import { toolText } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { normalizeDraft } from "../src/requirements/core.mjs";
import { newConsultation, evaluateConsultation } from "../src/requirements/consultation.mjs";
import { REQUIREMENT_DRAFT_MAX_BYTES } from "../src/requirements/requirement-limits.mjs";
import { architectureConfirmedContext } from "../src/architecture/architecture.mjs";
import { designHash, designSubmissionSchema, requirementItems } from "../src/architecture/architecture-contract.mjs";
import { createPlatformSnapshot } from "../src/architecture/platform-contract.mjs";
import { createArchitectureEvidenceReader } from "../src/architecture/architecture-evidence-reader.mjs";
import { validDraft, validDesign } from "./helpers/architecture.mjs";
import { sufficientPreflight } from "./helpers/consultation.mjs";

test("合法大需求的冻结依据跨两百万UTF-16位置连续续读，返回位置仍符合工具结构", async () => {
  const message = Array.from({ length: 1200 }, (_, index) => `${String(index).padStart(9, "0")}q`).join("");
  const draft = normalizeDraft({ ...validDraft(), taskSpec: { version: 1, items: Array.from({ length: 42 }, (_, index) => ({
    id: `item_${index}`, dimension: "processing", content: "x".repeat(500), applicability: "applies", critical: true,
    source: { kind: "user", evidence: Array.from({ length: 12 }, (_, number) => ({ messageId: "user_1",
      quote: message.slice(index * 12 + number, index * 12 + number + 4000) })) },
  })) } });
  assert.ok(Buffer.byteLength(JSON.stringify(draft)) < REQUIREMENT_DRAFT_MAX_BYTES);
  const platform = createPlatformSnapshot(), consultation = await evaluateConsultation({ draft,
    consultation: { ...newConsultation(), evidenceMessages: [{ id: "user_1", role: "user", content: message }] },
    platform, requestId: "unicode-pagination", preflight: sufficientPreflight });
  const requirements = requirementItems(draft), confirmedRequirementContext = await architectureConfirmedContext(draft, consultation, platform, requirements);
  assert.ok(confirmedRequirementContext);
  const source = JSON.stringify(confirmedRequirementContext);
  assert.ok(source.length > 2_000_000); assert.ok(Buffer.byteLength(source) < REQUIREMENT_DRAFT_MAX_BYTES);
  const candidate = validDesign(requirements), { tool } = createArchitectureEvidenceReader({
    context: { candidate, requirements, confirmedRequirementContext }, candidateHash: designHash(candidate),
    candidateSchema: designSubmissionSchema(draft, { requirements }),
  });
  const validate = new Ajv({ strict: false }).compile(tool.parameters);
  let offset = 1_999_999, previous = offset;
  while (offset !== null) {
    const params = { source: "confirmedRequirementContext", pointer: "", offset, limit: 1000 };
    assert.equal(validate(params), true, JSON.stringify(validate.errors));
    const page = JSON.parse(String(toolText((await tool.execute(`read-${offset}`, params)))));
    assert.equal(page.offsetUnit, "UTF-16"); assert.equal(page.reference.quote, source.slice(page.offset, page.nextOffset ?? source.length));
    if (page.nextOffset !== null) assert.ok(page.nextOffset > previous);
    previous = offset; offset = page.nextOffset;
  }
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const params = { source: "confirmedRequirementContext", pointer: "", offset: invalid, limit: 1000 };
    assert.equal(validate(params), false); await assert.rejects(tool.execute("invalid-offset", params));
  }
});
