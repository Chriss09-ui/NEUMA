import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { designHash } from "../src/architecture/architecture-contract.mjs";
import { createReviewProgressCheckpoint } from "../src/architecture/architecture-review-progress.mjs";
import { validDraft, validDesign, passingReview, withPriorFindingDecisions } from "./helpers/architecture.mjs";

function candidate(requirements) {
  return validDesign(requirements, { schemaVersion: 3, connections: [],
    interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "工作记录", results: "完整周报", persistentData: "无" },
    execution: { language: "none", hosting: "builtin", reason: "已有文本能力" },
    selectionBasis: { capacity: "当前输入", process: "完整处理", quality: "不编造", requirementIds: requirements.map((item) => item.id), assumptions: [] } });
}

function revise(payload) {
  const review = passingReview(payload.candidateHash, payload.design);
  review.verdict = "revise"; review.checks.find((item) => item.id === "verification").passed = false;
  review.issues = [{ id: "precision", blocking: true, description: "核对当前边界", remedy: "保持原边界并补齐检查",
    checkId: "verification", kind: "design", candidatePaths: ["/acceptance/2/expected"],
    references: [{ source: "candidate", path: "/acceptance/2/expected", quote: "尚未发送" }], factClaims: [] }];
  return withPriorFindingDecisions(review, payload.priorFindings);
}

async function fixture(t, { initial = "submission_incomplete", captureReceipt = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-review-recovery-")), calls = [];
  const definition = { id: "pending", name: "独立评审续接", draft: validDraft(), fingerprint: "same-source" };
  let phase = "initial", mode = "pass", initialReviews = 0, resumedReviews = 0, oldReceipt, initialReview;
  const controller = new AbortController();
  let designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"),
    sessionFactory: async (options) => {
      const tools = Object.fromEntries(options.customTools.map((tool) => [tool.name, tool]));
      const role = tools.submit_architecture ? "designer" : "reviewer";
      const session = { messages: [], subscribe: () => () => {}, async abort() {}, dispose() {}, async prompt(text) {
        const payload = JSON.parse(text); calls.push({ phase, role, payload, session });
        if (role === "designer") {
          if (phase === "initial" && initial === "revise_then_api_error" && initialReviews) throw new Error("unclassified fixture failure");
          if (phase === "resume" && payload.editableSubmission) {
            return tools.revise_architecture_submission.execute("partial", { submissionHash: payload.editableSubmission.submissionHash,
              updates: [{ path: "/instructions", value: payload.previousDesign.instructions + " 已按本轮意见核对边界。" }] });
          }
          return tools.submit_architecture.execute("design", candidate(payload.requirements));
        }
        if (phase === "initial") {
          initialReviews++;
          if (captureReceipt) oldReceipt = JSON.parse((await tools.read_architecture_evidence.execute("old-read", {
            source: "candidate", pointer: "/acceptance/2/expected" })).content[0].text).receiptId;
          if (initial === "revise_then_api_error") return tools.submit_architecture_review.execute("initial-revise", revise(payload));
          if (initial === "cancelled") { controller.abort(); throw new Error("cancelled fixture"); }
          if (initial === "api_connection") throw new Error("fetch failed");
          if (initial === "json_then_valid") {
            initialReview ??= passingReview(payload.candidateHash, payload.design);
            const review = structuredClone(initialReview);
            if (initialReviews === 1) delete review.candidateHash;
            else review.checks[0].passed = false;
            session.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(review) }] }); return;
          }
          session.messages.push({ role: "assistant", stopReason: "stop", content: [] }); return;
        }
        resumedReviews++;
        if (mode === "stale_receipt_then_pass") {
          assert.ok(oldReceipt);
          const bad = revise(payload); bad.issues[0].references = [{ receiptId: oldReceipt }];
          await assert.rejects(tools.submit_architecture_review.execute("stale-receipt", bad),
            (error) => error.validationIssue?.reason === "invalid_receipt");
          const current = JSON.parse((await tools.read_architecture_evidence.execute("fresh-read", {
            source: "candidate", pointer: "/acceptance/2/expected" })).content[0].text);
          assert.notEqual(current.receiptId, oldReceipt, "相同候选的新评审必须产生新的宿主回执");
        }
        if (mode === "cancelled") { controller.abort(); throw new Error("cancelled fixture"); }
        if (mode === "api_connection") throw new Error("fetch failed");
        if (mode === "continue_draft") return tools.revise_architecture_submission.execute("resumed-draft", {
          submissionHash: payload.reviewDraft.rejectedSubmission.submissionHash, updates: [{ path: "/summary", value: "继续同一评审并核对完整材料" }, { path: "/checks/0/passed", value: true }] });
        const review = mode === "always_revise" || mode === "revise_then_pass" && resumedReviews === 1
          ? revise(payload) : passingReview(payload.candidateHash, payload.design, payload.priorFindings);
        return tools.submit_architecture_review.execute("fresh-review", review);
      } };
      return session;
    } });
  t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  await assert.rejects(designer.design(definition, { signal: controller.signal }), (error) =>
    error.diagnostic.reason === (initial === "revise_then_api_error" ? "api_error" : initial === "json_then_valid" ? "submission_incomplete" : initial));
  const source = await designer.get(definition.id);
  assert.equal(source.status, initial === "cancelled" ? "cancelled" : "failed");
  assert.ok(source.design); assert.equal(source.candidateHash, designHash(source.design));
  assert.equal(source.reviewEvidence.version, 2);
  return { get designer() { return designer; }, definition, calls, source, reload: async () => {
    await designer.persistence;
    designer = new ArchitectureDesigner({ config: designer.config, cwd: root, dataDir: join(root, "data"), sessionFactory: designer.sessionFactory });
    await designer.ready;
  }, resume: async ({ result = "pass", next = definition, signal } = {}) => {
    phase = "resume"; mode = result;
    return designer.design(next, { signal });
  } };
}

