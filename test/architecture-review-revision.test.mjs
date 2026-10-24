import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { designHash, designSubmissionSchema, validateDesign } from "../src/architecture/architecture-contract.mjs";
import { architectureReviewRevisionRecovery, readArchitectureReviewRevision, runArchitectureReviewRevision,
  createArchitectureReviewRetry, createArchitectureReviewTestRetry, createArchitectureReviewContinuation, readArchitectureReviewRetry } from "../src/architecture/architecture-review-revision.mjs";
import { createReviewProgressCheckpoint } from "../src/architecture/architecture-review-progress.mjs";
import { validDesign } from "./helpers/architecture.mjs";
import { createMainReviewCheckpoint } from "../src/architecture/architecture-main-review-checkpoint.mjs";
import { createArchitectureFidelityProgress } from "../src/architecture/architecture-fidelity-progress.mjs";

function fixture({ progressVersion = 1, designCalls = 15 } = {}) {
  const requirements = [{ id: "req_0", text: "完整处理记录" }], draft = { taskSpec: { version: 1 } };
  const design = validDesign(requirements, { schemaVersion: 3, connections: [],
    interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "工作记录", results: "完整摘要", persistentData: "无" },
    execution: { language: "none", hosting: "builtin", reason: "对话处理" },
    selectionBasis: { capacity: "原始记录", process: "逐项核对", quality: "保留事实", requirementIds: ["req_0"], assumptions: [] } });
  design.acceptance.forEach(row => { row.requirementIds = ["req_0"]; });
  const candidateHash = designHash(design), review = { verdict: "revise", candidateHash };
  const issues = [{ id: "incomplete_instructions", blocking: true, candidateFields: ["instructions"], description: "补充处理边界" }];
  const source = { agentId: "review_revision", version: 8, status: "failed", sourceFingerprint: "frozen", draft, requirements,
    platformHash: "a".repeat(64), runtimeCapabilities: {}, evidence: [], researchGaps: [], designResearchCalls: 0,
    designProgressCheckpoint: { schemaVersion: progressVersion, pipelineId: "fixed-pipeline", hash: "b".repeat(64), modelCalls: designCalls },
    candidateHash, design, review, issues, attempts: [{ candidateHash, design, review, issues }] };
  const { hash: _hash, ...progress } = source.designProgressCheckpoint;
  source.designProgressCheckpoint.hash = designHash(progress);
  const record = structuredClone({ ...source, version: 9, design: null, candidateHash: null, review: null, attempts: [] });
  const saved = [], calls = [], schema = designSubmissionSchema(draft, { requirements });
  const run = overrides => runArchitectureReviewRevision({ record, source, candidateSchema: schema,
    sessionDirectory: "/tmp/neuma-review-revision-fixture", validate: value => validateDesign(value, { requirements }),
    onSave: async checkpoint => { saved.push(structuredClone(checkpoint)); }, runRole: async node => {
      calls.push(node);
      await node.onSessionRef({ file: node.sessionStorage.file ?? "fixed-review-revision.jsonl" });
      await node.onModelCall();
      const result = node.validate({ baseHash: node.baseHash, updates: [{ path: "/instructions", value: design.instructions + " 逐项核对并保留缺失标记。" }] });
      await node.onResult(result); return result;
    }, ...overrides });
  return { source, record, saved, calls, run };
}

test("已耗尽原设计的完整候选可显式按评审修订，原15轮及模块检查点保持", async () => {
  const f = fixture(), original = structuredClone(f.source), ledger = structuredClone(f.record.designProgressCheckpoint);
  const recovery = architectureReviewRevisionRecovery(f.source);
  assert.equal(recovery.status, "available"); assert.equal(recovery.request.kind, "review_revision");
  const candidate = await f.run();
  assert.notEqual(designHash(candidate), f.source.candidateHash);
  assert.equal(f.record.reviewRevisionCheckpoint.modelCalls, 1);
  assert.deepEqual(f.record.designProgressCheckpoint, ledger); assert.deepEqual(f.source, original);
  assert.equal(f.record.review, null); assert.equal(f.record.design, null);
  assert.deepEqual(await f.run({ runRole: () => assert.fail("已保存修订不能重跑") }), candidate);
  assert.ok(readArchitectureReviewRevision(f.record));
});

