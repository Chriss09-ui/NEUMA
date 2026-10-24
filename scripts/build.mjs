import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const SOURCE_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const BUILD_PATH = "dist/ts-build/package";
const PROJECTS = ["node", "browser", "frame", "test", "contracts"];
const TREES = ["src", "public", "test", "scripts", "bin", "native", ".github/scripts", "docs/images"];
const ROOT_FILES = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "README.md"];
export const REQUIRED_ENTRIES = ["bin/neuma.cjs", "src/server.mjs", "src/app-metadata.mjs",
  "src/installation/installation-cli.mjs", "src/installation/installation-runtime.mjs",
  "src/materials/material-parser-child.mjs", "src/services/node-service-worker.mjs",
  "src/services/python-service-worker.py", "src/services/mcp-bridge.mjs",
  "public/application-frame-bridge.js", "public/index.html", "public/style.css"];
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const portable = (path) => path.split(sep).join("/");
const declaration = (path) => /\.d\.(?:ts|mts|cts)$/.test(path);
const typed = (path) => /\.(?:ts|mts|cts)$/.test(path);
const emittedName = (path) => path.replace(/\.mts$/, ".mjs").replace(/\.cts$/, ".cjs").replace(/\.ts$/, ".js");

async function walk(root, path) {
  const info = await lstat(join(root, path));
  if (info.isSymbolicLink()) throw new Error(`构建输入不能是符号链接：${path}`);
  if (info.isFile()) return [portable(path)];
  if (!info.isDirectory()) throw new Error(`构建输入必须为普通文件或目录：${path}`);
  const result = [];
  for (const entry of (await readdir(join(root, path))).sort()) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    result.push(...await walk(root, join(path, entry)));
  }
  return result;
}

export async function sourceInputs(root) {
  const files = [...ROOT_FILES];
  for (const tree of TREES) {
    try { files.push(...await walk(root, tree)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  files.push(...(await readdir(root)).filter((name) => /^tsconfig(?:\.[\w-]+)?\.json$/.test(name)));
  const hashes = {};
  for (const path of [...new Set(files)].sort()) {
    const info = await lstat(join(root, path));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`构建输入无效：${path}`);
    hashes[path] = { hash: digest(await readFile(join(root, path))), mode: info.mode & 0o777 };
  }
  return { hashes, hash: digest(JSON.stringify(hashes)) };
}

function projectFor(path) {
  if (path.startsWith("src/contracts/") && declaration(path)) return "contracts";
  if (["public/application-frame-bridge.ts", "public/frame-globals.d.ts"].includes(path)) return "frame";
  if (path.startsWith("public/")) return "browser";
  if (path.startsWith("test/")) return "test";
  return "node";
}

export function execute(command, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true, ...options });
    let output = "";
    if (options.capture) {
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
    }
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? done(output)
      : reject(new Error(`命令失败（${signal ?? code}）：${command}\n${output.slice(0, 16000)}`)));
  });
}

function compiler() {
  return join(dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))), "bin/tsc");
}

export async function checkTypes(root = SOURCE_ROOT, inputs) {
  inputs ??= await sourceInputs(root);
  const files = Object.keys(inputs.hashes).filter(typed);
  for (const project of PROJECTS) {
    const owned = files.filter((path) => projectFor(path) === project);
    if (!owned.length) continue;
    const config = join(root, `tsconfig.${project}.json`);
    const shown = JSON.parse(await execute(process.execPath, [compiler(), "--showConfig", "-p", config], { capture: true }));
    const included = new Set((shown.files ?? []).map((path) => resolve(root, path)));
    if (shown.compilerOptions.strict !== true || shown.compilerOptions.noCheck === true || shown.compilerOptions.noEmit !== true)
      throw new Error(`类型配置必须严格检查且不发射：${project}`);
    for (const path of owned) if (!included.has(resolve(root, path))) throw new Error(`TS 文件未进入类型检查：${path}`);
    await execute(process.execPath, [compiler(), "-p", config, "--noCheck", "false"], { capture: true });
  }
  if (!files.length) throw new Error("类型检查没有 TypeScript 输入");
  return files.length;
}

export async function checkSourceLocks(root, { synchronize = false } = {}) {
  const manifest = await json(join(root, "package.json"));
  const lock = await json(join(root, "package-lock.json"));
  if (lock.name !== manifest.name || lock.version !== manifest.version || lock.packages?.[""]?.version !== manifest.version
    || ["dependencies", "devDependencies", "os", "cpu", "bin"].some((key) => !isDeepStrictEqual(lock.packages?.[""]?.[key], manifest[key])))
    throw new Error("package.json 与锁文件版本或依赖不一致，请先同步锁文件后打包。");
  if (synchronize) await writeFile(join(root, "npm-shrinkwrap.json"), JSON.stringify(lock, null, 2) + "\n");
  else if (!isDeepStrictEqual(await json(join(root, "npm-shrinkwrap.json")), lock))
    throw new Error("npm-shrinkwrap.json 与 package-lock.json 不一致");
  return manifest;
}

