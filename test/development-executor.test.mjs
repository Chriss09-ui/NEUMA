import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, link, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DevelopmentExecutor } from "../development-executor.mjs";
import { inspectDevelopmentCode } from "../development-workspace.mjs";

async function fixture(t, source = "console.log(JSON.stringify({ok:true,values:[42]}));") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuma-executor-test-")));
  const codeDir = join(root, "code"); await mkdir(codeDir); await writeFile(join(codeDir, "main.mjs"), source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { hash, files, path } = await inspectDevelopmentCode(codeDir);
  return { root, codeDir, snapshot: { hash, files, path }, entrypoint: "main.mjs" };
}

function fakeSandbox(runs = []) {
  const calls = [], killed = [];
  let index = 0;
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter(); child.pid = 999000 + calls.length;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    const call = calls.at(-1); call.input = ""; child.stdin.on("data", (data) => { call.input += data.toString("utf8"); });
    const probe = args.at(-1).endsWith("probe.mjs");
    const result = probe ? { stdout: JSON.stringify({ readDenied: true, writeDenied: true, codeWriteDenied: true, hardlinkDenied: true,
      metadataDenied: true, symlinkReadDenied: true, scratchWorked: true, networkDenied: true, subprocessDenied: true }) } : runs[index++] ?? { stdout: '{"ok":true,"values":[42]}' };
    queueMicrotask(() => {
      if (result.hang) return;
      if (result.spawnError) { child.emit("error", new Error("secret transport detail")); return; }
      if (result.stdout) child.stdout.write(result.stdout);
      if (result.stderr) child.stderr.write(result.stderr);
      child.emit("exit", result.exitCode ?? 0, null); child.emit("close", result.exitCode ?? 0, null);
    });
    return child;
  };
  return { calls, killed, executor: new DevelopmentExecutor({ platform: "darwin", spawnImpl,
    killImpl: (pid, signal) => killed.push({ pid, signal }), timeoutMs: 30 }) };
}

test("无隔离的平台明确不执行，不以 cwd 或普通进程代替沙箱", async (t) => {
  const input = await fixture(t);
  const executor = new DevelopmentExecutor({ platform: "linux", spawnImpl: () => assert.fail("不得启动非隔离进程") });
  assert.equal((await executor.probe()).available, false);
  assert.equal((await executor.run({ ...input, input: "hello" })).status, "not_run");
  const report = await executor.verify({ ...input, cases: [{ id: "t1", input: "", assertions: [{ path: "ok", expectedJson: "true" }] }] });
  assert.equal(report.status, "not_run"); assert.equal(report.results[0].status, "not_run");
});

test("每次执行使用系统沙箱、精简环境、代码只读与独立临时工作目录", async (t) => {
  const input = await fixture(t), { executor, calls } = fakeSandbox();
  const run = await executor.run({ ...input, input: "x" });
  assert.equal(run.status, "passed"); assert.deepEqual(run.output, { ok: true, values: [42] });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, "/usr/bin/sandbox-exec"); assert.equal(call.args[0], "-p");
    assert.match(call.args[1], /\(deny default\)/); assert.match(call.args[1], /\(deny network\*\)/);
    assert.equal(call.options.detached, true);
    assert.deepEqual(Object.keys(call.options.env).sort(), ["HOME", "LANG", "LC_ALL", "OPENSSL_CONF", "PATH", "TMPDIR"]);
    assert.equal(call.options.env.HOME, call.options.cwd);
    assert.notEqual(call.options.cwd, input.codeDir);
  }
  assert.equal(calls[1].input, "x");
  assert.ok(calls[1].args.at(-1).endsWith(join("code", "main.mjs")));
  assert.deepEqual(calls[1].options.stdio, ["pipe", "pipe", "pipe"]);
});

test("真实值断言、数组路径和完整 JSON 比较决定验收，不只检查字段名", async (t) => {
  const input = await fixture(t), { executor } = fakeSandbox();
  const cases = [
    { id: "ok", taskId: "task-1", acceptanceId: "a1", input: "1", assertions: [{ path: "ok", expectedJson: "true" }, { path: "values.0", expectedJson: "42" }] },
    { id: "wrong", input: "2", assertions: [{ path: "ok", expectedJson: "false" }] },
    { id: "root", input: "3", assertions: [{ path: "", expectedJson: '{"ok":true,"values":[42]}' }] },
    { id: "inherited", input: "4", assertions: [{ path: "toString", expectedJson: "null" }] },
  ];
  const result = await executor.verify({ ...input, cases });
  assert.equal(result.codeHash, input.snapshot.hash); assert.equal(result.status, "failed");
  assert.deepEqual(result.results.map((item) => item.status), ["passed", "failed", "passed", "failed"]);
  assert.equal(result.results[0].taskId, "task-1");
  assert.deepEqual(result.results[1].actual, { ok: true, values: [42] });
});

