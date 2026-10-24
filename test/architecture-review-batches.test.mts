import { fixtureText } from "./helpers/m7-test-boundaries.mjs";
import type { ArchitectureReview } from "../src/contracts/architecture.mjs";
import type { ArchitectureRoleOptions, ArchitectureRoleDiagnostic } from "../src/architecture/architecture-controller-port.mjs";
import { fixtureToolAt } from "./helpers/m7-test-boundaries.mjs";
type BatchMaterial = ReturnType<typeof material>;
type PartsReference = ReturnType<ReturnType<typeof import("../src/architecture/architecture-review-parts.mjs").createArchitectureReviewParts>["reference"]>;
type ReviewProgress = Parameters<NonNullable<ArchitectureRoleOptions<ArchitectureReview>["onReviewProgress"]>>[0];
interface BatchPayload { [key: string]: unknown; reviewParts: PartsReference }
interface BatchState { sessions: number; fidelity: number; validates: number; parts: unknown; reference: PartsReference | null; mainReview?: unknown; diagnostic?: ArchitectureRoleDiagnostic; serverError?: unknown; fidelityPayload?: unknown }
interface BatchPrompt { f: BatchMaterial; state: BatchState; payload: BatchPayload; tools: ReturnType<typeof fixtureTools>; session: { messages: SessionMessage[] }; controller: AbortController }
interface BatchOptions { count?: number; initialModelCalls?: number; onPrompt?: (input: BatchPrompt) => unknown | Promise<unknown>; native?: boolean; nativeStop?: string; fidelityAttempts?: number; save?: (value: ReviewProgress, controller: AbortController) => unknown | Promise<unknown>; requireAcceptanceVerification?: boolean; resumeReviewProgress?: (f: BatchMaterial) => NonNullable<ArchitectureRoleOptions<ArchitectureReview>["resumeReviewProgress"]> }
import { recordArray } from "./helpers/m7-test-boundaries.mjs";
import type { FixtureModelRequest } from "./helpers/m7-test-boundaries.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import type { PiSessionOptions } from "../src/runtime/pi-port.mjs";
import type { SessionMessage } from "../src/runtime/pi-port.mjs";
import { fixtureTools } from "./helpers/m7-test-boundaries.mjs";
import { listeningAddress } from "./helpers/m7-test-boundaries.mjs";
import type { TestFailure } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { designHash, reviewSubmissionSchema, validateReview } from "../src/architecture/architecture-contract.mjs";
import { architectureReviewEvidenceContext } from "../src/architecture/architecture-review-evidence.mjs";
import { createPlatformSnapshot, platformEvidence } from "../src/architecture/platform-contract.mjs";
import { renderArchitectureReviewPrompt } from "../src/architecture/architecture-prompts.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";
import { validDesign, passingReview } from "./helpers/architecture.mjs";
import { fidelityResult } from "./helpers/fidelity.mjs";
import type { Server,IncomingMessage,ServerResponse } from "http";
import type { ArchitectureBase } from "../src/contracts/architecture.mjs";

function material(count = 22) {
  const requirements = [{ id: "R1", text: "逐项核对全部记录及边界" }];
  const design = validDesign(requirements, { schemaVersion: 3 });
  design.acceptance = Array.from({ length: count }, (_, index) => ({ ...structuredClone(design.acceptance[index % 4])!,
    id: `criterion_${index}`, requirementIds: ["R1"] }));
  const platformSnapshot = createPlatformSnapshot({ allowNetwork: false });
  const platformContext = { platformSnapshot, platformContractVersion: platformSnapshot.version, platformHash: designHash(platformSnapshot) };
  const candidateHash = designHash(design), context = architectureReviewEvidenceContext({ design, requirements, runtimeCapabilities: {}, evidence: [platformEvidence(platformSnapshot)] });
  const priorFindings = { sameReviewObject: false, findings: [{ findingId: "prior_1", issue: { checkId: "verification" } }] };
  const review = passingReview(candidateHash, design, priorFindings);
  return { design, requirements, candidateHash, context, priorFindings, review, platformContext,
    schema: reviewSubmissionSchema({ evidenceRequired: true, priorFindingsRequired: true }) };
}

