import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import * as sdk from "@earendil-works/pi-coding-agent";
import { designHash, requirementItems } from "../src/architecture/architecture-contract.mjs";
import { createPlatformSnapshot, platformEvidence } from "../src/architecture/platform-contract.mjs";
import { runtimeCapabilityContract } from "../src/runtime/runtime-capability-contract.mjs";
import { architectureReviewEvidenceContext } from "../src/architecture/architecture-review-evidence.mjs";
import { createMainReviewCheckpoint } from "../src/architecture/architecture-main-review-checkpoint.mjs";
import { createArchitectureFidelityProgress } from "../src/architecture/architecture-fidelity-progress.mjs";
import { diagnoseRequirementFidelitySubmission, verifyRequirementFidelity } from "../src/architecture/requirement-fidelity.mjs";
import { readArchitectureRejectedFidelityReference } from "../src/architecture/architecture-fidelity-rejected-reference.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../src/verification/acceptance-contract.mjs";
import { piSessionManager } from "../src/runtime/pi-session-state.mjs";
import { architectureRecordFidelityContext } from "../src/architecture/architecture-fidelity-context.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";
import { fidelityResult } from "./helpers/fidelity.mjs";

const toolName = "submit_requirement_fidelity";
const blocked = () => ({ role: "assistant", stopReason: "error", errorMessage: "NEUMA_MODEL_CALL_BLOCKED", content: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 4 });

async function fixture(t, contextVersion, { extraRequirements = 0, legacyContract = false, largeContext = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "neuma-fidelity-rejected-")), directory = join(cwd, "sessions");
  t.after(async () => { await chmod(directory, 0o700).catch(() => {}); await rm(cwd, { recursive: true, force: true }); });
  const draft = validDraft(), requirements = [...requirementItems(draft), ...Array.from({ length: extraRequirements }, (_, index) => ({ id: `extra_${index}`, text: `额外要求${index}` }))],
    design = validDesign(requirements, { schemaVersion: 3 });
  if (largeContext) design.decisions[0].alternatives = Array.from({ length: 40 }, () => ({ option: "a".repeat(2000), reason: "b".repeat(2000) }));
  const confirmedRequirementContext = largeContext ? { accepted: "a".repeat(2 * 1024 * 1024 - 80 * 1024) } : null;
  const candidateHash = designHash(design), runtimeCapabilities = runtimeCapabilityContract(), platformSnapshot = createPlatformSnapshot({ allowNetwork: false }),
    platformHash = designHash(platformSnapshot), evidence = [platformEvidence(platformSnapshot)];
  const evidenceContext = architectureReviewEvidenceContext({ design, requirements, runtimeCapabilities, evidence, confirmedRequirementContext, acceptanceAdapterGuide: ACCEPTANCE_ADAPTER_GUIDE });
  const body = { version: 1, candidateHash, platformHash, acceptanceAdapterGuide: evidenceContext.acceptanceAdapterGuide, contextManifest: evidenceContext.contextManifest };
  const snapshot = { ...body, hash: designHash(body) };
  const record = { agentId: "rejected_fidelity", name: "synthetic", version: 3, sourceFingerprint: "source", draft, requirements,
    design, candidateHash, contractVersion: 3, platformContractVersion: platformSnapshot.version, platformSnapshot, platformHash,
    runtimeCapabilities, evidence, confirmedRequirementContext, modules: [], researchGaps: [], issues: [], attempts: [], review: null, status: "failed",
    reviewContext: { candidateHash, platformHash }, reviewEvidence: { version: 2, snapshot, snapshotHash: snapshot.hash } };
  record.mainReviewCheckpoint = createMainReviewCheckpoint(record, passingReview(candidateHash, design), 12);
  const context = architectureRecordFidelityContext(record, evidenceContext, { contextVersion });
  const user = { ...context, contextHash: designHash(context) }, valid = fidelityResult(user, "narrowed"), invalid = structuredClone(valid);
  invalid.restrictions[0].candidatePath = "acceptance[not-a-pointer].expected";
  let legacySchemaHash;
  if (legacyContract) await verifyRequirementFidelity({ context, config: {}, cwd: "/tmp", dataDir: "/tmp", sessionFactory: async (options) => {
    const schema = structuredClone(options.customTools[0].parameters); schema.properties.restrictions.maxItems = 40; legacySchemaHash = designHash(schema);
    return { modelCallAccounting: true, dispose() {}, async prompt() { await options.onModelCall(); await options.customTools[0].execute("capture", valid); } };
  } });
  const feedback = diagnoseRequirementFidelitySubmission(context, invalid, legacySchemaHash ? { schemaHash: legacySchemaHash } : {}), { contextHash, schemaHash, ...receipt } = feedback;
  delete receipt.referenceHints; // Older genuine diagnostics need no new explanatory hints.
  const native = await piSessionManager(sdk, { cwd, storage: { directory, binding: { version: 1, role: "requirement-fidelity", agentId: record.agentId,
    candidateHash, parentBindingHash: record.mainReviewCheckpoint.bindingHash, reviewHash: record.mainReviewCheckpoint.reviewHash, contextHash, schemaHash,
    ...(contextVersion ? { contextVersion } : {}) } } });
  native.manager.appendMessage({ role: "system", content: "Synthetic SDK system context", timestamp: 0 });
  native.manager.appendMessage({ role: "user", content: [{ type: "text", text: JSON.stringify(user) }], timestamp: 1 });
  native.manager.appendMessage({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "rejected_call", name: toolName, arguments: invalid }], timestamp: 2 });
  native.manager.appendMessage({ role: "toolResult", toolName, toolCallId: "rejected_call", isError: true,
    content: [{ type: "text", text: "范围复核提交未通过当前校验：" + JSON.stringify(receipt) }], timestamp: 3 });
  const state = { ...(contextVersion ? { contextVersion } : {}), contextHash, schemaHash, sessionFile: basename(native.manager.getSessionFile()), sessionBindingHash: native.bindingHash, calls: 1,
    diagnostic: { schemaVersion: 1, ...(contextVersion ? { contextVersion } : {}), contextHash, modelCalls: 1, submissionAttempts: 1, schemaRejections: 0, semanticRejections: 1,
      stopReason: "submission_rejected", resultAvailable: false, lastSubmission: receipt } };
  record.requirementFidelityProgress = createArchitectureFidelityProgress(record, state, 12);
  const file = native.manager.getSessionFile();
  const entries = async () => (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const mutate = async (change) => { const values = await entries(); change(values); await writeFile(file, values.map((entry) => JSON.stringify(entry)).join("\n") + "\n"); };
  return { cwd, directory, file, record, evidenceContext, valid, invalid, feedback, native, state, mutate,
    read: (r = record, e = evidenceContext, options = {}) => readArchitectureRejectedFidelityReference(r, e, { cwd, directory, ...options }) };
}

