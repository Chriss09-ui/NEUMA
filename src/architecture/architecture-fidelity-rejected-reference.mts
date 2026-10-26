import type { PiSessionPort, SessionMessage } from "../runtime/execution-port.mjs";
import { objectFields, isInteger, isArray } from "../runtime/type-boundary.mjs";
import { architectureTurnBudgetSpent, designHash, validateReview } from "./architecture-contract.mjs";
import { copyArchitectureReviewJson as jsonCopy, architectureReviewRecordBinding as recordBinding,
  reviewCheckpointOwn as own } from "./architecture-review-binding.mjs";
import { architectureReviewEvidenceContext } from "./architecture-review-evidence.mjs";
import { readMainReviewCheckpoint } from "./architecture-main-review-checkpoint.mjs";
import { readArchitectureFidelityProgress } from "./architecture-fidelity-progress.mjs";
import { readReviewProgressCheckpoint } from "./architecture-review-progress.mjs";
import { validateArchitecturePriorFindings } from "./architecture-prior-findings.mjs";
import { diagnoseRequirementFidelitySubmission } from "./requirement-fidelity.mjs";
import { readExecutionHistory } from "../runtime/execution-history.mjs";
import { architectureFidelityContextVersion, architectureRecordFidelityContext } from "./architecture-fidelity-context.mjs";
import { copyFidelityReviewEvidenceContext } from "./architecture-fidelity-revision.mjs";

const TOOL = "submit_requirement_fidelity";
const feedbackCore = (input: unknown) => { const value = objectFields(input); return value && value.valid === false && ["schema", "semantic"].some(stage => stage === value.stage)
  && isInteger(value.total) && value.total > 0 && typeof value.truncated === "boolean" && isArray(value.issues)
  && value.issues.length > 0 && value.issues.length <= value.total && (value.truncated || value.issues.length === value.total)
  ? { valid: false, stage: value.stage, total: value.total, truncated: value.truncated,
    issues: value.issues.map(input => { const { path, reason } = objectFields(input); return { path, reason }; }) } : null; };

function sameFeedback(saved: unknown, current: unknown) {
  const old = feedbackCore(saved), next = feedbackCore(current);
  return old && next && old.stage === next.stage && old.total === next.total && old.issues.length <= next.issues.length
    && old.issues.every((issue, index) => designHash(issue) === designHash(next.issues[index]));
}

function rejectedReceipt(input: unknown) {
  const message = objectFields(input);
  if (message.isError !== true || !Array.isArray(message.content) || message.content.length !== 1 || message.content[0]?.type !== "text") return null;
  const text = message.content[0].text;
  if (typeof text !== "string") return null;
  const prefix = "范围复核提交未通过当前校验：";
  try {
    const value = JSON.parse(text.startsWith(prefix) ? text.slice(prefix.length) : text);
    return value.submitted === true ? null : feedbackCore(value) ? value : null;
  } catch { return null; }
}

function localBudgetStop(input: unknown) {
  const message = objectFields(input), usage = objectFields(message.usage);
  return message.role === "assistant" && message.stopReason === "error" && message.errorMessage === "NEUMA_MODEL_CALL_BLOCKED"
    && Array.isArray(message.content) && message.content.length === 0 && usage && usage.totalTokens === 0
    && ["input", "output", "cacheRead", "cacheWrite"].every((key) => usage[key] === 0)
    && (usage.reasoning === undefined || usage.reasoning === 0)
    && usage.cost && Object.values(objectFields(usage.cost)).every((value) => value === 0);
}

function textMessage(message: SessionMessage) {
  return typeof message.content === "string" ? message.content : message.content?.length === 1 && message.content[0]?.type === "text" ? message.content[0].text : null;
}

