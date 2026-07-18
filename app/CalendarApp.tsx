"use client";

import { CSSProperties, DragEvent, MouseEvent, PointerEvent as ReactPointerEvent, TouchEvent, useMemo, useRef, useState } from "react";
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
  color?: string;
  category?: string;
};

export type CalendarCreatePreset = {
  type?: "normal" | "memory";
  date: string;
  startTime?: string;
  endTime?: string;
};

type CalendarAppProps = {
  tasks?: CalendarTask[];
  onToggleComplete?: (id: string | number) => void;
  onCreateTask?: (preset?: CalendarCreatePreset) => void;
  onRescheduleTask?: (id: string | number, date: string, startTime?: string, endTime?: string) => void;
};

type ViewMode = "day" | "threeDay" | "week" | "month";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const START_HOUR = 6;
const END_HOUR = 24;
const HOUR_HEIGHT = 72;
const HOURS = Array.from({ length: END_HOUR - START_HOUR + 1 }, (_, index) => index + START_HOUR);

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

function todayISO() {
  return toISO(new Date());
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
  return Array.from({ length: 42 }, (_, index) => addDays(toISO(start), index));
}

function timeToMinutes(value = `${START_HOUR.toString().padStart(2, "0")}:00`) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(value: number) {
  const minutes = Math.max(0, Math.min(23 * 60 + 30, value));
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function formatRange(value: string, view: ViewMode) {
  const date = parseDate(value);
  if (view === "day") {
    return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(date);
  }
  if (view === "month") return `${date.getFullYear()}年 ${date.getMonth() + 1}月`;
  const first = view === "week" ? startOfWeek(value) : value;
  const last = addDays(first, view === "week" ? 6 : 2);
  const startDate = parseDate(first);
  const endDate = parseDate(last);
  const endLabel = startDate.getMonth() === endDate.getMonth()
    ? `${endDate.getDate()}日`
    : `${endDate.getMonth() + 1}月${endDate.getDate()}日`;
  return `${startDate.getFullYear()}年 ${startDate.getMonth() + 1}月${startDate.getDate()}日—${endLabel}`;
}

function taskTimeLabel(task: CalendarTask) {
  if (!task.startTime) return task.type === "memory" ? `第 ${task.stage ?? 1} 轮复习` : "全天";
  return `${task.startTime}${task.endTime ? `—${task.endTime}` : ""}`;
}

function getViewDates(date: string, view: ViewMode) {
  if (view === "week") {
    const start = startOfWeek(date);
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }
  if (view === "threeDay") return Array.from({ length: 3 }, (_, index) => addDays(date, index));
  return [date];
}

function shiftPeriod(date: string, view: ViewMode, direction: number) {
  if (view === "day") return addDays(date, direction);
  if (view === "threeDay") return addDays(date, direction * 3);
  if (view === "week") return addDays(date, direction * 7);
  const next = parseDate(date);
  next.setMonth(next.getMonth() + direction, 1);
  return toISO(next);
}

type TouchTaskDrag = {
  task: CalendarTask;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
};

function useTouchTaskDrag(onDrop: (task: CalendarTask, clientX: number, clientY: number) => void) {
  const activeDrag = useRef<TouchTaskDrag | null>(null);
  const suppressedClick = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  function startTaskPointer(event: ReactPointerEvent<HTMLElement>, task: CalendarTask) {
    if (event.pointerType === "mouse" || event.button !== 0) return;
    event.stopPropagation();
    activeDrag.current = { task, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveTaskPointer(event: ReactPointerEvent<HTMLElement>) {
    const active = activeDrag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - active.startX, event.clientY - active.startY);
    if (!active.dragging && distance < 8) return;
    if (!active.dragging) {
      active.dragging = true;
      setDraggingId(String(active.task.id));
    }
    event.preventDefault();
    event.stopPropagation();
  }

  function finishTaskPointer(event: ReactPointerEvent<HTMLElement>) {
    const active = activeDrag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    activeDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDraggingId(null);
    if (!active.dragging) return;
    event.preventDefault();
    event.stopPropagation();
    suppressedClick.current = String(active.task.id);
    onDrop(active.task, event.clientX, event.clientY);
    window.setTimeout(() => {
      if (suppressedClick.current === String(active.task.id)) suppressedClick.current = null;
    }, 400);
  }

  function cancelTaskPointer(event: ReactPointerEvent<HTMLElement>) {
    if (activeDrag.current?.pointerId !== event.pointerId) return;
    activeDrag.current = null;
    setDraggingId(null);
  }

  function ignoreTaskClick(task: CalendarTask) {
    if (suppressedClick.current !== String(task.id)) return false;
    suppressedClick.current = null;
    return true;
  }

  return { draggingId, startTaskPointer, moveTaskPointer, finishTaskPointer, cancelTaskPointer, ignoreTaskClick };
}

function TimelineTask({ task, dragging, onSelect, onToggle, onDragStart, onPointerDown, onPointerMove, onPointerUp, onPointerCancel }: {
  task: CalendarTask;
  dragging: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const start = Math.max(0, timeToMinutes(task.startTime) - START_HOUR * 60);
  const duration = Math.max(30, timeToMinutes(task.endTime ?? task.startTime) - timeToMinutes(task.startTime));
  const style = {
    "--task-start": start,
    "--task-duration": duration,
    "--task-color": task.color || "var(--ui-action)",
  } as CSSProperties;
  return (
    <article
      className={`${styles.timedTask} ${task.completed ? styles.completedTask : ""} ${dragging ? styles.touchDragging : ""}`}
      style={style}
      draggable
      data-calendar-task="true"
      onDragStart={onDragStart}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClick={(event) => { event.stopPropagation(); onSelect(); }}
      tabIndex={0}
      onKeyDown={(event) => event.key === "Enter" && onSelect()}
      aria-label={`${task.title}，${taskTimeLabel(task)}`}
    >
      <button
        type="button"
        className={styles.taskCheck}
        aria-label={task.completed ? "恢复任务" : "完成任务"}
        aria-pressed={task.completed}
        onClick={(event) => { event.stopPropagation(); onToggle(); }}
      >{task.completed ? "✓" : ""}</button>
      <div><strong>{task.title}</strong><span>{taskTimeLabel(task)}</span></div>
    </article>
  );
}

function TimelineView({ dates, tasks, onCreate, onSelect, onToggle, onReschedule }: {
  dates: string[];
  tasks: CalendarTask[];
  onCreate: (preset: CalendarCreatePreset) => void;
  onSelect: (task: CalendarTask) => void;
  onToggle: (id: string | number) => void;
  onReschedule: (task: CalendarTask, date: string, startTime?: string, endTime?: string) => void;
}) {
  const dayMin = dates.length === 1 ? 360 : dates.length === 3 ? 220 : 148;
  const gridStyle = { "--days": dates.length, "--day-min": `${dayMin}px` } as CSSProperties;

  function createAt(event: MouseEvent<HTMLDivElement>, day: string) {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const rawMinutes = START_HOUR * 60 + ((event.clientY - rect.top) / HOUR_HEIGHT) * 60;
    const snapped = Math.round(rawMinutes / 30) * 30;
    onCreate({ type: "normal", date: day, startTime: minutesToTime(snapped), endTime: minutesToTime(snapped + 60) });
  }

  function dropAt(event: DragEvent<HTMLDivElement>, day: string, allDay = false) {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/calendar-task");
    const task = tasks.find((item) => String(item.id) === id);
    if (!task) return;
    if (allDay || !task.startTime) return onReschedule(task, day, task.startTime, task.endTime);
    const rect = event.currentTarget.getBoundingClientRect();
    const rawMinutes = START_HOUR * 60 + ((event.clientY - rect.top) / HOUR_HEIGHT) * 60;
    const snapped = Math.round(rawMinutes / 30) * 30;
    const duration = Math.max(30, timeToMinutes(task.endTime ?? task.startTime) - timeToMinutes(task.startTime));
    onReschedule(task, day, minutesToTime(snapped), minutesToTime(snapped + duration));
  }

  const touchDrag = useTouchTaskDrag((task, clientX, clientY) => {
    const dropTarget = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-calendar-drop-date]");
    const day = dropTarget?.dataset.calendarDropDate;
    if (!dropTarget || !day) return;
    if (dropTarget.dataset.calendarDropKind === "all-day" || !task.startTime) {
      onReschedule(task, day, task.startTime, task.endTime);
      return;
    }
    const rect = dropTarget.getBoundingClientRect();
    const duration = Math.max(30, timeToMinutes(task.endTime ?? task.startTime) - timeToMinutes(task.startTime));
    const rawMinutes = START_HOUR * 60 + ((clientY - rect.top) / HOUR_HEIGHT) * 60;
    const snapped = Math.max(START_HOUR * 60, Math.min(END_HOUR * 60 - duration, Math.round(rawMinutes / 30) * 30));
    onReschedule(task, day, minutesToTime(snapped), minutesToTime(snapped + duration));
  });

  const now = new Date();
  const nowOffset = (now.getHours() * 60 + now.getMinutes() - START_HOUR * 60) / 60 * HOUR_HEIGHT;
  return (
    <div className={styles.timelineScroller}>
      <div className={styles.timelineBoard} style={gridStyle} data-days={dates.length}>
        <div className={styles.timelineHeader}>
          <div className={styles.cornerLabel}>GMT+8</div>
          {dates.map((day) => {
            const parsed = parseDate(day);
            const current = day === todayISO();
            return <button key={day} type="button" className={current ? styles.todayHeader : ""} onClick={() => onCreate({ type: "normal", date: day })}><span>{WEEKDAYS[parsed.getDay()]}</span><strong>{parsed.getDate()}</strong></button>;
          })}
        </div>
        <div className={styles.allDayRow}>
          <div className={styles.allDayTitle}><span>全天</span></div>
          {dates.map((day) => {
            const dayTasks = tasks.filter((task) => task.date === day && !task.startTime);
            return <div key={day} className={styles.allDayColumn} data-calendar-drop-date={day} data-calendar-drop-kind="all-day" onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropAt(event, day, true)}>
              {dayTasks.map((task) => <button
                type="button"
                draggable
                data-calendar-task="true"
                onDragStart={(event) => event.dataTransfer.setData("text/calendar-task", String(task.id))}
                onPointerDown={(event) => touchDrag.startTaskPointer(event, task)}
                onPointerMove={touchDrag.moveTaskPointer}
                onPointerUp={touchDrag.finishTaskPointer}
                onPointerCancel={touchDrag.cancelTaskPointer}
                onClick={() => { if (!touchDrag.ignoreTaskClick(task)) onSelect(task); }}
                className={`${styles.allDayTask} ${task.type === "memory" ? styles.memoryTask : ""} ${task.completed ? styles.completedTask : ""} ${touchDrag.draggingId === String(task.id) ? styles.touchDragging : ""}`}
                style={{ "--task-color": task.color || "var(--ui-action)" } as CSSProperties}
                key={task.id}
              ><i />{task.type === "memory" && <span className={styles.memoryMark}>记</span>}<span>{task.title}</span><small>{task.type === "memory" ? `R${task.stage ?? 1}` : ""}</small></button>)}
              <button className={styles.quickAddAllDay} type="button" onClick={() => onCreate({ type: "normal", date: day })}>＋</button>
            </div>;
          })}
        </div>
        <div className={styles.timelineBody}>
          <div className={styles.timeRail}>{HOURS.map((hour) => <span key={hour}>{hour < END_HOUR ? `${String(hour).padStart(2, "0")}:00` : ""}</span>)}</div>
          {dates.map((day) => {
            const timed = tasks.filter((task) => task.date === day && task.startTime);
            return <div
              className={`${styles.dayColumn} ${day === todayISO() ? styles.todayColumn : ""}`}
              key={day}
              data-calendar-drop-date={day}
              data-calendar-drop-kind="timeline"
              onClick={(event) => createAt(event, day)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => dropAt(event, day)}
            >
              {HOURS.slice(0, -1).map((hour) => <div className={styles.hourLine} key={hour} />)}
              {day === todayISO() && nowOffset >= 0 && nowOffset <= (END_HOUR - START_HOUR) * HOUR_HEIGHT && <div className={styles.nowLine} style={{ top: nowOffset }}><i /></div>}
              {timed.map((task) => <TimelineTask
                key={task.id}
                task={task}
                dragging={touchDrag.draggingId === String(task.id)}
                onSelect={() => { if (!touchDrag.ignoreTaskClick(task)) onSelect(task); }}
                onToggle={() => onToggle(task.id)}
                onDragStart={(event) => event.dataTransfer.setData("text/calendar-task", String(task.id))}
                onPointerDown={(event) => touchDrag.startTaskPointer(event, task)}
                onPointerMove={touchDrag.moveTaskPointer}
                onPointerUp={touchDrag.finishTaskPointer}
                onPointerCancel={touchDrag.cancelTaskPointer}
              />)}
            </div>;
          })}
        </div>
      </div>
    </div>
  );
}

function MonthView({ date, tasks, onSelectDate, onSelectTask, onCreate, onReschedule }: {
  date: string;
  tasks: CalendarTask[];
  onSelectDate: (date: string) => void;
  onSelectTask: (task: CalendarTask) => void;
  onCreate: (preset: CalendarCreatePreset) => void;
  onReschedule: (task: CalendarTask, date: string, startTime?: string, endTime?: string) => void;
}) {
  const cells = getMonthCells(date);
  const month = parseDate(date).getMonth();
  const touchDrag = useTouchTaskDrag((task, clientX, clientY) => {
    const dropTarget = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-calendar-drop-date]");
    const day = dropTarget?.dataset.calendarDropDate;
    if (day) onReschedule(task, day, task.startTime, task.endTime);
  });

  function dropOnDay(event: DragEvent<HTMLElement>, day: string) {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/calendar-task");
    const task = tasks.find((item) => String(item.id) === id);
    if (task) onReschedule(task, day, task.startTime, task.endTime);
  }

  return <div className={styles.monthScroller}>
    <div className={styles.monthBoard}>
      <div className={styles.monthWeekdays}>{["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map((day) => <span key={day}>{day}</span>)}</div>
      <div className={styles.monthGrid}>{cells.map((day) => {
        const parsed = parseDate(day);
        const dayTasks = tasks.filter((task) => task.date === day);
        return <section
          className={`${styles.monthCell} ${parsed.getMonth() !== month ? styles.outsideMonth : ""} ${day === todayISO() ? styles.currentMonthDay : ""}`}
          key={day}
          data-calendar-drop-date={day}
          data-calendar-drop-kind="month"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => dropOnDay(event, day)}
        >
          <button type="button" className={styles.dateButton} onClick={() => onSelectDate(day)}><time dateTime={day}>{parsed.getDate()}</time></button>
          <div className={styles.monthTasks}>{dayTasks.slice(0, 3).map((task) => <button
            type="button"
            key={task.id}
            draggable
            data-calendar-task="true"
            className={`${task.type === "memory" ? styles.monthMemory : ""} ${task.completed ? styles.completedTask : ""} ${touchDrag.draggingId === String(task.id) ? styles.touchDragging : ""}`}
            style={{ "--task-color": task.color || "var(--ui-action)" } as CSSProperties}
            onDragStart={(event) => event.dataTransfer.setData("text/calendar-task", String(task.id))}
            onPointerDown={(event) => touchDrag.startTaskPointer(event, task)}
            onPointerMove={touchDrag.moveTaskPointer}
            onPointerUp={touchDrag.finishTaskPointer}
            onPointerCancel={touchDrag.cancelTaskPointer}
            onClick={() => { if (!touchDrag.ignoreTaskClick(task)) onSelectTask(task); }}
          ><i />{task.startTime && <small>{task.startTime}</small>}<span>{task.title}</span></button>)}</div>
          {dayTasks.length > 3 && <button type="button" className={styles.moreTasks} onClick={() => onSelectDate(day)}>还有 {dayTasks.length - 3} 项</button>}
          <button type="button" className={styles.cellAdd} aria-label={`在 ${day} 新建任务`} onClick={() => onCreate({ type: "normal", date: day })}>＋</button>
        </section>;
      })}</div>
    </div>
  </div>;
}

function TaskDetail({ task, onClose, onToggle, onMove }: {
  task: CalendarTask;
  onClose: () => void;
  onToggle: () => void;
  onMove: (date: string) => void;
}) {
  const [moveDate, setMoveDate] = useState(task.date);
  return <div className={styles.detailBackdrop} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className={styles.taskDetail} role="dialog" aria-modal="true" aria-labelledby="calendar-task-title">
      <div className={styles.detailHandle} />
      <header><span className={task.type === "memory" ? styles.memoryBadge : styles.normalBadge}>{task.type === "memory" ? `第 ${task.stage ?? 1} 轮复习` : "普通任务"}</span><button type="button" onClick={onClose} aria-label="关闭任务详情">×</button></header>
      <h3 id="calendar-task-title">{task.title}</h3>
      <div className={styles.detailMeta}><div><span>日期</span><strong>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(parseDate(task.date))}</strong></div><div><span>时间</span><strong>{taskTimeLabel(task)}</strong></div></div>
      <label className={styles.moveField}>调整日期<input type="date" value={moveDate} onChange={(event) => setMoveDate(event.target.value)} /></label>
      <div className={styles.detailActions}><button type="button" className={styles.secondaryAction} onClick={() => onMove(moveDate)} disabled={moveDate === task.date}>移动到该日</button><button type="button" className={styles.primaryAction} onClick={onToggle}>{task.completed ? "恢复为待办" : "标记完成"}</button></div>
      <p>桌面端和手机端都可直接拖动任务，也可在这里精确调整日期。</p>
    </aside>
  </div>;
}

