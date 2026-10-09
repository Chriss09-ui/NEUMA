import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InputError } from "../src/requirements/core.mjs";
import { createProjectAddError, ProjectFailureStore, safeDiagnosticText } from "../src/projects/project-diagnostics.mjs";

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "neuma-failure-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { dataDir, store: new ProjectFailureStore({ dataDir }) };
}

test("失败原因保留阶段和重连次数，脱敏凭据且不重复添加提示", () => {
  const error = createProjectAddError({ stage: "validation", reason: "unsupported_launcher", retries: 5,
    message: "添加失败：启动脚本未确认。项目未加入列表。" });
  assert.ok(error instanceof InputError);
  assert.equal(error.message, "添加失败：启动脚本未确认。项目未加入列表。");
  assert.equal(error.code, "PROJECT_ADD_FAILED");
  assert.deepEqual(error.diagnostic, { stage: "validation", reason: "unsupported_launcher", retries: 5 });
  const safe = safeDiagnosticText('Bearer bearer-secret API_KEY="api-secret" token=token-secret password=password-secret ACCESS_PASS=access-secret https://user:pass@example.test?a=1&access_token=url-secret');
  for (const secret of ["bearer-secret", "api-secret", "token-secret", "password-secret", "access-secret", "user:pass", "url-secret"]) assert.equal(safe.includes(secret), false);
  assert.doesNotMatch(safeDiagnosticText("postgres://user:db-secret@localhost/test\npassword=long secret with spaces"), /user:db-secret|long secret|with spaces/);
  assert.ok(safeDiagnosticText("x".repeat(5000)).length <= 1000);
});

test("失败记录独立保存，未知异常不写原始内容，文件权限仅本人可读写", async (t) => {
  const { dataDir, store } = await fixture(t);
  assert.deepEqual(await store.list(), []);
  const safe = await store.record({ name: "测试项目", path: "/demo/project", error: createProjectAddError({ stage: "inspection", reason: "missing_plan", message: "未能确认启动入口" }) });
  await store.record({ name: "另一个项目", path: "/demo/other", error: new Error("raw-sdk-response-secret") });
  const records = await new ProjectFailureStore({ dataDir }).list();
  assert.equal(records.length, 2); assert.equal(records[1].id, safe.id);
  assert.match(records[1].message, /未能确认启动入口/);
  const source = await readFile(join(dataDir, "project-add-failures.json"), "utf8");
  assert.doesNotMatch(source, /raw-sdk-response-secret|stack/);
  assert.equal((await stat(join(dataDir, "project-add-failures.json"))).mode & 0o777, 0o600);
  await assert.rejects(readFile(join(dataDir, "projects.json")), { code: "ENOENT" });
});

test("并发写入不会丢失记录，只保留最近五十条", async (t) => {
  const { store } = await fixture(t);
  await Promise.all(Array.from({ length: 52 }, (_, index) => store.record({ name: `项目${index}`, path: `/demo/${index}`, error: new InputError("项目路径不存在") })));
  const records = await store.list({ limit: 50 });
  assert.equal(records.length, 50); assert.equal(new Set(records.map((record) => record.id)).size, 50);
  assert.equal(records[0].name, "项目51"); assert.equal(records.at(-1).name, "项目2");
  assert.equal((await store.list()).length, 10);
});

test("损坏的失败记录明确报错并保留原文件", async (t) => {
  const { dataDir, store } = await fixture(t), file = join(dataDir, "project-add-failures.json");
  await writeFile(file, "broken history");
  await assert.rejects(store.list(), /失败记录已损坏/);
  await assert.rejects(store.record({ name: "项目", path: "/demo", error: new InputError("无效入口") }), /失败记录已损坏/);
  assert.equal(await readFile(file, "utf8"), "broken history");
});