test("负例只有匹配规定错误值才通过，崩溃、非法输出和超时不能通过", async (t) => {
  const input = await fixture(t);
  const { executor, killed } = fakeSandbox([{ stdout: '{"error":"missing_input"}' }, { exitCode: 1, stderr: "crash" },
    { stdout: 'log\n{"error":"missing_input"}' }, { hang: true }]);
  const cases = Array.from({ length: 4 }, (_, i) => ({ id: `negative-${i}`, input: "", assertions: [{ path: "error", expectedJson: '"missing_input"' }] }));
  const report = await executor.verify({ ...input, cases });
  assert.deepEqual(report.results.map((item) => item.status), ["passed", "failed", "failed", "error"]);
  assert.equal(report.results[3].reason, "timeout"); assert.equal(report.status, "error");
  assert.ok(killed.some(({ pid, signal }) => pid < 0 && signal === "SIGKILL"));
});

test("取消和输出溢出终止整个进程组且限制收集内容", async (t) => {
  const input = await fixture(t);
  const first = fakeSandbox([{ hang: true }]); await first.executor.probe();
  const controller = new AbortController();
  const running = first.executor.run({ ...input, input: "", signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  const cancelled = await running; assert.equal(cancelled.status, "error"); assert.equal(cancelled.reason, "cancelled");
  assert.ok(first.killed.some(({ pid }) => pid < 0));
  const second = fakeSandbox([{ stdout: "x".repeat(200000) }]);
  const overflow = await second.executor.run({ ...input, input: "" });
  assert.equal(overflow.reason, "output_limit"); assert.ok(Buffer.byteLength(overflow.stdout) <= 128 * 1024);
});

test("用例缺失、无断言、版本变化及危险入口不能伪造成功", async (t) => {
  const input = await fixture(t), { executor, calls } = fakeSandbox();
  assert.equal((await executor.verify({ ...input, cases: [] })).status, "not_run");
  assert.equal((await executor.verify({ ...input, cases: [{ id: "bad", input: "", assertions: [] }] })).status, "error");
  await writeFile(join(input.codeDir, "main.mjs"), "changed");
  assert.equal((await executor.verify({ ...input, cases: [{ id: "t1", input: "", assertions: [{ path: "ok", expectedJson: "true" }] }] })).status, "error");
  assert.equal(calls.length, 0);
  assert.equal((await executor.run({ ...input, entrypoint: "../main.mjs", input: "" })).status, "error");
  assert.equal((await executor.run({ ...input, input: "", workspaceDir: input.codeDir })).status, "error");
});

test("运行层指定工作目录只授予该目录，代码版本保持只读", async (t) => {
  const input = await fixture(t), { executor, calls } = fakeSandbox();
  const workspaceDir = join(input.root, "user-workspace"); await mkdir(workspaceDir);
  assert.equal((await executor.run({ ...input, input: "", workspaceDir })).status, "passed");
  assert.equal(calls.at(-1).options.cwd, await realpath(workspaceDir));
  assert.match(calls.at(-1).args[1], /allow file-read\* file-write\* \(subpath/);
});

test("隔离探测启动失败时绝不退回普通 node，也不公开进程错误细节", async (t) => {
  const input = await fixture(t); let spawned = 0;
  const executor = new DevelopmentExecutor({ platform: "darwin", spawnImpl: (command) => { spawned++; assert.equal(command, "/usr/bin/sandbox-exec"); throw new Error("private secret"); } });
  const probe = await executor.probe(); assert.equal(probe.available, false); assert.doesNotMatch(probe.reason, /private secret/);
  assert.equal((await executor.run({ ...input, input: "" })).status, "not_run"); assert.equal(spawned, 2);
});

test("本机实际隔离探测：仅通过系统边界后执行生成代码", async (t) => {
  const executor = new DevelopmentExecutor();
  const probe = await executor.probe();
  t.diagnostic(JSON.stringify(probe));
  if (!probe.available) { assert.notEqual(process.env.NEUMA_REQUIRE_ISOLATION, "1", probe.reason); assert.equal(probe.available, false); return; }
  const input = await fixture(t);
  const result = await executor.verify({ ...input, cases: [{ id: "real", input: "hello", assertions: [{ path: "values.0", expectedJson: "42" }] }] });
  assert.equal(result.status, "passed", JSON.stringify(result));
});

test("真实隔离运行只写指定用户目录，超时与取消终止正在运行的 Node", async (t) => {
  const executor = new DevelopmentExecutor();
  if (!(await executor.probe()).available) { t.diagnostic("当前宿主隔离不可用，真实执行保持未执行"); return; }
  const input = await fixture(t, "import fs from 'node:fs'; fs.writeFileSync('result.json', JSON.stringify({input:process.argv[2]})); console.log(JSON.stringify({saved:true}));");
  const workspaceDir = join(input.root, "runtime"); await mkdir(workspaceDir);
  const run = await executor.run({ ...input, workspaceDir, input: "hello" });
  assert.equal(run.status, "passed", JSON.stringify(run));
  assert.deepEqual(JSON.parse(await readFile(join(workspaceDir, "result.json"), "utf8")), { input: "hello" });
  await writeFile(join(input.codeDir, "main.mjs"), "setInterval(()=>{},1000);");
  executor.timeoutMs = 80;
  const timeout = await executor.run({ ...input, input: "" });
  assert.equal(timeout.status, "error"); assert.equal(timeout.reason, "timeout");
  executor.timeoutMs = 1000;
  const controller = new AbortController();
  const pending = executor.run({ ...input, input: "", signal: controller.signal });
  setTimeout(() => controller.abort(), 80);
  const cancelled = await pending;
  assert.equal(cancelled.status, "error"); assert.equal(cancelled.reason, "cancelled");
});

test("运行工作目录存在隐藏凭据、符号链接或硬链接时停止授权", async (t) => {
  const input = await fixture(t), { executor, calls } = fakeSandbox();
  const workspaceDir = join(input.root, "runtime"); await mkdir(workspaceDir);
  const outside = join(input.root, "outside.txt"); await writeFile(outside, "private");
  for (const prepare of [() => writeFile(join(workspaceDir, ".env"), "private"),
    () => symlink(outside, join(workspaceDir, "visible.txt")), () => link(outside, join(workspaceDir, "visible.txt"))]) {
    await prepare();
    const result = await executor.run({ ...input, input: "", workspaceDir, workspaceReadOnly: true });
    assert.equal(result.status, "error"); assert.equal(result.reason, "workspace_contains_unsafe_files");
    await rm(workspaceDir, { recursive: true }); await mkdir(workspaceDir);
  }
  assert.equal(calls.length, 1, "只有固定边界探测，不能执行生成代码");
});

test("真实只读工作目录能读取用户材料，但只有独立 scratch 可以写入", async (t) => {
  const executor = new DevelopmentExecutor();
  if (!(await executor.probe()).available) { t.diagnostic("当前宿主隔离不可用，真实执行保持未执行"); return; }
  const source = "import fs from 'node:fs'; import path from 'node:path'; let denied=false; try{fs.writeFileSync('forbidden.txt','bad')}catch(e){denied=['EPERM','EACCES'].includes(e.code)} fs.writeFileSync(path.join(process.env.TMPDIR,'scratch.txt'),'ok'); console.log(JSON.stringify({content:fs.readFileSync('input.txt','utf8'),denied}));";
  const input = await fixture(t, source), workspaceDir = join(input.root, "readonly"); await mkdir(workspaceDir);
  await writeFile(join(workspaceDir, "input.txt"), "user material");
  const result = await executor.run({ ...input, input: "", workspaceDir, workspaceReadOnly: true });
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.deepEqual(result.output, { content: "user material", denied: true });
  await assert.rejects(readFile(join(workspaceDir, "forbidden.txt")), { code: "ENOENT" });
});

test("真实持久状态验收按用例顺序共享新目录，不同验收重新从初始状态开始", async (t) => {
  const executor = new DevelopmentExecutor();
  if (!(await executor.probe()).available) { t.diagnostic("当前宿主隔离不可用，真实执行保持未执行"); return; }
  const source = "import fs from 'node:fs'; let count=0; try{count=JSON.parse(fs.readFileSync('counter.json','utf8')).count}catch(error){if(error.code!=='ENOENT')throw error} count++;fs.writeFileSync('counter.json',JSON.stringify({count}));console.log(JSON.stringify({count}));";
  const input = await fixture(t, source);
  const cases = [1, 2].map((value) => ({ id: `increment_${value}`, input: "increment", assertions: [{ path: "count", expectedJson: String(value) }] }));
  const realRun = executor.run.bind(executor), directories = [];
  executor.run = async (options) => { if (options.workspaceDir) directories.push(options.workspaceDir); return realRun(options); };
  for (let attempt = 0; attempt < 2; attempt++) {
    const report = await executor.verify({ ...input, cases, stateful: true });
    assert.equal(report.status, "passed", JSON.stringify(report)); assert.equal(report.stateful, true);
    assert.deepEqual(report.results.map((item) => item.actual.count), [1, 2]);
    assert.deepEqual(report.results.map((item) => item.caseId), ["increment_1", "increment_2"]);
  }
  assert.equal(directories[0], directories[1]); assert.equal(directories[2], directories[3]);
  assert.notEqual(directories[0], directories[2]);
  for (const directory of new Set(directories)) await assert.rejects(lstat(directory), { code: "ENOENT" });
  const isolated = await executor.verify({ ...input, cases });
  assert.equal(isolated.status, "failed"); assert.deepEqual(isolated.results.map((item) => item.actual.count), [1, 1]);
});
