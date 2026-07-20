"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Capacitor, CapacitorHttp, registerPlugin } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { StatusBar, Style } from "@capacitor/status-bar";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { CalendarApp, type CalendarTask } from "./CalendarApp";

const INTERVALS = [1, 2, 4, 7, 15];
const LOCAL_DATA_KEY = "xunji-data-v1";
const LOCAL_SYNC_KEY = "xunji-sync-v1";
const LOCAL_TIMER_KEY = "xunji-timer-v1";
const LOCAL_THEME_KEY = "xunji-theme";
const LOCAL_USAGE_OBSERVATION_KEY = "xunji-usage-observations-v1";
const LOCAL_DEVICE_ID_KEY = "xunji-device-id-v1";
const SYNC_API_ORIGIN = (import.meta.env.VITE_SYNC_API_ORIGIN || "").trim().replace(/\/$/, "");

function getSyncApiUrl() {
  if (SYNC_API_ORIGIN) {
    try {
      const origin = new URL(SYNC_API_ORIGIN);
      if (origin.protocol !== "http:" && origin.protocol !== "https:") throw new Error();
      return new URL("/api/sync", origin).toString();
    } catch {
      throw new Error("同步服务地址格式错误，请重新构建移动端 App");
    }
  }

  if (Capacitor.isNativePlatform()) {
    throw new Error("移动端未配置同步服务地址，请重新安装最新版 App");
  }

  return new URL("/api/sync", window.location.origin).toString();
}

function syncNativeTheme(theme: "light" | "dark") {
  if (!Capacitor.isNativePlatform()) return;
  void StatusBar.setStyle({ style: theme === "dark" ? Style.Dark : Style.Light });
}

type Tab = "today" | "calendar" | "tasks" | "focus" | "stats" | "settings";
type Category = { id: string; name: string; color: string };
type TaskScheduleMode = "once" | "ongoing";
type OngoingTaskStatus = "active" | "paused" | "completed";
type NewTaskKind = Task["type"] | "ongoing";
type Task = {
  id: string;
  type: "normal" | "memory";
  title: string;
  categoryId: string;
  tags: string[];
  tagChanges?: Record<string, { present: boolean; updatedAt: string }>;
  startDate: string;
  startTime?: string;
  endTime?: string;
  scheduleMode?: TaskScheduleMode;
  ongoingStatus?: OngoingTaskStatus;
  ongoingStatusUpdatedAt?: string;
  targetDate?: string;
  dailyGoalMinutes?: number;
  normalCompleted?: boolean;
  reviewDates?: string[];
  completed: boolean[];
  createdAt: string;
  updatedAt: string;
};
type PendingTaskAction = { kind: "complete-ongoing" | "delete"; taskId: string };
type FocusSession = {
  id: string;
  taskId: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  status: "completed" | "stopped";
  source?: "timer" | "app" | "desktop";
  sourceAppName?: string;
  sourcePackage?: string;
  updatedAt: string;
};
type AppBinding = {
  id: string;
  taskId: string;
  packageName: string;
  appName: string;
  createdAt: string;
  updatedAt: string;
};
type InstalledApp = { packageName: string; label: string; system: boolean };
type WindowsTrackingMode = "active" | "reading" | "media" | "backgroundMedia" | "manual";
type WindowsAppBinding = {
  id: string;
  taskId: string;
  appName: string;
  processPath: string;
  processName: string;
  mode: WindowsTrackingMode;
  idleThresholdSec: number;
  createdAt: string;
  updatedAt: string;
};
type WindowsRunningApp = { appName: string; processPath: string; processName: string; windowTitle: string };
type WindowsTrackerSnapshot = {
  date: string;
  paused: boolean;
  current: {
    bindingId?: string;
    appName?: string;
    mode?: WindowsTrackingMode;
    reason: string;
    counting: boolean;
    foregroundApp?: string;
    idleSeconds: number;
  };
  totals: Array<{ bindingId: string; seconds: number }>;
};
type UsageStatsPlugin = {
  hasUsageAccess(): Promise<{ granted: boolean }>;
  openUsageAccessSettings(): Promise<void>;
  getInstalledApps(): Promise<{ apps: InstalledApp[] }>;
  getUsageForPackages(options: { packageNames: string[]; startTime: number; endTime: number }): Promise<{
    usage: Array<{ packageName: string; usageMs: number; lastTimeUsed: number }>;
  }>;
};
const NativeUsageStats = registerPlugin<UsageStatsPlugin>("UsageStats");
type DeletedTask = { id: string; deletedAt: string };
type AppData = {
  version: 1;
  tasks: Task[];
  deletedTasks: DeletedTask[];
  sessions: FocusSession[];
  appBindings: AppBinding[];
  windowsBindings: WindowsAppBinding[];
  categories: Category[];
  settings: { focusMinutes: number; breakMinutes: number; dailyGoalMinutes: number };
};
type TimerState = {
  taskId: string;
  startedAt: string;
  endAt: number;
  durationSec: number;
  running: boolean;
  pausedRemaining: number;
};
type UsageObservation = {
  date: string;
  taskId: string;
  statusUpdatedAt: string;
  usageMs: number;
  active: boolean;
};
type SyncResponsePayload = {
  error?: string;
  found?: boolean;
  revision?: number;
  data?: unknown;
};

const DEFAULT_DATA: AppData = {
  version: 1,
  tasks: [],
  deletedTasks: [],
  sessions: [],
  appBindings: [],
  windowsBindings: [],
  categories: [],
  settings: { focusMinutes: 25, breakMinutes: 5, dailyGoalMinutes: 180 },
};

const NAV_ITEMS: { id: Tab; label: string }[] = [
  { id: "today", label: "今日" },
  { id: "calendar", label: "日历" },
  { id: "tasks", label: "任务" },
  { id: "focus", label: "专注" },
  { id: "stats", label: "统计" },
  { id: "settings", label: "设置" },
];

