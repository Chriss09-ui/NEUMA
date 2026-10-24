import { fixtureString } from "./helpers/http-model.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { InputError } from "../src/requirements/core.mjs";
import { WORKSPACE_TEXT_WRITE_CODE_UNITS } from "../src/runtime/runtime-capability-contract.mjs";
import type { BinaryLike } from "crypto";

const sha256 = (value: BinaryLike|NonSharedBuffer) => createHash("sha256").update(value).digest("hex");

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuma-workspace-nul-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const call = PrototypeAgents.prototype.activationBusinessHost.call({}, { workspaceRoot: root });
  return { root, call };
}

test("工作目录正文在原字符边界无损写读NUL与Unicode，分页和原始字节摘要一致", async (t) => {
  const { root, call } = await fixture(t);
  const prefix = "x".repeat(23999) + "\0😀尾";
  const content = prefix + "z".repeat(WORKSPACE_TEXT_WRITE_CODE_UNITS - prefix.length);
  const write = await call({ capability: "files.write", args: { file: "report.csv", content } });
  const raw = await readFile(join(root, "report.csv"));
  assert.deepEqual(raw, Buffer.from(content, "utf8"));
  assert.equal(objectFields(objectFields(write).integrity).sha256, sha256(raw));
  assert.equal(objectFields(objectFields(write).integrity).bytes, raw.length);
  assert.equal(objectFields(write).characters, WORKSPACE_TEXT_WRITE_CODE_UNITS);
  let actual = "", offset: number|null = 0, pages = 0;
  do {
    const page = await call({ capability: "files.read", args: { file: "report.csv", offset } });
    actual += fixtureString(objectFields(page).text); const nextOffset = objectFields(page).nextOffset; assert.ok(nextOffset === null || typeof nextOffset === "number"); offset = nextOffset; pages++;
    assert.equal(objectFields(objectFields(page).integrity).sha256, objectFields(objectFields(write).integrity).sha256);
    assert.equal(objectFields(objectFields(page).integrity).bytes, raw.length);
    assert.equal(objectFields(objectFields(page).integrity).utf16Units, content.length);
    assert.equal(objectFields(objectFields(page).integrity).redacted, false);
  } while (offset !== null);
  assert.ok(pages > 1);
  assert.equal(actual, content);
  await assert.rejects(call({ capability: "files.write", args: { file: "report.csv", content: content + "\0" } }), InputError);
  assert.deepEqual(await readFile(join(root, "report.csv")), raw, "超限写入不改变原文件");
});

test("正文支持NUL仍保留凭据脱敏，回执绑定脱敏前的实际字节", async (t) => {
  const { root, call } = await fixture(t);
  const content = '前缀\0尾部\napi_key="private-nul-fixture"\n结束\0';
  const written = await call({ capability: "files.write", args: { file: "report.txt", content } });
  const page = await call({ capability: "files.read", args: { file: "report.txt" } });
  assert.match(fixtureString(objectFields(page).text), /前缀\0尾部/u);
  assert.ok(fixtureString(objectFields(page).text).endsWith("结束\0"));
  assert.doesNotMatch(fixtureString(objectFields(page).text), /private-nul-fixture/u);
  assert.equal(objectFields(objectFields(page).integrity).redacted, true);
  assert.equal(objectFields(objectFields(page).integrity).sha256, objectFields(objectFields(written).integrity).sha256);
  assert.equal(objectFields(objectFields(page).integrity).sha256, sha256(await readFile(join(root, "report.txt"))));
});

test("NUL正文支持不放宽非法UTF8、路径、隐藏凭据和链接限制", async (t) => {
  const { root, call } = await fixture(t);
  await writeFile(join(root, "invalid.txt"), Buffer.from([0x61, 0x00, 0xc0, 0xaf]));
  await assert.rejects(call({ capability: "files.read", args: { file: "invalid.txt" } }), /UTF-8/u);
  await writeFile(join(root, "sentinel.txt"), "keep");
  await symlink(join(root, "sentinel.txt"), join(root, "linked.txt"));
  for (const file of ["report\0.csv", ".env", "../outside.txt", "linked.txt"]) {
    await assert.rejects(call({ capability: "files.read", args: { file } }), InputError);
    await assert.rejects(call({ capability: "files.write", args: { file, content: "正文\0" } }), InputError);
  }
  assert.equal(await readFile(join(root, "sentinel.txt"), "utf8"), "keep");
});
