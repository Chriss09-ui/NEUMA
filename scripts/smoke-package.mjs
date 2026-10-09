import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (process.platform === "win32") throw new Error("Windows 请在真实终端验证 Ctrl+C；child.kill(SIGINT) 不能替代控制台验收。");
const archive = resolve(process.argv[2] ?? "dist/chrissliu-neuma-0.1.0.tgz");
if ((await lstat(archive)).size > 16 * 1024 * 1024) throw new Error("安装包超过本次轻量测试预算，需要先确认更大的测试预算。");
const temporary = await mkdtemp(join(tmpdir(), "neuma-packed-test-"));
const root = join(temporary, "package"), dataDir = join(temporary, "用户 数据");
let child;

async function permissions(path, readonly) {
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

async function start(port) {
  let text = "", errors = "";
  child = spawn(process.execPath, [join(root, "bin", "neuma.cjs"), "--no-open", "--data-dir", dataDir,
    ...(port === undefined ? [] : ["--port", String(port)])], {
    cwd: temporary, env: { PATH: process.env.PATH, NODE_OPTIONS: "--max-old-space-size=128" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { text += chunk; });
  child.stderr.on("data", (chunk) => { errors += chunk; });
  return new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error(`安装包启动未就绪：${errors.slice(0, 1000)}`)), 8000);
    const received = () => {
      const match = text.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match && text.includes("Ctrl+C")) { clearTimeout(timeout); child.stdout.removeListener("data", received); done(match[0]); }
    };
    child.stdout.on("data", received);
    child.once("exit", (code) => { clearTimeout(timeout); if (!text.includes("Ctrl+C")) reject(new Error(`安装包提前退出${code}：${errors.slice(0, 1000)}`)); });
    child.once("error", reject);
  });
}

try {
  const extraction = spawn("tar", ["-xzf", archive, "-C", temporary], { stdio: "ignore" });
  assert.equal((await once(extraction, "exit"))[0], 0);
  await permissions(root, true);
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port; await new Promise((done) => reservation.close(done));
  const url = await start(port);
  const request = (path, options) => fetch(new URL(path, url), { signal: AbortSignal.timeout(5000), ...options });
  const health = await (await request("api/health")).json();
  assert.equal(health.ok, true); assert.equal(health.llmConfigured, false);
  assert.match(await (await request("")).text(), /agents-list/);
  assert.equal((await request("app.js")).status, 200);
  assert.equal((await request("api/settings", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture-package-model" }) })).status, 200);
  await stop();
  assert.equal(await start(), url);
  assert.equal((await (await request("api/settings")).json()).model, "fixture-package-model");
  await stop();
  process.stdout.write("实际 tgz 从任意目录、只读程序目录启动：通过；网页资源、设置保存、重启与 Ctrl+C：通过。\n仅验证安装入口；未安装/下载 SDK 依赖，未冒充干净 npm 安装或 Windows/Linux 验收。\n");
} finally {
  try { await stop(); }
  finally { await permissions(root, false).catch(() => {}); await rm(temporary, { recursive: true, force: true }); }
}
