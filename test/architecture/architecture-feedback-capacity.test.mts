import type { TestFailure } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { designHash, validateDesign, validateReview, reviewSubmissionSchema } from "../../src/architecture/architecture-contract.mjs";
import { architectureReviewEvidenceContext } from "../../src/architecture/architecture-review-evidence.mjs";
import { architecturePriorFindings, validateArchitecturePriorFindings } from "../../src/architecture/architecture-prior-findings.mjs";
import { createArchitectureFeedbackLedger } from "../../src/architecture/architecture-feedback-ledger.mjs";
import { createArchitectureReviewParts } from "../../src/architecture/architecture-review-parts.mjs";
import { historicalRepairSnapshot } from "../../src/architecture/architecture-repair-evidence.mjs";
import { runtimeCapabilityContract } from "../../src/runtime/runtime-capability-contract.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../../src/verification/acceptance-contract.mjs";
import { passingReview, validDesign } from "../helpers/architecture.mjs";
import type { ArchitectureBase } from "../../src/contracts/architecture.mjs";

const requirements = [
  { id: "inputSource", text: "处理用户提供的记录" },
  { id: "externalAction", text: "不执行未经授权的外部动作" },
  { id: "deliverable", text: "产出逐项处理结果" },
];
const facts = (items = requirements) => ({ requirements: items, runtimeCapabilities: runtimeCapabilityContract(), acceptanceAdapterGuide: ACCEPTANCE_ADAPTER_GUIDE });
const design = (items = requirements) => validDesign(items, { schemaVersion: 3, connections: [],
  interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "用户记录", results: "处理结果", persistentData: "无" },
  execution: { language: "none", hosting: "builtin", reason: "复用当前对话能力" },
  selectionBasis: { capacity: "保留全部输入范围", process: "逐项处理", quality: "逐项核对", requirementIds: items.map((row) => row.id), assumptions: [] } });
const oldIssues = (count: number, candidate: Omit<ArchitectureBase,"schemaVersion"|"connections"|"execution"|"selectionBasis"|"interaction">&{ schemaVersion: number; connections: never[]; interaction: { defaultEntry: string; page: boolean; operations: boolean; inputs: string; results: string; persistentData: string; }; execution: { language: string; hosting: string; reason: string; }; selectionBasis: { capacity: string; process: string; quality: string; requirementIds: string[]; assumptions: never[]; }; }, { paths = true } = {}) => Array.from({ length: count }, (_, index) => ({
  id: `old_${index}`, kind: "design", blocking: true, checkId: "verification", description: `旧问题${index}须核对`, remedy: "修订相关处理正文并独立核实",
  ...(paths ? { candidatePaths: ["/instructions"], references: [{ source: "candidate", path: "/instructions", quote: candidate.instructions }], factClaims: [] } : {}),
}));

