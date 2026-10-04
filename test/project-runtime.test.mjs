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
  const result = await scanLocalRuntime({ platform: "linux", run: (_file, _args, _options, done) => {
    done(Object.assign(new Error("private-error"), { code: "ENOENT" }));
  } });
  assert.equal(result.complete, false);
  assert.ok(result.warnings.length);
  assert.equal(JSON.stringify(result).includes("private-error"), false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(scanLocalRuntime({ signal: controller.signal }), { name: "AbortError" });
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