const shortScope = (row: Record<string, unknown>) => ({ acceptanceId: row.acceptanceId, adapterRulePath: `/adapters/${row.adapterId}/proves`,
  sufficient: row.sufficient, reason: row.reason });

function rows(f: BatchMaterial, reference: PartsReference) {
  return Object.fromEntries((["checks", "acceptanceScopeChecks", "priorFindingDecisions"] as const).map((key) => {
    const id = { checks: "id", acceptanceScopeChecks: "acceptanceId", priorFindingDecisions: "findingId" }[key];
    return [key, recordArray(objectFields(f.review)[key]).filter((row) => reference.batch![key]!.includes(fixtureText(row[id!])))
      .map((row) => key === "acceptanceScopeChecks" ? shortScope(row) : row)];
  }).filter(([, value]) => value!.length));
}

function latestReference(body: FixtureModelRequest) : PartsReference {
  for (const message of body.messages.slice().reverse()) {
    if (!["user", "tool"].includes(message.role)) continue;
    const content = typeof message.content === "string" ? message.content : recordArray((objectFields(message).content ?? [])).filter((part) => part.type === "text").map((part) => part.text).join("\n");
    for (const line of [content, ...content.split("\n")]) {
      try { const value = JSON.parse(String(line)); if (value.reviewParts) return value.reviewParts; } catch {}
    }
  }
  throw new Error("本地回放缺少宿主当前分项编号");
}

