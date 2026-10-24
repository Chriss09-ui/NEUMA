import type { SpawnOptions } from "node:child_process";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const SOURCE_ROOT = fileURLToPath(new URL(import.meta.url).searchParams.get("sourceRoot") ?? new URL("../", import.meta.url));
const require = createRequire(join(SOURCE_ROOT, "package.json"));
interface Inputs { hashes: Record<string, { hash: string; mode: number }>; hash: string }
interface BuildReceipt { sourceRoot: string; sourceHash: string; outputs: Record<string, string> }
interface PackageManifest { name: string; version: string; [key: string]: unknown }
const errorCode = (error: unknown) => error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
export const BUILD_PATH = "dist/ts-build/package";
const PROJECTS = ["node", "browser", "frame", "test", "contracts"];
const TREES = ["src", "public", "test", "scripts", "bin", "native", ".github/scripts", "docs/images"];
const ROOT_FILES = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "README.md"];
export const REQUIRED_ENTRIES = ["bin/neuma.cjs", "src/server.mjs", "src/app-metadata.mjs",
  "src/installation/installation-cli.mjs", "src/installation/installation-runtime.mjs",
  "src/materials/material-parser-child.mjs", "src/services/node-service-worker.mjs",
  "src/services/python-service-worker.py", "src/services/mcp-bridge.mjs",
  "public/application-frame-bridge.js", "public/index.html", "public/style.css"];
const json = async <T,>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const portable = (path: string) => path.split(sep).join("/");
const declaration = (path: string) => /\.d\.(?:ts|mts|cts)$/.test(path);
const typed = (path: string) => /\.(?:ts|mts|cts)$/.test(path);
const emittedName = (path: string) => path.replace(/\.mts$/, ".mjs").replace(/\.cts$/, ".cjs").replace(/\.ts$/, ".js");

async function walk(root: string, path: string): Promise<string[]> {
  const info = await lstat(join(root, path));
  if (info.isSymbolicLink()) throw new Error(`构建输入不能是符号链接：${path}`);
  if (info.isFile()) return [portable(path)];
  if (!info.isDirectory()) throw new Error(`构建输入必须为普通文件或目录：${path}`);
  const result: string[] = [];
  for (const entry of (await readdir(join(root, path))).sort()) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    result.push(...await walk(root, join(path, entry)));
  }
  return result;
}

export async function sourceInputs(root: string): Promise<Inputs> {
  const files = [...ROOT_FILES];
  for (const tree of TREES) {
    try { files.push(...await walk(root, tree)); }
    catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
  }
  files.push(...(await readdir(root)).filter((name) => /^tsconfig(?:\.[\w-]+)?\.json$/.test(name)));
  const hashes: Inputs["hashes"] = {};
  for (const path of [...new Set(files)].sort()) {
    const info = await lstat(join(root, path));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`构建输入无效：${path}`);
    hashes[path] = { hash: digest(await readFile(join(root, path))), mode: info.mode & 0o777 };
  }
  return { hashes, hash: digest(JSON.stringify(hashes)) };
}

function projectFor(path: string) {
  if (path.startsWith("src/contracts/") && declaration(path)) return "contracts";
  if (["public/application-frame-bridge.ts", "public/frame-globals.d.ts"].includes(path)) return "frame";
  if (path.startsWith("public/")) return "browser";
  if (path.startsWith("test/")) return "test";
  return "node";
}

export function execute(command: string, args: readonly string[], options: SpawnOptions & { capture?: boolean } = {}): Promise<string> {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true, ...options });
    let output = "";
    if (options.capture) {
      child.stdout!.on("data", (chunk) => { output += chunk; });
      child.stderr!.on("data", (chunk) => { output += chunk; });
    }
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? done(output)
      : reject(new Error(`命令失败（${signal ?? code}）：${command}\n${output.slice(0, 16000)}`)));
  });
}

function compiler() {
  return join(dirname(require.resolve("typescript/package.json")), "bin/tsc");
}

