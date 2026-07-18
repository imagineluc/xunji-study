"use client";

import { CSSProperties, useMemo, useState } from "react";
import styles from "./CalendarApp.module.css";

export type CalendarTask = {
  id: string | number;
  type: "normal" | "memory";
  title: string;
  date: string;
  stage?: number;
  startTime?: string;
  endTime?: string;
  completed?: boolean;
};

export type CalendarViewProps = {
  tasks: CalendarTask[];
  date: string;
  completedIds: Set<string | number>;
  onToggleComplete: (id: string | number) => void;
};

type ViewMode = "day" | "week" | "month";
const DEMO_TODAY = "2026-07-18";
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const HOURS = Array.from({ length: 13 }, (_, index) => index + 8);

const DEMO_TASKS: CalendarTask[] = [
  { id: 1, type: "normal", title: "和产品经理同步日历方案", date: "2026-07-18", startTime: "09:30", endTime: "10:30" },
  { id: 2, type: "normal", title: "整理第二季度学习笔记", date: "2026-07-18", startTime: "13:30", endTime: "15:00" },
  { id: 3, type: "normal", title: "完成交互原型评审", date: "2026-07-18", startTime: "16:00", endTime: "17:00" },
  { id: 4, type: "memory", title: "背诵流体力学第一章", stage: 3, date: "2026-07-18" },
  { id: 5, type: "memory", title: "复习高等数学：曲面积分", stage: 2, date: "2026-07-18" },
  { id: 6, type: "memory", title: "英语核心词组 · Unit 08", stage: 5, date: "2026-07-18", completed: true },
  { id: 7, type: "memory", title: "计算机网络：传输层", stage: 1, date: "2026-07-18" },
  { id: 8, type: "memory", title: "线性代数错题回顾", stage: 4, date: "2026-07-18" },
  { id: 9, type: "normal", title: "晨间规划", date: "2026-07-13", startTime: "09:00", endTime: "09:30" },
  { id: 10, type: "memory", title: "材料力学习题", stage: 2, date: "2026-07-13" },
  { id: 11, type: "normal", title: "项目周会", date: "2026-07-14", startTime: "10:00", endTime: "11:00" },
  { id: 12, type: "memory", title: "概率论公式", stage: 1, date: "2026-07-14" },
  { id: 13, type: "normal", title: "深度工作 · 原型", date: "2026-07-15", startTime: "14:00", endTime: "16:00" },
  { id: 14, type: "memory", title: "英语听力精听", stage: 3, date: "2026-07-15" },
  { id: 15, type: "memory", title: "操作系统进程调度", stage: 2, date: "2026-07-16" },
  { id: 16, type: "normal", title: "论文资料检索", date: "2026-07-16", startTime: "15:30", endTime: "17:00" },
  { id: 17, type: "normal", title: "健身训练", date: "2026-07-17", startTime: "18:00", endTime: "19:00" },
  { id: 18, type: "memory", title: "信号与系统", stage: 4, date: "2026-07-17" },
  { id: 19, type: "memory", title: "数据库范式", stage: 2, date: "2026-07-19" },
  { id: 20, type: "normal", title: "周复盘", date: "2026-07-19", startTime: "19:00", endTime: "20:00" },
  { id: 21, type: "memory", title: "工程热力学第二章", stage: 1, date: "2026-07-21" },
  { id: 22, type: "normal", title: "实验报告定稿", date: "2026-07-22", startTime: "09:00", endTime: "11:00" },
  { id: 23, type: "memory", title: "机械原理知识图谱", stage: 3, date: "2026-07-24" },
  { id: 24, type: "memory", title: "英语核心词组 · Unit 09", stage: 1, date: "2026-07-27" },
  { id: 25, type: "normal", title: "月度学习复盘", date: "2026-07-31", startTime: "16:00", endTime: "17:30" },
];

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function toISO(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(value: string, amount: number) {
  const date = parseDate(value);
  date.setDate(date.getDate() + amount);
  return toISO(date);
}

function startOfWeek(value: string) {
  const date = parseDate(value);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return toISO(date);
}

function getMonthCells(value: string) {
  const date = parseDate(value);
  const first = new Date(date.getFullYear(), date.getMonth(), 1, 12);
  const start = new Date(first);
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => {
    const cell = new Date(start);
    cell.setDate(start.getDate() + index);
    return toISO(cell);
  });
}

function formatTitle(value: string, view: ViewMode) {
  const date = parseDate(value);
  if (view === "day") return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(date);
  if (view === "week") {
    const start = parseDate(startOfWeek(value));
    const end = parseDate(addDays(startOfWeek(value), 6));
    return `${date.getFullYear()}年 ${start.getMonth() + 1}月${start.getDate()}日—${end.getMonth() + 1}月${end.getDate()}日`;
  }
  return `${date.getFullYear()}年 ${date.getMonth() + 1}月`;
}

