import { basename } from "node:path";
import type { AgentStoragePort } from "../runtime/storage-port.mjs";
import type { SessionStorage } from "../runtime/execution-port.mjs";
import type { FormatIssue, FormatRecovery } from "../runtime/format-recovery.mjs";
import { createFormatRecovery, readFormatRecovery, noteFormatRejection, resolveFormatRecovery,
  formatCorrectionFeedback, formatRecoveryExhausted, deliverFormatFeedback } from "../runtime/format-recovery.mjs";
import { InputError } from "../requirements/core.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import { designHash } from "./architecture-contract.mjs";

interface ReadCheckpoint {
  version: 1; bindingHash: string; modelCalls: number; correctionCalls: number;
  recovery: FormatRecovery; sessionFile?: string; hash: string;
}
export function architectureReadRecoveryBinding(role: string, agentId: string | undefined, submitName: string,
  payload: Record<string, unknown>, existing?: SessionStorage, version?: number) {
  return { version: 1, agentId: agentId ?? null, role, submitName,
    sourceHash: designHash(existing?.binding ?? {
      version: payload.previousDesign ? null : version ?? null,
      requirements: payload.requirements ?? null, candidate: payload.candidateHash ?? payload.previousDesign ?? payload.design ?? null,
      platformHash: payload.platformHash ?? null, runtimeCapabilities: payload.runtimeCapabilities ?? null,
      confirmedRequirementContext: payload.confirmedRequirementContext ?? null, deferredVerifications: payload.deferredVerifications ?? null,
      developmentRunId: objectFields(payload.revisionSource).developmentRunId ?? null,
      pipelineStage: payload.pipelineStage ?? null, assignment: payload.assignment ?? null,
    }) };
}

/** Persist read corrections separately from formal content rejection counters. */
export async function architectureReadRecovery(storage: AgentStoragePort, agentId: string | undefined,
  binding: ReturnType<typeof architectureReadRecoveryBinding>, existing?: SessionStorage) {
  const bindingHash = designHash(binding), file = `architecture-read-recovery/${bindingHash}.json`;
  const saved = agentId ? await storage.readJson(agentId, file, { maxBytes: 1024 * 1024 }) : null;
  let state: ReadCheckpoint;
  if (saved) {
    const value = objectFields(saved), { hash, ...body } = value;
    if (value.version !== 1 || value.bindingHash !== bindingHash || hash !== designHash(body)
      || !Number.isSafeInteger(value.modelCalls) || Number(value.modelCalls) < 0
      || !Number.isSafeInteger(value.correctionCalls) || Number(value.correctionCalls) < 0 || Number(value.correctionCalls) > Number(value.modelCalls)
      || value.sessionFile !== undefined && (typeof value.sessionFile !== "string" || !/^[A-Za-z0-9_.-]+\.jsonl$/u.test(value.sessionFile)))
      throw new InputError("读取纠正记录或来源绑定无效，不能重领机会。");
    readFormatRecovery(value.recovery);
    state = structuredClone(saved) as ReadCheckpoint;
  } else state = { version: 1, bindingHash, modelCalls: 0, correctionCalls: 0, recovery: createFormatRecovery(), hash: "" };
  if (existing?.file && state.sessionFile && existing.file !== state.sessionFile) throw new InputError("读取纠正记录对应其他原生会话。");
  const sessionStorage = existing ?? (agentId ? {
    directory: await storage.directory(agentId, "architecture-read-recovery/sessions", { create: true }), binding,
    ...(state.sessionFile ? { file: state.sessionFile } : {}),
  } : undefined);
  let persistenceError: unknown;
  const guard = () => { if (persistenceError) throw persistenceError; };
  const persist = async () => {
    guard(); const { hash: _hash, ...body } = state; state.hash = designHash(body);
    try { if (agentId) await storage.writeJson(agentId, file, state); }
    catch (error) {
      persistenceError = Object.assign(new InputError("读取纠正记录保存失败，已阻止后续请求；不能作为参数错误重试。"), {
        cause: error, diagnostic: { stage: "architecture", reason: "read_recovery_persistence" },
      });
      throw persistenceError;
    }
  };
  const feedback = () => formatCorrectionFeedback(state.recovery);
  return {
    sessionStorage,
    snapshot: () => structuredClone(state),
    feedback,
    extraCalls: () => state.correctionCalls + (feedback() ? 3 : 0),
    assertActive: () => {
      guard(); const exhausted = formatRecoveryExhausted(state.recovery);
      if (exhausted) throw Object.assign(new InputError("读取参数在明确反馈后已实际纠正三次，仍未通过；原会话及次数保留。"), {
        diagnostic: { stage: "architecture", reason: "read_input_correction_limit", counting: "corrections_after_feedback",
          attempts: 3, toolName: exhausted.toolName, issues: exhausted.failures.at(-1)!.issues },
      });
    },
    saveSession: async (sessionFile: string) => {
      const name = basename(sessionFile);
      if (state.sessionFile && state.sessionFile !== name) throw new InputError("不能替换读取纠正任务的原生会话。");
      state.sessionFile = name; await persist();
    },
    requested: async (turn: number, retryAttempt: number, feedbackId: string | undefined) => {
      state.modelCalls = Math.max(state.modelCalls, turn);
      if (!retryAttempt && feedbackId && feedback()?.feedbackId === feedbackId) state.correctionCalls++;
      deliverFormatFeedback(state.recovery, turn, feedbackId); await persist();
    },
    rejected: async (toolName: string, callId: string, turn: number, issues: FormatIssue[]) => {
      if (noteFormatRejection(state.recovery, toolName, turn, designHash({ toolName, callId, turn }), issues)) await persist();
    },
    accepted: async (toolName: string, turn: number, submitted = false) => {
      if (resolveFormatRecovery(state.recovery, toolName, turn, submitted)) await persist();
    },
  };
}
