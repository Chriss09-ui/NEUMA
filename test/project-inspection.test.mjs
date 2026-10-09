import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectReader, validateProjectPlan } from "../src/projects/project-inspection.mjs";
import { ProjectManager } from "../src/projects/projects.mjs";
import { createProjectAnalyzer } from "../src/runtime/pi-runtime.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuma-inspection-")));
  const app = join(root, "app"); await mkdir(app);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, app, project: { path: app, root: app, name: "fixture", kind: "other" } };
}

test("项目检查可读说明和入口，隔离凭据、隐藏文件、二进制及越界链接", async (t) => {
  const { root, app } = await fixture(t);
  await writeFile(join(app, "README.md"), "# demo\napi_key = fixture-secret\n启动 npm run dev");
  await writeFile(join(app, ".env"), "PRIVATE=fixture-only");
  await writeFile(join(root, "outside.md"), "outside-marker");
  await symlink(join(root, "outside.md"), join(app, "outside.md"));
  await symlink(join(app, ".env"), join(app, "alias.md"));
  await writeFile(join(app, "yarn.lock"), "fixture");
  await writeFile(join(app, "credentials.json"), "{}");
  await writeFile(join(app, "binary.md"), "\0binary");
  const reader = createProjectReader(app);
  const listing = await reader.list();
  assert.ok(listing.files.some((file) => file.name === "yarn.lock"));
  assert.equal(listing.files.some((file) => [".env", "credentials.json"].includes(file.name)), false);
  const result = await reader.read("README.md");
  assert.match(result.text, /npm run dev/); assert.equal(result.text.includes("fixture-secret"), false);
  for (const file of [".env", "credentials.json", "../outside.md", "outside.md", "alias.md", "binary.md"]) await assert.rejects(reader.read(file));
  assert.equal(reader.readFiles.size, 1);
});

test("启动方案使用真实脚本、正确子目录和包管理器，拒绝虚构脚本及命令注入", async (t) => {
  const { app, project } = await fixture(t);
  await mkdir(join(app, "frontend"));
  await writeFile(join(app, "frontend", "package.json"), JSON.stringify({ scripts: { dev: "vite" }, packageManager: "pnpm@10.0.0" }));
  const plan = { status: "ready", summary: "已识别前端开发入口。", directory: "frontend", command: "pnpm", args: ["run", "dev"] };
  const result = await validateProjectPlan(project, plan);
  assert.equal(result.root, join(app, "frontend")); assert.deepEqual(result.launch.args, ["run", "dev"]);
  assert.equal(result.kind, "node");
  for (const change of [{ args: ["run", "missing"] }, { args: ["install"] }, { command: "node", args: ["-e", "process.exit()"] },
    { command: "sh", args: ["-c", "echo nope"] }, { directory: ".." }, { url: "https://example.com" }, { url: "http://localhost:3002/?token=x" }]) {
    await assert.rejects(validateProjectPlan(project, { ...plan, ...change }));
  }
});

test("识别静态网页和 Python 模块入口，缺口结果不生成可执行配置", async (t) => {
  const { app, project } = await fixture(t);
  await writeFile(join(app, "index.html"), "<h1>demo</h1>");
  await writeFile(join(app, "dashboard.py"), "import streamlit");
  assert.equal((await validateProjectPlan(project, { status: "ready", summary: "静态网页", kind: "web" })).entry, "index.html");
  const result = await validateProjectPlan(project, { status: "ready", summary: "Streamlit 页面", command: "python3", args: ["-m", "streamlit", "run", "dashboard.py"] });
  assert.equal(result.kind, "python");
  await assert.rejects(validateProjectPlan(project, { status: "ready", summary: "入口", command: "python3", args: ["-m", "streamlit", "run", "missing.py"] }));
  assert.deepEqual(await validateProjectPlan(project, { status: "needs_input", summary: "目录下有两个应用，你想打开哪一个？" }),
    { setup: { status: "needs_input", source: "pi", summary: "目录下有两个应用，你想打开哪一个？" } });
});

function fakeAnalyzer(action) {
  return createProjectAnalyzer({ config: { llmConfigured: true, llmTimeoutMs: 2000 }, dataDir: tmpdir(),
    sessionFactory: async ({ customTools }) => {
      const tools = Object.fromEntries(customTools.map((tool) => [tool.name, async (args) => tool.execute("fixture", args)]));
      return { subscribe: () => () => {}, prompt: () => action(tools), abort() {}, dispose() {} };
    } });
}