function checkOwnedSources(inputs: Inputs) {
  const paths = new Set(Object.keys(inputs.hashes));
  for (const path of paths) {
    if (!/\.(?:js|mjs|cjs)$/.test(path) || path === "scripts/build.mjs") continue;
    const base = path.replace(/\.(?:js|mjs|cjs)$/, "");
    if ([".ts", ".mts", ".cts"].some(extension => paths.has(base + extension))) throw new Error(`同名源码会覆盖产物：${path}`);
    throw new Error(`自有 JavaScript 源码未迁移为 TypeScript：${path}`);
  }
}

export async function checkTypes(root = SOURCE_ROOT, inputs?: Inputs) {
  inputs ??= await sourceInputs(root);
  checkOwnedSources(inputs);
  const files = Object.keys(inputs.hashes).filter(typed);
  for (const project of PROJECTS) {
    const owned = files.filter((path) => projectFor(path) === project);
    if (!owned.length) continue;
    const config = join(root, `tsconfig.${project}.json`);
    const shown: { files?: string[]; compilerOptions: { strict?: boolean; noCheck?: boolean; noEmit?: boolean; allowJs?: boolean } } = JSON.parse(await execute(process.execPath, [compiler(), "--showConfig", "-p", config], { capture: true }));
    const included = new Set((shown.files ?? []).map((path) => resolve(root, path)));
    if (shown.compilerOptions.strict !== true || shown.compilerOptions.noCheck === true || shown.compilerOptions.allowJs === true || shown.compilerOptions.noEmit !== true)
      throw new Error(`类型配置必须严格检查且不发射，禁止 allowJs/noCheck：${project}`);
    for (const path of owned) if (!included.has(resolve(root, path))) throw new Error(`TS 文件未进入类型检查：${path}`);
    await execute(process.execPath, [compiler(), "-p", config, "--pretty", "false"], { capture: true });
  }
  if (!files.length) throw new Error("类型检查没有 TypeScript 输入");
  return files.length;
}

export async function checkSourceLocks(root: string, { synchronize = false } = {}) {
  const manifest = await json<PackageManifest>(join(root, "package.json"));
  const lock = await json<PackageManifest & { packages?: Record<string, PackageManifest> }>(join(root, "package-lock.json"));
  if (lock.name !== manifest.name || lock.version !== manifest.version || lock.packages?.[""]?.version !== manifest.version
    || ["dependencies", "devDependencies", "os", "cpu", "bin"].some((key) => !isDeepStrictEqual(lock.packages?.[""]?.[key], manifest[key])))
    throw new Error("package.json 与锁文件版本或依赖不一致，请先同步锁文件后打包。");
  if (synchronize) await writeFile(join(root, "npm-shrinkwrap.json"), JSON.stringify(lock, null, 2) + "\n");
  else if (!isDeepStrictEqual(await json(join(root, "npm-shrinkwrap.json")), lock))
    throw new Error("npm-shrinkwrap.json 与 package-lock.json 不一致");
  return manifest;
}

export async function validateArtifact(root: string) {
  for (const path of REQUIRED_ENTRIES) {
    const info = await lstat(join(root, path));
    if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new Error(`缺少构建入口：${path}`);
  }
  const bridge = await readFile(join(root, "public/application-frame-bridge.js"), "utf8");
  if (/^\s*(?:import\s|export\s)|\brequire\s*\(/m.test(bridge)) throw new Error("iframe bridge 必须保持普通脚本");
  const html = await readFile(join(root, "public/index.html"), "utf8");
  for (const [, path] of html.matchAll(/<script[^>]+src="\/([^"?#]+)"/g)) await lstat(join(root, "public", path!));
  for (const path of await walk(root, "public")) {
    if (!path.endsWith(".js")) continue;
    const text = await readFile(join(root, path), "utf8");
    for (const [, dependency] of text.matchAll(/(?:from\s*|import\s*)["'](\.\.?\/[^"']+)["']/g))
      await lstat(resolve(root, dirname(path), dependency!));
  }
}

async function copy(root: string, path: string, destination: string) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, path), destination);
  await chmod(destination, (await lstat(join(root, path))).mode & 0o777);
}

