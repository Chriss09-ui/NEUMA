import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { designHash } from "../src/architecture/architecture-contract.mjs";
import { createMainReviewCheckpoint, readMainReviewCheckpoint } from "../src/architecture/architecture-main-review-checkpoint.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";
import { fidelityResult } from "./helpers/fidelity.mjs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createArchitectureStageSessionFactory } from "./helpers/architecture-stages.mjs";

function assertRevisionBase(payload, original) {
  assert.equal(payload.baseHash, designHash(payload.baseCandidate));
  const blueprint = original.designProgressCheckpoint.blueprint.result;
  assert.deepEqual(payload.blueprintBoundary, { globalFields: Object.keys(blueprint.global).filter(key => key !== "instructions"),
    modules: blueprint.modules });
  assert.equal(Object.hasOwn(payload, "modules"), false, "整合不重复发送已经拼装的模块正文");
  assert.deepEqual({ ...payload.baseCandidate, instructions: original.design.instructions }, original.design,
    "整合仍使用原候选的冻结全局选择和全部模块正文");
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "neuma-main-review-checkpoint-")), calls = [], stageCalls = [], countsBeforeFidelity = [];
  const state = { fidelity: "interrupt", main: "valid", mainCalls: 1, controller: null, designSuffix: "", interruptDesigner: false };
  const draft = validDraft();
  draft.taskSpec = { version: 1, items: [{ id: "complete", dimension: "processing", content: "完整核对全部记录", applicability: "applies",
    critical: true, source: { kind: "user", evidence: [{ messageId: "source", quote: "完整核对全部记录" }] } }] };
  const definition = { id: "checkpoint", name: "正式主评审阶段检查点", fingerprint: "same-requirements", draft };
  let designer;
  const makeCandidate = (payload) => {
    const candidate = validDesign(payload.requirements, { schemaVersion: 3,
      connections: [], interaction: { defaultEntry: "conversation", page: false, operations: false,
        inputs: "全部记录", results: "完整结果", persistentData: "无" },
      execution: { language: "none", hosting: "builtin", reason: "已有文本能力" },
      selectionBasis: { capacity: "已确认边界", process: "完整处理", quality: "逐项核对",
        requirementIds: payload.requirements.map((item) => item.id), assumptions: [] } });
    candidate.instructions += state.designSuffix;
    return candidate;
  };
  const stageSessions = createArchitectureStageSessionFactory(makeCandidate, {
    onPrompt: ({ stage, payload, options }) => {
      stageCalls.push({ role: stage, payload });
      if (state.interruptDesigner && options.sessionStorage.binding.generation > 0)
        throw new Error("synthetic interruption before revised stage submission");
    },
  });
  const sessionFactory = async (options) => {
    const staged = await stageSessions(options); if (staged) return staged;
    const tools = Object.fromEntries(options.customTools.map((tool) => [tool.name, tool]));
    const role = tools.submit_architecture ? "designer" : "reviewer";
    const session = { messages: [], modelCallAccounting: true, subscribe: () => () => {}, dispose() {}, async abort() {}, async prompt(text) {
      const payload = JSON.parse(text); calls.push({ role, payload });
      for (let index = 0; index < (role === "reviewer" ? state.mainCalls : 1); index++) await options.onModelCall();
      if (role === "designer" && state.interruptDesigner) throw new Error("synthetic interruption before revised candidate submission");
      if (role === "designer") {
        return tools.submit_architecture.execute("candidate", makeCandidate(payload));
      }
      const review = passingReview(payload.candidateHash, payload.design, payload.priorFindings);
      review.acceptanceScopeChecks = payload.reviewEvidenceIndex.acceptanceScope.map((row) => ({ acceptanceId: row.acceptanceId,
        adapterRulePath: row.adapterRulePaths[0], sufficient: true, reason: "核对当前冻结执行范围" }));
      if (state.main === "json") {
        session.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(review) }] }); return;
      }
      if (state.main === "semantic") {
        review.checks[0].passed = false;
        await assert.rejects(tools.submit_architecture_review.execute("invalid", review));
        session.messages.push({ role: "assistant", stopReason: "stop", content: [] }); return;
      }
      if (state.main === "late-cancel") state.controller.abort();
      return tools.submit_architecture_review.execute("formal-review", review);
    } };
    return session;
  };
  const fidelitySessionFactory = async (options) => {
    const native = SessionManager.open(join(options.sessionStorage.directory, options.sessionStorage.file), options.sessionStorage.directory);
    const messages = native.buildSessionContext().messages;
    const source = messages.filter((message) => message.role === "user").map((message) => {
      try { return JSON.parse(typeof message.content === "string" ? message.content : message.content[0].text); } catch { return null; }
    }).find((payload) => payload?.requirements);
    const verdict = ["unproven", "narrowed"].includes(state.fidelity) ? state.fidelity : "preserved";
    let value = source ? fidelityResult(source, verdict) : undefined;
    const append = (message) => { native.appendMessage(message); messages.push(message); };
    const session = { messages, modelCallAccounting: true, setAutoCompactionEnabled() {}, dispose() {}, async abort() {}, async prompt(text) {
      append({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
      await options.onModelCall(); const payload = JSON.parse(text); calls.push({ role: "fidelity", payload });
      const saved = await designer.get(definition.id);
      assert.ok(readMainReviewCheckpoint(saved), "发送复核请求前完整检查点和本次记账必须已保存");
      countsBeforeFidelity.push(saved.mainReviewCheckpoint.modelCalls);
      if (payload.requirements) value = fidelityResult(payload, verdict);
      if (state.fidelity === "cancel") state.controller.abort();
      if (state.fidelity === "rejected-native") {
        const invalid = fidelityResult(source ?? payload, "narrowed");
        invalid.restrictions[0].candidatePath = "acceptance[unknown].expected";
        append({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "rejected-fidelity", name: "submit_requirement_fidelity", arguments: invalid }], timestamp: Date.now() });
        try { await options.customTools[0].execute("rejected-fidelity", invalid); }
        catch (error) {
          append({ role: "toolResult", toolCallId: "rejected-fidelity", toolName: "submit_requirement_fidelity", isError: true,
            content: [{ type: "text", text: error.message }], timestamp: Date.now() });
          throw error;
        }
      }
      if (["pass", "pass-cancel", "unproven", "narrowed"].includes(state.fidelity)) {
        append({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "fidelity", name: "submit_requirement_fidelity", arguments: value }], timestamp: Date.now() });
        const result = await options.customTools[0].execute("fidelity", value);
        append({ role: "toolResult", toolCallId: "fidelity", toolName: "submit_requirement_fidelity", isError: false, content: result.content, timestamp: Date.now() });
        if (state.fidelity === "pass-cancel") state.controller.abort();
        return result;
      }
      append({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "复核尚未给出正式判断" }], timestamp: Date.now() });
      if (state.fidelity === "interrupt") throw new Error("synthetic restart after the first fidelity call");
    } };
    return session;
  };
  designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"), sessionFactory, fidelitySessionFactory });
  t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  return { get designer() { return designer; }, state, calls, stageCalls, countsBeforeFidelity, definition,
    reload: async () => {
      await designer.persistence;
      designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"), sessionFactory, fidelitySessionFactory });
      await designer.ready;
    },
    run: () => designer.design(definition, { signal: state.controller?.signal }) };
}

