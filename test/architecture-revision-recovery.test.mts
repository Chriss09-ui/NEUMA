import {callFixture,fixtureNumber} from "./helpers/m7-test-boundaries.mjs";
import type {SessionMessage} from "../src/runtime/pi-port.mjs";
import type {RequirementItem} from "../src/contracts/architecture.mjs";
interface ModelPayload extends Record<string,unknown> {requirements:RequirementItem[];design:ReturnType<typeof validDesign>;candidateHash:string;previousDesign:unknown;issues:unknown;priorFindings:NonNullable<Parameters<typeof passingReview>[2]>;revisionSource:{version:number;kind:string;interruptedVersion:number;historicalOnly:boolean};modelBudget:{limit:number;used:number;remaining:number}}
import { objectFields } from "../src/runtime/type-boundary.mjs";
import type { PiSessionOptions } from "../src/runtime/pi-port.mjs";
import { fixtureTools } from "./helpers/m7-test-boundaries.mjs";
import { failureFields } from "./helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { designHash } from "../src/architecture/architecture-contract.mjs";
import { validDraft, validDesign, passingReview, withPriorFindingDecisions } from "./helpers/architecture.mjs";

async function fixture(t: test.TestContext, { failedRole = "designer", reason = "submission_incomplete", modelError }: {failedRole?:string|undefined;reason?:string|undefined;modelError?:string|undefined} = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-unsubmitted-recovery-")), prompts: {run:number;isDesign:boolean;payload:ModelPayload}[] = [];
  const definition = { id: "recovery", name: "固定续接测试", draft: validDraft(), fingerprint: "same-requirements" };
  let run = 1;
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"),
    sessionFactory: async (options: PiSessionOptions) => {
      const tools = fixtureTools(options.customTools!), isDesign = Boolean(tools.submit_architecture);
      const session = { messages: [] as SessionMessage[], subscribe: () => () => {}, async abort() {}, dispose() {}, async prompt(text: string) {
        const payload:ModelPayload = JSON.parse(text); prompts.push({ run, isDesign, payload });
        if (run === 2 && isDesign === (failedRole === "designer")) {
          if (modelError) throw new Error(modelError);
          session.messages.push({ role: "assistant", stopReason: reason === "output_limit" ? "length" : "stop", content: [] }); return;
        }
        if (isDesign) {
          const candidate = validDesign(payload.requirements, { schemaVersion: 3, connections: [],
            interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "工作记录", results: "完整周报", persistentData: "无" },
            execution: { language: "none", hosting: "builtin", reason: "已有文本能力" },
            selectionBasis: { capacity: "当前输入", process: "完整处理", quality: "不编造", requirementIds: payload.requirements.map((item) => item.id), assumptions: [] } });
          if (run === 2) candidate.instructions += " 本轮新稿尚未经过独立评审。";
          return tools.submit_architecture!.execute("fixed-design", candidate);
        }
        const review = passingReview(payload.candidateHash, payload.design);
        if (run === 1) {
          review.verdict = "revise"; review.checks.find((item) => item.id === "verification")!.passed = false;
          review.issues = [{ id: "precision", blocking: true, description: "核对当前边界", remedy: "保持原边界并补齐检查",
            checkId: "verification", kind: "design", candidatePaths: ["/acceptance/2/expected"],
            references: [{ source: "candidate", path: "/acceptance/2/expected", quote: "尚未发送" }], factClaims: [] }];
        }
        return tools.submit_architecture_review!.execute("fixed-review", withPriorFindingDecisions(review, payload.priorFindings));
      } };
      return session;
    } });
  t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  const prior = await designer.design(definition);
  assert.equal(prior.status, "needs_changes"); assert.equal(prior.contractVersion, 3);
  run = 2;
  await assert.rejects(designer.design(definition), (error) => failureFields(error).diagnostic!.reason === reason);
  const interrupted = await designer.get(definition.id);
  assert.equal(interrupted!.status, "failed"); assert.equal(interrupted!.contractVersion, failedRole === "designer" ? 1 : 3);
  if (failedRole === "designer") { assert.equal(interrupted!.design, null); assert.equal(interrupted!.candidateHash, null); }
  else { assert.ok(interrupted!.design); assert.notEqual(interrupted!.candidateHash, prior.candidateHash); }
  assert.equal(interrupted!.review, null); assert.deepEqual<NonNullable<NonNullable<typeof interrupted>>["attempts"]>(interrupted!.attempts, []);
  assert.equal(interrupted!.diagnostic!.modelCalls, reason === "submission_incomplete" ? 2 : 1);
  assert.equal(interrupted!.diagnostic!.submissionAttempts, 0);
  return { designer, definition, prompts, prior, interrupted, continue: async (next = definition) => {
    run = 3; const result = await designer.design(next);
    return { result, payload: prompts.find((item) => item.run === 3 && item.isDesign)?.payload,
      reviewPayload: prompts.find((item) => item.run === 3 && !item.isDesign)?.payload };
  } };
}

