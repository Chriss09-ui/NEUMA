import { execFile } from "node:child_process";
import { open, opendir, readlink } from "node:fs/promises";
import { basename, isAbsolute, relative, sep, join, win32 } from "node:path";
import { projectEnvironment, requireProjectHelper } from "./project-platform.mjs";

const INTERPRETERS = /^(?:node(?:js)?|python(?:\d+(?:\.\d+)*)?|bun|deno|ruby|php(?:\d+(?:\.\d+)*)?|java|dotnet|uvicorn|gunicorn)(?:\.exe)?$/i;
const PASSIVE_PROCESSES = /^(?:-?(?:ba|da|k|z|fi)?sh|login|open|sudo|env|git|ssh|sshd|tmux(?::.*)?|screen|lsof|ps|code(?: helper.*)?|visual studio code|electron|codex(?: helper.*)?|cursor(?: helper.*)?|zed|pycharm|webstorm|idea|vim|nvim|emacs|nano|terminal|iterm2?|finder|chrome(?: helper.*)?|google chrome(?: helper.*)?|safari|firefox)$/i;
const cleanName = (value) => basename(value || "未知进程").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100);
const positiveInteger = (value) => /^\d+$/.test(value || "") && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const unique = (values) => [...new Set(values)].sort((a, b) => a - b);
const PROC_LIMITS = { maxProcesses: 4096, maxFileDescriptors: 65536, maxPerProcessFds: 8192, timeoutMs: 5000 };

async function readProcText(path, _encoding, maxBytes = 1024 * 1024, { signal, deadline } = {}) {
  const file = await open(path, "r"), chunks = [];
  let size = 0;
  try {
    while (size <= maxBytes) {
      signal?.throwIfAborted();
      if (deadline && Date.now() >= deadline) throw Object.assign(new Error("proc time limit"), { code: "PROC_LIMIT" });
      const buffer = Buffer.allocUnsafe(Math.min(8192, maxBytes + 1 - size));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) return Buffer.concat(chunks, size).toString("utf8");
      size += bytesRead;
      if (size > maxBytes) throw Object.assign(new Error("proc read limit"), { code: "PROC_LIMIT" });
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally { await file.close(); }
}

async function readProcEntries(path, limit) {
  const directory = await opendir(path, { bufferSize: 32 }), result = [];
  for await (const item of directory) {
    if (result.length >= limit) { result.truncated = true; break; }
    if (path === "/proc" && !/^\d+$/.test(item.name)) continue;
    result.push(item.name);
  }
  return result;
}

function command(run, executable, args, signal, env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" }) {
  signal?.throwIfAborted();
  return new Promise((done) => {
    try {
      run(executable, args, { env, signal, timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (error, stdout = "", stderr = "") => done({ error, stdout: String(stdout), stderr: String(stderr) }));
    } catch (error) { done({ error, stdout: "", stderr: "" }); }
  });
}

function linuxAddress(value) {
  if (/^[A-Fa-f\d]{8}$/.test(value)) return [...Buffer.from(value, "hex")].reverse().join(".");
  if (!/^[A-Fa-f\d]{32}$/.test(value)) return null;
  const bytes = Buffer.concat(value.match(/.{8}/g).map((word) => Buffer.from(word, "hex").reverse()));
  return `[${Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(":")}]`;
}

function linuxListeners(source) {
  return source.split("\n").slice(1).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== "0A" || !/^\d+$/.test(fields[9] || "")) return [];
    const [address, encodedPort] = (fields[1] || "").split(":");
    const port = /^[\da-f]{4}$/i.test(encodedPort || "") ? parseInt(encodedPort, 16) : 0;
    const decoded = linuxAddress(address || "");
    return decoded && port > 0 ? [{ address: decoded, port, inode: fields[9] }] : [];
  });
}