test("路径添加自动调用 PI，读文件后持久化配置，无需手填或再次启用，并可实际预览", async (t) => {
  const { root, app } = await fixture(t);
  await writeFile(join(app, "index.html"), "<h1>自动配置</h1>");
  let calls = 0;
  const manager = new ProjectManager({ dataDir: join(root, "data"), openBrowser: async () => {}, analyzeProject: fakeAnalyzer(async (tools) => {
    calls++;
    await assert.rejects(tools.submit_launch_plan({ status: "ready", kind: "web", summary: "未读取" }), /先读取/);
    await tools.list_project_files({});
    await tools.read_project_file({ file: "index.html" });
    await tools.submit_launch_plan({ status: "ready", kind: "web", entry: "index.html", summary: "已找到网页入口，可以直接预览。" });
  }) });
  t.after(() => manager.dispose());
  const progress = [];
  const project = await manager.add({ path: app }, { onProgress: (event) => progress.push(event) });
  assert.equal(project.canLaunch, true); assert.equal(project.allowLaunch, true); assert.equal(project.setup.source, "pi");
  assert.equal(progress[0].label, "NUEMA 正在识别项目…");
  assert.equal((await manager.add({ path: app })).id, project.id); assert.equal(calls, 1);
  const persisted = JSON.parse(await readFile(join(root, "data", "projects.json"), "utf8"));
  assert.equal(persisted.projects[0].setup.status, "ready");
  const running = await manager.start(project.id);
  assert.match(await (await fetch(running.url)).text(), /自动配置/);
});

test("重新识别读取更新后的启动脚本，原记录更新且不会自动启动", async (t) => {
  const { root, app } = await fixture(t);
  const manifest = join(app, "package.json");
  await writeFile(manifest, JSON.stringify({ scripts: { start: "node old.js" } }));
  let calls = 0;
  const manager = new ProjectManager({ dataDir: join(root, "data"), analyzeProject: fakeAnalyzer(async (tools) => {
    calls++;
    const result = await tools.read_project_file({ file: "package.json" });
    const { text } = JSON.parse(result.content[0].text);
    const script = Object.keys(JSON.parse(text).scripts)[0];
    await tools.submit_launch_plan({ status: "ready", summary: "NUEMA 已读取当前入口。", command: "npm", args: ["run", script] });
  }) });
  t.after(() => manager.dispose());
  const initial = await manager.add({ path: app });
  assert.deepEqual(initial.launch.args, ["run", "start"]);
  await writeFile(manifest, JSON.stringify({ scripts: { dev: "node new.js" } }));
  const updated = await manager.inspect(initial.id);
  assert.deepEqual(updated.launch.args, ["run", "dev"]); assert.equal(updated.id, initial.id);
  assert.equal(updated.canLaunch, true); assert.equal(updated.status, "stopped");
  assert.equal(calls, 2); assert.equal(manager.runs.size, 0);
  assert.equal((await manager.list()).length, 1);
  const persisted = JSON.parse(await readFile(join(root, "data", "projects.json"), "utf8"));
  assert.deepEqual(persisted.projects[0].launch.args, ["run", "dev"]);
});

test("旧项目可以自动识别；并发检查合并，运行时不可重配，用户配置不被重复添加覆盖", async (t) => {
  const { root, app } = await fixture(t);
  await writeFile(join(app, "index.html"), "fixture");
  const manager = new ProjectManager({ dataDir: join(root, "data"), openBrowser: async () => {} });
  t.after(() => manager.dispose());
  const project = await manager.add({ path: app });
  let release, entered;
  const ready = new Promise((done) => { entered = done; });
  manager.analyzeProject = async () => { entered(); await new Promise((done) => { release = done; }); return { setup: { status: "ready", summary: "已配置" } }; };
  const first = manager.inspect(project.id); await ready;
  assert.equal((await manager.list())[0].setup.status, "checking");
  await assert.rejects(manager.configure(project.id, { allowLaunch: true }), /正在识别/);
  const second = manager.inspect(project.id);
  release();
  assert.equal((await first).canLaunch, true); assert.equal((await second).id, project.id);
  await manager.configure(project.id, { allowLaunch: true });
  assert.equal((await manager.add({ path: app })).setup.source, "manual");
  await manager.start(project.id); await assert.rejects(manager.inspect(project.id), /先停止/);
});

