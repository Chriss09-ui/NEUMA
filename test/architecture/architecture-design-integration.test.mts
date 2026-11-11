import type { CandidateDraft } from "../../src/contracts/architecture-stages.mjs";
import { fixtureChatRequest, fixtureString } from "../helpers/http-model.mjs";
import type { FixtureChatRequest, FixtureChatMessage } from "../helpers/http-model.mjs";
import { recordArray } from "../helpers/m7-test-boundaries.mjs";
import type { FixtureModelRequest } from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { listeningAddress } from "../helpers/m7-test-boundaries.mjs";
import type { TestFailure } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../../src/architecture/architecture.mjs";
import { PrototypeAgents } from "../../src/agents/agent-prototype.mjs";
import { createPlatformSnapshot } from "../../src/architecture/platform-contract.mjs";
import { networkAllowed } from "../../src/runtime/web-capabilities.mjs";
import { authorizeConfirmedRequirement, evaluateConsultation, issueConfirmation, newConsultation } from "../../src/requirements/consultation.mjs";
import { sufficientPreflight } from "../helpers/consultation.mjs";
import { readReviewTaskCheckpoint } from "../../src/runtime/repair-scheduler.mjs";
import { createPiSession } from "../../src/runtime/pi-runtime.mjs";
import { designHash } from "../../src/architecture/architecture-contract.mjs";
import { createReviewProgressCheckpoint } from "../../src/architecture/architecture-review-progress.mjs";
import { createArchitectureReviewRetry, createArchitectureReviewTestRetry } from "../../src/architecture/architecture-review-revision.mjs";
import { validDraft, validDesign, passingReview } from "../helpers/architecture.mjs";
import { architectureStageSubmission } from "../helpers/architecture-stages.mjs";
import { fidelityResult } from "../helpers/fidelity.mjs";
import { readModelContextSection } from "../helpers/model-context.mjs";
import type { NeumaPiSession, PiSessionOptions } from "../../src/runtime/pi-port.mjs";
import type { ArchitectureBase } from "../../src/contracts/architecture.mjs";

