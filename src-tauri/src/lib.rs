use chrono::Local;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_dialog::DialogExt;

#[cfg(target_os = "windows")]
use windows::{
    core::{Interface, BOOL, PWSTR},
    Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus,
    },
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM},
        Media::Audio::{
            Endpoints::IAudioMeterInformation, AudioSessionStateActive,
            IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
            DEVICE_STATE_ACTIVE, MMDeviceEnumerator, eRender,
        },
        System::{
            Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED},
            SystemInformation::GetTickCount64,
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{
            Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO},
            WindowsAndMessaging::{
                EnumWindows, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW,
                GetWindowThreadProcessId, IsWindowVisible,
            },
        },
    },
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackingBinding {
    id: String,
    task_id: String,
    app_name: String,
    process_path: String,
    process_name: String,
    mode: String,
    idle_threshold_sec: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunningApp {
    app_name: String,
    process_path: String,
    process_name: String,
    window_title: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurrentActivity {
    binding_id: Option<String>,
    app_name: Option<String>,
    mode: Option<String>,
    reason: String,
    counting: bool,
    foreground_app: Option<String>,
    idle_seconds: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedTracker {
    bindings: Vec<TrackingBinding>,
    totals: HashMap<String, u64>,
    paused: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BindingTotal {
    binding_id: String,
    seconds: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackerSnapshot {
    date: String,
    paused: bool,
    current: CurrentActivity,
    totals: Vec<BindingTotal>,
}

struct TrackerState {
    persisted: Mutex<PersistedTracker>,
    current: Mutex<CurrentActivity>,
    data_file: Mutex<Option<PathBuf>>,
    quitting: AtomicBool,
}

impl Default for TrackerState {
    fn default() -> Self {
        Self {
            persisted: Mutex::new(PersistedTracker::default()),
            current: Mutex::new(CurrentActivity::default()),
            data_file: Mutex::new(None),
            quitting: AtomicBool::new(false),
        }
    }
}

fn today_key() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn total_key(date: &str, binding_id: &str) -> String {
    format!("{date}|{binding_id}")
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_string()
}

fn save_tracker(state: &TrackerState) {
    let file = state.data_file.lock().ok().and_then(|value| value.clone());
    let data = state.persisted.lock().ok().map(|value| value.clone());
    if let (Some(file), Some(data)) = (file, data) {
        if let Some(parent) = file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_vec_pretty(&data) {
            let temporary = file.with_extension("tmp");
            if std::fs::write(&temporary, json).is_ok() {
                let _ = std::fs::rename(temporary, file);
            }
        }
    }
}

fn load_tracker(state: &TrackerState, file: PathBuf) {
    if let Ok(bytes) = std::fs::read(&file) {
        if let Ok(saved) = serde_json::from_slice::<PersistedTracker>(&bytes) {
            if let Ok(mut persisted) = state.persisted.lock() {
                *persisted = saved;
            }
        }
    }
    if let Ok(mut target) = state.data_file.lock() {
        *target = Some(file);
    }
}

#[cfg(target_os = "windows")]
fn process_path_from_pid(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = vec![0u16; 32768];
        let mut size = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(process);
        result.ok()?;
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
    }
}

#[cfg(target_os = "windows")]
fn window_title(hwnd: HWND) -> String {
    unsafe {
        let length = GetWindowTextLengthW(hwnd);
        if length <= 0 {
            return String::new();
        }
        let mut buffer = vec![0u16; length as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut buffer);
        String::from_utf16_lossy(&buffer[..copied.max(0) as usize])
    }
}

#[cfg(target_os = "windows")]
fn app_for_window(hwnd: HWND) -> Option<RunningApp> {
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    let process_path = process_path_from_pid(pid)?;
    let process_name = file_name(&process_path);
    let title = window_title(hwnd);
    let app_name = if title.is_empty() {
        process_name.trim_end_matches(".exe").to_string()
    } else {
        title.split(" - ").last().unwrap_or(&title).to_string()
    };
    Some(RunningApp {
        app_name,
        process_path,
        process_name,
        window_title: title,
    })
}

#[cfg(target_os = "windows")]
fn foreground_app() -> Option<RunningApp> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        None
    } else {
        app_for_window(hwnd)
    }
}

#[cfg(target_os = "windows")]
fn idle_seconds() -> u64 {
    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut info).as_bool() {
            GetTickCount64().saturating_sub(info.dwTime as u64) / 1000
        } else {
            0
        }
    }
}