/** A genuine rejected call is only editing material; it grants no decision or new budget. */
export async function readArchitectureRejectedFidelityReference(record: unknown, evidenceInput: unknown, { cwd, directory, signal }: { cwd?: string; directory?: string; signal?: AbortSignal | undefined } = {}) {
  try {
    signal?.throwIfAborted();
    let evidenceContext = evidenceInput;
    const binding = recordBinding(record), checkpoint = readMainReviewCheckpoint(record), progress = readArchitectureFidelityProgress(record);
    if (!binding || !checkpoint || checkpoint.fidelityStatus !== "pending" || !progress || !architectureTurnBudgetSpent(progress.parentModelCalls)
      || !["failed", "cancelled"].some(status => status === own(record, "status")) || own(record, "review") != null || own(record, "requirementFidelity") != null
      || !evidenceContext || progress.state.calls < 1) return null;
    if (own(record, "reviewProgressCheckpoint") !== undefined && !readReviewProgressCheckpoint(record)) return null;
    evidenceContext = copyFidelityReviewEvidenceContext(evidenceContext);
    const snapshot = objectFields(jsonCopy(objectFields(own(record, "reviewEvidence")).snapshot)), guide = snapshot?.acceptanceAdapterGuide;
    const expected = architectureReviewEvidenceContext({ design: jsonCopy(own(record, "design")), requirements: jsonCopy(own(record, "requirements")),
      runtimeCapabilities: jsonCopy(own(record, "runtimeCapabilities") ?? null), evidence: jsonCopy(own(record, "evidence") ?? []),
      confirmedRequirementContext: jsonCopy(own(record, "confirmedRequirementContext") ?? null), deferredVerifications: jsonCopy(own(record, "deferredVerifications") ?? null),
      acceptanceAdapterGuide: guide });
    const snapshotBody = { version: 1, candidateHash: binding.source.candidateHash, platformHash: own(record, "platformHash"),
      acceptanceAdapterGuide: guide, contextManifest: expected.contextManifest };
    if (designHash(evidenceContext) !== designHash(expected) || designHash(snapshot) !== designHash({ ...snapshotBody, hash: designHash(snapshotBody) })
      || objectFields(own(record, "reviewEvidence")).version !== 2 || objectFields(own(record, "reviewEvidence")).snapshotHash !== snapshot.hash) return null;
    validateArchitecturePriorFindings(validateReview(checkpoint.review, { candidateHash: binding.source.candidateHash,
      schemaVersion: objectFields(own(record, "design")).schemaVersion as number | undefined, evidenceContext }), own(record, "priorFindings"), own(record, "design"), { evidenceContext });
    const contextVersion = architectureFidelityContextVersion(progress.state);
    const context = architectureRecordFidelityContext(record, expected, { contextVersion });
    const state = progress.state, diagnostic = state.diagnostic;
    const contract = diagnoseRequirementFidelitySubmission(context, null, { schemaHash: state.schemaHash });
    if (state.contextHash !== contract.contextHash || state.schemaHash !== contract.schemaHash || diagnostic.schemaVersion !== 1
      || diagnostic.contextVersion !== contextVersion || diagnostic.contextHash !== contract.contextHash || diagnostic.modelCalls !== state.calls || diagnostic.resultAvailable === true
      || !isInteger(diagnostic.submissionAttempts) || diagnostic.submissionAttempts < 1
      || ["schemaRejections", "semanticRejections"].some((key) => !isInteger(diagnostic[key]) || diagnostic[key] < 0)
      || !feedbackCore(diagnostic.lastSubmission)) return null;
    const native = await readExecutionHistory({ cwd: cwd!, ...(signal ? { signal } : {}), storage: { directory: directory!, file: state.sessionFile,
      binding: { version: 1, role: "requirement-fidelity", agentId: binding.source.agentId, candidateHash: binding.source.candidateHash,
        parentBindingHash: checkpoint.bindingHash, reviewHash: checkpoint.reviewHash, contextHash: state.contextHash, schemaHash: state.schemaHash,
        ...(contextVersion ? { contextVersion } : {}) } } });
    if (native.bindingHash !== state.sessionBindingHash) return null;
    const messages = native.entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
    const expectedUser = designHash({ ...context, contextHash: contract.contextHash });
    let original = 0;
    for (const message of messages) {
      if (message.role !== "user") { if (original !== 1 && message.role !== "system") return null; continue; }
      const text = textMessage(message);
      let payload; try { payload = JSON.parse(text!); } catch { return null; }
      if (designHash(payload) === expectedUser) { if (original !== 0) return null; original++; }
      else if (original !== 1 || !payload || payload.contextHash !== contract.contextHash || Object.keys(payload).some((key) => !["contextHash", "correction", "lastSubmission", "remainingModelCalls"].includes(key))) return null;
    }
    if (original !== 1 || messages.some((message) => message.role === "toolResult" && message.toolName === TOOL && message.isError !== true)) return null;
    const usable = messages.filter((message) => !localBudgetStop(message)), assistantIndex = usable.findLastIndex((message) => message.role === "assistant");
    const assistant = usable[assistantIndex], calls = assistant?.role === "assistant" && Array.isArray(assistant.content) ? assistant.content.filter((part) => part.type === "toolCall") : undefined;
    if (assistant?.role !== "assistant" || assistant.stopReason !== "toolUse" || calls?.length !== 1 || calls[0]!.name !== TOOL || typeof calls[0]!.id !== "string") return null;
    const call = calls[0]!, receipts = usable.filter((message) => message.role === "toolResult" && message.toolCallId === call.id);
    if (usable.flatMap((message) => message.role === "assistant" && Array.isArray(message.content) ? message.content.filter((part) => part.type === "toolCall" && part.id === call.id) : []).length !== 1
      || receipts.length !== 1 || objectFields(receipts[0]).toolName !== TOOL || usable.indexOf(receipts[0]!) <= assistantIndex) return null;
    const feedback = rejectedReceipt(receipts[0]), submission = jsonCopy(call.arguments, { maxBytes: 256 * 1024 });
    const checked = diagnoseRequirementFidelitySubmission(context, submission, { schemaHash: state.schemaHash });
    if (checked.valid || !feedback || !sameFeedback(feedback, checked) || !sameFeedback(diagnostic.lastSubmission, checked)
      || designHash(feedbackCore(feedback)) !== designHash(feedbackCore(diagnostic.lastSubmission))) return null;
    signal?.throwIfAborted();
    return { trust: "untrusted-technical-reference", source: { ...binding.source, bindingHash: binding.bindingHash, reviewHash: checkpoint.reviewHash,
      contextHash: checked.contextHash, schemaHash: checked.schemaHash, contextManifestHash: designHash(expected.contextManifest),
      acceptanceAdapterGuideHash: designHash(guide), sessionBindingHash: native.bindingHash, sessionHash: native.sessionHash,
      toolCallId: call.id, submissionHash: designHash(submission), diagnosticHash: designHash(checked) },
    modelCalls: progress.parentModelCalls, fidelityModelCalls: state.calls, submission, diagnostic: checked };
  } catch { signal?.throwIfAborted(); return null; }
}
