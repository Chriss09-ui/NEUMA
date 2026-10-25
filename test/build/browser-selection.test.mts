import test from "node:test";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { join } from "node:path";
import { testBrowser } from "../helpers/browser.mjs";
import type { PathLike } from "fs";

const dia = "/Applications/Dia.app/Contents/MacOS/Dia";
const edge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const browserBin = join("/browser", "bin");
const diaOnPath = join(browserBin, "dia");

function selection({ platform = "darwin", env = { NEUMA_REQUIRE_BROWSER_TESTS: "1" }, installed = [], failure }: {platform?:string;env?:NodeJS.ProcessEnv;installed?:string[];failure?:unknown} = {}) {
  const checked: string[] = [], skipped: (string|undefined)[] = [];
  const run = () => testBrowser({ skip: (reason) => skipped.push(reason) }, {
    platform, env,
    checkExecutable: async (path, mode) => {
      assert.equal(mode, constants.X_OK);
      checked.push(path);
      if (failure) throw failure;
      if (!installed.includes(path)) throw Object.assign(new Error("不可执行"), { code: "ENOENT" });
    },
  });
  return { run, checked, skipped };
}

test("默认不探测或启动外部浏览器，页面检查留在 Codex 内置浏览器", async () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    const browser = selection({ platform, env: {}, installed: [dia, edge] });
    assert.equal(await browser.run(), null);
    assert.deepEqual<NonNullable<typeof browser>["checked"]>(browser.checked, []);
    assert.match(browser.skipped[0]!, /默认关闭.*手动启用/);
  }
});

test("手动启用后，macOS 同时安装 Dia 和 Edge 时只选择 Dia", async () => {
  const browser = selection({ installed: [dia, edge] });
  assert.equal(await browser.run(), dia);
  assert.deepEqual(browser.checked, [dia]);
  assert.deepEqual<NonNullable<typeof browser>["skipped"]>(browser.skipped, []);
});

test("手动启用后，macOS 未安装 Dia 时明确失败，不自动调用 Edge", async () => {
  const browser = selection({ env: { NEUMA_REQUIRE_BROWSER_TESTS: "1", PATH: browserBin },
    installed: [edge, join(browserBin, "microsoft-edge")] });
  await assert.rejects(browser.run(), /未找到 Dia/);
  assert.deepEqual(browser.checked, [dia, diaOnPath]);
  assert.deepEqual<NonNullable<typeof browser>["skipped"]>(browser.skipped, []);
});

test("macOS 可从 PATH 找到 Dia，显式指定的浏览器仍优先", async () => {
  const fromPath = selection({ env: { NEUMA_REQUIRE_BROWSER_TESTS: "1", PATH: browserBin }, installed: [diaOnPath] });
  assert.equal(await fromPath.run(), diaOnPath);
  const explicit = selection({ env: { NEUMA_TEST_BROWSER: "/custom/browser" }, installed: [dia, "/custom/browser"] });
  assert.equal(await explicit.run(), "/custom/browser");
  assert.deepEqual(explicit.checked, ["/custom/browser"]);
});

test("显式指定无效浏览器或要求浏览器测试时，缺失浏览器不能静默跳过", async () => {
  for (const env of [{ NEUMA_TEST_BROWSER: "/missing/browser" }, { NEUMA_REQUIRE_BROWSER_TESTS: "1" }]) {
    const browser = selection({ env, installed: [edge] });
    await assert.rejects(browser.run(), /未找到 Dia/);
    assert.deepEqual<NonNullable<typeof browser>["skipped"]>(browser.skipped, []);
  }
});

test("其他平台保留原有浏览器发现顺序", async () => {
  for (const [platform, name] of [["win32", "chrome.exe"], ["linux", "chromium"]] as const) {
    const path = join(browserBin, name);
    const browser = selection({ platform, env: { NEUMA_REQUIRE_BROWSER_TESTS: "1", PATH: browserBin }, installed: [path] });
    assert.equal(await browser.run(), path);
    assert.deepEqual(browser.checked, [path]);
  }
});

test("浏览器探测的意外系统错误不被当成浏览器缺失", async () => {
  const failure = Object.assign(new Error("探测失败"), { code: "EIO" });
  const browser = selection({ failure });
  await assert.rejects(browser.run(), (error) => error === failure);
  assert.deepEqual<NonNullable<typeof browser>["skipped"]>(browser.skipped, []);
});
