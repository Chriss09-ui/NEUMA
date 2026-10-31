import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { toolText } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createModelContextReader, modelContextPacket } from "../../src/runtime/model-context.mjs";
import type { NeumaTool } from "../../src/runtime/pi-port.mjs";
import { toolInputValidation } from "../../src/runtime/tool-input-diagnostics.mjs";

const read = async (tool: NeumaTool, requests: { section: string; pointer?: string; limit?: number; offset?: number; expectedHash?: unknown; cursor?: string }[], signal?: AbortSignal) => JSON.parse(String(toolText((await tool.execute("read", { requests }, signal))))).results;

test("真实失败的8500字符续读及10000边界可通过公开契约，超限仍拒绝", async () => {
  const source = { candidateSchema: "x".repeat(16038) }, tool = createModelContextReader(() => source);
  for (const limit of [8500, 10000]) {
    const requests = [{ section: "candidateSchema", offset: 8000, limit }];
    assert.equal(toolInputValidation({ requests }, tool.parameters).valid, true);
    const [page] = await read(tool, requests);
    assert.equal(page.text, JSON.stringify(source.candidateSchema).slice(8000));
    assert.equal(page.nextRequest, null);
  }
  assert.equal(toolInputValidation({ requests: [{ section: "candidateSchema", limit: 10001 }] }, tool.parameters).valid, false);
});

test("程序分页可跨读取器恢复且保留批次余量，续读不混用范围或变更后的原文", async () => {
  const source = { one: "😀".repeat(16000), two: "x".repeat(30000), three: "y".repeat(30000), four: "z".repeat(30000), short: "s".repeat(3997) };
  const pages = await read(createModelContextReader(() => source), Object.keys(source).map(section => ({ section })));
  assert.equal(pages.reduce((sum: number, p: { text?: string }) => sum + (p.text?.length ?? 0), 0), 24000);
  assert.equal(pages[3].reason, "batch_limit");
  for (const [i, key] of Object.keys(source).entries()) {
    let page = pages[i], text = page.text ?? "";
    while (page.nextRequest) {
      [page] = await read(createModelContextReader(() => source), [page.nextRequest]);
      assert.ok(!page.error); text += page.text;
    }
    assert.equal(text, JSON.stringify(source[key as keyof typeof source]));
  }
  const [wrongScope] = await read(createModelContextReader(() => source), [{ ...pages[0].nextRequest, section: "two" }]);
  assert.ok(wrongScope.error);
  const [mixed] = await read(createModelContextReader(() => source), [{ ...pages[0].nextRequest, offset: 0 }]);
  assert.ok(mixed.error);
  const partial = await read(createModelContextReader(() => source), [{ section: "two" }, { section: "three" }, { section: "short" }, pages[0].nextRequest]);
  assert.equal(partial[3].reason, "batch_limit", "批次仅剩一个UTF-16位置时延后完整字符，不把合法续读报为错误");
  assert.equal(partial[3].error, undefined);
  const [continued] = await read(createModelContextReader(() => source), [partial[3].nextRequest]);
  assert.ok(continued.text.startsWith("😀"));
  source.one = "changed";
  const [stale] = await read(createModelContextReader(() => source), [pages[0].nextRequest]);
  assert.match(stale.error.message, /已变化/);
});

test("节点首包省去说明原文，权威要求不截断且任意分页可无损还原", async () => {
  const source = { requirements: [{ id: "r", text: "必须完整交付😀".repeat(3000) }], guide: { details: "规则😀".repeat(4000) } };
  const packet = modelContextPacket(source, ["requirements"]), tool = createModelContextReader(() => source);
  assert.deepEqual(packet.requirements, source.requirements);
  assert.equal(objectFields(packet).guide, undefined);
  assert.equal(packet.contextIndex![0]!.delivery, "paged");
  let offset = 0, expectedHash, text = "";
  do {
    const [page] = await read(tool, [{ section: "guide", pointer: "/details", offset, limit: 7999, ...(expectedHash ? { expectedHash } : {}) }]);
    expectedHash = page.contentHash; text += page.text; offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(JSON.parse(String(text)), source.guide.details);
  source.guide.details = "new";
  assert.match((await read(tool, [{ section: "guide", pointer: "/details", expectedHash }]))[0].error.message, /已变化/);
  packet.requirements[0]!.text = "changed";
  assert.notEqual(source.requirements![0]!.text, "changed");
});

test("读取边界拒绝原型、访问器、错误路径及取消，批量正文有共同上限", async () => {
  let touched = 0;
  const source = { guide: { text: "x".repeat(30000), "a/b~c": "exact" } };
  Object.defineProperty(source.guide, "secret", { get() { touched++; return "hidden"; } });
  const tool = createModelContextReader(() => source);
  for (const pointer of ["/__proto__", "/constructor", "/secret", "/missing", "/bad~2path"])
    assert.ok((await read(tool, [{ section: "guide", pointer }]))[0].error);
  assert.equal(touched, 0);
  const [escaped] = await read(tool, [{ section: "guide", pointer: "/a~1b~0c" }]);
  assert.equal(JSON.parse(String(escaped.text)), "exact");
  const pages = await read(tool, Array.from({ length: 4 }, () => ({ section: "guide", pointer: "/text", limit: 8000 })));
  assert.equal(pages.reduce((sum: number, page: { text?: string }) => sum + (page.text?.length ?? 0), 0), 24000);
  assert.equal(pages[3].reason, "batch_limit");
  await assert.rejects(read(tool, [{ section: "guide" }], AbortSignal.abort()));
});

test("批读坏路径只拒绝该项，成功资料保留且返回实际父级字段，不执行访问器", async () => {
  const source = { candidateSchema: { properties: { profile: { type: "string" }, execution: { type: "object" } } },
    guide: "先提交蓝图", platform: { available: true } };
  let touched = 0;
  Object.defineProperty(source.candidateSchema.properties, "secret", { enumerable: true, get() { touched++; return "hidden"; } });
  const results = await read(createModelContextReader(() => source), [
    { section: "guide" }, { section: "candidateSchema", pointer: "/properties/global/properties/profile" },
    { section: "platform", pointer: "/available" }, { section: "candidateSchema", pointer: "/properties/profile" },
  ]);
  assert.equal(JSON.parse(String(results[0].text)), source.guide);
  assert.deepEqual(results[1].error.availableKeys, ["profile", "execution"]);
  assert.equal(results[1].error.parentPointer, "/properties");
  assert.equal(results[1].requestIndex, 1); assert.equal(results[1].text, undefined);
  assert.equal(JSON.parse(String(results[2].text)), true);
  assert.deepEqual(JSON.parse(String(results[3].text)), { type: "string" });
  assert.equal(touched, 0);
});