test("预算耗尽的真实被拒参数只读返回为不可信参考，原文、诊断和原生摘要精确绑定", async (t) => {
  const f = await fixture(t), before = await readFile(f.file), recordHash = designHash(f.record), files = await readdir(f.directory);
  await chmod(f.file, 0o400); await chmod(f.directory, 0o500);
  const reference = await f.read(); assert.ok(reference);
  assert.equal(reference.trust, "untrusted-technical-reference"); assert.deepEqual(reference.submission, f.invalid);
  assert.equal(reference.diagnostic.valid, false); assert.equal(reference.diagnostic.stage, "semantic");
  assert.equal(reference.modelCalls, 12); assert.equal(reference.fidelityModelCalls, 1);
  assert.equal(reference.source.toolCallId, "rejected_call"); assert.equal(reference.source.sessionBindingHash, f.native.bindingHash);
  assert.equal(reference.source.bindingHash, f.record.mainReviewCheckpoint.bindingHash);
  assert.equal(reference.source.contextHash, f.state.contextHash); assert.equal(reference.source.schemaHash, f.state.schemaHash);
  assert.match(reference.source.sessionHash, /^[a-f0-9]{64}$/); assert.equal(reference.source.submissionHash, designHash(f.invalid));
  assert.equal(Object.hasOwn(reference, "review"), false); assert.equal(Object.hasOwn(reference, "verdict"), false);
  assert.equal(designHash(f.record), recordHash); assert.deepEqual(await readFile(f.file), before); assert.deepEqual(await readdir(f.directory), files);
  assert.equal((await stat(f.file)).mode & 0o777, 0o400); assert.equal((await stat(f.directory)).mode & 0o777, 0o500);
});