interface NativePayload extends Record<string, unknown> {
  repairAssignment?: { baseHash: string; issues: { id: string }[]; allowedPaths: string[] };
  pipelineStage?: string; requirements?: { id: string; text: string }[]; assignment?: unknown; baseCandidate?: unknown;
  rejectedSubmission?: { submissionHash: string }; baseHash?: string; candidateHash?: string;
  design?: Parameters<typeof passingReview>[1] & { components: { purpose: string }[] }; priorFindings?: Parameters<typeof passingReview>[2];
  reviewEvidenceIndex?: { acceptanceScope: { acceptanceId: string; adapterId: string }[]; adapterRules: Record<string, string[]>; priorFindings: { findingId: string; findingRef: string }[] };
  contextHash?: string; candidate?: unknown; modelBudget?: { used: number; limit: number };
  evidenceCatalog?: { id: string }[]; stageRepair?: { additionalCalls: number }; reviewParts?: { saved?: unknown; missing: { acceptanceScopeChecks: unknown[] } };
}
const text = (content: unknown): string => typeof content === "string" ? content : recordArray(content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
const users = (body: FixtureChatRequest): NativePayload[] => body.messages.filter(message => message.role === "user").map(message => {
  try { const value: unknown = JSON.parse(text(message.content)); return value && typeof value === "object" && !Array.isArray(value) ? value as NativePayload : null; } catch { return null; }
}).filter((value): value is NativePayload => value !== null);
interface NativeStage { result: unknown; resultHash: unknown; modelCalls: number; sessionRef: { file: string } }
interface NativeCheckpoint { blueprint: NativeStage; modules: NativeStage[]; integration: NativeStage; modelCalls: number }
function nativeCheckpoint(value: unknown): NativeCheckpoint {
  const fields = objectFields(value); assert.ok(fields.blueprint && Array.isArray(fields.modules) && fields.integration);
  return value as NativeCheckpoint;
}
function fixtureNumber(value: unknown): number { assert.ok(typeof value === "number"); return value; }
const stageNames = { blueprint: "submit_architecture_blueprint", module: "submit_architecture_module", integration: "submit_architecture_integration" };

async function fixture(t: test.TestContext, { failModule = false, rejectReview = false, researchBeforeBlueprint = false, rejectModuleCalls = 0, rejectIntegrationCalls = 0,
  failRevisionCalls = 0, failRevisedReview = 0, failRepairCalls = 0, programBlocker = false, useFindingSelectors = false,
  consultBeforeBlueprint = false, failConsultation = false, omitBlueprintRequirement = false, stallModule = false,
  acceptanceCount = 0, failReviewSlice = false, malformedReviewSlice = false, readReviewPages = false, rejectSlice = false, reviewSliceJson = false, legacyModuleContext = false, compactHandoffs = false, malformedCoverage = false,
  interruptIntegration = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-design-native-")), requests: { kind: string; body: FixtureChatRequest }[] = [], errors: ((unknown))[] = [], sessions: ({ "session": (NeumaPiSession); "options": (PiSessionOptions); })[] = [], researchCalls: ((unknown))[] = [];
  const state = { failModule, rejectReview, researchBeforeBlueprint, rejectModuleCalls, rejectIntegrationCalls, failRevisionCalls, failRevisedReview,
    programBlocker, researchIssued: false, consultationIssued: false, reviewRejected: false, malformedSliceSubmitted: false, malformedSliceInterrupted: false,
    blueprintDraft: null as Record<string, unknown> | null, blueprintAllocation: null as Record<string, unknown> | null, blueprintPatched: false,
    blueprintRawRejected: false, blueprintRawFeedback: "",
    cancelStage: null as "blueprint" | "module" | "integration" | "research" | null, controller: null as AbortController | null }, dataDir = join(root, "data");
  let designer: ArchitectureDesigner, candidate: CandidateDraft;
  let rejectedSlice: Record<string, unknown> | undefined;
  const guideReference = { source: "acceptanceAdapterGuide", path: "/adapters/action/executionRule" };
  const draft = validDraft();
  draft.taskSpec = { version: 1, items: [{ id: "all_records", dimension: "processing", content: "完整核对全部工作记录", applicability: "applies", critical: true,
    source: { kind: "user", evidence: [{ messageId: "confirmed", quote: "完整核对全部工作记录" }] } }] };
  const definition = { id: "native_stages", name: "阶段化架构原生恢复", fingerprint: "same-confirmed-input", draft };
  const model = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString()), names = body.tools!.map((tool) => tool.function.name), payloads = users(body);
      const stage = (Object.keys(stageNames) as (keyof typeof stageNames)[]).find(key => names.includes(stageNames[key]));
      const kind = stage ?? (names.includes("submit_architecture_review_slice") ? "review_slice" : names.includes("submit_blueprint_analysis") ? "consultation" : names.includes("submit_repair_patch") ? "repair" : names.includes("submit_architecture_review_revision") ? "review_revision"
        : names.includes("submit_requirement_fidelity") ? "fidelity" : "reviewer");
      const firstSlice = kind === "review_slice" && objectFields(payloads.findLast(row => row.pipelineStage === "review_slice")?.assignment).id === "review_checks_0";
      requests.push({ kind, body });
      if (stage === "module" && stallModule) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: "native-stalled-stream", choices: [{ index: 0,
          delta: { role: "assistant", content: "固定的未完成模块" }, finish_reason: null }] })}\n\n`);
        return;
      }
      let name, args;
      if (stage === "integration" && interruptIntegration || firstSlice && failReviewSlice && rejectedSlice || kind === "consultation" && failConsultation
        || firstSlice && malformedReviewSlice && state.malformedSliceSubmitted && !state.malformedSliceInterrupted
        || kind === "review_revision" && state.failRevisionCalls-- > 0
        || kind === "repair" && failRepairCalls-- > 0
        || kind === "reviewer" && state.reviewRejected && state.failRevisedReview-- > 0) {
        if (stage === "integration") interruptIntegration = false;
        if (kind === "consultation") failConsultation = false;
        if (firstSlice && failReviewSlice) {
          assert.match(text(body.messages.findLast(message => message.role === "tool")!.content), /invalid_receipt/u);
          failReviewSlice = false;
        }
        if (firstSlice && malformedReviewSlice) {
          state.malformedSliceInterrupted = true;
          assert.match(text(body.messages.findLast(message => message.role === "tool")!.content), /JSON文字无法解析/);
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ id: "revision-length", choices: [{ index: 0, delta: { role: "assistant", content: "固定修订阶段截断" }, finish_reason: "length" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (stage === "module" && state.failModule) {
        state.failModule = false;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ id: "native-length", choices: [{ index: 0, delta: { role: "assistant", content: "固定未完整模块结果" }, finish_reason: "length" }],
          usage: { prompt_tokens: 100, completion_tokens: body.max_tokens, total_tokens: 100 + fixtureNumber(body.max_tokens) } })}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (stage) {
        const payload = payloads.find((row) => row.pipelineStage === stage && (stage === "blueprint" ? row.requirements : stage === "module" ? row.assignment : row.baseCandidate));
        assert.ok(payload, "恢复的原生历史应保留首次完整节点材料");
        if (stage === "blueprint" && consultBeforeBlueprint && !state.consultationIssued) {
          assert.ok(names.includes("consult_architecture")); state.consultationIssued = true;
          name = "consult_architecture"; args = { assignments: [{ topic: "platform", handoffText: "核对本需求的实现路径", requirementIds: [payload.requirements![0]!.id] }] };
        } else if (stage === "blueprint" && state.researchBeforeBlueprint && !state.researchIssued) {
          state.researchIssued = true;
          name = "search_technical_sources"; args = { query: "固定技术依据，无真实检索", topics: ["sdk"] };
        } else {
          if (stage === "blueprint") candidate = validDesign(payload.requirements!, { schemaVersion: 3, connections: [],
            interaction: { defaultEntry: "conversation", page: false, operations: false, inputs: "已确认记录", results: "完整摘要", persistentData: "无跨任务状态" },
            execution: { language: "none", hosting: "builtin", reason: "复用已有对话能力" },
            selectionBasis: { capacity: "已确认记录集合", process: "逐项核对", quality: "保留原文事实", requirementIds: payload.requirements!.map((item) => item.id), assumptions: [] } });
          if (stage === "blueprint" && state.programBlocker) candidate.unknowns = [{ question: "固定尚未核实的业务效果",
            blocking: true, resolution: "保留独立程序阻断，用于检验评审恢复不能绕过未完成核实" }];
          if (stage === "blueprint" && acceptanceCount) candidate.acceptance = Array.from({ length: acceptanceCount }, (_, i) => ({
            ...candidate.acceptance[i % candidate.acceptance.length]!, id: `case_${i}` }));
          if (stage === "module" && state.reviewRejected) candidate.components[0]!.purpose = "完整逐条归纳已确认工作记录并标记缺失项";
          const submission = compactHandoffs && stage === "integration"
            ? { name: stageNames.integration, args: { baseHash: payload.baseHash, path: "/instructions", value: candidate.instructions } }
            : architectureStageSubmission({ tools: Object.fromEntries(names.map((toolName) => [toolName, { name: toolName }])), payload, candidate });
          name = submission!.name!; args = submission!.args!;
          if (stage === "blueprint" && omitBlueprintRequirement) {
            if (!state.blueprintRawRejected) {
              Reflect.set(recordArray(objectFields(args).modules)[0]!, "requirementIds", [
                ...payload.requirements!.slice(0, -1).map(row => row.id), payload.requirements![0]!.id, "unknown_requirement",
              ]);
              state.blueprintRawRejected = true;
            } else if (!state.blueprintDraft) {
              state.blueprintRawFeedback = body.messages.filter(row => row.role === "tool").map(row => text(row.content))
                .findLast(value => value.includes('"blueprintAllocation"')) ?? "";
              assert.ok(state.blueprintRawFeedback, "SDK前置拒绝也必须返回具体分配诊断");
              Reflect.set(recordArray(objectFields(args).modules)[0]!, "requirementIds", payload.requirements!.slice(0, -1).map(row => row.id));
              state.blueprintDraft = objectFields(structuredClone(args));
            } else if (!state.blueprintPatched) {
              const feedback = body.messages.filter(row => row.role === "tool").map(row => text(row.content))
                .findLast(value => value.includes("蓝图需求分工诊断："));
              assert.ok(feedback, "原生工具回填必须携带具体分配诊断");
              const report = /蓝图需求分工诊断：(\{.*\})；只修正/.exec(feedback);
              const reference = /"rejectedSubmission":\{"submissionHash":"([a-f0-9]{64})"\}/.exec(feedback);
              assert.ok(report); assert.ok(reference);
              state.blueprintAllocation = objectFields(JSON.parse(report[1]!));
              name = "revise_architecture_submission";
              args = { submissionHash: reference[1], path: "/modules/0/requirementIds", value: payload.requirements!.map(row => row.id) };
              state.blueprintPatched = true;
            }
          }
          if (stage === "integration" && state.rejectIntegrationCalls > 0) {
            state.rejectIntegrationCalls--;
            Reflect.set(args!, "updates", [{ path: "/components", value: [{ ...candidate.components[0]!, id: "forbidden_rewrite" }] }]);
          }
          if (stage === "module" && state.rejectModuleCalls > 0) {
            state.rejectModuleCalls--; recordArray(objectFields(args).steps)[0]!.componentId = "fixture_missing_component";
          } else if (stage === "module" && payloads.at(-1)?.rejectedSubmission) {
            name = "revise_architecture_submission";
            args = { submissionHash: payloads.at(-1)!.rejectedSubmission!.submissionHash,
              updates: [{ path: "/steps/0/componentId", value: recordArray(objectFields(args).steps)[0]!.componentId }] };
          }
        }
      } else if (kind === "consultation") {
        const payload = payloads.find(row => row.pipelineStage === "consultation");
        assert.ok(payload); assert.equal(payload.requirements!.length, 1);
        assert.equal(names.includes("consult_architecture"), false);
        assert.equal(objectFields(payload.assignment).handoffText, "核对本需求的实现路径");
        name = "submit_blueprint_analysis"; args = { handoffText: "建议保留需求并使用已有能力，实际效果仍待验收。", references: [{ section: "requirements", pointer: "/0" }] };
      } else if (kind === "review_slice") {
        const payload = payloads.findLast(row => row.pipelineStage === "review_slice")!;
        const assignment = objectFields(payload.assignment), ids = assignment.ids as string[];
        const reviewed = passingReview(payload.candidateHash!, payload.design, payload.priorFindings);
        name = "submit_architecture_review_slice";
        const published = objectFields(body.tools!.find(tool => tool.function.name === "submit_architecture_review_slice")!.function).parameters;
        assert.deepEqual(Object.keys(objectFields(objectFields(published).properties)).sort(), ["summary", "issues", assignment.field].sort());
        args = { summary: "原生模拟模型独立核对本组原文", issues: [], factClaims: reviewSliceJson ? [] : " [\n ] ",
          checks: assignment.field === "checks" ? reviewed.checks.filter(row => ids.includes(row.id)) : [],
          acceptanceScopeChecks: assignment.field === "acceptanceScopeChecks" ? reviewed.acceptanceScopeChecks!.filter(row => "acceptanceId" in row && ids.includes(row.acceptanceId)) : [],
          priorFindingDecisions: assignment.field === "priorFindingDecisions" ? reviewed.priorFindingDecisions!.filter(row => "findingId" in row && ids.includes(row.findingId)) : [] };
        if (rejectReview && !state.reviewRejected && ids.includes("verification")) {
          args.checks.find(row => row.id === "verification")!.passed = false;
          args = { ...args, issues: [{ id: "review_scope", blocking: false, kind: "context", checkId: "verification",
            description: "本组认为职责说明需进一步核对，交主评审裁决。", remedy: "核对并完善职责说明。",
            candidatePaths: ["/components/0/purpose"], references: [{ source: "candidate", path: "/components/0/purpose" }] }] };
        }
        if (firstSlice && failReviewSlice) {
          const read = body.messages.findLast(message => message.role === "tool");
          if (!read) {
            name = "read_architecture_evidence"; args = { source: guideReference.source, pointer: guideReference.path };
          } else {
            const page = objectFields(JSON.parse(text(read.content).split("\n")[0]!));
            assert.ok(typeof page.receiptId === "string");
            const issue = { id: "verify_action", kind: "context", checkId: ids[0], blocking: false, description: "研发时核对动作的测试范围。",
              remedy: "对照实际验收结果。", candidatePaths: [{ receiptId: page.receiptId }, "candidate /acceptance/0/expected"], references: [guideReference] };
            args = { ...args, issues: [issue] }; rejectedSlice = args;
          }
        } else if (firstSlice && rejectedSlice) {
          const recovery = objectFields(payload.reviewReferenceRecovery), draft = objectFields(recovery.draft);
          const recoveredIssue = recordArray(draft.issues)[0]!;
          assert.deepEqual(recovery.reselect, []);
          assert.deepEqual(recovery.designLocations, ["/acceptance/0/expected"]);
          assert.deepEqual(recoveredIssue.candidatePaths, recovery.designLocations);
          assert.deepEqual(recoveredIssue.references, [guideReference]);
          args = rejectedSlice;
        }
        if (firstSlice && malformedReviewSlice) {
          const checks = recordArray(objectFields(args).checks).map(row => ({ ...row, evidence: '核对"引号"格式并保留本组判断' }));
          const issues = [{ id: "format_note", blocking: false, kind: "context", checkId: ids[0], description: '核对"引号"格式',
            remedy: "保留本组判断", candidatePaths: ["/components/0/purpose"], references: [{ source: "candidate", path: "/components/0/purpose" }] }];
          if (!state.malformedSliceSubmitted) {
            state.malformedSliceSubmitted = true;
            args = { ...args, checks: JSON.stringify(checks).replaceAll('\\"', '"'), issues: JSON.stringify(issues).replaceAll('\\"', '"') };
          } else {
            args = { ...args, checks, issues };
          }
        }
      } else if (kind === "repair") {
        const assignment = payloads.findLast(row => row.repairAssignment)!.repairAssignment!;
        name = "submit_repair_patch";
        args = { baseHash: assignment.baseHash, issueIds: assignment.issues.map(issue => issue.id),
          summary: "固定模型只补职责，其他程序阻断保留以检验评审恢复", updates: assignment.allowedPaths.some(path => path.startsWith("/components"))
            ? [{ path: "/components/0/purpose", value: "完整逐条归纳已确认工作记录并标记缺失项" }] : [] };
      } else if (kind === "review_revision") {
        const payload = payloads.findLast((row) => row.pipelineStage === "review_revision" && row.baseCandidate);
        assert.ok(payload); name = "submit_architecture_review_revision";
        args = { baseHash: payload.baseHash, path: "/components/0/purpose", value: "完整逐条归纳已确认工作记录并标记缺失项" };
      } else if (kind === "reviewer") {
        const payload = payloads.findLast((row) => row.design && row.candidateHash);
        assert.ok(payload); name = "submit_architecture_review";
        args = passingReview(payload.candidateHash!, payload.design, payload.priorFindings);
        if (acceptanceCount > 10) Reflect.set(args, "factClaims", "[]");
        args.acceptanceScopeChecks = payload.reviewEvidenceIndex!.acceptanceScope.map((row) => ({ acceptanceId: row.acceptanceId,
          adapterRulePath: payload.reviewEvidenceIndex!.adapterRules[row.adapterId]![0]!, sufficient: true, reason: "固定模型核对本项冻结范围" }));
        if (state.rejectReview && !state.reviewRejected) {
          state.reviewRejected = true; args.verdict = "revise";
          args.checks!.find(row => row.id === "verification")!.passed = false;
          args.issues.push({ id: "module_scope", blocking: true, checkId: "verification", kind: "design",
            description: "模块职责尚未明确逐条核对及缺失项标记。", remedy: "仅修改该模块职责，保留原业务承诺。",
            candidatePaths: ["/components/0/purpose"], references: [{ source: "candidate", path: "/components/0/purpose", quote: payload.design!.components[0]!.purpose }], factClaims: [] });
        }
        if (useFindingSelectors && payload.priorFindings?.findings.length) {
          const refs = new Map(payload.reviewEvidenceIndex!.priorFindings.map((row) => [row.findingId, row.findingRef]));
          Reflect.set(args, "priorFindingDecisions", args.priorFindingDecisions!.map(({ findingId, ...row }) => {
            assert.ok(refs.has(findingId!)); return { ...row, findingRef: refs.get(findingId!) };
          }));
          Reflect.set(args, "issues", args.issues.map(({ id, references, ...row }) => ({ ...row,
            ...(refs.has(id!) ? { findingRef: refs.get(id!) } : { id }),
            references: references!.map!(item => { const { quote: _quote, ...reference } = objectFields(item); return reference; }) })));
        }
      } else {
        const payload = payloads.findLast((row) => row.contextHash && row.candidate);
        assert.ok(payload); name = "submit_requirement_fidelity"; args = fidelityResult(payload);
      }
      const reviewNode = ["review_slice", "reviewer", "fidelity"].includes(kind);
      if (reviewNode && readReviewPages && body.messages.filter(row => row.role === "tool").length < 4) {
        name = "read_model_context"; args = { requests: [{ section: "requirements" }] };
        assert.ok(names.includes(name));
      } else if (rejectSlice && kind === "review_slice" && payloads.some(row => objectFields(row.assignment).id === "review_checks_0")) {
        args = { ...objectFields(args), factClaims: [{ source: "runtimeCapabilities", path: "/version", expectedJson: "1" }] };
      }
      if (stage === "module" && malformedCoverage) {
        const rejection = body.messages.filter(m => m.role === "tool").map(m => text(m.content)).find(m => m.includes('"rejectedSubmission"'));
        if (rejection) {
          const hash = /"submissionHash":"([a-f0-9]{64})"/.exec(rejection);
          assert.ok(hash, "仅有容器类型错误的拒稿须取得当前修订编号");
          name = "revise_architecture_submission"; args = { submissionHash: hash[1], path: "/coverage", value: candidate.coverage };
        } else { Reflect.set(args, "coverage", '[{"requirementId": "first"'); }
      }
      if (compactHandoffs) {
        const fields = objectFields(args);
        if (name === stageNames.blueprint) {
          const { rationale, ...global } = objectFields(fields.global);
          args = { ...global, handoffText: rationale, modules: JSON.stringify(fields.modules) };
        } else if (name === stageNames.module) {
          const { coverage, ...rest } = fields;
          const components = recordArray(fields.components).map(component => ({ ...component, requirementIds: recordArray(coverage)
            .filter(row => (row.componentIds as string[]).includes(String(component.id))).map(row => row.requirementId) }));
          const decisions = recordArray(fields.decisions).map(({ uncertainties, ...decision }) =>
            Array.isArray(uncertainties) && !uncertainties.length ? decision : { ...decision, uncertainties });
          args = { ...rest, handoffText: "下游请核对逐条归纳的结果。", components, decisions, acceptance: JSON.stringify(fields.acceptance) };
        } else if (name === "submit_architecture_review") {
          const { issues, ...rest } = fields;
          args = { ...rest, ...(Array.isArray(issues) && issues.length ? { issue: issues[0] } : {}) };
        }
      }
      if (reviewSliceJson && name === "submit_architecture_review_slice") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ id: "native-slice-json", choices: [{ index: 0,
          delta: { role: "assistant", content: JSON.stringify(args) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "native-stage-fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0,
        id: `stage_call_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      errors.push(error); response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: objectFields(error).message } }));
    }
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const config = { llmConfigured: true, model: "native-stage-model", apiKey: "fixed-local-fixture", chatUrl: `http://127.0.0.1:${listeningAddress(model).port}/v1/chat/completions`,
    ...(stallModule ? { llmIdleTimeoutMs: 150 } : {}) };
  const sessionFactory = async (options: PiSessionOptions) => {
    const session = await createPiSession({ ...options,
      ...(legacyModuleContext && objectFields(options.sessionStorage?.binding).stage === "module" ? { preparePrompt: async (raw: string) => {
        const payload = JSON.parse(await options.preparePrompt?.(raw) ?? raw);
        if (payload.type !== "resume_architecture_stage") { delete payload.requirementScope; delete payload.moduleObligations; }
        return JSON.stringify(payload);
      } } : {}) });
    sessions.push({ session, options });
    session.setAutoRetryEnabled(false); session.setAutoCompactionEnabled(false);
    session.subscribe(event => {
      const name = state.cancelStage === "research" ? "search_technical_sources" : state.cancelStage ? stageNames[state.cancelStage] : undefined;
      if (name && event.type === "tool_execution_end" && event.toolName === name && !event.isError) {
        state.cancelStage = null; state.controller!.abort(new Error("固定阶段保存后的用户取消"));
      }
    });
    return session;
  };
  const research = { async search(query: unknown, { signal }: { signal?: AbortSignal } = {}) {
    signal?.throwIfAborted(); researchCalls.push(structuredClone(query));
    assert.equal((await designer.get(definition.id))!.designResearchCalls!, 1, "检索工具执行前必须已持久扣减本次额度");
    return { sources: [{ id: "fixed-sdk-source", url: "https://docs.example.test/fixed-sdk", title: "固定本地技术夹具",
      retrievedAt: "2026-10-22T00:00:00.000Z", versionScope: "只用于本机固定回放，不代表真实文档检索", excerpt: "固定接口边界证据。" }], gaps: [] };
  } };
  const create = async () => {
    designer = new ArchitectureDesigner({ config, cwd: root, dataDir, sessionFactory, fidelitySessionFactory: sessionFactory, research });
    await designer.ready;
  };
  await create();
  t.after(async () => { await designer.persistence; model.closeAllConnections(); await new Promise<void>(resolve => model.close(error => error ? assert.fail(error.message) : resolve())); await rm(root, { recursive: true, force: true }); });
  return { root, dataDir, config, definition, state, requests, errors, sessions, researchCalls,
    get designer() { return designer; },
    reload: async () => { await designer.persistence; await create(); },
    run: (options = {}) => designer.design(definition, { signal: state.controller?.signal, ...options }),
    sessionDirectory: () => sessions.find(row => row.options.sessionStorage)!.options.sessionStorage!.directory,
    sessionPath: (file: unknown) => join(sessions.find(row => row.options.sessionStorage)?.options.sessionStorage!.directory!, fixtureString(file)) };
}