for (const reason of ["submission_incomplete", "api_connection", "cancelled"]) {
  test(`完整候选在${reason}后直接续评，不重抄候选或继承通过，已用预算继续累计`, async (t) => {
    const f = await fixture(t, { initial: reason }), before = designHash(f.source);
    assert.equal(f.source.review, null); assert.deepEqual(f.source.attempts, []);
    const result = await f.resume(), calls = f.calls.filter((item) => item.phase === "resume");
    assert.deepEqual(calls.map((item) => item.role), ["reviewer"]);
    assert.notEqual(calls[0].session, f.calls.find((item) => item.role === "reviewer").session);
    assert.deepEqual(calls[0].payload.design, f.source.design);
    assert.equal(result.candidateHash, f.source.candidateHash);
    assert.equal(result.status, "passed"); assert.equal(result.delivery, "blocked");
    assert.equal(result.attempts.length, 1); assert.equal(result.review.verdict, "pass");
    assert.equal(result.revisionSource.kind, "review-continuation");
    assert.equal(result.revisionSource.version, f.source.version);
    const previousCalls = f.source.reviewProgressCheckpoint.modelCalls;
    assert.equal(previousCalls, reason === "submission_incomplete" ? 2 : 1);
    assert.deepEqual(calls[0].payload.modelBudget, { limit: 12, used: previousCalls + 1, remaining: 11 - previousCalls });
    assert.equal(result.diagnostic, undefined);
    assert.equal(designHash(await f.designer.getVersion(f.definition.id, f.source.version)), before);
  });
}

