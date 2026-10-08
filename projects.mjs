import { access, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { InputError } from "./core.mjs";
import { projectRuntimeSnapshot, scanLocalRuntime } from "./project-runtime.mjs";
import { validateProjectPlan } from "./project-inspection.mjs";
import { startScriptServices, stopScriptServices } from "./project-script-runtime.mjs";
import { createProjectAddError, ProjectFailureStore } from "./project-diagnostics.mjs";

const TYPES = { ".html": "text/html", ".htm": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2" };
const PROGRAMS = new Set(["npm", "pnpm", "yarn", "bun", "node", "python", "python3", "open"]);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const projectEnvironment = () => Object.fromEntries(["PATH", "HOME", "USER", "LANG", "TMPDIR", "SYSTEMROOT", "USERPROFILE", "APPDATA"]
  .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));

function inside(root, path) {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}

export function localUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password) throw new Error();
    return url.href;
  } catch { throw new InputError("预览地址必须是本机的 http 地址"); }
}

export function openProjectPage(value, { platform = process.platform, run = execFile } = {}) {
  const url = localUrl(value);
  if (!url) throw new InputError("项目页面尚未就绪");
  const commands = { darwin: ["/usr/bin/open", [url]], linux: ["xdg-open", [url]],
    win32: ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] };
  const command = commands[platform];
  if (!command) throw new InputError("当前系统暂不支持自动打开项目窗口");
  const env = Object.fromEntries(["PATH", "HOME", "USER", "LANG", "SYSTEMROOT", "USERPROFILE", "APPDATA", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]
    .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  return new Promise((done, reject) => run(command[0], command[1], { timeout: 10_000, maxBuffer: 16_384, env, windowsHide: true },
    (error) => error ? reject(new InputError("项目正在运行，但窗口未能打开。请再次点击“打开项目”。")) : done()));
}

async function canonicalPath(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new InputError("请提供项目的完整本地路径");
  const expanded = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value.trim();
  if (!isAbsolute(expanded)) throw new InputError("请使用完整路径，或以 ~/ 开头的路径");
  try { return await realpath(expanded); }
  catch { throw new InputError("项目路径不存在或当前程序没有读取权限"); }
}

async function inspectProject(value) {
  const path = await canonicalPath(value);
  const info = await stat(path);
  const root = info.isDirectory() ? path : dirname(path);
  const files = info.isDirectory() ? (await readdir(root)).filter((name) => !name.startsWith(".")
    && !["node_modules", "venv", "__pycache__"].includes(name)) : [basename(path)];
  let kind = "other", launch = null, entry = null, scripts = [];
  if (path.endsWith(".app") && process.platform === "darwin") {
    kind = "desktop"; launch = { command: "open", args: [path], url: null };
  } else if (info.isDirectory() && files.includes("package.json")) {
    try {
      const manifestPath = await realpath(join(root, "package.json"));
      if (!inside(root, manifestPath)) throw new Error();
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      scripts = Object.keys(manifest.scripts ?? {}).filter((name) => /^[\w:-]+$/.test(name));
      const script = ["dev", "start", "serve"].find((name) => scripts.includes(name));
      kind = "node";
      if (script) launch = { command: "npm", args: ["run", script], url: null };
    } catch { throw new InputError("package.json 无法读取，或不在项目目录内"); }
  } else if ((entry = files.find((name) => info.isFile() ? /\.html?$/i.test(name) : name === "index.html"))) {
    kind = "web";
  } else if ((entry = files.find((name) => info.isFile() ? name.endsWith(".py") : ["main.py", "app.py"].includes(name)))) {
    kind = "python"; launch = { command: "python3", args: [entry], url: null };
  } else if (info.isFile() && [".js", ".mjs", ".cjs"].includes(extname(path))) {
    kind = "node"; launch = { command: "node", args: [basename(path)], url: null };
  }
  return { path, root, kind, entry, scripts, launch, name: basename(path) };
}

