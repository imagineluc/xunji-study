import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const studySource = await readFile(new URL("app/StudyApp.tsx", root), "utf8");
const calendarSource = await readFile(new URL("app/CalendarApp.tsx", root), "utf8");
const globalCss = await readFile(new URL("app/globals.css", root), "utf8");
const calendarCss = await readFile(new URL("app/CalendarApp.module.css", root), "utf8");

const functionNames = new Set([
  "uid", "localISO", "parseDate", "addDays", "reviewDate", "getTagChanges", "tagsFromChanges",
  "isOngoingTask", "ongoingTaskStatus", "normalTaskStatus", "normalTaskOverdueLabel", "isTaskFinished",
  "isTaskAvailableForFocus", "taskListState", "ongoingTargetReached", "focusSecondsByTask", "countActiveTasks",
  "normalizeData", "mergeByUpdatedAt", "mergeData", "mergeTasks", "automaticSessionId",
]);
const sourceFile = ts.createSourceFile("StudyApp.tsx", studySource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const printer = ts.createPrinter();
const selectedFunctions = sourceFile.statements
  .filter((statement) => ts.isFunctionDeclaration(statement) && statement.name && functionNames.has(statement.name.text))
  .map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, sourceFile))
  .join("\n");
assert.equal((selectedFunctions.match(/function /g) || []).length, functionNames.size, "regression harness must load every production helper");