#[cfg(target_os = "windows")]
fn list_visible_apps() -> Vec<RunningApp> {
    unsafe extern "system" fn enumerate(hwnd: HWND, parameter: LPARAM) -> BOOL {
        if !IsWindowVisible(hwnd).as_bool() || GetWindowTextLengthW(hwnd) <= 0 {
            return true.into();
        }
        let apps = &mut *(parameter.0 as *mut Vec<RunningApp>);
        if let Some(app) = app_for_window(hwnd) {
            apps.push(app);
        }
        true.into()
    }

    let mut apps = Vec::<RunningApp>::new();
    unsafe {
        let _ = EnumWindows(Some(enumerate), LPARAM(&mut apps as *mut _ as isize));
    }
    let own_exe = std::env::current_exe().ok().map(|path| path.to_string_lossy().to_lowercase());
    let mut seen = HashSet::new();
    apps.retain(|app| {
        let key = app.process_path.to_lowercase();
        let is_own = own_exe.as_ref().is_some_and(|own| own == &key);
        !is_own && seen.insert(key)
    });
    apps.sort_by(|first, second| first.app_name.to_lowercase().cmp(&second.app_name.to_lowercase()));
    apps
}

#[cfg(target_os = "windows")]
fn playing_media_sources() -> Vec<String> {
    let mut sources = Vec::new();
    let operation = match GlobalSystemMediaTransportControlsSessionManager::RequestAsync() {
        Ok(value) => value,
        Err(_) => return sources,
    };
    let manager = match operation.join() {
        Ok(value) => value,
        Err(_) => return sources,
    };
    let sessions = match manager.GetSessions() {
        Ok(value) => value,
        Err(_) => return sources,
    };
    let size = sessions.Size().unwrap_or(0);
    for index in 0..size {
        let Ok(session) = sessions.GetAt(index) else { continue };
        let Ok(info) = session.GetPlaybackInfo() else { continue };
        let Ok(status) = info.PlaybackStatus() else { continue };
        if status == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing {
            if let Ok(source) = session.SourceAppUserModelId() {
                sources.push(source.to_string_lossy().to_lowercase());
            }
        }
    }
    sources
}

fn binding_matches_app(binding: &TrackingBinding, app: &RunningApp) -> bool {
    let expected_path = binding.process_path.to_lowercase();
    let actual_path = app.process_path.to_lowercase();
    if !expected_path.is_empty() && expected_path == actual_path {
        return true;
    }
    binding.process_name.eq_ignore_ascii_case(&app.process_name)
}

fn binding_has_media(binding: &TrackingBinding, sources: &[String]) -> bool {
    let process = binding.process_name.to_lowercase();
    let stem = process.trim_end_matches(".exe");
    sources.iter().any(|source| source.contains(&process) || (!stem.is_empty() && source.contains(stem)))
}

#[cfg(target_os = "windows")]
fn audible_audio_processes(bindings: &[TrackingBinding]) -> HashSet<String> {
    let mut processes = HashSet::new();
    unsafe {
        let Ok(enumerator) = CoCreateInstance::<_, IMMDeviceEnumerator>(
            &MMDeviceEnumerator,
            None,
            CLSCTX_ALL,
        ) else {
            return processes;
        };
        let Ok(devices) = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else {
            return processes;
        };
        let count = devices.GetCount().unwrap_or(0);
        for device_index in 0..count {
            let Ok(device) = devices.Item(device_index) else { continue };
            let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
            let Ok(sessions) = manager.GetSessionEnumerator() else { continue };
            let session_count = sessions.GetCount().unwrap_or(0);
            for session_index in 0..session_count {
                let Ok(session) = sessions.GetSession(session_index) else { continue };
                if session.GetState().ok() != Some(AudioSessionStateActive) {
                    continue;
                }
                let Ok(control) = session.cast::<IAudioSessionControl2>() else { continue };
                let Ok(pid) = control.GetProcessId() else { continue };
                let Some(path) = process_path_from_pid(pid).map(|value| value.to_lowercase()) else { continue };
                if !bindings.iter().any(|binding| binding_matches_audio_path(binding, &path)) {
                    continue;
                }
                let Ok(meter) = session.cast::<IAudioMeterInformation>() else { continue };
                // Sample a short window instead of one instant so normal gaps between words
                // do not look like a paused course. This sleeps only on the tracker thread.
                let mut audible = false;
                for sample in 0..5 {
                    if meter.GetPeakValue().unwrap_or(0.0) > 0.000_01 {
                        audible = true;
                        break;
                    }
                    if sample < 4 {
                        thread::sleep(Duration::from_millis(40));
                    }
                }
                if audible {
                    processes.insert(path);
                }
            }
        }
    }
    processes
}