async function normalBuild(t: test.TestContext, f: Awaited<ReturnType<typeof fixture>>) {
  const platform = createPlatformSnapshot({ allowNetwork: networkAllowed(f.definition.draft) });
  const source = newConsultation();
  source.evidenceMessages.push({ id: "confirmed", role: "user", content: "完整核对全部工作记录" });
  const consultation = await evaluateConsultation({ draft: f.definition.draft, consultation: source, platform, preflight: sufficientPreflight });
  const confirmationReceipt = authorizeConfirmedRequirement(f.definition.draft, issueConfirmation(f.definition.draft, consultation, { platform }));
  const agents = new PrototypeAgents({ config: f.config, cwd: f.root, dataDir: f.dataDir, architecture: f.designer });
  await agents.ready;
  await agents.library.saveRequirement(f.definition.id, f.definition, { consultation, confirmationReceipt });
  t.after(() => agents.close());
  return agents;
}

test("真实Pi把扁平蓝图、模块正文和编码用例装配为正式候选，交接正文不进入执行指令", { timeout: 30000 }, async t => {
  const f = await fixture(t, { compactHandoffs: true });
  const built = await f.run();
  assert.equal(built.status, "passed", built.summary);
  assert.deepEqual(f.errors, []);
  const checkpoint = nativeCheckpoint(built.designProgressCheckpoint);
  assert.equal(checkpoint.blueprint.modelCalls, 1);
  const result = objectFields(checkpoint.modules[0]!.result);
  assert.equal(checkpoint.modules[0]!.modelCalls, 1);
  assert.equal(result.handoffText, "下游请核对逐条归纳的结果。");
  assert.doesNotMatch(built.design!.instructions, /下游请核对/u);
  assert.deepEqual(built.design!.decisions[0]!.uncertainties, []);
  assert.deepEqual(built.design!.coverage.map(row => row.requirementId), built.requirements.map(row => row.id));
  assert.ok(built.design!.coverage.every(row => row.componentIds.length > 0 && built.design!.acceptance.some(item => item.requirementIds.includes(row.requirementId))));
  const boundary = objectFields(users(f.requests.find(row => row.kind === "integration")!.body)[0]!.blueprintBoundary);
  assert.equal(recordArray(boundary.moduleHandoffs)[0]!.handoffText, result.handoffText);
  assert.deepEqual(built.review!.issues, []);
  await f.reload(); assert.equal((await f.designer.get(f.definition.id))!.candidateHash, built.candidateHash);
});

test("整合首次派发和原会话恢复都给出本轮验收修改范围与空补丁写法", { timeout: 30000 }, async t => {
  const f = await fixture(t, { interruptIntegration: true });
  await assert.rejects(f.run(), error => objectFields(objectFields(error).diagnostic).reason === "output_limit");
  await f.reload();
  const passed = await f.run();
  assert.equal(passed.status, "passed");
  assert.deepEqual(f.errors, []);
  const requests = f.requests.filter(row => row.kind === "integration");
  assert.equal(requests.length, 2);
  const packets = requests.map(({ body }) => users(body).at(-1)!);
  assert.equal(packets[1]!.type, "resume_architecture_stage");
  const integrated = objectFields(nativeCheckpoint(passed.designProgressCheckpoint).integration.result);
  for (const packet of packets) {
    assert.deepEqual(packet.conflicts, []);
    assert.equal(packet.baseHash, integrated.baseHash);
    const policy = fixtureString(objectFields(packet.integrationPolicy).instruction);
    assert.match(policy, /conflicts/);
    assert.match(policy, /verification/);
    assert.match(policy, /追加/);
    assert.match(policy, /updates\s*:\s*\[\]/);
  }
  assert.equal(Object.hasOwn(packets[1]!, "baseCandidate"), false);
  const prompt = requests[1]!.body.messages.filter(row => ["system", "developer"].includes(row.role)).map(row => text(row.content)).join("\n");
  assert.match(prompt, /verification/);
  assert.doesNotMatch(prompt, /正式重查可修正技术验收与证据分工/);
});

test("结构损坏的覆盖清单先被拒，原生会话只补该字段即可完整复验", { timeout: 30000 }, async t => {
  const f = await fixture(t, { malformedCoverage: true });
  const built = await f.run();
  assert.deepEqual(f.errors, []); assert.equal(built.status, "passed");
  const checkpoint = nativeCheckpoint(built.designProgressCheckpoint);
  assert.equal(checkpoint.blueprint.modelCalls, 1); assert.equal(checkpoint.modules[0]!.modelCalls, 2);
  assert.equal(built.design!.coverage.length, built.requirements.length);
});

