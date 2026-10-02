import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager } from "../projects.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "neuma-projects-test-"));
  const app = join(root, "app"); await mkdir(app);
  const manager = new ProjectManager({ dataDir: join(root, "data") });
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, app, manager };
}
async function waitFor(action) {
  for (let attempt = 0; attempt < 70; attempt++) { if (await action()) return; await new Promise((done) => setTimeout(done, 100)); }
  assert.fail("等待真实项目状态超时");
}

test("登记原项目、识别类型、规范化路径去重并在重启后恢复", async (t) => {
  const { root, app, manager } = await fixture(t);
  await writeFile(join(app, "package.json"), JSON.stringify({ scripts: { start: "node main.mjs" } }));
  const [first, duplicate] = await Promise.all([manager.add({ path: app, description: "本地工具" }), manager.add({ path: app })]);
  assert.equal(first.id, duplicate.id); assert.equal(first.kind, "node"); assert.equal(first.allowLaunch, false);
  assert.deepEqual(first.launch.args, ["run", "start"]);
  const alias = join(root, "alias"); await symlink(app, alias);
  assert.equal((await manager.add({ path: alias })).id, first.id);
  const restored = new ProjectManager({ dataDir: join(root, "data") });
  assert.equal((await restored.list()).length, 1);
  assert.equal((await restored.list())[0].description, "本地工具");
  assert.equal((await restored.list())[0].status, "stopped");
  await manager.remove(first.id);
  assert.ok(await readFile(join(app, "package.json"), "utf8"));
  assert.equal((await manager.list()).length, 0);
});

test("静态网页需要启用启动方式，预览拒绝隐藏文件和越界符号链接", async (t) => {
  const { root, app, manager } = await fixture(t);
  await writeFile(join(app, "index.html"), "<h1>可用页面</h1>");
  await writeFile(join(app, ".env"), "TEST_VALUE=fixture-only");
  await writeFile(join(root, "outside.js"), "outside-marker");
  await symlink(join(root, "outside.js"), join(app, "leak.js"));
  await mkdir(join(app, ".private")); await writeFile(join(app, ".private", "secret.js"), "private-marker");
  await symlink(join(app, ".private", "secret.js"), join(app, "alias.js"));
  const project = await manager.add({ path: app });
  await assert.rejects(manager.start(project.id), /启用启动方式/);
  await manager.configure(project.id, { allowLaunch: true });
  const [started, repeated] = await Promise.all([manager.start(project.id), manager.start(project.id)]);
  const running = (await manager.list())[0];
  assert.equal(started.status, "running"); assert.equal(repeated.id, started.id);
  assert.match(await (await fetch(running.url)).text(), /可用页面/);
  for (const path of [".env", "leak.js", "alias.js", "%2e%2e/outside.js"]) {
    assert.equal((await fetch(`${running.url}${path}`)).status, 404);
  }
  await manager.stop(project.id);
  assert.equal((await manager.list())[0].status, "stopped");
});

test("Node 项目真实启动、验证页面并停止，子进程不继承 NEUMA 的密钥", async (t) => {
  const { app, manager } = await fixture(t);
  await writeFile(join(app, "package.json"), JSON.stringify({ scripts: { start: "node server.mjs" } }));
  await writeFile(join(app, "server.mjs"), `import { createServer } from 'node:http';
const server=createServer((req,res)=>res.end(JSON.stringify({hasKey:Boolean(process.env.NEUMA_LLM_API_KEY)})));
server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port+'/'));`);
  const previousKey = process.env.NEUMA_LLM_API_KEY;
  process.env.NEUMA_LLM_API_KEY = "fixture-only";
  try {
    const project = await manager.add({ path: app });
    await manager.configure(project.id, { ...project.launch, allowLaunch: true });
    await manager.start(project.id);
    await waitFor(async () => Boolean((await manager.list())[0].url));
    const running = (await manager.list())[0];
    assert.equal((await (await fetch(running.url)).json()).hasKey, false);
    await manager.stop(project.id);
    await waitFor(async () => { try { await fetch(running.url); return false; } catch { return true; } });
    assert.equal((await manager.list())[0].url, null);
  } finally {
    if (previousKey === undefined) delete process.env.NEUMA_LLM_API_KEY; else process.env.NEUMA_LLM_API_KEY = previousKey;
  }
});

test("其他项目可以登记，启动配置拒绝远端地址和目录外可执行程序", async (t) => {
  const { app, manager } = await fixture(t);
  const project = await manager.add({ path: app });
  assert.equal(project.kind, "other");
  await assert.rejects(manager.configure(project.id, { command: "node", args: [], url: "https://example.com", allowLaunch: true }), /本机/);
  await assert.rejects(manager.configure(project.id, { command: "/bin/sh", args: [], allowLaunch: true }), /项目目录/);
  await assert.rejects(manager.add({ path: "relative/path" }), /完整路径/);
});

test("损坏的项目记录报错并保留原文件，不覆盖为一个空列表", async (t) => {
  const { root, manager } = await fixture(t);
  await mkdir(join(root, "data")); await writeFile(join(root, "data", "projects.json"), "broken-json");
  await assert.rejects(manager.list(), /无法读取/);
  assert.equal(await readFile(join(root, "data", "projects.json"), "utf8"), "broken-json");
});