const harness = `
const INTERVALS = [1, 2, 4, 7, 15];
const DEFAULT_DATA = { version: 1, tasks: [], deletedTasks: [], sessions: [], appBindings: [], windowsBindings: [], categories: [], settings: { focusMinutes: 25, breakMinutes: 5, dailyGoalMinutes: 180 } };
${selectedFunctions}
return { ${[...functionNames].join(",")} };
`;
const compiled = ts.transpileModule(harness, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const domain = new Function(compiled)();

function normalTask(overrides = {}) {
  return {
    id: "normal-1", type: "normal", title: "普通任务", categoryId: "cat", tags: [], startDate: "2026-07-20",
    scheduleMode: "once", normalCompleted: false, completed: [], createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z", ...overrides,
  };
}

function ongoingTask(overrides = {}) {
  return normalTask({
    id: "ongoing-1", title: "长期课程", scheduleMode: "ongoing", ongoingStatus: "active",
    ongoingStatusUpdatedAt: "2026-07-01T00:00:00.000Z", targetDate: "2026-07-20", ...overrides,
  });
}

test("旧普通任务和旧版记忆数据迁移保持兼容", () => {
  const oldNormal = domain.normalizeData({ version: 1, tasks: [normalTask({ scheduleMode: undefined })] });
  assert.equal(oldNormal.tasks[0].type, "normal");
  assert.equal(oldNormal.tasks[0].scheduleMode, "once");
  assert.equal(oldNormal.tasks[0].ongoingStatus, undefined);

  const legacy = domain.normalizeData({ items: [{ id: "legacy", task: "旧记忆任务", startDate: "2026-07-01", completed: [true] }] });
  assert.equal(legacy.tasks[0].type, "memory");
  assert.deepEqual(legacy.tasks[0].completed, [true, false, false, false, false]);
  assert.deepEqual(legacy.tasks[0].reviewDates, ["2026-07-02", "2026-07-03", "2026-07-05", "2026-07-08", "2026-07-16"]);
});

test("旧长期任务和旧专注记录补齐安全默认值", () => {
  const migrated = domain.normalizeData({
    version: 1,
    tasks: [ongoingTask({ ongoingStatus: undefined, ongoingStatusUpdatedAt: undefined })],
    sessions: [{ id: "old-session", taskId: "ongoing-1", startedAt: "2026-07-20T01:00:00.000Z", endedAt: "2026-07-20T01:10:00.000Z", durationSec: "600" }],
  });
  assert.equal(migrated.tasks[0].ongoingStatus, "active");
  assert.equal(migrated.tasks[0].ongoingStatusUpdatedAt, migrated.tasks[0].createdAt);
  assert.equal(migrated.sessions[0].durationSec, 600);
  assert.equal(migrated.sessions[0].updatedAt, "2026-07-20T01:10:00.000Z");
  assert.equal(migrated.sessions[0].status, "completed");
});

test("普通任务逾期日期边界准确", () => {
  const exactEnd = new Date(2026, 6, 20, 10, 0, 0, 0);
  const afterEnd = new Date(2026, 6, 20, 10, 0, 0, 1);
  const timed = normalTask({ endTime: "10:00" });
  assert.equal(domain.normalTaskStatus(timed, exactEnd), "today");
  assert.equal(domain.normalTaskStatus(timed, afterEnd), "overdue");
  assert.equal(domain.normalTaskOverdueLabel(timed, afterEnd), "已过结束时间");
  assert.equal(domain.normalTaskOverdueLabel(normalTask({ startDate: "2026-07-18" }), exactEnd), "已逾期 2 天");
  assert.equal(domain.normalTaskStatus(normalTask({ normalCompleted: true, startDate: "2026-07-01" }), exactEnd), "done");
});

test("长期任务目标日只提示，不逾期或自动结束", () => {
  const task = ongoingTask({ targetDate: "2026-07-20" });
  assert.equal(domain.ongoingTargetReached(task, "2026-07-19"), false);
  assert.equal(domain.ongoingTargetReached(task, "2026-07-20"), true);
  assert.equal(domain.normalTaskStatus(task, new Date(2026, 6, 25, 12)), "future");
  assert.equal(domain.taskListState(task), "active");
});

test("长期任务暂停、恢复和结束状态正确控制专注", () => {
  const active = ongoingTask();
  const paused = ongoingTask({ ongoingStatus: "paused" });
  const completed = ongoingTask({ ongoingStatus: "completed" });
  assert.equal(domain.isTaskAvailableForFocus(active), true);
  assert.equal(domain.isTaskAvailableForFocus(paused), false);
  assert.equal(domain.isTaskAvailableForFocus(completed), false);
  assert.equal(domain.taskListState(paused), "paused");
  assert.equal(domain.taskListState(completed), "done");
  assert.equal(domain.countActiveTasks([active, paused, completed, normalTask()]), 2);
});

test("长期任务归档可撤销，危险操作使用应用内确认", () => {
  assert.match(studySource, /status === "completed"[\s\S]{0,160}>取消归档<\/button>/);
  assert.match(studySource, /已完成 \/ 归档/);
  assert.match(studySource, /role="alertdialog"/);
  assert.match(studySource, /确认结束并归档/);
  assert.match(studySource, /确认删除/);
  assert.doesNotMatch(studySource, /window\.confirm\(`确定结束长期任务/);
  assert.doesNotMatch(studySource, /window\.confirm\(`确定删除/);
});

test("日历页只显示日历自身的新建任务入口", () => {
  assert.match(studySource, /\{tab !== "calendar" && <button className="primary"/);
  assert.match(calendarSource, /className=\{styles\.addTaskButton\}/);
});

test("跨设备合并采用较新的任务状态并保留两端专注记录", () => {
  const local = domain.normalizeData({
    version: 1, tasks: [ongoingTask({ updatedAt: "2026-07-20T02:00:00.000Z" })],
    sessions: [{ id: "focus-a", taskId: "ongoing-1", startedAt: "2026-07-20T01:00:00.000Z", endedAt: "2026-07-20T01:10:00.000Z", durationSec: 600, status: "completed", updatedAt: "2026-07-20T01:10:00.000Z" }],
  });
  const remote = domain.normalizeData({
    version: 1, tasks: [ongoingTask({ ongoingStatus: "paused", updatedAt: "2026-07-20T03:00:00.000Z", ongoingStatusUpdatedAt: "2026-07-20T03:00:00.000Z" })],
    sessions: [{ id: "focus-b", taskId: "ongoing-1", startedAt: "2026-07-20T02:00:00.000Z", endedAt: "2026-07-20T02:05:00.000Z", durationSec: 300, status: "completed", updatedAt: "2026-07-20T02:05:00.000Z" }],
  });
  const merged = domain.mergeData(local, remote);
  assert.equal(merged.tasks[0].ongoingStatus, "paused");
  assert.deepEqual(new Set(merged.sessions.map((session) => session.id)), new Set(["focus-a", "focus-b"]));
  assert.equal(domain.focusSecondsByTask(merged.sessions).get("ongoing-1"), 900);
});

test("删除墓碑不会在跨设备合并时复活旧任务", () => {
  const local = domain.normalizeData({ version: 1, tasks: [], deletedTasks: [{ id: "normal-1", deletedAt: "2026-07-20T03:00:00.000Z" }] });
  const remote = domain.normalizeData({ version: 1, tasks: [normalTask({ updatedAt: "2026-07-20T02:00:00.000Z" })] });
  assert.equal(domain.mergeData(local, remote).tasks.length, 0);
});

test("自动计时记录包含设备维度，避免跨设备覆盖", () => {
  const first = domain.automaticSessionId("app", "2026-07-20", "com.course", "phone-a");
  const second = domain.automaticSessionId("app", "2026-07-20", "com.course", "phone-b");
  assert.notEqual(first, second);
  assert.match(first, /^app_2026-07-20_com\.course_phone-a$/);
});

test("日历长期任务只声明开始和目标里程碑", () => {
  assert.match(studySource, /milestone: "ongoing-start"/);
  assert.match(studySource, /milestone: "ongoing-target"/);
  assert.match(calendarSource, /if \(task\.milestone\) return/);
  assert.match(calendarSource, /不会生成每日待办/);
});

test("移动端关键布局在窄屏下收敛为单列", () => {
  assert.match(globalCss, /@media \(max-width: 780px\)/);
  assert.match(globalCss, /\.task-grid, \.focus-layout \{ @apply grid-cols-1; \}/);
  assert.match(globalCss, /\.ongoing-item \{ grid-template-columns: 1fr; \}/);
  assert.match(globalCss, /\.task-type-switch \{ grid-template-columns: 1fr; \}/);
  assert.match(globalCss, /\.subfilters \{ @apply flex-nowrap overflow-x-auto/);
  assert.match(calendarCss, /@media\(max-width:760px\)/);
  assert.match(calendarCss, /\.taskDetail\{width:100%/);
});