test("新设计二十五轮总账允许正式评审后修订，旧版和未知预算版本不能借此放宽", async () => {
  for (const progressVersion of [2, 3]) {
    const f = fixture({ progressVersion, designCalls: 25 });
    assert.equal(architectureReviewRevisionRecovery(f.source).status, "available");
    await f.run();
    assert.equal(f.record.designProgressCheckpoint.modelCalls, 25);
    assert.equal(f.record.reviewRevisionCheckpoint.modelCalls, 1);
  }
  for (const options of [{ progressVersion: 1, designCalls: 16 }, { progressVersion: 2, designCalls: 26 },
    { progressVersion: 3, designCalls: 26 }, { progressVersion: 4, designCalls: 1 }]) {
    const invalid = fixture(options);
    await assert.rejects(invalid.run());
    assert.equal(invalid.calls.length, 0);
  }
});

test("中断沿同一修订会话续接，累计三次后不能重开或重复授权", async () => {
  const f = fixture();
  for (let used = 1; used <= 3; used++) {
    await assert.rejects(f.run({ runRole: async node => {
      await node.onSessionRef({ file: node.sessionStorage.file ?? "same-session.jsonl" }); await node.onModelCall();
      assert.equal(node.modelCalls, used - 1); throw new Error("固定中断");
    } }), /固定中断/u);
    f.record.status = "failed";
    assert.equal(f.record.reviewRevisionCheckpoint.modelCalls, used);
    assert.equal(f.record.reviewRevisionCheckpoint.sessionRef.file, "same-session.jsonl");
  }
  assert.equal(architectureReviewRevisionRecovery(f.record).status, "blocked");
  await assert.rejects(f.run({ runRole: () => assert.fail("额度耗尽不能请求") }), /额度已用完/u);
  assert.equal(f.record.designProgressCheckpoint.modelCalls, 15);
});

test("局部补丁必须解决真实反馈、保留编号且受原完整校验，错误结果不保存", async () => {
  const f = fixture();
  await assert.rejects(f.run({ runRole: async node => {
    await node.onSessionRef({ file: "same-session.jsonl" }); await node.onModelCall();
    assert.throws(() => node.validate({ baseHash: node.baseHash, updates: [{ path: "/instructions", value: f.source.design.instructions }] }), /必须实际解决/u);
    assert.throws(() => node.validate({ baseHash: node.baseHash, updates: [{ path: "/profile", value: "custom" }] }), /无法核验/u);
    assert.throws(() => node.validate({ baseHash: "0".repeat(64), updates: [{ path: "/instructions", value: "替换" }] }), /无法核验/u);
    assert.throws(() => node.validate({ baseHash: node.baseHash, updates: [{ path: "/instructions", value: "" }] }));
    throw new Error("固定拒绝");
  } }), /固定拒绝/u);
  assert.equal(f.record.reviewRevisionCheckpoint.result, null);
});

test("来源、会话或检查点损坏不回退成新修订预算", async () => {
  for (const damage of [
    f => { f.source.review.verdict = "pass"; },
    f => { f.record.requirements[0].text += "变化"; },
    f => { f.record.reviewRevisionCheckpoint.modelCalls = 0; },
    f => { f.record.reviewRevisionCheckpoint.sessionRef.file = "../outside.jsonl"; },
    f => { f.record.designProgressCheckpoint.modelCalls = 14; },
  ]) {
    const f = fixture();
    await assert.rejects(f.run({ runRole: async node => {
      await node.onSessionRef({ file: "same-session.jsonl" }); await node.onModelCall(); throw new Error("固定中断");
    } }));
    damage(f);
    await assert.rejects(f.run({ runRole: () => assert.fail("损坏来源不能请求") }));
  }
});

