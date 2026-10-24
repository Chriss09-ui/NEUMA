import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { diagnoseRequirementFidelitySubmission, verifyRequirementFidelity } from "../src/architecture/requirement-fidelity.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";
import { piSessionManager } from "../src/runtime/pi-session-state.mjs";
import { designHash } from "../src/architecture/architecture-contract.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../src/verification/acceptance-contract.mjs";
import { fidelityResult } from "./helpers/fidelity.mjs";

function context() {
  return { requirements: [{ id: "input", text: "允许任意字符，沿用已确认长度限制。" },
    { id: "delivery", text: "完整输出全部记录，不抽样。" }], draft: { accepted: "任意字符，完整处理" },
    confirmedRequirementContext: { quote: "不增加字符白名单" },
    candidate: { instructions: "仅接收ASCII字母；其他字符拒绝。" }, runtimeCapabilities: { version: 1 } };
}

const textOf = (content) => typeof content === "string" ? content
  : (content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
const latestUser = (body) => JSON.parse(textOf(body.messages.findLast((message) => message.role === "user").content));
const incomplete = (error) => error.reason === "scope_evaluation_incomplete";
const nativeEntries = async (file) => (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
const successReceipt = (entry) => entry.type === "message" && entry.message.role === "toolResult"
  && entry.message.toolName === "submit_requirement_fidelity" && entry.message.isError === false
  && textOf(entry.message.content) === '{"submitted":true}';
const formalResult = ({ fidelityDiagnostic: _diagnostic, ...result }) => result;

async function fixture(t, respond, currentContext = context()) {
  const root = await mkdtemp(join(tmpdir(), "neuma-fidelity-recovery-")), requests = [], factories = [];
  const storage = { directory: join(root, "sessions"), binding: { role: "fidelity", task: "synthetic-recovery" } };
  let serverFailure;
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
      const next = await respond(body, requests.length);
      const delta = next.value ? { role: "assistant", tool_calls: [{ index: 0, id: `fidelity_recovery_${requests.length}`,
        type: "function", function: { name: "submit_requirement_fidelity", arguments: JSON.stringify(next.value) } }] }
        : { role: "assistant", content: next.text ?? "尚未正式提交。" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "fidelity_recovery", choices: [{ index: 0, delta,
        finish_reason: next.finishReason ?? (next.value ? "tool_calls" : "stop") }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      serverFailure = error;
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":{"message":"synthetic fixture failed"}}');
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true }); assert.equal(serverFailure, undefined);
  });
  const config = { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only",
    chatUrl: `http://127.0.0.1:${server.address().port}/v1/chat/completions` };
  const run = ({ afterPrompt, ...options } = {}) => verifyRequirementFidelity({ context: currentContext, config, cwd: root, dataDir: root,
    sessionStorage: storage, ...options, sessionFactory: async (settings) => {
      const session = await createPiSession(settings);
      session.setAutoRetryEnabled(false); session.setAutoCompactionEnabled(false);
      factories.push({ file: session.sessionFile, bindingHash: session.sessionBindingHash,
        messages: structuredClone(session.messages), storage: structuredClone(settings.sessionStorage) });
      if (afterPrompt) {
        const prompt = session.prompt.bind(session);
        session.prompt = async (...args) => { const result = await prompt(...args); await afterPrompt(session); return result; };
      }
      return session;
    } });
  return { root, storage, requests, factories, run,
    files: async () => (await readdir(storage.directory)).filter((name) => name.endsWith(".jsonl")).sort() };
}

async function interruptAfterRejection(f, { charge } = {}) {
  const controller = new AbortController(), saved = [], reason = new Error("synthetic-cancel-after-rejection");
  await assert.rejects(f.run({ signal: controller.signal, charge, onProgress: async (state) => {
    saved.push(structuredClone(state));
    assert.equal((await stat(join(f.storage.directory, state.sessionFile))).mode & 0o777, 0o600);
    if (state.diagnostic.lastSubmission && !controller.signal.aborted) controller.abort(reason);
  } }), (error) => error === reason);
  const progress = saved.at(-1);
  assert.equal(f.requests.length, 1); assert.equal(progress.calls, 1); assert.equal(progress.diagnostic.stopReason, "cancelled");
  assert.equal(progress.diagnostic.semanticRejections, 1); assert.equal(progress.diagnostic.submissionAttempts, 1);
  assert.equal(progress.diagnostic.lastSubmission.stage, "semantic");
  assert.equal(progress.diagnostic.lastSubmission.issues[0].reason, "reference_quote_mismatch");
  assert.doesNotMatch(JSON.stringify(progress.diagnostic), /UNMATCHED_FIXTURE_QUOTE/u);
  return { progress, saved };
}

