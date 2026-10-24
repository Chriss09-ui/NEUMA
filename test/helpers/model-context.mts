import assert from "node:assert/strict";
import { fixtureTools, type FixtureTool } from "./m7-test-boundaries.mjs";
import type { PiSessionOptions } from "../../src/runtime/pi-port.mjs";

/** Expose only the selected tool's tested execution port and validate its actual result. */
export function fixtureTool(options: PiSessionOptions, name: string): FixtureTool {
  const tool = options.customTools?.find(item => item.name === name);
  assert.ok(tool, `测试需要当前实际注册的工具：${name}`);
  return fixtureTools([tool])[name]!;
}

export async function readModelContextSection(options: PiSessionOptions, section: string, pointer = ""): Promise<unknown> {
  const tool = fixtureTool(options, "read_model_context");
  let text = "", offset: number | null = 0, expectedHash: string | undefined;
  do {
    const output = await tool.execute("fixture-context", { requests: [{ section, pointer, offset, limit: 8000,
      ...(expectedHash ? { expectedHash } : {}) }] });
    const content = output.content[0]; assert.ok(content && content.type === "text");
    const value: unknown = JSON.parse(content.text);
    assert.ok(value && typeof value === "object" && "results" in value && Array.isArray(value.results));
    const page: unknown = value.results[0];
    assert.ok(page && typeof page === "object" && "encoding" in page);
    assert.equal(page.encoding, "json");
    assert.ok("text" in page && typeof page.text === "string");
    assert.ok("nextOffset" in page && (page.nextOffset === null || typeof page.nextOffset === "number"));
    assert.ok("contentHash" in page && typeof page.contentHash === "string");
    text += page.text; offset = page.nextOffset; expectedHash = page.contentHash;
  } while (offset !== null);
  return JSON.parse(text) as unknown;
}

export async function completeVerificationContext(packet: Record<string, unknown>, options: PiSessionOptions) {
  const result = { ...packet };
  const index = packet.contextIndex ?? []; assert.ok(Array.isArray(index));
  for (const section of index) {
    assert.ok(section && typeof section === "object" && "section" in section && typeof section.section === "string");
    result[section.section] = await readModelContextSection(options, section.section);
  }
  for (const key of ["contextIndex", "inputContextVersion", "platformOverview", "deferredObligations"]) delete result[key];
  return result;
}