test("首轮正文结构坏、次轮完整稿语义拒绝时保存，重启用新编号局部续交而不自动通过", async (t) => {
  const f = await fixture(t, { initial: "json_then_valid" }), sourceHash = designHash(f.source);
  assert.equal(f.source.reviewProgressCheckpoint.origin, "semantic-rejected");
  assert.equal(f.source.reviewProgressCheckpoint.modelCalls, 2);
  assert.ok(f.source.reviewProgressCheckpoint.review); assert.equal(f.source.review, null);
  await f.reload();
  const next = await f.resume({ result: "continue_draft" }), resumed = f.calls.filter((entry) => entry.phase === "resume");
  assert.deepEqual(resumed.map((entry) => entry.role), ["reviewer"]);
  assert.equal(resumed[0].payload.reviewDraft.trust, "untrusted-reference");
  assert.deepEqual(resumed[0].payload.reviewDraft.review, f.source.reviewProgressCheckpoint.review);
  assert.match(resumed[0].payload.reviewDraft.rejectedSubmission.submissionHash, /^[a-f0-9]{64}$/);
  assert.equal(next.status, "passed"); assert.equal(next.review.summary, "继续同一评审并核对完整材料");
  assert.equal(next.reviewProgressCheckpoint.modelCalls, 3);
  assert.equal(designHash(await f.designer.getVersion(f.definition.id, f.source.version)), sourceHash);
});

test("同材料评审累计额度耗尽后显式重试也不再发请求", async (t) => {
  const f = await fixture(t), source = structuredClone(f.source);
  source.reviewProgressCheckpoint = createReviewProgressCheckpoint(source, null, 12);
  assert.ok(source.reviewProgressCheckpoint); await f.designer.save(source); await f.reload();
  const before = f.calls.length;
  await assert.rejects(f.resume(), (error) => error.diagnostic.reason === "turn_limit" && error.diagnostic.modelCalls === 12);
  assert.equal(f.calls.length, before); assert.equal((await f.designer.get(f.definition.id)).review, null);
});

test("进程退出没有机会写最终诊断时，重启仍识别请求前保存的评审草稿和累计额度", async (t) => {
  const f = await fixture(t, { initial: "json_then_valid" }), interrupted = structuredClone(f.source);
  interrupted.status = "evaluating"; delete interrupted.diagnostic;
  await f.designer.save(interrupted); await f.reload();
  const loaded = await f.designer.get(f.definition.id);
  assert.equal(loaded.diagnostic.reason, "process_interrupted");
  assert.equal(loaded.reviewProgressCheckpoint.modelCalls, 2); assert.equal(loaded.review, null);
  const next = await f.resume({ result: "continue_draft" }), resumed = f.calls.filter((entry) => entry.phase === "resume");
  assert.deepEqual(resumed.map((entry) => entry.role), ["reviewer"]);
  assert.equal(resumed[0].payload.modelBudget.used, 3); assert.equal(next.status, "passed");
});

test("待评候选只能续接当前同来源完整材料，损坏绑定或不受控原因回到设计", async (t) => {
  const changes = [
    ["agent", (record) => { record.agentId = "another"; }],
    ["name", (record) => { record.name += " changed"; }],
    ["fingerprint", (record) => { record.sourceFingerprint += " changed"; }],
    ["draft", (record) => { record.draft.goal.value += " changed"; }],
    ["requirements", (record) => { record.requirements[0].text += " changed"; }],
    ["platform", (record) => { record.platformHash = "0".repeat(64); }],
    ["runtime", (record) => { record.runtimeCapabilities.hash = "0".repeat(64); }],
    ["confirmed", (record) => { record.confirmedRequirementContext = { hash: "changed" }; }],
    ["deferred", (record) => { record.deferredVerifications = { issues: [] }; }],
    ["candidate", (record) => { record.design.instructions += " changed"; }],
    ["context", (record) => { record.reviewContext.candidateHash = "0".repeat(64); }],
    ["snapshot hash", (record) => { record.reviewEvidence.snapshotHash = "0".repeat(64); }],
    ["snapshot", (record) => { record.reviewEvidence.snapshot.contextManifest.candidate.sha256 = "0".repeat(64); }],
    ["missing attempts", (record) => { delete record.attempts; }],
    ["invalid issues", (record) => { record.issues = {}; }],
    ["evidence", (record) => { record.evidence[0].excerpt += " changed"; }],
    ["modules", (record) => { record.modules = [{ assignment: { question: "q", boundary: "b", benefit: "b" },
      result: { proposal: "p", interfaces: "i", tradeoffs: "t", evidenceIds: ["missing"], unknowns: [] } }]; }],
    ["already reviewed", (record) => { record.review = passingReview(record.candidateHash, record.design); }],
    ["unknown reason", (record) => { record.diagnostic.reason = "api_error"; }],
    ["wrong phase", (record) => { record.diagnostic.phase = "designing"; }],
    ["program blocker", (record) => { record.issues = [{ blocking: true }]; }],
  ];
  for (const [label, change] of changes) {
    await t.test(label, async (t) => {
      const f = await fixture(t), changed = structuredClone(f.source), get = f.designer.get.bind(f.designer);
      change(changed); f.designer.get = async () => structuredClone(changed);
      const result = await f.resume(); f.designer.get = get;
      const resumed = f.calls.filter((item) => item.phase === "resume");
      assert.equal(resumed[0].role, "designer"); assert.equal(resumed[0].payload.previousDesign, null);
      assert.equal(result.revisionSource, undefined);
      assert.deepEqual(await f.designer.getVersion(f.definition.id, f.source.version), f.source);
    });
  }
});