function timeToMinutes(value = "08:00") {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function tasksOn(tasks: CalendarTask[], date: string) {
  return tasks.filter((task) => task.date === date);
}

function MemoryTask({ task, done, onToggle, compact = false }: { task: CalendarTask; done: boolean; onToggle: () => void; compact?: boolean }) {
  return (
    <div className={`${styles.memoryTask} ${done ? styles.taskDone : ""} ${compact ? styles.compactTask : ""}`}>
      <button className={styles.checkButton} onClick={onToggle} aria-label={`${done ? "恢复" : "完成"}复习：${task.title}`} aria-pressed={done}>{done ? "✓" : ""}</button>
      <span className={styles.brain} aria-hidden="true">🧠</span>
      <span className={styles.taskTitle}>{task.title}</span>
      <small>第{task.stage ?? 1}轮</small>
    </div>
  );
}

export function DayView({ tasks, date, completedIds, onToggleComplete }: CalendarViewProps) {
  const dailyTasks = tasksOn(tasks, date);
  const memoryTasks = dailyTasks.filter((task) => task.type === "memory");
  const normalTasks = dailyTasks.filter((task) => task.type === "normal" && task.startTime);
  return (
    <div className={styles.dayView}>
      <section className={styles.allDay} aria-labelledby="all-day-title">
        <div className={styles.allDayLabel}><span id="all-day-title">全天任务</span><small>{memoryTasks.filter((task) => !completedIds.has(task.id)).length} 项待复习</small></div>
        <div className={styles.allDayTasks}>
          {memoryTasks.length ? memoryTasks.map((task) => <MemoryTask key={task.id} task={task} done={completedIds.has(task.id)} onToggle={() => onToggleComplete(task.id)} />) : <div className={styles.emptyInline}>今天没有安排复习</div>}
        </div>
      </section>
      <div className={styles.timeline}>
        <div className={styles.hourLabels} aria-hidden="true">{HOURS.map((hour) => <span key={hour}>{String(hour).padStart(2, "0")}:00</span>)}</div>
        <div className={styles.timeCanvas}>
          {HOURS.slice(0, -1).map((hour) => <div className={styles.hourLine} key={hour} />)}
          {normalTasks.map((task) => {
            const start = Math.max(0, timeToMinutes(task.startTime) - 8 * 60);
            const duration = Math.max(45, timeToMinutes(task.endTime ?? task.startTime) - timeToMinutes(task.startTime));
            const style = { "--task-start": start, "--task-duration": duration } as CSSProperties;
            return <article className={styles.timedTask} style={style} key={task.id}><i aria-hidden="true" /><div><strong>{task.title}</strong><span>{task.startTime}—{task.endTime ?? "待定"}</span></div></article>;
          })}
        </div>
      </div>
    </div>
  );
}

export function WeekView({ tasks, date, completedIds, onToggleComplete }: CalendarViewProps) {
  const weekStart = startOfWeek(date);
  const dates = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  function toggleExpanded(day: string) {
    setExpandedDates((current) => { const next = new Set(current); if (next.has(day)) next.delete(day); else next.add(day); return next; });
  }
  return (
    <div className={styles.weekScroller}><div className={styles.weekGrid}>
      {dates.map((day, index) => {
        const daily = tasksOn(tasks, day);
        const memory = daily.filter((task) => task.type === "memory");
        const normal = daily.filter((task) => task.type === "normal");
        const expanded = expandedDates.has(day);
        return <section className={`${styles.weekDay} ${day === DEMO_TODAY ? styles.currentDay : ""}`} key={day} aria-label={`${WEEKDAYS[index]} ${parseDate(day).getDate()}日`}>
          <header><span>{WEEKDAYS[index]}</span><strong>{parseDate(day).getDate()}</strong></header>
          <div className={styles.weekTasks}>
            {normal.map((task) => <article className={styles.weekNormalTask} key={task.id}><i aria-hidden="true" /><span>{task.startTime}</span><strong>{task.title}</strong></article>)}
            {(expanded ? memory : memory.slice(0, 3)).map((task) => <MemoryTask key={task.id} task={task} done={completedIds.has(task.id)} onToggle={() => onToggleComplete(task.id)} compact />)}
            {memory.length > 3 && <button className={styles.expandButton} onClick={() => toggleExpanded(day)} aria-expanded={expanded}>🧠 {expanded ? "收起复习" : `还有 ${memory.length - 3} 项复习`}</button>}
            {!daily.length && <span className={styles.emptyDay}>暂无安排</span>}
          </div>
        </section>;
      })}
    </div></div>
  );
}

export function MonthView({ tasks, date, completedIds }: CalendarViewProps) {
  const cells = getMonthCells(date);
  const currentMonth = parseDate(date).getMonth();
  return (
    <div className={styles.monthScroller}>
      <div className={styles.monthWeekdays}>{WEEKDAYS.map((day) => <span key={day}>{day}</span>)}</div>
      <div className={styles.monthGrid}>{cells.map((day) => {
        const daily = tasksOn(tasks, day);
        const normal = daily.filter((task) => task.type === "normal");
        const memory = daily.filter((task) => task.type === "memory");
        return <section className={`${styles.monthCell} ${parseDate(day).getMonth() !== currentMonth ? styles.outsideMonth : ""} ${day === DEMO_TODAY ? styles.currentMonthDay : ""}`} key={day}>
          <time dateTime={day}>{parseDate(day).getDate()}</time>
          <div className={styles.monthNormalTasks}>{normal.slice(0, 2).map((task) => <span key={task.id}>{task.title}</span>)}{normal.length > 2 && <small>+{normal.length - 2} 项</small>}</div>
          {memory.length > 0 && <div className={styles.memoryIndicator}>
            <button aria-label={`${memory.length} 项复习，查看清单`}><i aria-hidden="true" /><span>{memory.length}</span></button>
            <div className={styles.tooltip} role="tooltip"><div className={styles.tooltipHeader}><span>复习清单</span><small>{memory.length} 项</small></div>
              {memory.map((task) => <div className={completedIds.has(task.id) ? styles.tooltipDone : ""} key={task.id}><span>🧠</span><strong>{task.title}</strong><small>第{task.stage ?? 1}轮</small></div>)}
            </div>
          </div>}
        </section>;
      })}</div>
    </div>
  );
}

export function CalendarApp({ tasks = DEMO_TASKS }: { tasks?: CalendarTask[] }) {
  const [view, setView] = useState<ViewMode>("week");
  const [date, setDate] = useState(DEMO_TODAY);
  const [completedIds, setCompletedIds] = useState<Set<string | number>>(() => new Set(tasks.filter((task) => task.completed).map((task) => task.id)));
  const periodTasks = useMemo(() => {
    if (view === "day") return tasksOn(tasks, date);
    if (view === "week") { const start = startOfWeek(date); const end = addDays(start, 6); return tasks.filter((task) => task.date >= start && task.date <= end); }
    return tasks.filter((task) => task.date.startsWith(date.slice(0, 7)));
  }, [date, tasks, view]);
  const memoryCount = periodTasks.filter((task) => task.type === "memory").length;
  const doneCount = periodTasks.filter((task) => task.type === "memory" && completedIds.has(task.id)).length;
  function movePeriod(direction: number) {
    if (view === "day") return setDate(addDays(date, direction));
    if (view === "week") return setDate(addDays(date, direction * 7));
    const next = parseDate(date); next.setMonth(next.getMonth() + direction, 1); setDate(toISO(next));
  }
  function toggleComplete(id: string | number) {
    setCompletedIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  const sharedProps = { tasks, date, completedIds, onToggleComplete: toggleComplete };
  return (
    <div className={styles.appShell}>
      <aside className={styles.sidebar}>
        <a href="/" className={styles.brand} aria-label="循记日历首页"><span>循</span><strong>循记</strong></a>
        <nav aria-label="主导航"><a className={styles.activeNav} href="/"><span>◫</span>日历</a><a href="/study"><span>◎</span>记忆库</a><a href="/study"><span>◷</span>专注模式</a></nav>
        <div className={styles.sidebarSection}><span>我的日历</span><div><i className={styles.normalLegend} />普通任务</div><div><i className={styles.memoryLegend} />记忆复习</div></div>
        <div className={styles.progressCard}><div><span>本期复习</span><strong>{doneCount}/{memoryCount}</strong></div><div className={styles.progressTrack}><i style={{ width: `${memoryCount ? Math.round(doneCount / memoryCount * 100) : 0}%` }} /></div><small>完成一项，记忆就更稳一点</small></div>
        <div className={styles.profile}><span>SR</span><div><strong>Serenity</strong><small>保持节奏</small></div></div>
      </aside>
      <main className={styles.main}>
        <header className={styles.topbar}><div><span className={styles.eyebrow}>日历 / 任务计划</span><h1>{formatTitle(date, view)}</h1></div><div className={styles.topActions}><span className={styles.syncState}><i />本地已同步</span><a href="/study" className={styles.addButton}>＋ 新建任务</a></div></header>
        <section className={styles.toolbar} aria-label="日历工具栏">
          <div className={styles.periodControls}><button onClick={() => movePeriod(-1)} aria-label="上一时段">‹</button><button onClick={() => setDate(DEMO_TODAY)}>今天</button><button onClick={() => movePeriod(1)} aria-label="下一时段">›</button></div>
          <div className={styles.periodMeta}><span>{periodTasks.length} 个任务</span><i /><span>{memoryCount} 次复习</span></div>
          <div className={styles.viewSwitch} aria-label="切换视图">{(["day", "week", "month"] as ViewMode[]).map((mode) => <button key={mode} onClick={() => setView(mode)} className={view === mode ? styles.activeView : ""} aria-pressed={view === mode}>{{ day: "日", week: "周", month: "月" }[mode]}</button>)}</div>
        </section>
        <section className={styles.calendarFrame}>{view === "day" && <DayView {...sharedProps} />}{view === "week" && <WeekView {...sharedProps} />}{view === "month" && <MonthView {...sharedProps} />}</section>
      </main>
    </div>
  );
}
