import type { TestFailure } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { textLength, textWithinLimit, truncateText } from "../../src/runtime/text-length.mjs";
import { assertRequirementDraftSize, REQUIREMENT_DRAFT_MAX_BYTES, REQUIREMENT_RECORD_MAX_BYTES,
  REQUIREMENT_CONVERSATION_MAX_BYTES, REQUIREMENT_LIMITS } from "../../src/requirements/requirement-limits.mjs";
import { requirementItems } from "../../src/architecture/architecture-contract.mjs";
import { normalizeDraft } from "../../src/requirements/core.mjs";
import { validDraft } from "../helpers/architecture.mjs";

test("字符数、UTF16位置和UTF8字节各自有明确口径，截取不会拆开代理对", () => {
  const text = "A😀𠀀中文";
  assert.equal(textLength(text), 5); assert.equal(text.length, 7); assert.equal(Buffer.byteLength(text), 15);
  assert.equal(textWithinLimit(text, 5), true); assert.equal(textWithinLimit(text, 4), false);
  assert.equal(truncateText(text, 2), "A😀"); assert.equal(truncateText(text, 0), ""); assert.equal(truncateText(text, 20), text);
});

test("需求总量按实际紧凑JSON的UTF8字节统一核算，边界外整体拒绝不改原值", () => {
  const base = { payload: "" }, overhead = Buffer.byteLength(JSON.stringify(base));
  const exact = { payload: "x".repeat(REQUIREMENT_DRAFT_MAX_BYTES - overhead) };
  assert.equal(assertRequirementDraftSize(exact), exact);
  const tooLarge = { payload: exact.payload + "中" }, before = tooLarge.payload;
  assert.throws(() => assertRequirementDraftSize(tooLarge), (error: TestFailure) => error.reason === "requirement_draft_too_large"
    && error.bytes === REQUIREMENT_DRAFT_MAX_BYTES + 3 && error.limitBytes === REQUIREMENT_DRAFT_MAX_BYTES);
  assert.equal(tooLarge.payload, before);
  assert.ok(REQUIREMENT_RECORD_MAX_BYTES > REQUIREMENT_DRAFT_MAX_BYTES);
  assert.ok(REQUIREMENT_CONVERSATION_MAX_BYTES >= 8 * REQUIREMENT_DRAFT_MAX_BYTES);
});

test("正式需求文字预算覆盖上游合法交互JSON的控制字符转义，不只覆盖普通中文样例", () => {
  const draft = validDraft();
  draft.interaction = { defaultEntry: "conversation", page: true, operations: [], inputs: "\u0001".repeat(1200),
    results: "\u0001".repeat(1200), persistentData: "\u0001".repeat(1200), assistant: { enabled: true, purpose: "\u0001".repeat(500) } };
  const normalized = normalizeDraft(draft), item = requirementItems(normalized).find(item => item.id === "interaction");
  assert.ok(item!.text!.length > 24_000); assert.ok(textWithinLimit(item!.text!, REQUIREMENT_LIMITS.formalTextCharacters));
  assert.equal(item!.text!.includes("\u0001"), false); assert.equal(JSON.parse(String(item!.text!.slice(3))).inputs, normalized.interaction!.inputs);
});