test("请求前持久扣数失败不发模型请求，不补存被拒保存的修订成果", async () => {
  const f = fixture(); let writes = 0, sent = false;
  await assert.rejects(f.run({ onSave: async () => { if (++writes === 3) throw new Error("保存失败"); }, runRole: async node => {
    await node.onSessionRef({ file: "same-session.jsonl" }); await node.onModelCall(); sent = true;
  } }), /保存失败/u);
  assert.equal(sent, false); assert.equal(f.record.reviewRevisionCheckpoint.modelCalls, 0);
  const g = fixture();
  await assert.rejects(g.run({ onSave: async checkpoint => { if (checkpoint.result) throw new Error("成果保存失败"); } }), /成果保存失败/u);
  assert.equal(g.record.reviewRevisionCheckpoint.result, null); assert.equal(g.record.reviewRevisionCheckpoint.modelCalls, 1);
});

test("首次成果保存失败锁住后续请求与迟到成果，原计数不倒退", async () => {
  const f = fixture();
  await assert.rejects(f.run({ onSave: async checkpoint => { if (checkpoint.result) throw new Error("持久化失败"); }, runRole: async node => {
    await node.onSessionRef({ file: "same-session.jsonl" }); await node.onModelCall();
    const result = node.validate({ baseHash: node.baseHash, updates: [{ path: "/instructions", value: f.source.design.instructions + " 补充原处理边界。" }] });
    await assert.rejects(node.onResult(result), /持久化失败/u);
    await assert.rejects(node.onModelCall(), /持久化失败/u);
    await assert.rejects(node.onResult(result), /持久化失败/u);
    throw new Error("固定结束");
  } }), /固定结束/u);
  assert.equal(f.record.reviewRevisionCheckpoint.modelCalls, 1); assert.equal(f.record.reviewRevisionCheckpoint.result, null);
});

test("已知修订检查点缺失和契约变化均拒绝重领授权", async () => {
  const f = fixture(); await f.run(); f.record.status = "failed";
  const checkpoint = f.record.reviewRevisionCheckpoint;
  delete f.record.reviewRevisionCheckpoint;
  assert.equal(architectureReviewRevisionRecovery(f.record).status, "blocked");
  f.record.reviewRevisionCheckpoint = checkpoint;
  await assert.rejects(f.run({ candidateSchema: { changed: true }, runRole: () => assert.fail("新契约不能沿旧会话") }));
});

test("不能以无关说明换取新评审，原验收类型和正式需求归属冻结", async () => {
  const f = fixture();
  f.source.issues[0].candidateFields = ["acceptance"];
  f.source.issues[0].candidatePaths = ["/acceptance/0/verification"];
  await assert.rejects(f.run({ runRole: async node => {
    await node.onSessionRef({ file: "same-session.jsonl" }); await node.onModelCall();
    assert.throws(() => node.validate({ baseHash: node.baseHash, updates: [{ path: "/instructions", value: f.source.design.instructions + " 无关说明。" }] }), /未改变任何阻断/u);
    const rows = structuredClone(f.source.design.acceptance);
    rows[0].kind = rows[0].kind === "normal" ? "failure" : "normal";
    assert.throws(() => node.validate({ baseHash: node.baseHash, updates: [{ path: "/acceptance", value: rows }] }));
    throw new Error("固定结束");
  } }), /固定结束/u);
  assert.equal(f.record.reviewRevisionCheckpoint.result, null);
});

test("修订后的证据不足、不可行及返需终态不能绕回旧设计重领额度", async () => {
  const f = fixture(); await f.run();
  for (const status of ["needs_evidence", "infeasible", "needs_input"]) {
    f.record.status = status;
    const recovery = architectureReviewRevisionRecovery(f.record);
    assert.equal(recovery.status, "blocked"); assert.equal(recovery.request, undefined);
  }
});