async function awaitProjectAdd(item, { signal, onProgress } = {}) {
  signal?.throwIfAborted();
  if (onProgress) item.listeners.add(onProgress);
  let abort;
  try {
    const cancelled = signal && new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    return await (cancelled ? Promise.race([item.pending, cancelled]) : item.pending);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    if (onProgress) item.listeners.delete(onProgress);
  }
}

async function staticPreview(project) {
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405); return response.end(); }
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      const parts = pathname.split("/");
      if (parts.some((part) => part.startsWith(".") || part === "node_modules") || pathname.includes("\0")) throw new Error();
      const target = await realpath(join(project.root, pathname === "/" ? project.entry : pathname));
      if (!inside(project.root, target) || relative(project.root, target).split(sep).some((part) => part.startsWith("."))
        || !TYPES[extname(target).toLowerCase()]) throw new Error();
      const file = await stat(target);
      if (!file.isFile() || file.size > 40_000_000) throw new Error();
      response.writeHead(200, { "content-type": TYPES[extname(target).toLowerCase()], "x-content-type-options": "nosniff" });
      response.end(request.method === "HEAD" ? undefined : await readFile(target));
    } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return { server, status: "running", url: `http://127.0.0.1:${server.address().port}/` };
}

export class ProjectManager {
  constructor({ dataDir, spawnImpl = spawn, blockedPort = 3000, analyzeProject, openBrowser = openProjectPage, scanRuntime = scanLocalRuntime } = {}) {
    this.dataDir = dataDir;
    this.spawnImpl = spawnImpl;
    this.blockedPort = blockedPort;
    this.records = null;
    this.runs = new Map();
    this.pendingStarts = new Map();
    this.removing = new Set();
    this.queue = Promise.resolve();
    this.analyzeProject = analyzeProject;
    this.inspections = new Map();
    this.pendingAdds = new Map();
    this.disposed = false;
    this.openBrowser = openBrowser;
    this.scanRuntime = scanRuntime;
    this.failureStore = dataDir ? new ProjectFailureStore({ dataDir }) : null;
  }

  async load() {
    if (this.records) return;
    this.loading ??= (async () => {
      try {
        const file = join(this.dataDir, "projects.json");
        if ((await stat(file)).size > 2_000_000) throw new Error();
        const data = JSON.parse(await readFile(file, "utf8"));
        if (data.version !== 1 || !Array.isArray(data.projects) || data.projects.some((item) => !item.id || !isAbsolute(item.root))) throw new Error();
        this.records = data.projects;
      } catch (error) {
        if (error.code === "ENOENT") this.records = [];
        else throw new InputError("项目记录无法读取，请保留原文件并检查 .neuma/projects.json");
      }
    })();
    const loading = this.loading;
    try { await loading; }
    finally { if (this.loading === loading) this.loading = null; }
  }

  change(action, { signal } = {}) {
    const result = this.queue.then(async () => {
      await this.load();
      const previous = structuredClone(this.records);
      let temp;
      try {
        signal?.throwIfAborted();
        const value = await action();
        await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
        temp = join(this.dataDir, `projects-${randomUUID()}.tmp`);
        await writeFile(temp, JSON.stringify({ version: 1, projects: this.records }, null, 2), { mode: 0o600 });
        signal?.throwIfAborted();
        await rename(temp, join(this.dataDir, "projects.json"));
        return value;
      } catch (error) {
        this.records = previous;
        if (temp) await unlink(temp).catch(() => {});
        throw error;
      }
    });
    this.queue = result.catch(() => {});
    return result;
  }

  view(project) {
    const run = this.runs.get(project.id);
    const inspecting = this.inspections.has(project.id);
    return { ...project, status: run?.status ?? "stopped", url: run?.url ?? null,
      setup: inspecting ? { status: "checking", summary: "NUEMA 正在检查项目文件并识别启动方式…" } : project.setup,
      pageOpened: Boolean(run?.pageOpened), openingPage: Boolean(run?.openingPage || run?.checkingPage), openError: run?.openError ?? null,
      error: run?.error ?? null, canLaunch: !inspecting && !run?.stopping && project.allowLaunch === true && (project.kind === "web" || Boolean(project.launch)),
      canStop: run?.background ? Boolean(run.ownsService || run.status === "starting") : ["starting", "running"].includes(run?.status) };
  }

