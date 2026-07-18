import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("contains the interactive calendar, study experience, and deployable output", async () => {
  const [studyApp, calendar, layout, manifest] = await Promise.all([
    readFile(new URL("app/StudyApp.tsx", root), "utf8"),
    readFile(new URL("app/CalendarApp.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("public/manifest.webmanifest", root), "utf8"),
  ]);
  assert.match(layout, /循记 · 艾宾浩斯学习助手/);
  assert.match(studyApp, /"today" \| "calendar" \| "tasks"/);
  assert.match(studyApp, /<CalendarApp/);
  assert.match(studyApp, /type: "normal" \| "memory"/);
  assert.match(studyApp, /task-type-switch/);
  assert.match(calendar, /type ViewMode = "day" \| "threeDay" \| "week" \| "month"/);
  assert.match(calendar, /onRescheduleTask/);
  assert.match(calendar, /useTouchTaskDrag/);
  assert.match(calendar, /data-calendar-drop-date/);
  assert.match(calendar, /onDrop=\{\(event\) => dropOnDay/);
  assert.match(calendar, /点击空白时间快速新建/);
  assert.match(calendar, /第.*轮复习/);
  assert.match(calendar, /移动到该日/);
  assert.match(studyApp, /INTERVALS = \[1, 2, 4, 7, 15\]/);
  assert.doesNotMatch(calendar + layout, /codex-preview|Your site is taking shape|react-loading-skeleton/);
  assert.equal(JSON.parse(manifest).display, "standalone");
  await access(new URL("dist/server/index.js", root));
  await access(new URL("drizzle/0000_foamy_black_tarantula.sql", root));
});