test("输出格式错误可沿同一修订继续到10次，内容错误仍在3次停止", async () => {
  const f = fixture();
  for (let used = 1; used <= 3; used++) {
    await assert.rejects(f.run({ runRole: async node => {
      await node.onSessionRef({ file: "same-session.jsonl" });
      await node.onModelCall({ formatSubmission: used > 1 });
      throw new Error("格式拒绝");
    } }), /格式拒绝/u);
    f.record.status = "failed";
    f.record.diagnostic = { lastSubmissionIssue: { path: "review_revision.updates", reason: "invalid_type" } };
  }
  const recovery = architectureReviewRevisionRecovery(f.record);
  assert.equal(recovery.status, "continuing");
  assert.equal(recovery.modelCallLimit, 10);
  assert.match(recovery.message, /输出格式/u);
  for (let used = 4; used <= 10; used++) {
    await assert.rejects(f.run({ formatSubmissionIssue: f.record.diagnostic.lastSubmissionIssue, runRole: async node => {
      assert.equal(node.resumeSubmissionIssue.reason, "invalid_type");
      assert.equal(node.formatSubmissionLimit, 10);
      await node.onSessionRef({ file: "same-session.jsonl" });
      await node.onModelCall({ formatSubmission: true });
      assert.equal(f.record.reviewRevisionCheckpoint.modelCalls, used);
      throw new Error("格式拒绝");
    } }), /格式拒绝/u);
    f.record.status = "failed";
  }
  assert.equal(architectureReviewRevisionRecovery(f.record).status, "blocked");
  await assert.rejects(f.run({ formatSubmissionIssue: f.record.diagnostic.lastSubmissionIssue,
    runRole: () => assert.fail("十次后不能再请求") }), /额度已用完/u);

  const content = fixture();
  for (let used = 1; used <= 3; used++) {
    await assert.rejects(content.run({ runRole: async node => {
      await node.onSessionRef({ file: "same-session.jsonl" });
      await node.onModelCall();
      throw new Error("内容拒绝");
    } }), /内容拒绝/u);
    content.record.status = "failed";
    content.record.diagnostic = { lastSubmissionIssue: { path: "review_revision.updates", reason: "review_unchanged" } };
  }
  assert.equal(architectureReviewRevisionRecovery(content.record).status, "blocked");
  await assert.rejects(content.run({ formatSubmissionIssue: content.record.diagnostic.lastSubmissionIssue,
    runRole: () => assert.fail("内容错误不能加到10次") }), /额度已用完/u);
  content.record.diagnostic = { lastSubmissionIssue: { path: "design.steps[3].componentId", reason: "invalid_reference" } };
  assert.equal(architectureReviewRevisionRecovery(content.record).status, "continuing");
  assert.equal(architectureReviewRevisionRecovery(content.record).modelCallLimit, 10);
});

test("格式续试期间接口中断不结束修订，内容错误在超过3次后仍停止", async () => {
  const f = fixture();
  for (let used = 1; used <= 4; used++) {
    await assert.rejects(f.run({ formatSubmissionIssue: used > 3 ? f.record.diagnostic.lastSubmissionIssue : undefined, runRole: async node => {
      await node.onSessionRef({ file: "same-session.jsonl" });
      await node.onModelCall({ formatSubmission: used > 1 });
      throw new Error("格式拒绝");
    } }), /格式拒绝/u);
    f.record.status = "failed";
    f.record.diagnostic = { lastSubmissionIssue: { path: "review_revision.updates", reason: "invalid_type" } };
  }
  f.record.diagnostic = { reason: "api_connection" };
  const recovery = architectureReviewRevisionRecovery(f.record);
  assert.equal(f.record.reviewRevisionCheckpoint.modelCalls, 4);
  assert.equal(recovery.status, "continuing");
  assert.equal(recovery.modelCallLimit, 10);
  assert.match(recovery.message, /连接中断/u);
  await assert.rejects(f.run({ runRole: async node => {
    assert.equal(node.resumeSubmissionIssue, undefined);
    await node.onSessionRef({ file: "same-session.jsonl" });
    await node.onModelCall({ formatSubmission: true });
    throw new Error("连接后续试");
  } }), /连接后续试/u);

  f.record.diagnostic = { lastSubmissionIssue: { path: "design.steps[3].componentId", reason: "invalid_reference" } };
  const referenceRecovery = architectureReviewRevisionRecovery(f.record);
  assert.equal(referenceRecovery.status, "continuing");
  assert.match(referenceRecovery.message, /不存在的编号/u);
  await assert.rejects(f.run({ formatSubmissionIssue: f.record.diagnostic.lastSubmissionIssue, runRole: async node => {
    assert.equal(node.resumeSubmissionIssue.reason, "invalid_reference");
    await node.onSessionRef({ file: "same-session.jsonl" });
    await node.onModelCall({ formatSubmission: true });
    throw new Error("编号修正");
  } }), /编号修正/u);
  f.record.diagnostic = { lastSubmissionIssue: { path: "design.acceptance", reason: "missing_coverage" } };
  const acceptanceRecovery = architectureReviewRevisionRecovery(f.record);
  assert.equal(acceptanceRecovery.status, "continuing");
  assert.equal(acceptanceRecovery.modelCallLimit, 10);
  await assert.rejects(f.run({ formatSubmissionIssue: f.record.diagnostic.lastSubmissionIssue, runRole: async node => {
    assert.equal(node.resumeSubmissionIssue.reason, "missing_coverage");
    await node.onSessionRef({ file: "same-session.jsonl" });
    await node.onModelCall({ formatSubmission: true });
    throw new Error("验收再改");
  } }), /验收再改/u);
  f.record.reviewRevisionCheckpoint.modelCalls = 10;
  const { hash: _ignored, ...body } = f.record.reviewRevisionCheckpoint;
  f.record.reviewRevisionCheckpoint = { ...body, hash: designHash(body) };
  f.record.diagnostic = { lastSubmissionIssue: { path: "design.acceptance", reason: "missing_coverage" } };
  assert.equal(architectureReviewRevisionRecovery(f.record).status, "blocked");
});