test("原生子组续接从冻结材料恢复出处，旧的重复错填不阻断主评审和范围复核", { timeout: 30000 }, async t => {
  const f = await fixture(t, { acceptanceCount: 13, failReviewSlice: true });
  await assert.rejects(f.run(), error => objectFields(objectFields(error).diagnostic).reason === "review_slice_incomplete");
  const before = (await f.designer.get(f.definition.id))!;
  const saved = readReviewTaskCheckpoint(objectFields(before.reviewDispatchCheckpoint).dispatch);
  assert.equal(saved.groups.length, 7); assert.equal(saved.calls, 5);
  assert.equal(saved.groups.filter(group => group.result).length, 2);
  assert.equal(saved.groups[0]!.rejection?.count, 1);
  assert.equal(before.reviewProgressCheckpoint!.modelCalls, 0);
  assert.equal(before.designRecovery!.kind, "review_specialists");
  const start = f.requests.length;
  await f.reload(); const result = await f.run();
  assert.equal(result.status, "passed");
  assert.equal(f.requests.slice(start).some(request => ["blueprint", "module", "integration"].includes(request.kind)), false);
  const completed = readReviewTaskCheckpoint(objectFields(result.reviewDispatchCheckpoint).dispatch);
  assert.equal(completed.calls, 10);
  for (const group of saved.groups.filter(group => group.result))
    assert.deepEqual(completed.groups.find(item => item.id === group.id), group);
  assert.equal(result.reviewProgressCheckpoint!.modelCalls, 2);
  assert.ok(f.requests.slice(start).some(request => request.kind === "fidelity"));
  assert.deepEqual(f.errors, []);
});

test("原生评审列表文字损坏后逐字段回填诊断，重启原会话重交且保留同因计数", { timeout: 30000 }, async t => {
  const f = await fixture(t, { acceptanceCount: 13, malformedReviewSlice: true });
  await assert.rejects(f.run(), error => objectFields(objectFields(error).diagnostic).reason === "review_slice_incomplete");
  assert.deepEqual(f.errors, []);
  const before = (await f.designer.get(f.definition.id))!, saved = readReviewTaskCheckpoint(objectFields(before.reviewDispatchCheckpoint).dispatch);
  const stopped = saved.groups[0]!;
  assert.equal(stopped.calls, 2); assert.equal(stopped.rejection!.count, 1); assert.equal(stopped.result, null);
  const start = f.requests.length;
  await f.reload();
  const result = await f.run();
  assert.deepEqual(f.errors, []); assert.equal(result.status, "passed");
  const completed = readReviewTaskCheckpoint(objectFields(result.reviewDispatchCheckpoint).dispatch), resumed = completed.groups[0]!;
  assert.equal(resumed.sessionFile, stopped.sessionFile); assert.equal(resumed.calls, 3);
  assert.deepEqual(resumed.rejection, stopped.rejection);
  for (const group of saved.groups.filter(row => row.result)) assert.deepEqual(completed.groups.find(row => row.id === group.id), group);
  const request = f.requests.slice(start).find(row => row.kind === "review_slice")!, packet = users(request.body).at(-1)!;
  assert.equal(packet.modelBudget!.used, stopped.calls);
  const recovery = objectFields(packet.reviewReferenceRecovery), diagnostics = recordArray(recovery.submissionIssues);
  assert.deepEqual(diagnostics.map(row => row.path).sort(), ["review_slice.checks", "review_slice.issues"]);
  assert.ok(diagnostics.every(row => row.reason === "invalid_type" && String(row.remedy).includes("JSON文字无法解析")));
  assert.equal(typeof objectFields(recovery.draft).checks, "string");
  const prompt = request.body.messages.filter(row => ["system", "developer"].includes(row.role)).map(row => text(row.content)).join("\n");
  assert.match(prompt, /列表直接提交原生数组/);
  assert.deepEqual(result.designProgressCheckpoint, before.designProgressCheckpoint);
});

test("子组、主评审和范围复核都能在四次读取后提交，累计用量可重新载入", { timeout: 30000 }, async t => {
  const f = await fixture(t, { acceptanceCount: 13, readReviewPages: true, reviewSliceJson: true });
  assert.equal((await f.run()).status, "passed");
  await f.reload();
  const record = (await f.designer.get(f.definition.id))!;
  const dispatch = readReviewTaskCheckpoint(objectFields(record.reviewDispatchCheckpoint).dispatch);
  assert.ok(dispatch.groups.every(group => group.calls === 5 && group.result && !group.rejection));
  assert.equal(dispatch.callLimit, null);
  assert.equal(record.reviewProgressCheckpoint!.modelCalls, 10);
  assert.equal(objectFields(record.requirementFidelityProgress!.state).calls, 5);
  assert.equal(record.designProgressCheckpoint!.modelCalls, 3);
  assert.deepEqual(f.errors, []);
});

test("子组连续三次把有内容的证据放在报告外层会锁住原任务，恢复不再发请求", { timeout: 30000 }, async t => {
  const f = await fixture(t, { acceptanceCount: 13, rejectSlice: true });
  await assert.rejects(f.run(), error => objectFields(objectFields(error).diagnostic).reason === "review_slice_incomplete");
  await f.reload();
  const record = (await f.designer.get(f.definition.id))!;
  const group = readReviewTaskCheckpoint(objectFields(record.reviewDispatchCheckpoint).dispatch).groups[0]!;
  assert.equal(group.calls, 3); assert.equal(group.rejection?.count, 3);
  assert.equal(record.diagnostic?.lastSubmissionIssue?.path, "review_slice.factClaims");
  assert.equal(record.diagnostic?.lastSubmissionIssue?.reason, "unknown_field");
  assert.equal(record.designRecovery!.status, "blocked");
  const requests = f.requests.length;
  await assert.rejects(f.run(), /连续三次/);
  assert.equal(f.requests.length, requests);
});

test("原生模块响应停滞保留超时收包诊断与蓝图检查点，重读仍为失败且不续调", { timeout: 30000 }, async t => {
  const f = await fixture(t, { stallModule: true });
  let diagnostic: Record<string, unknown> = {};
  await assert.rejects(f.run(), error => {
    diagnostic = objectFields(objectFields(error).diagnostic);
    assert.equal(diagnostic.reason, "api_idle_timeout");
    const transport = objectFields(diagnostic.modelTransport);
    assert.equal(transport.phase, "body");
    assert.equal(transport.idleTimeoutMs, 150);
    assert.ok(fixtureNumber(transport.receivedBytes) > 0);
    assert.ok(fixtureNumber(transport.chunkCount) >= 1);
    assert.ok(fixtureNumber(transport.firstResponseMs) <= fixtureNumber(transport.lastDataMs));
    assert.ok(fixtureNumber(transport.elapsedMs) >= fixtureNumber(transport.lastDataMs));
    return true;
  });
  assert.deepEqual(f.requests.map(row => row.kind), ["blueprint", "module"]);
  await f.reload();
  const saved = (await f.designer.get(f.definition.id))!;
  assert.equal(saved.status, "failed");
  assert.deepEqual(saved.diagnostic, diagnostic);
  const checkpoint = nativeCheckpoint(saved.designProgressCheckpoint);
  assert.ok(checkpoint.blueprint.result);
  assert.equal(checkpoint.modules[0]!.modelCalls, 1);
  assert.equal(checkpoint.modules[0]!.result, null);
  assert.equal(checkpoint.modelCalls, 2);
  assert.deepEqual(f.errors, []);
});

test("必读提示与工具区分全局引用和模块主责，原生反馈能指导只补编号清单", { timeout: 30000 }, async t => {
  const f = await fixture(t, { omitBlueprintRequirement: true });
  const result = await f.run();
  assert.equal(result.status, "passed");
  assert.equal(f.state.blueprintPatched, true);
  const allocation = f.state.blueprintAllocation!;
  assert.deepEqual(allocation.totals, { missing: 1, duplicates: 0, unknown: 0 });
  assert.equal(recordArray(allocation.missing)[0]!.referencedGlobally, true);
  const saved = objectFields(nativeCheckpoint(result.designProgressCheckpoint).blueprint.result);
  assert.deepEqual(saved.global, f.state.blueprintDraft!.global);
  const beforeModule = recordArray(f.state.blueprintDraft!.modules)[0]!, afterModule = recordArray(saved.modules)[0]!;
  const { requirementIds: beforeIds, ...beforeBody } = beforeModule;
  const { requirementIds: afterIds, ...afterBody } = afterModule;
  assert.deepEqual(afterBody, beforeBody);
  assert.equal((afterIds as string[]).length, (beforeIds as string[]).length + 1);
  assert.equal(nativeCheckpoint(result.designProgressCheckpoint).blueprint.modelCalls, 3);
  assert.match(f.state.blueprintRawFeedback, /"totals":\{"missing":1,"duplicates":1,"unknown":1\}/);
  assert.match(f.state.blueprintRawFeedback, /"id":"unknown_requirement"/);
  const request = f.requests.find(row => row.kind === "blueprint")!.body;
  const system = request.messages.filter(row => row.role === "system").map(row => text(row.content)).join("\n");
  assert.match(system, /每个id.*恰好出现一次/);
  assert.match(system, /selectionBasis\.requirementIds.*不能替代/);
  const parameters = objectFields(objectFields(request.tools!.find(tool => tool.function.name === "submit_architecture_blueprint")!.function).parameters);
  const properties = objectFields(parameters.properties);
  const moduleFields = objectFields(objectFields(objectFields(properties.modules).items).properties);
  assert.match(String(objectFields(moduleFields.requirementIds).description), /恰好出现一次/);
  const globalFields = objectFields(objectFields(properties.global).properties);
  const basisFields = objectFields(objectFields(globalFields.selectionBasis).properties);
  assert.match(String(objectFields(basisFields.requirementIds).description), /不算模块覆盖/);
  assert.deepEqual(f.errors, []);
});

test("蓝图专项分析使用独立原生会话，截断恢复保留子会话及已用总额", { timeout: 30000 }, async t => {
  const f = await fixture(t, { consultBeforeBlueprint: true, failConsultation: true });
  await assert.rejects(f.run(), /模型输出额度已用完/);
  const first = await f.designer.get(f.definition.id);
  assert.equal(first!.status, "failed");
  const before = objectFields(first!.designProgressCheckpoint), advice = recordArray(before.consultations)[0]!;
  assert.equal(advice.modelCalls, 1); assert.equal(advice.result, null);
  assert.equal(before.modelCalls, 2);
  const savedSession = objectFields(advice.sessionRef).file;
  await f.reload();
  const result = await f.run();
  assert.equal(result.status, "passed");
  const after = objectFields(result.designProgressCheckpoint);
  assert.equal(recordArray(after.consultations)[0]!.modelCalls, 2);
  assert.equal(after.modelCalls, 6);
  const children = f.sessions.filter(row => objectFields(row.options.sessionStorage?.binding).stage === "consultation");
  assert.equal(children.length, 2);
  assert.equal(children[1]!.options.sessionStorage!.file, savedSession);
  assert.deepEqual(children[0]!.options.sessionStorage!.binding, children[1]!.options.sessionStorage!.binding);
  assert.equal(f.requests.filter(row => row.kind === "consultation").length, 2);
  const resumedBlueprint = users(f.requests.filter(row => row.kind === "blueprint").at(-1)!.body).at(-1)!;
  assert.equal(recordArray(resumedBlueprint.consultations).length, 1);
  assert.equal(recordArray(resumedBlueprint.consultations)[0]!.trust, "advisory-not-verified");
  assert.deepEqual(recordArray(resumedBlueprint.consultations)[0]!.result, {
    handoffText: "建议保留需求并使用已有能力，实际效果仍待验收。", references: [{ section: "requirements", pointer: "/0" }],
  });
  const modulePacket = users(f.requests.find(row => row.kind === "module")!.body).find(row => row.assignment)!;
  const assignment = objectFields(modulePacket.assignment);
  assert.deepEqual(Object.keys(assignment).sort(), ["dependsOn", "handoffText", "id", "requirementIds"]);
  assert.ok(typeof assignment.handoffText === "string" && assignment.handoffText.includes("完整摘要"));
  assert.equal(JSON.stringify(modulePacket).split(assignment.handoffText).length, 2, "本节点正文只内联一次");
  assert.deepEqual(f.errors, []);
});

