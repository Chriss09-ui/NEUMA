import { execFile } from "node:child_process";
import { basename, isAbsolute, relative, sep } from "node:path";

const INTERPRETERS = /^(?:node(?:js)?|python(?:\d+(?:\.\d+)*)?|bun|deno|ruby|php(?:\d+(?:\.\d+)*)?|java|dotnet|uvicorn|gunicorn)$/i;
const PASSIVE_PROCESSES = /^(?:-?(?:ba|da|k|z|fi)?sh|login|open|sudo|env|git|ssh|sshd|tmux(?::.*)?|screen|lsof|ps|code(?: helper.*)?|visual studio code|electron|codex(?: helper.*)?|cursor(?: helper.*)?|zed|pycharm|webstorm|idea|vim|nvim|emacs|nano|terminal|iterm2?|finder|chrome(?: helper.*)?|google chrome(?: helper.*)?|safari|firefox)$/i;
const cleanName = (value) => basename(value || "未知进程").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100);
const positiveInteger = (value) => /^\d+$/.test(value || "") && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const unique = (values) => [...new Set(values)].sort((a, b) => a - b);

function command(run, executable, args, signal) {
  signal?.throwIfAborted();
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" };
  return new Promise((done) => {
    try {
      run(executable, args, { env, signal, timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (error, stdout = "", stderr = "") => done({ error, stdout: String(stdout), stderr: String(stderr) }));
    } catch (error) { done({ error, stdout: "", stderr: "" }); }
  });
}

function lsofRecords(output) {
  const records = [];
  let process = null, file = null;
  for (const field of output.split("\0")) {
    const text = field.replace(/^\n+/, "");
    if (!text) continue;
    const value = text.slice(1);
    if (text[0] === "p") { process = { pid: positiveInteger(value), files: [] }; records.push(process); file = null; }
    else if (text[0] === "c" && process) process.name = cleanName(value);
    else if (text[0] === "f" && process) { file = {}; process.files.push(file); }
    else if (file && ["n", "P"].includes(text[0])) file[text[0]] = value;
    else if (file && text[0] === "T" && value.startsWith("ST=")) file.T = value;
  }
  return records.filter((record) => record.pid);
}

function parsePorts(output) {
  const ports = [];
  for (const process of lsofRecords(output)) for (const file of process.files) {
    if (file.P !== "TCP" || (file.T && file.T !== "ST=LISTEN")) continue;
    const match = file.n?.match(/^(.*):(\d+)$/);
    const port = match && positiveInteger(match[2]);
    if (!port || port > 65535 || !match[1] || match[1].includes("->")) continue;
    ports.push({ port, protocol: "TCP", address: match[1], pid: process.pid, processName: process.name || "未知进程" });
  }
  return [...new Map(ports.map((item) => [`${item.pid}:${item.address}:${item.port}`, item])).values()]
    .sort((a, b) => a.port - b.port || a.pid - b.pid || a.address.localeCompare(b.address));
}

function parseProcesses(output) {
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    const pid = match && positiveInteger(match[1]);
    return pid ? [{ pid, ppid: Number(match[2]), name: cleanName(match[3]) }] : [];
  });
}

export async function scanLocalRuntime({ signal, run = execFile, platform = process.platform } = {}) {
  signal?.throwIfAborted();
  const checkedAt = new Date().toISOString();
  if (!["darwin", "linux"].includes(platform)) {
    return { checkedAt, ports: [], processes: [], warnings: ["当前系统暂不支持读取端口和进程，项目运行状态无法完整确认。"], complete: false };
  }
  const lsof = platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
  const [listeners, processList, directories] = await Promise.all([
    command(run, lsof, ["-nP", "+c0", "-iTCP", "-sTCP:LISTEN", "-F0pcfPnT"], signal),
    command(run, "/bin/ps", ["-axo", "pid=,ppid=,comm="], signal),
    command(run, lsof, ["-nP", "+c0", "-a", "-d", "cwd", "-F0pcfn"], signal),
  ]);
  signal?.throwIfAborted();
  const warnings = [];
  const successful = (result, allowNoMatch = false) => !result.stderr.trim()
    && (!result.error || (allowNoMatch && result.error.code === 1 && !result.stdout.trim()));
  if (!successful(listeners, true)) warnings.push("部分监听端口无法读取，结果可能不完整；请确认系统允许读取进程且已安装 lsof。");
  if (!successful(processList)) warnings.push("部分进程无法读取，不能据此判断项目已经停止。");
  if (!successful(directories)) warnings.push("部分进程目录无法读取，项目归属可能无法确认。");
  const cwdByPid = new Map(lsofRecords(directories.stdout).flatMap((process) => {
    const cwd = process.files.find((file) => isAbsolute(file.n || ""))?.n;
    return cwd ? [[process.pid, cwd]] : [];
  }));
  const processes = parseProcesses(processList.stdout).map((item) => ({ ...item, ...(cwdByPid.has(item.pid) ? { cwd: cwdByPid.get(item.pid) } : {}) }));
  const byPid = new Map(processes.map((item) => [item.pid, item]));
  const ports = parsePorts(listeners.stdout).map((item) => {
    const cwd = cwdByPid.get(item.pid);
    if (!byPid.has(item.pid)) {
      const process = { pid: item.pid, name: item.processName, ...(cwd ? { cwd } : {}) };
      processes.push(process); byPid.set(item.pid, process);
    }
    return { ...item, ...(cwd ? { cwd } : {}) };
  });
  const listenerPids = new Set(ports.map((item) => item.pid));
  if (processes.some((item) => !item.cwd && (INTERPRETERS.test(item.name) || listenerPids.has(item.pid)))) {
    warnings.push("有监听端口或运行环境进程的目录不可见，部分项目可能无法确认是否运行。");
  }
  return { checkedAt, ports, processes, warnings, complete: warnings.length === 0 };
}