test("新项目检查期间不进列表或磁盘，成功后只登记一次且不阻塞其他项目操作", { timeout: 2000 }, async (t) => {
  const { root, app } = await fixture(t);
  await writeFile(join(app, "index.html"), "fixture");
  const other = join(root, "other"); await mkdir(other); await writeFile(join(other, "index.html"), "existing");
  const alias = join(root, "alias"); await symlink(app, alias);
  const manager = new ProjectManager({ dataDir: join(root, "data") });
  t.after(() => manager.dispose());
  const existing = await manager.add({ path: other });
  let started, finish, calls = 0;
  const ready = new Promise((done) => { started = done; });
  manager.analyzeProject = async () => {
    calls++; started(); await new Promise((done) => { finish = done; });
    return { setup: { status: "ready", summary: "已配置" } };
  };
  const first = manager.add({ path: app }, { onProgress() {} }); await ready;
  const duplicate = manager.add({ path: alias }, { onProgress() {} });
  while (manager.pendingAdds.get(app).listeners.size < 2) await new Promise((done) => setTimeout(done, 1));
  assert.deepEqual((await manager.list()).map((item) => item.id), [existing.id]);
  const before = JSON.parse(await readFile(join(root, "data", "projects.json"), "utf8"));
  assert.deepEqual(before.projects.map((item) => item.id), [existing.id]);
  assert.equal(manager.runs.size, 0);
  await manager.configure(existing.id, { allowLaunch: true });
  finish();
  const [project, repeated] = await Promise.all([first, duplicate]);
  assert.equal(calls, 1); assert.equal(project.id, repeated.id); assert.equal(project.canLaunch, true);
  assert.equal(manager.pendingAdds.size, 0); assert.equal((await manager.list()).length, 2);
  const persisted = JSON.parse(await readFile(join(root, "data", "projects.json"), "utf8"));
  assert.equal(persisted.projects.filter((item) => item.path === app).length, 1);
});

test("新项目失败、缺少方案和接口异常都不登记，提示安全且之后可重新添加", async (t) => {
  const { root, app } = await fixture(t);
  await writeFile(join(app, "index.html"), "source-is-untouched");
  const cases = [
    { setup: { status: "failed", summary: "模型接口连接中断", reason: "api_error" } },
    { setup: { status: "needs_input", summary: "缺少入口" } },
    new Error("private-provider-error"),
  ];
  for (const [index, failure] of cases.entries()) {
    let calls = 0;
    const dataDir = join(root, `data-${index}`);
    const manager = new ProjectManager({ dataDir, analyzeProject: async () => {
      calls++;
      if (failure instanceof Error) throw failure;
      return failure;
    } });
    t.after(() => manager.dispose());
    await assert.rejects(manager.add({ path: app }), (error) => {
      assert.equal(error.code, "PROJECT_ADD_FAILED");
      assert.equal(error.reason, failure.setup?.reason || failure.setup?.status || "inspection_failed");
      assert.match(error.message, /添加失败：.*项目未加入列表/);
      if (failure.setup) assert.ok(error.message.includes(failure.setup.summary));
      assert.doesNotMatch(error.message, /private-provider-error/);
      return true;
    });
    assert.equal((await manager.list()).length, 0); assert.equal(manager.pendingAdds.size, 0);
    assert.equal(manager.runs.size, 0);
    const failures = await manager.failures();
    assert.equal(failures.length, 1); assert.equal(failures[0].path, app);
    assert.doesNotMatch(JSON.stringify(failures), /private-provider-error/);
    await assert.rejects(readFile(join(dataDir, "projects.json")), { code: "ENOENT" });
    manager.analyzeProject = async () => { calls++; return { setup: { status: "ready", summary: "已配置" } }; };
    assert.equal((await manager.add({ path: app })).canLaunch, true); assert.equal(calls, 2);
    assert.equal((await manager.list()).length, 1);
  }
  assert.equal(await readFile(join(app, "index.html"), "utf8"), "source-is-untouched");
});

test("新项目取消或关闭管理器会停止检查且不落入登记", async (t) => {
  const { root, app } = await fixture(t);
  for (const action of ["cancel", "dispose"]) {
    let started, aborted = false;
    const ready = new Promise((done) => { started = done; });
    const dataDir = join(root, action);
    const manager = new ProjectManager({ dataDir, analyzeProject: async (_project, { signal }) => {
      started(); await new Promise((done) => signal.addEventListener("abort", done, { once: true }));
      aborted = true;
      return { setup: { status: "ready", summary: "迟到的结果" } };
    } });
    const controller = new AbortController();
    const pending = manager.add({ path: app }, { signal: controller.signal });
    const rejected = assert.rejects(pending, (error) => error.name === "AbortError");
    await ready;
    if (action === "cancel") controller.abort();
    await manager.dispose(); await rejected;
    assert.equal(aborted, true); assert.equal((await manager.list()).length, 0); assert.equal(manager.pendingAdds.size, 0);
    await assert.rejects(readFile(join(dataDir, "projects.json")), { code: "ENOENT" });
  }
});