  async list() { await this.queue; await this.load(); return this.records.map((item) => this.view(item)); }

  async failures(options) { return this.failureStore ? this.failureStore.list(options) : []; }

  async recordAddFailure(error, project, stage) {
    const reason = stage === "save" ? "save_failed" : stage === "path" ? "invalid_path" : "inspection_failed";
    const storageReasons = { EACCES: "没有写入项目记录的权限", EPERM: "没有写入项目记录的权限", ENOSPC: "磁盘空间不足，无法保存项目", EEXIST: "项目记录目录不可用", ENOTDIR: "项目记录目录不可用" };
    const failure = error?.code === "PROJECT_ADD_FAILED" ? error : createProjectAddError({ stage, reason,
      message: error instanceof InputError ? error.message : storageReasons[error?.code] || (stage === "save" ? "无法保存项目记录，请检查目录和磁盘" : "项目检查暂时无法完成，请稍后再试") });
    try {
      const record = await this.failureStore.record({ name: project.name, path: project.path, error: failure });
      failure.diagnostic.recordId = record.id;
    } catch {
      failure.diagnostic.recorded = false;
      failure.message += " 失败记录未能保存。";
    }
    return failure;
  }

  async runtime({ signal } = {}) {
    signal?.throwIfAborted();
    const snapshot = await this.scanRuntime({ signal });
    signal?.throwIfAborted();
    return projectRuntimeSnapshot(await this.list(), this.runs, snapshot);
  }

  async get(id) {
    await this.load();
    const project = this.records.find((item) => item.id === id);
    if (!project) throw new InputError("没有找到这个项目，请刷新列表");
    return project;
  }