test("第5次真实范围提交被拒后只作为未接受技术参考返设计，相同候选不获新评审额度", async (t) => {
  const f = await fixture(t); f.state.mainCalls = 4; f.state.fidelity = "rejected-native";
  await assert.rejects(f.run());
  const source = await f.designer.get(f.definition.id), sourceHash = designHash(source);
  assert.deepEqual(f.stageCalls.map(({ role }) => role), ["blueprint", "module", "integration"]);
  assert.equal(source.designProgressCheckpoint.modelCalls, 3);
  assert.equal(source.mainReviewCheckpoint.modelCalls, 5); assert.equal(source.mainReviewCheckpoint.fidelityStatus, "pending");
  assert.equal(source.requirementFidelityProgress.state.calls, 1);
  assert.equal(source.review, null); assert.deepEqual(source.attempts, []);
  await f.reload(); const start = f.calls.length, stageStart = f.stageCalls.length;
  await assert.rejects(f.run(), (error) => error.diagnostic.reason === "turn_limit");
  assert.deepEqual(f.calls.slice(start).map(({ role }) => role), [], "同候选不能重新独立评审或复核");
  assert.deepEqual(f.stageCalls.slice(stageStart).map(({ role }) => role), ["integration"]);
  const payload = f.stageCalls[stageStart].payload, feedback = payload.rejectedRequirementFidelitySubmission;
  assert.equal(feedback.trust, "untrusted-technical-reference"); assert.equal(feedback.modelCalls, 5);
  assert.equal(feedback.submission.restrictions[0].candidatePath, "acceptance[unknown].expected");
  assert.equal(feedback.diagnostic.valid, false); assert.equal(payload.revisionSource.reviewRepair.reason, "rejected_fidelity_submission");
  assert.equal((await f.designer.get(f.definition.id)).reviewProgressCheckpoint.modelCalls, 5);
  assert.equal(designHash(await f.designer.getVersion(f.definition.id, source.version)), sourceHash);
});

