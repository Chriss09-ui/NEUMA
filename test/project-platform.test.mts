import type {ProjectChild,ProjectRun,ProjectProcessSpawner} from "../src/projects/project-port.mjs";
import type {SpawnOptions} from "node:child_process";
import { callFixture } from "./helpers/m7-test-boundaries.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
class FixtureChild extends EventEmitter {declare pid:number;declare exitCode:number|null;declare signalCode:NodeJS.Signals|number|null;declare neumaClosed:boolean;declare kill:((signal?:NodeJS.Signals|number)=>boolean)|undefined;declare stdout:EventEmitter & {resume?:()=>unknown;write?:(chunk:string)=>unknown};declare stderr:{resume():unknown};declare stdin:import("node:stream").PassThrough;declare then?:undefined}
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectEnvironment, projectHelperPath, resolveProjectProgram, spawnProject, stopProjectProcess, validateBatchArguments } from "../src/projects/project-platform.mjs";
import { createProjectReader, projectScriptFile, validateProjectPlan, validateScriptCommand } from "../src/projects/project-inspection.mjs";
import { ProjectManager } from "../src/projects/projects.mjs";

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuma-project-platform-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("平台环境只继承已允许的系统变量，Windows Path 大小写不会丢失", () => {
  assert.deepEqual(projectEnvironment({ Path: "C:\\Node", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", NEUMA_LLM_API_KEY: "fixture-only", DISPLAY: ":1" }),
    { Path: "C:\\Node", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" });
  assert.equal(projectEnvironment({ DISPLAY: ":1" }, { desktop: true }).DISPLAY, ":1");
  assert.equal(projectHelperPath({ platform: "win32", arch: "arm64" }),
    fileURLToPath(new URL("../native/projects/bin/win32-arm64/neuma-projects.exe", import.meta.url)));
  assert.throws(() => projectHelperPath({ platform: "freebsd", arch: "x64" }));
});

test("Windows npm 使用真实 Node CLI，不能找到时不回退成拼接 Shell", async (t) => {
  const root = await fixture(t), bin = join(root, "node_modules", "npm", "bin");
  await mkdir(bin, { recursive: true }); await writeFile(join(bin, "npm-cli.js"), "// fixture");
  const result = await resolveProjectProgram("npm", ["run", "dev"], { platform: "win32", nodePath: join(root, "node.exe"), env: { Path: root } });
  assert.equal(result.command, join(root, "node.exe"));
  assert.deepEqual(result.args, [join(bin, "npm-cli.js"), "run", "dev"]);
  await assert.rejects(resolveProjectProgram("yarn", ["run", "dev"], { platform: "win32", nodePath: join(root, "node.exe"), env: {} }), /没有找到/);
});

test("Windows 托管协议从 Job 获取身份、转发输出并用控制管道停止整个树", async () => {
  const supervisor = new FixtureChild(); supervisor.stdout = new PassThrough(); supervisor.stderr = new PassThrough(); supervisor.stdin = new PassThrough();
  let control = "", launch;
  supervisor.stdin.on("data", (chunk: string) => { control += chunk; });
  const child = await spawnProject("node", ["入口 文件.mjs"], { cwd: "C:\\研究 项目", env: { Path: "C:\\Node" } }, {
    platform: "win32", helperPath: process.execPath, nodePath: "C:\\Node\\node.exe", spawnImpl: (file, args, options) => { launch = { file, args, options }; return supervisor; },
  });
  const output: ((unknown))[] = []; child.stdout!.on("data", (chunk) => output.push(chunk.toString()));
  supervisor.stdout.write!(JSON.stringify({ event: "started", pid: 101 }) + "\n");
  supervisor.stdout.write!(JSON.stringify({ event: "members", pids: [101, 102] }) + "\n");
  supervisor.stdout.write!(JSON.stringify({ event: "stdout", data: Buffer.from("http://127.0.0.1:4000/").toString("base64") }) + "\n");
  assert.equal(child.pid, 101); assert.deepEqual(child.managedPids, [101, 102]); assert.equal(output.join(""), "http://127.0.0.1:4000/");
  assert.deepEqual(launch!.args!, ["manage", "C:\\研究 项目", "C:\\Node\\node.exe", "入口 文件.mjs"]);
  assert.equal(launch!.options!.shell, false); assert.equal(launch!.options!.detached, false);
  const treeStop = child.stopTree!();
  const stopped = stopProjectProcess(child, { platform: "win32" });
  assert.equal(child.kill!(), false); assert.equal(child.stopTree!(), treeStop);
  assert.equal(control, "stop\n"); supervisor.stdout.write!('{"event":"treeEmpty"}\n'); supervisor.emit("close", 0, null); await stopped;
  assert.equal(child.exitCode, 0);
});

test("Windows 停止管道 EPIPE 不崩服务，强制关闭后缺少树退出证据不能报告成功", async () => {
  const supervisor = new FixtureChild(); supervisor.stdout = new PassThrough(); supervisor.stderr = new PassThrough(); supervisor.stdin = new PassThrough();
  let kills = 0;
  supervisor.kill = () => { kills++; queueMicrotask(() => supervisor.emit("close", null, "SIGKILL")); return true; };
  const child = await spawnProject("node", ["entry.mjs"], { cwd: "C:\\Project", env: {} }, {
    platform: "win32", helperPath: process.execPath, nodePath: "C:\\Node\\node.exe", spawnImpl: () => supervisor,
    stopTimeoutMs: 20, killTimeoutMs: 20,
  });
  const stopped = child.stopTree!();
  assert.doesNotThrow(() => supervisor.stdin.emit("error", Object.assign(new Error("fixture pipe closed"), { code: "EPIPE" })));
  assert.equal(child.kill!(), false);
  await assert.rejects(stopped, /未能确认/); assert.equal(kills, 1);
});

test("Windows 停止期限会终止辅助进程并等待关闭，未收到关闭事件也有界失败", async () => {
  for (const closes of [true, false]) {
    const supervisor = new FixtureChild(); supervisor.stdout = new PassThrough(); supervisor.stderr = new PassThrough(); supervisor.stdin = new PassThrough();
    let kills = 0;
    supervisor.kill = () => { kills++; if (closes) queueMicrotask(() => supervisor.emit("close", null, "SIGKILL")); return true; };
    const child = await spawnProject("node", ["entry.mjs"], { cwd: "C:\\Project", env: {} }, {
      platform: "win32", helperPath: process.execPath, nodePath: "C:\\Node\\node.exe", spawnImpl: () => supervisor,
      stopTimeoutMs: 20, killTimeoutMs: 20,
    });
    const stopped = child.stopTree!();
    await assert.rejects(stopped, /未能确认/); assert.equal(kills, 1);
    if (!closes) supervisor.emit("close", null, "SIGKILL");
  }
});

test("POSIX 停止等待整个进程组退出，父进程先关闭也会清理忽略 SIGTERM 的子进程", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  for (const launcherClosed of [false, true]) {
    const workerSource = "process.on('SIGTERM', () => {}); process.send({ pid: process.pid }); setInterval(() => {}, 1000);";
    const parentSource = `import { spawn } from 'node:child_process';
const worker = spawn(process.execPath, ['-e', ${JSON.stringify(workerSource)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
worker.on('message', (message) => { console.log(JSON.stringify(message)); worker.disconnect(); });
setInterval(() => {}, 1000);`;
    const child = await spawnProject("node", ["--input-type=module", "-e", parentSource], {
      detached: true, stdio: ["ignore", "pipe", "ignore"], env: projectEnvironment(),
    });
    t.after(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch (error) { if (objectFields(error).code !== "ESRCH") throw error; } });
    let output = "";
    for await (const chunk of asyncOutput(child.stdout)) { output += chunk; if (output.includes("\n")) break; }
    const workerPid = JSON.parse(String(output)).pid;
    assert.equal(process.kill(workerPid, 0), true);
    if (launcherClosed) { const closed = once(child, "close"); child.kill!("SIGTERM"); await closed; }
    await stopProjectProcess(child, { stopTimeoutMs: 50 });
    assert.equal(child.neumaClosed, true);
    assert.throws(() => process.kill(workerPid, 0), { code: "ESRCH" });
    assert.throws(() => process.kill(-child.pid!, 0), { code: "ESRCH" });
  }
});

test("POSIX 强制停止仍无法确认进程组退出时有界失败，不遗留关闭监听", async (t) => {
  const child = new FixtureChild(); child.pid = 123456789; child.neumaClosed = true;
  const signals: ((unknown))[] = [];
  t.mock.method(process, "kill", (_pid: unknown, signal: unknown) => { signals.push(signal); return true; });
  await assert.rejects(callFixture(stopProjectProcess, undefined, [child, { platform: "linux", stopTimeoutMs: 0, killTimeoutMs: 0 }]), /未能确认/);
  assert.equal(signals.filter((signal) => signal === "SIGKILL").length, 1);
  assert.equal(child.listenerCount("close"), 0);
});

test("批处理拒绝变量展开和内联参数，PowerShell 保留系统执行策略", async (t) => {
  const root = await fixture(t); await writeFile(join(root, "start.cmd"), "@echo off"); await writeFile(join(root, "start.ps1"), "Write-Output 'fixture'");
  const options = { platform: "win32" as const, accessImpl: async () => {} };
  const batch = await validateScriptCommand(root, { command: "cmd", args: ["start.cmd", "研究 项目&(demo)"] }, options);
  assert.deepEqual(batch, { command: join(root, "start.cmd"), args: ["研究 项目&(demo)"] });
  assert.equal(projectScriptFile(batch), join(root, "start.cmd"));
  const powershell = await validateScriptCommand(root, { command: "powershell", args: ["start.ps1", "start"] }, options);
  assert.deepEqual(powershell.args, ["-NoProfile", "-NonInteractive", "-File", join(root, "start.ps1"), "start"]);
  assert.doesNotMatch(powershell.args.join(" "), /Bypass|ExecutionPolicy/);
  assert.deepEqual(await validateScriptCommand(root, powershell, options), powershell);
  assert.equal(projectScriptFile(powershell), join(root, "start.ps1"));
  await assert.rejects(callFixture(validateScriptCommand, undefined, [root, { command: "cmd", args: ["/c", "echo fixture"] }, options]));
  for (const arg of ["%PATH%", "bad\"argument", "bad\nargument"]) assert.throws(() => validateBatchArguments([arg]));
});

test("Windows 项目识别虚拟环境 Scripts/python.exe 和已存在的 Python 入口", async (t) => {
  const root = await fixture(t); await mkdir(join(root, ".venv", "Scripts"), { recursive: true });
  await writeFile(join(root, ".venv", "Scripts", "python.exe"), "fixture", { mode: 0o700 }); await writeFile(join(root, "main.py"), "print('fixture')");
  assert.deepEqual((await createProjectReader(root, { platform: "win32" }).list()).pythonEnvironments, [".venv/Scripts/python.exe"]);
  const result = await callFixture(validateProjectPlan,undefined,[{root}, { status: "ready", summary: "已有环境", command: ".venv/Scripts/python.exe", args: ["main.py"] }, {platform:"win32"}]);
  assert.equal(result.kind, "python"); assert.equal(result.launch!.command, join(root, ".venv", "Scripts", "python.exe"));
});

test("Linux desktop 文件交给系统启动器，Exec 内容不拼接成模型命令", async (t) => {
  const root = await fixture(t), file = join(root, "demo.desktop");
  await writeFile(file, "[Desktop Entry]\nType=Application\nName=Demo\nExec=/bin/echo fixture\n");
  const manager = new ProjectManager({ dataDir: join(root, "data"), platform: "linux" });
  const project = await manager.add({ path: file });
  assert.equal(project.kind, "desktop"); assert.deepEqual(project.launch, { command: "/usr/bin/gio", args: ["launch", file], url: null });
  await assert.rejects(manager.configure(project.id, { command: "/bin/sh", args: ["-c", "echo fixture"], allowLaunch: true }), /当前登记/);
});

function asyncOutput(value:unknown):AsyncIterable<Buffer>{assert.ok(value && typeof value==="object" && typeof Reflect.get(value,Symbol.asyncIterator)==="function");return value as AsyncIterable<Buffer>;}