async function fixture(t: test.TestContext, { count = 22, initialModelCalls = 0, onPrompt, native = false, nativeStop, fidelityAttempts = 1, save,
  requireAcceptanceVerification = true, resumeReviewProgress }: BatchOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-review-batch-")), f = material(count), progress: ReviewProgress[] = [], budgets: ((number))[] = [], prompts: BatchPayload[] = [], requests: FixtureModelRequest[] = [];
  const state: BatchState = { sessions: 0, fidelity: 0, validates: 0, parts: null, reference: null }, controller = new AbortController();
  let server: Server | undefined;
  const config: import("../src/contracts/model.mjs").ModelConfig = { llmConfigured: true, model: "offline-batch-fixture", apiKey: "fixture-only" };
  if (native) {
    server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(String(Buffer.concat(chunks))); requests.push(body);
        for (const name of ["save_architecture_review_parts", "submit_architecture_review_parts"]) {
          const schema = body.tools.find((tool: { function: { name: string; }; }) => tool.function.name === name).function.parameters;
          const branches = schema.properties.acceptanceScopeChecks.items.anyOf;
          assert.equal(branches.length, 2, "真实Pi请求的分批工具不能继续派发详细引文格式");
          assert.ok(branches.every((branch: { properties: object; }) => Object.keys(branch.properties).length === 4
            && !Object.hasOwn(branch.properties, "criterionQuote") && !Object.hasOwn(branch.properties, "adapterQuote")));
        }
        const full = body.tools.find((tool: { function: { name: string; }; }) => tool.function.name === "submit_architecture_review").function.parameters;
        assert.ok(full.properties.acceptanceScopeChecks.items.anyOf.some((branch: { properties: { criterionQuote: unknown; }; }) => branch.properties.criterionQuote), "原完整提交保留详细格式");
        const reference = latestReference(body), final = reference.batch!.stage.startsWith("submit");
        assert.ok(["save", "submit-with-parts", "submit"].includes(reference.batch!.stage));
        if (requests.length > 1) assert.ok(JSON.parse(String(await readFile(join(root, "saved-parts.json"), "utf8"))).parts);
        const name = final ? "submit_architecture_review_parts" : "save_architecture_review_parts";
        const args = { candidateHash: f.candidateHash, progressHash: reference.progressHash, ...rows(f, reference),
          ...(final ? { verdict: "pass", summary: "本地协议夹具已逐项核对，非真实业务验收" } : {}) };
        const interrupted = requests.length === 2 && nativeStop, asText = !interrupted && requests.length % 2 === 0;
        const delta = asText ? { content: JSON.stringify({ submission: { name, arguments: args } }) }
          : { tool_calls: [{ index: 0, id: `batch_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ id: "local", choices: [{ index: 0, delta, finish_reason: interrupted || (asText ? "stop" : "tool_calls") }] })}\n\ndata: [DONE]\n\n`);
      } catch (error) { response.writeHead(500); response.end("Local fixture failed"); state.serverError = error; }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    config.chatUrl = `http://127.0.0.1:${listeningAddress(server).port}/v1/chat/completions`;
  }
  const sessionFactory = async (options: PiSessionOptions) => {
    state.sessions++;
    assert.equal(options.reasoningMode, "off");
    if (native) {
      const session = await createPiSession(options); session.setAutoRetryEnabled(false); session.setAutoCompactionEnabled(false); return session;
    }
    const tools = fixtureTools(options.customTools);
    const session = { messages: [] as SessionMessage[], modelCallAccounting: true, subscribe: () => () => {}, async abort() {}, dispose() {},
      async prompt(text: string) { await options.onModelCall!({}); const payload = JSON.parse(String(text)); prompts.push(payload);
        state.reference = payload.reviewParts; return onPrompt!({ f, state, payload, tools, session, controller }); } };
    return session;
  };
  const designer = new ArchitectureDesigner({ config, cwd: root, dataDir: join(root, "data"), sessionFactory,
    fidelitySessionFactory: async (options) => { assert.equal(options.reasoningMode, "off"); const messages: SessionMessage[] = []; return { messages, modelCallAccounting: true, subscribe: () => () => {}, async abort() {}, dispose() {}, setAutoCompactionEnabled() {},
      async prompt(text) {
        await options.onModelCall!({}); state.fidelity++;
        const supplied = JSON.parse(String(text)); if (supplied.requirements) state.fidelityPayload = supplied;
        const payload = state.fidelityPayload;
        if (state.fidelity < fidelityAttempts) { messages.push({ role: "assistant", stopReason: "stop", content: [] }); return; }
        return fixtureToolAt(options.customTools).execute("fidelity", fidelityResult(payload));
      } }; } });
  t.after(async () => { if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    await designer.persistence; await rm(root, { recursive: true, force: true }); });
  await designer.ready;
  const run = () => designer.role({ role: "reviewer", systemPrompt: renderArchitectureReviewPrompt({ batchMode: true }), submitName: "submit_architecture_review", parameters: f.schema,
    payload: { candidateHash: f.candidateHash, design: f.design, requirements: f.requirements, priorFindings: f.priorFindings,
      runtimeCapabilities: {}, acceptanceAdapterGuide: f.context.acceptanceAdapterGuide, ...f.platformContext, requireAcceptanceVerification },
    reviewEvidenceContext: f.context, initialModelCalls, signal: controller.signal, onProgress() {},
    ...(resumeReviewProgress ? { resumeReviewProgress: resumeReviewProgress(f) } : {}),
    validate: (value) => { state.validates++; return validateReview(value, { candidateHash: f.candidateHash, schemaVersion: 3, evidenceContext: f.context }); },
    onMainReviewBudget: (used) => { budgets.push(used); },
    onMainReviewValidated: (review, used) => { state.mainReview = { review, used }; },
    onReviewProgress: async (value) => { progress.push(structuredClone(value)); if (value.parts) {
      await save?.(value, controller); controller.signal.throwIfAborted();
      await writeFile(join(root, "saved-parts.json"), JSON.stringify(value)); state.parts = value.parts;
    } }, onDiagnostics: (diagnostic) => { state.diagnostic = diagnostic; } });
  return { ...f, run, state, progress, budgets, prompts, requests, controller };
}

const textReply = (session: { messages: SessionMessage[] }, value: { submission?: { name: string; arguments: unknown; }; candidateHash?: unknown; progressHash?: unknown; acceptanceScopeChecks?: unknown[]; }) => session.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(value) }] });
function negativeReview(f: BatchMaterial) {
  const review = structuredClone(f.review); objectFields(review).verdict = "revise";
  recordArray(objectFields(review).checks).find((row) => row.id === "verification")!.passed = false;
  objectFields(review).issues = [{ id: "specific", checkId: "verification", kind: "design", blocking: true, description: "本地夹具需补充具体验证",
    remedy: "核对当前指令中的验证安排", candidatePaths: ["/instructions"],
    references: [{ source: "candidate", path: "/instructions", quote: f.design.instructions }], factClaims: [] }];
  return review;
}