fn binding_matches_audio_path(binding: &TrackingBinding, audio_path: &str) -> bool {
    let expected_path = binding.process_path.to_lowercase();
    let process_name = binding.process_name.to_lowercase();
    let install_dir = Path::new(&expected_path)
        .parent()
        .map(|path| path.to_string_lossy().trim_end_matches(['\\', '/']).to_string());
    audio_path == expected_path
        || Path::new(audio_path)
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case(&process_name))
        || install_dir.as_ref().is_some_and(|directory| {
            audio_path.starts_with(directory)
                && audio_path[directory.len()..].starts_with(['\\', '/'])
        })
}

fn binding_has_audio(binding: &TrackingBinding, audio_processes: &HashSet<String>) -> bool {
    audio_processes
        .iter()
        .any(|audio_path| binding_matches_audio_path(binding, audio_path))
}

fn media_reason(
    binding: &TrackingBinding,
    media_sources: &[String],
    audio_processes: &HashSet<String>,
    recent_audio: &HashMap<String, Instant>,
) -> Option<&'static str> {
    if binding_has_media(binding, media_sources) {
        return Some("Windows 已确认媒体正在播放");
    }
    if binding_has_audio(binding, audio_processes) {
        return Some("检测到绑定软件正在输出音频");
    }
    if recent_audio
        .get(&binding.id)
        .is_some_and(|instant| instant.elapsed() <= Duration::from_secs(20))
    {
        return Some("课程短暂停顿，继续计时");
    }
    None
}

fn choose_activity(
    bindings: &[TrackingBinding],
    foreground: Option<&RunningApp>,
    idle: u64,
    media_sources: &[String],
    audio_processes: &HashSet<String>,
    recent_audio: &HashMap<String, Instant>,
) -> (Option<TrackingBinding>, String) {
    if let Some(app) = foreground {
        for binding in bindings.iter().filter(|binding| binding_matches_app(binding, app)) {
            match binding.mode.as_str() {
                "active" if idle <= binding.idle_threshold_sec => return (Some(binding.clone()), "正在操作绑定软件".into()),
                "active" => return (None, "键鼠空闲，操作模式已暂停".into()),
                "reading" => return (Some(binding.clone()), "绑定软件位于前台".into()),
                "media" => return media_reason(binding, media_sources, audio_processes, recent_audio)
                    .map(|reason| (Some(binding.clone()), reason.into()))
                    .unwrap_or_else(|| (None, "未检测到媒体或音频输出".into())),
                "backgroundMedia" => return media_reason(binding, media_sources, audio_processes, recent_audio)
                    .map(|reason| (Some(binding.clone()), reason.into()))
                    .unwrap_or_else(|| (None, "未检测到媒体或音频输出".into())),
                _ => return (None, "手动模式不会自动计时".into()),
            }
        }
    }
    for binding in bindings.iter().filter(|binding| binding.mode == "backgroundMedia") {
        if let Some(reason) = media_reason(binding, media_sources, audio_processes, recent_audio) {
            return (Some(binding.clone()), reason.into());
        }
    }
    (None, "当前软件未绑定任务".into())
}