export function CalendarApp({ tasks = [], onToggleComplete, onCreateTask, onRescheduleTask }: CalendarAppProps) {
  const [view, setView] = useState<ViewMode>(() => typeof window !== "undefined" && window.innerWidth <= 760 ? "threeDay" : "week");
  const [date, setDate] = useState(todayISO);
  const [showCompleted, setShowCompleted] = useState(true);
  const [showOptions, setShowOptions] = useState(false);
  const [selectedTask, setSelectedTask] = useState<CalendarTask | null>(null);
  const [localDone, setLocalDone] = useState<Set<string | number>>(new Set());
  const [touchStart, setTouchStart] = useState<{ x: number; y: number } | null>(null);

  const effectiveTasks = useMemo(() => tasks
    .map((task) => ({ ...task, completed: task.completed || localDone.has(task.id) }))
    .filter((task) => showCompleted || !task.completed), [localDone, showCompleted, tasks]);
  const dates = getViewDates(date, view);
  const rangeStart = view === "week" ? startOfWeek(date) : view === "month" ? `${date.slice(0, 7)}-01` : dates[0];
  const rangeEnd = view === "month" ? toISO(new Date(parseDate(rangeStart).getFullYear(), parseDate(rangeStart).getMonth() + 1, 0, 12)) : dates.at(-1) ?? date;
  const periodTasks = effectiveTasks.filter((task) => task.date >= rangeStart && task.date <= rangeEnd);
  const completedCount = periodTasks.filter((task) => task.completed).length;
  const memoryCount = periodTasks.filter((task) => task.type === "memory").length;

  function toggleTask(id: string | number) {
    if (onToggleComplete) onToggleComplete(id);
    else setLocalDone((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    if (selectedTask?.id === id) setSelectedTask({ ...selectedTask, completed: !selectedTask.completed });
  }

  function createTask(preset: CalendarCreatePreset) {
    onCreateTask?.(preset);
  }

  function reschedule(task: CalendarTask, nextDate: string, startTime = task.startTime, endTime = task.endTime) {
    onRescheduleTask?.(task.id, nextDate, startTime, endTime);
    setSelectedTask(null);
  }

  function move(direction: number) {
    setDate((current) => shiftPeriod(current, view, direction));
  }

  function handleTouchStart(event: TouchEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("[data-calendar-task]")) return setTouchStart(null);
    const touch = event.touches[0];
    setTouchStart({ x: touch.clientX, y: touch.clientY });
  }

  function handleTouchEnd(event: TouchEvent<HTMLElement>) {
    if (!touchStart) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - touchStart.x;
    const dy = touch.clientY - touchStart.y;
    if (Math.abs(dx) > 64 && Math.abs(dx) > Math.abs(dy) * 1.4) move(dx < 0 ? 1 : -1);
    setTouchStart(null);
  }

  return <div className={styles.calendarApp}>
    <div className={styles.calendarHeading}>
      <div><span>日程与复习</span><h2>{formatRange(date, view)}</h2></div>
      <div className={styles.headingActions}><button type="button" className={styles.iconButton} onClick={() => setShowOptions((open) => !open)} aria-expanded={showOptions} aria-label="日历显示选项"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg></button><button type="button" className={styles.addTaskButton} onClick={() => createTask({ type: "normal", date })} aria-label="新建任务"><span className={styles.addTaskIcon} aria-hidden="true">＋</span><span className={styles.addTaskLabel}>新建</span></button></div>
      {showOptions && <div className={styles.optionsMenu}><strong>显示选项</strong><label><span>显示已完成任务</span><input type="checkbox" checked={showCompleted} onChange={(event) => setShowCompleted(event.target.checked)} /></label><small>时间轴显示 06:00—24:00</small></div>}
    </div>
    <section className={styles.toolbar} aria-label="日历工具栏">
      <div className={styles.periodControls}><button type="button" onClick={() => move(-1)} aria-label="上一时段">‹</button><button type="button" onClick={() => setDate(todayISO())}>今天</button><button type="button" onClick={() => move(1)} aria-label="下一时段">›</button></div>
      <div className={styles.periodMeta}><span>{periodTasks.length} 项安排</span><i /><span>{memoryCount} 次复习</span><i /><span>{completedCount} 项完成</span></div>
      <div className={styles.viewSwitch} aria-label="切换日历视图">{(["day", "threeDay", "week", "month"] as ViewMode[]).map((mode) => <button type="button" key={mode} onClick={() => setView(mode)} className={view === mode ? styles.activeView : ""} aria-pressed={view === mode}>{{ day: "日", threeDay: "3日", week: "周", month: "月" }[mode]}</button>)}</div>
    </section>
    <section className={styles.calendarFrame} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      {!tasks.length ? <div className={styles.calendarEmpty}><span>＋</span><h3>从第一项日程开始</h3><p>在时间轴空白处点击，即可按日期和时间快速创建任务。</p><button type="button" onClick={() => createTask({ type: "normal", date })}>新建日程</button></div>
      : view === "month"
        ? <MonthView date={date} tasks={effectiveTasks} onSelectTask={setSelectedTask} onCreate={createTask} onReschedule={reschedule} onSelectDate={(day) => { setDate(day); setView("day"); }} />
        : <TimelineView dates={dates} tasks={effectiveTasks} onCreate={createTask} onSelect={setSelectedTask} onToggle={toggleTask} onReschedule={reschedule} />}
    </section>
    <div className={styles.calendarHint}><span>点击空白时间快速新建</span><span>拖动任务调整日程</span><span>记忆任务会保留复习轮次</span></div>
    {selectedTask && <TaskDetail task={selectedTask} onClose={() => setSelectedTask(null)} onToggle={() => toggleTask(selectedTask.id)} onMove={(nextDate) => reschedule(selectedTask, nextDate)} />}
  </div>;
}
