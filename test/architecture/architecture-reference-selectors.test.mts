import {objectFields} from "../../src/runtime/type-boundary.mjs";
import {callFixture} from "../helpers/m7-test-boundaries.mjs";
import { failureFields } from "../helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createArchitectureEvidenceReader } from "../../src/architecture/architecture-evidence-reader.mjs";
import { architectureReviewEvidenceContext } from "../../src/architecture/architecture-review-evidence.mjs";
import { designHash, requirementItems, reviewSubmissionSchema, validateReview } from "../../src/architecture/architecture-contract.mjs";
import { architectureToolValidation } from "../../src/architecture/architecture-tool-diagnostics.mjs";
import { validDraft, validDesign, passingReview } from "../helpers/architecture.mjs";

function fixture() {
  const requirements = requirementItems(validDraft()), candidate = validDesign(requirements, { schemaVersion: 3 });
  const candidateHash = designHash(candidate), context = architectureReviewEvidenceContext({ design: candidate, requirements,
    runtimeCapabilities: { version: 1, available: false } });
  const reader = createArchitectureEvidenceReader({ context, candidateHash });
  const review = passingReview(candidateHash, candidate);
  review.verdict = "revise"; review.checks.find((item) => item.id === "acceptance_quality")!.passed = false;
  review.issues = [{ id: "scope_gap", blocking: true, description: "当前承诺尚缺充分的验证", remedy: "补齐验证分工后重新审查",
    checkId: "acceptance_quality", kind: "design", candidatePaths: ["/acceptance/0"], factClaims: [],
    references: [{ source: "candidate", path: "/acceptance/0/expected" }, { source: "acceptanceAdapterGuide", path: "/adapters/action/proves" }] }];
  review.acceptanceScopeChecks![0]!.sufficient = false;
  return { context, candidateHash, reader, review };
}

test("冻结材料的位置规范化后，仍保留独立评审的负面判断", () => {
  const f = fixture();
  f.review.issues[0]!.candidatePaths = ["candidate /acceptance/0"];
  objectFields(f.review.issues[0]!.references![0]).path = "candidate /acceptance/0/expected";
  const before = structuredClone(f.review);
  assert.equal(architectureToolValidation(f.review, f.reader.submissionSchema(reviewSubmissionSchema({ evidenceRequired: true }))).valid, true);
  const normalized = f.reader.resolveSubmission(f.review) as import("../../src/contracts/architecture.mjs").ArchitectureReview;
  assert.deepEqual(normalized.issues[0]!.candidatePaths, ["/acceptance/0"]);
  assert.deepEqual(normalized.issues[0]!.references![0], { source: "candidate", path: "/acceptance/0/expected" });
  assert.deepEqual(f.review, before);
  assert.equal(validateReview(normalized, { candidateHash: f.candidateHash, schemaVersion: 3, evidenceContext: f.context }).verdict, "revise");
  normalized.checks.find((item: { id: string; }) => item.id === "acceptance_quality")!.passed = true;
  assert.throws(() => validateReview(normalized, { candidateHash: f.candidateHash, schemaVersion: 3, evidenceContext: f.context }));
});

test("选择器不替换错误显式引文，不接受缺失/混合/陈旧候选或不完整来源", () => {
  const f = fixture();
  const explicit = structuredClone(f.review); objectFields(explicit.issues[0]!.references![0]).quote = "并非本轮原文";
  assert.throws(() => validateReview(f.reader.resolveSubmission(explicit), { candidateHash: f.candidateHash, schemaVersion: 3, evidenceContext: f.context }),
    (error) => failureFields(error).validationIssues!.some((issue) => issue.reason === "reference_quote_mismatch"));
  for (const change of [{ path: "/PRIVATE_MISSING" }, { source: "PRIVATE_SOURCE" }, { extra: "PRIVATE_VALUE" }, { path: "/__proto__" },
    { source: "runtimeCapabilities", path: "candidate /version" }]) {
    const bad = structuredClone(f.review); Object.assign(bad.issues[0]!.references![0]!, change);
    assert.throws(() => f.reader.resolveSubmission(bad), (error) => !/PRIVATE/u.test(failureFields(error).message!));
  }
  const missing = structuredClone(f.review);
  missing.issues[0]!.candidatePaths = ["candidate /acceptance/999/expected"];
  assert.throws(() => validateReview(f.reader.resolveSubmission(missing), { candidateHash: f.candidateHash, schemaVersion: 3, evidenceContext: f.context }),
    (error) => failureFields(error).validationIssues!.some((issue) => issue.reason === "candidate_path_missing"));
  assert.throws(() => f.reader.resolveSubmission({ ...f.review, candidateHash: "0".repeat(64) }));
  for (const change of [{ delivery: "summary" }, { sha256: "0".repeat(64) }]) {
    const context = structuredClone(f.context); Object.assign(context.contextManifest.candidate!, change);
    assert.throws(() => createArchitectureEvidenceReader({ context, candidateHash: f.candidateHash }).resolveSubmission(f.review),
      (error) => failureFields(error).validationIssue!.reason === "context_not_full");
  }
});