test("真实连续三次design在首候选前自然中断后只读恢复历史待修方案，不改失败记录或旧预算", async (t) => {
  const f = await fixture(t);
  const historyHashes = () => Promise.all([f.prior, f.interrupted].map(async (item) => designHash(await f.designer.getVersion(f.definition.id, item!.version))));
  const before = await historyHashes();
  const { result, payload } = await f.continue();
  assert.equal(result.status, "passed"); assert.equal(result.version, f.interrupted!.version + 1);
  assert.deepEqual(payload!.previousDesign, f.prior.design);
  assert.equal(payload!.revisionSource.version, f.prior.version);
  assert.equal(payload!.revisionSource.interruptedVersion, f.interrupted!.version);
  assert.equal(payload!.revisionSource.historicalOnly, true);
  assert.deepEqual(await historyHashes(), before);
  assert.equal((await f.designer.getVersion(f.definition.id, f.interrupted!.version))!.diagnostic!.modelCalls, 2);
});

const controlledFailures: [string,string|undefined][] = [
  ["api_authentication", "401 unauthorized"], ["api_rate_limit", "429 rate limit"], ["api_not_found", "404 model not found"],
  ["api_unavailable", "503 service unavailable"], ["api_context", "maximum context length exceeded"],
  ["api_output_limit", "truncated response"], ["api_rejected", "finish_reason: content_filter"],
  ["api_stream_interrupted", "Stream ended without finish_reason"], ["api_protocol", "invalid json stream"],
  ["api_connection", "fetch failed"], ["output_limit", undefined],
];
for (const failedRole of ["designer", "reviewer"]) for (const [reason, modelError] of controlledFailures) {
  test(`真实连续三次design在${failedRole}的${reason}后只读复用完整材料并重新独立评审`, async (t) => {
    const f = await fixture(t, { failedRole, reason, modelError });
    const histories = async () => Promise.all([f.prior, f.interrupted].map(async (record) =>
      designHash(await f.designer.getVersion(f.definition.id, record!.version))));
    const before = await histories(), failedCalls = f.interrupted!.diagnostic!.modelCalls;
    const { result, payload, reviewPayload } = await f.continue();
    assert.equal(result.status, "passed"); assert.equal(result.version, f.interrupted!.version + 1);
    if (failedRole === "designer") {
      assert.deepEqual(payload!.previousDesign, f.prior.design); assert.deepEqual(payload!.issues, f.prior.issues);
      assert.equal(payload!.revisionSource.version, f.prior.version);
    } else {
      assert.equal(payload, undefined, "当前候选完整时不重新启动设计者");
      assert.deepEqual(reviewPayload!.design, f.interrupted!.design);
      assert.equal(reviewPayload!.candidateHash, f.interrupted!.candidateHash);
      assert.equal(reviewPayload!.revisionSource.version, f.interrupted!.version);
      assert.equal(reviewPayload!.revisionSource.kind, "review-continuation");
    }
    const firstPayload = payload ?? reviewPayload;
    assert.equal(firstPayload!.revisionSource.interruptedVersion, f.interrupted!.version);
    assert.equal(firstPayload!.revisionSource.historicalOnly, true); assert.equal(firstPayload!.modelBudget.limit, 5);
    const carriedCalls = failedRole === "reviewer" ? fixtureNumber(f.interrupted!.reviewProgressCheckpoint!.modelCalls) : 0;
    assert.equal(firstPayload!.modelBudget.used, carriedCalls + 1); assert.equal(firstPayload!.modelBudget.remaining, 4 - carriedCalls);
    const reviews = f.prompts.filter((item) => item.run === 3 && !item.isDesign);
    assert.equal(reviews.length, 1); assert.equal(reviews[0]!.payload.candidateHash, result.candidateHash);
    assert.equal(result.attempts.length, 1); assert.equal(objectFields(result.attempts[0]!.review).verdict, "pass");
    assert.deepEqual(await histories(), before);
    assert.equal((await f.designer.getVersion(f.definition.id, f.interrupted!.version))!.diagnostic!.modelCalls, failedCalls);
  });
}

