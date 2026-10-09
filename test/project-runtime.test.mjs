import test from "node:test";
import assert from "node:assert/strict";
import { scanLocalRuntime, projectRuntimeSnapshot } from "../project-runtime.mjs";
import { ProjectManager } from "../projects.mjs";

const fields = (...values) => `${values.join("\0")}\0\n`;
const snapshot = (overrides = {}) => ({ checkedAt: "2026-10-04T00:00:00.000Z", ports: [], processes: [], complete: true, warnings: [], ...overrides });
const project = (id, root, kind = "node") => ({ id, name: id, root, kind, status: "stopped", canStop: false });
const port = (pid, number) => ({ pid, port: number, protocol: "TCP", address: "127.0.0.1", processName: "node" });

test("端口扫描使用数字 TCP LISTEN 字段，保留进程目录但不读取命令参数或环境变量", async () => {
  const calls = [];
  const result = await scanLocalRuntime({ platform: "darwin", run: (file, args, options, done) => {
    calls.push({ file, args, options });
    if (file === "/bin/ps") done(null, " 41 1 /usr/local/bin/node\n 52 1 /bin/zsh\n");
    else if (args.includes("cwd")) done(null, fields("p41", "cnode", "fcwd", "n/apps/demo") + fields("p52", "czsh", "fcwd", "n/apps/demo"));
    else done(null, fields("p41", "cnode", "f7", "PTCP", "n127.0.0.1:3000", "TST=LISTEN", "TQR=0", "f8", "PTCP", "n[::1]:3000", "TST=LISTEN", "TQS=0"));
  } });
  assert.equal(result.complete, true);
  assert.equal(result.ports.length, 2);
  assert.equal(result.ports[1].cwd, "/apps/demo");
  assert.equal(result.processes[0].name, "node");
  assert.deepEqual(calls[1].args, ["-axo", "pid=,ppid=,comm="]);
  for (const call of calls) {
    assert.equal(call.options.shell, undefined);
    assert.deepEqual(Object.keys(call.options.env).sort(), ["LANG", "LC_ALL", "PATH"]);
  }
});

