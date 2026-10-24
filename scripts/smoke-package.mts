import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPreviewRelease } from "./check-preview-release.mjs";
import { execute } from "./build.mjs";

if (process.platform === "win32") throw new Error("Windows 请在真实终端验证 Ctrl+C；child.kill(SIGINT) 不能替代控制台验收。");
if (!process.argv[2]) throw new Error("请提供 npm pack 实际生成的 tgz 路径");
const archive = resolve(process.argv[2]);
const cleanInstall = process.argv[3] === "--install";
if ((await lstat(archive)).size > 16 * 1024 * 1024) throw new Error("安装包超过本次轻量测试预算，需要先确认更大的测试预算。");
const temporary = await mkdtemp(join(tmpdir(), "neuma-packed-test-"));
let root = join(temporary, "package");
const dataDir = join(temporary, "用户 数据");
let child: ChildProcessByStdio<null, Readable, Readable> | null = null;

async function permissions(path: string, readonly: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("安装包包含非预期链接。");
  if (info.isDirectory()) {
    if (!readonly) await chmod(path, 0o700);
    for (const entry of await readdir(path)) await permissions(join(path, entry), readonly);
    if (readonly) await chmod(path, 0o555);
  } else await chmod(path, readonly ? 0o444 | (info.mode & 0o111) : 0o600 | (info.mode & 0o111));
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  const timeout = setTimeout(() => child?.kill("SIGKILL"), 5000);
  child.kill("SIGINT");
  try { assert.equal((await exited)[0], 0); } finally { clearTimeout(timeout); child = null; }
}

async function start(port?: number): Promise<string> {
  let text = "", errors = "";
  const currentChild = child = spawn(process.execPath, [join(root, "bin", "neuma.cjs"), "--no-open", "--data-dir", dataDir,
    ...(port === undefined ? [] : ["--port", String(port)])], {
    cwd: temporary, env: { PATH: process.env.PATH, NODE_OPTIONS: "--max-old-space-size=128" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  currentChild.stdout.on("data", (chunk) => { text += chunk; });
  currentChild.stderr.on("data", (chunk) => { errors += chunk; });
  return new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error(`安装包启动未就绪：${errors.slice(0, 1000)}`)), 8000);
    const received = () => {
      const match = text.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match && text.includes("Ctrl+C")) { clearTimeout(timeout); currentChild.stdout.removeListener("data", received); done(match[0]); }
    };
    currentChild.stdout.on("data", received);
    currentChild.once("exit", (code) => { clearTimeout(timeout); if (!text.includes("Ctrl+C")) reject(new Error(`安装包提前退出${code}：${errors.slice(0, 1000)}`)); });
    currentChild.once("error", reject);
  });
}

try {
  const extraction = spawn("tar", ["-xzf", archive, "-C", temporary], { stdio: "ignore" });
  assert.equal((await once(extraction, "exit"))[0], 0);
  const checked = await checkPreviewRelease(root, { artifact: true });
  assert.equal(checked.ok, true, checked.failures.join("\n"));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (cleanInstall) {
    const prefix = join(temporary, "installed");
    await execute("npm", ["install", "--prefix", prefix,
      "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--fetch-retries=2", "--fetch-timeout=30000", archive], { capture: true });
    root = join(prefix, "node_modules", manifest.name);
    assert.equal((await checkPreviewRelease(root, { artifact: true })).ok, true);
  } else {
    // Resolve dependencies outside the readonly package; this is explicitly not a clean install.
    await symlink(process.argv[4] ? join(resolve(process.argv[4]), "node_modules") : fileURLToPath(new URL("../node_modules", import.meta.url)), join(temporary, "node_modules"), "dir");
  }
  await permissions(root, true);
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as AddressInfo).port; await new Promise((done) => reservation.close(done));
  const url = await start(port);
  const request = (path: string, options: RequestInit = {}) => fetch(new URL(path!, url), { signal: AbortSignal.timeout(5000), ...options });
  const health = objectFields(await (await request("api/health")).json());
  assert.equal(health.ok, true); assert.equal(health.llmConfigured, false);
  const html = await (await request("")).text();
  assert.match(html, /agents-list/);
  const pending = [...html.matchAll(/<script[^>]+src="(\/[^"?#]+)"/g)].map((match) => match[1]!);
  const loaded = new Set();
  while (pending.length) {
    const path = pending.pop()!;
    if (loaded.has(path)) continue;
    loaded.add(path);
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") ?? "", /javascript/, path);
    const source = await response.text();
    for (const [, dependency] of source.matchAll(/(?:from\s*|import\s*)["'](\.\.?\/[^"']+)["']/g))
      pending.push(new URL(dependency!, new URL(path!, url)).pathname);
  }
  for (const path of ["vendor/marked.mjs", "vendor/katex/katex.mjs", "vendor/katex/katex.min.css"])
    assert.equal((await request(path)).status, 200, path);
  assert.equal((await request("api/settings", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture-package-model" }) })).status, 200);
  await stop();
  assert.equal(await start(), url);
  assert.equal(objectFields(await (await request("api/settings")).json()).model, "fixture-package-model");
  await stop();
  process.stdout.write(`实际 tgz 从任意目录、只读程序目录启动：通过；${loaded.size} 个前端模块、vendor、设置保存、重启与 Ctrl+C：通过。\n`
    + (cleanInstall ? "独立临时 npm 安装生产依赖：通过；未复用仓库 node_modules。\n" : "依赖复用仓库 node_modules；本项是解包 smoke，不是干净安装验收。\n"));
} finally {
  try { await stop(); }
  finally { await permissions(root, false).catch(() => {}); await rm(temporary, { recursive: true, force: true }); }
}