test("native fidelity recovery keeps the rejected tool history and exact feedback, using only its original second call", { timeout: 15000 }, async (t) => {
  let valid, rejectedFeedback, charges = 0;
  const f = await fixture(t, (body, turn) => {
    const payload = latestUser(body);
    assert.deepEqual(body.tools.map((item) => item.function.name), ["submit_requirement_fidelity", "read_model_context"]);
    if (turn === 1) {
      valid = fidelityResult(payload, "narrowed");
      const invalid = structuredClone(valid); invalid.restrictions[0].quote = "UNMATCHED_FIXTURE_QUOTE";
      return { value: invalid };
    }
    assert.equal(turn, 2);
    assert.deepEqual(Object.keys(payload).sort(), ["contextHash", "correction", "lastSubmission", "remainingModelCalls"]);
    assert.equal(payload.contextHash, valid.contextHash); assert.equal(payload.remainingModelCalls, 1);
    assert.deepEqual(payload.lastSubmission, rejectedFeedback);
    const previousCall = body.messages.find((message) => message.role === "assistant"
      && message.tool_calls?.some((call) => call.id === "fidelity_recovery_1"));
    assert.ok(previousCall, "the original rejected tool call remains in native history");
    assert.equal(JSON.parse(previousCall.tool_calls[0].function.arguments).restrictions[0].quote, "UNMATCHED_FIXTURE_QUOTE");
    const previousError = body.messages.find((message) => message.role === "tool" && message.tool_call_id === "fidelity_recovery_1");
    assert.ok(previousError); assert.match(textOf(previousError.content), /reference_quote_mismatch/u);
    assert.doesNotMatch(textOf(previousError.content), /UNMATCHED_FIXTURE_QUOTE/u);
    const original = body.messages.find((message) => message.role === "user" && textOf(message.content).includes('"requirements"'));
    assert.deepEqual(JSON.parse(textOf(original.content)).requirements, context().requirements);
    return { value: valid };
  });
  const { progress, saved } = await interruptAfterRejection(f, { charge: () => { charges++; } });
  assert.equal(saved[0].calls, 0); assert.equal(saved[0].diagnostic.submissionAttempts, 0);
  rejectedFeedback = structuredClone(progress.diagnostic.lastSubmission);
  const resumedStates = [];
  const result = await f.run({ progress, charge: () => { charges++; }, onProgress: async (state) => {
    resumedStates.push(structuredClone(state));
    if (state.calls === 2 && state.diagnostic.stopReason !== "submitted")
      assert.equal(f.requests.length, 1, "the remaining call is persisted before its HTTP request");
  } });
  assert.equal(result.verdict, "narrowed"); assert.equal(result.modelCalls, 2); assert.equal(charges, 2);
  assert.equal(result.fidelityDiagnostic.submissionAttempts, 2); assert.equal(result.fidelityDiagnostic.semanticRejections, 1);
  assert.deepEqual(result.restrictions, valid.restrictions);
  assert.equal(f.requests.length, 2); assert.equal(f.factories.length, 2);
  assert.equal(f.factories[1].file, f.factories[0].file); assert.equal(f.factories[1].bindingHash, progress.sessionBindingHash);
  assert.ok(f.factories[1].messages.some((message) => message.role === "user" && textOf(message.content).includes(progress.contextHash)));
  assert.equal(resumedStates[0].calls, 1); assert.equal(resumedStates.at(-1).calls, 2);
  assert.equal(resumedStates.at(-1).sessionFile, progress.sessionFile); assert.equal(resumedStates.at(-1).diagnostic.stopReason, "submitted");
  const recovered = await f.run({ progress: resumedStates.at(-1), charge: () => assert.fail("receipt recovery must not charge a new call") });
  assert.deepEqual(formalResult(recovered), formalResult(result));
  assert.equal(f.requests.length, 2, "a completed two-call reference revalidates its actual receipt without a third request");
  assert.equal((await f.files()).length, 1);
});