test("显式重开只准备待启动记录，手动运行从新蓝图开始且中断恢复不会取回旧方案", { timeout: 30000 }, async t => {
  const f = await fixture(t, { rejectReview: true });
  const rejected = await f.run();
  assert.equal(rejected.status, "needs_changes");
  const original = await f.designer.getVersion(f.definition.id, rejected.version);
  const history = structuredClone([...f.designer.records.values()]);
  const requestCount = f.requests.length;
  const grant = { expectedVersion: original!.version!, expectedHash: designHash(original), authorization: "用户要求保留旧结果，从架构起点手动测试。" };
  await assert.rejects(f.designer.prepareRestart(f.definition.id, { ...grant, expectedHash: "stale" }), /原始版本已变化/u);
  await assert.rejects(f.designer.prepareRestart(f.definition.id, { ...grant, authorization: "" }), /明确请求/u);
  const pending = await f.designer.prepareRestart(f.definition.id, grant);
  assert.equal(pending.status, "pending");
  assert.equal(pending.design, null); assert.equal(pending.review, null);
  assert.equal(pending.designProgressCheckpoint, undefined);
  assert.equal(f.requests.length, requestCount, "准备不请求模型");
  await assert.rejects(f.designer.prepareRestart(f.definition.id, grant), /原始版本已变化/u);
  await assert.rejects(f.designer.prepareRestart(f.definition.id, { ...grant,
    expectedVersion: pending.version, expectedHash: designHash(pending) }), /已停止且未通过/u);
  await f.reload();
  assert.equal((await f.designer.get(f.definition.id))!.designRecovery!, undefined);
  assert.equal((await f.designer.get(f.definition.id))!.status!, "pending");
  assert.equal(f.requests.length, requestCount, "重启不自动执行");
  f.state.controller = new AbortController(); f.state.cancelStage = "blueprint";
  await assert.rejects(f.run());
  const stopped = await f.designer.get(f.definition.id);
  assert.deepEqual(f.requests.slice(requestCount).map(row => row.kind), ["blueprint"]);
  assert.notEqual(stopped!.designProgressCheckpoint!.pipelineId, original!.designProgressCheckpoint!.pipelineId);
  assert.equal(stopped!.designProgressCheckpoint!.modelCalls, 1);
  assert.equal(stopped!.reviewRevisionCheckpoint!, undefined);
  assert.equal(stopped!.revisionSource!, undefined);
  assert.equal(stopped!.restartSource!.preparedVersion, pending.version);
  f.state.controller = null;
  await f.reload();
  const resumed = await f.run();
  assert.equal(resumed.status, "passed");
  assert.deepEqual(f.requests.slice(requestCount).map(row => row.kind), ["blueprint", "module", "integration", "reviewer", "fidelity"]);
  assert.equal(resumed.designProgressCheckpoint!.pipelineId, stopped!.designProgressCheckpoint!.pipelineId);
  assert.equal(resumed.designProgressCheckpoint!.modelCalls, 3);
  assert.equal(resumed.revisionSource, undefined);
  for (const record of history) assert.deepEqual(await f.designer.getVersion(record.agentId, record.version), record);
  assert.deepEqual(f.errors, []);
});

test("整合耗尽后程序只完成可确定的拼装，保留原用量且仍需独立评审和范围复核", { timeout: 30000 }, async t => {
  const f = await fixture(t, { rejectIntegrationCalls: 5 });
  await assert.rejects(f.run());
  const failed = await f.designer.get(f.definition.id), start = f.requests.length;
  assert.equal(objectFields(failed!.designProgressCheckpoint!.integration).modelCalls, 5);
  assert.equal(failed!.designRecovery!.localCompletion, true);
  assert.equal(failed!.review!, null);
  const integrationRequest = f.requests.find(row => row.kind === "integration");
  assert.equal(recordArray(objectFields(integrationRequest!.body).tools).some((row) => objectFields(row.function).name === "revise_architecture_submission"), false);
  const schema = objectFields(recordArray(objectFields(integrationRequest!.body).tools).find((row) => objectFields(row.function).name === "submit_architecture_integration")!.function).parameters;
  assert.ok(objectFields(objectFields(objectFields(objectFields(objectFields(objectFields(schema).properties).updates).items).properties).path).pattern);
  await f.reload(); const passed = await f.run();
  assert.equal(passed.status, "passed");
  assert.deepEqual(f.requests.slice(start).map(row => row.kind), ["reviewer", "fidelity"]);
  assert.equal(objectFields(passed.designProgressCheckpoint!.integration).completedBy, "program");
  assert.equal(passed.designProgressCheckpoint!.modelCalls, failed!.designProgressCheckpoint!.modelCalls);
  assert.equal(objectFields(objectFields(passed.designProgressCheckpoint!.integration).sessionRef).file, objectFields(objectFields(failed!.designProgressCheckpoint!.integration).sessionRef).file);
  assert.deepEqual(passed.designProgressCheckpoint!.modules, failed!.designProgressCheckpoint!.modules);
  assert.equal(passed.design!.components.some((row) => row.id === "forbidden_rewrite"), false);
  assert.deepEqual(f.errors, []);
});

for (const damage of ["missing", "invalid"]) test(`程序恢复前仍核验原生历史，${damage}会话不创建替代历史或调用评审`, { timeout: 30000 }, async t => {
  const f = await fixture(t, { rejectIntegrationCalls: 5 }); await assert.rejects(f.run());
  const failed = await f.designer.get(f.definition.id), start = f.requests.length;
  const path = f.sessionPath(objectFields(objectFields(failed!.designProgressCheckpoint!.integration).sessionRef).file);
  if (damage === "missing") await rm(path);
  else await writeFile(path, "invalid native history\n", { mode: 0o600 });
  await f.reload(); await assert.rejects(f.run());
  assert.equal(f.requests.length, start);
  const saved = await f.designer.get(f.definition.id);
  assert.equal(objectFields(saved!.designProgressCheckpoint!.integration).result, null);
  assert.equal(saved!.designProgressCheckpoint!.modelCalls, failed!.designProgressCheckpoint!.modelCalls);
});

for (const outcome of ["success", "exhausted"]) test(`原生模块五轮提交被拒后显式局部修复${outcome}，不重跑蓝图且授权不能重领`, { timeout: 30000 }, async t => {
  const f = await fixture(t, { rejectModuleCalls: 5 });
  await assert.rejects(f.run(), (error: TestFailure) => error.diagnostic?.reason === "turn_limit");
  const failed = await f.designer.get(f.definition.id), before = f.requests.length;
  const request = failed!.designRecovery!.request, moduleFile = objectFields(objectFields(objectFields(failed!.designProgressCheckpoint!.modules)[0]).sessionRef).file;
  assert.equal(failed!.designRecovery!.status, "available");
  assert.match(fixtureString(failed!.designRecovery!.message), /结构|引用|步骤/u);
  assert.equal(objectFields(objectFields(failed!.designProgressCheckpoint!.modules)[0]).modelCalls, 5);
  await assert.rejects(f.run(), /手动授权/u);
  assert.equal((await f.designer.get(f.definition.id))!.version!, failed!.version!, "无效重试不新增失败版本");
  await assert.rejects(f.run({ architectureRepair: { ...objectFields(request), version: 99 } }), /授权/u);
  assert.equal(f.requests.length, before);
  await f.reload();
  if (outcome === "exhausted") f.state.rejectModuleCalls = 2;
  if (outcome === "success") {
    const passed = await f.run({ architectureRepair: request });
    assert.equal(passed.status, "passed");
    assert.deepEqual(f.requests.slice(before).map(row => row.kind), ["module", "integration", "reviewer", "fidelity"]);
    assert.equal(passed.designProgressCheckpoint!.modelCalls, 8);
    assert.deepEqual(passed.designProgressCheckpoint!.blueprint, failed!.designProgressCheckpoint!.blueprint);
  } else {
    await assert.rejects(f.run({ architectureRepair: request }), (error: TestFailure) => error.diagnostic?.reason === "turn_limit");
    const stopped = await f.designer.get(f.definition.id);
    assert.equal(stopped!.designRecovery!.status, "blocked");
    assert.equal(objectFields(objectFields(stopped!.designProgressCheckpoint!.modules)[0]).modelCalls, 7);
    assert.equal(stopped!.design!, null); assert.equal(stopped!.review!, null);
    const count = f.requests.length;
    await assert.rejects(f.run({ architectureRepair: request }), /授权/u);
    await assert.rejects(f.run(), /耗尽/u);
    assert.equal(f.requests.length, count);
  }
  const latest = await f.designer.get(f.definition.id);
  assert.equal(objectFields(objectFields(objectFields(latest!.designProgressCheckpoint!.modules)[0]).sessionRef).file, moduleFile);
  const resumed = users(f.requests[before]!.body).at(-1);
  assert.equal(resumed!.type, "resume_architecture_stage");
  assert.equal(resumed!.modelBudget!.used, 5); assert.equal(resumed!.modelBudget!.limit, 7);
  assert.equal(resumed!.stageRepair!.additionalCalls, 2);
  assert.ok(resumed!.rejectedSubmission?.submissionHash, "宿主从原生历史恢复被拒模块，支持仅提交局部字段");
  assert.ok(resumed!.lastSubmissionIssue);
  assert.equal(f.sessions.findLast(row => objectFields(row.options.sessionStorage?.binding).stage === "module")!.options.reasoningMode, "off");
  assert.deepEqual(f.errors, []);
});

