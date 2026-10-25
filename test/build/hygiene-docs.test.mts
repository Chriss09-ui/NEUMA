import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { checkDocReferences, MAINTAINED_DOCS } from "../../scripts/hygiene-docs.mjs";

test("失效的仓库内链接按文档与行号报告，本地文档库与锚点链接不判错", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-hygiene-docs-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "存在");
  await writeFile(join(root, "docs/typescript-kept.md"), "存在");
  const result = await checkDocReferences(root, [{ path: "README.md", content: [
    "[说明](AGENTS.md)",
    "[外部](https://example.invalid/x)",
    "[锚点](#快速开始)",
    "[本地库](docs/user-guide.md)",
    "[坏链接](ARCHITECTURE.md)",
    "[已入库](docs/typescript-kept.md)",
  ].join("\n") }]);
  assert.deepEqual(result.violations.map((violation) => `${violation.file}:${violation.rule}:${violation.message.includes("第 5 行") ? "行号" : "其他"}`),
    ["README.md:文档/失效引用:行号"]);
  assert.match(result.violations[0]!.message, /ARCHITECTURE\.md/);
});

test("文件链接带章节时校验文件路径，缺失文件仍按原链接报告", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-hygiene-docs-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "AGENTS.md"), "# 开发约定");
  const result = await checkDocReferences(root, [{ path: "README.md", content: [
    "[现行约定](AGENTS.md#开发约定)",
    "[缺失文件](MISSING.md#章节)",
    "[本页章节](#章节)",
    "[外部章节](https://example.invalid/x#章节)",
    "[本地库章节](docs/user-guide.md#章节)",
  ].join("\n") }]);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]!.file, "README.md");
  assert.match(result.violations[0]!.message, /第 2 行.*MISSING\.md#章节/);
});

test("编码的井号属于文件名，不作为章节分隔符", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-hygiene-docs-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "guide#part.md"), "# 章节");
  await writeFile(join(root, "guide"), "不能代替带井号的文件");
  const result = await checkDocReferences(root, [{ path: "README.md", content: [
    "[带井号的文件](guide%23part.md#章节)",
    "[缺失的带井号文件](guide%23missing.md#章节)",
  ].join("\n") }]);
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0]!.message, /第 2 行.*guide%23missing\.md#章节/);
});

test("真实维护文档的仓库内链接全部有效", async () => {
  const sourceRoot = JSON.parse(String(await readFile(new URL("../../.neuma-build.json", import.meta.url), "utf8"))).sourceRoot;
  const result = await checkDocReferences(sourceRoot);
  assert.deepEqual(result.violations, []);
  assert.ok(result.notes[0]!.includes("3 份维护文档"));
  assert.ok(MAINTAINED_DOCS.length === 3);
});