fn start_tracker(state: Arc<TrackerState>) {
    thread::spawn(move || {
        #[cfg(target_os = "windows")]
        let _apartment = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok();
        let mut last_tick = Instant::now();
        let mut last_save = Instant::now();
        let mut recent_audio = HashMap::<String, Instant>::new();
        loop {
            thread::sleep(Duration::from_secs(2));
            if state.quitting.load(Ordering::Relaxed) {
                save_tracker(&state);
                break;
            }
            let elapsed = last_tick.elapsed().as_secs();
            last_tick = Instant::now();
            let (bindings, paused) = state
                .persisted
                .lock()
                .map(|value| (value.bindings.clone(), value.paused))
                .unwrap_or_default();
            let foreground = foreground_app();
            let idle = idle_seconds();
            let media_sources = if bindings.iter().any(|binding| binding.mode.contains("Media") || binding.mode == "media") {
                playing_media_sources()
            } else {
                Vec::new()
            };
            let audio_processes = if bindings.iter().any(|binding| binding.mode.contains("Media") || binding.mode == "media") {
                audible_audio_processes(&bindings)
            } else {
                HashSet::new()
            };
            for binding in &bindings {
                if binding_has_audio(binding, &audio_processes) {
                    recent_audio.insert(binding.id.clone(), Instant::now());
                }
            }
            recent_audio.retain(|binding_id, instant| {
                bindings.iter().any(|binding| &binding.id == binding_id)
                    && instant.elapsed() <= Duration::from_secs(20)
            });
            let (selected, reason) = if paused {
                (None, "自动计时已暂停".to_string())
            } else {
                choose_activity(
                    &bindings,
                    foreground.as_ref(),
                    idle,
                    &media_sources,
                    &audio_processes,
                    &recent_audio,
                )
            };
            if let Ok(mut current) = state.current.lock() {
                *current = CurrentActivity {
                    binding_id: selected.as_ref().map(|binding| binding.id.clone()),
                    app_name: selected.as_ref().map(|binding| binding.app_name.clone()),
                    mode: selected.as_ref().map(|binding| binding.mode.clone()),
                    reason,
                    counting: selected.is_some(),
                    foreground_app: foreground.as_ref().map(|app| app.app_name.clone()),
                    idle_seconds: idle,
                };
            }
            if let Some(binding) = selected {
                // Gaps larger than ten seconds usually mean sleep/resume or a suspended process.
                if elapsed > 0 && elapsed <= 10 {
                    if let Ok(mut persisted) = state.persisted.lock() {
                        let key = total_key(&today_key(), &binding.id);
                        *persisted.totals.entry(key).or_insert(0) += elapsed;
                    }
                }
            }
            if last_save.elapsed() >= Duration::from_secs(20) {
                save_tracker(&state);
                last_save = Instant::now();
            }
        }
    });
}

#[tauri::command]
fn list_windows_apps() -> Vec<RunningApp> {
    list_visible_apps()
}

#[tauri::command]
fn set_tracking_bindings(bindings: Vec<TrackingBinding>, state: State<'_, Arc<TrackerState>>) {
    if let Ok(mut persisted) = state.persisted.lock() {
        persisted.bindings = bindings;
    }
    save_tracker(&state);
}

#[tauri::command]
fn get_tracker_state(state: State<'_, Arc<TrackerState>>) -> TrackerSnapshot {
    let date = today_key();
    let persisted = state.persisted.lock().map(|value| value.clone()).unwrap_or_default();
    let current = state.current.lock().map(|value| value.clone()).unwrap_or_default();
    let totals = persisted
        .bindings
        .iter()
        .map(|binding| BindingTotal {
            binding_id: binding.id.clone(),
            seconds: *persisted.totals.get(&total_key(&date, &binding.id)).unwrap_or(&0),
        })
        .collect();
    TrackerSnapshot { date, paused: persisted.paused, current, totals }
}

#[tauri::command]
fn set_tracker_paused(paused: bool, state: State<'_, Arc<TrackerState>>) {
    if let Ok(mut persisted) = state.persisted.lock() {
        persisted.paused = paused;
    }
    save_tracker(&state);
}

#[tauri::command]
fn export_backup(app: AppHandle, contents: String, default_name: String) -> Result<bool, String> {
    let Some(selected) = app
        .dialog()
        .file()
        .set_file_name(default_name)
        .add_filter("JSON 备份", &["json"])
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let mut path = selected.into_path().map_err(|error| error.to_string())?;
    if path.extension().is_none() {
        path.set_extension("json");
    }
    std::fs::write(&path, contents).map_err(|error| format!("无法写入备份文件：{error}"))?;
    Ok(true)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn run() {
    let tracker = Arc::new(TrackerState::default());
    let setup_tracker = tracker.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_dialog::init())
        .manage(tracker)
        .invoke_handler(tauri::generate_handler![
            list_windows_apps,
            set_tracking_bindings,
            get_tracker_state,
            set_tracker_paused,
            export_backup
        ])
        .setup(move |app| {
            let data_file = app.path().app_data_dir()?.join("windows-tracker.json");
            load_tracker(&setup_tracker, data_file);
            start_tracker(setup_tracker.clone());

            let show = MenuItem::with_id(app, "show", "打开循记", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "暂停 / 继续自动计时", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &pause, &quit])?;
            let tray_tracker = setup_tracker.clone();
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("window icon"))
                .tooltip("循记 · Windows 专注助手")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "pause" => {
                        if let Ok(mut persisted) = tray_tracker.persisted.lock() {
                            persisted.paused = !persisted.paused;
                        }
                        save_tracker(&tray_tracker);
                    }
                    "quit" => {
                        tray_tracker.quitting.store(true, Ordering::Relaxed);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if let Some(state) = window.app_handle().try_state::<Arc<TrackerState>>() {
                    if !state.quitting.load(Ordering::Relaxed) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running xunji desktop");
}