function uid(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function localDeviceId() {
  if (typeof localStorage === "undefined") return "server";
  const existing = localStorage.getItem(LOCAL_DEVICE_ID_KEY);
  if (existing) return existing;
  const created = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : uid("device");
  localStorage.setItem(LOCAL_DEVICE_ID_KEY, created);
  return created;
}

function automaticSessionId(source: "app" | "desktop", date: string, bindingKey: string, deviceId: string) {
  return `${source}_${date}_${bindingKey}_${deviceId}`;
}

function localISO(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(value: string, days: number) {
  const date = parseDate(value);
  date.setDate(date.getDate() + days);
  return localISO(date);
}

function reviewDate(task: Task, index: number) {
  return task.reviewDates?.[index] || addDays(task.startDate, INTERVALS[index]);
}

function getTagChanges(task: Task) {
  const stamp = task.updatedAt || task.createdAt || new Date().toISOString();
  const changes = { ...(task.tagChanges || {}) };
  task.tags.forEach((tag) => {
    if (!changes[tag]) changes[tag] = { present: true, updatedAt: stamp };
  });
  return changes;
}

function tagsFromChanges(changes: Record<string, { present: boolean; updatedAt: string }>) {
  return Object.entries(changes)
    .filter(([, value]) => value.present)
    .sort(([first], [second]) => first.localeCompare(second, "zh-CN"))
    .map(([tag]) => tag);
}

function dateLabel(value: string, withWeekday = false) {
  return new Intl.DateTimeFormat("zh-CN", withWeekday
    ? { month: "numeric", day: "numeric", weekday: "short" }
    : { month: "numeric", day: "numeric" }).format(parseDate(value));
}

function dateTimeLabel(timestamp: number) {
  const date = new Date(timestamp);
  const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${weekday} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function NavIcon({ name }: { name: Tab }) {
  const commonProps = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (name === "today") return <svg {...commonProps}><path d="M3.5 10.2 12 3.5l8.5 6.7" /><path d="M5.8 9.2v10.3h12.4V9.2" /><path d="M9.4 19.5v-5.8h5.2v5.8" /></svg>;
  if (name === "calendar") return <svg {...commonProps}><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M7.5 3v4M16.5 3v4M3.5 9.5h17M8 13h.01M12 13h.01M16 13h.01M8 16.5h.01M12 16.5h.01" /></svg>;
  if (name === "tasks") return <svg {...commonProps}><rect x="4" y="3.5" width="16" height="17" rx="2.5" /><path d="m7.5 8.2 1.3 1.3 2.1-2.3M13.5 8.5h3M7.5 14.2l1.3 1.3 2.1-2.3M13.5 14.5h3" /></svg>;
  if (name === "focus") return <svg {...commonProps}><circle cx="12" cy="12" r="7.5" /><circle cx="12" cy="12" r="3.5" /><path d="M12 1.8v2.7M12 19.5v2.7M1.8 12h2.7M19.5 12h2.7" /></svg>;
  if (name === "stats") return <svg {...commonProps}><path d="M4 20V10.5h4V20M10 20V4h4v16M16 20v-6.5h4V20M2.5 20h19" /></svg>;
  return <svg {...commonProps}><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></svg>;
}

function ThemeIcon({ theme }: { theme: "light" | "dark" }) {
  const commonProps = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (theme === "dark") {
    return <svg {...commonProps}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" /></svg>;
  }
  return <svg {...commonProps}><path d="M20.4 15.5A8.5 8.5 0 0 1 8.5 3.6 8.5 8.5 0 1 0 20.4 15.5Z" /></svg>;
}

function reviewStatus(task: Task, index: number) {
  if (task.completed[index]) return "done" as const;
  const due = reviewDate(task, index);
  const today = localISO();
  if (due < today) return "overdue" as const;
  if (due === today) return "due" as const;
  if (due === addDays(today, 1)) return "soon" as const;
  return "future" as const;
}

type NormalTaskStatus = "done" | "overdue" | "today" | "future";

function isOngoingTask(task: Task) {
  return task.type === "normal" && task.scheduleMode === "ongoing";
}

function ongoingTaskStatus(task: Task): OngoingTaskStatus {
  return isOngoingTask(task) && ["active", "paused", "completed"].includes(task.ongoingStatus || "")
    ? task.ongoingStatus as OngoingTaskStatus
    : "active";
}

function normalTaskStatus(task: Task, now = new Date()): NormalTaskStatus {
  if (isOngoingTask(task)) return ongoingTaskStatus(task) === "completed" ? "done" : "future";
  if (task.normalCompleted) return "done";
  const today = localISO(now);
  if (task.startDate < today) return "overdue";
  if (task.startDate > today) return "future";
  if (!task.endTime) return "today";
  const [hours, minutes] = task.endTime.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return "today";
  const endAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
  return now.getTime() > endAt.getTime() ? "overdue" : "today";
}

function normalTaskOverdueLabel(task: Task, now = new Date()) {
  if (normalTaskStatus(task, now) !== "overdue") return "";
  const today = localISO(now);
  if (task.startDate === today) return "已过结束时间";
  const due = parseDate(task.startDate);
  const elapsedDays = Math.max(1, Math.round(
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(due.getFullYear(), due.getMonth(), due.getDate())) / 86_400_000,
  ));
  return `已逾期 ${elapsedDays} 天`;
}

function isTaskFinished(task: Task) {
  if (isOngoingTask(task)) return ongoingTaskStatus(task) === "completed";
  return task.type === "normal" ? Boolean(task.normalCompleted) : task.completed.every(Boolean);
}

function isTaskAvailableForFocus(task: Task) {
  return !isTaskFinished(task) && (!isOngoingTask(task) || ongoingTaskStatus(task) === "active");
}

function taskListState(task: Task): "active" | "paused" | "done" {
  if (isTaskFinished(task)) return "done";
  return isOngoingTask(task) && ongoingTaskStatus(task) === "paused" ? "paused" : "active";
}

function ongoingTargetReached(task: Task, today = localISO()) {
  return isOngoingTask(task) && Boolean(task.targetDate && task.targetDate <= today);
}

function focusSecondsByTask(sessions: FocusSession[]) {
  const totals = new Map<string, number>();
  sessions.forEach((session) => totals.set(session.taskId, (totals.get(session.taskId) || 0) + Math.max(0, Number(session.durationSec) || 0)));
  return totals;
}

function countActiveTasks(tasks: Task[]) {
  return tasks.filter((task) => taskListState(task) === "active").length;
}

function normalizeData(value: unknown): AppData {
  if (!value || typeof value !== "object") return DEFAULT_DATA;
  const input = value as Partial<AppData>;
  const legacyItems = (value as { items?: Array<{ id?: string; task?: string; startDate?: string; completed?: boolean[] }> }).items;
  const sourceTasks = Array.isArray(input.tasks) ? input.tasks : Array.isArray(legacyItems)
    ? legacyItems.map((item) => ({
        id: item.id || uid("task"),
        title: item.task || "未命名任务",
        categoryId: "",
        tags: [],
        startDate: item.startDate || localISO(),
        completed: item.completed || [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }))
    : [];
  return {
    version: 1,
    tasks: sourceTasks.map((task) => {
      const candidate = task as Partial<Task>;
      const type = candidate.type === "normal" ? "normal" as const : "memory" as const;
      const scheduleMode = type === "normal" ? (candidate.scheduleMode === "ongoing" ? "ongoing" as const : "once" as const) : undefined;
      const ongoingStatus = scheduleMode === "ongoing" && ["active", "paused", "completed"].includes(candidate.ongoingStatus || "")
        ? candidate.ongoingStatus as OngoingTaskStatus
        : scheduleMode === "ongoing" ? "active" as const : undefined;
      const dailyGoalMinutes = scheduleMode === "ongoing" && Number(candidate.dailyGoalMinutes) > 0
        ? Math.min(1_440, Math.round(Number(candidate.dailyGoalMinutes)))
        : undefined;
      return {
        ...task,
        type,
        scheduleMode,
        ongoingStatus,
        ongoingStatusUpdatedAt: scheduleMode === "ongoing" ? candidate.ongoingStatusUpdatedAt || candidate.createdAt || candidate.updatedAt : undefined,
        targetDate: scheduleMode === "ongoing" && candidate.targetDate ? candidate.targetDate : undefined,
        dailyGoalMinutes,
        normalCompleted: type === "normal" ? Boolean(candidate.normalCompleted) : false,
        completed: type === "memory" ? INTERVALS.map((_, index) => Boolean(candidate.completed?.[index])) : [],
        tags: Array.isArray(candidate.tags) ? candidate.tags : [],
        reviewDates: type === "memory" ? INTERVALS.map((days, index) => candidate.reviewDates?.[index] || addDays(candidate.startDate || localISO(), days)) : [],
        updatedAt: candidate.updatedAt || candidate.createdAt || new Date().toISOString(),
      };
    }).map((task) => ({ ...task, tagChanges: getTagChanges(task) })),
    deletedTasks: Array.isArray(input.deletedTasks)
      ? input.deletedTasks.filter((entry): entry is DeletedTask => Boolean(entry?.id && entry?.deletedAt))
      : [],
    sessions: Array.isArray(input.sessions)
      ? input.sessions.filter((session): session is FocusSession => Boolean(session?.id && session?.taskId)).map((session) => ({
          ...session,
          durationSec: Math.max(0, Math.round(Number(session.durationSec) || 0)),
          status: session.status === "stopped" ? "stopped" as const : "completed" as const,
          startedAt: session.startedAt || session.endedAt || new Date().toISOString(),
          endedAt: session.endedAt || session.startedAt || new Date().toISOString(),
          updatedAt: session.updatedAt || session.endedAt || session.startedAt || new Date().toISOString(),
        }))
      : [],
    appBindings: Array.isArray(input.appBindings)
      ? input.appBindings.filter((binding): binding is AppBinding => Boolean(binding?.id && binding?.taskId && binding?.packageName))
      : [],
    windowsBindings: Array.isArray(input.windowsBindings)
      ? input.windowsBindings.filter((binding): binding is WindowsAppBinding => Boolean(binding?.id && binding?.taskId && binding?.processPath))
      : [],
    categories: Array.isArray(input.categories) ? input.categories : DEFAULT_DATA.categories,
    settings: { ...DEFAULT_DATA.settings, ...(input.settings || {}) },
  };
}

function mergeByUpdatedAt<T extends { id: string; updatedAt: string }>(local: T[], remote: T[]) {
  const map = new Map<string, T>();
  [...local, ...remote].forEach((entry) => {
    const current = map.get(entry.id);
    if (!current || entry.updatedAt >= current.updatedAt) map.set(entry.id, entry);
  });
  return [...map.values()];
}

function mergeData(local: AppData, remote: AppData): AppData {
  const categories = new Map(local.categories.map((category) => [category.id, category]));
  remote.categories.forEach((category) => categories.set(category.id, category));
  const deletedTasks = mergeByUpdatedAt(
    local.deletedTasks.map((entry) => ({ ...entry, updatedAt: entry.deletedAt })),
    remote.deletedTasks.map((entry) => ({ ...entry, updatedAt: entry.deletedAt })),
  ).map(({ id, updatedAt }) => ({ id, deletedAt: updatedAt }));
  const deletedAt = new Map(deletedTasks.map((entry) => [entry.id, entry.deletedAt]));
  return {
    version: 1,
    tasks: mergeTasks(local.tasks, remote.tasks).filter((task) => !deletedAt.get(task.id) || task.updatedAt > deletedAt.get(task.id)!),
    deletedTasks,
    sessions: mergeByUpdatedAt(local.sessions, remote.sessions),
    appBindings: mergeByUpdatedAt(local.appBindings, remote.appBindings),
    windowsBindings: mergeByUpdatedAt(local.windowsBindings, remote.windowsBindings),
    categories: [...categories.values()],
    settings: remote.settings || local.settings,
  };
}

function mergeTasks(local: Task[], remote: Task[]) {
  const map = new Map<string, Task>();
  [...local, ...remote].forEach((incoming) => {
    const current = map.get(incoming.id);
    if (!current) {
      map.set(incoming.id, { ...incoming, tagChanges: getTagChanges(incoming) });
      return;
    }
    const primary = current.updatedAt > incoming.updatedAt ? current : incoming;
    const mergedChanges = { ...getTagChanges(current) };
    Object.entries(getTagChanges(incoming)).forEach(([tag, change]) => {
      const existing = mergedChanges[tag];
      if (!existing || change.updatedAt >= existing.updatedAt) mergedChanges[tag] = change;
    });
    map.set(incoming.id, { ...primary, tagChanges: mergedChanges, tags: tagsFromChanges(mergedChanges) });
  });
  return [...map.values()];
}

function minutesLabel(seconds: number) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function windowsModeLabel(mode: WindowsTrackingMode) {
  if (mode === "active") return "活跃操作";
  if (mode === "reading") return "前台阅读";
  if (mode === "media") return "媒体播放";
  if (mode === "backgroundMedia") return "后台听课";
  return "手动专注";
}

export function StudyApp() {
  const [data, setData] = useState<AppData>(DEFAULT_DATA);
  const [tab, setTab] = useState<Tab>("today");
  const [hydrated, setHydrated] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newTaskType, setNewTaskType] = useState<NewTaskKind>("memory");
  const [calendarDraft, setCalendarDraft] = useState<{ date: string; startTime?: string; endTime?: string } | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [pendingTaskAction, setPendingTaskAction] = useState<PendingTaskAction | null>(null);
  const [newEditTag, setNewEditTag] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [taskFilter, setTaskFilter] = useState<"active" | "paused" | "all" | "done">("active");
  const [toast, setToast] = useState("");
  const [syncCode, setSyncCode] = useState("");
  const [syncInput, setSyncInput] = useState("");
  const [syncStatus, setSyncStatus] = useState<"local" | "syncing" | "synced" | "error">("local");
  const [syncMessage, setSyncMessage] = useState("尚未启用跨设备同步");
  const [timer, setTimer] = useState<TimerState | null>(null);
  const [timerTaskId, setTimerTaskId] = useState("");
  const [now, setNow] = useState(Date.now());
  const [newCategory, setNewCategory] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [usageAccess, setUsageAccess] = useState(false);
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [bindingTaskId, setBindingTaskId] = useState("");
  const [bindingPackage, setBindingPackage] = useState("");
  const [appUsageBusy, setAppUsageBusy] = useState(false);
  const [appUsageMessage, setAppUsageMessage] = useState("尚未检查使用权限");
  const [windowsApps, setWindowsApps] = useState<WindowsRunningApp[]>([]);
  const [windowsBindingTaskId, setWindowsBindingTaskId] = useState("");
  const [windowsBindingPath, setWindowsBindingPath] = useState("");
  const [windowsTrackingMode, setWindowsTrackingMode] = useState<WindowsTrackingMode>("active");
  const [windowsIdleMinutes, setWindowsIdleMinutes] = useState(3);
  const [windowsTracker, setWindowsTracker] = useState<WindowsTrackerSnapshot | null>(null);
  const [windowsAppsBusy, setWindowsAppsBusy] = useState(false);
  const [desktopAutostart, setDesktopAutostart] = useState(false);
  const revisionRef = useRef(0);
  const skipAutoSync = useRef(true);

  const today = localISO();
  const isAndroidApp = Capacitor.getPlatform() === "android";
  const isWindowsClient = isTauri();
  const currentMinute = Math.floor(now / 60_000);
  const taskMap = useMemo(() => new Map(data.tasks.map((task) => [task.id, task])), [data.tasks]);
  const categoryMap = useMemo(() => new Map(data.categories.map((category) => [category.id, category])), [data.categories]);
  const pendingTask = pendingTaskAction ? taskMap.get(pendingTaskAction.taskId) : undefined;
  const bindableTasks = useMemo(() => data.tasks.filter(isTaskAvailableForFocus), [data.tasks]);
  const activeWindowsBindings = useMemo(() => data.windowsBindings.filter((binding) => {
    const task = taskMap.get(binding.taskId);
    return Boolean(task && isTaskAvailableForFocus(task));
  }), [data.windowsBindings, taskMap]);
  const calendarTasks = useMemo<CalendarTask[]>(() => data.tasks.flatMap((task) => isOngoingTask(task)
    ? [{
        id: `${task.id}:ongoing-start`,
        type: "normal" as const,
        title: task.title,
        date: task.startDate,
        milestone: "ongoing-start" as const,
        color: categoryMap.get(task.categoryId)?.color,
        category: categoryMap.get(task.categoryId)?.name,
      }, ...(task.targetDate ? [{
        id: `${task.id}:ongoing-target`,
        type: "normal" as const,
        title: task.title,
        date: task.targetDate,
        milestone: "ongoing-target" as const,
        targetReached: task.targetDate <= localISO(new Date(currentMinute * 60_000)),
        color: categoryMap.get(task.categoryId)?.color,
        category: categoryMap.get(task.categoryId)?.name,
      }] : [])]
    : task.type === "normal"
    ? [{
        id: `${task.id}:normal`,
        type: "normal" as const,
        title: task.title,
        date: task.startDate,
        startTime: task.startTime,
        endTime: task.endTime,
        completed: Boolean(task.normalCompleted),
        overdue: normalTaskStatus(task, new Date(currentMinute * 60_000)) === "overdue",
        overdueLabel: normalTaskOverdueLabel(task, new Date(currentMinute * 60_000)),
        color: categoryMap.get(task.categoryId)?.color,
        category: categoryMap.get(task.categoryId)?.name,
      }]
    : [
        { id: `${task.id}:initial`, type: "normal" as const, title: `初次学习 · ${task.title}`, date: task.startDate, color: categoryMap.get(task.categoryId)?.color, category: categoryMap.get(task.categoryId)?.name },
        ...INTERVALS.map((_, index) => ({
          id: `${task.id}:${index}`,
          type: "memory" as const,
          title: task.title,
          stage: index + 1,
          date: reviewDate(task, index),
          completed: Boolean(task.completed[index]),
          color: categoryMap.get(task.categoryId)?.color,
          category: categoryMap.get(task.categoryId)?.name,
        })),
      ]), [categoryMap, currentMinute, data.tasks]);

  useEffect(() => {
    const currentTheme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    // Initial client theme is owned by the document bootstrap script.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(currentTheme);
    syncNativeTheme(currentTheme);
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LOCAL_DATA_KEY);
      // Hydrate the device cache once after the client storage becomes available.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setData(normalizeData(JSON.parse(saved)));
      const sync = JSON.parse(localStorage.getItem(LOCAL_SYNC_KEY) || "null");
      if (sync?.code) {
        setSyncCode(sync.code);
        setSyncInput(sync.code);
        revisionRef.current = Number(sync.revision) || 0;
      }
      const savedTimer = JSON.parse(localStorage.getItem(LOCAL_TIMER_KEY) || "null");
      if (savedTimer?.taskId) setTimer(savedTimer);
    } catch { /* start clean if a local cache is damaged */ }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(LOCAL_DATA_KEY, JSON.stringify(data));
  }, [data, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    if (timer) localStorage.setItem(LOCAL_TIMER_KEY, JSON.stringify(timer));
    else localStorage.removeItem(LOCAL_TIMER_KEY);
  }, [timer, hydrated]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    // Keep both native binding pickers on a task that can currently receive time.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!bindingTaskId && bindableTasks.length) setBindingTaskId(bindableTasks[0].id);
    if (bindingTaskId && !bindableTasks.some((task) => task.id === bindingTaskId)) setBindingTaskId(bindableTasks[0]?.id || "");
    if (!windowsBindingTaskId && bindableTasks.length) setWindowsBindingTaskId(bindableTasks[0].id);
    if (windowsBindingTaskId && !bindableTasks.some((task) => task.id === windowsBindingTaskId)) setWindowsBindingTaskId(bindableTasks[0]?.id || "");
  }, [bindableTasks, bindingTaskId, windowsBindingTaskId]);

  useEffect(() => {
    if (!hydrated || !isAndroidApp) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshAppUsage();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    void refreshAppUsage();
    return () => {
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
    };
    // Binding changes should be reflected immediately; session changes do not recreate these listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, isAndroidApp, data.appBindings, data.tasks]);

  useEffect(() => {
    if (tab === "settings" && isAndroidApp && !installedApps.length) void loadInstalledApps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, isAndroidApp]);

  useEffect(() => {
    if (!hydrated || !isWindowsClient) return;
    void invoke("set_tracking_bindings", { bindings: activeWindowsBindings }).catch(() => undefined);
    void refreshWindowsTracker();
    const interval = window.setInterval(() => void refreshWindowsTracker(), 5000);
    return () => window.clearInterval(interval);
    // Session updates keep the same bindings array, so the native tracker is only reset when configuration changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWindowsBindings, hydrated, isWindowsClient]);

  useEffect(() => {
    if (tab !== "settings" || !isWindowsClient) return;
    if (!windowsApps.length) void loadWindowsApps();
    void isAutostartEnabled().then(setDesktopAutostart).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, isWindowsClient]);

  const remaining = timer ? (timer.running ? Math.max(0, Math.ceil((timer.endAt - now) / 1000)) : timer.pausedRemaining) : 0;

  useEffect(() => {
    if (timer?.running && remaining === 0) finishTimer("completed", true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining, timer?.running]);

  useEffect(() => {
    if (!hydrated || !timer) return;
    const timerTask = data.tasks.find((task) => task.id === timer.taskId);
    if (!timerTask || !isTaskAvailableForFocus(timerTask)) finishTimer("stopped");
    // Cloud sync can pause/end a long-term task while another device is timing it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.tasks, hydrated, timer?.taskId]);

  useEffect(() => {
    if (!hydrated || !syncCode) return;
    if (skipAutoSync.current) {
      skipAutoSync.current = false;
      void pullAndMerge(syncCode);
      return;
    }
    const id = window.setTimeout(() => void pushData(syncCode, data), 1400);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, syncCode, hydrated]);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }

  function toggleTheme() {
    const nextTheme = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme = nextTheme;
    localStorage.setItem(LOCAL_THEME_KEY, nextTheme);
    syncNativeTheme(nextTheme);
    setTheme(nextTheme);
  }

  function updateTask(id: string, patch: Partial<Task>) {
    setData((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === id ? { ...task, ...patch, updatedAt: new Date().toISOString() } : task),
    }));
  }

  async function loadInstalledApps() {
    if (!isAndroidApp) return;
    try {
      const result = await NativeUsageStats.getInstalledApps();
      setInstalledApps(result.apps || []);
      if (!bindingPackage && result.apps?.length) setBindingPackage(result.apps[0].packageName);
    } catch {
      setAppUsageMessage("无法读取应用列表，请重新打开应用后再试");
    }
  }

  async function refreshAppUsage(showFeedback = false) {
    if (!isAndroidApp) return;
    try {
      if (showFeedback) setAppUsageBusy(true);
      const permission = await NativeUsageStats.hasUsageAccess();
      setUsageAccess(permission.granted);
      if (!permission.granted) {
        setAppUsageMessage("需要先允许循记读取应用使用时长");
        return;
      }
      const bindings = data.appBindings;
      if (!bindings.length) {
        setAppUsageMessage("权限已开启，可以开始绑定应用");
        return;
      }
      const startTime = parseDate(today).getTime();
      const endTime = Date.now();
      const result = await NativeUsageStats.getUsageForPackages({
        packageNames: [...new Set(bindings.map((binding) => binding.packageName))],
        startTime,
        endTime,
      });
      const usageByPackage = new Map(result.usage.map((entry) => [entry.packageName, entry]));
      const stamp = new Date(endTime).toISOString();
      const deviceId = localDeviceId();
      let observations: Record<string, UsageObservation> = {};
      try {
        observations = JSON.parse(localStorage.getItem(LOCAL_USAGE_OBSERVATION_KEY) || "{}") as Record<string, UsageObservation>;
      } catch { /* reset device-local usage observations if damaged */ }
      const nextObservations = { ...observations };
      const ongoingDeltas = new Map<string, number>();
      bindings.forEach((binding) => {
        const task = taskMap.get(binding.taskId);
        if (!task || !isOngoingTask(task)) return;
        const usageMs = Math.max(0, usageByPackage.get(binding.packageName)?.usageMs || 0);
        const previous = observations[binding.id];
        const statusUpdatedAt = task.ongoingStatusUpdatedAt || task.createdAt;
        const sameLifecycle = previous?.taskId === task.id && previous.statusUpdatedAt === statusUpdatedAt;
        const active = ongoingTaskStatus(task) === "active";
        const baseline = sameLifecycle && previous.date === today ? previous.usageMs : 0;
        const deltaMs = active && previous && sameLifecycle && previous.active ? Math.max(0, usageMs - baseline) : 0;
        ongoingDeltas.set(binding.id, Math.floor(deltaMs / 1000));
        nextObservations[binding.id] = { date: today, taskId: task.id, statusUpdatedAt, usageMs, active };
      });
      localStorage.setItem(LOCAL_USAGE_OBSERVATION_KEY, JSON.stringify(nextObservations));
      const creditedSeconds = bindings.reduce((sum, binding) => {
        const task = taskMap.get(binding.taskId);
        if (task && isOngoingTask(task)) return sum + (ongoingDeltas.get(binding.id) || 0);
        return sum + Math.max(0, Math.floor((usageByPackage.get(binding.packageName)?.usageMs || 0) / 1000));
      }, 0);
      setData((current) => {
        let changed = false;
        const sessions = [...current.sessions];
        current.appBindings.forEach((binding) => {
          const usage = usageByPackage.get(binding.packageName);
          const durationSec = Math.max(0, Math.floor((usage?.usageMs || 0) / 1000));
          const sessionId = automaticSessionId("app", today, binding.packageName, deviceId);
          const legacySessionId = `app_${today}_${binding.packageName}`;
          const deviceIndex = sessions.findIndex((session) => session.id === sessionId);
          const legacyIndex = sessions.findIndex((session) => session.id === legacySessionId && session.taskId === binding.taskId);
          const index = deviceIndex >= 0 ? deviceIndex : legacyIndex;
          const task = current.tasks.find((entry) => entry.id === binding.taskId);
          if (task && isOngoingTask(task)) {
            if (ongoingTaskStatus(task) !== "active") return;
            const deltaSec = ongoingDeltas.get(binding.id) || 0;
            if (!deltaSec) return;
            if (index < 0) {
              sessions.push({
                id: sessionId,
                taskId: binding.taskId,
                startedAt: new Date(Math.max(startTime, endTime - deltaSec * 1000)).toISOString(),
                endedAt: stamp,
                durationSec: deltaSec,
                status: "completed",
                source: "app",
                sourceAppName: binding.appName,
                sourcePackage: binding.packageName,
                updatedAt: stamp,
              });
            } else {
              const previous = sessions[index];
              sessions[index] = {
                ...previous,
                taskId: binding.taskId,
                durationSec: previous.durationSec + deltaSec,
                endedAt: stamp,
                source: "app",
                sourceAppName: binding.appName,
                sourcePackage: binding.packageName,
                updatedAt: stamp,
              };
            }
            changed = true;
            return;
          }
          if (index < 0) {
            if (!durationSec) return;
            sessions.push({
              id: sessionId,
              taskId: binding.taskId,
              startedAt: new Date(startTime).toISOString(),
              endedAt: new Date(Math.min(endTime, Math.max(startTime, usage?.lastTimeUsed || endTime))).toISOString(),
              durationSec,
              status: "completed",
              source: "app",
              sourceAppName: binding.appName,
              sourcePackage: binding.packageName,
              updatedAt: stamp,
            });
            changed = true;
            return;
          }
          const previous = sessions[index];
          const nextDuration = Math.max(previous.durationSec, durationSec);
          if (previous.taskId === binding.taskId && previous.sourceAppName === binding.appName && previous.durationSec === nextDuration) return;
          sessions[index] = {
            ...previous,
            taskId: binding.taskId,
            durationSec: nextDuration,
            endedAt: stamp,
            source: "app",
            sourceAppName: binding.appName,
            sourcePackage: binding.packageName,
            updatedAt: stamp,
          };
          changed = true;
        });
        return changed ? { ...current, sessions } : current;
      });
      setAppUsageMessage(`已自动更新今日应用时长${creditedSeconds ? ` · ${minutesLabel(creditedSeconds)}` : ""}`);
      if (showFeedback) notify("今日应用使用时长已更新");
    } catch {
      setAppUsageMessage("读取使用时长失败，请检查系统权限");
    } finally {
      if (showFeedback) setAppUsageBusy(false);
    }
  }

  async function requestUsageAccess() {
    if (!isAndroidApp) return;
    await NativeUsageStats.openUsageAccessSettings();
    setAppUsageMessage("请在系统页面中允许“循记”访问使用情况");
  }

  function bindSelectedApp() {
    const task = data.tasks.find((entry) => entry.id === bindingTaskId);
    const app = installedApps.find((entry) => entry.packageName === bindingPackage);
    if (!task) return notify("请先选择一个任务");
    if (!isTaskAvailableForFocus(task)) return notify("暂停或已结束的长期任务不能绑定应用，请先恢复任务");
    if (!app) return notify("请选择要绑定的应用");
    const stamp = new Date().toISOString();
    const existing = data.appBindings.find((binding) => binding.packageName === app.packageName);
    const binding: AppBinding = existing
      ? { ...existing, taskId: task.id, appName: app.label, updatedAt: stamp }
      : { id: uid("binding"), taskId: task.id, packageName: app.packageName, appName: app.label, createdAt: stamp, updatedAt: stamp };
    let observations: Record<string, UsageObservation> = {};
    try { observations = JSON.parse(localStorage.getItem(LOCAL_USAGE_OBSERVATION_KEY) || "{}") as Record<string, UsageObservation>; } catch { /* reset below */ }
    if (isOngoingTask(task)) observations[binding.id] = {
      date: today,
      taskId: task.id,
      statusUpdatedAt: task.ongoingStatusUpdatedAt || task.createdAt,
      usageMs: 0,
      active: false,
    };
    else delete observations[binding.id];
    localStorage.setItem(LOCAL_USAGE_OBSERVATION_KEY, JSON.stringify(observations));
    setData((current) => ({
      ...current,
      appBindings: existing
        ? current.appBindings.map((entry) => entry.id === existing.id ? binding : entry)
        : [binding, ...current.appBindings],
    }));
    notify(existingBindingLabel(data.appBindings, app.packageName) ? "应用绑定已更新" : "应用已绑定，正在统计今日时长");
  }

  function existingBindingLabel(bindings: AppBinding[], packageName: string) {
    return bindings.find((binding) => binding.packageName === packageName)?.appName || "";
  }

  function removeAppBinding(bindingId: string) {
    let observations: Record<string, UsageObservation> = {};
    try { observations = JSON.parse(localStorage.getItem(LOCAL_USAGE_OBSERVATION_KEY) || "{}") as Record<string, UsageObservation>; } catch { /* reset below */ }
    delete observations[bindingId];
    localStorage.setItem(LOCAL_USAGE_OBSERVATION_KEY, JSON.stringify(observations));
    setData((current) => ({ ...current, appBindings: current.appBindings.filter((binding) => binding.id !== bindingId) }));
    notify("已解除应用绑定，已有专注记录会保留");
  }

  async function loadWindowsApps() {
    if (!isWindowsClient) return;
    setWindowsAppsBusy(true);
    try {
      const apps = await invoke<WindowsRunningApp[]>("list_windows_apps");
      setWindowsApps(apps);
      if (!windowsBindingPath && apps.length) setWindowsBindingPath(apps[0].processPath);
    } catch {
      notify("无法读取当前运行的软件，请稍后重试");
    } finally {
      setWindowsAppsBusy(false);
    }
  }

  async function refreshWindowsTracker() {
    if (!isWindowsClient) return;
    try {
      const snapshot = await invoke<WindowsTrackerSnapshot>("get_tracker_state");
      setWindowsTracker(snapshot);
      const totalMap = new Map(snapshot.totals.map((entry) => [entry.bindingId, entry.seconds]));
      const stamp = new Date().toISOString();
      const deviceId = localDeviceId();
      setData((current) => {
        let changed = false;
        const sessions = [...current.sessions];
        current.windowsBindings.forEach((binding) => {
          const durationSec = Math.max(0, totalMap.get(binding.id) || 0);
          const sessionId = automaticSessionId("desktop", snapshot.date, binding.id, deviceId);
          const legacySessionId = `desktop_${snapshot.date}_${binding.id}`;
          const deviceIndex = sessions.findIndex((session) => session.id === sessionId);
          const legacyIndex = sessions.findIndex((session) => session.id === legacySessionId && session.taskId === binding.taskId);
          const index = deviceIndex >= 0 ? deviceIndex : legacyIndex;
          if (index < 0) {
            if (!durationSec) return;
            sessions.push({
              id: sessionId,
              taskId: binding.taskId,
              startedAt: parseDate(snapshot.date).toISOString(),
              endedAt: stamp,
              durationSec,
              status: "completed",
              source: "desktop",
              sourceAppName: binding.appName,
              sourcePackage: binding.processPath,
              updatedAt: stamp,
            });
            changed = true;
            return;
          }
          const previous = sessions[index];
          if (previous.durationSec === durationSec && previous.taskId === binding.taskId && previous.sourceAppName === binding.appName) return;
          sessions[index] = {
            ...previous,
            taskId: binding.taskId,
            durationSec: Math.max(previous.durationSec, durationSec),
            endedAt: stamp,
            source: "desktop",
            sourceAppName: binding.appName,
            sourcePackage: binding.processPath,
            updatedAt: stamp,
          };
          changed = true;
        });
        return changed ? { ...current, sessions } : current;
      });
    } catch {
      // The native tracker may briefly be unavailable while Windows resumes.
    }
  }

  function bindSelectedWindowsApp() {
    const task = data.tasks.find((entry) => entry.id === windowsBindingTaskId);
    const app = windowsApps.find((entry) => entry.processPath === windowsBindingPath);
    if (!task) return notify("请先选择一个任务");
    if (!isTaskAvailableForFocus(task)) return notify("暂停或已结束的长期任务不能绑定软件，请先恢复任务");
    if (!app) return notify("请先选择一个正在运行的软件");
    const stamp = new Date().toISOString();
    setData((current) => {
      const existing = current.windowsBindings.find((binding) => binding.processPath.toLowerCase() === app.processPath.toLowerCase());
      const binding: WindowsAppBinding = existing
        ? {
            ...existing,
            taskId: task.id,
            appName: app.appName,
            processName: app.processName,
            mode: windowsTrackingMode,
            idleThresholdSec: Math.max(30, windowsIdleMinutes * 60),
            updatedAt: stamp,
          }
        : {
            id: uid("winbinding"),
            taskId: task.id,
            appName: app.appName,
            processPath: app.processPath,
            processName: app.processName,
            mode: windowsTrackingMode,
            idleThresholdSec: Math.max(30, windowsIdleMinutes * 60),
            createdAt: stamp,
            updatedAt: stamp,
          };
      return {
        ...current,
        windowsBindings: existing
          ? current.windowsBindings.map((entry) => entry.id === existing.id ? binding : entry)
          : [binding, ...current.windowsBindings],
      };
    });
    notify("Windows 软件已绑定，后台计时已经生效");
  }

  function removeWindowsBinding(bindingId: string) {
    setData((current) => ({ ...current, windowsBindings: current.windowsBindings.filter((binding) => binding.id !== bindingId) }));
    notify("已解除 Windows 软件绑定，历史记录会保留");
  }

  async function toggleWindowsTracker() {
    const nextPaused = !windowsTracker?.paused;
    await invoke("set_tracker_paused", { paused: nextPaused });
    await refreshWindowsTracker();
    notify(nextPaused ? "Windows 自动计时已暂停" : "Windows 自动计时已继续");
  }

  async function toggleDesktopAutostart() {
    try {
      if (desktopAutostart) await disableAutostart();
      else await enableAutostart();
      setDesktopAutostart(!desktopAutostart);
      notify(desktopAutostart ? "已关闭开机启动" : "已开启开机启动");
    } catch {
      notify("无法修改开机启动设置");
    }
  }

  function toggleReview(taskId: string, index: number) {
    const task = taskMap.get(taskId);
    if (!task) return;
    const completed = [...task.completed];
    completed[index] = !completed[index];
    updateTask(taskId, { completed });
    notify(completed[index] ? "复习已完成 ✓" : "已恢复为待复习");
  }

  function toggleNormalTask(taskId: string) {
    const task = taskMap.get(taskId);
    if (!task || task.type !== "normal" || isOngoingTask(task)) return;
    updateTask(taskId, { normalCompleted: !task.normalCompleted });
    notify(task.normalCompleted ? "已恢复为待办" : "普通任务已完成 ✓");
  }

  function moveNormalTaskToToday(taskId: string) {
    const task = taskMap.get(taskId);
    if (!task || task.type !== "normal" || isOngoingTask(task)) return;
    const nowDate = new Date();
    const movedTask = { ...task, startDate: localISO(nowDate) };
    const pastTimeSlot = normalTaskStatus(movedTask, nowDate) === "overdue";
    updateTask(taskId, {
      startDate: localISO(nowDate),
      ...(pastTimeSlot ? { startTime: undefined, endTime: undefined } : {}),
    });
    notify(pastTimeSlot ? "任务已移到今天，过期时段已改为全天" : "任务已移到今天");
  }

  async function applyOngoingStatus(taskId: string, status: OngoingTaskStatus) {
    const task = taskMap.get(taskId);
    if (!task || !isOngoingTask(task)) return;
    if (ongoingTaskStatus(task) === "active" && status !== "active") {
      if (isAndroidApp) await refreshAppUsage();
      if (isWindowsClient) await refreshWindowsTracker();
    }
    if (status !== "active" && timer?.taskId === taskId) finishTimer("stopped");
    updateTask(taskId, { ongoingStatus: status, ongoingStatusUpdatedAt: new Date().toISOString(), normalCompleted: false });
    notify(status === "active" ? "长期任务已恢复" : status === "paused" ? "长期任务已暂停" : "长期任务已结束并归档");
  }

  async function setOngoingStatus(taskId: string, status: OngoingTaskStatus) {
    if (status === "completed") {
      setPendingTaskAction({ kind: "complete-ongoing", taskId });
      return;
    }
    await applyOngoingStatus(taskId, status);
  }

  function rescheduleCalendarTask(calendarId: string | number, nextDate: string, startTime?: string, endTime?: string) {
    const [taskId, target] = String(calendarId).split(":");
    const task = taskMap.get(taskId);
    if (!task) return;
    if (target === "ongoing-start" || target === "ongoing-target") return;
    if (target === "normal" && task.type === "normal") {
      updateTask(taskId, { startDate: nextDate, startTime, endTime });
      notify("任务时间已调整");
      return;
    }
    if (target === "initial" && task.type === "memory") {
      const reviewDates = INTERVALS.map((days, index) => task.completed[index] ? reviewDate(task, index) : addDays(nextDate, days));
      updateTask(taskId, { startDate: nextDate, reviewDates });
      notify("首次学习日期与后续复习已重新排期");
      return;
    }
    const reviewIndex = Number(target);
    if (task.type === "memory" && Number.isInteger(reviewIndex) && reviewIndex >= 0 && reviewIndex < INTERVALS.length) {
      const reviewDates = [...(task.reviewDates || INTERVALS.map((days) => addDays(task.startDate, days)))];
      reviewDates[reviewIndex] = nextDate;
      updateTask(taskId, { reviewDates });
      notify(`第 ${reviewIndex + 1} 轮复习已移动`);
    }
  }

  function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") || "").trim();
    if (!title) return;
    const stamp = new Date().toISOString();
    const requestedType = String(form.get("type") || "memory") as NewTaskKind;
    const isOngoing = requestedType === "ongoing";
    const type = requestedType === "memory" ? "memory" as const : "normal" as const;
    const startDate = String(form.get("startDate") || today);
    const startTime = String(form.get("startTime") || "");
    const endTime = String(form.get("endTime") || "");
    const targetDate = String(form.get("targetDate") || "");
    const dailyGoalValue = String(form.get("dailyGoalMinutes") || "");
    if (type === "normal" && !isOngoing && startTime && endTime && endTime <= startTime) return notify("结束时间需要晚于开始时间");
    if (isOngoing && targetDate && targetDate < startDate) return notify("目标日期不能早于开始日期");
    const tags = String(form.get("tags") || "").split(/[，,]/).map((tag) => tag.trim()).filter(Boolean);
    const task: Task = {
      id: uid("task"),
      type,
      title,
      categoryId: String(form.get("category") || ""),
      tags: [...new Set(tags)],
      startDate,
      startTime: type === "normal" && !isOngoing ? startTime : undefined,
      endTime: type === "normal" && !isOngoing ? endTime : undefined,
      scheduleMode: type === "normal" ? (isOngoing ? "ongoing" : "once") : undefined,
      ongoingStatus: isOngoing ? "active" : undefined,
      ongoingStatusUpdatedAt: isOngoing ? stamp : undefined,
      targetDate: isOngoing && targetDate ? targetDate : undefined,
      dailyGoalMinutes: isOngoing && Number(dailyGoalValue) > 0 ? Math.min(1_440, Math.round(Number(dailyGoalValue))) : undefined,
      normalCompleted: false,
      reviewDates: type === "memory" ? INTERVALS.map((days) => addDays(startDate, days)) : [],
      completed: type === "memory" ? INTERVALS.map(() => false) : [],
      createdAt: stamp,
      updatedAt: stamp,
    };
    task.tagChanges = Object.fromEntries(task.tags.map((tag) => [tag, { present: true, updatedAt: stamp }]));
    setData((current) => ({ ...current, tasks: [task, ...current.tasks] }));
    setTimerTaskId(task.id);
    setShowAdd(false);
    setNewTaskType("memory");
    setCalendarDraft(null);
    notify(type === "memory" ? "记忆任务已添加，复习节点已排好" : isOngoing ? "长期任务已创建，可以持续累计投入" : "普通任务已添加");
  }

  function editTask(task: Task) {
    setEditingTask({ ...task, tags: [...task.tags] });
    setNewEditTag("");
  }

  function saveEditedTask(event: FormEvent) {
    event.preventDefault();
    if (!editingTask) return;
    const title = editingTask.title.trim();
    if (!title) return notify("任务名称不能为空");
    if (editingTask.type === "normal" && !isOngoingTask(editingTask) && editingTask.startTime && editingTask.endTime && editingTask.endTime <= editingTask.startTime) return notify("结束时间需要晚于开始时间");
    if (isOngoingTask(editingTask) && editingTask.targetDate && editingTask.targetDate < editingTask.startDate) return notify("目标日期不能早于开始日期");
    const previous = taskMap.get(editingTask.id);
    const reviewDates = editingTask.type === "memory" && previous && previous.startDate !== editingTask.startDate
      ? INTERVALS.map((days, index) => previous.completed[index] ? reviewDate(previous, index) : addDays(editingTask.startDate, days))
      : editingTask.reviewDates;
    updateTask(editingTask.id, { ...editingTask, title, reviewDates, tagChanges: getTagChanges(editingTask) });
    setEditingTask(null);
    notify("任务信息已更新");
  }

  function addEditTag() {
    const tag = newEditTag.trim().replace(/^#/, "");
    if (!editingTask || !tag || editingTask.tags.includes(tag)) return;
    const stamp = new Date().toISOString();
    setEditingTask({ ...editingTask, tags: [...editingTask.tags, tag], tagChanges: { ...getTagChanges(editingTask), [tag]: { present: true, updatedAt: stamp } } });
    setNewEditTag("");
  }

  function removeTaskTag(task: Task, tag: string) {
    const stamp = new Date().toISOString();
    updateTask(task.id, { tags: task.tags.filter((entry) => entry !== tag), tagChanges: { ...getTagChanges(task), [tag]: { present: false, updatedAt: stamp } } });
    notify(`已删除标签 #${tag}`);
  }

  function deleteTask(task: Task) {
    setPendingTaskAction({ kind: "delete", taskId: task.id });
  }

  function applyDeleteTask(task: Task) {
    const deletedAt = new Date().toISOString();
    setData((current) => ({
      ...current,
      tasks: current.tasks.filter((entry) => entry.id !== task.id),
      deletedTasks: [...current.deletedTasks.filter((entry) => entry.id !== task.id), { id: task.id, deletedAt }],
      appBindings: current.appBindings.filter((binding) => binding.taskId !== task.id),
      windowsBindings: current.windowsBindings.filter((binding) => binding.taskId !== task.id),
    }));
    notify("任务已删除");
  }

  async function confirmPendingTaskAction() {
    const action = pendingTaskAction;
    const task = action ? taskMap.get(action.taskId) : undefined;
    setPendingTaskAction(null);
    if (!action || !task) return;
    if (action.kind === "complete-ongoing") await applyOngoingStatus(task.id, "completed");
    else applyDeleteTask(task);
  }

  function startTimer(taskIdOverride?: string) {
    const taskId = taskIdOverride || timerTaskId || data.tasks.find(isTaskAvailableForFocus)?.id;
    if (!taskId) return notify("请先选择或添加一个任务");
    const selectedTask = taskMap.get(taskId);
    if (!selectedTask || !isTaskAvailableForFocus(selectedTask)) return notify("这个任务当前不可专注，请先恢复任务");
    const durationSec = Math.max(1, data.settings.focusMinutes) * 60;
    const startedAt = new Date().toISOString();
    setTimerTaskId(taskId);
    setTimer({ taskId, startedAt, durationSec, endAt: Date.now() + durationSec * 1000, running: true, pausedRemaining: durationSec });
    setNow(Date.now());
    if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission();
  }

  function pauseTimer() {
    if (!timer?.running) return;
    setTimer({ ...timer, running: false, pausedRemaining: remaining });
  }

  function resumeTimer() {
    if (!timer || timer.running) return;
    setTimer({ ...timer, running: true, endAt: Date.now() + timer.pausedRemaining * 1000 });
    setNow(Date.now());
  }

  function finishTimer(status: "completed" | "stopped", natural = false) {
    if (!timer) return;
    const elapsed = natural ? timer.durationSec : Math.max(0, timer.durationSec - remaining);
    const stamp = new Date().toISOString();
    const session: FocusSession | null = elapsed > 0 ? {
      id: uid("focus"), taskId: timer.taskId, startedAt: timer.startedAt, endedAt: stamp,
      durationSec: elapsed, status, source: "timer", updatedAt: stamp,
    } : null;
    if (session) setData((current) => ({ ...current, sessions: [session, ...current.sessions] }));
    setTimer(null);
    if (natural && session && "Notification" in window && Notification.permission === "granted") {
      new Notification("本轮专注完成", { body: taskMap.get(session.taskId)?.title || "做得很好，休息一下吧。" });
    }
    notify(natural ? "本轮专注完成，已计入统计" : session ? "本次专注时长已保存" : "专注已结束，本次未产生计时");
  }

  async function syncRequest(code: string, body: Record<string, unknown>) {
    const url = getSyncApiUrl();
    const data = { ...body, code };

    if (Capacitor.isNativePlatform()) {
      const response = await CapacitorHttp.post({
        url,
        headers: { "Content-Type": "application/json" },
        data,
      });
      return new Response(typeof response.data === "string" ? response.data : JSON.stringify(response.data), {
        status: response.status,
        headers: response.headers,
      });
    }

    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  }

  async function readSyncResponse(response: Response) {
    const body = await response.text();
    try {
      return JSON.parse(body) as SyncResponsePayload;
    } catch {
      const returnedHtml = /^\s*<(?:!doctype|html)\b/i.test(body);
      throw new Error(
        returnedHtml
          ? "同步服务器地址返回了网页，请安装已配置同步服务的最新版应用"
          : "同步服务器返回的数据格式不正确，请稍后重试",
      );
    }
  }

  async function pullAndMerge(code: string) {
    setSyncStatus("syncing");
    setSyncMessage("正在检查云端数据…");
    try {
      const response = await syncRequest(code, { action: "pull" });
      const result = await readSyncResponse(response);
      if (!response.ok) {
        throw new Error(typeof result.error === "string" ? result.error : `同步服务返回 ${response.status}`);
      }
      revisionRef.current = result.revision || 0;
      if (result.found && result.data) setData((current) => mergeData(current, normalizeData(result.data)));
      else await pushData(code, data, 0);
      localStorage.setItem(LOCAL_SYNC_KEY, JSON.stringify({ code, revision: revisionRef.current }));
      setSyncStatus("synced");
      setSyncMessage(result.found ? "云端数据已合并，本机修改会自动上传" : "已创建新的云端数据空间");
    } catch (error) {
      setSyncStatus("error");
      setSyncMessage(error instanceof Error ? error.message : "同步失败，请检查网络后重试");
    }
  }

  async function pushData(code: string, payload: AppData, forcedRevision?: number) {
    setSyncStatus("syncing");
    setSyncMessage("正在保存到云端…");
    try {
      const response = await syncRequest(code, { action: "push", data: payload, revision: forcedRevision ?? revisionRef.current });
      if (response.status === 409) {
        const conflict = await readSyncResponse(response);
        const merged = conflict.data ? mergeData(payload, normalizeData(conflict.data)) : payload;
        const retry = await syncRequest(code, { action: "push", data: merged, revision: conflict.revision || 0 });
        const result = await readSyncResponse(retry);
        if (!retry.ok) {
          throw new Error(typeof result.error === "string" ? result.error : `同步服务返回 ${retry.status}`);
        }
        revisionRef.current = Number(result.revision) || 0;
        setData(merged);
      } else {
        const result = await readSyncResponse(response);
        if (!response.ok) {
          throw new Error(typeof result.error === "string" ? result.error : `同步服务返回 ${response.status}`);
        }
        revisionRef.current = Number(result.revision) || 0;
      }
      localStorage.setItem(LOCAL_SYNC_KEY, JSON.stringify({ code, revision: revisionRef.current }));
      setSyncStatus("synced");
      setSyncMessage(`已同步 · 云端版本 ${revisionRef.current}`);
    } catch (error) {
      setSyncStatus("error");
      setSyncMessage(error instanceof Error ? error.message : "暂时无法连接云端，本机数据不会丢失");
    }
  }

  function normalizeSyncCode(value: string) {
    const clean = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
    return clean.match(/.{1,4}/g)?.join("-") || "";
  }

  async function connectSync() {
    const code = normalizeSyncCode(syncInput);
    if (code.replace(/-/g, "").length < 12) return notify("同步码至少需要 12 位");
    setSyncInput(code);
    revisionRef.current = 0;
    localStorage.setItem(LOCAL_SYNC_KEY, JSON.stringify({ code, revision: 0 }));
    if (syncCode === code) {
      await pullAndMerge(code);
    } else {
      skipAutoSync.current = true;
      setSyncCode(code);
      setSyncStatus("syncing");
      setSyncMessage("正在连接这个同步码…");
    }
    notify("同步码已启用");
  }

  function generateSyncCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const values = crypto.getRandomValues(new Uint8Array(12));
    const code = Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
    const formatted = code.match(/.{1,4}/g)?.join("-") || code;
    setSyncInput(formatted);
    revisionRef.current = 0;
    skipAutoSync.current = true;
    localStorage.setItem(LOCAL_SYNC_KEY, JSON.stringify({ code: formatted, revision: 0 }));
    setSyncCode(formatted);
    setSyncStatus("syncing");
    setSyncMessage("正在创建新的云端数据空间…");
    notify("安全同步码已生成并启用");
  }

  function disconnectSync() {
    setSyncCode("");
    setSyncInput("");
    revisionRef.current = 0;
    localStorage.removeItem(LOCAL_SYNC_KEY);
    setSyncStatus("local");
    setSyncMessage("尚未启用跨设备同步");
    notify("已断开云同步，本机数据仍保留");
  }

  async function exportData() {
    const fileName = `循记备份-${today}.json`;
    const contents = JSON.stringify(data, null, 2);

    try {
      if (isAndroidApp) {
        const saved = await Filesystem.writeFile({
          path: fileName,
          data: contents,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
        });
        await Share.share({
          title: "循记 JSON 备份",
          files: [saved.uri],
          dialogTitle: "保存或分享备份",
        });
        return;
      }

      if (isWindowsClient) {
        const exported = await invoke<boolean>("export_backup", { contents, defaultName: fileName });
        if (!exported) return;
        notify("备份已导出");
        return;
      }

      const blob = new Blob([contents], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      notify("备份已导出");
    } catch (error) {
      console.error("Failed to export backup", error);
      notify("导出失败，请重试");
    }
  }

  async function importData(file: File) {
    try {
      const parsed = normalizeData(JSON.parse(await file.text()));
      if (!window.confirm("导入后将与当前数据合并，是否继续？")) return;
      setData((current) => mergeData(current, parsed));
      notify("备份已导入");
    } catch { notify("无法识别这个备份文件"); }
  }

  function addCategory(event: FormEvent) {
    event.preventDefault();
    const name = newCategory.trim();
    if (!name) return;
    const palette = ["#3f7c71", "#9a7045", "#805c75", "#55758a"];
    setData((current) => ({
      ...current,
      categories: [...current.categories, { id: uid("cat"), name, color: palette[current.categories.length % palette.length] }],
    }));
    setNewCategory("");
  }

  function deleteCategory(category: Category) {
    const affected = data.tasks.filter((task) => task.categoryId === category.id).length;
    const replacement = data.categories.find((entry) => entry.id !== category.id);
    const message = affected
      ? `删除“${category.name}”后，其中 ${affected} 个任务会移动到“${replacement?.name || "未分类"}”，是否继续？`
      : `确定删除分类“${category.name}”吗？`;
    if (!window.confirm(message)) return;
    const stamp = new Date().toISOString();
    setData((current) => ({
      ...current,
      categories: current.categories.filter((entry) => entry.id !== category.id),
      tasks: current.tasks.map((task) => task.categoryId === category.id ? { ...task, categoryId: replacement?.id || "", updatedAt: stamp } : task),
    }));
    notify(`已删除分类“${category.name}”`);
  }

  function rescheduleOverdueReviews() {
    const nodes = data.tasks.filter((task) => task.type === "memory").flatMap((task) => INTERVALS.map((_, index) => ({ task, index }))
      .filter((node) => reviewStatus(node.task, node.index) === "overdue"))
      .sort((a, b) => reviewDate(a.task, a.index).localeCompare(reviewDate(b.task, b.index)));
    if (!nodes.length) return notify("没有需要顺延的逾期复习");
    const days = Math.max(3, Math.ceil(nodes.length / 4));
    const perDay = Math.ceil(nodes.length / days);
    if (!window.confirm(`将 ${nodes.length} 个逾期复习平均分摊到未来 ${days} 天，是否继续？`)) return;

    // Today's scheduled reviews stay put. Rescheduled reviews start tomorrow and
    // avoid every other unfinished review date of the same task.
    const reservedDates = new Map(data.tasks.filter((task) => task.type === "memory").map((task) => [task.id, new Set(
      INTERVALS.flatMap((_, index) => reviewStatus(task, index) !== "overdue" ? [reviewDate(task, index)] : []),
    )]));
    const scheduledPerDay = new Map<string, number>();
    const schedule = new Map<string, string>();
    nodes.forEach((node) => {
      const reserved = reservedDates.get(node.task.id)!;
      let offset = 1;
      while (reserved.has(addDays(today, offset)) || (scheduledPerDay.get(addDays(today, offset)) || 0) >= perDay) offset += 1;
      const date = addDays(today, offset);
      reserved.add(date);
      scheduledPerDay.set(date, (scheduledPerDay.get(date) || 0) + 1);
      schedule.set(`${node.task.id}-${node.index}`, date);
    });
    const stamp = new Date().toISOString();
    setData((current) => ({
      ...current,
      tasks: current.tasks.map((task) => {
        if (task.type === "normal") return task;
        const reviewDates = INTERVALS.map((daysToAdd, index) => schedule.get(`${task.id}-${index}`) || reviewDate(task, index) || addDays(task.startDate, daysToAdd));
        return schedule.size && reviewDates.some((date, index) => date !== reviewDate(task, index))
          ? { ...task, reviewDates, updatedAt: stamp }
          : task;
      }),
    }));
    notify(`已将逾期复习分摊到未来 ${days} 天`);
  }

  const dueTasks = useMemo(() => data.tasks.filter((task) => task.type === "memory" && task.completed.some((_, index) => {
    const status = reviewStatus(task, index);
    return status === "due" || status === "overdue";
  })), [data.tasks]);
  const overdueCount = data.tasks.filter((task) => task.type === "memory").reduce((sum, task) => sum + INTERVALS.filter((_, index) => reviewStatus(task, index) === "overdue").length, 0);
  const normalStatusNow = new Date(now);
  const todayNormalTasks = data.tasks
    .filter((task) => task.type === "normal" && ["today", "overdue"].includes(normalTaskStatus(task, normalStatusNow)))
    .sort((a, b) => {
      const aOverdue = normalTaskStatus(a, normalStatusNow) === "overdue";
      const bOverdue = normalTaskStatus(b, normalStatusNow) === "overdue";
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
      return a.startDate.localeCompare(b.startDate);
    });
  const todayAttentionCount = dueTasks.length + todayNormalTasks.length;

  const visibleTasks = useMemo(() => data.tasks.filter((task) => {
    const matchesCategory = categoryFilter === "all" || task.categoryId === categoryFilter;
    const query = search.trim().toLowerCase();
    const matchesSearch = !query || task.title.toLowerCase().includes(query) || task.tags.some((tag) => tag.toLowerCase().includes(query));
    const matchesState = taskFilter === "all" || taskListState(task) === taskFilter;
    return matchesCategory && matchesSearch && matchesState;
  }), [data.tasks, categoryFilter, search, taskFilter]);

  const todaySessions = data.sessions.filter((session) => localISO(new Date(session.startedAt)) === today);
  const todaySeconds = todaySessions.reduce((sum, session) => sum + session.durationSec, 0);
  const totalSeconds = data.sessions.reduce((sum, session) => sum + session.durationSec, 0);
  const focusTotals = focusSecondsByTask(data.sessions);
  const todayFocusTotals = focusSecondsByTask(todaySessions);
  const activeOngoingTasks = data.tasks.filter((task) => isOngoingTask(task) && ongoingTaskStatus(task) === "active");
  const activeTaskCount = countActiveTasks(data.tasks);
  const pausedTaskCount = data.tasks.filter((task) => taskListState(task) === "paused").length;
  const ongoingSummaries = activeOngoingTasks.map((task) => ({
    task,
    todaySeconds: todayFocusTotals.get(task.id) || 0,
    totalSeconds: focusTotals.get(task.id) || 0,
  }));
  const memoryTasks = data.tasks.filter((task) => task.type === "memory");
  const completedReviews = memoryTasks.reduce((sum, task) => sum + task.completed.filter(Boolean).length, 0);
  const totalReviews = memoryTasks.length * INTERVALS.length;
  const weekly = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    const iso = localISO(date);
    const seconds = data.sessions.filter((session) => localISO(new Date(session.startedAt)) === iso).reduce((sum, session) => sum + session.durationSec, 0);
    return { iso, label: new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date), minutes: Math.round(seconds / 60) };
  });
  const maxDayMinutes = Math.max(30, ...weekly.map((day) => day.minutes));
  const categoryStats = data.categories.map((category) => {
    const taskIds = new Set(data.tasks.filter((task) => task.categoryId === category.id).map((task) => task.id));
    const seconds = [...taskIds].reduce((sum, taskId) => sum + (focusTotals.get(taskId) || 0), 0);
    return { ...category, seconds };
  }).sort((a, b) => b.seconds - a.seconds);
  const topTasks = data.tasks.map((task) => ({
    task,
    seconds: focusTotals.get(task.id) || 0,
  })).filter((entry) => entry.seconds > 0).sort((a, b) => b.seconds - a.seconds).slice(0, 5);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setTab("today")} aria-label="返回今日">
          <span className="brand-mark">循</span><span><strong>循记</strong><small>学习节奏中心</small></span>
        </button>
        <nav>{NAV_ITEMS.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><span><NavIcon name={item.id} /></span>{item.label}</button>)}</nav>
        <div className="sidebar-foot">
          <span className={`sync-dot ${syncStatus}`} />
          <div><strong>{syncCode ? "云端已连接" : "仅保存在本机"}</strong><small>{syncStatus === "syncing" ? "正在同步…" : syncStatus === "error" ? "离线，稍后重试" : "数据状态正常"}</small></div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div><p className="eyebrow date-time" suppressHydrationWarning>{dateTimeLabel(now)}</p><h1>{NAV_ITEMS.find((item) => item.id === tab)?.label}</h1></div>
          <div className="topbar-actions">
            <button className="theme-toggle" type="button" onClick={toggleTheme} aria-label={`切换到${theme === "light" ? "深色" : "浅色"}模式`} title={`切换到${theme === "light" ? "深色" : "浅色"}模式`}>
              <ThemeIcon theme={theme} /><span>{theme === "light" ? "深色" : "浅色"}</span>
            </button>
            {tab !== "calendar" && <button className="primary" onClick={() => { setCalendarDraft(null); setNewTaskType("memory"); setShowAdd(true); }}>＋ 新建任务</button>}
          </div>
        </header>

        {tab === "today" && <section className="page-stack">
          <div className="hero-card">
            <div className="hero-atmosphere" aria-hidden="true"><i /><i /><i /><span /></div>
            <div><p className="eyebrow">今日节奏</p><h2>{todayAttentionCount ? `今天有 ${todayAttentionCount} 项值得专注` : "今天，可以从容开始"}</h2><p>{todayAttentionCount ? "先完成到期任务，再用一轮专注推进最重要的学习。" : "当前没有到期安排。创建一个学习任务，循记会替你排好复习节奏。"}</p><div className="hero-actions">{overdueCount > 0 ? <button className="hero-action" onClick={rescheduleOverdueReviews}>重新规划 {overdueCount} 个逾期复习</button> : data.tasks.length ? <button className="hero-action" onClick={() => setTab("focus")}>开始一轮专注</button> : <button className="hero-action" onClick={() => { setCalendarDraft(null); setNewTaskType("memory"); setShowAdd(true); }}>创建学习任务</button>}</div></div>
            <div className="hero-progress"><strong>{Math.min(100, Math.round(todaySeconds / 60 / data.settings.dailyGoalMinutes * 100))}%</strong><span>今日专注目标</span></div>
          </div>
          <div className="content-grid">
            <div className="panel wide">
              <PanelTitle title="今日安排" subtitle="普通任务与到期复习统一处理" action={todayAttentionCount ? `${todayAttentionCount} 项` : "已清空"} />
              {todayAttentionCount ? <div className="review-list">{todayNormalTasks.map((task) => <TodayNormalTask key={task.id} task={task} category={categoryMap.get(task.categoryId)} now={normalStatusNow} onToggle={toggleNormalTask} onMoveToToday={moveNormalTaskToToday} />)}{dueTasks.slice(0, 6).map((task) => <TodayTask key={task.id} task={task} category={categoryMap.get(task.categoryId)} onToggle={toggleReview} />)}</div> : <Empty icon="✓" title="今天没有待办任务" text="可以创建新的学习任务，循记会自动安排后续复习。" action={{ label: "新建学习任务", onClick: () => { setCalendarDraft(null); setNewTaskType("memory"); setShowAdd(true); } }} />}
            </div>
            <div className="panel focus-quick">
              <PanelTitle title="快速专注" subtitle={`${data.settings.focusMinutes} 分钟一轮`} />
              <TaskPicker value={timerTaskId} onChange={setTimerTaskId} tasks={data.tasks.filter(isTaskAvailableForFocus)} label="选择专注任务" />
              <div className="mini-timer">{data.settings.focusMinutes}<small>分钟</small></div>
              <button className="primary block" onClick={() => { startTimer(); setTab("focus"); }}>开始专注</button>
            </div>
          </div>
          {ongoingSummaries.length > 0 && <div className="panel ongoing-panel">
            <PanelTitle title="持续推进" subtitle="长期任务不会每天重复创建，所有投入都会持续累计" action={`${ongoingSummaries.length} 项进行中`} />
            <div className="ongoing-list">{ongoingSummaries.map(({ task, todaySeconds: taskTodaySeconds, totalSeconds: taskTotalSeconds }) => {
              const goalSeconds = (task.dailyGoalMinutes || 0) * 60;
              const progress = goalSeconds ? Math.min(100, Math.round(taskTodaySeconds / goalSeconds * 100)) : 0;
              return <article key={task.id} className="ongoing-item">
                <div className="ongoing-item-head"><div><span>{categoryMap.get(task.categoryId)?.name || "未分类"} · 长期任务</span><strong>{task.title}</strong></div>{task.targetDate && <small className={ongoingTargetReached(task, today) ? "target-reached" : ""}>{ongoingTargetReached(task, today) ? "目标日期已到" : `目标 ${dateLabel(task.targetDate)}`}</small>}</div>
                <div className="ongoing-metrics"><span><small>今日投入</small><strong>{minutesLabel(taskTodaySeconds)}</strong></span><span><small>累计投入</small><strong>{minutesLabel(taskTotalSeconds)}</strong></span>{task.dailyGoalMinutes && <span><small>每日目标</small><strong>{Math.round(taskTodaySeconds / 60)} / {task.dailyGoalMinutes} 分钟</strong></span>}</div>
                {goalSeconds > 0 && <div className="ongoing-progress" aria-label={`今日目标完成 ${progress}%`}><i style={{ width: `${progress}%` }} /></div>}
                <button className="primary" type="button" onClick={() => { startTimer(task.id); setTab("focus"); }}>开始专注</button>
              </article>;
            })}</div>
          </div>}
          <div className="metric-grid overview-metrics">
            <Metric label="待复习" value={String(dueTasks.length)} note={dueTasks.some((task) => task.completed.some((_, i) => reviewStatus(task, i) === "overdue")) ? "包含逾期节点" : "节奏正常"} tone="warm" />
            <Metric label="今日专注" value={minutesLabel(todaySeconds)} note={`${todaySessions.length} 次记录`} />
            <Metric label="复习进度" value={totalReviews ? `${Math.round(completedReviews / totalReviews * 100)}%` : "—"} note={totalReviews ? `完成 ${completedReviews} 个节点` : "等待第一个任务"} />
            <Metric label="累计投入" value={totalSeconds ? minutesLabel(totalSeconds) : "—"} note={data.sessions.length ? `${data.sessions.length} 次专注` : "尚无专注记录"} />
          </div>
        </section>}

        {tab === "calendar" && <section className="page-stack calendar-page">
          <CalendarApp
            tasks={calendarTasks}
            onCreateTask={(preset) => {
              setCalendarDraft(preset ? { date: preset.date, startTime: preset.startTime, endTime: preset.endTime } : null);
              setNewTaskType(preset?.type || "normal");
              setShowAdd(true);
            }}
            onRescheduleTask={rescheduleCalendarTask}
            onToggleComplete={(calendarId) => {
              const [taskId, target] = String(calendarId).split(":");
              if (target === "ongoing-start" || target === "ongoing-target") return;
              if (target === "normal") toggleNormalTask(taskId);
              else if (target !== "initial") toggleReview(taskId, Number(target));
            }}
          />
        </section>}

        {tab === "tasks" && <section className="page-stack">
          <div className="filter-bar">
            <div className="category-tabs"><button className={categoryFilter === "all" ? "active" : ""} onClick={() => setCategoryFilter("all")}>全部</button>{data.categories.map((category) => <button key={category.id} className={categoryFilter === category.id ? "active" : ""} onClick={() => setCategoryFilter(category.id)}><i style={{ background: category.color }} />{category.name}</button>)}</div>
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索任务或标签" aria-label="搜索任务或标签" />
          </div>
          <div className="subfilters"><button className={taskFilter === "active" ? "active" : ""} onClick={() => setTaskFilter("active")}>进行中</button><button className={taskFilter === "paused" ? "active" : ""} onClick={() => setTaskFilter("paused")}>已暂停</button><button className={taskFilter === "all" ? "active" : ""} onClick={() => setTaskFilter("all")}>全部</button><button className={taskFilter === "done" ? "active" : ""} onClick={() => setTaskFilter("done")}>已完成 / 归档</button><span>{visibleTasks.length} 个任务</span></div>
          {visibleTasks.length ? <div className="task-grid">{visibleTasks.map((task) => <TaskCard key={task.id} task={task} category={categoryMap.get(task.categoryId)} now={normalStatusNow} todaySeconds={todayFocusTotals.get(task.id) || 0} totalSeconds={focusTotals.get(task.id) || 0} onToggle={toggleReview} onToggleNormal={() => toggleNormalTask(task.id)} onMoveToToday={() => moveNormalTaskToToday(task.id)} onSetOngoingStatus={(status) => setOngoingStatus(task.id, status)} onEdit={() => editTask(task)} onDelete={() => deleteTask(task)} onRemoveTag={(tag) => removeTaskTag(task, tag)} onFocus={() => { setTimerTaskId(task.id); setTab("focus"); }} />)}</div> : <div className="panel"><Empty icon="□" title="没有符合条件的任务" text="试试切换分类，或者新建一个任务。" /></div>}
        </section>}

        {tab === "focus" && <section className="page-stack focus-layout">
          <div className="panel timer-panel">
            <p className="eyebrow">专注计时</p>
            <TaskPicker value={timer?.taskId || timerTaskId} onChange={setTimerTaskId} tasks={data.tasks.filter((task) => isTaskAvailableForFocus(task) || task.id === timer?.taskId)} label="当前专注任务" disabled={Boolean(timer)} />
            <div className={`timer-ring ${timer?.running ? "running" : ""}`} style={{ "--progress": timer ? `${Math.max(0, 100 - remaining / timer.durationSec * 100)}%` : "0%" } as React.CSSProperties}>
              <div><strong>{String(Math.floor((timer ? remaining : data.settings.focusMinutes * 60) / 60)).padStart(2, "0")}:{String((timer ? remaining : 0) % 60).padStart(2, "0")}</strong><span>{timer ? (timer.running ? "保持专注" : "已暂停") : "准备开始"}</span></div>
            </div>
            <div className="timer-actions">{!timer ? <button className="primary large" onClick={() => startTimer()}>开始专注</button> : <><button className="secondary large" onClick={timer.running ? pauseTimer : resumeTimer}>{timer.running ? "暂停" : "继续"}</button><button className="ghost large" onClick={() => finishTimer("stopped")}>结束并保存</button></>}</div>
            <p className="timer-tip">锁屏或切换应用后，重新打开仍会按实际时间恢复。</p>
          </div>
          <div className="panel session-panel">
            <PanelTitle title="今日记录" subtitle={`累计 ${minutesLabel(todaySeconds)}`} />
            {todaySessions.length ? <div className="session-list">{todaySessions.map((session) => <div key={session.id}><span className={`session-dot ${session.source === "app" || session.source === "desktop" ? "automatic" : ""}`} /><div><strong>{taskMap.get(session.taskId)?.title || "已删除任务"}</strong><small>{session.source === "app" || session.source === "desktop" ? `自动记录 · ${session.sourceAppName || "已绑定应用"}` : new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(session.startedAt))}</small></div><b>{minutesLabel(session.durationSec)}</b></div>)}</div> : <Empty icon="◷" title="今天还没有专注记录" text="完成第一轮或使用已绑定应用后，时间会自动记在这里。" />}
          </div>
        </section>}

        {tab === "stats" && <section className="page-stack">
          <div className="metric-grid stats-metrics"><Metric label="累计专注" value={minutesLabel(totalSeconds)} note={`${data.sessions.length} 次记录`} /><Metric label="今日专注" value={minutesLabel(todaySeconds)} note={`目标 ${data.settings.dailyGoalMinutes} 分钟`} /><Metric label="完成复习" value={String(completedReviews)} note={`共 ${totalReviews} 个节点`} /><Metric label="活跃任务" value={String(activeTaskCount)} note={`${pausedTaskCount ? `${pausedTaskCount} 项暂停 · ` : ""}共 ${data.tasks.length} 个任务`} /></div>
          <div className="content-grid stats-grid">
            <div className="panel wide"><PanelTitle title="最近 7 天" subtitle="每日有效专注分钟" /><div className="bar-chart">{weekly.map((day) => <div key={day.iso} className={day.iso === today ? "today" : ""}><span>{day.minutes || ""}</span><i style={{ height: `${Math.max(5, day.minutes / maxDayMinutes * 100)}%` }} /><small>{day.label}</small></div>)}</div></div>
            <div className="panel"><PanelTitle title="分类投入" subtitle="累计专注时长" />{categoryStats.some((entry) => entry.seconds) ? <div className="category-stats">{categoryStats.map((entry) => <div key={entry.id}><span><i style={{ background: entry.color }} />{entry.name}</span><strong>{minutesLabel(entry.seconds)}</strong><div><i style={{ width: `${totalSeconds ? entry.seconds / totalSeconds * 100 : 0}%`, background: entry.color }} /></div></div>)}</div> : <Empty icon="▥" title="还没有统计数据" text="完成番茄钟后会自动生成。" />}</div>
          </div>
          <div className="panel"><PanelTitle title="投入最多的任务" subtitle="帮助你看见时间去了哪里" />{topTasks.length ? <div className="ranking">{topTasks.map((entry, index) => <div key={entry.task.id}><b>{String(index + 1).padStart(2, "0")}</b><span><strong>{entry.task.title}</strong><small>{categoryMap.get(entry.task.categoryId)?.name || "未分类"}{isOngoingTask(entry.task) ? ` · 长期任务 · ${ongoingTaskStatus(entry.task) === "active" ? "进行中" : ongoingTaskStatus(entry.task) === "paused" ? "已暂停" : "已结束"}` : ""}</small></span><em>{minutesLabel(entry.seconds)}</em></div>)}</div> : <Empty icon="↗" title="排行榜等待第一条记录" text="开始专注后，这里会按累计时间排序。" />}</div>
        </section>}

        {tab === "settings" && <section className="page-stack settings-grid">
          {isWindowsClient && <div className="panel settings-card app-usage-card windows-tracker-card">
            <PanelTitle title="Windows 软件自动计时" subtitle="按软件类型选择操作、阅读或播放规则" />
            <div className={`usage-permission ${windowsTracker?.paused ? "required" : "granted"}`}>
              <span>{windowsTracker?.paused ? "Ⅱ" : windowsTracker?.current.counting ? "●" : "✓"}</span>
              <div>
                <strong>{windowsTracker?.paused ? "自动计时已暂停" : windowsTracker?.current.counting ? `正在计时 · ${windowsTracker.current.appName}` : "后台监测正常"}</strong>
                <small>{windowsTracker?.current.reason || "正在连接 Windows 专注助手…"}{windowsTracker?.current.foregroundApp ? ` · 当前 ${windowsTracker.current.foregroundApp}` : ""}</small>
              </div>
              <button className="secondary" type="button" onClick={() => void toggleWindowsTracker()}>{windowsTracker?.paused ? "继续计时" : "暂停计时"}</button>
            </div>
            <div className="desktop-binding-form">
              <label>计入任务<select value={windowsBindingTaskId} onChange={(event) => setWindowsBindingTaskId(event.target.value)} disabled={!bindableTasks.length}><option value="">选择一个任务</option>{bindableTasks.map((task) => <option value={task.id} key={task.id}>{task.title}{isOngoingTask(task) ? " · 长期" : ""}</option>)}</select></label>
              <label>选择正在运行的软件<select value={windowsBindingPath} onChange={(event) => setWindowsBindingPath(event.target.value)} disabled={!windowsApps.length}><option value="">选择软件</option>{windowsApps.map((app) => <option value={app.processPath} key={app.processPath}>{app.appName} · {app.processName}</option>)}</select></label>
              <label>计时模式<select value={windowsTrackingMode} onChange={(event) => setWindowsTrackingMode(event.target.value as WindowsTrackingMode)}><option value="active">活跃操作</option><option value="reading">前台阅读</option><option value="media">媒体播放</option><option value="backgroundMedia">后台听课</option><option value="manual">手动专注</option></select></label>
              {windowsTrackingMode === "active" && <label>空闲暂停（分钟）<input type="number" min="1" max="60" value={windowsIdleMinutes} onChange={(event) => setWindowsIdleMinutes(Math.max(1, Number(event.target.value) || 3))} /></label>}
            </div>
            <div className="button-row desktop-tracker-actions"><button className="primary" type="button" onClick={bindSelectedWindowsApp} disabled={!windowsBindingTaskId || !windowsBindingPath}>绑定并开始监测</button><button className="secondary" type="button" onClick={() => void loadWindowsApps()} disabled={windowsAppsBusy}>{windowsAppsBusy ? "刷新中…" : "刷新软件列表"}</button><button className={`secondary autostart-toggle ${desktopAutostart ? "active" : ""}`} type="button" onClick={() => void toggleDesktopAutostart()}>{desktopAutostart ? "✓ 已开启开机启动" : "开启开机启动"}</button></div>
            <p className="manage-hint">列表只显示当前有可见窗口的软件；未找到时请先打开目标软件再刷新。媒体模式仅在 Windows 检测到实际播放时计时。</p>
            {data.windowsBindings.length ? <div className="app-binding-list">{data.windowsBindings.map((binding) => {
              const recordDate = windowsTracker?.date || today;
              const todaySession = data.sessions.find((session) => session.taskId === binding.taskId && (session.id === `desktop_${recordDate}_${binding.id}` || session.id.startsWith(`desktop_${recordDate}_${binding.id}_`)));
              const boundTask = taskMap.get(binding.taskId);
              const inactiveLabel = boundTask && isOngoingTask(boundTask) && ongoingTaskStatus(boundTask) !== "active" ? ongoingTaskStatus(boundTask) === "paused" ? " · 已暂停累计" : " · 已结束累计" : "";
              return <div key={binding.id}><span className="app-avatar">{binding.appName.slice(0, 1).toUpperCase()}</span><div><strong>{binding.appName}</strong><small>计入「{boundTask?.title || "已删除任务"}」 · {windowsModeLabel(binding.mode)} · 今日 {minutesLabel(todaySession?.durationSec || 0)}{inactiveLabel}</small></div><button className="text-button danger-text" type="button" onClick={() => removeWindowsBinding(binding.id)}>解除</button></div>;
            })}</div> : <p className="manage-hint">尚未绑定 Windows 软件。窗口关闭后循记会缩到系统托盘并继续监测。</p>}
          </div>}
          {isAndroidApp && <div className="panel settings-card app-usage-card">
            <PanelTitle title="应用自动计时" subtitle="把其他应用的前台使用时长计入任务" />
            <div className={`usage-permission ${usageAccess ? "granted" : "required"}`}>
              <span>{usageAccess ? "✓" : "!"}</span>
              <div><strong>{usageAccess ? "使用情况权限已开启" : "需要开启使用情况权限"}</strong><small>{appUsageMessage}</small></div>
              <button className="secondary" type="button" onClick={usageAccess ? () => void refreshAppUsage(true) : requestUsageAccess} disabled={appUsageBusy}>{usageAccess ? (appUsageBusy ? "更新中…" : "刷新时长") : "前往授权"}</button>
            </div>
            {usageAccess && <>
              <div className="app-binding-form">
                <label>计入任务<select value={bindingTaskId} onChange={(event) => setBindingTaskId(event.target.value)} disabled={!bindableTasks.length}><option value="">选择一个任务</option>{bindableTasks.map((task) => <option value={task.id} key={task.id}>{task.title}{isOngoingTask(task) ? " · 长期" : ""}</option>)}</select></label>
                <label>选择应用<select value={bindingPackage} onChange={(event) => setBindingPackage(event.target.value)} disabled={!installedApps.length}><option value="">选择手机中的应用</option>{installedApps.map((app) => <option value={app.packageName} key={app.packageName}>{app.label}</option>)}</select></label>
                <button className="primary" type="button" onClick={bindSelectedApp} disabled={!bindingTaskId || !bindingPackage}>绑定并统计</button>
              </div>
              {!bindableTasks.length && <p className="manage-hint">请先新建任务，或恢复一个已暂停的长期任务，再绑定学习应用。</p>}
              {data.appBindings.length ? <div className="app-binding-list">{data.appBindings.map((binding) => {
                const todaySession = data.sessions.find((session) => session.taskId === binding.taskId && (session.id === `app_${today}_${binding.packageName}` || session.id.startsWith(`app_${today}_${binding.packageName}_`)));
                const boundTask = taskMap.get(binding.taskId);
                const inactiveLabel = boundTask && isOngoingTask(boundTask) && ongoingTaskStatus(boundTask) !== "active" ? ongoingTaskStatus(boundTask) === "paused" ? " · 已暂停累计" : " · 已结束累计" : "";
                return <div key={binding.id}><span className="app-avatar">{binding.appName.slice(0, 1).toUpperCase()}</span><div><strong>{binding.appName}</strong><small>计入「{boundTask?.title || "已删除任务"}」 · 今日 {minutesLabel(todaySession?.durationSec || 0)}{inactiveLabel}</small></div><button className="text-button danger-text" type="button" onClick={() => removeAppBinding(binding.id)}>解除</button></div>;
              })}</div> : <p className="manage-hint">绑定后，每次返回循记都会自动刷新当天的前台使用时长；同一应用不会重复累计。</p>}
            </>}
          </div>}
          <div className="panel settings-card"><PanelTitle title="设备同步" subtitle="使用同一个同步码连接手机与电脑" /><div className="sync-box"><label>同步码<input value={syncInput} onChange={(event) => setSyncInput(normalizeSyncCode(event.target.value))} placeholder="XXXX-XXXX-XXXX" autoComplete="off" /></label><div className={`sync-feedback ${syncStatus}`}><span className={`sync-dot ${syncStatus}`} /><div><strong>{syncStatus === "synced" ? "同步正常" : syncStatus === "syncing" ? "正在同步" : syncStatus === "error" ? "同步未完成" : "本机模式"}</strong><small>{syncMessage}</small></div></div><div className="button-row"><button className="secondary" onClick={generateSyncCode}>生成并启用新同步码</button><button className="primary" onClick={connectSync}>{syncCode ? "重新同步" : "连接已有同步码"}</button></div>{syncCode && <button className="text-button danger-text" onClick={disconnectSync}>断开当前同步码</button>}<p>同步码相当于密码，请不要发给其他人。第一次在电脑生成并启用后，手机只需输入相同同步码并点击连接。</p></div></div>
          <div className="panel settings-card"><PanelTitle title="专注偏好" subtitle="调整你的默认节奏" /><div className="form-grid"><label>专注时长（分钟）<input type="number" min="1" max="180" value={data.settings.focusMinutes} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, focusMinutes: Number(event.target.value) || 25 } }))} /></label><label>休息时长（分钟）<input type="number" min="1" max="60" value={data.settings.breakMinutes} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, breakMinutes: Number(event.target.value) || 5 } }))} /></label><label>每日目标（分钟）<input type="number" min="10" max="1440" value={data.settings.dailyGoalMinutes} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, dailyGoalMinutes: Number(event.target.value) || 180 } }))} /></label></div></div>
          <div className="panel settings-card"><PanelTitle title="任务分类" subtitle="所有分类都可以自由添加和删除" /><div className="category-manage">{data.categories.length ? data.categories.map((category) => <span key={category.id}><i style={{ background: category.color }} />{category.name}<button type="button" onClick={() => deleteCategory(category)} aria-label={`删除分类 ${category.name}`}>×</button></span>) : <span>当前没有分类</span>}</div><form className="inline-form" onSubmit={addCategory}><input value={newCategory} onChange={(event) => setNewCategory(event.target.value)} placeholder="例如：西综、英语、政治" /><button className="secondary">添加分类</button></form><p className="manage-hint">删除正在使用的分类不会删除任务，相关任务会移入其他现有分类；没有其他分类时则转为“未分类”。</p></div>
          <div className="panel settings-card"><PanelTitle title="备份与迁移" subtitle="随时保留一份自己的数据" /><div className="button-row"><button className="secondary" onClick={exportData}>导出 JSON 备份</button><label className="secondary file-button">导入备份<input type="file" accept="application/json,.json" onChange={(event) => event.target.files?.[0] && void importData(event.target.files[0])} /></label></div></div>
        </section>}
      </main>

      <nav className="mobile-nav">{NAV_ITEMS.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><span><NavIcon name={item.id} /></span>{item.label}</button>)}</nav>

      {showAdd && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setShowAdd(false); setCalendarDraft(null); } }}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-task-title">
          <div className="modal-head"><div><p className="eyebrow">新任务</p><h2 id="new-task-title">添加任务</h2></div><button className="close" onClick={() => { setShowAdd(false); setCalendarDraft(null); }} aria-label="关闭">×</button></div>
          <form onSubmit={createTask}>
            <div className="task-type-switch" role="radiogroup" aria-label="任务类型">
              <button type="button" role="radio" aria-checked={newTaskType === "normal"} className={newTaskType === "normal" ? "active" : ""} onClick={() => setNewTaskType("normal")}><strong>普通任务</strong><small>只安排一次，不生成复习</small></button>
              <button type="button" role="radio" aria-checked={newTaskType === "ongoing"} className={newTaskType === "ongoing" ? "active ongoing" : "ongoing"} onClick={() => setNewTaskType("ongoing")}><strong>长期任务</strong><small>持续投入，累计每天的时间</small></button>
              <button type="button" role="radio" aria-checked={newTaskType === "memory"} className={newTaskType === "memory" ? "active memory" : "memory"} onClick={() => setNewTaskType("memory")}><strong>记忆任务</strong><small>自动生成 5 个复习节点</small></button>
            </div>
            <input type="hidden" name="type" value={newTaskType} />
            <label>任务名称<input name="title" autoFocus maxLength={100} placeholder={newTaskType === "memory" ? "例如：英语 Unit 3 单词" : newTaskType === "ongoing" ? "例如：西综课程" : "例如：下午 3 点产品会议"} required /></label>
            <div className="form-grid">
              <label>分类<select name="category" defaultValue={data.categories[0]?.id || ""}><option value="">未分类</option>{data.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
              <label>{newTaskType === "memory" ? "首次学习日期" : newTaskType === "ongoing" ? "开始日期" : "任务日期"}<input name="startDate" type="date" defaultValue={calendarDraft?.date || today} required /></label>
            </div>
            {newTaskType === "normal" && <div className="form-grid"><label>开始时间<input name="startTime" type="time" defaultValue={calendarDraft?.startTime || ""} /></label><label>结束时间<input name="endTime" type="time" defaultValue={calendarDraft?.endTime || ""} /></label></div>}
            {newTaskType === "ongoing" && <div className="form-grid"><label>目标日期（可选）<input name="targetDate" type="date" /></label><label>每日目标（分钟，可选）<input name="dailyGoalMinutes" type="number" min="1" max="1440" placeholder="例如：90" /></label></div>}
            <label>标签<input name="tags" placeholder="例如：工作、错题、背诵（逗号分隔）" /></label>
            {newTaskType === "memory" && <div className="schedule-preview"><strong>自动安排 5 次复习</strong><span>1 天后 · 2 天后 · 4 天后 · 7 天后 · 15 天后</span></div>}
            {newTaskType === "ongoing" && <div className="schedule-preview ongoing-preview"><strong>只创建一个长期任务</strong><span>每天的专注与自动计时都会累计到这里，不生成重复待办。</span></div>}
            <div className="modal-actions"><button type="button" className="ghost" onClick={() => { setShowAdd(false); setCalendarDraft(null); }}>取消</button><button className="primary">{newTaskType === "memory" ? "添加并排期" : newTaskType === "ongoing" ? "开始长期任务" : "添加任务"}</button></div>
          </form>
        </div>
      </div>}
      {editingTask && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setEditingTask(null)}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-task-title">
          <div className="modal-head"><div><p className="eyebrow">编辑任务</p><h2 id="edit-task-title">编辑任务</h2></div><button className="close" onClick={() => setEditingTask(null)} aria-label="关闭">×</button></div>
          <form onSubmit={saveEditedTask}>
            <div className={`editing-type ${editingTask.type} ${isOngoingTask(editingTask) ? "ongoing" : ""}`}>{editingTask.type === "memory" ? "🧠 记忆任务" : isOngoingTask(editingTask) ? "长期任务" : "普通任务"}<small>任务类型创建后不可转换</small></div>
            <label>任务名称<input value={editingTask.title} onChange={(event) => setEditingTask({ ...editingTask, title: event.target.value })} maxLength={100} required /></label>
            <div className="form-grid"><label>分类<select value={editingTask.categoryId} onChange={(event) => setEditingTask({ ...editingTask, categoryId: event.target.value })}><option value="">未分类</option>{data.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>{editingTask.type === "memory" ? "首次学习日期" : isOngoingTask(editingTask) ? "开始日期" : "任务日期"}<input type="date" value={editingTask.startDate} onChange={(event) => setEditingTask({ ...editingTask, startDate: event.target.value })} required /></label></div>
            {editingTask.type === "normal" && !isOngoingTask(editingTask) && <div className="form-grid"><label>开始时间<input type="time" value={editingTask.startTime || ""} onChange={(event) => setEditingTask({ ...editingTask, startTime: event.target.value })} /></label><label>结束时间<input type="time" value={editingTask.endTime || ""} onChange={(event) => setEditingTask({ ...editingTask, endTime: event.target.value })} /></label></div>}
            {isOngoingTask(editingTask) && <div className="form-grid"><label>目标日期（可选）<input type="date" value={editingTask.targetDate || ""} onChange={(event) => setEditingTask({ ...editingTask, targetDate: event.target.value || undefined })} /></label><label>每日目标（分钟，可选）<input type="number" min="1" max="1440" value={editingTask.dailyGoalMinutes || ""} onChange={(event) => setEditingTask({ ...editingTask, dailyGoalMinutes: event.target.value ? Math.min(1_440, Math.max(1, Math.round(Number(event.target.value)))) : undefined })} /></label></div>}
            <label>标签</label><div className="editable-tags">{editingTask.tags.length ? editingTask.tags.map((tag) => <button type="button" key={tag} onClick={() => { const stamp = new Date().toISOString(); setEditingTask({ ...editingTask, tags: editingTask.tags.filter((entry) => entry !== tag), tagChanges: { ...getTagChanges(editingTask), [tag]: { present: false, updatedAt: stamp } } }); }}>#{tag}<span>×</span></button>) : <small>还没有标签</small>}</div>
            <div className="inline-form"><input value={newEditTag} onChange={(event) => setNewEditTag(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addEditTag(); } }} placeholder="输入新标签" /><button type="button" className="secondary" onClick={addEditTag}>添加标签</button></div>
            <div className="modal-actions"><button type="button" className="ghost" onClick={() => setEditingTask(null)}>取消</button><button className="primary">保存修改</button></div>
          </form>
        </div>
      </div>}
      {pendingTaskAction && pendingTask && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setPendingTaskAction(null)}>
        <div className="modal confirmation-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-task-title" aria-describedby="confirm-task-description">
          <div className="modal-head"><div><p className="eyebrow">请确认操作</p><h2 id="confirm-task-title">{pendingTaskAction.kind === "complete-ongoing" ? "结束长期任务？" : "删除任务？"}</h2></div><button className="close" onClick={() => setPendingTaskAction(null)} aria-label="关闭确认窗口">×</button></div>
          <p id="confirm-task-description" className="confirmation-copy">{pendingTaskAction.kind === "complete-ongoing" ? <>“{pendingTask.title}”将移至“已完成 / 归档”，历史专注记录会保留。之后可以在任务页取消归档。</> : <>“{pendingTask.title}”将从任务列表中删除，相关专注记录会保留。此操作不能直接撤销。</>}</p>
          <div className="modal-actions"><button type="button" className="ghost" autoFocus onClick={() => setPendingTaskAction(null)}>取消</button><button type="button" className="primary confirmation-danger" onClick={() => void confirmPendingTaskAction()}>{pendingTaskAction.kind === "complete-ongoing" ? "确认结束并归档" : "确认删除"}</button></div>
        </div>
      </div>}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function Metric({ label, value, note, tone = "" }: { label: string; value: string; note: string; tone?: string }) {
  return <div className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>;
}