test("真实Pi本地循环：多批工具及严格正文保存复用同会话，末批直接正式提交并独立复核", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { native: true });
  const result = await f.run();
  assert.equal(f.state.serverError, undefined); assert.equal(objectFields(result).verdict, "pass");
  assert.equal(f.state.sessions, 1); assert.equal(f.requests.length, 3); assert.equal(f.state.fidelity, 1); assert.equal(f.state.validates, 1);
  assert.equal(objectFields(objectFields(result).acceptanceScopeChecks).length, 22); assert.equal(objectFields(objectFields(result).checks).length, 8); assert.equal(objectFields(objectFields(result).priorFindingDecisions).length, 1);
  const first = { reviewParts: latestReference(f.requests[0]!) };
  assert.equal(first.reviewParts.batch!.stage, "save"); assert.equal(first.reviewParts.batch!.acceptanceScopeChecks.length, 11);
  assert.deepEqual(first.reviewParts.batch!.checks, []);
  assert.equal(f.state.diagnostic!.submissionContinuations, 0); assert.equal(f.state.diagnostic!.modelCalls, 4);
  assert.equal(f.state.diagnostic!.structuredSubmissions, 1);
  assert.ok(f.budgets.every((used, index) => index === 0 || used >= f.budgets![index - 1]!));
});

test("仅余三轮时末批携带真实分项与结论，正式提交和两次范围复核共用原5轮", async (t) => {
  const f = await fixture(t, { initialModelCalls: 2, fidelityAttempts: 2, onPrompt: ({ f, payload, session }) => {
    assert.equal(payload.reviewParts.batch!.stage, "submit-with-parts");
    assert.equal(payload.reviewParts.batch!.remainingModelCalls, 3);
    textReply(session, { submission: { name: "submit_architecture_review_parts", arguments: { candidateHash: f.candidateHash,
      progressHash: payload.reviewParts.progressHash, ...rows(f, payload.reviewParts), verdict: "pass", summary: "完整本地夹具" } } });
  } });
  assert.equal(objectFields((await f.run())).verdict, "pass"); assert.equal(f.state.fidelity, 2);
  assert.equal(f.prompts.length, 1); assert.equal(f.state.diagnostic!.modelCalls, 5); assert.equal(f.budgets.at(-1), 5);
});

test("预留只限制新分批，余下一两轮仍能走原完整正式负评通道", async (t) => {
  for (const used of [3, 4]) await t.test(String(used), async (t) => {
    const f = await fixture(t, { initialModelCalls: used, onPrompt: async ({ f, payload, tools }) => {
      assert.equal(payload.reviewParts.batch!.stage, "final-only");
      await assert.rejects(tools.save_architecture_review_parts!.execute("partial", { candidateHash: f.candidateHash,
        progressHash: payload.reviewParts.progressHash, ...rows(f, payload.reviewParts) }), /完整正式提交/u);
      return tools.submit_architecture_review!.execute("full", negativeReview(f));
    } });
    assert.equal(objectFields((await f.run())).verdict, "revise");
    assert.equal(f.state.sessions, 1); assert.equal(f.state.fidelity, 0); assert.equal(f.state.diagnostic!.modelCalls, used + 1);
    assert.equal(f.state.parts, null);
  });
  const full = await fixture(t, { initialModelCalls: 5, onPrompt: () => { throw new Error("must not request"); } });
  await assert.rejects(full.run(), (error: TestFailure) => error.diagnostic!.reason === "turn_limit" && error.diagnostic!.modelCalls === 5);
  assert.equal(full.state.sessions, 0);
});

test("最后两轮仍可用末批正式提交加一次真实复核，只有实际耗尽才停止", async (t) => {
  for (const used of [3, 4]) await t.test(String(used), async (t) => {
    const f = await fixture(t, { initialModelCalls: used, onPrompt: ({ f, payload, tools }) =>
      tools.submit_architecture_review_parts!.execute("final", { candidateHash: f.candidateHash, progressHash: payload.reviewParts.progressHash,
        ...rows(f, payload.reviewParts), verdict: "pass", summary: "完整本地夹具" }) });
    if (used === 3) assert.equal(objectFields((await f.run())).verdict, "pass");
    else await assert.rejects(f.run(), (error: TestFailure) => error.diagnostic!.reason === "turn_limit");
    assert.equal(objectFields(f.state.mainReview).used, used + 1); assert.equal(f.state.diagnostic!.modelCalls, 5);
    assert.equal(f.state.fidelity, used === 3 ? 1 : 0);
  });
});