for (const mode of ["revise_then_pass", "always_revise"]) {
  test(`续接评审${mode}仍只用原有两轮预算，修改走宿主局部提交`, async (t) => {
    const f = await fixture(t), result = await f.resume({ result: mode });
    const calls = f.calls.filter((item) => item.phase === "resume");
    assert.deepEqual(calls.map((item) => item.role), ["reviewer", "designer", "reviewer"]);
    assert.equal(calls[1].payload.remaining.revisions, 0);
    assert.deepEqual(calls[1].payload.previousDesign, f.source.design);
    assert.ok(calls[1].payload.editableSubmission.submissionHash);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.status, mode === "always_revise" ? "needs_changes" : "passed");
    assert.deepEqual(result.design.acceptance, f.source.design.acceptance);
    assert.equal(result.delivery, "blocked");
  });
}

test("续接新评审再遇技术错误不能用旧候选充当评审通过", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.resume({ result: "api_connection" }), (error) => error.diagnostic.reason === "api_connection");
  const result = await f.designer.get(f.definition.id);
  assert.equal(result.status, "failed"); assert.equal(result.review, null); assert.equal(result.delivery, "blocked");
  assert.deepEqual(result.attempts, []); assert.deepEqual(result.design, f.source.design);
});

test("续接使用新评审回执nonce，同候选旧回执不能冒充当前读取证据", async (t) => {
  const f = await fixture(t, { initial: "api_connection", captureReceipt: true });
  const result = await f.resume({ result: "stale_receipt_then_pass" });
  assert.equal(result.status, "passed"); assert.equal(result.attempts.length, 1);
  assert.deepEqual(f.calls.filter((item) => item.phase === "resume").map((item) => item.role), ["reviewer"]);
});

test("同版真实revise后的设计技术错误保留已完成评审意见，不受后续未知错误分类影响", async (t) => {
  const f = await fixture(t, { initial: "revise_then_api_error" });
  assert.equal(f.source.diagnostic.reason, "api_error"); assert.equal(f.source.attempts.length, 1);
  assert.equal(f.source.review.verdict, "revise");
  const result = await f.resume(), calls = f.calls.filter((item) => item.phase === "resume");
  assert.deepEqual(calls.map((item) => item.role), ["designer", "reviewer"]);
  assert.deepEqual(calls[0].payload.previousDesign, f.source.attempts[0].design);
  assert.deepEqual(calls[0].payload.issues, f.source.attempts[0].issues);
  assert.equal(calls[0].payload.revisionSource.attemptIndex, 0);
  assert.equal(result.status, "passed"); assert.equal(result.attempts.length, 1);
  assert.deepEqual(await f.designer.getVersion(f.definition.id, f.source.version), f.source);
});