test("真实被拒复核可驱动新候选，但必须重新独立评审与范围复核", async (t) => {
  const f = await fixture(t); f.state.mainCalls = 4; f.state.fidelity = "rejected-native";
  await assert.rejects(f.run()); const original = await f.designer.get(f.definition.id);
  await f.reload(); const start = f.calls.length, stageStart = f.stageCalls.length;
  f.state.mainCalls = 1; f.state.fidelity = "pass"; f.state.designSuffix = "；修正实际技术说明，完整要求保持";
  const result = await f.run();
  assert.deepEqual(f.stageCalls.slice(stageStart).map(({ role }) => role), ["integration"]);
  assert.deepEqual(f.calls.slice(start).map(({ role }) => role), ["reviewer", "fidelity"]);
  assert.equal(result.status, "passed"); assert.notEqual(result.candidateHash, original.candidateHash);
  assert.equal(result.mainReviewCheckpoint.modelCalls, 2); assert.equal(result.requirementFidelity.verdict, "preserved");
});

test("被拒复核触发设计中断后沿原生来源续接，不丢5轮且不退回其他候选", async (t) => {
  const f = await fixture(t); f.state.mainCalls = 4; f.state.fidelity = "rejected-native";
  await assert.rejects(f.run()); const original = await f.designer.get(f.definition.id);
  await f.reload(); f.state.interruptDesigner = true;
  await assert.rejects(f.run()); const interrupted = await f.designer.get(f.definition.id);
  assert.equal(interrupted.candidateHash, null); assert.equal(interrupted.revisionSource.version, original.version);
  await f.reload(); f.state.interruptDesigner = false; const start = f.calls.length, stageStart = f.stageCalls.length;
  await assert.rejects(f.run(), (error) => error.diagnostic.reason === "turn_limit");
  assert.deepEqual(f.calls.slice(start).map(({ role }) => role), [], "同候选修订中断不能刷新原评审额度");
  assert.deepEqual(f.stageCalls.slice(stageStart).map(({ role }) => role), ["integration"]);
  assert.equal(f.stageCalls[stageStart].payload.rejectedRequirementFidelitySubmission.source.architectureVersion, original.version);
  assertRevisionBase(f.stageCalls[stageStart].payload, original);
  assert.equal((await f.designer.get(f.definition.id)).reviewProgressCheckpoint.modelCalls, 5);
});

test("被拒复核修订已标记时，坏repair不能降级为普通设计刷新原额度", async (t) => {
  const changes = [record => { delete record.revisionSource.reviewRepair; },
    record => { record.revisionSource.reviewRepair.reason = "unknown_repair"; },
    record => { record.revisionSource.reviewRepair.modelCalls = 0; },
    record => { record.revisionSource.reviewRepair.candidateHash = "b".repeat(64); },
    record => { record.revisionSource.rejectedFidelitySource.sessionHash = "c".repeat(64); }];
  for (const change of changes) await t.test(change.toString(), async (t) => {
    const f = await fixture(t); f.state.mainCalls = 4; f.state.fidelity = "rejected-native";
    await assert.rejects(f.run()); f.state.interruptDesigner = true;
    await assert.rejects(f.run()); const interrupted = await f.designer.get(f.definition.id);
    change(interrupted); await f.designer.save(interrupted); await f.reload(); const start = f.calls.length, stageStart = f.stageCalls.length;
    f.state.interruptDesigner = false;
    await assert.rejects(f.run(), /被拒复核/u);
    assert.equal(f.calls.length, start, "损坏来源必须在新模型请求前停止");
    assert.equal(f.stageCalls.length, stageStart);
  });
});