test("扫描失败或取消不会伪装成所有端口空闲，系统错误内容不泄漏", async () => {
  const denied = async () => { throw Object.assign(new Error("private-error"), { code: "EACCES" }); };
  const result = await scanLocalRuntime({ platform: "linux", procFs: { readFile: denied, readdir: denied, readlink: denied } });
  assert.equal(result.complete, false);
  assert.ok(result.warnings.length);
  assert.equal(JSON.stringify(result).includes("private-error"), false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(scanLocalRuntime({ signal: controller.signal }), { name: "AbortError" });
});

test("Linux 只从 proc status、cwd、exe、fd 和监听表读取事实，不依赖 lsof", async () => {
  const reads = [];
  const result = await scanLocalRuntime({ platform: "linux", procRoot: "/fixture-proc", run: () => assert.fail("不应启动系统命令"), procFs: {
    readFile: async (path) => {
      reads.push(path);
      if (path.endsWith("/net/tcp")) return "header\n 0: 0100007F:0FA0 00000000:0000 0A 0:0 00:0 00000000 1000 0 404\n";
      if (path.endsWith("/net/tcp6")) return "header\n";
      if (path.endsWith("/101/status")) return "Name:\tnode\nPPid:\t1\n";
      assert.fail(`不允许读取 ${path}`);
    },
    readdir: async (path) => path === "/fixture-proc" ? ["101", "net"] : ["7"],
    readlink: async (path) => { reads.push(path); return path.endsWith("/cwd") ? "/apps/demo" : path.endsWith("/exe") ? "/usr/bin/node" : "socket:[404]"; },
  } });
  assert.equal(result.complete, true); assert.deepEqual(result.ports, [{ address: "127.0.0.1", port: 4000, pid: 101, protocol: "TCP", processName: "node", cwd: "/apps/demo" }]);
  assert.equal(reads.some((path) => /cmdline|environ/.test(path)), false);
});

test("Windows 的外部全局 Node 无目录证据时保留未知，项目内 exe 可以关联", async () => {
  const scanned = await scanLocalRuntime({ platform: "win32", helperPath: process.execPath, run: (_file, args, _options, done) => {
    assert.deepEqual(args, ["scan"]);
    done(null, JSON.stringify({ complete: true, processes: [{ pid: 41, ppid: 1, name: "node.exe", exe: "C:\\Node\\node.exe" },
      { pid: 52, ppid: 1, name: "worker.exe", exe: "C:\\Projects\\worker\\worker.exe" }], ports: [{ pid: 52, port: 4500, address: "127.0.0.1" }] }));
  } });
  const result = projectRuntimeSnapshot([project("node", "C:\\Projects\\node"), project("worker", "C:\\Projects\\worker")], new Map(), scanned);
  assert.equal(result.projects[0].runtime.state, "unknown"); assert.equal(result.projects[1].runtime.state, "running");
  assert.deepEqual(result.projects[1].runtime.ports, [4500]);
});

test("Linux 达到查询上限返回已有事实并保留未知，取消不会发布成功快照", async () => {
  const procFs = {
    readFile: async (path) => path.includes("/net/") ? "header\n" : "Name:\tnode\nPPid:\t1\n",
    readdir: async () => ["101", "102"],
    readlink: async () => "/apps/demo",
  };
  const result = await scanLocalRuntime({ platform: "linux", procFs, procLimits: { maxProcesses: 1 } });
  assert.equal(result.processes.length, 1); assert.equal(result.complete, false); assert.match(result.warnings.join(""), /资源上限/);
  const controller = new AbortController();
  await assert.rejects(scanLocalRuntime({ platform: "linux", signal: controller.signal, procFs: { ...procFs,
    readdir: async () => { controller.abort(); return []; },
  } }), { name: "AbortError" });
});

test("Windows 后台脚本使用 Job 成员关联端口，不能通过无关父 PID 推断归属", () => {
  const launcher = { pid: 60, exitCode: null, signalCode: null, jobManaged: true, managedPids: [61] };
  const runs = new Map([["managed", { status: "running", background: true, ownsService: true, launcher }]]);
  const result = projectRuntimeSnapshot([project("managed", "C:\\Projects\\managed")], runs, snapshot({
    processes: [{ pid: 61, name: "node.exe" }, { pid: 62, ppid: 60, name: "node.exe" }], ports: [port(61, 4001), port(62, 4002)],
  }));
  assert.deepEqual(result.projects[0].runtime.ports, [4001]); assert.deepEqual(result.ports[1].projects, []);
});

test("进程目录与运行环境识别外部启动，终端和同端口的其他项目不误报", () => {
  const result = projectRuntimeSnapshot([project("external", "/apps/one"), project("idle", "/apps/two"), project("worker", "/apps/worker")], new Map(), snapshot({
    processes: [{ pid: 41, name: "node", cwd: "/apps/one/server" }, { pid: 52, name: "zsh", cwd: "/apps/two" }, { pid: 53, name: "python3", cwd: "/apps/worker" }],
    ports: [{ ...port(41, 3000), cwd: "/apps/one/server" }],
  }));
  assert.deepEqual(result.summary, { total: 3, running: 2, stopped: 1, unknown: 0 });
  assert.equal(result.projects[0].runtime.source, "external");
  assert.equal(result.projects[1].runtime.state, "stopped");
  assert.deepEqual(result.ports[0].projects, [{ id: "external", name: "external" }]);
  assert.equal("cwd" in result.ports[0], false);
});

test("共享服务 PID 的静态项目只关联自己的端口，托管子进程关联后代 PID", () => {
  const server = { listening: true, address: () => ({ port: 4200 }) };
  const runs = new Map([["static", { status: "running", server }], ["managed", { status: "running", child: { pid: 60, exitCode: null, signalCode: null } }]]);
  const result = projectRuntimeSnapshot([project("static", "/apps/static", "web"), project("managed", "/apps/managed")], runs, snapshot({
    complete: false, warnings: ["目录部分不可见"],
    processes: [{ pid: 60, ppid: 1, name: "npm" }, { pid: 61, ppid: 60, name: "node" }],
    ports: [port(process.pid, 4200), port(process.pid, 3000), port(61, 4500)],
  }));
  assert.deepEqual(result.projects[0].runtime.ports, [4200]);
  assert.deepEqual(result.ports[1].projects, []);
  assert.deepEqual(result.projects[1].runtime.pids, [60, 61]);
  assert.equal(result.projects[1].runtime.source, "nuema");
});

test("不完整扫描、含糊目录和桌面应用的已打开记录均保留未知状态", () => {
  const projects = [project("a", "/apps/shared"), project("b", "/apps/shared"), project("desktop", "/Applications/demo.app", "desktop")];
  const result = projectRuntimeSnapshot(projects, new Map([["desktop", { status: "external" }]]), snapshot({
    processes: [{ pid: 1, name: "node", cwd: "/apps/shared" }],
  }));
  assert.equal(result.summary.unknown, 3);
  assert.equal(projectRuntimeSnapshot([project("idle", "/apps/idle")], new Map(), snapshot({ complete: false })).projects[0].runtime.state, "unknown");
});

test("ProjectManager 提供独立只读快照，不改变原列表或停止控制", async () => {
  const manager = new ProjectManager({ scanRuntime: async () => snapshot({ processes: [{ pid: 41, name: "node", cwd: "/apps/one" }] }) });
  manager.records = [project("external", "/apps/one")];
  const result = await manager.runtime();
  assert.equal(result.projects[0].runtime.state, "running");
  assert.equal((await manager.list())[0].status, "stopped");
  assert.equal((await manager.list())[0].canStop, false);
  assert.equal(manager.runs.size, 0);
});