test("新项目路径或登记写入失败同样返回添加失败，不保留临时记录", async (t) => {
  const { root, app } = await fixture(t);
  await writeFile(join(app, "index.html"), "fixture");
  const pathFailure = new ProjectManager({ dataDir: join(root, "path-diagnostics"), analyzeProject: async () => {} });
  t.after(() => pathFailure.dispose());
  await assert.rejects(pathFailure.add({ path: join(root, "missing") }), (error) => {
    assert.equal(error.code, "PROJECT_ADD_FAILED"); assert.match(error.message, /路径不存在/); return true;
  });
  const dataDir = join(root, "data");
  const manager = new ProjectManager({ dataDir, analyzeProject: async () => {
    await writeFile(dataDir, "storage-unavailable");
    return { setup: { status: "ready", summary: "已配置" } };
  } });
  t.after(() => manager.dispose());
  await assert.rejects(manager.add({ path: app }), (error) => {
    assert.equal(error.code, "PROJECT_ADD_FAILED"); assert.equal(error.diagnostic.stage, "save");
    assert.equal(error.diagnostic.recorded, false); return true;
  });
  assert.equal((await manager.list()).length, 0); assert.equal(manager.pendingAdds.size, 0);
});

test("已有项目重新检查失败保留登记，不留下永久检查状态", async (t) => {
  const { root, app } = await fixture(t);
  let started;
  const ready = new Promise((done) => { started = done; });
  const manager = new ProjectManager({ dataDir: join(root, "data") });
  t.after(() => manager.dispose());
  const project = await manager.add({ path: app });
  manager.analyzeProject = async (_project, { signal }) => {
    started(); await new Promise((done) => signal.addEventListener("abort", done, { once: true })); signal.throwIfAborted();
  };
  const controller = new AbortController();
  const pending = manager.inspect(project.id, { signal: controller.signal }); await ready;
  controller.abort(); const result = await pending;
  assert.equal(result.setup.status, "failed"); assert.equal(result.canLaunch, false); assert.match(result.setup.summary, /已停止/);
  manager.analyzeProject = async () => { throw new Error("private-provider-key"); };
  const retried = await manager.inspect(result.id);
  assert.equal(retried.setup.summary.includes("private-provider-key"), false);
  assert.equal((await manager.list()).length, 1); assert.equal(manager.inspections.size, 0);
});

test("PI 只描述没有提交方案时不算完成；模型未连接返回具体缺口", async (t) => {
  const { project } = await fixture(t);
  await assert.rejects(fakeAnalyzer(async () => {})(project), /尚未确认/);
  const analyze = createProjectAnalyzer({ config: { llmConfigured: false } });
  await assert.rejects(analyze(project), /先在设置中连接模型/);
});

test("模型第一次只给文字结论时自动要求提交方案，保持同次检查和已有文件上下文", async (t) => {
  const { app, project } = await fixture(t);
  await writeFile(join(app, "index.html"), "<p>fixture</p>");
  let prompts = 0, disposed = false;
  const analyze = createProjectAnalyzer({ config: { llmConfigured: true }, sessionFactory: async ({ customTools }) => ({
    subscribe: () => () => {}, abort() {}, dispose() { disposed = true; },
    async prompt(message) {
      prompts++;
      if (prompts === 1) await customTools.find((tool) => tool.name === "read_project_file").execute("read", { file: "index.html" });
      else {
        assert.match(message, /还没有.*提交/);
        await customTools.find((tool) => tool.name === "submit_launch_plan").execute("save", { status: "ready", kind: "web", summary: "已找到网页入口。" });
      }
    },
  }) });
  const result = await analyze(project);
  assert.equal(result.setup.status, "ready"); assert.equal(prompts, 2); assert.equal(disposed, true);
});

