import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { sourceApplicationOptions } from "../../scripts/start-source.mjs";

test("本机双击启动器从有空格的目录调用源码启动命令并请求打开页面", { skip: process.platform !== "darwin" }, async t => {
  const { sourceRoot } = JSON.parse(await readFile(new URL("../../.neuma-build.json", import.meta.url), "utf8"));
  const dir = await mkdtemp(join(tmpdir(), "NEUMA 启动器 ")); t.after(() => rm(dir, { recursive: true, force: true }));
  const name = "启动 NEUMA.command";
  try { await copyFile(join(sourceRoot, name), join(dir, name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { t.skip("此检出没有本机双击脚本"); return; } throw error; }
  await mkdir(join(dir, "node_modules"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { start: "node observe.cjs" } }));
  await writeFile(join(dir, "observe.cjs"), 'require("node:fs").writeFileSync("launch.json", JSON.stringify(process.argv.slice(2)))');
  await promisify(execFile)("/bin/zsh", [join(dir, name)], { cwd: tmpdir(), timeout: 10_000 });
  assert.deepEqual(JSON.parse(await readFile(join(dir, "launch.json"), "utf8")), ["--open"]);
});

test("源码启动显式传递仓库根与Agent cwd，数据和配置仍由原启动器传入", () => {
  let seen;
  const options = sourceApplicationOptions("/synthetic/source", (input) => { seen = input; return "handler"; });
  assert.equal(options.root, "/synthetic/source");
  assert.equal(options.createHandler({ dataDir: "/synthetic/source/.neuma", envPath: "/synthetic/source/.env" }), "handler");
  assert.deepEqual(seen, { dataDir: "/synthetic/source/.neuma", envPath: "/synthetic/source/.env", cwd: "/synthetic/source" });
});
