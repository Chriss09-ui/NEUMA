import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TestContext } from "node:test";

export async function testBrowser(t: Pick<TestContext, "skip">, { platform = process.platform, env = process.env, checkExecutable = access }: {platform?: string; env?: NodeJS.ProcessEnv; checkExecutable?: (path: string, mode: number) => Promise<unknown>} = {}) {
  if (!env.NEUMA_TEST_BROWSER && env.NEUMA_REQUIRE_BROWSER_TESTS !== "1") {
    t.skip("外部浏览器测试默认关闭；可用 NEUMA_REQUIRE_BROWSER_TESTS=1 手动启用");
    return null;
  }
  const names = platform === "darwin" ? ["dia"] : platform === "win32" ? ["chrome.exe", "msedge.exe"]
    : ["chromium", "chromium-browser", "google-chrome", "microsoft-edge"];
  const candidates = env.NEUMA_TEST_BROWSER ? [env.NEUMA_TEST_BROWSER] : [
    ...(platform === "darwin" ? ["/Applications/Dia.app/Contents/MacOS/Dia"] : []),
    ...(env.PATH ?? "").split(delimiter).filter(Boolean).flatMap((directory) => names.map((name) => join(directory, name))),
  ];
  for (const candidate of candidates) {
    try { await checkExecutable(candidate, constants.X_OK); return candidate; }
    catch (error) { if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  const reason = `未找到 ${platform === "darwin" ? "Dia" : "Chromium/Edge"}；可用 NEUMA_TEST_BROWSER 指定浏览器可执行文件`;
  assert.fail(reason);
}

export async function browserResult(t: TestContext, browser: string, script: string, { windowSize }: { windowSize?: { width: number; height: number } } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-browser-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const page = join(root, "test.html");
  await writeFile(page, `<!doctype html><meta charset="utf-8"><pre id="test-result"></pre><script>
const writeResult = value => {
  document.getElementById("test-result").textContent = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
};
try {
  const result = (() => { ${script} })();
  writeResult({ ok: true, result });
} catch (error) {
  writeResult({ ok: false, error: String(error.stack || error) });
}
</script>`);
  const args = ["--headless", ...(windowSize ? [`--window-size=${windowSize.width},${windowSize.height}`] : []),
    "--disable-gpu", "--disable-background-networking",
    "--disable-component-update", "--disable-sync", "--no-first-run", "--no-default-browser-check",
    "--host-resolver-rules=MAP * ~NOTFOUND", `--user-data-dir=${join(root, "profile")}`,
    "--timeout=5000", "--dump-dom", pathToFileURL(page).href];
  const encoded = await new Promise<string>((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(browser, args, { detached: grouped, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", bytes = 0, result: string | undefined, failure: unknown, cleanupTimer: string|number|NodeJS.Timeout|undefined, stopping = false;
    const stop = (error: unknown, value?: string) => {
      if (stopping) return;
      stopping = true; failure = error; result = value; clearTimeout(timer);
      cleanupTimer = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy();
        reject(failure ?? new Error("浏览器停止后未在2秒内关闭输出管道"));
      }, 2000);
      // Chromium browsers may keep background processes after dump-dom; close only this test's process group.
      if (!child.pid) return;
      try { if (grouped) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") { failure = error; child.kill("SIGKILL"); } }
    };
    const timer = setTimeout(() => stop(new Error("浏览器未在15秒内返回测试结果")), 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    child.stdout.on("data", (chunk) => {
      if (stopping) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) return stop(new Error("浏览器输出超过1 MiB"));
      stdout += chunk;
      const value = stdout.match(/<pre id="test-result">([A-Za-z0-9+/=]+)<\/pre>/)?.[1];
      if (value) stop(null, value);
    });
    child.once("error", (error) => stop(error));
    child.once("close", (code) => {
      clearTimeout(timer); clearTimeout(cleanupTimer);
      if (failure) reject(failure);
      else if (result) resolve(result);
      else reject(new Error(`浏览器提前退出，未返回测试结果（${code}）`));
    });
  });
  const response = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert.equal(response.ok, true, response.error);
  return response.result;
}