function within(root, cwd) {
  if (!root || !cwd) return false;
  const suffix = relative(root, cwd);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}

function processTree(pid, processes) {
  const pids = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) if (pids.has(process.ppid) && !pids.has(process.pid)) {
      pids.add(process.pid); changed = true;
    }
  }
  return pids;
}

export function projectRuntimeSnapshot(projects, runs, snapshot) {
  const processes = snapshot.processes || [], ports = snapshot.ports || [];
  const listenerPids = new Set(ports.map((item) => item.pid));
  const ownership = new Map(), uncertain = new Set(), managed = new Map();
  for (const project of projects) {
    const run = runs.get(project.id);
    const liveChild = run?.child?.pid && run.child.exitCode == null && run.child.signalCode == null;
    const background = run?.background && run.ownsService;
    if (!["starting", "running"].includes(run?.status) || (!liveChild && !run.server?.listening && !background)) continue;
    const pids = liveChild ? processTree(run.child.pid, processes) : new Set(run.server?.listening ? [process.pid] : []);
    const serverPort = run.server?.listening ? run.server.address()?.port : null;
    managed.set(project.id, { pids, serverPort });
    if (liveChild) for (const pid of pids) ownership.set(pid, project.id);
  }
  for (const process of processes) {
    if (ownership.has(process.pid) || PASSIVE_PROCESSES.test(process.name)) continue;
    const matches = projects.filter((project) => within(project.root, process.cwd));
    if (!matches.length) continue;
    const longest = Math.max(...matches.map((project) => project.root.length));
    const nearest = matches.filter((project) => project.root.length === longest);
    if (nearest.length !== 1) { for (const project of nearest) uncertain.add(project.id); continue; }
    const project = nearest[0];
    const launchName = project.launch?.command && basename(project.launch.command);
    if (listenerPids.has(process.pid) || INTERPRETERS.test(process.name) || (launchName && process.name === launchName)) {
      ownership.set(process.pid, project.id);
    } else { uncertain.add(project.id); }
  }
  const rows = ports.map(({ port, protocol, address, pid, processName }) => {
    const staticOwners = projects.filter((project) => pid === process.pid && managed.get(project.id)?.serverPort === port);
    const owners = staticOwners.length ? staticOwners : projects.filter((project) => !managed.get(project.id)?.serverPort && ownership.get(pid) === project.id);
    return { port, protocol, address, pid, processName, projects: owners.map(({ id, name }) => ({ id, name })) };
  });
  const result = projects.map((project) => {
    const own = managed.get(project.id);
    const pids = unique([...ownership.entries()].filter(([, id]) => id === project.id).map(([pid]) => pid).concat(own ? [...own.pids] : []));
    const projectPorts = unique(rows.filter((row) => row.projects.some((item) => item.id === project.id)).map((row) => row.port)
      .concat(own?.serverPort ? [own.serverPort] : []));
    const unknown = !snapshot.complete || uncertain.has(project.id) || project.kind === "desktop" || ["starting", "running", "external"].includes(runs.get(project.id)?.status);
    const runtime = own ? { state: "running", source: "nuema", reason: "由 NUEMA 启动的项目进程仍在运行。" }
      : pids.length ? { state: "running", source: runs.get(project.id)?.ownsService ? "nuema" : "external", reason: "发现工作目录属于此项目的运行进程。" }
      : unknown ? { state: "unknown", source: "none", reason: project.kind === "desktop" ? "打开过桌面应用，但尚无足够进程信息确认当前状态。" : "当前进程信息不足，无法确认项目是否已经停止。" }
      : { state: "stopped", source: "none", reason: "本次检查未发现属于此项目的运行进程。" };
    return { ...project, runtime: { ...runtime, ports: projectPorts, pids } };
  });
  const summary = { total: result.length, running: 0, stopped: 0, unknown: 0 };
  for (const project of result) summary[project.runtime.state]++;
  return { checkedAt: snapshot.checkedAt, ports: rows, projects: result, summary, warnings: snapshot.warnings || [] };
}