export async function assertFreshBuild(root: string) {
  const marker = await json<BuildReceipt>(join(root, ".neuma-build.json"));
  if ((await sourceInputs(marker.sourceRoot)).hash !== marker.sourceHash) throw new Error("构建产物已过期，请重新构建");
  for (const [path, hash] of Object.entries(marker.outputs))
    if (digest(await readFile(join(root, path))) !== hash) throw new Error(`构建产物缺失或已改变：${path}`);
  for (const tree of ["src", "public", "test", "scripts", "bin", "native", "docs/images", ".github/scripts"]) {
    let files;
    try { files = await walk(root, tree); } catch (error) { if (errorCode(error) === "ENOENT") continue; throw error; }
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
        "--outDir", join(work, project)], { capture: true });
    }
    for (const [output, path] of owners) {
      if (typed(path)) await copy(join(work, projectFor(path)), output, join(assembled, output));
      else await copy(root, path, join(assembled, output));
    }
    const tool = await json<{ version: string }>(require.resolve("typescript/package.json"));
    const stagedManifest = { ...manifest, scripts: { start: "node bin/neuma.cjs" },
      neumaBuild: { format: 1, sourceHash: inputs.hash, typescript: tool.version } };
    await writeFile(join(assembled, "package.json"), JSON.stringify(stagedManifest, null, 2) + "\n");
    await validateArtifact(assembled);
    if ((await sourceInputs(root)).hash !== inputs.hash) throw new Error("构建期间源码已改变，请重新构建");
    const outputs: Record<string, string> = {};
    for (const path of owners.keys()) outputs[path] = digest(await readFile(join(assembled, path)));
    await writeFile(join(assembled, ".neuma-build.json"), JSON.stringify({ version: 1, id: randomUUID(),
      sourceRoot: root, sourceHash: inputs.hash, outputs }, null, 2) + "\n");
    try { await rename(destination, join(work, "previous")); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    await rename(assembled, destination);
    process.stdout.write(`构建完成：${destination}（${typedFiles.length} 个 TypeScript 实现）\n`);
    return destination;
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
    await rm(lockPath, { recursive: true, force: true });
  }
}

export async function runBuildCommand() {
  const [command = "build", ...args] = process.argv.slice(2);
  if (command === "typecheck") {
    process.stdout.write(`严格类型检查通过：${await checkTypes()} 个 TypeScript 文件\n`); return;
  }
  if (command === "guard") throw new Error("源码目录不能直接打包或发布；请使用 npm run package:pack 生成经过编译与检查的安装包。");
  if (!["build", "start", "test", "package", "prepare", "check"].includes(command)) throw new Error("构建命令必须为 build、typecheck、start、test、package 或 check");
  if (["package", "prepare"].includes(command)) await checkSourceLocks(SOURCE_ROOT, { synchronize: true });
  const root = await buildProject();
  if (command === "package") {
    const artifact = await import(pathToFileURL(join(root, "scripts/package-artifact.mjs")).href);
    await artifact.runPackageCommand({ root: SOURCE_ROOT, command: args[0] ?? "pack", requested: args[1] });
  }
  if (command === "check") {
    const preview = args[0] === "preview";
    const checker = await import(pathToFileURL(join(root, preview ? "scripts/check-preview-release.mjs" : "scripts/check-release.mjs")).href);
    const result = preview ? await checker.checkPreviewRelease(root, { artifact: true }) : await checker.checkRelease(root);
    if (preview) { const source = await checker.checkPreviewRelease(SOURCE_ROOT); result.failures.unshift(...source.failures); result.ok &&= source.ok; }
    if (!result.ok) throw new Error(result.failures.join("\n"));
    process.stdout.write(preview ? "Apple 芯片 Mac 试用版源配置与编译产物检查通过。\n" : "发布检查通过。\n");
  }
  if (command === "test") await execute(process.execPath, [join(root, "scripts/run-tests.mjs"), ...args], { cwd: root });
  if (command === "start") await execute(process.execPath, ["--env-file=" + join(SOURCE_ROOT, ".env"),
    join(root, "scripts/start-source.mjs"), SOURCE_ROOT], { cwd: SOURCE_ROOT });
}