test("真实原生节点length后重建控制器，仅恢复模块与整合并完成原独立评审和范围复核", { timeout: 30000 }, async t => {
  const f = await fixture(t, { failModule: true, legacyModuleContext: true });
  await assert.rejects(f.run());
  assert.deepEqual(f.errors, []);
  const failed = await f.designer.get(f.definition.id), checkpoint = nativeCheckpoint(failed!.designProgressCheckpoint);
  assert.equal(failed!.status!, "failed"); assert.equal(failed!.delivery!, "blocked");
  assert.equal(failed!.design!, null); assert.equal(failed!.review!, null);
  assert.ok(checkpoint.blueprint!.result); assert.equal(checkpoint.modules![0]!.result, null);
  assert.equal(checkpoint.modelCalls!, 2); assert.equal(checkpoint.modules![0]!.modelCalls, 1);
  const moduleFile = checkpoint.modules![0]!.sessionRef.file, start = f.requests.length;
  for (const entry of [checkpoint.blueprint!, checkpoint.modules![0]])
    assert.equal((await stat(f.sessionPath(entry!.sessionRef.file))).mode & 0o777, 0o600);
  assert.equal((await stat(f.sessionDirectory())).mode & 0o777, 0o700);
  await f.reload(); const passed = await f.run();
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.requests.slice(start).map(row => row.kind), ["module", "integration", "reviewer", "fidelity"]);
  assert.equal(passed.status, "passed"); assert.equal(passed.review!.verdict, "pass");
  assert.equal(passed.designProgressCheckpoint!.modelCalls, 4);
  assert.equal(objectFields(objectFields(passed.designProgressCheckpoint!.modules)[0]).modelCalls, 2);
  assert.equal(objectFields(objectFields(objectFields(passed.designProgressCheckpoint!.modules)[0]).sessionRef).file, moduleFile);
  const resumed = users(f.requests[start]!.body).at(-1);
  assert.equal(resumed!.type, "resume_architecture_stage");
  const assignment = recordArray(objectFields(checkpoint.blueprint.result).modules)[0]!;
  assert.equal(users(f.requests[1]!.body).at(-1)!.requirementScope, undefined, "旧会话首包尚未标明主责与参考范围");
  assert.deepEqual(objectFields(resumed!.requirementScope).ownedRequirementIds, assignment.requirementIds,
    "恢复必须用新消息提供当前冻结分工，不能因旧首包缺少范围标记而继续含糊交接");
  assert.equal(objectFields(resumed!.requirementScope).moduleId, assignment.id);
  assert.deepEqual(objectFields(resumed!.requirementScope).referenceOnly, []);
  assert.equal(users(f.requests[1]!.body).at(-1)!.moduleObligations, undefined);
  assert.equal(objectFields(resumed!.moduleObligations).moduleId, assignment.id);
  assert.deepEqual(objectFields(resumed!.moduleObligations).acceptanceKinds, ["success", "missing_input", "boundary"]);
  assert.deepEqual(objectFields(resumed!.moduleObligations).conditionalAcceptanceKinds, ["tool_failure"]);
  assert.equal(Object.hasOwn(resumed!, "requirements"), false); assert.equal(Object.hasOwn(resumed!, "draft"), false);
  assert.ok(text(recordArray(objectFields(f.requests[start]!.body).messages).find((message) => message.role === "user")!.content).includes('"assignment"'));
});

for (const stage of ["blueprint", "module"] as const) test(`真实${stage}正常保存后取消，重启跳过完成节点且不丢累计额度`, { timeout: 30000 }, async t => {
  const f = await fixture(t); f.state.controller = new AbortController(); f.state.cancelStage = stage;
  await assert.rejects(f.run());
  const cancelled = await f.designer.get(f.definition.id), checkpoint = nativeCheckpoint(cancelled!.designProgressCheckpoint);
  assert.equal(cancelled!.status!, "cancelled");
  assert.ok(stage === "blueprint" ? checkpoint.blueprint!.result : checkpoint.modules![0]!.result);
  assert.equal(cancelled!.design!, null); assert.equal(cancelled!.review!, null);
  const start = f.requests.length; f.state.controller = null;
  await f.reload(); const passed = await f.run();
  assert.equal(passed.status, "passed"); assert.deepEqual(f.errors, []);
  assert.deepEqual(f.requests.slice(start).map(row => row.kind), stage === "blueprint"
    ? ["module", "integration", "reviewer", "fidelity"] : ["integration", "reviewer", "fidelity"]);
  assert.equal(passed.designProgressCheckpoint!.modelCalls, 3);
});

for (const corruption of ["checkpoint", "session_missing", "session_header"]) test(`已知${corruption}损坏在恢复请求前失败，不能创建替代会话或刷新预算`, { timeout: 30000 }, async t => {
  const f = await fixture(t, { failModule: true }); await assert.rejects(f.run());
  const failed = await f.designer.get(f.definition.id), before = f.requests.length;
  if (corruption === "checkpoint") {
    failed!.designProgressCheckpoint!.hash = "0".repeat(64); await f.designer.save(failed!);
  } else {
    const file = f.sessionPath(objectFields(objectFields(objectFields(failed!.designProgressCheckpoint!.modules)[0]).sessionRef).file);
    if (corruption === "session_missing") await rm(file);
    else await writeFile(file, "malformed native session fixture\n", { mode: 0o600 });
  }
  await f.reload(); await assert.rejects(f.run());
  assert.equal(f.requests.length, before); assert.deepEqual(f.errors, []);
  const latest = await f.designer.get(f.definition.id);
  assert.equal(latest!.status!, "failed"); assert.equal(latest!.designProgressCheckpoint!.modelCalls, 2);
  assert.equal(objectFields(objectFields(latest!.designProgressCheckpoint!.modules)[0]).modelCalls, 1);
  assert.equal(designHash(objectFields(latest!.designProgressCheckpoint!.blueprint).result), objectFields(failed!.designProgressCheckpoint!.blueprint).resultHash);
});

async function exhaustedReviewFixture(t: test.TestContext) {
  const f = await fixture(t, { rejectReview: true, failRevisedReview: 1 });
  await f.run(); const source = await f.designer.get(f.definition.id);
  await assert.rejects(f.run({ architectureRepair: source!.designRecovery!.request }));
  const failed = await f.designer.get(f.definition.id);
  delete failed!.reviewRequestPolicy;
  // Replay a persisted five-call failure with saved scope rows, without making real model requests.
  failed!.diagnostic! = { stage: "architecture", role: "reviewer", phase: "evaluating", reason: "turn_limit", modelCalls: 5,
    lastSubmissionIssue: { path: "review.issues[0].candidatePaths[1]", reason: "candidate_path_missing" } };
  failed!.reviewProgressCheckpoint! = createReviewProgressCheckpoint(failed, null, 5, {
    diagnostic: { lastSubmissionIssue: failed!.diagnostic!.lastSubmissionIssue },
    parts: { candidateHash: failed!.candidateHash!, checks: [], issues: [], priorFindingDecisions: [],
      acceptanceScopeChecks: passingReview(failed!.candidateHash!, failed!.design!).acceptanceScopeChecks } })!;
  assert.ok(failed!.reviewProgressCheckpoint!);
  await f.designer.save(failed!); await f.reload();
  return f;
}

test("旧五次主评审通过普通继续恢复分项与累计用量，保存失败不派发", { timeout: 30000 }, async t => {
  const f = await exhaustedReviewFixture(t), source = (await f.designer.get(f.definition.id))!, before = f.requests.length;
  assert.equal(source.designRecovery!.status, "continuing");
  assert.equal(source.designRecovery!.request, undefined);
  const save = f.designer.storage.writeJson.bind(f.designer.storage);
  f.designer.storage.writeJson = async (id, file, data) => {
    if (file === "architecture.json") throw new Error("固定保存失败");
    return save(id, file, data);
  };
  await assert.rejects(f.run(), /固定保存失败/);
  assert.equal(f.requests.length, before);
  f.designer.storage.writeJson = save;
  const passed = await f.run();
  assert.equal(passed.status, "passed");
  assert.deepEqual(passed.designProgressCheckpoint, source.designProgressCheckpoint);
  assert.deepEqual(f.requests.slice(before).map(row => row.kind), ["reviewer", "fidelity"]);
  const payload = users(f.requests[before]!.body).find(row => row.candidateHash)!;
  assert.deepEqual(payload.modelBudget, { policy: "task_rejections", limit: null, used: 5 });
  assert.deepEqual(payload.reviewParts!.missing.acceptanceScopeChecks, []);
  assert.equal(passed.reviewProgressCheckpoint!.modelCalls, 7);
  assert.equal(passed.reviewRetryCheckpoint, undefined);
  assert.deepEqual((await f.designer.getVersion(f.definition.id, source.version))!.reviewProgressCheckpoint, source.reviewProgressCheckpoint);
});

