import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
let core = new URL("./build-core.mjs", import.meta.url), temporary;
if (!existsSync(core)) {
  temporary = await mkdtemp(join(tmpdir(), "neuma-build-bootstrap-"));
  const compiler = join(dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))), "bin/tsc");
  try {
    await new Promise((done, reject) => {
      const child = spawn(process.execPath, [compiler, "-p", join(root, "tsconfig.bootstrap.json"), "--outDir", temporary], { stdio: "inherit" });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? done() : reject(new Error("构建引导器严格编译失败")));
    });
    core = pathToFileURL(join(temporary, "scripts/build-core.mjs"));
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}
core.searchParams.set("sourceRoot", pathToFileURL(root).href);
const build = await import(core.href);
if (temporary) await rm(temporary, { recursive: true, force: true });
export const { SOURCE_ROOT, BUILD_PATH, REQUIRED_ENTRIES, sourceInputs, execute, checkTypes,
  checkSourceLocks, validateArtifact, assertFreshBuild, buildProject } = build;
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  build.runBuildCommand().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
