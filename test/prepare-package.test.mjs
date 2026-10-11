import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

async function fixture(t, dependencies) {
  const root = await mkdtemp(join(tmpdir(), "neuma-prepare-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  await copyFile(new URL("../scripts/prepare-package.mjs", import.meta.url), join(root, "scripts/prepare-package.mjs"));
  const manifest = { name: "fixture-package", version: "1.0.0", dependencies: { parser: "4.10.2" } };
  const lock = { name: manifest.name, version: manifest.version, packages: { "": { version: manifest.version, dependencies } } };
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  await writeFile(join(root, "package-lock.json"), JSON.stringify(lock));
  await writeFile(join(root, "npm-shrinkwrap.json"), "original published lock\n");
  return { root, lock, run: () => execute(process.execPath, [join(root, "scripts/prepare-package.mjs")]) };
}

test("准备安装包复制一致的锁文件，不修改依赖", async (t) => {
  const { root, lock, run } = await fixture(t, { parser: "4.10.2" });
  await run();
  assert.deepEqual(JSON.parse(await readFile(join(root, "npm-shrinkwrap.json"))), lock);
});

test("旧依赖锁不能覆盖已保存的发布锁文件", async (t) => {
  const { root, run } = await fixture(t, {});
  await assert.rejects(run(), /版本或依赖不一致/);
  assert.equal(await readFile(join(root, "npm-shrinkwrap.json"), "utf8"), "original published lock\n");
});
