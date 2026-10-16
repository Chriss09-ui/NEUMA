import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { TEST_LAYERS, selectTestFiles, testEnvironment } from "../scripts/run-tests.mjs";

test("分层清单覆盖实际测试文件，快速组不包含真实执行或浏览器混合文件", async () => {
  const files = (await readdir(new URL("./", import.meta.url))).filter((name) => name.endsWith(".test.mjs"));
  const layers = Object.fromEntries(["unit", "integration", "browser"].map((layer) => [layer, selectTestFiles(layer, files)]));
  assert.deepEqual([...new Set(Object.values(layers).flatMap((layer) => layer.files))].sort(), files.sort());
  for (const layer of Object.values(layers)) assert.deepEqual(layer.missing, []);
  assert.deepEqual(layers.unit.files.filter((name) => layers.integration.files.includes(name) || layers.browser.files.includes(name)), []);
  assert.ok(layers.unit.files.includes("core.test.mjs")); assert.ok(layers.unit.files.includes("collaboration-ui.test.mjs"));
  for (const name of ["agent-prototype.test.mjs", "pi-runtime.test.mjs", "development-executor.test.mjs", "materials-runner.test.mjs", "project-platform.test.mjs"])
    assert.ok(layers.integration.files.includes(name), `${name} 必须归入集成组`);
  assert.deepEqual(layers.browser.files, ["agent-artifact-document.test.mjs", "agent-build-view.test.mjs", "agent-layout.test.mjs", "sidebar-layout.test.mjs"]);
  assert.deepEqual(layers.browser.files.filter((name) => layers.integration.files.includes(name)), ["agent-build-view.test.mjs"]);
});

test("未登记的新测试默认进入集成组并提供分类提示，不把夹具当成测试", () => {
  const files = ["new-feature.test.mjs", "core.test.mjs", "helpers.mjs"];
  const selected = selectTestFiles("integration", files);
  assert.deepEqual(selected.files, ["new-feature.test.mjs"]); assert.deepEqual(selected.unclassified, ["new-feature.test.mjs"]);
  assert.deepEqual(selectTestFiles("unit", files).files, ["core.test.mjs"]);
  assert.equal(selectTestFiles("browser", files).files.includes("new-feature.test.mjs"), false);
  assert.throws(() => selectTestFiles("unknown", files), /测试层/);
  assert.equal(new Set(Object.values(TEST_LAYERS).flat()).has("new-feature.test.mjs"), false);
});

test("模块与集成命令关闭外部浏览器，显式浏览器命令保留用户选定的程序", () => {
  const source = { PATH: "fixture-path", NEUMA_TEST_BROWSER: "/chosen/browser", NEUMA_REQUIRE_BROWSER_TESTS: "1" };
  for (const layer of ["unit", "integration"]) {
    const env = testEnvironment(layer, source);
    assert.equal(env.NEUMA_TEST_BROWSER, undefined); assert.equal(env.NEUMA_REQUIRE_BROWSER_TESTS, undefined);
    assert.equal(env.PATH, "fixture-path");
  }
  const browser = testEnvironment("browser", { ...source, NEUMA_REQUIRE_BROWSER_TESTS: "0" });
  assert.equal(browser.NEUMA_TEST_BROWSER, "/chosen/browser"); assert.equal(browser.NEUMA_REQUIRE_BROWSER_TESTS, "1");
  assert.equal(source.NEUMA_REQUIRE_BROWSER_TESTS, "1"); assert.equal(source.NEUMA_TEST_BROWSER, "/chosen/browser");
});