test("同一会话格式续试转为内容错误后，在下一请求前收回扩展额度", async t => {
  const f = fixture();
  await assert.rejects(f.run({ runRole: async node => {
    await node.onSessionRef({ file: "same-session.jsonl" });
    for (let index = 0; index < 3; index++) await node.onModelCall();
    throw new Error("format submission interrupted");
  } }));
  f.record.status = "failed";
  const formatSubmissionIssue = { path: "review_revision.updates", reason: "invalid_type" };
  const root = await mkdtemp(join(tmpdir(), "neuma-review-content-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0, submissionIssue;
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: root,
    sessionFactory: async options => ({ messages: [], modelCallAccounting: true,
      sessionFile: join(root, "same-session.jsonl"), subscribe: () => () => {}, dispose() {}, async abort() {},
      async prompt() {
        await options.onModelCall(); requests++;
        const submit = options.customTools.find(tool => tool.name === "submit_architecture_review_revision");
        await assert.rejects(submit.execute("unchanged-content", { baseHash: f.source.candidateHash,
          updates: [{ path: "/instructions", value: f.source.design.instructions }] }), error => {
          submissionIssue = error.validationIssue;
          return /修订必须实际解决评审问题/u.test(error.message);
        });
        await options.onModelCall(); requests++;
        throw new Error("unexpected request after content rejection");
      } }) });
  await assert.rejects(f.run({ formatSubmissionIssue, runRole: node => designer.role({ ...node, role: "designer",
    agentId: f.record.agentId, systemPrompt: "offline fixture", payload: { pipelineStage: "review_revision" },
    submitName: "submit_architecture_review_revision", initialModelCalls: node.modelCalls,
    onStageModelCall: node.onModelCall, onStageResult: node.onResult,
    onDiagnostics: diagnostic => { f.record.diagnostic = diagnostic; } }) }), error => error.diagnostic?.reason === "turn_limit");
  assert.equal(requests, 1);
  assert.equal(submissionIssue.reason, "invalid_value");
  assert.equal(f.record.reviewRevisionCheckpoint.modelCalls, 4);
  assert.equal(f.record.reviewRevisionCheckpoint.result, null);
  assert.equal(architectureReviewRevisionRecovery(f.record).status, "blocked");
});