test("修复后显式测试续评核对两级授权，保存后等待手动运行，保留7次及已保存检查", { timeout: 30000 }, async t => {
  const f = await exhaustedReviewFixture(t), initial = await f.designer.get(f.definition.id);
  // Restore the two authorized historical versions as written by the old policy.
  const source = { ...initial!, version: initial!.version + 1, reviewRetryCheckpoint: createArchitectureReviewRetry(initial) };
  const saved = initial!.reviewProgressCheckpoint!;
  source.reviewProgressCheckpoint = createReviewProgressCheckpoint(source, null, 7, { diagnostic: saved.diagnostic, parts: saved.parts });
  await f.designer.save(source); await f.reload();
  const before = f.requests.length;
  const authorization = { kind: "user_requested_test", authorizedAt: "2026-10-22T14:00:00.000Z", reason: "用户明确要求保留材料恢复测试" };
  const grant = createArchitectureReviewTestRetry(source, authorization);
  const restored = structuredClone({ ...source!, version: source!.version! + 1, reviewRetryCheckpoint: grant });
  Reflect.deleteProperty(restored, "designRecovery");
  const progress = source!.reviewProgressCheckpoint!;
  restored.reviewProgressCheckpoint = createReviewProgressCheckpoint(restored, progress.review!, progress.modelCalls!,
    { origin: progress.origin!, diagnostic: progress.diagnostic!, parts: progress.parts! });
  await f.designer.save(restored); await f.reload();
  assert.equal(f.requests.length, before);
  assert.equal((await f.designer.get(f.definition.id))!.designRecovery!.status, "continuing");
  const invalid = structuredClone(restored), { hash: _hash, ...body } = grant;
  body.previousCheckpointHash = "0".repeat(64);
  invalid.reviewRetryCheckpoint = { ...body, hash: designHash(body) };
  await f.designer.save(invalid);
  await assert.rejects(f.run(), /原始方案或检查点已变化/u);
  assert.equal(f.requests.length, before);
  await f.designer.save(restored); await f.reload();
  f.state.failRevisedReview = 6;
  for (let used = 8; used <= 13; used++) {
    await assert.rejects(f.run());
    await f.reload();
    const current = (await f.designer.get(f.definition.id))!;
    assert.equal(current.reviewProgressCheckpoint!.modelCalls, used);
    assert.equal(current.designRecovery!.status, "continuing");
    assert.equal(current.designRecovery!.request, undefined);
    assert.deepEqual(current.reviewRetryCheckpoint, grant);
  }
  const passed = await f.run();
  assert.deepEqual(f.errors, []);
  assert.equal(passed.status, "passed"); assert.equal(passed.candidateHash, source!.candidateHash!);
  assert.deepEqual(passed.design, source!.design!);
  assert.deepEqual(passed.designProgressCheckpoint, source!.designProgressCheckpoint!);
  assert.deepEqual(passed.reviewRevisionCheckpoint, source!.reviewRevisionCheckpoint!);
  assert.deepEqual(f.requests.slice(before).map(row => row.kind), [...Array(7).fill("reviewer"), "fidelity"]);
  const payload = users(f.requests[before]!.body).find((row) => row.candidateHash);
  assert.deepEqual(payload!.modelBudget, { policy: "task_rejections", limit: null, used: 7 });
  assert.equal(payload!.reviewParts!.saved, undefined);
  const reader = f.sessions.findLast(row => row.options.customTools!.some((tool: { name: string; }) => tool.name === "submit_architecture_review"))!.options;
  assert.deepEqual(await readModelContextSection(reader, "reviewParts", "/saved/acceptanceScopeChecks"), objectFields(progress.parts).acceptanceScopeChecks);
  assert.equal(passed.reviewProgressCheckpoint!.modelCalls, 15);
  assert.deepEqual(passed.reviewRetryCheckpoint, grant);
  assert.deepEqual((await f.designer.getVersion(f.definition.id, source!.version!))!.reviewProgressCheckpoint!, progress);
  assert.throws(() => createArchitectureReviewTestRetry(passed, authorization));
});

test("原生评审以短历史编号和原文路径提交，落盘完整编号且仍执行独立范围复核", { timeout: 30000 }, async t => {
  const f = await fixture(t, { rejectReview: true, useFindingSelectors: true, compactHandoffs: true });
  await f.run(); const source = await f.designer.get(f.definition.id), before = f.requests.length;
  const passed = await f.run({ architectureRepair: source!.designRecovery!.request });
  assert.deepEqual(f.errors, []); assert.equal(passed.status, "passed");
  assert.deepEqual(f.requests.slice(before).map(row => row.kind), ["review_revision", "reviewer", "fidelity"]);
  assert.ok(passed.review!.priorFindingDecisions!.length);
  assert.ok(passed.review!.priorFindingDecisions!.every((row) => row.findingId.startsWith("finding_") && !Object.hasOwn(row, "findingRef")));
  assert.ok(passed.review!.issues.every((row) => row.id && !Object.hasOwn(row, "findingRef") && row.references!.every(ref => ref.quote)));
  assert.ok(passed.requirementFidelity);
});

test("普通制作汇总子组负评后自动局部修订，重新评审及范围复核通过才交付", { timeout: 30000 }, async t => {
  const f = await fixture(t, { rejectReview: true, acceptanceCount: 13 });
  const agents = await normalBuild(t, f), progress: unknown[] = [];
  const built = await agents.build(f.definition, { onProgress: event => progress.push(event) });
  const architecture = objectFields(built.architecture);
  assert.equal(architecture.status, "passed");
  assert.equal(objectFields(built.agent).status, "ready");
  const reviewed = await f.designer.getVersion(f.definition.id, 1);
  assert.equal(reviewed!.status, "needs_changes");
  assert.notEqual(reviewed!.candidateHash, architecture.candidateHash);
  assert.deepEqual(architecture.designProgressCheckpoint, reviewed!.designProgressCheckpoint);
  assert.equal(objectFields(architecture.reviewRevisionCheckpoint).modelCalls, 1);
  const slices = readReviewTaskCheckpoint(objectFields(reviewed!.reviewDispatchCheckpoint).dispatch).groups;
  assert.ok(slices.some(group => group.result!.updates.some(update => recordArray(objectFields(objectFields(update.value).parts).checks)
    .some(check => check.id === "verification" && check.passed === false))));
  assert.ok(progress.some(event => objectFields(event).label === "主评审提出修改意见，正在修订方案并重新评审…"));
  for (const kind of ["blueprint", "module", "integration", "review_revision"])
    assert.equal(f.requests.filter(request => request.kind === kind).length, 1);
  assert.equal(f.requests.filter(request => request.kind === "reviewer").length, 2);
  assert.equal(f.requests.filter(request => request.kind === "fidelity").length, 1);
  assert.deepEqual(f.errors, []);
});

test("自动修订中断保留原负评，重启续用原会话及额度，仍有阻断时停止", { timeout: 30000 }, async t => {
  const f = await fixture(t, { rejectReview: true, failRepairCalls: 1, programBlocker: true });
  const agents = await normalBuild(t, f);
  await assert.rejects(agents.build(f.definition));
  const reviewed = await f.designer.getVersion(f.definition.id, 1), stopped = await f.designer.get(f.definition.id);
  assert.equal(reviewed!.status, "needs_changes");
  assert.equal(stopped!.status, "failed");
  assert.equal(stopped!.reviewRevisionCheckpoint!.modelCalls, 2);
  const groups = recordArray(objectFields(stopped!.reviewRevisionCheckpoint!.dispatch).groups);
  assert.equal(groups.filter(group => group.result).length, 1);
  await agents.close(); await f.reload();
  const restarted = new PrototypeAgents({ config: f.config, cwd: f.root, dataDir: f.dataDir, architecture: f.designer });
  await restarted.ready; t.after(() => restarted.close());
  const result = await restarted.build(f.definition);
  assert.equal(result.architecture!.status, "needs_changes");
  assert.equal(result.agent, null);
  assert.equal(result.architecture!.reviewRevisionCheckpoint!.modelCalls, 3);
  const resumedGroups = recordArray(objectFields(result.architecture!.reviewRevisionCheckpoint!.dispatch).groups);
  for (const group of groups) {
    const resumed = resumedGroups.find(row => row.id === group.id)!;
    assert.equal(resumed.sessionFile, group.sessionFile);
    if (group.result) assert.deepEqual(resumed, group);
  }
  const start = f.requests.length;
  await assert.rejects(restarted.build(f.definition));
  assert.equal(f.requests.length, start);
  assert.equal((await f.designer.getVersion(f.definition.id, 1))!.status, "needs_changes");
  assert.deepEqual(f.errors, []);
});

test("真实独立评审完成后显式局部修订，不重跑原节点，候选变化后重新评审及范围复核", { timeout: 30000 }, async t => {
  const f = await fixture(t, { rejectReview: true });
  const reviewed = await f.run();
  assert.equal(reviewed.status, "needs_changes");
  const failed = await f.designer.get(f.definition.id), before = f.requests.length;
  const saved = structuredClone(failed!.designProgressCheckpoint!);
  assert.equal(failed!.designRecovery!.actionLabel, "按评审修订（最多3轮）");
  await assert.rejects(f.run(), /局部修订/u);
  assert.equal(f.requests.length, before);
  await f.reload();
  const passed = await f.run({ architectureRepair: failed!.designRecovery!.request });
  assert.deepEqual(f.errors, []);
  assert.equal(passed.status, "passed"); assert.equal(passed.attempts.length, 1);
  assert.deepEqual(f.requests.slice(before).map(row => row.kind), ["review_revision", "reviewer", "fidelity"]);
  for (const kind of ["blueprint", "module", "integration", "review_revision", "reviewer"]) {
    const request = f.requests.find(row => row.kind === kind);
    assert.ok(request, `实际调用应覆盖${kind}`);
    const prompt = recordArray(objectFields(request.body).messages).filter((message) => ["system", "developer"].includes(fixtureString(message.role)))
      .map((message) => text(message.content)).join("\n");
    assert.match(prompt, /单纯待验收的效果保留在unknowns及适用的acceptance或后续验证义务中/, `${kind}应收到分类规则`);
    assert.match(prompt, /真实缺失的必需引擎、浏览器自动执行工具、接口或权限仍须阻断/);
  }
  assert.notEqual(reviewed.candidateHash, passed.candidateHash);
  assert.deepEqual(passed.designProgressCheckpoint, saved);
  assert.equal(passed.reviewRevisionCheckpoint!.modelCalls, 1);
  await assert.rejects(f.run({ architectureRepair: failed!.designRecovery!.request }), /授权已过期/u);
});

test("评审修订截断后原生会话与三轮总账续接，三次耗尽拒绝重复授权", { timeout: 30000 }, async t => {
  const f = await fixture(t, { rejectReview: true, failRevisionCalls: 3 });
  await f.run(); const source = await f.designer.get(f.definition.id), request = source!.designRecovery!.request;
  let file;
  for (let used = 1; used <= 3; used++) {
    await assert.rejects(f.run(used === 1 ? { architectureRepair: request } : {}));
    const stopped = await f.designer.get(f.definition.id);
    const checkpoint = stopped!.reviewRevisionCheckpoint!;
    file ??= objectFields(checkpoint.sessionRef).file;
    assert.equal(objectFields(checkpoint.sessionRef).file, file); assert.equal(checkpoint.modelCalls!, used);
    assert.deepEqual(stopped!.designProgressCheckpoint!, source!.designProgressCheckpoint!);
    await f.reload();
  }
  const start = f.requests.length;
  await assert.rejects(f.run()); await assert.rejects(f.run({ architectureRepair: request }));
  assert.equal(f.requests.length, start);
  assert.equal((await f.designer.get(f.definition.id))!.designRecovery!.status, "blocked");
  assert.deepEqual(f.errors, []);
});