async function scanLinux({ signal, procRoot, procFs, procLimits }) {
  const checkedAt = new Date().toISOString(), warnings = [], listeners = [], processes = [], owners = new Map();
  const limits = Object.fromEntries(Object.entries(PROC_LIMITS).map(([key, value]) => [key,
    Number.isInteger(procLimits?.[key]) && procLimits[key] > 0 ? Math.min(value, procLimits[key]) : value]));
  const deadline = Date.now() + limits.timeoutMs;
  const limited = () => { if (!warnings.includes("状态查询达到资源上限，返回已有结果，部分项目无法确认。")) warnings.push("状态查询达到资源上限，返回已有结果，部分项目无法确认。"); };
  const available = () => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) { limited(); return false; }
    return true;
  };
  const entriesAt = async (path, maximum) => {
    const result = await procFs.readdir(path, maximum);
    signal?.throwIfAborted();
    if (result.truncated || result.length > maximum) limited();
    return result.slice(0, maximum);
  };
  const unavailable = () => { if (!warnings.includes("部分进程或监听端口不可见，项目归属可能无法确认。")) warnings.push("部分进程或监听端口不可见，项目归属可能无法确认。"); };
  for (const name of ["tcp", "tcp6"]) {
    if (!available()) break;
    try { listeners.push(...linuxListeners(await procFs.readFile(join(procRoot, "net", name), "utf8", 1024 * 1024, { signal, deadline }))); }
    catch (error) { if (error.code === "PROC_LIMIT") limited(); else if (name !== "tcp6" || error.code !== "ENOENT") unavailable(); }
  }
  const wanted = new Set(listeners.map((item) => item.inode));
  let entries;
  try { entries = available() ? (await entriesAt(procRoot, limits.maxProcesses)).filter((name) => /^\d+$/.test(name)) : []; }
  catch { unavailable(); entries = []; }
  // Bounded, sequential /proc reads avoid spawning tools or building a promise for every process.
  let descriptorCount = 0;
  for (const entry of entries) {
    if (!available()) break;
    const directory = join(procRoot, entry), pid = positiveInteger(entry);
    let source;
    try { source = await procFs.readFile(join(directory, "status"), "utf8", 64 * 1024, { signal, deadline }); }
    catch (error) { if (error.code === "PROC_LIMIT") limited(); else if (error.code !== "ENOENT" && error.code !== "ESRCH") unavailable(); continue; }
    const name = cleanName(source.match(/^Name:\s*(.+)$/m)?.[1]);
    const item = { pid, ppid: Number(source.match(/^PPid:\s*(\d+)$/m)?.[1] || 0), name };
    for (const property of ["cwd", "exe"]) {
      if (!available()) break;
      try { const value = await procFs.readlink(join(directory, property)); if (isAbsolute(value)) item[property] = value; }
      catch (error) { if (property === "cwd" && INTERPRETERS.test(name) && !["ENOENT", "ESRCH"].includes(error.code)) unavailable(); }
    }
    processes.push(item);
    if (!wanted.size) continue;
    let descriptors;
    if (descriptorCount >= limits.maxFileDescriptors) { limited(); break; }
    try { descriptors = await entriesAt(join(directory, "fd"), Math.min(limits.maxPerProcessFds, limits.maxFileDescriptors - descriptorCount)); }
    catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) unavailable(); continue; }
    for (const descriptor of descriptors) {
      if (!available()) break;
      descriptorCount++;
      try {
        const inode = (await procFs.readlink(join(directory, "fd", descriptor))).match(/^socket:\[(\d+)\]$/)?.[1];
        if (wanted.has(inode)) { const pids = owners.get(inode) || []; pids.push(item); owners.set(inode, pids); }
      } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) unavailable(); }
    }
  }
  const ports = [];
  for (const { address, port, inode } of listeners) {
    const members = owners.get(inode);
    if (!members?.length) { unavailable(); ports.push({ address, port, protocol: "TCP", pid: null, processName: "无法确认" }); continue; }
    for (const member of members) ports.push({ address, port, protocol: "TCP", pid: member.pid, processName: member.name, ...(member.cwd ? { cwd: member.cwd } : {}) });
  }
  ports.sort((a, b) => a.port - b.port || (a.pid || 0) - (b.pid || 0));
  signal?.throwIfAborted();
  return { checkedAt, ports, processes, warnings, complete: warnings.length === 0 };
}