export async function validateArtifact(root) {
  for (const path of REQUIRED_ENTRIES) {
    const info = await lstat(join(root, path));
    if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new Error(`缺少构建入口：${path}`);
  }
  const bridge = await readFile(join(root, "public/application-frame-bridge.js"), "utf8");
  if (/^\s*(?:import\s|export\s)|\brequire\s*\(/m.test(bridge)) throw new Error("iframe bridge 必须保持普通脚本");
  const html = await readFile(join(root, "public/index.html"), "utf8");
  for (const [, path] of html.matchAll(/<script[^>]+src="\/([^"?#]+)"/g)) await lstat(join(root, "public", path));
  for (const path of await walk(root, "public")) {
    if (!path.endsWith(".js")) continue;
    const text = await readFile(join(root, path), "utf8");
    for (const [, dependency] of text.matchAll(/(?:from\s*|import\s*)["'](\.\.?\/[^"']+)["']/g))
      await lstat(resolve(root, dirname(path), dependency));
  }
}

async function copy(root, path, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, path), destination);
  await chmod(destination, (await lstat(join(root, path))).mode & 0o777);
}

export async function assertFreshBuild(root) {
  const marker = await json(join(root, ".neuma-build.json"));
  if ((await sourceInputs(marker.sourceRoot)).hash !== marker.sourceHash) throw new Error("构建产物已过期，请重新构建");
  for (const [path, hash] of Object.entries(marker.outputs))
    if (digest(await readFile(join(root, path))) !== hash) throw new Error(`构建产物缺失或已改变：${path}`);
  for (const tree of ["src", "public", "test", "scripts", "bin", "native", "docs/images", ".github/scripts"]) {
    let files;
    try { files = await walk(root, tree); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const path of files) if (!Object.hasOwn(marker.outputs, path)) throw new Error(`构建产物包含未登记文件：${path}`);
  }
  await validateArtifact(root);
  return marker;
}

export async function buildProject({ root = SOURCE_ROOT } = {}) {
  root = resolve(root);
  const parent = join(root, "dist/ts-build"), destination = join(root, BUILD_PATH), lockPath = join(parent, ".lock");
  await mkdir(parent, { recursive: true });
  await mkdir(lockPath).catch(() => { throw new Error("已有构建运行，请等待；中断后确认无构建进程再清理 dist/ts-build/.lock"); });
  let work;
  try {
    await rm(join(destination, ".neuma-build.json"), { force: true });
    const manifest = await checkSourceLocks(root);
    const inputs = await sourceInputs(root);
    await checkTypes(root, inputs);
    work = await mkdtemp(join(parent, ".work-"));
    const assembled = join(work, "package");
    await mkdir(assembled);
    const owners = new Map();
    for (const path of Object.keys(inputs.hashes)) {
      if (declaration(path)) continue;
      const output = emittedName(path);
      if (owners.has(output)) throw new Error(`同名源码会覆盖产物：${owners.get(output)}、${path}`);
      owners.set(output, path);
    }
    const typedFiles = Object.keys(inputs.hashes).filter((path) => typed(path) && !declaration(path));
    for (const project of PROJECTS) {
      if (!typedFiles.some((path) => projectFor(path) === project)) continue;
      await execute(process.execPath, [compiler(), "-p", join(root, `tsconfig.${project}.json`), "--noEmit", "false",
        "--noCheck", "--outDir", join(work, project)], { capture: true });
    }
    for (const [output, path] of owners) {
      if (typed(path)) await copy(join(work, projectFor(path)), output, join(assembled, output));
      else await copy(root, path, join(assembled, output));
    }
    const tool = await json(fileURLToPath(import.meta.resolve("typescript/package.json")));
    const stagedManifest = { ...manifest, scripts: { start: "node bin/neuma.cjs" },
      neumaBuild: { format: 1, sourceHash: inputs.hash, typescript: tool.version } };
    await writeFile(join(assembled, "package.json"), JSON.stringify(stagedManifest, null, 2) + "\n");
    await validateArtifact(assembled);
    if ((await sourceInputs(root)).hash !== inputs.hash) throw new Error("构建期间源码已改变，请重新构建");
    const outputs = {};
    for (const path of owners.keys()) outputs[path] = digest(await readFile(join(assembled, path)));
    await writeFile(join(assembled, ".neuma-build.json"), JSON.stringify({ version: 1, id: randomUUID(),
      sourceRoot: root, sourceHash: inputs.hash, outputs }, null, 2) + "\n");
    try { await rename(destination, join(work, "previous")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(assembled, destination);
    process.stdout.write(`构建完成：${destination}（${typedFiles.length} 个 TypeScript 实现，旧 JS 原样复制）\n`);
    return destination;
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function main() {
  const [command = "build", ...args] = process.argv.slice(2);
  if (command === "typecheck") {
    process.stdout.write(`严格类型检查通过：${await checkTypes()} 个 TypeScript 文件\n`); return;
  }
  if (!["build", "start", "test"].includes(command)) throw new Error("构建命令必须为 build、typecheck、start 或 test");
  const root = await buildProject();
  if (command === "test") await execute(process.execPath, [join(root, "scripts/run-tests.mjs"), ...args], { cwd: root });
  if (command === "start") await execute(process.execPath, ["--env-file=" + join(SOURCE_ROOT, ".env"),
    join(root, "scripts/start-source.mjs"), SOURCE_ROOT], { cwd: SOURCE_ROOT });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