test("旧大需求原生会话保留精确40条契约、原文件及剩余一次预算，不自动升级或另开会话", { timeout: 15000 }, async (t) => {
  const current = { ...context(), fidelityContextVersion: "full-v2", requirements: Array.from({ length: 41 }, (_, index) => ({ id: `r_${index}`, text: `原要求${index}` })) };
  let schema, valid;
  await verifyRequirementFidelity({ context: current, config: {}, cwd: "/tmp", dataDir: "/tmp", sessionFactory: async (options) => {
    schema = structuredClone(options.customTools[0].parameters);
    return { modelCallAccounting: true, dispose() {}, async prompt(text) { await options.onModelCall();
      valid = fidelityResult(JSON.parse(text), "narrowed"); await options.customTools[0].execute("capture", valid); } };
  } });
  const currentHash = designHash(schema);
  schema.properties.restrictions.maxItems = 40;
  const schemaHash = designHash(schema), contextHash = valid.contextHash;
  assert.notEqual(schemaHash, currentHash);
  const original = { ...current, acceptanceAdapterGuide: ACCEPTANCE_ADAPTER_GUIDE, acceptanceAdapterGuideSource: "current-default", contextHash };
  const invalid = structuredClone(valid); invalid.restrictions[0].candidatePath = "not-a-pointer";
  const { contextHash: _context, schemaHash: _schema, ...feedback } = diagnoseRequirementFidelitySubmission(current, invalid, { schemaHash });
  const f = await fixture(t, (body) => {
    assert.equal(body.tools[0].function.parameters.properties.restrictions.maxItems, 40);
    assert.equal(latestUser(body).remainingModelCalls, 1);
    assert.match(textOf(body.messages.find((message) => message.role === "tool").content), /candidate_path_missing/);
    return { value: valid };
  }, current);
  const sdk = await import("@earendil-works/pi-coding-agent"), native = await piSessionManager(sdk, { cwd: f.root,
    storage: { ...f.storage, binding: { ...f.storage.binding, contextHash, schemaHash, contextVersion: "full-v2" } } });
  native.manager.appendMessage({ role: "user", content: [{ type: "text", text: JSON.stringify(original) }], timestamp: 1 });
  native.manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "neuma", model: "fixture-model", stopReason: "toolUse",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [{ type: "toolCall", id: "legacy_scope", name: "submit_requirement_fidelity", arguments: invalid }], timestamp: 2 });
  native.manager.appendMessage({ role: "toolResult", toolCallId: "legacy_scope", toolName: "submit_requirement_fidelity", isError: true,
    content: [{ type: "text", text: JSON.stringify({ submitted: false, ...feedback }) }], timestamp: 3 });
  const sessionFile = native.manager.getSessionFile().split("/").at(-1), progress = { contextVersion: "full-v2", contextHash, schemaHash,
    sessionFile, sessionBindingHash: native.bindingHash, calls: 1, diagnostic: { schemaVersion: 1, contextVersion: "full-v2", contextHash,
      modelCalls: 1, submissionAttempts: 1, schemaRejections: 0, semanticRejections: 1, stopReason: "submission_rejected", resultAvailable: false, lastSubmission: feedback } };
  const states = []; let charges = 0;
  const result = await f.run({ progress, charge: () => { charges++; }, onProgress: async (state) => { states.push(structuredClone(state)); } });
  assert.equal(result.verdict, "narrowed"); assert.equal(result.modelCalls, 2); assert.equal(charges, 1);
  assert.equal(f.requests.length, 1); assert.equal(f.factories[0].bindingHash, native.bindingHash);
  assert.equal(f.factories[0].storage.file, sessionFile); assert.deepEqual(await f.files(), [sessionFile]);
  assert.equal(states.at(-1).schemaHash, schemaHash); assert.equal(states.at(-1).calls, 2);
  const recovered = await f.run({ progress: states.at(-1), charge: () => assert.fail("旧完整回执不得新增请求") });
  assert.equal(recovered.modelCalls, 2); assert.equal(f.requests.length, 1); assert.deepEqual(await f.files(), [sessionFile]);
});