test("旧v3无需范围复核及已保存完整revise草稿不改成新批次门槛", async (t) => {
  for (const mode of ["legacy", "complete-draft"]) await t.test(mode, async (t) => {
    const f = await fixture(t, { initialModelCalls: 4, requireAcceptanceVerification: mode !== "legacy",
      ...(mode === "complete-draft" ? { resumeReviewProgress: (f) => ({ modelCalls: 4, review: negativeReview(f), origin: "semantic-rejected" }) } : {}),
      onPrompt: ({ f, payload, tools }) => { assert.equal(payload.reviewParts.batch, undefined);
        return tools.submit_architecture_review!.execute("legacy", negativeReview(f)); } });
    assert.equal(objectFields((await f.run())).verdict, "revise"); assert.equal(f.state.diagnostic!.modelCalls, 5); assert.equal(f.state.fidelity, 0);
  });
});

test("正文保存必须有实质进展；相同分项不无限续批，普通一次提醒保持", async (t) => {
  let row;
  const f = await fixture(t, { onPrompt: ({ f, payload, session }) => {
    row ??= shortScope(objectFields(f.review.acceptanceScopeChecks![0]));
    textReply(session, { candidateHash: f.candidateHash, progressHash: payload.reviewParts.progressHash, acceptanceScopeChecks: [row] });
  } });
  await assert.rejects(f.run(), (error: TestFailure) => error.diagnostic!.reason === "submission_incomplete");
  assert.equal(f.prompts.length, 3); assert.equal(f.state.diagnostic!.submissionContinuations, 1); assert.equal(f.state.fidelity, 0);
  assert.equal(f.progress.filter((entry) => entry.parts).length, 1);
});

test("末批完整语义不自洽时保留被拒草稿，不覆盖已接受分项或进入范围复核", async (t) => {
  const f = await fixture(t, { initialModelCalls: 2, onPrompt: ({ f, payload, session }) => {
    const parts = rows(f, payload.reviewParts); parts.checks[0].passed = false;
    textReply(session, { candidateHash: f.candidateHash, progressHash: payload.reviewParts.progressHash, ...parts,
      verdict: "pass", summary: "错误的自洽结论应拒绝" });
  } });
  await assert.rejects(f.run());
  assert.equal(f.state.fidelity, 0); assert.equal(objectFields(objectFields(f.state!.parts!).checks).length, 0);
  assert.equal(objectFields(objectFields(objectFields(f.progress!.findLast(entry => entry.rejectedParts)!.rejectedParts).checks)[0]).passed, false);
  assert.equal(f.state.diagnostic!.lastSubmissionIssue!.reason, "missing_check_issue");
  assert.equal(f.state.validates, 0);
});

test("正文保存落盘失败或保存中取消，不派发下一批也不产生通过", async (t) => {
  for (const mode of ["storage", "cancel"]) await t.test(mode, async (t) => {
    const f = await fixture(t, { save: (_value, controller) => { if (mode === "cancel") controller.abort(); else throw new Error("local save failed"); },
      onPrompt: ({ f, payload, session }) => textReply(session, { candidateHash: f.candidateHash,
        progressHash: payload.reviewParts.progressHash, ...rows(f, payload.reviewParts) }) });
    await assert.rejects(f.run()); assert.equal(f.prompts.length, 1); assert.equal(f.state.parts, null); assert.equal(f.state.fidelity, 0);
  });
});

test("真实Pi截断或错误响应即使含完整tool参数也不能新增分项，已保存旧批保留", { timeout: 10000 }, async (t) => {
  for (const nativeStop of ["length", "content_filter"]) await t.test(nativeStop, async (t) => {
    const f = await fixture(t, { native: true, nativeStop });
    await assert.rejects(f.run());
    assert.equal(f.state.serverError, undefined); assert.equal(f.requests.length, 2);
    assert.equal(objectFields(objectFields(f.state!.parts!).acceptanceScopeChecks).length, 11); assert.equal(objectFields(objectFields(f.state!.parts!).checks).length, 0);
    assert.equal(f.state.fidelity, 0); assert.equal(f.state.validates, 0);
    assert.equal(f.progress.filter((entry) => entry.parts).length, 1);
  });
});
