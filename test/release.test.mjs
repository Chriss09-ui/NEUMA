import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { checkRelease, NATIVE_ARTIFACTS } from "../scripts/check-release.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "neuma-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { name: "@fixture/neuma", version: "0.1.0", files: ["src/"], dependencies: { fixture: "1.0.0" } };
  const lock = { name: manifest.name, version: manifest.version, packages: { "": manifest } };
  for (const [name, value] of [["package.json", manifest], ["package-lock.json", lock], ["npm-shrinkwrap.json", lock]])
    await writeFile(join(root, name), JSON.stringify(value));
  return { root, manifest, lock };
}

test("没有辅助程序和真实系统记录时，发布检查必须失败", async (t) => {
  const { root } = await fixture(t);
  const result = await checkRelease(root);
  assert.equal(result.ok, false);
  assert.equal(result.failures.filter((value) => value.startsWith("缺少有效辅助程序")).length, 8);
  assert.ok(result.failures.some((value) => value.includes("真实系统验收")));
});

test("发布记录字段、版本与辅助程序摘要须匹配；合成记录只用于检查门槛", async (t) => {
  const { root } = await fixture(t);
  const bytes = Buffer.from("synthetic artifact; never executable proof");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const evidence = { version: "0.1.0", artifacts: {}, systems: {} };
  for (const path of NATIVE_ARTIFACTS) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes); await chmod(join(root, path), 0o755);
    evidence.artifacts[path] = digest;
  }
  for (const system of ["darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64", "ubuntu-24.04-x64", "ubuntu-24.04-arm64", "ubuntu-26.04-x64", "ubuntu-26.04-arm64"])
    evidence.systems[system] = { checkedAt: "2026-10-08T00:00:00Z", evidence: "test fixture, not real validation", checks:
      Object.fromEntries(["installedTarball", "sdkLocalModel", "dataUpgrade", "migration", "projectLifecycle", "folderPicker", "isolation", "cancellation", "nodeMinimum"].map((key) => [key, true])) };
  const path = join(root, "native", "verification.json"); await writeFile(path, JSON.stringify(evidence));
  assert.equal((await checkRelease(root)).ok, true);
  evidence.version = "old"; evidence.systems["win32-x64"].checks.isolation = false; evidence.artifacts[NATIVE_ARTIFACTS[0]] = "invalid";
  await writeFile(path, JSON.stringify(evidence));
  const result = await checkRelease(root);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((value) => value.includes("版本")));
  assert.ok(result.failures.some((value) => value.includes("win32-x64")));
  assert.ok(result.failures.some((value) => value.includes("摘要")));
});

test("过时的 shrinkwrap 不通过发布检查", async (t) => {
  const { root, lock } = await fixture(t);
  await writeFile(join(root, "npm-shrinkwrap.json"), JSON.stringify({ ...lock, version: "old" }));
  const result = await checkRelease(root);
  assert.ok(result.failures.some((value) => value.includes("发布锁文件与")));
});

test("发布清单只包含入口而遗漏完整源码目录时必须失败", async (t) => {
  const { root, manifest } = await fixture(t);
  manifest.files = ["bin/", "public/", "src/server.mjs", "src/installation/installation-cli.mjs"];
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  const result = await checkRelease(root);
  assert.ok(result.failures.some((value) => value.includes("完整源码目录 src/")));
});