function PanelTitle({ title, subtitle, action }: { title: string; subtitle: string; action?: string }) {
  return <div className="panel-title"><div><h3>{title}</h3><p>{subtitle}</p></div>{action && <span>{action}</span>}</div>;
}

function Empty({ icon, title, text, action }: { icon: string; title: string; text: string; action?: { label: string; onClick: () => void } }) {
  return <div className="empty"><span>{icon}</span><strong>{title}</strong><p>{text}</p>{action && <button className="secondary empty-action" onClick={action.onClick}>{action.label}</button>}</div>;
}

function TaskPicker({ value, onChange, tasks, label, disabled = false }: { value: string; onChange: (value: string) => void; tasks: Task[]; label: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const selected = tasks.find((task) => task.id === value);

  useEffect(() => {
    function closeOnOutsidePress(event: PointerEvent) {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, []);

  function choose(nextValue: string) {
    onChange(nextValue);
    setOpen(false);
  }

  return <div className={`task-picker ${open ? "open" : ""}`} ref={pickerRef} onKeyDown={(event) => {
    if (event.key === "Escape") setOpen(false);
    if ((event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") && !open && !disabled) {
      event.preventDefault();
      setOpen(true);
    }
  }}>
    <button className="task-picker-trigger" type="button" onClick={() => setOpen((current) => !current)} disabled={disabled} aria-label={label} aria-haspopup="listbox" aria-expanded={open}>
      <span className={selected ? "selected-label" : "placeholder-label"}>{selected?.title || "选择一个任务"}</span><i aria-hidden="true" />
    </button>
    {open && <div className="task-picker-menu" role="listbox" aria-label={label}>
      <button type="button" role="option" aria-selected={!value} className={!value ? "selected" : ""} onClick={() => choose("")}><span>选择一个任务</span>{!value && <b aria-hidden="true">✓</b>}</button>
      {tasks.length ? tasks.map((task) => <button type="button" role="option" aria-selected={task.id === value} className={task.id === value ? "selected" : ""} key={task.id} onClick={() => choose(task.id)}><span>{task.title}</span>{task.id === value && <b aria-hidden="true">✓</b>}</button>) : <div className="task-picker-empty">还没有可专注的任务</div>}
    </div>}
  </div>;
}

function TodayTask({ task, category, onToggle }: { task: Task; category?: Category; onToggle: (id: string, index: number) => void }) {
  const actionable = INTERVALS.map((_, index) => ({ index, status: reviewStatus(task, index), date: reviewDate(task, index) })).filter((entry) => entry.status === "due" || entry.status === "overdue");
  return <article className="today-task"><i style={{ background: category?.color || "#a1a1aa" }} /><div className="task-info"><span>{category?.name || "未分类"}</span><strong>{task.title}</strong><small>{task.tags.join(" · ") || "暂无标签"}</small></div><div className="today-actions">{actionable.map((entry) => <button key={entry.index} className={entry.status} onClick={() => onToggle(task.id, entry.index)}><span>{entry.status === "overdue" ? "已逾期" : "今天"}</span><small>第 {entry.index + 1} 次 · {dateLabel(entry.date)}</small></button>)}</div></article>;
}

function TodayNormalTask({ task, category, now, onToggle, onMoveToToday }: { task: Task; category?: Category; now: Date; onToggle: (id: string) => void; onMoveToToday: (id: string) => void }) {
  const time = task.startTime ? `${task.startTime}${task.endTime ? `—${task.endTime}` : ""}` : "全天";
  const overdueLabel = normalTaskOverdueLabel(task, now);
  return <article className={`today-task normal ${overdueLabel ? "overdue-normal" : ""}`}><i style={{ background: overdueLabel ? "#e05a67" : category?.color || "#71717a" }} /><div className="task-info"><span>{category?.name || "未分类"} · 普通任务</span><strong>{task.title}</strong><small className={overdueLabel ? "overdue-copy" : ""}>{overdueLabel ? `${overdueLabel} · ` : ""}{time} · {task.tags.join(" · ") || "暂无标签"}</small></div><div className="today-actions">{overdueLabel && <button className="normal-move" onClick={() => onMoveToToday(task.id)}><span>移到今天</span><small>重新安排</small></button>}<button className="normal-done" onClick={() => onToggle(task.id)}><span>完成</span><small>结束任务</small></button></div></article>;
}

function TaskCard({ task, category, now, todaySeconds, totalSeconds, onToggle, onToggleNormal, onMoveToToday, onSetOngoingStatus, onEdit, onDelete, onRemoveTag, onFocus }: { task: Task; category?: Category; now: Date; todaySeconds: number; totalSeconds: number; onToggle: (id: string, index: number) => void; onToggleNormal: () => void; onMoveToToday: () => void; onSetOngoingStatus: (status: OngoingTaskStatus) => void; onEdit: () => void; onDelete: () => void; onRemoveTag: (tag: string) => void; onFocus: () => void }) {
  const categoryColor = category?.color || "#71717a";
  const ongoing = isOngoingTask(task);
  const status = ongoing ? ongoingTaskStatus(task) : undefined;
  const targetReached = ongoingTargetReached(task, localISO(now));
  const overdueLabel = task.type === "normal" && !ongoing ? normalTaskOverdueLabel(task, now) : "";
  return <article className={`task-card ${isTaskFinished(task) ? "finished" : ""} ${overdueLabel ? "overdue-normal" : ""}`}>
    <div className="task-card-head"><div><div className="task-badges"><span className="category-pill" style={{ color: categoryColor, background: `${categoryColor}18` }}>{category?.name || "未分类"}</span><span className={`task-kind ${task.type} ${ongoing ? "ongoing" : ""}`}>{task.type === "memory" ? "🧠 记忆" : ongoing ? "长期" : "普通"}</span>{ongoing && <span className={`task-kind ongoing-status ${status}`}>{status === "active" ? "进行中" : status === "paused" ? "已暂停" : "已结束"}</span>}{targetReached && <span className="task-kind target-reached">目标日期已到</span>}{overdueLabel && <span className="task-kind overdue">{overdueLabel}</span>}</div><h3>{task.title}</h3><div className="tags">{task.tags.length ? task.tags.map((tag) => <button type="button" key={tag} onClick={() => onRemoveTag(tag)} title={`删除标签 ${tag}`}>#{tag}<span>删除 ×</span></button>) : <button type="button" onClick={onEdit}>＋ 添加标签</button>}</div></div><button className="more" onClick={onEdit} aria-label="编辑任务和标签">编辑任务</button></div>
    {task.type === "memory" ? <div className="review-track">{INTERVALS.map((days, index) => { const reviewState = reviewStatus(task, index); const statusLabel = reviewState === "done" ? "已完成" : reviewState === "overdue" ? "已逾期" : reviewState === "due" ? "今日复习" : reviewState === "soon" ? "即将到期" : "安全期"; return <button key={days} className={reviewState} onClick={() => onToggle(task.id, index)} aria-pressed={task.completed[index]} title={`${statusLabel} · ${dateLabel(reviewDate(task, index))}`}><i>{reviewState === "done" ? "✓" : index + 1}</i><span>{dateLabel(reviewDate(task, index))}</span><small>{statusLabel}</small></button>; })}</div> : ongoing ? <div className="ongoing-task-row"><div className="ongoing-task-stats"><span><small>今日投入</small><strong>{minutesLabel(todaySeconds)}</strong></span><span><small>累计投入</small><strong>{minutesLabel(totalSeconds)}</strong></span>{task.dailyGoalMinutes && <span><small>每日目标</small><strong>{Math.round(todaySeconds / 60)} / {task.dailyGoalMinutes} 分钟</strong></span>}</div><div className="ongoing-task-actions">{status === "active" && <button onClick={() => onSetOngoingStatus("paused")}>暂停</button>}{status === "paused" && <button onClick={() => onSetOngoingStatus("active")}>恢复任务</button>}{status === "completed" && <button onClick={() => onSetOngoingStatus("active")}>取消归档</button>}{status !== "completed" && <button className="danger" onClick={() => onSetOngoingStatus("completed")}>结束</button>}</div></div> : <div className={`normal-task-row ${overdueLabel ? "overdue" : ""}`}><div><span>{task.startTime ? `${task.startTime}${task.endTime ? `—${task.endTime}` : ""}` : "全天任务"}</span><strong>{task.normalCompleted ? "已完成" : overdueLabel || "待完成"}</strong></div><div className="normal-task-actions">{overdueLabel && <button onClick={onMoveToToday}>移到今天</button>}<button className={task.normalCompleted ? "done" : ""} onClick={onToggleNormal}>{task.normalCompleted ? "恢复任务" : "完成"}</button></div></div>}
    <div className="task-card-foot"><span>{task.type === "memory" ? "开始于" : ongoing ? "开始于" : "安排于"} {dateLabel(task.startDate)}{ongoing && task.targetDate ? ` · 目标 ${dateLabel(task.targetDate)}` : overdueLabel ? ` · ${overdueLabel}` : ""}</span><div><button className="text-button" onClick={onEdit}>管理标签</button>{(!ongoing || status === "active") && <button className="text-button" onClick={onFocus}>开始专注</button>}<button className="text-button danger-text" onClick={onDelete}>删除任务</button></div></div>
  </article>;
}