test("a durable success receipt survives cancellation and another cancellation during initial resume persistence", { timeout: 15000 }, async (t) => {
  let valid;
  const f = await fixture(t, (body, turn) => {
    if (turn === 1) {
      valid = fidelityResult(latestUser(body), "narrowed");
      const invalid = structuredClone(valid); invalid.restrictions[0].quote = "UNMATCHED_FIXTURE_QUOTE";
      return { value: invalid };
    }
    assert.equal(turn, 2); return { value: valid };
  });
  const { progress } = await interruptAfterRejection(f), controller = new AbortController(), states = [];
  const reason = new Error("synthetic-after-durable-success-receipt");
  await assert.rejects(f.run({ progress, signal: controller.signal, onProgress: async (state) => { states.push(structuredClone(state)); },
    afterPrompt: async (session) => {
      assert.equal((await nativeEntries(session.sessionFile)).filter(successReceipt).length, 1);
      controller.abort(reason);
    } }), (error) => error === reason);
  const completed = states.at(-1);
  assert.equal(completed.calls, 2); assert.equal(completed.diagnostic.stopReason, "cancelled");
  assert.equal(completed.diagnostic.resultAvailable, true); assert.equal(f.requests.length, 2);
  const resumeController = new AbortController(), resumeReason = new Error("synthetic-resume-reference-cancel"), resumeStates = [];
  const factoryCount = f.factories.length;
  await assert.rejects(f.run({ progress: completed, signal: resumeController.signal, onProgress: async (state) => {
    resumeStates.push(structuredClone(state));
    assert.equal(state.calls, 2); assert.equal(state.diagnostic.resultAvailable, true);
    if (!resumeController.signal.aborted) {
      assert.equal(f.factories.length, factoryCount, "initial progress is saved before opening the restored native role");
      resumeController.abort(resumeReason);
    }
  } }), (error) => error === resumeReason);
  assert.equal(resumeStates.at(-1).diagnostic.resultAvailable, true);
  const recovered = await f.run({ progress: resumeStates.at(-1), charge: () => assert.fail("a persisted receipt uses no model budget") });
  assert.deepEqual(formalResult(recovered), { ...valid, modelCalls: 2 });
  assert.equal(recovered.fidelityDiagnostic.resultAvailable, true); assert.equal(f.requests.length, 2);
  assert.equal(f.factories.at(-1).storage.file, progress.sessionFile); assert.equal((await f.files()).length, 1);
});

test("missing, error, truncated or duplicated native receipts cannot authorize exhausted-call result recovery", { timeout: 15000 }, async (t) => {
  let valid;
  const f = await fixture(t, (body, turn) => {
    if (turn === 1) {
      valid = fidelityResult(latestUser(body), "narrowed");
      const invalid = structuredClone(valid); invalid.restrictions[0].quote = "UNMATCHED_FIXTURE_QUOTE";
      return { value: invalid };
    }
    assert.equal(turn, 2); return { value: valid };
  });
  const { progress } = await interruptAfterRejection(f), states = [];
  await f.run({ progress, onProgress: async (state) => { states.push(structuredClone(state)); } });
  const completed = states.at(-1), file = join(f.storage.directory, completed.sessionFile), original = await nativeEntries(file);
  assert.equal(completed.calls, 2); assert.equal(completed.diagnostic.resultAvailable, true);
  assert.equal(original.filter(successReceipt).length, 1);
  for (const [label, mutate] of [
    ["missing receipt", (entries) => entries.filter((entry) => !successReceipt(entry))],
    ["error receipt", (entries) => { entries.find(successReceipt).message.isError = true; return entries; }],
    ["truncated assistant", (entries) => {
      const id = entries.find(successReceipt).message.toolCallId;
      entries.find((entry) => entry.type === "message" && entry.message.role === "assistant"
        && entry.message.content.some((item) => item.type === "toolCall" && item.id === id)).message.stopReason = "length";
      return entries;
    }],
    ["duplicate receipt", (entries) => {
      entries.push({ ...structuredClone(entries.find(successReceipt)), id: "f1de1100", parentId: entries.at(-1).id });
      return entries;
    }],
  ]) {
    const changed = mutate(structuredClone(original));
    await writeFile(file, changed.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const rejected = [];
    await assert.rejects(f.run({ progress: completed, onProgress: async (state) => { rejected.push(structuredClone(state)); },
      charge: () => assert.fail("an exhausted reference cannot request replacement evidence") }), incomplete, label);
    assert.equal(f.requests.length, 2, label); assert.equal(rejected.at(-1).calls, 2, label);
    assert.equal(rejected.at(-1).diagnostic.resultAvailable, false, label);
    assert.deepEqual(await f.files(), [completed.sessionFile], label);
  }
});

test("cancelling the initial saved zero-call reference sends no request and can resume the same reserved file", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, (body) => ({ value: fidelityResult(latestUser(body), "narrowed") }));
  const controller = new AbortController(), reason = new Error("synthetic-before-first-request"), saved = [];
  let charged = 0;
  await assert.rejects(f.run({ signal: controller.signal, charge: () => { charged++; }, onProgress: async (state) => {
    saved.push(structuredClone(state));
    if (!controller.signal.aborted) {
      assert.equal(f.factories.length, 0, "the reserved reference is saved before constructing the native session");
      assert.equal(f.requests.length, 0); assert.equal(state.calls, 0);
      assert.match(await readFile(join(f.storage.directory, state.sessionFile), "utf8"), /neuma.session-binding.v1/u);
      controller.abort(reason);
    }
  } }), (error) => error === reason);
  assert.equal(charged, 0); assert.equal(f.requests.length, 0);
  const progress = saved.at(-1); assert.equal(progress.calls, 0); assert.equal(progress.diagnostic.stopReason, "cancelled");
  const result = await f.run({ progress, charge: () => { charged++; } });
  assert.equal(result.modelCalls, 1); assert.equal(charged, 1); assert.equal(f.requests.length, 1);
  assert.deepEqual(latestUser(f.requests[0]).requirements, context().requirements);
  assert.equal(f.factories.at(-1).storage.file, progress.sessionFile); assert.equal((await f.files()).length, 1);
});