test("正式主评审通过宿主验证后复核中断，重启仅续范围复核且累计原预算", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run(), (error) => error.diagnostic.reason === "scope_evaluation_incomplete");
  const source = await f.designer.get(f.definition.id), before = designHash(source);
  assert.equal(source.review, null); assert.deepEqual(source.attempts, []);
  assert.equal(source.mainReviewCheckpoint.modelCalls, 2); assert.equal(source.mainReviewCheckpoint.fidelityStatus, "pending");
  assert.ok(source.mainReviewCheckpoint.review.acceptanceScopeChecks.every((row) => row.criterionQuote && row.adapterQuote && !row.adapterRulePath && !row.scopeReceiptId));
  assert.deepEqual(f.countsBeforeFidelity, [2]);
  await f.reload();
  const calls = f.calls.length, stageCount = f.stageCalls.length; f.state.fidelity = "pass";
  const next = await f.run();
  assert.deepEqual(f.calls.slice(calls).map(({ role }) => role), ["fidelity"]);
  assert.equal(f.stageCalls.length, stageCount, "已完成设计不能因范围复核恢复而重做");
  assert.equal(next.status, "passed"); assert.equal(next.attempts.length, 1); assert.equal(next.mainReviewCheckpoint.modelCalls, 3);
  assert.equal(next.reviewDiagnostics.at(-1).modelCalls, 3); assert.equal(f.countsBeforeFidelity.at(-1), 3);
  assert.equal(designHash(await f.designer.getVersion(f.definition.id, source.version)), before);
});

test("结构化JSON通过同一主评审校验，语义错误仍不能保存通过检查点", async (t) => {
  for (const main of ["json", "semantic"]) await t.test(main, async (t) => {
    const f = await fixture(t); f.state.main = main;
    await assert.rejects(f.run());
    const source = await f.designer.get(f.definition.id);
    assert.equal(Boolean(source.mainReviewCheckpoint), main === "json"); assert.equal(source.review, null);
    assert.equal(f.calls.filter(({ role }) => role === "fidelity").length, main === "json" ? 1 : 0);
  });
});

test("取消后的迟到提交不保存，取消前已保存检查点可在新显式构建中仅续复核", async (t) => {
  const late = await fixture(t); late.state.controller = new AbortController(); late.state.main = "late-cancel";
  await assert.rejects(late.run()); assert.equal((await late.designer.get(late.definition.id)).mainReviewCheckpoint, undefined);
  const f = await fixture(t); f.state.controller = new AbortController(); f.state.fidelity = "cancel";
  await assert.rejects(f.run()); const source = await f.designer.get(f.definition.id);
  assert.equal(source.status, "cancelled"); assert.equal(source.mainReviewCheckpoint.modelCalls, 2);
  f.state.controller = null; f.state.fidelity = "pass"; const count = f.calls.length, stageCount = f.stageCalls.length;
  const next = await f.run(); assert.equal(next.status, "passed");
  assert.deepEqual(f.calls.slice(count).map(({ role }) => role), ["fidelity"]); assert.equal(next.mainReviewCheckpoint.modelCalls, 3);
  assert.equal(f.stageCalls.length, stageCount);
});

test("检查点篡改或未知中断原因不得跳过新的主评审", async (t) => {
  for (const kind of ["tamper", "semantic-checkpoint", "unknown"]) await t.test(kind, async (t) => {
    const f = await fixture(t); await assert.rejects(f.run());
    const source = await f.designer.get(f.definition.id);
    if (kind === "tamper") source.mainReviewCheckpoint.review.summary += " changed";
    else if (kind === "semantic-checkpoint") {
      const invalid = structuredClone(source.mainReviewCheckpoint.review); invalid.checks[0].passed = false;
      source.mainReviewCheckpoint = createMainReviewCheckpoint(source, invalid, source.mainReviewCheckpoint.modelCalls);
      assert.ok(readMainReviewCheckpoint(source), "完整结构和hash本身不代替review语义校验");
    }
    else source.diagnostic.reason = "api_error";
    await f.designer.save(source); f.state.fidelity = "pass";
    const count = f.calls.length; assert.equal((await f.run()).status, "passed");
    assert.ok(f.calls.slice(count).some(({ role }) => role === "reviewer"));
  });
});

test("检查点已用5轮时恢复不新建主评审或发出额外复核请求", async (t) => {
  const f = await fixture(t); f.state.mainCalls = 3; f.state.fidelity = "text";
  await assert.rejects(f.run()); assert.equal((await f.designer.get(f.definition.id)).mainReviewCheckpoint.modelCalls, 5);
  f.state.fidelity = "pass"; const count = f.calls.length, stageCount = f.stageCalls.length;
  await assert.rejects(f.run(), (error) => error.diagnostic.reason === "turn_limit" && error.diagnostic.modelCalls === 5);
  assert.equal(f.calls.length, count); assert.equal((await f.designer.get(f.definition.id)).mainReviewCheckpoint.modelCalls, 5);
  assert.equal(f.stageCalls.length, stageCount);
});