test("后续唯一的本地零用量预算拒绝不抹掉真实拒稿，任意真实后续结果均不能沿用旧稿", async (t) => {
  const f = await fixture(t); f.native.manager.appendMessage(blocked());
  assert.ok(await f.read());
  for (const message of [{ ...blocked(), errorMessage: "some-other-failure" }, { ...blocked(), usage: { ...blocked().usage, output: 1 } },
    { role: "assistant", stopReason: "length", content: [], timestamp: 5 },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "another normal output" }], timestamp: 5 }]) {
    const file = await readFile(f.file); const manager = sdk.SessionManager.open(f.file, f.directory);
    manager.appendMessage(message); assert.equal(await f.read(), null); await writeFile(f.file, file);
  }
});

test("完整版本拒稿沿原版本恢复，不能删除版本字段后冒充旧会话", async (t) => {
  const f = await fixture(t, "full-v2"), reference = await f.read();
  assert.ok(reference); assert.equal(reference.modelCalls, 12);
  const changed = structuredClone(f.record), state = structuredClone(f.state); delete state.contextVersion;
  changed.requirementFidelityProgress = createArchitectureFidelityProgress(changed, state, 12);
  assert.equal(await f.read(changed), null);
});

test("超过40项的旧拒稿沿精确旧契约只读重放，原诊断、文件和预算不改写", async (t) => {
  for (const version of [undefined, "full-v2"]) {
    const f = await fixture(t, version, { extraRequirements: 33, legacyContract: true });
    assert.equal(f.record.requirements.length, 41);
    const before = await readFile(f.file), recordHash = designHash(f.record), reference = await f.read();
    assert.ok(reference); assert.equal(reference.source.schemaHash, f.state.schemaHash);
    assert.equal(reference.diagnostic.schemaHash, f.state.schemaHash);
    assert.equal(reference.fidelityModelCalls, 1); assert.equal(reference.modelCalls, 12);
    assert.equal(reference.diagnostic.stage, "semantic"); assert.equal(reference.diagnostic.valid, false);
    assert.notEqual(diagnoseRequirementFidelitySubmission(architectureRecordFidelityContext(f.record, f.evidenceContext, { contextVersion: version }), null).schemaHash, f.state.schemaHash);
    assert.deepEqual(await readFile(f.file), before); assert.equal(designHash(f.record), recordHash);
  }
});

test("拒稿只读来源合包超过2MiB仍沿独立来源额度核对，原会话不改写", async (t) => {
  const f = await fixture(t, "full-v2", { largeContext: true }), before = await readFile(f.file), recordHash = designHash(f.record);
  assert.ok(Buffer.byteLength(JSON.stringify(f.evidenceContext)) > 2 * 1024 * 1024);
  for (const value of Object.values(f.evidenceContext)) assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 2 * 1024 * 1024);
  assert.ok(await f.read()); assert.deepEqual(await readFile(f.file), before); assert.equal(designHash(f.record), recordHash);
  const oversized = structuredClone(f.evidenceContext); oversized.confirmedRequirementContext.accepted = "a".repeat(2 * 1024 * 1024);
  assert.equal(await f.read(f.record, oversized), null);
});

test("拒稿诊断版本、上下文和已用数必须与真实绑定状态一致", async (t) => {
  for (const contextVersion of [undefined, "full-v2"]) {
    const f = await fixture(t, contextVersion); assert.ok(await f.read());
    for (const change of [value => { value.contextHash = "b".repeat(64); }, value => { value.modelCalls = 2; },
      value => { value.schemaVersion = 2; }, value => { value.contextVersion = "unknown"; }, value => {
        if (contextVersion) delete value.contextVersion; else value.contextVersion = "full-v2";
      }]) {
      const record = structuredClone(f.record), state = structuredClone(f.state); change(state.diagnostic);
      record.requirementFidelityProgress = createArchitectureFidelityProgress(record, state, 12);
      assert.equal(await f.read(record), null);
    }
  }
});

