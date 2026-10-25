import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { toolText } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createModelContextReader, modelContextPacket } from "../../src/runtime/model-context.mjs";
import type { NeumaTool } from "../../src/runtime/pi-port.mjs";

const read = async (tool: NeumaTool, requests: { section: string; pointer: string; limit: number; }[]|{ expectedHash?: unknown; section: string; pointer: string; offset: number; limit: number; }[]|{ section: string; pointer: string; expectedHash: unknown; }[]|({ section: string; pointer?: never; }|{ section: string; pointer: string; })[], signal?: AbortSignal) => JSON.parse(String(toolText((await tool.execute("read", { requests }, signal))))).results;

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