test("正常产生的未知模型错误仍不启用历史续接，不将api_前缀当作授权", async (t) => {
  const f = await fixture(t, { reason: "api_error", modelError: "unclassified fixture failure" });
  const before = designHash(await f.designer.getVersion(f.definition.id, f.interrupted!.version));
  const { payload } = await f.continue();
  assert.equal(payload!.previousDesign, null); assert.equal(payload!.revisionSource, undefined);
  assert.equal(designHash(await f.designer.getVersion(f.definition.id, f.interrupted!.version)), before);
});

test("首候选前中断的例外不穿越需求、平台、运行能力、后续义务或已有候选的版本绑定", async (t) => {
  for (const change of [
    (record: { sourceFingerprint: string; }) => { record.sourceFingerprint += "-changed"; },
    (record: { draft: { goal: { value: string; }; }; }) => { record.draft.goal.value += " changed"; },
    (record: { requirements: { text: string; }[]; }) => { record.requirements[0]!.text += " changed"; },
    (record: { platformHash: string; }) => { record.platformHash = "0".repeat(64); },
    (record: { runtimeCapabilities: { hash: string; }; }) => { record.runtimeCapabilities.hash = "0".repeat(64); },
    (record: { confirmedRequirementContext: { changed: boolean; }; }) => { record.confirmedRequirementContext = { changed: true }; },
    (record: { deferredVerifications: { issues: never[]; }; }) => { record.deferredVerifications = { issues: [] }; },
    (record: { contractVersion: number; }) => { record.contractVersion = 2; },
    (record: { diagnostic: { reason: string; }; }) => { record.diagnostic.reason = "api_error"; },
    (record: { diagnostic: { reason: string; }; }) => { record.diagnostic.reason = "request_failed"; },
    (record: { diagnostic: { reason: string; }; }) => { record.diagnostic.reason = "api_unknown"; },
    (record: { diagnostic: { reason: string; modelCalls: number; }; }) => { record.diagnostic.reason = "invalid_result"; record.diagnostic.modelCalls = 2; },
    (record: { diagnostic: { role: string; phase: string; }; }) => { record.diagnostic.role = "reviewer"; record.diagnostic.phase = "evaluating"; },
    (record:NonNullable<Awaited<ReturnType<ArchitectureDesigner["get"]>>>, prior:Awaited<ReturnType<ArchitectureDesigner["design"]>>) => {
      objectFields(record).design = { ...structuredClone(prior.design), schemaVersion: 2 };
      record.candidateHash = designHash(record.design);
      record.reviewContext = { candidateHash: record.candidateHash, platformHash: record.platformHash };
    },
  ]) {
    const f = await fixture(t), actualGet = f.designer.get.bind(f.designer), changed = structuredClone(f.interrupted);
    callFixture(change,undefined,[changed,f.prior]); f.designer.get = async () => structuredClone(changed);
    const { payload } = await f.continue(); f.designer.get = actualGet;
    assert.equal(payload!.previousDesign, null); assert.equal(payload!.revisionSource, undefined);
    assert.deepEqual(await f.designer.getVersion(f.definition.id, f.interrupted!.version), f.interrupted);
  }
});
