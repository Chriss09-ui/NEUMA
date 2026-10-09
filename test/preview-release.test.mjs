import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { checkPreviewRelease } from "../scripts/check-preview-release.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "neuma-preview-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { name: "@fixture/neuma", version: "0.1.0-preview.1", private: false,
    os: ["darwin"], cpu: ["arm64"], bin: { neuma: "bin/neuma.cjs" },
    publishConfig: { access: "public", tag: "preview", registry: "https://registry.npmjs.org/" },
    dependencies: { fixture: "1.0.0" } };
  const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: {
    "": { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies,
      os: manifest.os, cpu: manifest.cpu, bin: manifest.bin },
  } };
  async function save({ syncManifest = false } = {}) {
    if (syncManifest) {
      lock.name = manifest.name; lock.version = manifest.version;
      for (const key of ["name", "version", "dependencies", "os", "cpu", "bin"])
        lock.packages[""][key] = manifest[key];
    }
    for (const [path, value] of [["package.json", manifest], ["package-lock.json", lock], ["npm-shrinkwrap.json", lock]])
      await writeFile(join(root, path), JSON.stringify(value));
  }
  await save();
  for (const path of ["bin/neuma.cjs", "installation-cli.mjs", "installation-runtime.mjs",
    "app-metadata.mjs", "server.mjs", "public/index.html"]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "synthetic test entry; not a running application");
  }
  return { root, manifest, lock, save };
}

test("明确的 Apple 芯片 Mac 试用包通过，不需要三平台验收记录", async (t) => {
  const { root } = await fixture(t);
  assert.deepEqual(await checkPreviewRelease(root), { ok: true, failures: [] });
});

test("试用检查拒绝稳定版本号和扩大安装平台", async (t) => {
  for (const change of [{ version: "0.1.0" }, { os: ["darwin", "win32", "linux"] }, { cpu: ["x64", "arm64"] }]) {
    const { root, manifest, save } = await fixture(t);
    Object.assign(manifest, change); await save({ syncManifest: true });
    const result = await checkPreviewRelease(root);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((value) => value.includes("版本号") || value.includes("只支持 Apple 芯片 Mac")));
  }
});

test("公开试用配置拒绝缺少 private false、latest 标签和错误 registry", async (t) => {
  for (const change of [{ private: true }, { private: undefined },
    { publishConfig: { access: "public", tag: "latest", registry: "https://registry.npmjs.org/" } },
    { publishConfig: { access: "restricted", tag: "preview", registry: "https://registry.npmjs.org/" } },
    { publishConfig: { access: "public", tag: "preview", registry: "https://example.invalid/" } }]) {
    const { root, manifest, save } = await fixture(t);
    Object.assign(manifest, change); await save({ syncManifest: true });
    assert.equal((await checkPreviewRelease(root)).ok, false);
  }
});

test("过时的包信息、依赖锁与 shrinkwrap 会阻止发布", async (t) => {
  const { root, lock, save } = await fixture(t);
  lock.packages[""].name = "@old/neuma"; await save();
  assert.ok((await checkPreviewRelease(root)).failures.some((value) => value.includes("与 package-lock.json 不一致")));
  lock.packages[""].name = "@fixture/neuma";
  lock.packages[""].dependencies = { fixture: "2.0.0" }; await save();
  assert.equal((await checkPreviewRelease(root)).ok, false);
  await writeFile(join(root, "npm-shrinkwrap.json"), JSON.stringify({ ...lock, version: "0.0.1-preview.1" }));
  assert.ok((await checkPreviewRelease(root)).failures.some((value) => value.includes("npm-shrinkwrap.json 与")));
});

test("错误命令入口、缺入口文件或损坏锁文件会阻止发布", async (t) => {
  const { root, manifest, save } = await fixture(t);
  manifest.bin.neuma = "missing.cjs"; await save();
  assert.ok((await checkPreviewRelease(root)).failures.some((value) => value.includes("命令入口")));
  manifest.bin.neuma = "bin/neuma.cjs"; await save();
  await rm(join(root, "installation-cli.mjs"));
  await writeFile(join(root, "package-lock.json"), "invalid json");
  const result = await checkPreviewRelease(root);
  assert.ok(result.failures.some((value) => value.includes("installation-cli.mjs")));
  assert.ok(result.failures.some((value) => value.includes("无法读取有效的 package-lock.json")));
});
