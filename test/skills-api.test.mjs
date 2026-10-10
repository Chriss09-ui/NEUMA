import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestHandler } from "../src/server.mjs";
import { SkillManager } from "../src/skills/skill-manager.mjs";
import { InputError } from "../src/requirements/core.mjs";

function handler(options = {}) {
  return createRequestHandler({ config: {}, providers: {}, projects: {}, projectAgent: {}, prototypeAgents: {}, ...options });
}

function request(method, url, body, headers = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(stream, { method, url, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers } });
  return stream;
}

class Response extends EventEmitter {
  writableEnded = false;
  text = "";
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  end(content = "") { this.text += content; this.writableEnded = true; }
}

async function invoke(app, method, path, body, headers) {
  const response = new Response();
  await app(request(method, path, body, headers), response);
  return { ...response, json: response.headers?.["content-type"]?.includes("application/json") ? JSON.parse(response.text) : null };
}

test("skill 接口使用独立服务，逐项转发参数且不调用任何 Agent", async () => {
  const calls = [];
  const methods = ["list", "scan", "detail", "save", "sources", "addSource", "removeSource", "previewImport", "importSkill", "previewRemoval", "trashSkill", "listTrash", "restore"];
  const manager = Object.fromEntries(methods.map((method) => [method, async (...args) => {
    calls.push({ method, args }); return ["sources", "addSource", "removeSource", "listTrash"].includes(method) ? [{ id: method }] : { operation: method };
  }]));
  const app = handler({ skillManager: manager,
    projectAgent: { prompt: () => assert.fail("管理 skill 不应使用项目助手") },
    prototypeAgents: { prompt: () => assert.fail("管理 skill 不应使用工作 Agent") } });
  const cases = [
    ["GET", "/api/skills", undefined, "list"],
    ["POST", "/api/skills/scan", {}, "scan"],
    ["GET", "/api/skills/sources", undefined, "sources"],
    ["POST", "/api/skills/sources", { path: "/fixture/skills" }, "addSource"],
    ["POST", "/api/skills/sources/custom-1/remove", {}, "removeSource"],
    ["GET", "/api/skills/skill-1", undefined, "detail"],
    ["POST", "/api/skills/skill-1/save", { content: "---\nname: sample\n---\n", revision: "r1" }, "save"],
    ["POST", "/api/skills/import/preview", { path: "/fixture/sample", targetId: "agents" }, "previewImport"],
    ["POST", "/api/skills/import", { path: "/fixture/sample", targetId: "agents", revision: "r2" }, "importSkill"],
    ["POST", "/api/skills/skill-1/trash/preview", { action: "link", locationId: "alias-1" }, "previewRemoval"],
    ["POST", "/api/skills/skill-1/trash", { confirm: true, action: "link", locationId: "alias-1", revision: "r3" }, "trashSkill"],
    ["GET", "/api/skills/trash", undefined, "listTrash"],
    ["POST", "/api/skills/trash/trash-1/restore", {}, "restore"],
  ];
  for (const [method, path, body, expected] of cases) {
    const result = await invoke(app, method, path, body);
    assert.equal(result.status, 200, path);
    assert.equal(calls.at(-1).method, expected);
    if (["save", "previewRemoval", "trashSkill"].includes(expected)) {
      assert.equal(calls.at(-1).args[0], "skill-1");
      assert.deepEqual(calls.at(-1).args[1], body);
    }
    if (["addSource", "previewImport", "importSkill"].includes(expected)) assert.deepEqual(calls.at(-1).args[0], body);
    if (expected === "removeSource") assert.equal(calls.at(-1).args[0], "custom-1");
    if (["sources", "addSource", "removeSource"].includes(expected)) assert.deepEqual(result.json, { sources: [{ id: expected }] });
    if (expected === "listTrash") assert.deepEqual(result.json, { entries: [{ id: expected }] });
  }
  await app.dispose();
});

test("写入冲突使用 409 且返回稳定错误码，不泄露内部异常", async () => {
  const conflict = new InputError("原文件已经更新，请重新读取"); conflict.code = "SKILL_CONFLICT";
  const app = handler({ skillManager: { save: async () => { throw conflict; }, detail: async () => { throw new Error("private-file-diagnostic"); } } });
  const result = await invoke(app, "POST", "/api/skills/s1/save", { content: "text", revision: "old" });
  assert.equal(result.status, 409);
  assert.equal(result.json.code, "SKILL_CONFLICT");
  const failed = await invoke(app, "GET", "/api/skills/s1");
  assert.equal(failed.status, 500);
  assert.doesNotMatch(failed.text, /private-file-diagnostic/);
  await app.dispose();
});