test("有效范围否定直接给设计者技术修订，新候选仍经过完整独立评审与范围复核", async (t) => {
  for (const verdict of ["unproven", "narrowed"]) await t.test(verdict, async (t) => {
    const f = await fixture(t); await assert.rejects(f.run());
    f.state.fidelity = verdict; const count = f.calls.length;
    await assert.rejects(f.run(), (error) => error.diagnostic.reason === "scope_not_preserved");
    assert.deepEqual(f.calls.slice(count).map(({ role }) => role), ["fidelity"]);
    const rejected = await f.designer.get(f.definition.id), originalHash = designHash(rejected);
    assert.equal(rejected.review, null); assert.equal(rejected.mainReviewCheckpoint.fidelityStatus, "not_preserved");
    assert.equal(rejected.mainReviewCheckpoint.modelCalls, 3); assert.equal(rejected.mainReviewCheckpoint.fidelityEvidence.verdict, verdict);
    f.state.fidelity = "pass"; f.state.designSuffix = "\n按真实平台事实补充完整处理和验收说明。"; const fresh = f.calls.length, stageStart = f.stageCalls.length;
    const next = await f.run(), resumed = f.calls.slice(fresh);
    assert.deepEqual(f.stageCalls.slice(stageStart).map(({ role }) => role), ["integration"]);
    const revisionPayload = f.stageCalls[stageStart].payload;
    assert.deepEqual(resumed.map(({ role }) => role), ["reviewer", "fidelity"]);
    assertRevisionBase(revisionPayload, rejected);
    assert.deepEqual(revisionPayload.requirementFidelityFeedback.evidence, rejected.mainReviewCheckpoint.fidelityEvidence);
    assert.equal(revisionPayload.requirementFidelityFeedback.trust, "untrusted-technical-reference");
    assert.equal(next.revisionSource.reviewRepair.modelCalls, 3); assert.equal(next.revisionSource.reviewRepair.candidateHash, rejected.candidateHash);
    assert.notEqual(next.candidateHash, rejected.candidateHash); assert.equal(resumed[0].payload.modelBudget.used, 0);
    assert.equal(next.status, "passed"); assert.equal(next.mainReviewCheckpoint.modelCalls, 2);
    assert.equal(designHash(await f.designer.getVersion(f.definition.id, rejected.version)), originalHash);
  });
});

test("已有有效范围否定的相同候选不能换新评审预算，多次重启仍保留实际spent", async (t) => {
  const f = await fixture(t); f.state.fidelity = "narrowed";
  await assert.rejects(f.run(), (error) => error.diagnostic.reason === "scope_not_preserved");
  const original = await f.designer.get(f.definition.id), spent = original.mainReviewCheckpoint.modelCalls;
  f.state.fidelity = "pass";
  for (let retry = 0; retry < 2; retry++) {
    await f.reload(); const count = f.calls.length, stageStart = f.stageCalls.length;
    await assert.rejects(f.run(), (error) => error.diagnostic.reason === "scope_not_preserved" && error.diagnostic.modelCalls === spent);
    assert.deepEqual(f.calls.slice(count).map(({ role }) => role), [], "相同候选不再进入独立评审");
    assert.deepEqual(f.stageCalls.slice(stageStart).map(({ role }) => role), retry === 0 ? ["integration"] : []);
    const next = await f.designer.get(f.definition.id);
    assert.equal(next.review, null); assert.equal(next.candidateHash, original.candidateHash);
    assert.equal(next.reviewProgressCheckpoint.modelCalls, spent); assert.equal(next.revisionSource.version, original.version);
  }
});

test("否定后的设计修订中断可沿原来源继续，坏来源不能回退到新评审", async (t) => {
  const f = await fixture(t); f.state.fidelity = "unproven";
  await assert.rejects(f.run()); const original = await f.designer.get(f.definition.id);
  f.state.interruptDesigner = true; await assert.rejects(f.run());
  const interrupted = await f.designer.get(f.definition.id);
  assert.equal(interrupted.candidateHash, null); assert.equal(interrupted.revisionSource.version, original.version);
  const tampered = structuredClone(interrupted); tampered.revisionSource.fidelitySource.evidenceHash = "f".repeat(64);
  await f.designer.save(tampered); await f.reload(); const count = f.calls.length;
  await assert.rejects(f.run(), /原始来源或已用额度无效/u); assert.equal(f.calls.length, count);
  const missing = structuredClone(interrupted); missing.revisionSource.version = 9999;
  await f.designer.save(missing); await f.reload();
  await assert.rejects(f.run(), /原始来源不可恢复/u); assert.equal(f.calls.length, count);
  await f.designer.save(interrupted); await f.reload(); f.state.interruptDesigner = false;
  f.state.fidelity = "pass"; f.state.designSuffix = "\n依据真实事实修订技术说明，保留全部用户承诺。";
  const next = await f.run(); assert.equal(next.status, "passed"); assert.notEqual(next.candidateHash, original.candidateHash);
  assert.equal(next.revisionSource.version, original.version);
});