test("手动续评只接受绑定完整的引用或格式失败，授权不改变原5次且损坏不能回退", async () => {
  const f = fixture(), candidate = await f.run();
  Object.assign(f.record, { design: candidate, candidateHash: designHash(candidate), status: "failed", diagnostic: {
    role: "reviewer", phase: "evaluating", reason: "turn_limit", lastSubmissionIssue: { path: "review.issues[0].candidatePaths[1]", reason: "candidate_path_missing" } } });
  f.record.reviewProgressCheckpoint = createReviewProgressCheckpoint(f.record, null, 5);
  const original = structuredClone(f.record), grant = createArchitectureReviewRetry(f.record);
  assert.equal(architectureReviewRevisionRecovery(f.record).status, "available");
  assert.deepEqual(f.record, original);
  for (const change of [
    r => { r.diagnostic.lastSubmissionIssue.reason = "contradictory_review"; },
    r => { r.review = { verdict: "revise" }; },
    r => { r.reviewProgressCheckpoint.hash = "0".repeat(64); },
    r => { r.diagnostic.reason = "scope_not_preserved"; },
  ]) {
    const invalid = structuredClone(original); change(invalid);
    assert.throws(() => createArchitectureReviewRetry(invalid));
  }
  f.record.version++;
  f.record.reviewProgressCheckpoint = createReviewProgressCheckpoint(f.record, null, 5);
  f.record.reviewRetryCheckpoint = grant;
  assert.deepEqual(readArchitectureReviewRetry(f.record), grant);
  assert.equal(architectureReviewRevisionRecovery(f.record).status, "continuing");
  assert.throws(() => createArchitectureReviewRetry(f.record));
  f.record.reviewRetryCheckpoint.additionalCalls = 3;
  assert.throws(() => readArchitectureReviewRetry(f.record));
  assert.equal(architectureReviewRevisionRecovery(f.record).status, "blocked");
});