test("skill 管理继承本机请求保护，回收必须明确确认", async () => {
  const app = handler({ skillManager: { list: () => assert.fail("跨站查询不能进入服务"), trashSkill: () => assert.fail("未确认不能回收") } });
  for (const headers of [
    { host: "127.0.0.1:3000", origin: "https://elsewhere.example" },
    { host: "elsewhere.example:3000" },
    { host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" },
  ]) assert.equal((await invoke(app, "GET", "/api/skills", undefined, headers)).status, 403);
  assert.equal((await invoke(app, "POST", "/api/skills/s1/trash", { revision: "r1" })).status, 400);
  assert.equal((await invoke(app, "POST", "/api/skills/scan")).status, 400);
  assert.equal((await invoke(app, "DELETE", "/api/skills/s1")).status, 404);
  await app.dispose();
});

test("skill 文件夹窗口使用对应提示并传递取消信号", async () => {
  const purposes = [];
  const app = handler({ skillManager: {}, pickSkillFolder: async ({ signal, prompt }) => {
    assert.equal(signal.aborted, false); purposes.push(prompt); return { cancelled: true };
  } });
  for (const purpose of ["source", "import"]) {
    const response = await invoke(app, "POST", "/api/skills/pick-folder", { purpose });
    assert.deepEqual(response.json, { cancelled: true });
  }
  assert.deepEqual(purposes, ["选择要查找 skill 的文件夹", "选择要导入的 skill 文件夹"]);
  assert.equal((await invoke(app, "POST", "/api/skills/pick-folder", { purpose: "invalid" })).status, 400);
  await app.dispose();
});

test("关闭服务等待 skill 管理清理，启动不触发扫描", async () => {
  let closed = false;
  const app = handler({ skillManager: { list: () => assert.fail("健康检查不应扫描"), dispose: async () => { closed = true; } } });
  assert.equal((await invoke(app, "GET", "/api/health")).status, 200);
  await app.dispose();
  assert.equal(closed, true);
  assert.equal((await invoke(app, "GET", "/api/skills")).status, 503);
});

test("Skill 管理页面及其独立模块由静态白名单提供", async () => {
  const app = handler({ skillManager: {} });
  const page = await invoke(app, "GET", "/");
  assert.match(page.text, /href="#skills"[^>]*data-page="skills"/);
  assert.match(page.text, /id="page-skills"/);
  assert.match(page.text, /src="\/skills\.js"/);
  for (const path of ["/skills.js", "/skills-view.js"]) {
    const result = await invoke(app, "GET", path);
    assert.equal(result.status, 200);
    assert.match(result.headers["content-type"], /javascript/);
  }
  assert.equal((await invoke(app, "GET", "/src/skills/skill-manager.mjs")).status, 404);
  await app.dispose();
});

test("真实 skill 接口完成扫描、编辑、导入、回收和恢复，文件操作只在临时目录", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "neuma-skill-api-"));
  const home = join(fixture, "home"), dataDir = join(fixture, "data");
  const original = join(home, ".agents", "skills", "sample");
  const local = join(fixture, "incoming");
  await mkdir(original, { recursive: true }); await mkdir(local);
  const text = (name, body) => `---\nname: ${name}\ndescription: A test skill\n---\n\n${body}\n`;
  await writeFile(join(original, "SKILL.md"), text("sample", "Original"));
  await writeFile(join(local, "SKILL.md"), text("incoming", "Incoming"));
  await writeFile(join(local, "reference.txt"), "Supporting file");
  const manager = new SkillManager({ dataDir, home });
  const app = handler({ skillManager: manager });
  t.after(async () => { await app.dispose(); await rm(fixture, { recursive: true, force: true }); });
  const listing = await invoke(app, "GET", "/api/skills");
  assert.equal(listing.status, 200);
  const sample = listing.json.skills.find((skill) => skill.name === "sample");
  assert.ok(sample);
  const detail = (await invoke(app, "GET", `/api/skills/${sample.id}`)).json;
  const saved = await invoke(app, "POST", `/api/skills/${sample.id}/save`, { content: text("sample", "Updated"), revision: detail.revision });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.match(await readFile(join(original, "SKILL.md"), "utf8"), /Updated/);
  const targetPath = await realpath(join(home, ".agents", "skills"));
  const target = listing.json.sources.find((source) => source.path === targetPath);
  const input = { path: local, targetId: target.id };
  const preview = await invoke(app, "POST", "/api/skills/import/preview", input);
  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  const imported = await invoke(app, "POST", "/api/skills/import", { ...input, revision: preview.json.revision });
  assert.equal(imported.status, 200, JSON.stringify(imported.json));
  assert.equal(await readFile(join(imported.json.baseDir, "reference.txt"), "utf8"), "Supporting file");
  const removal = await invoke(app, "POST", `/api/skills/${sample.id}/trash/preview`, { action: "skill" });
  assert.equal(removal.status, 200, JSON.stringify(removal.json));
  const recycled = await invoke(app, "POST", `/api/skills/${sample.id}/trash`, { confirm: true, revision: removal.json.revision, action: "skill" });
  assert.equal(recycled.status, 200, JSON.stringify(recycled.json));
  await assert.rejects(readFile(join(original, "SKILL.md")), { code: "ENOENT" });
  const trash = await invoke(app, "GET", "/api/skills/trash");
  assert.equal(trash.json.entries.length, 1);
  const restored = await invoke(app, "POST", `/api/skills/trash/${trash.json.entries[0].id}/restore`, {});
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  assert.match(await readFile(join(original, "SKILL.md"), "utf8"), /Updated/);
  assert.match(await readFile(join(local, "SKILL.md"), "utf8"), /Incoming/);
});
