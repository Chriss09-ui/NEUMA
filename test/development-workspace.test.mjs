import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, chmod, readdir, writeFile, readFile, mkdir, symlink, link, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DevelopmentWorkspace, DEVELOPMENT_LIMITS, inspectDevelopmentCode } from "../development-workspace.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "neuma-workspace-test-"));
  t.after(async () => {
    const unseal = async (path) => {
      await chmod(path, 0o700);
      for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(path, entry.name));
    };
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  return { root, workspace: new DevelopmentWorkspace({ dataDir: join(root, "data") }) };
}
const tool = (tools, name) => tools.find((item) => item.name === name);
const call = async (tools, name, args = {}, signal) => JSON.parse((await tool(tools, name).execute("test", args, signal)).content[0].text);

test("研发文件工具只写任务精确授权文件，读取与元数据分离", async (t) => {
  const { workspace, root } = await fixture(t);
  const path = await workspace.create("run-1");
  await writeFile(join(root, "data", "development-records.json"), "private record");
  const tools = await workspace.tools("run-1", { allowedFiles: ["src/main.mjs"] });
  assert.deepEqual(tools.map((item) => item.name), ["list_code_files", "read_code_file", "write_code_file"]);
  await call(tools, "write_code_file", { path: "src/main.mjs", content: "export const result = 42;" });
  assert.equal(await readFile(join(path, "src/main.mjs"), "utf8"), "export const result = 42;");
  assert.deepEqual((await call(tools, "list_code_files")).files.map((file) => file.path), ["src/main.mjs"]);
  assert.equal((await call(tools, "read_code_file", { path: "src/main.mjs", offset: 13, limit: 6 })).content, "result");
  await assert.rejects(call(tools, "write_code_file", { path: "src/other.mjs", content: "bad" }), /授权/);
  assert.equal((await workspace.tools("run-1", { readOnly: true })).some((item) => item.name === "write_code_file"), false);
  await assert.rejects(call(await workspace.tools("run-1"), "write_code_file", { path: "main.mjs", content: "bad" }), /授权/);
});

test("路径穿越、隐藏凭据、元数据、符号链接及硬链接均拒绝", async (t) => {
  const { workspace, root } = await fixture(t);
  const code = await workspace.create("safe");
  for (const path of ["../other.mjs", "/tmp/main.mjs", "src/../main.mjs", "src\\main.mjs", ".env", "src/.env.local", "metadata/state.json", "secret.pem", "credentials.json", "auth.json", "token.json"])
    await assert.rejects(workspace.tools("safe", { allowedFiles: [path] }), /路径/);
  for (const id of ["../other", "/tmp/other", "", "a/b"]) await assert.rejects(workspace.create(id));
  const outside = join(root, "outside.txt"); await writeFile(outside, "not code");
  const tools = await workspace.tools("safe", { allowedFiles: ["linked.txt", "nested/x.mjs"] });
  await symlink(outside, join(code, "linked.txt"));
  await assert.rejects(call(tools, "read_code_file", { path: "linked.txt" }), /链接/);
  await assert.rejects(call(tools, "write_code_file", { path: "linked.txt", content: "bad" }), /链接/);
  await rm(join(code, "linked.txt"));
  await symlink(root, join(code, "nested"));
  await assert.rejects(call(tools, "read_code_file", { path: "nested/outside.txt" }), /链接/);
  await rm(join(code, "nested"));
  await link(outside, join(code, "linked.txt"));
  await assert.rejects(call(tools, "read_code_file", { path: "linked.txt" }), /链接/);
  assert.equal(await readFile(outside, "utf8"), "not code");
});

test("快照绑定实际内容、去重且工作区后续写入不修改旧快照", async (t) => {
  const { workspace } = await fixture(t);
  const tools = await workspace.tools("snapshot", { allowedFiles: ["src/main.mjs"] });
  await call(tools, "write_code_file", { path: "src/main.mjs", content: "version one" });
  const first = await workspace.snapshot("snapshot"), duplicate = await workspace.snapshot("snapshot");
  assert.deepEqual(first, duplicate);
  assert.equal(first.hash.length, 64); assert.equal(first.files[0].size, 11);
  assert.equal((await stat(join(first.path, "src/main.mjs"))).mode & 0o222, 0);
  const readOnly = await workspace.snapshotTools(first);
  assert.equal(readOnly.some((item) => item.name === "write_code_file"), false);
  await call(tools, "write_code_file", { path: "src/main.mjs", content: "version two" });
  assert.equal((await call(readOnly, "read_code_file", { path: "src/main.mjs" })).content, "version one");
  assert.notEqual((await workspace.snapshot("snapshot")).hash, first.hash);
  await chmod(join(first.path, "src/main.mjs"), 0o600); await writeFile(join(first.path, "src/main.mjs"), "tampered");
  await assert.rejects(call(readOnly, "list_code_files"), /改变/);
  await assert.rejects(workspace.snapshotTools({ ...first, path: first.path + "/../other" }), /不属于/);
});

test("取消主会话或 Pi 工具调用后均不能写文件", async (t) => {
  const { workspace } = await fixture(t);
  const controller = new AbortController(), toolController = new AbortController();
  const tools = await workspace.tools("cancel", { allowedFiles: ["main.mjs"], signal: controller.signal });
  toolController.abort();
  await assert.rejects(call(tools, "write_code_file", { path: "main.mjs", content: "bad" }, toolController.signal), { name: "AbortError" });
  controller.abort();
  await assert.rejects(call(tools, "write_code_file", { path: "main.mjs", content: "bad" }), { name: "AbortError" });
  assert.deepEqual((await inspectDevelopmentCode(await workspace.create("cancel"))).files, []);
});

test("文件与总量限制按字节计数，并发写入仍串行核实预算", async (t) => {
  const { workspace } = await fixture(t);
  const paths = Array.from({ length: 6 }, (_, index) => `f${index}.txt`);
  const tools = await workspace.tools("limits", { allowedFiles: paths });
  await assert.rejects(call(tools, "write_code_file", { path: paths[0], content: "中".repeat(DEVELOPMENT_LIMITS.fileBytes / 2) }), /2 MB/);
  const results = await Promise.allSettled(paths.map((path) => call(tools, "write_code_file", { path, content: "x".repeat(DEVELOPMENT_LIMITS.fileBytes) })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 5);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal((await call(tools, "list_code_files")).files.length, 5);
});

test("文件数量上限与非法已有文件同样受检查", async (t) => {
  const { workspace } = await fixture(t);
  const code = await workspace.create("count");
  await Promise.all(Array.from({ length: 200 }, (_, index) => writeFile(join(code, `${index}.mjs`), "")));
  const tools = await workspace.tools("count", { allowedFiles: ["new.mjs", "0.mjs"] });
  await assert.rejects(call(tools, "write_code_file", { path: "new.mjs", content: "x" }), /200/);
  await call(tools, "write_code_file", { path: "0.mjs", content: "existing" });
  await mkdir(join(code, "metadata"));
  await assert.rejects(workspace.snapshot("count"), /路径/);
});
