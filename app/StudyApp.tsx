"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { CalendarApp, type CalendarTask } from "./CalendarApp";

const INTERVALS = [1, 2, 4, 7, 15];
const LOCAL_DATA_KEY = "xunji-data-v1";
const LOCAL_SYNC_KEY = "xunji-sync-v1";
const LOCAL_TIMER_KEY = "xunji-timer-v1";
const LOCAL_THEME_KEY = "xunji-theme";
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

type Tab = "today" | "calendar" | "tasks" | "focus" | "stats" | "settings";
type Category = { id: string; name: string; color: string };
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
  normalCompleted?: boolean;
  reviewDates?: string[];
  completed: boolean[];
  createdAt: string;
  updatedAt: string;
};
type FocusSession = {
  id: string;
  taskId: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  status: "completed" | "stopped";
  updatedAt: string;
};
type DeletedTask = { id: string; deletedAt: string };
type AppData = {
  version: 1;
  tasks: Task[];
  deletedTasks: DeletedTask[];
  sessions: FocusSession[];
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

const DEFAULT_DATA: AppData = {
  version: 1,
  tasks: [],
  deletedTasks: [],
  sessions: [],
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

function isTaskFinished(task: Task) {
  return task.type === "normal" ? Boolean(task.normalCompleted) : task.completed.every(Boolean);
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
      const type = task.type === "normal" ? "normal" as const : "memory" as const;
      return {
        ...task,
        type,
        normalCompleted: type === "normal" ? Boolean(task.normalCompleted) : false,
        completed: type === "memory" ? INTERVALS.map((_, index) => Boolean(task.completed?.[index])) : [],
        tags: Array.isArray(task.tags) ? task.tags : [],
        reviewDates: type === "memory" ? INTERVALS.map((days, index) => task.reviewDates?.[index] || addDays(task.startDate || localISO(), days)) : [],
        updatedAt: task.updatedAt || task.createdAt || new Date().toISOString(),
      };
    }).map((task) => ({ ...task, tagChanges: getTagChanges(task) })),
    deletedTasks: Array.isArray(input.deletedTasks)
      ? input.deletedTasks.filter((entry): entry is DeletedTask => Boolean(entry?.id && entry?.deletedAt))
      : [],
    sessions: Array.isArray(input.sessions) ? input.sessions : [],
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

export function StudyApp() {
  const [data, setData] = useState<AppData>(DEFAULT_DATA);
  const [tab, setTab] = useState<Tab>("today");
  const [hydrated, setHydrated] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newTaskType, setNewTaskType] = useState<Task["type"]>("memory");
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [newEditTag, setNewEditTag] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [taskFilter, setTaskFilter] = useState<"active" | "all" | "done">("active");
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
  const revisionRef = useRef(0);
  const skipAutoSync = useRef(true);

  const today = localISO();
  const taskMap = useMemo(() => new Map(data.tasks.map((task) => [task.id, task])), [data.tasks]);
  const categoryMap = useMemo(() => new Map(data.categories.map((category) => [category.id, category])), [data.categories]);
  const calendarTasks = useMemo<CalendarTask[]>(() => data.tasks.flatMap((task) => task.type === "normal"
    ? [{
        id: `${task.id}:normal`,
        type: "normal" as const,
        title: task.title,
        date: task.startDate,
        startTime: task.startTime,
        endTime: task.endTime,
        completed: Boolean(task.normalCompleted),
      }]
    : [
        { id: `${task.id}:initial`, type: "normal" as const, title: `初次学习 · ${task.title}`, date: task.startDate },
        ...INTERVALS.map((_, index) => ({
          id: `${task.id}:${index}`,
          type: "memory" as const,
          title: task.title,
          stage: index + 1,
          date: reviewDate(task, index),
          completed: Boolean(task.completed[index]),
        })),
      ]), [data.tasks]);

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LOCAL_DATA_KEY);
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

  const remaining = timer ? (timer.running ? Math.max(0, Math.ceil((timer.endAt - now) / 1000)) : timer.pausedRemaining) : 0;

  useEffect(() => {
    if (timer?.running && remaining === 0) finishTimer("completed", true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining, timer?.running]);

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
    setTheme(nextTheme);
  }

  function updateTask(id: string, patch: Partial<Task>) {
    setData((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === id ? { ...task, ...patch, updatedAt: new Date().toISOString() } : task),
    }));
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
    if (!task || task.type !== "normal") return;
    updateTask(taskId, { normalCompleted: !task.normalCompleted });
    notify(task.normalCompleted ? "已恢复为待办" : "普通任务已完成 ✓");
  }

  function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") || "").trim();
    if (!title) return;
    const stamp = new Date().toISOString();
    const type = String(form.get("type") || "memory") === "normal" ? "normal" as const : "memory" as const;
    const startDate = String(form.get("startDate") || today);
    const startTime = String(form.get("startTime") || "");
    const endTime = String(form.get("endTime") || "");
    if (type === "normal" && startTime && endTime && endTime <= startTime) return notify("结束时间需要晚于开始时间");
    const tags = String(form.get("tags") || "").split(/[，,]/).map((tag) => tag.trim()).filter(Boolean);
    const task: Task = {
      id: uid("task"),
      type,
      title,
      categoryId: String(form.get("category") || ""),
      tags: [...new Set(tags)],
      startDate,
      startTime: type === "normal" ? startTime : undefined,
      endTime: type === "normal" ? endTime : undefined,
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
    notify(type === "memory" ? "记忆任务已添加，复习节点已排好" : "普通任务已添加");
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
    if (editingTask.type === "normal" && editingTask.startTime && editingTask.endTime && editingTask.endTime <= editingTask.startTime) return notify("结束时间需要晚于开始时间");
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
    if (!window.confirm(`确定删除“${task.title}”吗？相关专注记录会保留。`)) return;
    const deletedAt = new Date().toISOString();
    setData((current) => ({
      ...current,
      tasks: current.tasks.filter((entry) => entry.id !== task.id),
      deletedTasks: [...current.deletedTasks.filter((entry) => entry.id !== task.id), { id: task.id, deletedAt }],
    }));
    notify("任务已删除");
  }

  function startTimer() {
    const taskId = timerTaskId || data.tasks.find((task) => !isTaskFinished(task))?.id;
    if (!taskId) return notify("请先选择或添加一个任务");
    const durationSec = Math.max(1, data.settings.focusMinutes) * 60;
    const startedAt = new Date().toISOString();
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
    const elapsed = natural ? timer.durationSec : Math.max(60, timer.durationSec - remaining);
    const stamp = new Date().toISOString();
    const session: FocusSession = {
      id: uid("focus"),
      taskId: timer.taskId,
      startedAt: timer.startedAt,
      endedAt: stamp,
      durationSec: elapsed,
      status,
      updatedAt: stamp,
    };
    setData((current) => ({ ...current, sessions: [session, ...current.sessions] }));
    setTimer(null);
    if (natural && "Notification" in window && Notification.permission === "granted") {
      new Notification("本轮专注完成", { body: taskMap.get(session.taskId)?.title || "做得很好，休息一下吧。" });
    }
    notify(natural ? "本轮专注完成，已计入统计" : "本次专注时长已保存");
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

  async function pullAndMerge(code: string) {
    setSyncStatus("syncing");
    setSyncMessage("正在检查云端数据…");
    try {
      const response = await syncRequest(code, { action: "pull" });
      if (!response.ok) {
        const detail = await response.json().catch(() => null);
        throw new Error(detail?.error || `同步服务返回 ${response.status}`);
      }
      const result = await response.json();
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
        const conflict = await response.json();
        const merged = conflict.data ? mergeData(payload, normalizeData(conflict.data)) : payload;
        const retry = await syncRequest(code, { action: "push", data: merged, revision: conflict.revision || 0 });
        if (!retry.ok) throw new Error("retry failed");
        const result = await retry.json();
        revisionRef.current = result.revision;
        setData(merged);
      } else {
        if (!response.ok) throw new Error("push failed");
        const result = await response.json();
        revisionRef.current = result.revision;
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

  function exportData() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `循记备份-${today}.json`;
    link.click();
    URL.revokeObjectURL(url);
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
  const todayNormalTasks = data.tasks.filter((task) => task.type === "normal" && task.startDate === today && !task.normalCompleted);
  const todayAttentionCount = dueTasks.length + todayNormalTasks.length;

  const visibleTasks = useMemo(() => data.tasks.filter((task) => {
    const matchesCategory = categoryFilter === "all" || task.categoryId === categoryFilter;
    const query = search.trim().toLowerCase();
    const matchesSearch = !query || task.title.toLowerCase().includes(query) || task.tags.some((tag) => tag.toLowerCase().includes(query));
    const done = isTaskFinished(task);
    const matchesState = taskFilter === "all" || (taskFilter === "done" ? done : !done);
    return matchesCategory && matchesSearch && matchesState;
  }), [data.tasks, categoryFilter, search, taskFilter]);

  const todaySessions = data.sessions.filter((session) => localISO(new Date(session.startedAt)) === today);
  const todaySeconds = todaySessions.reduce((sum, session) => sum + session.durationSec, 0);
  const totalSeconds = data.sessions.reduce((sum, session) => sum + session.durationSec, 0);
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
    const seconds = data.sessions.filter((session) => taskIds.has(session.taskId)).reduce((sum, session) => sum + session.durationSec, 0);
    return { ...category, seconds };
  }).sort((a, b) => b.seconds - a.seconds);
  const topTasks = data.tasks.map((task) => ({
    task,
    seconds: data.sessions.filter((session) => session.taskId === task.id).reduce((sum, session) => sum + session.durationSec, 0),
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
            <button className="primary" onClick={() => { setNewTaskType("memory"); setShowAdd(true); }}>＋ 新建任务</button>
          </div>
        </header>

        {tab === "today" && <section className="page-stack">
          <div className="hero-card">
            <div className="hero-atmosphere" aria-hidden="true"><i /><i /><i /><span /></div>
            <div><p className="eyebrow">今日节奏</p><h2>{todayAttentionCount ? `今天有 ${todayAttentionCount} 项值得专注` : "今天，可以从容开始"}</h2><p>{todayAttentionCount ? "先完成到期任务，再用一轮专注推进最重要的学习。" : "当前没有到期安排。创建一个学习任务，循记会替你排好复习节奏。"}</p><div className="hero-actions">{overdueCount > 0 ? <button className="hero-action" onClick={rescheduleOverdueReviews}>重新规划 {overdueCount} 个逾期复习</button> : data.tasks.length ? <button className="hero-action" onClick={() => setTab("focus")}>开始一轮专注</button> : <button className="hero-action" onClick={() => { setNewTaskType("memory"); setShowAdd(true); }}>创建学习任务</button>}</div></div>
            <div className="hero-progress"><strong>{Math.min(100, Math.round(todaySeconds / 60 / data.settings.dailyGoalMinutes * 100))}%</strong><span>今日专注目标</span></div>
          </div>
          <div className="content-grid">
            <div className="panel wide">
              <PanelTitle title="今日安排" subtitle="普通任务与到期复习统一处理" action={todayAttentionCount ? `${todayAttentionCount} 项` : "已清空"} />
              {todayAttentionCount ? <div className="review-list">{todayNormalTasks.map((task) => <TodayNormalTask key={task.id} task={task} category={categoryMap.get(task.categoryId)} onToggle={toggleNormalTask} />)}{dueTasks.slice(0, 6).map((task) => <TodayTask key={task.id} task={task} category={categoryMap.get(task.categoryId)} onToggle={toggleReview} />)}</div> : <Empty icon="✓" title="今天没有待办任务" text="可以创建新的学习任务，循记会自动安排后续复习。" action={{ label: "新建学习任务", onClick: () => { setNewTaskType("memory"); setShowAdd(true); } }} />}
            </div>
            <div className="panel focus-quick">
              <PanelTitle title="快速专注" subtitle={`${data.settings.focusMinutes} 分钟一轮`} />
              <select value={timerTaskId} onChange={(event) => setTimerTaskId(event.target.value)} aria-label="选择专注任务">
                <option value="">选择一个任务</option>{data.tasks.filter((task) => !isTaskFinished(task)).map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
              </select>
              <div className="mini-timer">{data.settings.focusMinutes}<small>分钟</small></div>
              <button className="primary block" onClick={() => { startTimer(); setTab("focus"); }}>开始专注</button>
            </div>
          </div>
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
            onCreateTask={() => { setNewTaskType("memory"); setShowAdd(true); }}
            onToggleComplete={(calendarId) => {
              const [taskId, target] = String(calendarId).split(":");
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
          <div className="subfilters"><button className={taskFilter === "active" ? "active" : ""} onClick={() => setTaskFilter("active")}>进行中</button><button className={taskFilter === "all" ? "active" : ""} onClick={() => setTaskFilter("all")}>全部</button><button className={taskFilter === "done" ? "active" : ""} onClick={() => setTaskFilter("done")}>已完成</button><span>{visibleTasks.length} 个任务</span></div>
          {visibleTasks.length ? <div className="task-grid">{visibleTasks.map((task) => <TaskCard key={task.id} task={task} category={categoryMap.get(task.categoryId)} onToggle={toggleReview} onToggleNormal={() => toggleNormalTask(task.id)} onEdit={() => editTask(task)} onDelete={() => deleteTask(task)} onRemoveTag={(tag) => removeTaskTag(task, tag)} onFocus={() => { setTimerTaskId(task.id); setTab("focus"); }} />)}</div> : <div className="panel"><Empty icon="□" title="没有符合条件的任务" text="试试切换分类，或者新建一个任务。" /></div>}
        </section>}

        {tab === "focus" && <section className="page-stack focus-layout">
          <div className="panel timer-panel">
            <p className="eyebrow">专注计时</p>
            <select value={timer?.taskId || timerTaskId} onChange={(event) => setTimerTaskId(event.target.value)} disabled={Boolean(timer)} aria-label="当前专注任务"><option value="">选择专注任务</option>{data.tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select>
            <div className={`timer-ring ${timer?.running ? "running" : ""}`} style={{ "--progress": timer ? `${Math.max(0, 100 - remaining / timer.durationSec * 100)}%` : "0%" } as React.CSSProperties}>
              <div><strong>{String(Math.floor((timer ? remaining : data.settings.focusMinutes * 60) / 60)).padStart(2, "0")}:{String((timer ? remaining : 0) % 60).padStart(2, "0")}</strong><span>{timer ? (timer.running ? "保持专注" : "已暂停") : "准备开始"}</span></div>
            </div>
            <div className="timer-actions">{!timer ? <button className="primary large" onClick={startTimer}>开始专注</button> : <><button className="secondary large" onClick={timer.running ? pauseTimer : resumeTimer}>{timer.running ? "暂停" : "继续"}</button><button className="ghost large" onClick={() => finishTimer("stopped")}>结束并保存</button></>}</div>
            <p className="timer-tip">锁屏或切换应用后，重新打开仍会按实际时间恢复。</p>
          </div>
          <div className="panel session-panel">
            <PanelTitle title="今日记录" subtitle={`累计 ${minutesLabel(todaySeconds)}`} />
            {todaySessions.length ? <div className="session-list">{todaySessions.map((session) => <div key={session.id}><span className="session-dot" /><div><strong>{taskMap.get(session.taskId)?.title || "已删除任务"}</strong><small>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(session.startedAt))}</small></div><b>{minutesLabel(session.durationSec)}</b></div>)}</div> : <Empty icon="◷" title="今天还没有专注记录" text="完成第一轮后，时间会自动记在这里。" />}
          </div>
        </section>}

        {tab === "stats" && <section className="page-stack">
          <div className="metric-grid stats-metrics"><Metric label="累计专注" value={minutesLabel(totalSeconds)} note={`${data.sessions.length} 次记录`} /><Metric label="今日专注" value={minutesLabel(todaySeconds)} note={`目标 ${data.settings.dailyGoalMinutes} 分钟`} /><Metric label="完成复习" value={String(completedReviews)} note={`共 ${totalReviews} 个节点`} /><Metric label="活跃任务" value={String(data.tasks.filter((task) => !isTaskFinished(task)).length)} note={`共 ${data.tasks.length} 个任务`} /></div>
          <div className="content-grid stats-grid">
            <div className="panel wide"><PanelTitle title="最近 7 天" subtitle="每日有效专注分钟" /><div className="bar-chart">{weekly.map((day) => <div key={day.iso} className={day.iso === today ? "today" : ""}><span>{day.minutes || ""}</span><i style={{ height: `${Math.max(5, day.minutes / maxDayMinutes * 100)}%` }} /><small>{day.label}</small></div>)}</div></div>
            <div className="panel"><PanelTitle title="分类投入" subtitle="累计专注时长" />{categoryStats.some((entry) => entry.seconds) ? <div className="category-stats">{categoryStats.map((entry) => <div key={entry.id}><span><i style={{ background: entry.color }} />{entry.name}</span><strong>{minutesLabel(entry.seconds)}</strong><div><i style={{ width: `${totalSeconds ? entry.seconds / totalSeconds * 100 : 0}%`, background: entry.color }} /></div></div>)}</div> : <Empty icon="▥" title="还没有统计数据" text="完成番茄钟后会自动生成。" />}</div>
          </div>
          <div className="panel"><PanelTitle title="投入最多的任务" subtitle="帮助你看见时间去了哪里" />{topTasks.length ? <div className="ranking">{topTasks.map((entry, index) => <div key={entry.task.id}><b>{String(index + 1).padStart(2, "0")}</b><span><strong>{entry.task.title}</strong><small>{categoryMap.get(entry.task.categoryId)?.name || "未分类"}</small></span><em>{minutesLabel(entry.seconds)}</em></div>)}</div> : <Empty icon="↗" title="排行榜等待第一条记录" text="开始专注后，这里会按累计时间排序。" />}</div>
        </section>}

        {tab === "settings" && <section className="page-stack settings-grid">
          <div className="panel settings-card"><PanelTitle title="设备同步" subtitle="使用同一个同步码连接手机与电脑" /><div className="sync-box"><label>同步码<input value={syncInput} onChange={(event) => setSyncInput(normalizeSyncCode(event.target.value))} placeholder="XXXX-XXXX-XXXX" autoComplete="off" /></label><div className={`sync-feedback ${syncStatus}`}><span className={`sync-dot ${syncStatus}`} /><div><strong>{syncStatus === "synced" ? "同步正常" : syncStatus === "syncing" ? "正在同步" : syncStatus === "error" ? "同步未完成" : "本机模式"}</strong><small>{syncMessage}</small></div></div><div className="button-row"><button className="secondary" onClick={generateSyncCode}>生成并启用新同步码</button><button className="primary" onClick={connectSync}>{syncCode ? "重新同步" : "连接已有同步码"}</button></div>{syncCode && <button className="text-button danger-text" onClick={disconnectSync}>断开当前同步码</button>}<p>同步码相当于密码，请不要发给其他人。第一次在电脑生成并启用后，手机只需输入相同同步码并点击连接。</p></div></div>
          <div className="panel settings-card"><PanelTitle title="专注偏好" subtitle="调整你的默认节奏" /><div className="form-grid"><label>专注时长（分钟）<input type="number" min="1" max="180" value={data.settings.focusMinutes} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, focusMinutes: Number(event.target.value) || 25 } }))} /></label><label>休息时长（分钟）<input type="number" min="1" max="60" value={data.settings.breakMinutes} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, breakMinutes: Number(event.target.value) || 5 } }))} /></label><label>每日目标（分钟）<input type="number" min="10" max="1440" value={data.settings.dailyGoalMinutes} onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, dailyGoalMinutes: Number(event.target.value) || 180 } }))} /></label></div></div>
          <div className="panel settings-card"><PanelTitle title="任务分类" subtitle="所有分类都可以自由添加和删除" /><div className="category-manage">{data.categories.length ? data.categories.map((category) => <span key={category.id}><i style={{ background: category.color }} />{category.name}<button type="button" onClick={() => deleteCategory(category)} aria-label={`删除分类 ${category.name}`}>×</button></span>) : <span>当前没有分类</span>}</div><form className="inline-form" onSubmit={addCategory}><input value={newCategory} onChange={(event) => setNewCategory(event.target.value)} placeholder="例如：西综、英语、政治" /><button className="secondary">添加分类</button></form><p className="manage-hint">删除正在使用的分类不会删除任务，相关任务会移入其他现有分类；没有其他分类时则转为“未分类”。</p></div>
          <div className="panel settings-card"><PanelTitle title="备份与迁移" subtitle="随时保留一份自己的数据" /><div className="button-row"><button className="secondary" onClick={exportData}>导出 JSON 备份</button><label className="secondary file-button">导入备份<input type="file" accept="application/json,.json" onChange={(event) => event.target.files?.[0] && void importData(event.target.files[0])} /></label></div></div>
        </section>}
      </main>

      <nav className="mobile-nav">{NAV_ITEMS.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><span><NavIcon name={item.id} /></span>{item.label}</button>)}</nav>

      {showAdd && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setShowAdd(false)}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-task-title">
          <div className="modal-head"><div><p className="eyebrow">新任务</p><h2 id="new-task-title">添加任务</h2></div><button className="close" onClick={() => setShowAdd(false)} aria-label="关闭">×</button></div>
          <form onSubmit={createTask}>
            <div className="task-type-switch" role="radiogroup" aria-label="任务类型">
              <button type="button" role="radio" aria-checked={newTaskType === "normal"} className={newTaskType === "normal" ? "active" : ""} onClick={() => setNewTaskType("normal")}><strong>普通任务</strong><small>只安排一次，不生成复习</small></button>
              <button type="button" role="radio" aria-checked={newTaskType === "memory"} className={newTaskType === "memory" ? "active memory" : "memory"} onClick={() => setNewTaskType("memory")}><strong>记忆任务</strong><small>自动生成 5 个复习节点</small></button>
            </div>
            <input type="hidden" name="type" value={newTaskType} />
            <label>任务名称<input name="title" autoFocus maxLength={100} placeholder={newTaskType === "memory" ? "例如：英语 Unit 3 单词" : "例如：下午 3 点产品会议"} required /></label>
            <div className="form-grid">
              <label>分类<select name="category" defaultValue={data.categories[0]?.id || ""}><option value="">未分类</option>{data.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
              <label>{newTaskType === "memory" ? "首次学习日期" : "任务日期"}<input name="startDate" type="date" defaultValue={today} required /></label>
            </div>
            {newTaskType === "normal" && <div className="form-grid"><label>开始时间<input name="startTime" type="time" /></label><label>结束时间<input name="endTime" type="time" /></label></div>}
            <label>标签<input name="tags" placeholder="例如：工作、错题、背诵（逗号分隔）" /></label>
            {newTaskType === "memory" && <div className="schedule-preview"><strong>自动安排 5 次复习</strong><span>1 天后 · 2 天后 · 4 天后 · 7 天后 · 15 天后</span></div>}
            <div className="modal-actions"><button type="button" className="ghost" onClick={() => setShowAdd(false)}>取消</button><button className="primary">{newTaskType === "memory" ? "添加并排期" : "添加任务"}</button></div>
          </form>
        </div>
      </div>}
      {editingTask && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setEditingTask(null)}>
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-task-title">
          <div className="modal-head"><div><p className="eyebrow">编辑任务</p><h2 id="edit-task-title">编辑任务</h2></div><button className="close" onClick={() => setEditingTask(null)} aria-label="关闭">×</button></div>
          <form onSubmit={saveEditedTask}>
            <div className={`editing-type ${editingTask.type}`}>{editingTask.type === "memory" ? "🧠 记忆任务" : "普通任务"}<small>任务类型创建后不可转换</small></div>
            <label>任务名称<input value={editingTask.title} onChange={(event) => setEditingTask({ ...editingTask, title: event.target.value })} maxLength={100} required /></label>
            <div className="form-grid"><label>分类<select value={editingTask.categoryId} onChange={(event) => setEditingTask({ ...editingTask, categoryId: event.target.value })}><option value="">未分类</option>{data.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label>{editingTask.type === "memory" ? "首次学习日期" : "任务日期"}<input type="date" value={editingTask.startDate} onChange={(event) => setEditingTask({ ...editingTask, startDate: event.target.value })} required /></label></div>
            {editingTask.type === "normal" && <div className="form-grid"><label>开始时间<input type="time" value={editingTask.startTime || ""} onChange={(event) => setEditingTask({ ...editingTask, startTime: event.target.value })} /></label><label>结束时间<input type="time" value={editingTask.endTime || ""} onChange={(event) => setEditingTask({ ...editingTask, endTime: event.target.value })} /></label></div>}
            <label>标签</label><div className="editable-tags">{editingTask.tags.length ? editingTask.tags.map((tag) => <button type="button" key={tag} onClick={() => { const stamp = new Date().toISOString(); setEditingTask({ ...editingTask, tags: editingTask.tags.filter((entry) => entry !== tag), tagChanges: { ...getTagChanges(editingTask), [tag]: { present: false, updatedAt: stamp } } }); }}>#{tag}<span>×</span></button>) : <small>还没有标签</small>}</div>
            <div className="inline-form"><input value={newEditTag} onChange={(event) => setNewEditTag(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addEditTag(); } }} placeholder="输入新标签" /><button type="button" className="secondary" onClick={addEditTag}>添加标签</button></div>
            <div className="modal-actions"><button type="button" className="ghost" onClick={() => setEditingTask(null)}>取消</button><button className="primary">保存修改</button></div>
          </form>
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

function TodayTask({ task, category, onToggle }: { task: Task; category?: Category; onToggle: (id: string, index: number) => void }) {
  const actionable = INTERVALS.map((_, index) => ({ index, status: reviewStatus(task, index), date: reviewDate(task, index) })).filter((entry) => entry.status === "due" || entry.status === "overdue");
  return <article className="today-task"><i style={{ background: category?.color || "#a1a1aa" }} /><div className="task-info"><span>{category?.name || "未分类"}</span><strong>{task.title}</strong><small>{task.tags.join(" · ") || "暂无标签"}</small></div><div className="today-actions">{actionable.map((entry) => <button key={entry.index} className={entry.status} onClick={() => onToggle(task.id, entry.index)}><span>{entry.status === "overdue" ? "已逾期" : "今天"}</span><small>第 {entry.index + 1} 次 · {dateLabel(entry.date)}</small></button>)}</div></article>;
}

function TodayNormalTask({ task, category, onToggle }: { task: Task; category?: Category; onToggle: (id: string) => void }) {
  const time = task.startTime ? `${task.startTime}${task.endTime ? `—${task.endTime}` : ""}` : "全天";
  return <article className="today-task normal"><i style={{ background: category?.color || "#71717a" }} /><div className="task-info"><span>{category?.name || "未分类"} · 普通任务</span><strong>{task.title}</strong><small>{time} · {task.tags.join(" · ") || "暂无标签"}</small></div><div className="today-actions"><button className="normal-done" onClick={() => onToggle(task.id)}><span>完成任务</span><small>仅本次</small></button></div></article>;
}

function TaskCard({ task, category, onToggle, onToggleNormal, onEdit, onDelete, onRemoveTag, onFocus }: { task: Task; category?: Category; onToggle: (id: string, index: number) => void; onToggleNormal: () => void; onEdit: () => void; onDelete: () => void; onRemoveTag: (tag: string) => void; onFocus: () => void }) {
  const categoryColor = category?.color || "#71717a";
  return <article className={`task-card ${isTaskFinished(task) ? "finished" : ""}`}>
    <div className="task-card-head"><div><div className="task-badges"><span className="category-pill" style={{ color: categoryColor, background: `${categoryColor}18` }}>{category?.name || "未分类"}</span><span className={`task-kind ${task.type}`}>{task.type === "memory" ? "🧠 记忆" : "普通"}</span></div><h3>{task.title}</h3><div className="tags">{task.tags.length ? task.tags.map((tag) => <button type="button" key={tag} onClick={() => onRemoveTag(tag)} title={`删除标签 ${tag}`}>#{tag}<span>删除 ×</span></button>) : <button type="button" onClick={onEdit}>＋ 添加标签</button>}</div></div><button className="more" onClick={onEdit} aria-label="编辑任务和标签">编辑任务</button></div>
    {task.type === "memory" ? <div className="review-track">{INTERVALS.map((days, index) => { const status = reviewStatus(task, index); const statusLabel = status === "done" ? "已完成" : status === "overdue" ? "已逾期" : status === "due" ? "今日复习" : status === "soon" ? "即将到期" : "安全期"; return <button key={days} className={status} onClick={() => onToggle(task.id, index)} aria-pressed={task.completed[index]} title={`${statusLabel} · ${dateLabel(reviewDate(task, index))}`}><i>{status === "done" ? "✓" : index + 1}</i><span>{dateLabel(reviewDate(task, index))}</span><small>{statusLabel}</small></button>; })}</div> : <div className="normal-task-row"><div><span>{task.startTime ? `${task.startTime}${task.endTime ? `—${task.endTime}` : ""}` : "全天任务"}</span><strong>{task.normalCompleted ? "已完成" : "待完成"}</strong></div><button className={task.normalCompleted ? "done" : ""} onClick={onToggleNormal}>{task.normalCompleted ? "恢复任务" : "标记完成"}</button></div>}
    <div className="task-card-foot"><span>{task.type === "memory" ? "开始于" : "安排于"} {dateLabel(task.startDate)}</span><div><button className="text-button" onClick={onEdit}>管理标签</button><button className="text-button" onClick={onFocus}>开始专注</button><button className="text-button danger-text" onClick={onDelete}>删除任务</button></div></div>
  </article>;
}