test("80条历史关闭解释与1条新阻断可同时通过完整及分项评审契约", () => {
  const original = design(), candidate = structuredClone(original);
  candidate.instructions = "处理全部输入并保留明确错误及恢复检查点。";
  const previous = { agentId: "capacity_agent", version: 1, candidateHash: designHash(original), design: original,
    review: { issues: oldIssues(80, original) } };
  const context = architectureReviewEvidenceContext({ design: candidate, ...facts() });
  const ledger = createArchitectureFeedbackLedger(previous, { agentId: previous.agentId, candidate: original, ...facts() });
  const current = { candidateHash: designHash(candidate), guideHash: context.contextManifest!.acceptanceAdapterGuide!.sha256,
    contextManifestHash: designHash(context.contextManifest) };
  const prior = architecturePriorFindings(previous, current, { candidate, evidenceContext: context, feedbackLedger: ledger });
  assert.equal(prior!.findings!.length, 80);
  const review = passingReview(current.candidateHash, candidate);
  review.verdict = "revise"; review.checks!.find((row) => row.id === "verification")!.passed = false;
  review.priorFindingDecisions = prior!.findings!.map((finding) => ({ findingId: finding.findingId, status: "resolved",
    checkIds: ["verification"], candidatePaths: ["/instructions"], reason: "当前相关正文已有实际修订，独立逐项核对。" }));
  review.issues = prior!.findings!.map((finding) => ({ id: finding.findingId, kind: "design", blocking: false, checkId: "verification",
    description: "本轮核对旧问题已修订", remedy: "继续保留当前证明范围", candidatePaths: ["/instructions"],
    references: [{ source: "candidate", path: "/instructions", quote: candidate.instructions }], factClaims: [] }));
  review.issues.push({ id: "new_current_blocker", kind: "design", blocking: true, checkId: "verification",
    description: "本轮发现另一项尚未解决的验证缺口", remedy: "补齐该项验证后再评审", candidatePaths: ["/acceptance/0/expected"],
    references: [{ source: "candidate", path: "/acceptance/0/expected", quote: candidate.acceptance![0]!.expected }], factClaims: [] });
  const checked = validateArchitecturePriorFindings(validateReview(review, { candidateHash: current.candidateHash, schemaVersion: 3, evidenceContext: context }),
    prior, candidate, { evidenceContext: context });
  assert.equal(checked.issues.length, 81); assert.equal(checked.verdict, "revise");
  const schema = reviewSubmissionSchema({ evidenceRequired: true, priorFindingsRequired: true });
  const { verdict, summary, ...parts } = review;
  const controller = createArchitectureReviewParts({ schema, candidateHash: current.candidateHash, context, priorFindings: prior, initial: parts });
  const ref = controller.reference();
  assert.ok(Object.values(ref.missing).every((rows) => rows.length === 0));
  const assembled = controller.assemble({ candidateHash: current.candidateHash, progressHash: ref.progressHash, verdict, summary });
  assert.deepEqual(assembled, review);
});

test("254条正式需求与80条验收的大候选按摘要共享修订前快照，不在80个问题中重复复制", () => {
  const items = Array.from({ length: 254 }, (_, index) => ({ id: `requirement_${index}`, text: `必须保留要求${index}` }));
  const candidate = design(items);
  const scenarios = candidate.acceptance;
  candidate.acceptance = Array.from({ length: 80 }, (_, index) => ({ ...scenarios[index % scenarios.length]!, id: `acceptance_${index}`,
    requirementIds: items.map((item) => item.id), input: `固定输入${index}`, expected: `完整处理并核对输出${index}` }));
  candidate.decisions = Array.from({ length: 80 }, (_, index) => ({ ...candidate.decisions[0]!, id: `decision_${index}`, choice: `当前功能方案${index}` }));
  validateDesign(candidate, { ...facts(items) });
  const before = designHash(candidate), snapshot = historicalRepairSnapshot(candidate);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) * 80 > 512 * 1024, "若每个问题重复复制完整多锚点快照，会超过账本总量");
  const previous = { agentId: "large_capacity_agent", version: 1, candidateHash: before, design: candidate,
    review: { issues: oldIssues(80, candidate, { paths: false }) } };
  const ledger = createArchitectureFeedbackLedger(previous, { agentId: previous.agentId, candidate, ...facts(items) });
  assert.equal(ledger.findings.length, 80);
  assert.equal(Object.keys(ledger.repairBases!).length, 1);
  assert.equal(ledger.findings.every((row) => row.repairBasisHash === snapshot.hash && !Object.hasOwn(row, "repairBasis")), true);
  assert.deepEqual(ledger.repairBases![snapshot.hash], snapshot);
  assert.ok(Buffer.byteLength(JSON.stringify(ledger)) <= 512 * 1024);
  assert.equal(designHash(candidate), before);
});

test("超过80个未关闭问题明确整体拒绝，不截断来源或改写旧记录", () => {
  const candidate = design(), previous = { agentId: "too_many_findings", version: 1, candidateHash: designHash(candidate), design: candidate,
    review: { issues: oldIssues(81, candidate) } };
  const before = designHash(previous);
  assert.throws(() => createArchitectureFeedbackLedger(previous, { agentId: previous.agentId, candidate, ...facts() }),
    (error: TestFailure) => error.validationIssue?.reason === "feedback_findings_capacity");
  assert.equal(previous.review.issues.length, 81);
  assert.equal(designHash(previous), before);
});
