import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { assertFreshBuild, buildProject, checkTypes, REQUIRED_ENTRIES } from "../scripts/build.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "neuma-ts-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { name: "@fixture/neuma", version: "0.1.0-preview.1", type: "module", dependencies: {} };
  const lock = { name: manifest.name, version: manifest.version, packages: { "": manifest } };
  for (const [name, value] of [["package.json", manifest], ["package-lock.json", lock], ["npm-shrinkwrap.json", lock]])
    await writeFile(join(root, name), JSON.stringify(value));
  await writeFile(join(root, "README.md"), "Synthetic fixture\n");
  for (const name of ["base", "node", "browser", "frame", "test", "contracts"])
    await copyFile(new URL(`../tsconfig.${name}.json`, import.meta.url), join(root, `tsconfig.${name}.json`));
  await symlink(dirname(dirname(fileURLToPath(import.meta.resolve("typescript/package.json")))), join(root, "node_modules"), "dir");
  for (const path of REQUIRED_ENTRIES) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    const source = path === "public/application-frame-bridge.js" ? "(() => { 'use strict'; })();\n"
      : path.endsWith(".mjs") ? "export {};\n" : "synthetic fixture\n";
    await writeFile(join(root, path), source);
  }
  await writeFile(join(root, "src/probe.mts"), "export const value: number = 42;\n");
  await mkdir(join(root, "scripts"), { recursive: true });
  return root;
}

test("严格类型检查拒绝真实类型错误，不能由noCheck发射掩盖", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "src/probe.mts"), "export const value: number = 'invalid';\n");
  await assert.rejects(checkTypes(root), /TS2322/);
});

test("遗漏类型检查的TS文件、同名JS/TS源及普通桥模块化均拒绝构建", async (t) => {
  const root = await fixture(t);
  const config = JSON.parse(await readFile(join(root, "tsconfig.node.json")));
  config.include = ["src/other.mts"];
  await writeFile(join(root, "src/other.mts"), "export {};\n");
  await writeFile(join(root, "tsconfig.node.json"), JSON.stringify(config));
  await assert.rejects(buildProject({ root }), /未进入类型检查/);
  config.include = ["src/**/*.mts"];
  await writeFile(join(root, "tsconfig.node.json"), JSON.stringify(config));
  await writeFile(join(root, "src/probe.mjs"), "export const value = 1;\n");
  await assert.rejects(buildProject({ root }), /同名源码/);
  await rm(join(root, "src/probe.mjs"));
  await writeFile(join(root, "public/application-frame-bridge.js"), "export {};\n");
  await assert.rejects(buildProject({ root }), /普通脚本/);
});

test("产物保留JS字节与相对布局，旧文件移除，源码变化和篡改均使产物失效", async (t) => {
  const root = await fixture(t), output = await buildProject({ root });
  const text = await readFile(join(root, "src/server.mjs"), "utf8");
  assert.equal(await readFile(join(output, "src/server.mjs"), "utf8"), text);
  assert.match(await readFile(join(output, "src/probe.mjs"), "utf8"), /42/);
  await assertFreshBuild(output);
  await writeFile(join(output, "public/obsolete.js"), "stale");
  await buildProject({ root });
  await assert.rejects(lstat(join(output, "public/obsolete.js")), { code: "ENOENT" });
  await writeFile(join(output, "src/probe.mjs"), "changed");
  await assert.rejects(assertFreshBuild(output), /产物缺失或已改变/);
  await buildProject({ root });
  await writeFile(join(root, "src/probe.mts"), "export const value: number = 'invalid';\n");
  await assert.rejects(assertFreshBuild(output), /已过期/);
  await assert.rejects(buildProject({ root }), /TS2322/);
  await assert.rejects(lstat(join(output, ".neuma-build.json")), { code: "ENOENT" });
});

test("缺少worker使新构建失败且不能继续使用旧代次，历史归档不受清理影响", async (t) => {
  const root = await fixture(t), output = await buildProject({ root });
  await writeFile(join(root, "dist/retained.tgz"), "keep");
  await rm(join(root, "src/services/node-service-worker.mjs"));
  await assert.rejects(buildProject({ root }), /node-service-worker/);
  await assert.rejects(assertFreshBuild(output), /ENOENT/);
  assert.equal(await readFile(join(root, "dist/retained.tgz"), "utf8"), "keep");
});