test("a truncated native response persists its spent call and cannot become a formal fidelity result", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, (body) => ({ text: JSON.stringify(fidelityResult(latestUser(body), "narrowed")), finishReason: "length" }));
  const states = [];
  await assert.rejects(f.run({ onProgress: async (state) => { states.push(structuredClone(state)); } }), (error) => incomplete(error)
    && error.modelCalls === 1 && error.fidelityDiagnostic.stopReason === "output_limit");
  assert.equal(f.requests.length, 1); assert.equal(states.at(-1).calls, 1);
  assert.equal(states.at(-1).diagnostic.stopReason, "output_limit"); assert.equal(states.at(-1).diagnostic.submissionAttempts, 0);
});

test("changed context, schema, native binding or absent filename rejects before creating a replacement session", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, (body) => {
    const invalid = fidelityResult(latestUser(body), "narrowed"); invalid.restrictions[0].quote = "UNMATCHED_FIXTURE_QUOTE";
    return { value: invalid };
  });
  const { progress } = await interruptAfterRejection(f), files = await f.files(), factoryCount = f.factories.length;
  const changedCandidate = context(); changedCandidate.candidate.instructions += " changed";
  const changedRequirements = context(); changedRequirements.requirements[0].text += " changed";
  const missingFilename = structuredClone(progress); delete missingFilename.sessionFile;
  for (const [label, options] of [
    ["candidate", { context: changedCandidate }], ["requirements", { context: changedRequirements }],
    ["context hash", { progress: { ...progress, contextHash: "a".repeat(64) } }],
    ["schema hash", { progress: { ...progress, schemaHash: "a".repeat(64) } }],
    ["binding hash", { progress: { ...progress, sessionBindingHash: "a".repeat(64) } }],
    ["host binding", { sessionStorage: { ...f.storage, binding: { ...f.storage.binding, task: "another-task" } } }],
    ["missing filename", { progress: missingFilename }],
  ]) {
    await assert.rejects(f.run({ progress, ...options }), incomplete, label);
    assert.equal(f.requests.length, 1, label); assert.equal(f.factories.length, factoryCount, label);
    assert.deepEqual(await f.files(), files, label);
  }
});

test("deleting the referenced native file cannot create a substitute or another HTTP request", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, (body) => {
    const invalid = fidelityResult(latestUser(body), "narrowed"); invalid.restrictions[0].quote = "UNMATCHED_FIXTURE_QUOTE";
    return { value: invalid };
  });
  const { progress } = await interruptAfterRejection(f), factoryCount = f.factories.length;
  await rm(join(f.storage.directory, progress.sessionFile));
  await assert.rejects(f.run({ progress }), incomplete);
  assert.equal(f.requests.length, 1); assert.equal(f.factories.length, factoryCount); assert.deepEqual(await f.files(), []);
});

test("a referenced native file without the exact original context cannot rebootstrap its full evidence", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, (body) => {
    const invalid = fidelityResult(latestUser(body), "narrowed"); invalid.restrictions[0].quote = "UNMATCHED_FIXTURE_QUOTE";
    return { value: invalid };
  });
  const { progress } = await interruptAfterRejection(f), file = join(f.storage.directory, progress.sessionFile);
  const setupOnly = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    .filter((entry) => entry.type !== "message");
  await writeFile(file, setupOnly.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await assert.rejects(f.run({ progress }), incomplete);
  assert.equal(f.requests.length, 1); assert.equal(f.factories.at(-1).messages.length, 0);
  assert.deepEqual(await f.files(), [progress.sessionFile]);
});