test("明确测试授权保留旧7次用量与来源，仅补两次，不能再次追加或跨候选复用", async () => {
  const f = fixture(), candidate = await f.run();
  Object.assign(f.record, { design: candidate, candidateHash: designHash(candidate), status: "failed", diagnostic: {
    role: "reviewer", reason: "turn_limit", lastSubmissionIssue: { reason: "candidate_path_missing" } } });
  f.record.reviewProgressCheckpoint = createReviewProgressCheckpoint(f.record, null, 5);
  const first = createArchitectureReviewRetry(f.record);
  f.record.version++; f.record.reviewRetryCheckpoint = first;
  f.record.reviewProgressCheckpoint = createReviewProgressCheckpoint(f.record, null, 7);
  const original = structuredClone(f.record);
  const authorization = { kind: "user_requested_test", authorizedAt: "2026-10-22T14:00:00.000Z", reason: "修复后恢复手动测试，保留原方案和检查结果" };
  assert.throws(() => createArchitectureReviewTestRetry(f.record));
  const grant = createArchitectureReviewTestRetry(f.record, authorization);
  assert.deepEqual(f.record, original);
  assert.equal(grant.previousCheckpointHash, first.hash);
  assert.equal(grant.source.progressHash, original.reviewProgressCheckpoint.hash);
  f.record.version++; f.record.reviewRetryCheckpoint = grant;
  f.record.reviewProgressCheckpoint = createReviewProgressCheckpoint(f.record, null, 7);
  assert.deepEqual(readArchitectureReviewRetry(f.record), grant);
  assert.equal(architectureReviewRevisionRecovery(f.record).status, "continuing");
  assert.equal(architectureReviewRevisionRecovery(f.record).modelCallLimit, 9);
  assert.throws(() => createArchitectureReviewTestRetry(f.record, authorization));
  const changed = structuredClone(f.record); changed.candidateHash = "c".repeat(64);
  assert.throws(() => readArchitectureReviewRetry(changed));
  f.record.reviewProgressCheckpoint = createReviewProgressCheckpoint(f.record, null, 9);
  assert.equal(architectureReviewRevisionRecovery(f.record).status, "available");
  assert.equal(architectureReviewRevisionRecovery(f.record).actionLabel, "继续设计");
  assert.equal(architectureReviewRevisionRecovery(f.record).request.kind, "review_continue");
  const continuation = createArchitectureReviewContinuation(f.record);
  assert.equal(continuation.source.modelCalls, 9); assert.equal(continuation.additionalCalls, 5);
  assert.equal(continuation.previousCheckpointHash, grant.hash);
  f.record.reviewProgressCheckpoint = createReviewProgressCheckpoint(f.record, null, 10);
  assert.throws(() => readArchitectureReviewRetry(f.record));
  f.record.version++; f.record.reviewRetryCheckpoint = continuation;
  f.record.reviewProgressCheckpoint = createReviewProgressCheckpoint(f.record, null, 13);
  assert.ok(f.record.reviewProgressCheckpoint); assert.ok(readArchitectureReviewRetry(f.record));
  assert.equal(architectureReviewRevisionRecovery(f.record).status, "continuing");
  assert.equal(architectureReviewRevisionRecovery(f.record).modelCallLimit, 14);
  const stalled = { lastSubmissionIssue: { path: "review.issues[2].references[1]", reason: "reference_too_broad" },
    repeatedFailure: { modelContractHash: "a".repeat(64), fingerprint: "b".repeat(64), count: 3 } };
  f.record.reviewProgressCheckpoint = createReviewProgressCheckpoint(f.record, null, 13, { diagnostic: stalled });
  const stoppedBefore = structuredClone(f.record), repaired = architectureReviewRevisionRecovery(f.record);
  assert.equal(repaired.status, "continuing"); assert.equal(repaired.actionLabel, "继续设计");
  assert.equal(repaired.modelCalls, 13); assert.equal(repaired.modelCallLimit, 14); assert.deepEqual(f.record, stoppedBefore);
  f.record.reviewProgressCheckpoint = createReviewProgressCheckpoint(f.record, null, 13, {
    diagnostic: { ...stalled, repeatedFailure: { ...stalled.repeatedFailure, protocolVersion: 2 } } });
  assert.equal(architectureReviewRevisionRecovery(f.record).status, "blocked", "同一新版规则再次停滞，重启不能解锁");
  f.record.reviewProgressCheckpoint = createReviewProgressCheckpoint(f.record, null, 13, {
    diagnostic: { ...stalled, lastSubmissionIssue: { ...stalled.lastSubmissionIssue, reason: "contradictory_review" } } });
  assert.equal(architectureReviewRevisionRecovery(f.record).status, "blocked", "未修复类型的旧错误不能解锁");
  f.record.reviewProgressCheckpoint = createReviewProgressCheckpoint(f.record, null, 14);
  assert.equal(architectureReviewRevisionRecovery(f.record).status, "available");
  assert.equal(createArchitectureReviewContinuation(f.record).source.modelCalls, 14);
  const damaged = structuredClone(f.record); damaged.reviewRetryCheckpoint.hash = "0".repeat(64);
  assert.equal(architectureReviewRevisionRecovery(damaged).status, "blocked");
  assert.equal(createReviewProgressCheckpoint(damaged, null, 14), null);
});

test("第5次范围结果已真实保存时仅允许重验现有结果，不要求新增评审额度", async () => {
  const f = fixture(), candidate = await f.run();
  f.record.design = candidate; f.record.candidateHash = designHash(candidate); f.record.status = "cancelled";
  f.record.mainReviewCheckpoint = createMainReviewCheckpoint(f.record, { verdict: "pass", candidateHash: f.record.candidateHash }, 5);
  f.record.requirementFidelityProgress = createArchitectureFidelityProgress(f.record, { contextHash: "a".repeat(64), schemaHash: "b".repeat(64),
    sessionBindingHash: "c".repeat(64), sessionFile: "fixed-fidelity.jsonl", calls: 2, diagnostic: { resultAvailable: true } }, 5);
  assert.ok(f.record.mainReviewCheckpoint); assert.ok(f.record.requirementFidelityProgress);
  assert.equal(architectureReviewRevisionRecovery(f.record).status, "continuing");
  f.record.requirementFidelityProgress.hash = "0".repeat(64);
  assert.equal(architectureReviewRevisionRecovery(f.record).status, "blocked");
});
