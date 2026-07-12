import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("contains the complete study experience and deployable output", async () => {
  const [app, layout, manifest] = await Promise.all([
    readFile(new URL("app/StudyApp.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("public/manifest.webmanifest", root), "utf8"),
  ]);
  assert.match(layout, /循记 · 艾宾浩斯学习助手/);
  assert.match(app, /新建任务/);
  assert.match(app, /快速专注/);
  assert.match(app, /设备同步/);
  assert.match(app, /分类投入/);
  assert.match(app, /INTERVALS = \[1, 2, 4, 7, 15\]/);
  assert.doesNotMatch(app + layout, /codex-preview|Your site is taking shape|react-loading-skeleton/);
  assert.equal(JSON.parse(manifest).display, "standalone");
  await access(new URL("dist/server/index.js", root));
  await access(new URL("drizzle/0000_foamy_black_tarantula.sql", root));
});