async function scanWindows({ signal, run, helperPath }) {
  const checkedAt = new Date().toISOString(), warnings = [];
  try {
    const helper = await requireProjectHelper({ platform: "win32", helperPath });
    const result = await command(run, helper, ["scan"], signal, projectEnvironment());
    signal?.throwIfAborted();
    if (result.error) throw result.error;
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed.processes) || !Array.isArray(parsed.ports)) throw new Error();
    const processes = parsed.processes.filter((item) => Number.isSafeInteger(item.pid) && item.pid > 0)
      .map((item) => ({ pid: item.pid, ppid: Number.isSafeInteger(item.ppid) ? item.ppid : 0,
        name: cleanName(item.name), ...(typeof item.exe === "string" && win32.isAbsolute(item.exe) ? { exe: item.exe } : {}) }));
    const byPid = new Map(processes.map((item) => [item.pid, item]));
    const ports = parsed.ports.filter((item) => Number.isSafeInteger(item.pid) && item.pid > 0
      && Number.isInteger(item.port) && item.port > 0 && item.port < 65536 && typeof item.address === "string")
      .map((item) => ({ pid: item.pid, port: item.port, address: item.address, protocol: "TCP", processName: byPid.get(item.pid)?.name || "未知进程" }));
    if (parsed.complete !== true) warnings.push("部分 Windows 进程或监听端口不可见，结果可能不完整。");
    // Windows has no supported current-directory query without reading another process's memory.
    if (processes.some((item) => INTERPRETERS.test(item.name)) || ports.length) warnings.push("Windows 外部进程的工作目录不可见，未托管项目的状态可能无法确认。");
    return { checkedAt, ports, processes, warnings, complete: warnings.length === 0 };
  } catch (error) {
    signal?.throwIfAborted();
    return { checkedAt, ports: [], processes: [], warnings: ["Windows 项目状态查询辅助程序不可用，无法完整确认运行状态。"], complete: false };
  }
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

export async function scanLocalRuntime({ signal, run = execFile, platform = process.platform, helperPath, procLimits,
  procRoot = "/proc", procFs = { readFile: readProcText, readdir: readProcEntries, readlink } } = {}) {
  signal?.throwIfAborted();
  if (platform === "linux") return scanLinux({ signal, procRoot, procFs, procLimits });
  if (platform === "win32") return scanWindows({ signal, run, helperPath });
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
  const paths = win32.isAbsolute(root) && /^[A-Za-z]:|^\\\\/.test(root) ? win32 : { relative, isAbsolute, sep };
  const suffix = paths.relative(root, cwd);
  return !paths.isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${paths.sep}`);
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
    const child = run?.child || (run?.background && run.launcher?.jobManaged ? run.launcher : null);
    const liveChild = child?.pid && child.exitCode == null && child.signalCode == null;
    const background = run?.background && run.ownsService;
    if (!["starting", "running"].includes(run?.status) || (!liveChild && !run.server?.listening && !background)) continue;
    const pids = liveChild ? child.jobManaged ? new Set(child.managedPids || [child.pid]) : processTree(child.pid, processes) : new Set(run.server?.listening ? [process.pid] : []);
    const serverPort = run.server?.listening ? run.server.address()?.port : null;
    managed.set(project.id, { pids, serverPort });
    if (liveChild) for (const pid of pids) ownership.set(pid, project.id);
  }
  for (const process of processes) {
    if (ownership.has(process.pid) || PASSIVE_PROCESSES.test(process.name)) continue;
    const matches = projects.filter((project) => within(project.root, process.cwd) || process.exe && within(project.root, process.exe));
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
    const runtime = own ? { state: "running", source: "nuema", reason: "由 NEUMA 启动的项目进程仍在运行。" }
      : pids.length ? { state: "running", source: runs.get(project.id)?.ownsService ? "nuema" : "external", reason: "发现工作目录属于此项目的运行进程。" }
      : unknown ? { state: "unknown", source: "none", reason: project.kind === "desktop" ? "打开过桌面应用，但尚无足够进程信息确认当前状态。" : "当前进程信息不足，无法确认项目是否已经停止。" }
      : { state: "stopped", source: "none", reason: "本次检查未发现属于此项目的运行进程。" };
    return { ...project, runtime: { ...runtime, ports: projectPorts, pids } };
  });
  const summary = { total: result.length, running: 0, stopped: 0, unknown: 0 };
  for (const project of result) summary[project.runtime.state]++;
  return { checkedAt: snapshot.checkedAt, ports: rows, projects: result, summary, warnings: snapshot.warnings || [] };
}