test("错上下文、成功、重复回执、多工具、合法正式判断或失真的诊断均不能变成拒稿参考", async (t) => {
  for (const mutate of [
    (entries) => { const message = entries.find((entry) => entry.message?.role === "user").message; const payload = JSON.parse(message.content[0].text); payload.draft.goal.value += "changed"; message.content[0].text = JSON.stringify(payload); },
    (entries) => { entries.find((entry) => entry.message?.role === "toolResult").message.isError = false; },
    (entries) => { const message = entries.find((entry) => entry.message?.role === "assistant").message; message.content.push(structuredClone(message.content[0])); },
    (entries) => { const message = entries.find((entry) => entry.message?.role === "assistant").message; message.stopReason = "length"; },
    (entries, fixture) => { entries.find((entry) => entry.message?.role === "assistant").message.content[0].arguments = fixture.valid; },
    (entries) => { const message = entries.find((entry) => entry.message?.role === "toolResult").message; message.toolCallId = "another_call"; },
    (entries) => { const message = entries.find((entry) => entry.message?.role === "toolResult").message; message.content[0].text = "unrelated rejection"; },
    (entries) => { const source = entries.find((entry) => entry.message?.role === "toolResult"), last = entries.at(-1); entries.push({ ...structuredClone(source), id: "duplicate_receipt", parentId: last.id }); },
    (entries, fixture) => { const source = entries.find((entry) => entry.message?.role === "user"), original = structuredClone(source), last = entries.at(-1);
      source.message.content[0].text = JSON.stringify({ contextHash: fixture.state.contextHash, correction: "repair" });
      entries.push({ ...original, id: "late_original_context", parentId: last.id }); },
  ]) {
    const f = await fixture(t); await f.mutate((entries) => mutate(entries, f)); assert.equal(await f.read(), null);
  }
});

test("任一冻结材料、schema、原生绑定或耗尽计数改变即停止，缺文件不建立替代历史", async (t) => {
  const f = await fixture(t);
  for (const change of [(record) => { record.version++; }, (record) => { record.draft.task.value += "changed"; },
    (record) => { record.requirements[0].text += "changed"; }, (record) => { record.platformHash = "e".repeat(64); },
    (record) => { record.reviewEvidence.snapshot.acceptanceAdapterGuide.version++; },
    (record) => { record.mainReviewCheckpoint.reviewHash = "e".repeat(64); },
    (record) => { record.requirementFidelityProgress.state.schemaHash = "e".repeat(64); },
    (record) => { record.requirementFidelityProgress.state.sessionBindingHash = "e".repeat(64); },
    (record) => { record.requirementFidelityProgress.parentModelCalls = 4; }]) {
    const record = structuredClone(f.record); change(record); assert.equal(await f.read(record), null);
  }
  const lower = structuredClone(f.record);
  lower.mainReviewCheckpoint = createMainReviewCheckpoint(lower, f.record.mainReviewCheckpoint.review, 4);
  lower.requirementFidelityProgress = createArchitectureFidelityProgress(lower, f.state, 4);
  assert.equal(await f.read(lower), null);
  const changed = structuredClone(f.evidenceContext); changed.contextManifest.requirements.characters++;
  assert.equal(await f.read(f.record, changed), null);
  await rm(f.file); const files = await readdir(f.directory);
  assert.equal(await f.read(), null); assert.deepEqual(await readdir(f.directory), files);
});

test("取消及主动对象不执行getter或写入任何会话", async (t) => {
  const f = await fixture(t), before = await readFile(f.file); let touched = 0;
  const hostile = { ...f.record }; Object.defineProperty(hostile, "draft", { enumerable: true, get() { touched++; throw new Error("no"); } });
  assert.equal(await f.read(hostile), null); assert.equal(touched, 0);
  const context = { ...f.evidenceContext }; Object.defineProperty(context, "contextManifest", { enumerable: true, get() { touched++; throw new Error("no"); } });
  assert.equal(await f.read(f.record, context), null); assert.equal(touched, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.read(f.record, f.evidenceContext, { signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(await readFile(f.file), before);
});
