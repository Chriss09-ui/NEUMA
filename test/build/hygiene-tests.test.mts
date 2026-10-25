import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkTestRegistrationLists } from "../../scripts/hygiene-tests.mjs";
import { TEST_LAYERS, discoverTestFiles } from "../../scripts/run-tests.mjs";

test("遗漏、失效与未说明理由的重复登记都被报告", () => {
  const mixed = { integration: ["agents/agent-build-view.test.mjs"], browser: ["agents/agent-build-view.test.mjs"] };
  const layers = { unit: ["core.test.mjs"], integration: [...mixed.integration, "api.test.mjs"], browser: mixed.browser };
  const missing = checkTestRegistrationLists(layers, ["core.test.mjs", "api.test.mjs", "agents/agent-build-view.test.mjs", "new-feature.test.mjs"]);
  assert.deepEqual(missing.violations.map((violation) => `${violation.file}:${violation.rule}`),
    ["new-feature.test.mjs:登记/遗漏"]);
  const stale = checkTestRegistrationLists({ unit: ["core.test.mjs"], integration: [...mixed.integration, "gone.test.mjs"], browser: mixed.browser },
    ["core.test.mjs", "agents/agent-build-view.test.mjs"]);
  assert.deepEqual(stale.violations.map((violation) => `${violation.file}:${violation.rule}`),
    ["gone.test.mjs:登记/失效"]);
  const duplicated = checkTestRegistrationLists({ unit: ["core.test.mjs"], integration: [...mixed.integration, "core.test.mjs"], browser: mixed.browser },
    ["core.test.mjs", "agents/agent-build-view.test.mjs"]);
  assert.deepEqual(duplicated.violations.map((violation) => `${violation.file}:${violation.rule}`),
    ["core.test.mjs:登记/重复"]);
  const mixedGone = checkTestRegistrationLists({ unit: [], integration: ["agents/agent-build-view.test.mjs"], browser: [] }, ["agents/agent-build-view.test.mjs"]);
  assert.ok(mixedGone.violations.some((violation) => violation.rule === "登记/混合例外失效"));
});

test("登记过的混合层文件放行", () => {
  const layers = { unit: [], integration: ["agents/agent-build-view.test.mjs"], browser: ["agents/agent-build-view.test.mjs"] };
  assert.deepEqual(checkTestRegistrationLists(layers, ["agents/agent-build-view.test.mjs"]).violations, []);
});

test("真实源码树的测试登记完整且无重复", async () => {
  const sourceRoot = JSON.parse(String(await readFile(new URL("../../.neuma-build.json", import.meta.url), "utf8"))).sourceRoot;
  const discovered = await discoverTestFiles(sourceRoot);
  assert.ok(discovered.length > 240);
  const result = checkTestRegistrationLists(TEST_LAYERS, discovered);
  assert.deepEqual(result.violations, []);
});
