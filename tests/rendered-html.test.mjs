import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("contains the calendar views, study experience, and deployable output", async () => {
  const [studyApp, calendar, layout, manifest] = await Promise.all([
    readFile(new URL("app/StudyApp.tsx", root), "utf8"),
    readFile(new URL("app/CalendarApp.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("public/manifest.webmanifest", root), "utf8"),
  ]);
  assert.match(layout, /循记日历/);
  assert.match(calendar, /export function DayView/);
  assert.match(calendar, /export function WeekView/);
  assert.match(calendar, /export function MonthView/);
  assert.match(calendar, /还有.*项复习/);
  assert.match(calendar, /复习清单/);
  assert.match(studyApp, /INTERVALS = \[1, 2, 4, 7, 15\]/);
  assert.doesNotMatch(calendar + layout, /codex-preview|Your site is taking shape|react-loading-skeleton/);
  assert.equal(JSON.parse(manifest).display, "standalone");
  await access(new URL("dist/server/index.js", root));
  await access(new URL("drizzle/0000_foamy_black_tarantula.sql", root));
});
