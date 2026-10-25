import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkLeftoverFiles } from "../../scripts/hygiene-leftovers.mjs";
import { sourceTreeFiles } from "../../scripts/hygiene-tree.mjs";

async function fixtureRoot(files: string[]) {
  const root = await mkdtemp(join(tmpdir(), "neuma-hygiene-leftovers-"));
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), "fixture\n");
  }
  return root;
}

test("同名 JavaScript 产物与未迁移脚本都被报告并给出精确位置", async () => {
  const root = await fixtureRoot(["src/one.mts", "src/one.mjs", "bin/cli.cts", "bin/cli.cjs", "src/legacy/helper.mjs", "scripts/build.mjs"]);
  try {
    const result = await checkLeftoverFiles(root);
    assert.deepEqual(result.violations.map((violation) => violation.file), ["bin/cli.cjs", "src/legacy/helper.mjs", "src/one.mjs"]);
    const twin = result.violations.find((violation) => violation.file === "src/one.mjs")!;
    assert.match(twin.rule, /同名覆盖/); assert.match(twin.message, /src\/one\.mts/);
    assert.match(result.violations.find((violation) => violation.file === "src/legacy/helper.mjs")!.rule, /未迁移/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("白名单 JavaScript 放行，白名单条目消失时提示清理", async () => {
  const withAllow = await fixtureRoot(["src/a.mts", "scripts/build.mjs"]);
  try { assert.deepEqual((await checkLeftoverFiles(withAllow)).violations, []); }
  finally { await rm(withAllow, { recursive: true, force: true }); }
  const withoutAllow = await fixtureRoot(["src/a.mts"]);
  try {
    const stale = (await checkLeftoverFiles(withoutAllow)).violations.find((violation) => violation.file === "scripts/build.mjs");
    assert.ok(stale); assert.match(stale!.rule, /白名单失效/);
  } finally { await rm(withoutAllow, { recursive: true, force: true }); }
});

test("真实源码树当前没有误生成文件", async () => {
  const sourceRoot = JSON.parse(String(await readFile(new URL("../../.neuma-build.json", import.meta.url), "utf8"))).sourceRoot;
  const files = await sourceTreeFiles(sourceRoot);
  assert.ok(files.includes("scripts/build.mjs"));
  assert.deepEqual((await checkLeftoverFiles(sourceRoot)).violations, []);
});
