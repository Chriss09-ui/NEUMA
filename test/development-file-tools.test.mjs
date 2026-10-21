import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevelopmentFileTools } from "../src/development/development-file-tools.mjs";
import { DevelopmentWorkspace, inspectDevelopmentCode } from "../src/development/development-workspace.mjs";

const call = (tools, name, args, signal) => tools.find((tool) => tool.name === name).execute("test", args, signal);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "neuma-native-file-tools-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const workspace = new DevelopmentWorkspace({ dataDir: join(root, "data") });
  return { root, workspace, code: await workspace.create("agent_one", "run_one") };
}

test("Pi 原生多处编辑复用宿主授权和原子写入，保留精确分页", async (t) => {
  const { workspace, code } = await fixture(t);
  const tools = await createDevelopmentFileTools(workspace, "agent_one", "run_one", { allowedFiles: ["main.mjs"] });
  assert.deepEqual(tools.map((tool) => tool.name), ["read", "write", "edit", "list_code_files", "read_code_file"]);
  const content = "export const a = 1;\r\nexport const b = 2;\r\n";
  await call(tools, "write", { path: "main.mjs", content });
  const edited = await call(tools, "edit", { path: "main.mjs", edits: [
    { oldText: "a = 1", newText: "a = 3" }, { oldText: "b = 2", newText: "b = 4" },
  ] });
  assert.match(edited.details.patch, /a = 3/);
  assert.equal(await readFile(join(code, "main.mjs"), "utf8"), content.replace("a = 1", "a = 3").replace("b = 2", "b = 4"));
  await assert.rejects(call(tools, "write", { path: "other.mjs", content: "bad" }), /授权/);
  await assert.rejects(call(tools, "write", { path: "../index.json", content: "bad" }), /路径/);
  await assert.rejects(call(tools, "read", { path: join(code, "main.mjs") }), /路径/);
  const large = "x".repeat(120000);
  await call(tools, "write", { path: "main.mjs", content: large });
  const fallback = JSON.parse((await call(tools, "read_code_file", { path: "main.mjs", offset: 95000, limit: 25000 })).content[0].text);
  assert.equal(fallback.content, large.slice(95000)); assert.equal(fallback.nextOffset, null);
  assert.deepEqual((await createDevelopmentFileTools(workspace, "agent_one", "run_one", { readOnly: true })).map((tool) => tool.name),
    ["read", "list_code_files", "read_code_file"]);
});

test("原生工具拒绝链接和取消，失败不会留下半写文件", async (t) => {
  const { root, workspace, code } = await fixture(t);
  const outside = join(root, "outside.mjs"); await writeFile(outside, "outside");
  const tools = await createDevelopmentFileTools(workspace, "agent_one", "run_one", { allowedFiles: ["main.mjs", "linked.mjs"] });
  await symlink(outside, join(code, "linked.mjs"));
  await assert.rejects(call(tools, "write", { path: "linked.mjs", content: "bad" }), /链接/);
  await assert.rejects(call(tools, "read", { path: "linked.mjs" }), /链接/);
  assert.equal(await readFile(outside, "utf8"), "outside");
  await rm(join(code, "linked.mjs"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(call(tools, "write", { path: "main.mjs", content: "bad" }, controller.signal), { name: "AbortError" });
  assert.equal((await inspectDevelopmentCode(code)).files.length, 0);
});
