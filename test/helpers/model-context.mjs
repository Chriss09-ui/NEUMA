import assert from "node:assert/strict";

export async function readModelContextSection(options, section, pointer = "") {
  const tool = options.customTools.find(item => item.name === "read_model_context");
  assert.ok(tool, "未内联的原文必须具有只读入口");
  let text = "", offset = 0, expectedHash;
  do {
    const output = await tool.execute("fixture-context", { requests: [{ section, pointer, offset, limit: 8000,
      ...(expectedHash ? { expectedHash } : {}) }] });
    const page = JSON.parse(output.content[0].text).results[0];
    assert.equal(page.encoding, "json");
    text += page.text; offset = page.nextOffset; expectedHash = page.contentHash;
  } while (offset !== null);
  return JSON.parse(text);
}

export async function completeVerificationContext(packet, options) {
  const result = { ...packet };
  for (const section of packet.contextIndex ?? []) result[section.section] = await readModelContextSection(options, section.section);
  for (const key of ["contextIndex", "inputContextVersion", "platformOverview", "deferredObligations"]) delete result[key];
  return result;
}