  async add({ path, name, description = "" }, options = {}) {
    options.signal?.throwIfAborted();
    let detected;
    try {
      detected = await inspectProject(path);
      await this.queue;
      await this.load();
      options.signal?.throwIfAborted();
      if (this.disposed) throw new DOMException("项目管理器已关闭", "AbortError");
    } catch (error) {
      if (!this.analyzeProject || error.name === "AbortError") throw error;
      throw await this.recordAddFailure(error, { name, path }, "path");
    }
    const existing = this.records.find((item) => item.path === detected.path);
    if (existing) return !this.analyzeProject || existing.allowLaunch ? this.view(existing) : this.inspect(existing.id, options);
    if (this.pendingAdds.has(detected.path)) return awaitProjectAdd(this.pendingAdds.get(detected.path), options);
    const project = { ...detected, id: randomUUID(), name: String(name || detected.name).slice(0, 100),
      description: String(description).slice(0, 500), allowLaunch: false, addedAt: new Date().toISOString() };
    const save = (value, signal) => this.change(() => {
      const duplicate = this.records.find((item) => item.path === detected.path);
      if (duplicate) return this.view(duplicate);
      if (this.records.length >= 500) throw new InputError("当前测试版最多登记 500 个项目");
      this.records.push(value);
      return this.view(value);
    }, { signal });
    if (!this.analyzeProject) return save(project, options.signal);

    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const item = { controller, listeners: new Set() };
    let stage = "inspection";
    this.pendingAdds.set(detected.path, item);
    item.pending = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const result = await this.analyzeProject(project, { ...options, signal, onProgress: (event) => {
        for (const listener of item.listeners) { try { listener(event); } catch {} }
      } });
      signal.throwIfAborted();
      if (result?.setup?.status !== "ready") throw createProjectAddError({ stage: result?.setup?.diagnostic?.stage || "inspection",
        reason: result?.setup?.diagnostic?.reason || result?.setup?.reason || result?.setup?.status || "inspection_failed",
        retries: result?.setup?.diagnostic?.retries || 0,
        message: result?.setup?.summary || "没有找到可用的启动方案，请确认项目入口" });
      const configured = { ...project, ...result, allowLaunch: true };
      if (!this.view(configured).canLaunch) throw createProjectAddError({ stage: "configuration", reason: "invalid_plan", message: "识别结果缺少可用的启动入口" });
      stage = "save";
      return save(configured, signal);
    }).catch(async (error) => {
      if (signal.aborted) throw signal.reason;
      if (error.name === "AbortError") throw error;
      throw await this.recordAddFailure(error, project, stage);
    }).finally(() => this.pendingAdds.delete(detected.path));
    return awaitProjectAdd(item, options);
  }

  async inspect(id, { signal, instructions, onProgress = () => {} } = {}) {
    signal?.throwIfAborted();
    await this.queue;
    const project = await this.get(id);
    if (this.view(project).canStop) throw new InputError("请先停止项目，再重新识别启动方式");
    if (this.inspections.has(id)) return this.inspections.get(id).pending;
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const item = { controller };
    this.inspections.set(id, item);
    item.pending = (async () => {
      let result;
      try {
        if (!this.analyzeProject) throw new InputError("自动识别暂不可用，请检查模型设置后重试。");
        const detected = await inspectProject(project.path);
        result = await this.analyzeProject({ ...project, ...detected, name: project.name }, { signal: combined, instructions, onProgress });
        combined.throwIfAborted();
      } catch (error) {
        result = { setup: { status: "failed", summary: combined.aborted ? "项目检查已停止，可以随时重新识别。"
          : error instanceof InputError ? error.message : "项目检查暂时失败，请重试。" } };
      }
      await this.change(async () => {
        const current = await this.get(id);
        if (result.setup?.status === "ready") {
          Object.assign(current, result, { allowLaunch: true });
        } else {
          current.setup = result.setup; current.allowLaunch = false;
        }
      });
    })().finally(() => this.inspections.delete(id)).then(async () => this.view(await this.get(id)));
    return item.pending;
  }

  async configure(id, { command, args, url, allowLaunch }) {
    if (typeof allowLaunch !== "boolean") throw new InputError("请明确是否启用这个启动方式");
    if (this.inspections.has(id)) throw new InputError("正在识别项目，请完成后再修改启动方式");
    return this.change(async () => {
      const project = await this.get(id);
      if (this.view(project).canStop) throw new InputError("请先停止项目，再修改启动方式");
      if (project.kind !== "web") {
        if (typeof command !== "string" || !command || command.includes("\0") || !Array.isArray(args)
          || args.length > 40 || args.some((arg) => typeof arg !== "string" || arg.length > 2000 || arg.includes("\0"))) {
          throw new InputError("请填写启动程序和有效的参数数组");
        }
        if (project.kind === "script" || /^(?:\/bin\/)?(?:bash|sh|zsh)$/.test(command)) {
          const plan = await validateProjectPlan(project, { ...project.launch, command, args, url,
            status: "ready", kind: "script", summary: "已保存项目脚本启动方式" });
          project.kind = "script"; project.launch = plan.launch;
        } else {
        if (!PROGRAMS.has(command)) {
          const executable = await canonicalPath(command);
          if (!inside(project.root, executable) || !(await stat(executable)).isFile()) throw new InputError("自定义程序必须是项目目录内的可执行文件");
          await access(executable, constants.X_OK);
          command = executable;
        }
        if (command === "open" && (project.kind !== "desktop" || process.platform !== "darwin"
          || args.length !== 1 || args[0] !== project.path)) throw new InputError("桌面启动只支持打开当前登记的应用");
        project.launch = { command, args, url: localUrl(url) };
        }
      }
      project.allowLaunch = allowLaunch;
      project.setup = { status: allowLaunch ? "ready" : "needs_input", source: "manual", summary: allowLaunch ? "已保存自定义启动方式。" : "启动方式已停用。" };
      this.analyzeProject?.forget?.(project.path);
      return this.view(project);
    });
  }

  start(id) {
    if (this.disposed) return Promise.reject(new InputError("项目管理器已关闭"));
    if (this.removing.has(id)) return Promise.reject(new InputError("项目正在删除，请等待完成"));
    if (this.pendingStarts.has(id)) return this.pendingStarts.get(id).pending;
    const item = { cancelled: false };
    // Stop and remove must see a start even while it is waiting for a previous save.
    this.pendingStarts.set(id, item);
    item.pending = this.startProject(id, item).finally(() => this.pendingStarts.delete(id));
    return item.pending;
  }

  async startProject(id, item) {
    await this.queue;
    const project = await this.get(id);
    if (item.cancelled) return this.view(project);
    if (!this.view(project).canLaunch) throw new InputError("启动方式尚未就绪，请先自动识别启动方式");
    if (this.view(project).canStop) {
      const existing = this.runs.get(id);
      if (existing.background && existing.status === "failed") throw new InputError("部分项目服务可能仍在运行，请先停止后再打开");
      if (existing.url) await this.openPage(existing);
      else if (existing.getPageUrl && !existing.checkingPage) void this.verifyUrl(existing, existing.getPageUrl);
      return this.view(project);
    }
    // Reserve before awaiting so overlapping UI and Agent calls cannot start duplicate processes.
    const run = { status: "starting", url: null, child: null, server: null };
    this.runs.set(id, run);
    try {
      if (await canonicalPath(project.root) !== project.root) throw new InputError("项目位置发生变化，请重新添加");
      if (item.cancelled || run.status === "stopped") return this.view(project);
      if (project.kind === "web") {
        const preview = await staticPreview(project);
        if (item.cancelled || run.status === "stopped") await new Promise((done) => preview.server.close(done));
        else { Object.assign(run, preview); await this.openPage(run); }
      } else {
        const launch = project.kind === "script" ? (await validateProjectPlan(project, { ...project.launch,
          kind: "script", status: "ready", summary: "核对项目脚本启动方式" })).launch : project.launch;
        if (item.cancelled || run.status === "stopped") return this.view(project);
        if (launch.background) {
          await startScriptServices({ ...project, launch }, run, { spawnImpl: this.spawnImpl, env: projectEnvironment(),
            blockedPort: this.blockedPort, onReady: () => this.openPage(run) });
          return this.view(project);
        }
        const child = this.spawnImpl(launch.command, launch.args, {
          cwd: project.root, shell: false, detached: process.platform !== "win32", env: projectEnvironment(), stdio: ["ignore", "pipe", "pipe"],
        });
        run.child = child;
        child.on("error", () => { run.status = "failed"; run.error = "启动程序不可用，请检查是否已安装相应运行环境"; });
        child.on("close", (code) => {
          run.url = null;
          if (run.status === "stopped") return;
          run.status = code === 0 ? (project.kind === "desktop" ? "external" : "completed") : "failed";
          if (code !== 0) run.error = `项目已退出（退出码 ${code ?? "未知"}），请在项目自己的终端检查原因`;
        });
        let candidate = launch.url, tail = "";
        child.stdout?.on("data", (data) => {
          // Only retain a URL-sized tail; program output may contain credentials.
          tail = (tail + data.toString()).slice(-1000);
          const match = tail.match(/http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+(?:\/[^\s\x1b]*)?/);
          if (match) { try { candidate = localUrl(match[0]); } catch { /* Ignore unrecognized output. */ } }
        });
        child.stderr?.resume();
        await sleep(200);
        if (item.cancelled || run.status === "stopped") return this.view(project);
        if (run.status === "starting") run.status = "running";
        if (project.kind !== "desktop") {
          run.getPageUrl = () => candidate;
          void this.verifyUrl(run, run.getPageUrl);
        }
      }
    } catch (error) {
      if (item.cancelled || run.status === "stopped") return this.view(project);
      run.status = "failed"; run.error = error instanceof InputError ? error.message : "项目无法启动，请检查路径和运行环境";
      throw new InputError(run.error);
    }
    return this.view(project);
  }

  async verifyUrl(run, candidate) {
    if (run.checkingPage) return;
    run.checkingPage = true; run.openError = null;
    try {
    for (let attempt = 0; attempt < 30 && ["starting", "running"].includes(run.status); attempt++) {
      try {
        const url = candidate();
        if (url && Number(new URL(url).port || 80) !== this.blockedPort) {
          const response = await fetch(url, { signal: AbortSignal.timeout(500), redirect: "error" });
          await response.body?.cancel();
          if (response.ok && run.status === "running") {
            run.url = url; await this.openPage(run); return;
          }
        }
      } catch { /* An alive process can take time to expose its page. */ }
      await sleep(300);
    }
    if (run.status === "running") run.openError = "项目正在运行，暂时没有发现可打开的网页。可以再试一次；脚本工具可能没有窗口。";
    } finally { run.checkingPage = false; }
  }

  async openPage(run) {
    if (run.openingPage) return run.openingPage;
    const active = () => ["running", "external"].includes(run.status);
    if (!active() || !run.url) return;
    run.openError = null;
    run.openingPage = Promise.resolve().then(() => { if (active()) return this.openBrowser(run.url); })
      .then(() => { if (active()) run.pageOpened = true; })
      .catch(() => { if (active()) run.openError = "项目正在运行，但窗口未能打开。请再次点击“打开项目”。"; })
      .finally(() => { run.openingPage = null; });
    return run.openingPage;
  }

  async stop(id) {
    const starting = this.pendingStarts.get(id);
    if (starting) starting.cancelled = true;
    const project = await this.get(id), run = this.runs.get(id);
    if (!run || !this.view(project).canStop) return this.view(project);
    if (run.background) {
      await stopScriptServices(project, run, { spawnImpl: this.spawnImpl, env: projectEnvironment() });
      return this.view(project);
    }
    run.status = "stopped"; run.url = null; run.pageOpened = false; run.openError = null;
    if (run.server) await new Promise((done) => run.server.close(done));
    if (run.child?.pid) {
      const kill = (signal) => {
        try { if (process.platform !== "win32") process.kill(-run.child.pid, signal); else run.child.kill(signal); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      };
      kill("SIGTERM");
      const timer = setTimeout(() => { if (run.child.exitCode === null && run.child.signalCode === null) kill("SIGKILL"); }, 1500);
      timer.unref();
    }
    return this.view(project);
  }

  async remove(id, { removeOnly = false } = {}) {
    if (typeof removeOnly !== "boolean") throw new InputError("请选择有效的项目移除方式");
    if (this.removing.has(id)) throw new InputError("项目正在删除，请等待完成");
    this.removing.add(id);
    const starting = this.pendingStarts.get(id);
    if (starting) starting.cancelled = true;
    try {
      const inspection = this.inspections.get(id);
      if (inspection) { inspection.controller.abort(); await inspection.pending; }
      const project = await this.get(id), run = this.runs.get(id);
      this.analyzeProject?.forget?.(project.path);
      if (removeOnly && !run?.removalStopFailed) throw new InputError("请先尝试正常删除，再确认仅移除记录");
      if (!removeOnly) {
        try { await this.stop(id); }
        catch (error) {
          if (run) run.removalStopFailed = true;
          const detail = error instanceof InputError ? error.message : "停止项目时发生错误";
          throw Object.assign(new InputError(`未能停止项目：${detail}。可以仅移除记录，仍在运行的服务不会被停止。`),
            { code: "PROJECT_REMOVE_STOP_FAILED" });
        }
      }
      await starting?.pending.catch(() => {});
      const result = await this.change(() => {
        this.records = this.records.filter((item) => item.id !== id);
        return { removed: true, ...(removeOnly ? { servicesMayBeRunning: true } : {}) };
      });
      // Forgetting a failed run must also stop monitoring it, without killing its remaining services.
      if (run) { run.monitorController?.abort(); run.status = "detached"; }
      this.runs.delete(id);
      return result;
    } finally { this.removing.delete(id); }
  }

  async dispose() {
    this.disposed = true;
    for (const item of this.pendingStarts.values()) item.cancelled = true;
    for (const item of this.pendingAdds.values()) item.controller.abort();
    for (const item of this.inspections.values()) item.controller.abort();
    const stopping = [...this.runs.keys()].map((id) => this.stop(id));
    const pending = [...this.pendingAdds.values(), ...this.inspections.values(), ...this.pendingStarts.values()];
    await Promise.allSettled([...stopping, ...pending.map((item) => item.pending)]);
    this.analyzeProject?.dispose?.();
  }
}