test("超过原来的文件大小、累计读取量和目录数量仍能分页读完", async (t) => {
  const { app, project } = await fixture(t);
  const content = "这是较长的项目说明。\n".repeat(18_000);
  await writeFile(join(app, "README.md"), content);
  await Promise.all(Array.from({ length: 130 }, (_, index) => writeFile(join(app, `file-${index}.md`), "fixture")));
  const reader = createProjectReader(app);
  let offset = 0, text = "", pages = 0;
  do {
    const result = await reader.read("README.md", offset);
    text += result.text; offset = result.nextOffset; pages++;
  } while (offset !== null);
  assert.equal(text, content); assert.ok(pages > 4);
  const first = await reader.list(); const second = await reader.list(".", first.nextOffset);
  assert.equal(first.files.length + second.files.length, 131); assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.files, ...second.files].map((file) => file.name)).size, 131);
  await writeFile(join(app, "package.json"), JSON.stringify({ description: "x".repeat(140_000), scripts: { start: "node app.mjs" } }));
  const plan = await validateProjectPlan(project, { status: "ready", summary: "已识别启动脚本", command: "npm", args: ["run", "start"] });
  assert.deepEqual(plan.launch.args, ["run", "start"]);
});

test("项目检查不设置执行计时器，持续读取直到模型完成", async (t) => {
  const { app, project } = await fixture(t);
  await writeFile(join(app, "index.html"), "<p>fixture</p>");
  const timer = t.mock.method(globalThis, "setTimeout", () => ({ unref() {} }));
  let ready, finish, aborts = 0, disposed = 0, reads = 0;
  const started = new Promise((done) => { ready = done; });
  const analyze = createProjectAnalyzer({ config: { llmConfigured: true, llmTimeoutMs: 1 }, sessionFactory: async ({ customTools }) => {
    const read = customTools.find((tool) => tool.name === "read_project_file");
    const submit = customTools.find((tool) => tool.name === "submit_launch_plan");
    return {
      abort: async () => { aborts++; finish?.(); }, dispose() { disposed++; },
      async prompt() {
        for (let index = 0; index < 25; index++) { await read.execute(`read-${index}`, { file: "index.html" }); reads++; }
        const waiting = new Promise((done) => { finish = done; }); ready(); await waiting;
        await submit.execute("save", { status: "ready", kind: "web", summary: "已找到网页入口。" });
      },
    };
  } });
  t.after(() => finish?.());
  const pending = analyze(project); await started;
  assert.equal(timer.mock.calls.length, 0); assert.equal(aborts, 0); assert.equal(reads, 25);
  finish();
  assert.equal((await pending).setup.status, "ready"); assert.equal(disposed, 1);
});

test("主动取消会终止并释放 PI 检查", async (t) => {
  const { project } = await fixture(t);
  let ready, finish, disposed = false;
  const started = new Promise((done) => { ready = done; });
  const analyze = createProjectAnalyzer({ config: { llmConfigured: true }, sessionFactory: async () => ({
    prompt: async () => { const waiting = new Promise((done) => { finish = done; }); ready(); await waiting; },
    abort: async () => { finish(); }, dispose: () => { disposed = true; },
  }) });
  const controller = new AbortController();
  const pending = analyze(project, { signal: controller.signal });
  const rejected = assert.rejects(pending, (error) => error.name === "AbortError");
  await started; controller.abort(); await rejected;
  assert.equal(disposed, true);
});

test("API 重连耗尽结束检查，不另发提示重启模型或泄露接口错误", async (t) => {
  const { project } = await fixture(t);
  let listener, prompts = 0;
  const progress = [];
  const analyze = createProjectAnalyzer({ config: { llmConfigured: true }, sessionFactory: async () => ({
    messages: [{ role: "assistant", stopReason: "error" }], dispose() {}, abort() {},
    subscribe(fn) { listener = fn; return () => {}; },
    async prompt() {
      prompts++;
      for (let attempt = 1; attempt <= 5; attempt++) listener({ type: "auto_retry_start", attempt, errorMessage: "private-api-payload" });
      listener({ type: "auto_retry_end", attempt: 5, success: false, finalError: "private-api-payload" });
    },
  }) });
  const result = await analyze(project, { onProgress: (event) => progress.push(event) });
  assert.equal(result.setup.reason, "api_error"); assert.equal(result.setup.status, "failed");
  assert.match(result.setup.summary, /重连 5 次/); assert.equal(prompts, 1);
  assert.equal(progress.filter((event) => event.label?.includes("重连")).length, 5);
  assert.doesNotMatch(JSON.stringify({ result, progress }), /private-api-payload/);
});
