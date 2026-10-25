import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
const command = process.argv[2] ?? "build";
const strictCompile = (config, out) => new Promise((done, reject) => {
  const compiler = join(dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))), "bin/tsc");
  const child = spawn(process.execPath, [compiler, "-p", config, "--outDir", out], { stdio: "inherit" });
  child.once("error", reject);
  child.once("close", (code) => code === 0 ? done() : reject(new Error("引导器严格编译失败")));
});

// hygiene 是独立的源码检查分支：不加载 build-core、不生成产品运行目录，从没有 dist 的源码树也能运行。
const hygiene = isMain && command === "hygiene";
let build = null;
if (hygiene) {
  const temporary = await mkdtemp(join(tmpdir(), "neuma-hygiene-bootstrap-"));
  try {
    await strictCompile(join(root, "tsconfig.hygiene.json"), temporary);
    const entry = pathToFileURL(join(temporary, "scripts/hygiene.mjs"));
    entry.searchParams.set("sourceRoot", pathToFileURL(root).href);
    const check = await import(entry.href);
    if (!(await check.runHygiene(root))) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
} else {
  let core = new URL("./build-core.mjs", import.meta.url), temporary;
  if (!existsSync(core)) {
    temporary = await mkdtemp(join(tmpdir(), "neuma-build-bootstrap-"));
    try {
      await strictCompile(join(root, "tsconfig.bootstrap.json"), temporary);
      core = pathToFileURL(join(temporary, "scripts/build-core.mjs"));
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  }
  core.searchParams.set("sourceRoot", pathToFileURL(root).href);
  build = await import(core.href);
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
export const { SOURCE_ROOT, BUILD_PATH, REQUIRED_ENTRIES, sourceInputs, execute, checkTypes,
  checkSourceLocks, validateArtifact, assertFreshBuild, buildProject } = build ?? {};
if (isMain && !hygiene)
  build.runBuildCommand().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