test("范围复核已用两次的原会话不能因重启补充第三次调用", async (t) => {
  const f = await fixture(t); f.state.fidelity = "text";
  await assert.rejects(f.run()); const before = await f.designer.get(f.definition.id);
  assert.equal(before.requirementFidelityProgress.state.calls, 2); assert.equal(before.mainReviewCheckpoint.modelCalls, 3);
  await f.reload(); f.state.fidelity = "pass"; const count = f.calls.length, stageCount = f.stageCalls.length;
  await assert.rejects(f.run(), (error) => error.diagnostic.reason === "scope_evaluation_incomplete");
  assert.equal(f.calls.length, count); assert.equal((await f.designer.get(f.definition.id)).mainReviewCheckpoint.modelCalls, 3);
  assert.equal(f.stageCalls.length, stageCount);
});

test("主预算4与子预算1的真实持久引用重启后只完成原第5次请求", async (t) => {
  const f = await fixture(t); f.state.mainCalls = 3;
  await assert.rejects(f.run()); const saved = await f.designer.get(f.definition.id);
  assert.equal(saved.mainReviewCheckpoint.modelCalls, 4); assert.equal(saved.requirementFidelityProgress.parentModelCalls, 4);
  assert.equal(saved.requirementFidelityProgress.state.calls, 1);
  const file = saved.requirementFidelityProgress.state.sessionFile;
  await f.reload(); f.state.fidelity = "pass"; const count = f.calls.length, stageCount = f.stageCalls.length;
  const result = await f.run();
  assert.deepEqual(f.calls.slice(count).map(({ role }) => role), ["fidelity"]);
  assert.equal(f.stageCalls.length, stageCount);
  assert.equal(result.status, "passed"); assert.equal(result.mainReviewCheckpoint.modelCalls, 5);
  assert.equal(result.requirementFidelityProgress.parentModelCalls, 5); assert.equal(result.requirementFidelityProgress.state.calls, 2);
  assert.equal(result.requirementFidelityProgress.state.sessionFile, file);
  assert.equal(f.calls.at(-1).payload.remainingModelCalls, 1); assert.equal(f.calls.at(-1).payload.requirements, undefined);
});

test("损坏的范围复核引用不能回退为新的主评审或替代会话", async (t) => {
  const f = await fixture(t); await assert.rejects(f.run());
  const source = await f.designer.get(f.definition.id);
  source.requirementFidelityProgress.state.sessionFile = "../outside.jsonl";
  await f.designer.save(source); await f.reload(); const count = f.calls.length, stageCount = f.stageCalls.length;
  await assert.rejects(f.run(), /进度引用无效/u);
  assert.equal(f.calls.length, count);
  assert.equal(f.stageCalls.length, stageCount);
});

test("原第5次复核已有完整原生成功回执时，取消重启只重验结果而不增加请求", async (t) => {
  const f = await fixture(t); f.state.mainCalls = 3;
  await assert.rejects(f.run());
  f.state.fidelity = "pass-cancel"; f.state.controller = new AbortController();
  await assert.rejects(f.run());
  const saved = await f.designer.get(f.definition.id);
  assert.equal(saved.status, "cancelled"); assert.equal(saved.review, null);
  assert.equal(saved.mainReviewCheckpoint.modelCalls, 5); assert.equal(saved.mainReviewCheckpoint.fidelityStatus, "pending");
  assert.equal(saved.requirementFidelityProgress.state.calls, 2);
  await f.reload(); f.state.controller = null; f.state.fidelity = "pass"; const count = f.calls.length, stageCount = f.stageCalls.length;
  const result = await f.run();
  assert.equal(result.status, "passed"); assert.equal(result.mainReviewCheckpoint.modelCalls, 5);
  assert.equal(result.requirementFidelityProgress.state.calls, 2); assert.equal(f.calls.length, count);
  assert.equal(f.stageCalls.length, stageCount);
});
