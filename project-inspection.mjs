import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { InputError } from "./core.mjs";

const excluded = /^(?:\..*|node_modules|venv|__pycache__|vendor|dist|build|coverage|.*(?:secret|credential|token|password).*|.*\.(?:pem|key|p12|pfx))$/i;
const scriptTypes = new Set([".sh", ".bash", ".zsh", ".command"]);
const scriptPrograms = new Map([...["bash", "sh", "zsh"].map((name) => [name, `/bin/${name}`]), ...["bash", "sh", "zsh"].map((name) => [`/bin/${name}`, `/bin/${name}`])]);
const textTypes = new Set([".md", ".txt", ".json", ".toml", ".yaml", ".yml", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".html", ".htm", ...scriptTypes]);

function redactProjectText(source) {
  return source
    .replace(/((?:[\w-]*(?:api[_-]?key|access[_-]?pass|token|secret|password|passwd|authorization)[\w-]*)["']?\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'[^']*'|[^\r\n,;]+)/gi, "$1[已隐藏]")
    .replace(/Bearer\s+[\w.+\/-]+/gi, "Bearer [已隐藏]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[已隐藏私钥]");
}

function inside(root, path) {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}

export async function projectPath(root, value = ".", { directory = false, executable = false } = {}) {
  if (typeof value !== "string" || value.includes("\0")) throw new InputError("项目内路径无效");
  const target = resolve(root, value);
  if (!inside(root, target)) throw new InputError("只能检查当前项目目录内的文件");
  let path, info;
  try { path = await realpath(target); info = await stat(path); }
  catch { throw new InputError("没有找到项目内的这个文件或目录"); }
  // Python virtual environments normally symlink the interpreter to the installed Python.
  const virtualPython = executable && /^(?:\.venv|venv)\/bin\/python[\d.]*$/.test(relative(root, target))
    && inside(root, await realpath(dirname(target))) && /^python[\d.]*$/.test(basename(path));
  if (!inside(root, path) && !virtualPython) throw new InputError("项目文件不能指向目录外部");
  if (directory ? !info.isDirectory() : !info.isFile()) throw new InputError(directory ? "工作目录必须是文件夹" : "启动入口必须是文件");
  if (executable) {
    try { await access(path, constants.X_OK); } catch { throw new InputError("项目内的启动程序不可执行"); }
  }
  return virtualPython ? target : path;
}

function readable(root, path) {
  return relative(root, path).split(sep).every((part) => !excluded.test(part));
}

function pageOffset(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new InputError("请使用有效的续读位置");
  return value;
}

// Page tool output without imposing a total reading budget on the inspection.
export function createProjectReader(root) {
  const readFiles = new Set();
  return {
    readFiles,
    async list(directory = ".", offset = 0) {
      pageOffset(offset);
      const path = await projectPath(root, directory, { directory: true });
      if (path !== root && !readable(root, path)) throw new InputError("此目录不参与项目检查");
      const entries = (await readdir(path, { withFileTypes: true })).filter((entry) => !excluded.test(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      const pythonEnvironments = [];
      for (const candidate of [".venv/bin/python", "venv/bin/python"]) {
        try { await projectPath(path, candidate, { executable: true }); pythonEnvironments.push(candidate); } catch { /* Optional runtime. */ }
      }
      const end = Math.min(offset + 120, entries.length);
      return { directory, files: entries.slice(offset, end).map((entry) => ({ name: entry.name, directory: entry.isDirectory() })),
        pythonEnvironments, truncated: end < entries.length, nextOffset: end < entries.length ? end : null };
    },
    async read(file, offset = 0, { signal } = {}) {
      pageOffset(offset);
      const path = await projectPath(root, file);
      if (!readable(root, path) || !textTypes.has(extname(path).toLowerCase())) throw new InputError("只能读取项目说明、依赖清单和文本源码，不能读取凭据或隐藏文件");
      const source = await readFile(path, { encoding: "utf8", signal });
      if (source.includes("\0")) throw new InputError("不能读取二进制文件");
      // Redact before paging so a credential split across pages cannot escape redaction.
      const safeText = redactProjectText(source);
      let end = Math.min(offset + 24_000, safeText.length);
      if (end < safeText.length && /[\uD800-\uDBFF]/.test(safeText[end - 1])) end--;
      readFiles.add(relative(root, path));
      return { file, text: safeText.slice(offset, end), truncated: end < safeText.length, nextOffset: end < safeText.length ? end : null };
    },
  };
}

export async function validateScriptCommand(root, launch) {
  const command = scriptPrograms.get(launch?.command), args = launch?.args;
  if (!command || !Array.isArray(args) || args.length < 1 || args.length > 30
    || args.some((arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > 1000)
    || args[0].startsWith("-")) throw new InputError("脚本启动必须使用 bash、sh 或 zsh 和项目内已有的脚本文件，不能使用内联命令");
  const file = await projectPath(root, args[0]);
  if (!readable(root, file) || !scriptTypes.has(extname(file).toLowerCase())) throw new InputError("启动或停止脚本必须是项目内可读取的 Shell 脚本");
  try { await access(file, constants.R_OK); await access(command, constants.X_OK); }
  catch { throw new InputError("无法读取项目脚本，或电脑未安装对应的 Shell 程序"); }
  return { command, args: [file, ...args.slice(1)] };
}

function localPlanUrl(value) {
  try {
    if (typeof value !== "string") throw new Error();
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
      || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
    return parsed.href;
  } catch { throw new InputError("自动识别的页面或健康检查地址必须是不含凭据的本机 HTTP 地址"); }
}

export async function validateProjectPlan(project, plan) {
  const summary = typeof plan.summary === "string" ? plan.summary.trim().slice(0, 240) : "";
  if (!summary) throw new InputError("请说明实际识别到的启动方式或缺口");
  if (plan.status === "needs_input") return { setup: { status: "needs_input", source: "pi", summary } };
  if (plan.status !== "ready") throw new InputError("项目检查结果状态无效");
  const root = await projectPath(project.root, plan.directory || ".", { directory: true });
  const setup = { status: "ready", source: "pi", summary };
  if (plan.kind === "web") {
    const file = await projectPath(root, plan.entry || "index.html");
    if (!/\.html?$/i.test(file)) throw new InputError("静态网页入口必须是 HTML 文件");
    return { root, kind: "web", entry: relative(root, file), launch: null, setup };
  }
  if (plan.kind === "desktop" && project.kind === "desktop") return { root, kind: "desktop", launch: project.launch, setup };
  if (plan.kind === "script" || scriptPrograms.has(plan.command)) {
    const launch = await validateScriptCommand(root, plan);
    if (plan.background !== undefined && typeof plan.background !== "boolean") throw new InputError("脚本后台运行标记必须是布尔值");
    const background = plan.background === true;
    const url = plan.url ? localPlanUrl(plan.url) : null;
    const stop = plan.stop ? await validateScriptCommand(root, plan.stop) : null;
    if (plan.healthUrls !== undefined && !Array.isArray(plan.healthUrls)) throw new InputError("服务健康检查地址必须是数组");
    const healthUrls = [...new Set((plan.healthUrls || []).map(localPlanUrl))];
    if (background && (!url || !stop || !healthUrls.length)) throw new InputError("后台启动脚本需要页面地址、各服务健康检查地址和项目内的停止脚本");
    return { root, kind: "script", entry: null, launch: { ...launch, url, background, stop, healthUrls }, setup };
  }
  const { command, args } = plan;
  if (typeof command !== "string" || !Array.isArray(args) || args.length < 1 || args.length > 30
    || args.some((arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > 1000)) throw new InputError("启动程序或参数无效");
  let program = command, kind;
  if (["npm", "pnpm", "yarn", "bun"].includes(command)) {
    if (args.length !== 2 || args[0] !== "run" || !/^[\w:-]+$/.test(args[1])) throw new InputError("请使用项目中已有的运行脚本，例如 npm run dev");
    const manifestPath = await projectPath(root, "package.json");
    if (!readable(root, manifestPath)) throw new InputError("项目清单必须位于可读取的项目目录内");
    let manifest;
    try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
    catch { throw new InputError("项目的 package.json 不是有效的 JSON 文件"); }
    if (typeof manifest?.scripts?.[args[1]] !== "string") throw new InputError("项目中不存在这个启动脚本");
    kind = "node";
  } else if (command === "node") {
    if (!/\.(?:mjs|cjs|js)$/i.test(args[0]) || args[0].startsWith("-")) throw new InputError("Node 入口必须是项目内已有的脚本文件");
    await projectPath(root, args[0]); kind = "node";
  } else if (["python", "python3"].includes(command) || /(?:^|\/)python[\d.]*$/.test(command)) {
    if (!["python", "python3"].includes(command)) program = await projectPath(root, command, { executable: true });
    if (args[0] === "-m") {
      if (args[1] === "streamlit" && args[2] === "run") await projectPath(root, args[3]);
      else if (args[1] === "uvicorn" && /^[\w.]+:\w+$/.test(args[2] || "")) {
        await projectPath(root, `${args[2].split(":")[0].replaceAll(".", "/")}.py`);
      } else if (args[1] === "flask" && args[2] === "--app" && args.includes("run")) {
        await projectPath(root, `${args[3].replace(/\.py$/, "")}.py`);
      } else throw new InputError("当前仅支持已确认入口的 Streamlit、Uvicorn 或 Flask 模块启动");
    } else {
      if (!args[0].endsWith(".py") || args[0].startsWith("-")) throw new InputError("Python 入口必须是项目内已有的脚本文件");
      await projectPath(root, args[0]);
    }
    kind = "python";
  } else throw new InputError("无法自动确认这个启动程序，请说明具体缺口");
  const url = plan.url ? localPlanUrl(plan.url) : null;
  return { root, kind, entry: null, launch: { command: program, args, url }, setup };
}