test("修订候选仍有程序阻断时评审中断，重启保留该候选的实际评审用量", { timeout: 30000 }, async t => {
  const f = await fixture(t, { rejectReview: true, failRevisedReview: 1, programBlocker: true });
  await f.run(); const source = await f.designer.get(f.definition.id);
  await assert.rejects(f.run({ architectureRepair: source!.designRecovery!.request }));
  const stopped = await f.designer.get(f.definition.id), before = f.requests.length;
  assert.ok(stopped!.issues!.some(item => item.blocking));
  assert.equal(stopped!.reviewProgressCheckpoint!.modelCalls, 1);
  await f.reload(); const result = await f.run();
  const payload = users(f.requests[before]!.body).find((row) => row.design);
  assert.equal(payload!.modelBudget!.used, stopped!.reviewProgressCheckpoint!.modelCalls, "原生请求发送前的提示保留已用次数");
  assert.equal(result.reviewProgressCheckpoint!.modelCalls, stopped!.reviewProgressCheckpoint!.modelCalls + 2, "续接的一次评审和一次范围复核追加到原计数");
  assert.equal(result.reviewRevisionCheckpoint!.modelCalls, stopped!.reviewRevisionCheckpoint!.modelCalls, "恢复独立评审不得重跑已保存的修复子组");
  assert.equal(result.status, "needs_changes", "程序阻断不能被独立评审pass绕过");
  assert.equal((await f.designer.get(f.definition.id))!.designRecovery!.status, "blocked");
  assert.deepEqual(f.requests.slice(before).map(row => row.kind), ["reviewer", "fidelity"]);
  assert.deepEqual(f.errors, []);
});

test("首次评审修订授权保存失败不产生无入口的失败版本，可按原授权重试", { timeout: 30000 }, async t => {
  const f = await fixture(t, { rejectReview: true }); await f.run();
  const source = await f.designer.get(f.definition.id), originalSave = f.designer.save.bind(f.designer), before = f.requests.length;
  let failed = false;
  f.designer.save = async record => {
    if (!failed && record.reviewRevisionCheckpoint) { failed = true; throw new Error("首次授权保存失败"); }
    return originalSave(record);
  };
  await assert.rejects(f.run({ architectureRepair: source!.designRecovery!.request }), /首次授权保存失败/u);
  assert.equal((await f.designer.get(f.definition.id))!.version!, source!.version!);
  assert.equal(f.requests.length, before);
  const passed = await f.run({ architectureRepair: source!.designRecovery!.request });
  assert.equal(passed.status, "passed"); assert.equal(passed.reviewRevisionCheckpoint!.modelCalls, 1);
});

test("真实修复子会话截断后只续接未完成组，已提交组及原调用账本保留", { timeout: 30000 }, async t => {
  const f = await fixture(t, { rejectReview: true, programBlocker: true, failRepairCalls: 1 });
  await f.run(); const source = await f.designer.get(f.definition.id);
  await assert.rejects(f.run({ architectureRepair: source!.designRecovery!.request }));
  const stopped = await f.designer.get(f.definition.id), checkpoint = stopped!.reviewRevisionCheckpoint!;
  assert.equal(checkpoint.schemaVersion, 2);
  const dispatch = objectFields(checkpoint.dispatch), groups = recordArray(dispatch.groups);
  assert.equal(groups.filter(group => group.result).length, 1);
  assert.equal(checkpoint.modelCalls, 2);
  const before = f.requests.filter(request => request.kind === "repair").length;
  await f.reload(); const resumed = await f.run();
  assert.equal(f.requests.filter(request => request.kind === "repair").length, before + 1);
  assert.equal(resumed.reviewRevisionCheckpoint!.modelCalls, 3);
  assert.equal(resumed.status, "needs_changes", "原程序阻断仍须真实处理，不能因子组已提交而通过");
  assert.deepEqual(f.errors, []);
});

for (const legacy of [false, true]) test(`评审后追加检索资料仍能完整修订和复评，${legacy ? "旧记录按精确历史目录恢复" : "新记录使用冻结目录"}`, { timeout: 30000 }, async t => {
  const f = await fixture(t, { rejectReview: true });
  if (legacy) {
    f.state.controller = new AbortController(); f.state.cancelStage = "blueprint";
    await assert.rejects(f.run()); await f.reload(); f.state.controller = null;
  }
  await f.run();
  const source = await f.designer.get(f.definition.id), frozen = structuredClone(source!.evidence!);
  assert.deepEqual(source!.reviewEvidence!.frozenEvidence, frozen);
  if (legacy) {
    Reflect.deleteProperty(source!.reviewEvidence!, "frozenEvidence");
    Reflect.deleteProperty(objectFields(source!.attempts!.at(-1)!.reviewEvidence), "frozenEvidence");
  }
  source!.evidence!.push({ id: "later-research", title: "评审后保存的固定检索资料", url: "https://example.test/late-source",
    versionScope: "本地模拟，非真实联网结果", excerpt: "新增资料只用于新修订，不改变旧评审来源。" });
  source!.researchGaps!.push("保留评审后的检索缺口"); source!.designResearchCalls! = 2;
  source!.designProgressEvidenceHash! = designHash({ evidence: source!.evidence!, researchGaps: source!.researchGaps!, designResearchCalls: 2 });
  await f.designer.save(source!); await f.reload();
  const current = await f.designer.get(f.definition.id), before = f.requests.length;
  const originalHash = designHash(await f.designer.getVersion(f.definition.id, source!.version!));
  const passed = await f.run({ architectureRepair: current!.designRecovery!.request });
  assert.equal(passed.status, "passed");
  assert.deepEqual(f.requests.slice(before).map(row => row.kind), ["review_revision", "reviewer", "fidelity"]);
  const payload = users(f.requests[before]!.body).find((row) => row.pipelineStage === "review_revision");
  assert.equal(payload!.evidence, undefined);
  assert.deepEqual(payload!.evidenceCatalog!.map((row) => row.id), source!.evidence!.map(row => row.id));
  const reader = f.sessions.findLast(row => row.options.customTools!.some((tool: { name: string; }) => tool.name === "submit_architecture_review"))!.options;
  assert.deepEqual(await readModelContextSection(reader, "evidence"), source!.evidence!);
  assert.deepEqual(passed.evidence, source!.evidence!); assert.deepEqual(passed.researchGaps, source!.researchGaps!);
  assert.equal(passed.designResearchCalls, 2); assert.equal(passed.reviewRevisionCheckpoint!.modelCalls, 1);
  assert.deepEqual(passed.designProgressCheckpoint, source!.designProgressCheckpoint!);
  assert.deepEqual(passed.reviewEvidence!.frozenEvidence, source!.evidence!);
  assert.equal(designHash(await f.designer.getVersion(f.definition.id, source!.version!)), originalHash);
  assert.deepEqual(f.errors, []);
});

test("阶段成果首次落盘瞬时失败，失败兜底不能补存未接受成果且恢复沿原会话计数", { timeout: 30000 }, async t => {
  const f = await fixture(t), save = f.designer.save.bind(f.designer); let rejected = false;
  f.designer.save = async record => {
    if (!rejected && Array.isArray(record.designProgressCheckpoint?.modules) && recordArray(record.designProgressCheckpoint.modules).some((entry) => entry.result !== null)) {
      rejected = true; throw new Error("固定模块成果第一次落盘失败");
    }
    return save(record);
  };
  await assert.rejects(f.run());
  assert.equal(rejected, true); assert.deepEqual(f.errors, []);
  assert.deepEqual(f.requests.map(row => row.kind), ["blueprint", "module"]);
  const failed = await f.designer.get(f.definition.id), checkpoint = nativeCheckpoint(failed!.designProgressCheckpoint);
  assert.equal(failed!.status!, "failed"); assert.equal(failed!.design!, null); assert.equal(failed!.review!, null);
  assert.ok(checkpoint.blueprint!.result); assert.equal(checkpoint.modules![0]!.result, null);
  assert.equal(checkpoint.modules![0]!.resultHash, null); assert.equal(checkpoint.integration!.result, null);
  assert.equal(checkpoint.modelCalls!, 2); assert.equal(checkpoint.modules![0]!.modelCalls, 1);
  const moduleFile = checkpoint.modules![0]!.sessionRef.file, start = f.requests.length;
  await f.reload(); const passed = await f.run();
  assert.equal(passed.status, "passed"); assert.deepEqual(f.errors, []);
  assert.deepEqual(f.requests.slice(start).map(row => row.kind), ["module", "integration", "reviewer", "fidelity"]);
  assert.equal(passed.designProgressCheckpoint!.modelCalls, 4);
  assert.equal(objectFields(objectFields(passed.designProgressCheckpoint!.modules)[0]).modelCalls, 2);
  assert.equal(objectFields(objectFields(objectFields(passed.designProgressCheckpoint!.modules)[0]).sessionRef).file, moduleFile);
  assert.equal(users(f.requests[start]!.body).at(-1)!.type, "resume_architecture_stage");
});

test("蓝图检索成功后取消，重启原阶段保留检索次数与证据摘要，不重开检索预算", { timeout: 30000 }, async t => {
  const f = await fixture(t, { researchBeforeBlueprint: true });
  f.state.controller = new AbortController(); f.state.cancelStage = "research";
  await assert.rejects(f.run());
  assert.deepEqual(f.errors, []); assert.equal(f.researchCalls.length, 1);
  const cancelled = await f.designer.get(f.definition.id), checkpoint = nativeCheckpoint(cancelled!.designProgressCheckpoint);
  assert.equal(cancelled!.status!, "cancelled"); assert.equal(cancelled!.designResearchCalls!, 1);
  assert.equal(checkpoint.blueprint!.result, null); assert.equal(checkpoint.blueprint!.modelCalls, 1);
  assert.equal(checkpoint.modelCalls!, 1); assert.equal(cancelled!.design!, null); assert.equal(cancelled!.review!, null);
  assert.ok(cancelled!.evidence!.some((source) => source.id === "fixed-sdk-source"));
  const expectedEvidenceHash = designHash({ evidence: cancelled!.evidence!, researchGaps: cancelled!.researchGaps!, designResearchCalls: 1 });
  assert.equal(cancelled!.designProgressEvidenceHash!, expectedEvidenceHash);
  const start = f.requests.length, file = checkpoint.blueprint!.sessionRef.file;
  f.state.controller = null; await f.reload(); const passed = await f.run();
  assert.equal(passed.status, "passed"); assert.deepEqual(f.errors, []);
  assert.deepEqual(f.requests.slice(start).map(row => row.kind), ["blueprint", "module", "integration", "reviewer", "fidelity"]);
  assert.equal(users(f.requests[start]!.body).at(-1)!.type, "resume_architecture_stage");
  assert.equal(objectFields(objectFields(passed.designProgressCheckpoint!.blueprint).sessionRef).file, file);
  assert.equal(objectFields(passed.designProgressCheckpoint!.blueprint).modelCalls, 2);
  assert.equal(passed.designProgressCheckpoint!.modelCalls, 4);
  assert.equal(passed.designResearchCalls, 1); assert.equal(f.researchCalls.length, 1);
  assert.equal(passed.designProgressEvidenceHash, expectedEvidenceHash);
  assert.deepEqual(passed.evidence, cancelled!.evidence!);
});