test("full-v2实际wire使用ID selector，原生成功回执恢复canonical证据且零新增请求", { timeout: 15000 }, async (t) => {
  const current = { ...context(), fidelityContextVersion: "full-v2",
    deferredVerifications: { issues: [{ stage: "development", stageDecision: { reason: "固定测试合法后续验收" } }] } };
  const f = await fixture(t, (body) => {
    const message = latestUser(body), schema = body.tools[0].function.parameters;
    assert.equal(message.fidelityContextVersion, "full-v2");
    assert.deepEqual(message.deferredObligations, current.deferredVerifications.issues);
    assert.equal(message.deferredVerifications, undefined);
    assert.ok(message.contextIndex.some(item => item.section === "deferredVerifications" && item.delivery === "paged"));
    assert.ok(schema.properties.restrictions.items.anyOf.some((item) => item.properties?.claimRef));
    const system = body.messages.filter((item) => item.role === "system").map((item) => textOf(item.content)).join("\n");
    assert.match(system, /原本合法输入被候选排除/u); assert.match(system, /合法延期至development/u);
    const value = fidelityResult(message, "narrowed");
    assert.deepEqual(Object.keys(value.restrictions[0]).sort(), ["candidatePath", "claimRef", "reason"]);
    assert.deepEqual(value.restrictions[0].claimRef, { source: "requirements", requirementId: message.requirements[0].id });
    return { value };
  });
  const controller = new AbortController(), reason = new Error("cancel-after-v2-receipt"), saved = [];
  await assert.rejects(f.run({ context: current, signal: controller.signal,
    onProgress: (state) => { saved.push(structuredClone(state)); }, afterPrompt: () => controller.abort(reason) }), (error) => error === reason);
  const progress = saved.at(-1);
  assert.equal(progress.contextVersion, "full-v2"); assert.equal(progress.diagnostic.contextVersion, "full-v2");
  assert.equal(progress.calls, 1); assert.equal(progress.diagnostic.resultAvailable, true);
  assert.equal(f.factories[0].storage.binding.contextVersion, "full-v2"); assert.equal(f.requests.length, 1);
  const result = await f.run({ context: current, progress, sessionStorage: { ...f.storage, file: progress.sessionFile },
    charge() { assert.fail("成功回执恢复不得新增请求"); } });
  assert.equal(result.contextVersion, "full-v2"); assert.equal(result.modelCalls, 1); assert.equal(result.verdict, "narrowed");
  assert.equal(result.restrictions[0].quote, current.requirements[0].text);
  assert.equal(result.restrictions[0].path, "/0/text"); assert.ok(!Object.hasOwn(result.restrictions[0], "claimRef"));
  assert.equal(f.requests.length, 1); assert.equal(f.factories[1].file, f.factories[0].file);
});

test("full-v2两次非法selector保留原生失败和已用数，恢复不创建第三个请求", { timeout: 15000 }, async (t) => {
  const current = { ...context(), fidelityContextVersion: "full-v2" }, saved = [];
  const f = await fixture(t, (body) => {
    const original = body.messages.filter((message) => message.role === "user").map((message) => {
      try { return JSON.parse(textOf(message.content)); } catch { return null; }
    }).find((message) => message?.requirements);
    const value = fidelityResult(original, "narrowed"); value.restrictions[0].claimRef.requirementId = "PRIVATE_UNKNOWN_SELECTOR";
    return { value };
  });
  await assert.rejects(f.run({ context: current, onProgress: (state) => saved.push(structuredClone(state)) }),
    (error) => error.reason === "scope_evaluation_incomplete" && error.modelCalls === 2);
  const progress = saved.at(-1);
  assert.equal(progress.contextVersion, "full-v2"); assert.equal(progress.calls, 2);
  assert.equal(progress.diagnostic.schemaRejections, 2); assert.equal(progress.diagnostic.resultAvailable, false);
  assert.doesNotMatch(JSON.stringify(progress.diagnostic), /PRIVATE_/u); assert.equal(f.requests.length, 2);
  await assert.rejects(f.run({ context: current, progress, sessionStorage: { ...f.storage, file: progress.sessionFile },
    charge() { assert.fail("耗尽的同源selector不能新增请求"); } }),
  (error) => error.reason === "scope_evaluation_incomplete" && error.modelCalls === 2);
  assert.equal(f.requests.length, 2); assert.equal(f.factories[1].file, f.factories[0].file);
});
