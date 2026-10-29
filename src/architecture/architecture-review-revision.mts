import type { UnknownRecord } from "../contracts/json.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import type { ArchitectureDesign, ArchitectureIssue, ReviewDiagnosticIssue } from "../contracts/architecture.mjs";
import type { SessionStorage } from "../runtime/execution-port.mjs";
import { objectFields, isInteger, isArray, isRecord } from "../runtime/type-boundary.mjs";
import { createRepairCheckpoint, readRepairCheckpoint, runRepairSchedule, repairHash } from "../runtime/repair-scheduler.mjs";
import type { RepairCheckpoint, RepairWorker, RepairIssue } from "../runtime/repair-scheduler.mjs";
interface RevisionSource { version: number; candidateHash: string; reviewHash: string; issuesHash: string; progressHash: string; pipelineId: string; modelCalls: number }
export type ReviewRevisionCheckpoint = { schemaVersion: 1 | 2; schemaHash: string; bindingHash: string; source: RevisionSource;
  dispatch?: RepairCheckpoint; modelCalls: number; sessionRef: { file: string } | null; result: unknown; resultHash: string | null; hash: string }
interface RetrySource { version: number; candidateHash: string; progressHash: string; modelCalls: number }
type RevisionIssue = UnknownRecord & { blocking: unknown; candidatePaths?: string[]; candidateFields?: string[] };
interface TestAuthorization { kind: "user_requested_test"; reason: string; authorizedAt: string }
export type ReviewRetryCheckpoint = { bindingHash: string; additionalCalls: number; source: RetrySource; hash: string } & (
  { schemaVersion: 1; previousCheckpointHash?: never; authorization?: never } |
  { schemaVersion: 2; previousCheckpointHash: string; authorization: TestAuthorization } |
  { schemaVersion: 3; previousCheckpointHash: string; authorization?: never });
export interface ReviewRevisionRole { parameters: ToolSchema; validate(value: unknown): ArchitectureDesign; candidate: ArchitectureDesign; issues: RevisionIssue[];
  baseHash: string; allowedRoots: string[]; modelCalls: number; modelCallLimit: number; formatSubmissionLimit: number;
  resumeSubmissionIssue?: { path: string; reason: string } | undefined; sessionStorage: SessionStorage;
  onSessionRef(reference: unknown): Promise<void>; onModelCall(event?: unknown): Promise<void>; onResult(value: unknown): Promise<void> }
interface RevisionOptions { record: UnknownRecord; source: unknown; candidateSchema: ToolSchema; validate(value: unknown): ArchitectureDesign;
  runWorker?: ((worker: RepairWorker) => Promise<unknown>) | undefined;
  runRole(node: ReviewRevisionRole): Promise<unknown>; onSave(checkpoint: ReviewRevisionCheckpoint): Promise<void>; sessionDirectory: string;
  signal?: AbortSignal | undefined; formatSubmissionIssue?: ReviewDiagnosticIssue | undefined }
import { InputError, ProviderError } from "../requirements/core.mjs";
import { ARCHITECTURE_ROLE_TURN_LIMIT, designHash } from "./architecture-contract.mjs";
import { architectureDesignCallLimits } from "./architecture-design-pipeline.mjs";
import { copyArchitectureReviewJson } from "./architecture-review-binding.mjs";
import { createArchitectureSubmissionRepair } from "./architecture-submission-repair.mjs";
import { readMainReviewCheckpoint } from "./architecture-main-review-checkpoint.mjs";
import { readArchitectureFidelityProgress } from "./architecture-fidelity-progress.mjs";
import { readReviewProgressCheckpoint } from "./architecture-review-progress.mjs";
import { architectureReviewFailureStalled, architectureReviewProtocolRepairAvailable } from "./architecture-review-protocol.mjs";
import { ARCHITECTURE_FORMAT_SUBMISSION_LIMIT, isArchitectureFormatSubmissionIssue } from "./architecture-tool-diagnostics.mjs";

export const ARCHITECTURE_REVIEW_REVISION_CALL_LIMIT = 3;
export const ARCHITECTURE_REVIEW_RETRY_CALL_LIMIT = ARCHITECTURE_ROLE_TURN_LIMIT + 2;
export const ARCHITECTURE_REVIEW_TEST_RETRY_CALL_LIMIT = ARCHITECTURE_REVIEW_RETRY_CALL_LIMIT + 2;
const copy = <T,>(value: T): T => copyArchitectureReviewJson(value, { maxDepth: 48, maxNodes: 300_000, maxBytes: 2 * 1024 * 1024 });
const seal = <T extends object,>(value: T): Omit<T, "hash"> & { hash: string } => { const { hash: _hash, ...body } = { ...value, hash: undefined }; return { ...body, hash: designHash(body) }; };
const materialHash = (input: unknown) => { const record = objectFields(input); return designHash({ agentId: record.agentId, sourceFingerprint: record.sourceFingerprint,
  draft: record.draft, requirements: record.requirements, platformHash: record.platformHash, runtimeCapabilities: record.runtimeCapabilities,
  confirmedRequirementContext: record.confirmedRequirementContext ?? null, deferredVerifications: record.deferredVerifications ?? null,
  evidence: record.evidence, researchGaps: record.researchGaps, designResearchCalls: record.designResearchCalls ?? 0 }); };
function sourceReference(input: unknown): RevisionSource {
  const record = objectFields(input), progress = objectFields(record.designProgressCheckpoint);
  if (!isInteger(record.version) || typeof record.candidateHash !== "string" || typeof progress.hash !== "string"
    || typeof progress.pipelineId !== "string" || !isInteger(progress.modelCalls)) throw invalid();
  return { version: record.version, candidateHash: record.candidateHash, reviewHash: designHash(record.review),
    issuesHash: designHash(record.issues), progressHash: progress.hash, pipelineId: progress.pipelineId, modelCalls: progress.modelCalls };
}
const invalid = () => new InputError("评审修订来源或进度无法核验；不能重开会话刷新额度，请保留原材料。");
const contentError = (message: string) => Object.assign(new InputError(message), {
  validationIssue: { path: "review_revision.updates", reason: "invalid_value" },
});
const validProgress = (input: unknown) => {
  const { hash, ...body } = objectFields(objectFields(input).designProgressCheckpoint);
  return hash === designHash(body) && isInteger(body.modelCalls) && body.modelCalls >= 0
    && body.modelCalls <= architectureDesignCallLimits(body).pipeline;
};

export function hasReviewedArchitectureCandidate(input: unknown) {
  const record = objectFields(input);
  try {
    const last = (isArray(record.attempts) ? record.attempts : []).map(objectFields).at(-1);
    return Boolean(record?.designProgressCheckpoint && validProgress(record) && Number(objectFields(record.design).schemaVersion) >= 3
      && record.candidateHash === designHash(record.design) && record.review
      && ["revise", "pass"].some(verdict => verdict === objectFields(record.review).verdict) && (isArray(record.issues) ? record.issues : []).some(item => objectFields(item).blocking)
      && last?.candidateHash === record.candidateHash && designHash(last.design) === record.candidateHash
      && designHash(last.review) === designHash(record.review) && designHash(last.issues) === designHash(record.issues));
  } catch { return false; }
}

function revisionShape(input: unknown): ReviewRevisionCheckpoint {
  const checkpoint = objectFields(input), source = objectFields(checkpoint.source), session = objectFields(checkpoint.sessionRef);
  if (!isRecord(input) || !isRecord(checkpoint.source) || ![1, 2].includes(Number(checkpoint.schemaVersion)) || !isInteger(checkpoint.modelCalls)
    || [checkpoint.schemaHash, checkpoint.bindingHash, checkpoint.hash, source.candidateHash, source.reviewHash, source.issuesHash, source.progressHash, source.pipelineId].some(value => typeof value !== "string")
    || !isInteger(source.version) || !isInteger(source.modelCalls)
    || checkpoint.sessionRef !== null && (!isRecord(checkpoint.sessionRef) || typeof session.file !== "string")
    || checkpoint.resultHash !== null && typeof checkpoint.resultHash !== "string") throw invalid();
  return input as ReviewRevisionCheckpoint;
}
function retryShape(input: unknown): ReviewRetryCheckpoint {
  const checkpoint = objectFields(input), source = objectFields(checkpoint.source);
  if (!isRecord(input) || !isRecord(checkpoint.source) || ![1, 2, 3].some(version => version === checkpoint.schemaVersion)
    || !isInteger(checkpoint.additionalCalls) || !isInteger(source.version) || !isInteger(source.modelCalls)
    || [checkpoint.bindingHash, checkpoint.hash, source.candidateHash, source.progressHash].some(value => typeof value !== "string")
    || checkpoint.schemaVersion !== 1 && typeof checkpoint.previousCheckpointHash !== "string"
    || checkpoint.schemaVersion === 2 && !validTestAuthorization(checkpoint.authorization)) throw invalid();
  return input as ReviewRetryCheckpoint;
}
function retrySource(record: UnknownRecord, progress: { hash: string; modelCalls: number }): RetrySource {
  if (!isInteger(record.version) || typeof record.candidateHash !== "string") throw invalid();
  return { version: record.version, candidateHash: record.candidateHash, progressHash: progress.hash, modelCalls: progress.modelCalls };
}

export function readArchitectureReviewRevision(input: unknown): ReviewRevisionCheckpoint | null {
  const record = objectFields(input);
  if (!Object.hasOwn(record, "reviewRevisionCheckpoint")) return null;
  try {
    const checkpoint = revisionShape(copy(record.reviewRevisionCheckpoint));
    const distributed = checkpoint.schemaVersion === 2;
    const dispatch = distributed ? readRepairCheckpoint(checkpoint.dispatch) : null;
    if (Object.keys(checkpoint).sort().join() !== (distributed ? "bindingHash,dispatch,hash,modelCalls,result,resultHash,schemaHash,schemaVersion,sessionRef,source" : "bindingHash,hash,modelCalls,result,resultHash,schemaHash,schemaVersion,sessionRef,source")
      || checkpoint.hash !== seal(checkpoint).hash || checkpoint.bindingHash !== materialHash(record)
      || dispatch && (dispatch.calls !== checkpoint.modelCalls || dispatch.baseHash !== checkpoint.source.candidateHash
        || dispatch.bindingHash !== repairHash(checkpoint.source))
      || !/^[a-f0-9]{64}$/u.test(checkpoint.schemaHash) || !validProgress(record)
      || !Number.isSafeInteger(checkpoint!.modelCalls) || checkpoint!.modelCalls < 0 || checkpoint!.modelCalls > (dispatch?.callLimit ?? ARCHITECTURE_FORMAT_SUBMISSION_LIMIT)
      || !Number.isSafeInteger(checkpoint.source?.version) || checkpoint.source.version < 1 || (!isInteger(record.version) || checkpoint.source.version >= record.version)
      || checkpoint.source.pipelineId !== objectFields(record.designProgressCheckpoint).pipelineId
      || checkpoint.source.progressHash !== objectFields(record.designProgressCheckpoint).hash || checkpoint.source.modelCalls !== objectFields(record.designProgressCheckpoint).modelCalls
      || record.reviewRevisionSource !== designHash(checkpoint.source)
      || checkpoint!.sessionRef !== null && (Object.keys(checkpoint!.sessionRef).join() !== "file"
        || !/^[A-Za-z0-9_.-]+\.jsonl$/u.test(checkpoint!.sessionRef.file))
      || !distributed && checkpoint!.modelCalls > 0 && !checkpoint!.sessionRef
      || (checkpoint!.result === null ? checkpoint!.resultHash !== null : checkpoint!.resultHash !== designHash(checkpoint!.result)
        || checkpoint!.modelCalls < 1 || (!distributed && !checkpoint!.sessionRef)
        || dispatch && dispatch.groups.some(group => !group.result))) throw invalid();
    return checkpoint;
  } catch { throw invalid(); }
}

const reviewRetryBinding = (input: unknown) => { const record = objectFields(input); return designHash({ materialHash: materialHash(record), candidateHash: record.candidateHash,
  revisionSource: record.reviewRevisionSource, progressHash: objectFields(record.designProgressCheckpoint).hash }); };
const retryableReviewIssue = (issue: unknown) => isArchitectureFormatSubmissionIssue(issue)
  || ["candidate_path_missing", "reference_path_missing", "reference_quote_mismatch", "invalid_reference"].some(reason => reason === objectFields(issue).reason);

export function createArchitectureReviewRetry(input: unknown): ReviewRetryCheckpoint {
  const record = objectFields(input);
  const revision = readArchitectureReviewRevision(record), progress = readReviewProgressCheckpoint(record);
  if (Object.hasOwn(record, "reviewRetryCheckpoint") || !["failed", "cancelled"].some(status => status === record.status)
    || !revision?.result || record.candidateHash !== revision.resultHash || record.review !== null
    || !progress || progress.modelCalls !== ARCHITECTURE_ROLE_TURN_LIMIT || record.mainReviewCheckpoint
    || objectFields(record.diagnostic).role !== "reviewer" || objectFields(record.diagnostic).reason !== "turn_limit"
    || !retryableReviewIssue(objectFields(record.diagnostic).lastSubmissionIssue)
    || architectureReviewFailureStalled(progress.diagnostic)) throw new InputError("当前评审不符合手动续评条件，不能重复领取额度。");
  return seal({ schemaVersion: 1 as const, bindingHash: reviewRetryBinding(record), additionalCalls: 2,
    source: retrySource(record, progress) });
}

const validTestAuthorization = (input: unknown): input is TestAuthorization => { const value = objectFields(input); return value && Object.keys(value).sort().join() === "authorizedAt,kind,reason"
  && value.kind === "user_requested_test" && typeof value.reason === "string" && value.reason.trim().length > 0
  && value.reason.length <= 1000 && typeof value.authorizedAt === "string"
  && Number.isFinite(Date.parse(value.authorizedAt)) && new Date(value.authorizedAt).toISOString() === value.authorizedAt; };

// Maintenance-only: an explicit user request after a fix, never issued by the build endpoint.
export function createArchitectureReviewTestRetry(input: unknown, authorization?: unknown): ReviewRetryCheckpoint {
  const record = objectFields(input);
  const previous = readArchitectureReviewRetry(record), progress = readReviewProgressCheckpoint(record);
  const revision = readArchitectureReviewRevision(record);
  if (!validTestAuthorization(authorization) || previous?.schemaVersion !== 1
    || !["failed", "cancelled"].some(status => status === record.status) || record.review !== null || record.mainReviewCheckpoint
    || !revision?.result || record.candidateHash !== revision.resultHash
    || progress?.modelCalls !== ARCHITECTURE_REVIEW_RETRY_CALL_LIMIT || (progress.diagnostic?.repeatedFailure?.count ?? 0) >= 3)
    throw new InputError("追加测试需明确的用户请求和完整的耗尽续评记录，不能重复追加。");
  return seal({ schemaVersion: 2 as const, bindingHash: reviewRetryBinding(record), additionalCalls: 2,
    source: retrySource(record, progress),
    previousCheckpointHash: previous.hash, authorization: copy(authorization) });
}

export const architectureReviewRetryCallLimit = (checkpoint: ReviewRetryCheckpoint | null | undefined) => checkpoint?.schemaVersion === 3
  ? checkpoint.source.modelCalls + checkpoint.additionalCalls : checkpoint?.schemaVersion === 2
    ? ARCHITECTURE_REVIEW_TEST_RETRY_CALL_LIMIT : ARCHITECTURE_REVIEW_RETRY_CALL_LIMIT;

export function createArchitectureReviewContinuation(input: unknown): ReviewRetryCheckpoint {
  const record = objectFields(input);
  const previous = readArchitectureReviewRetry(record), progress = readReviewProgressCheckpoint(record);
  const revision = readArchitectureReviewRevision(record);
  if (!previous || !["failed", "cancelled"].some(status => status === record.status) || record.review !== null || record.mainReviewCheckpoint
    || !revision?.result || record.candidateHash !== revision.resultHash || !progress
    || progress.modelCalls !== architectureReviewRetryCallLimit(previous)
    || !Number.isSafeInteger(progress.modelCalls + ARCHITECTURE_ROLE_TURN_LIMIT)
    || architectureReviewFailureStalled(progress.diagnostic))
    throw new InputError("当前材料不能继续评审，请保留原方案检查具体问题。");
  return seal({ schemaVersion: 3 as const, bindingHash: reviewRetryBinding(record), additionalCalls: ARCHITECTURE_ROLE_TURN_LIMIT,
    source: retrySource(record, progress),
    previousCheckpointHash: previous.hash });
}

export function readArchitectureReviewRetry(input: unknown): ReviewRetryCheckpoint | null {
  const record = objectFields(input);
  if (!Object.hasOwn(record, "reviewRetryCheckpoint")) return null;
  try {
    const checkpoint = retryShape(copy(record.reviewRetryCheckpoint)), progress = readReviewProgressCheckpoint(record);
    const testRetry = checkpoint.schemaVersion === 2, continuation = checkpoint.schemaVersion === 3;
    if (Object.keys(checkpoint).sort().join() !== (testRetry
      ? "additionalCalls,authorization,bindingHash,hash,previousCheckpointHash,schemaVersion,source"
      : continuation ? "additionalCalls,bindingHash,hash,previousCheckpointHash,schemaVersion,source"
        : "additionalCalls,bindingHash,hash,schemaVersion,source")
      || ![1, 2, 3].includes(checkpoint.schemaVersion) || checkpoint.additionalCalls !== (continuation ? ARCHITECTURE_ROLE_TURN_LIMIT : 2)
      || checkpoint.hash !== seal(checkpoint).hash
      || testRetry && (!validTestAuthorization(checkpoint.authorization) || !/^[a-f0-9]{64}$/u.test(checkpoint.previousCheckpointHash))
      || continuation && (!/^[a-f0-9]{64}$/u.test(checkpoint.previousCheckpointHash)
        || !Number.isSafeInteger(checkpoint.source?.modelCalls) || checkpoint.source.modelCalls < ARCHITECTURE_REVIEW_RETRY_CALL_LIMIT
        || !Number.isSafeInteger(architectureReviewRetryCallLimit(checkpoint)))
      || checkpoint.bindingHash !== reviewRetryBinding(record)
      || Object.keys(checkpoint.source).sort().join() !== "candidateHash,modelCalls,progressHash,version"
      || !Number.isSafeInteger(checkpoint.source.version) || checkpoint.source.version < 1 || (!isInteger(record.version) || checkpoint.source.version >= record.version)
      || checkpoint.source.candidateHash !== record.candidateHash
      || !continuation && checkpoint.source.modelCalls !== (testRetry ? ARCHITECTURE_REVIEW_RETRY_CALL_LIMIT : ARCHITECTURE_ROLE_TURN_LIMIT)
      || !/^[a-f0-9]{64}$/u.test(checkpoint.source.progressHash) || !progress
      || progress.modelCalls < checkpoint.source.modelCalls || progress.modelCalls > architectureReviewRetryCallLimit(checkpoint))
      throw new Error();
    return checkpoint;
  } catch { throw new InputError("手动续评授权或检查点无法核验；不能重新领取额度，请保留原材料。"); }
}

function reviewRetryRecovery(input: unknown) {
  const record = objectFields(input);
  const progress = readReviewProgressCheckpoint(record);
  if (Object.hasOwn(record, "reviewRetryCheckpoint")) {
    const checkpoint = readArchitectureReviewRetry(record), limit = architectureReviewRetryCallLimit(checkpoint);
    const exhausted = progress!.modelCalls >= limit;
    const replay = readMainReviewCheckpoint(record)?.fidelityStatus === "pending"
      && readArchitectureFidelityProgress(record)?.state?.diagnostic?.resultAvailable === true;
    const blocked = exhausted && !replay || architectureReviewFailureStalled(progress!.diagnostic);
    const protocolRepaired = architectureReviewProtocolRepairAvailable(progress!.diagnostic);
    if (exhausted && !replay) {
      try {
        const next = createArchitectureReviewContinuation(record);
        return { kind: "review_retry", status: "available", stage: "evaluating", modelCalls: progress!.modelCalls,
          modelCallLimit: architectureReviewRetryCallLimit(next), actionLabel: "继续设计",
          message: `方案和检查结果已保留，已累计使用${progress!.modelCalls}次评审。点击继续当前未完成的独立评估，本轮最多5次，完成前不会进入交付。`,
          request: { kind: "review_continue", version: record.version, candidateHash: record.candidateHash, checkpointHash: next.hash } };
      } catch { /* Corrupt, stalled or already concluded work remains blocked. */ }
    }
    return { kind: "review_retry", status: blocked ? "blocked" : "continuing", stage: "evaluating",
      modelCalls: progress!.modelCalls, modelCallLimit: limit,
      actionLabel: blocked ? "查看评审阻断" : checkpoint!.schemaVersion === 3 ? "继续设计" : "继续手动评审",
      message: blocked ? `独立评审仍未完成，已用${progress!.modelCalls}/${limit}次；本次手动续评不能再次领取额度，方案和已保存检查保留。`
        : protocolRepaired ? `引用纠错规则已更新，可继续已保存检查（已用${progress!.modelCalls}/${limit}次）；原方案、草稿和累计用量保留。`
          : `手动续评尚未完成，已用${progress!.modelCalls}/${limit}次；继续已保存检查，不重做方案。` };
  }
  let checkpoint;
  try { checkpoint = createArchitectureReviewRetry(record); } catch { return null; }
  return { kind: "review_retry", status: "available", stage: "evaluating", modelCalls: progress!.modelCalls,
    modelCallLimit: ARCHITECTURE_REVIEW_RETRY_CALL_LIMIT, actionLabel: "手动继续评审（最多2次）",
    message: "独立评审的提交格式或引用未通过校验，已用5/5次，尚未形成正式结论。方案和已保存检查保留，可手动追加最多2次完成评审。",
    request: { kind: "review_retry", version: record.version, candidateHash: record.candidateHash, checkpointHash: checkpoint.hash } };
}

export function architectureReviewRevisionRecovery(input: unknown) {
  const record = objectFields(input);
  if (!record || ["designing", "evaluating", "passed"].some(status => status === record.status)) return null;
  if (!["failed", "cancelled", "needs_changes"].some(status => status === record.status))
    return Object.hasOwn(record, "reviewRevisionCheckpoint") || Object.hasOwn(record, "reviewRevisionSource")
      ? { kind: "review_revision", status: "blocked", actionLabel: "评审修订已结束", message: "本次评审修订已有最终结论，候选和问题均已保存；不能重开原设计或重新领取修订额度。" } : null;
  if (Object.hasOwn(record, "reviewRevisionSource") && !Object.hasOwn(record, "reviewRevisionCheckpoint"))
    return { kind: "review_revision", status: "blocked", actionLabel: "检查修订材料", message: "已授权的评审修订进度缺失，不能重新领取额度；请保留材料检查。" };
  if (Object.hasOwn(record, "reviewRevisionCheckpoint")) {
    try {
      const checkpoint = readArchitectureReviewRevision(record);
      const reviewed = checkpoint!.result && record.candidateHash === checkpoint!.resultHash && record.review;
      if (checkpoint!.result && !reviewed) {
        const retry = reviewRetryRecovery(record);
        if (retry) return retry;
      }
      const mainReview = readMainReviewCheckpoint(record), fidelity = readArchitectureFidelityProgress(record);
      const replayAvailable = mainReview?.fidelityStatus === "pending" && fidelity?.state?.diagnostic?.resultAvailable === true;
      // A completed revision has its own review continuation, never a second revision allowance.
      const reviewExhausted = checkpoint!.result && Math.max(Number(objectFields(record.reviewProgressCheckpoint).modelCalls ?? 0),
        Number(objectFields(record.mainReviewCheckpoint).modelCalls ?? 0)) >= ARCHITECTURE_ROLE_TURN_LIMIT && !replayAvailable;
      const submissionIssue = objectFields(record.diagnostic).lastSubmissionIssue;
      const formatIssue = isArchitectureFormatSubmissionIssue(submissionIssue);
      const referenceRetry = objectFields(submissionIssue).reason === "invalid_reference"
        && checkpoint!.modelCalls >= ARCHITECTURE_REVIEW_REVISION_CALL_LIMIT
        && checkpoint!.modelCalls < ARCHITECTURE_FORMAT_SUBMISSION_LIMIT;
      const acceptanceRetry = objectFields(submissionIssue).reason === "missing_coverage"
        && checkpoint!.modelCalls < ARCHITECTURE_FORMAT_SUBMISSION_LIMIT;
      const contentIssue = Boolean(submissionIssue) && !formatIssue && !referenceRetry && !acceptanceRetry;
      const formatContinuation = !contentIssue && checkpoint!.modelCalls < ARCHITECTURE_FORMAT_SUBMISSION_LIMIT
        && (formatIssue && checkpoint!.modelCalls >= ARCHITECTURE_REVIEW_REVISION_CALL_LIMIT
          || checkpoint!.modelCalls > ARCHITECTURE_REVIEW_REVISION_CALL_LIMIT
          || acceptanceRetry || referenceRetry);
      const revisionLimit = checkpoint!.dispatch?.callLimit ?? (formatContinuation ? ARCHITECTURE_FORMAT_SUBMISSION_LIMIT : ARCHITECTURE_REVIEW_REVISION_CALL_LIMIT);
      const blocked = Boolean(reviewed || reviewExhausted) || !checkpoint!.result && (checkpoint!.modelCalls >= revisionLimit
        || checkpoint!.dispatch?.groups.some(group => !group.result && group.calls >= checkpoint!.dispatch!.groupCallLimit));
      return { kind: "review_revision", status: blocked ? "blocked" : "continuing", stage: "review_revision", stageKey: "review_revision",
        stageLabel: "评审修订", modelCalls: checkpoint!.modelCalls, modelCallLimit: revisionLimit,
        actionLabel: blocked ? "查看评审阻断" : checkpoint!.result ? "继续独立评审" : "继续按评审修订",
        message: blocked ? reviewed ? "修订后的独立评审已完成，但仍有阻断；方案和评审意见已保存，本轮修订不能重复领取额度。"
          : reviewExhausted ? "独立评审尚未完成，评审额度已用尽；方案和已保存检查保留，请查看具体失败原因。"
            : "本轮方案修订额度已用尽，尚未保存有效修订结果；原方案和问题已保留。"
          : checkpoint!.result ? "修订候选已保存，可继续独立评审；不重复设计，也不刷新已用评审次数。"
            : formatContinuation && formatIssue
              ? `上次修订卡在输出格式，可沿原会话继续（已用${checkpoint!.modelCalls}/${ARCHITECTURE_FORMAT_SUBMISSION_LIMIT}次）。内容错误仍以${ARCHITECTURE_REVIEW_REVISION_CALL_LIMIT}次为限。`
              : formatContinuation && referenceRetry
                ? `上次修订引用了不存在的编号，可沿原会话继续修正（已用${checkpoint!.modelCalls}/${ARCHITECTURE_FORMAT_SUBMISSION_LIMIT}次）。`
                : formatContinuation && acceptanceRetry
                  ? `上次修订没有补上验收，可沿原会话再改（已用${checkpoint!.modelCalls}/${ARCHITECTURE_FORMAT_SUBMISSION_LIMIT}次）。`
                : formatContinuation
                  ? `模型接口连接中断，这次修订还没完成（已用${checkpoint!.modelCalls}/${ARCHITECTURE_FORMAT_SUBMISSION_LIMIT}次）。可沿原会话继续。`
              : checkpoint!.dispatch ? `正在按问题分组修订：${checkpoint!.dispatch.groups.filter(group => group.result).length}/${checkpoint!.dispatch.groups.length}组已提交，累计${checkpoint!.modelCalls}/${revisionLimit}轮。`
              : `正在续接同一次评审修订（已用${checkpoint!.modelCalls}/${revisionLimit}轮）；蓝图、模块和原设计用量保留。` };
    } catch (error) { return { kind: "review_revision", status: "blocked", actionLabel: "检查修订材料", message: error instanceof Error ? error.message : String(error) }; }
  }
  if (!hasReviewedArchitectureCandidate(record)) return null;
  const source = sourceReference(record);
  const planned = createRepairCheckpoint(source, record.design, repairIssues(record), ARCHITECTURE_REVIEW_REVISION_CALL_LIMIT);
  const grouped = planned.groups.length > 1;
  return { kind: "review_revision", status: "available", stage: "review_revision", stageKey: "review_revision", stageLabel: "评审修订",
    actionLabel: grouped ? "按问题分组修订" : "按评审修订（最多3轮）", modelCalls: 0, modelCallLimit: grouped ? planned.callLimit : ARCHITECTURE_REVIEW_REVISION_CALL_LIMIT,
    message: grouped ? `完整方案及意见已保存，将分成${planned.groups.length}组独立修复，每组最多3轮，总计最多${planned.callLimit}轮；修订后仍须完整检查和独立评审。`
      : "完整方案及独立评审意见已保存。可开启一次按评审意见的局部修订（最多3轮），不重跑蓝图和模块；原设计用量保留，修订后仍须独立评审。",
    request: { kind: "review_revision", version: record.version, checkpointHash: objectFields(record.designProgressCheckpoint).hash,
      candidateHash: source.candidateHash, reviewHash: source.reviewHash, issuesHash: source.issuesHash } };
}

function repairIssues(source: unknown): RepairIssue[] {
  const value = objectFields(source);
  return (isArray(value.issues) ? value.issues : []).map(objectFields).filter(issue => issue.blocking).map((issue, index) => {
    const paths = (isArray(issue.candidatePaths) && issue.candidatePaths.length ? issue.candidatePaths
      : isArray(issue.candidateFields) ? issue.candidateFields.map(field => `/${String(field)}`) : ["/instructions"]).map(String);
    return { id: `issue_${index + 1}`, description: String(issue.description ?? issue.id ?? "评审问题"), remedy: String(issue.remedy ?? "按原需求核对并修复"),
      paths, owner: [...new Set(paths.map(path => path.split("/")[1]))].sort().join("+") };
  });
}

export function createArchitectureReviewRevision(record: unknown, source: unknown, candidateSchema: ToolSchema): ReviewRevisionCheckpoint {
  if (!hasReviewedArchitectureCandidate(source) || materialHash(source) !== materialHash(record)) throw invalid();
  const dispatch = createRepairCheckpoint(sourceReference(source), objectFields(source).design, repairIssues(source), ARCHITECTURE_REVIEW_REVISION_CALL_LIMIT);
  return seal({ schemaVersion: dispatch.groups.length > 1 ? 2 as const : 1 as const,
    ...(dispatch.groups.length > 1 ? { dispatch } : {}), schemaHash: designHash(candidateSchema), bindingHash: materialHash(record), source: sourceReference(source),
    modelCalls: 0, sessionRef: null, result: null, resultHash: null });
}

export async function runArchitectureReviewRevision({ record, source: sourceInput, candidateSchema, validate, runRole, runWorker, onSave, sessionDirectory, signal, formatSubmissionIssue }: RevisionOptions): Promise<ArchitectureDesign> {
  const source = objectFields(sourceInput);
  if (!hasReviewedArchitectureCandidate(source) || materialHash(source) !== materialHash(record)) throw invalid();
  let checkpoint = readArchitectureReviewRevision(record);
  const expected = sourceReference(source);
  if (checkpoint && (designHash(checkpoint.source) !== designHash(expected) || checkpoint.schemaHash !== designHash(candidateSchema))) throw invalid();
  if (record.reviewRevisionSource !== undefined && record.reviewRevisionSource !== designHash(expected)) throw invalid();
  let writes = Promise.resolve();
  let persistenceError: unknown;
  const active = () => { if (persistenceError) throw persistenceError; signal?.throwIfAborted(); };
  const save = (action: (next: ReviewRevisionCheckpoint) => void) => {
    const task = writes.then(async () => {
      active();
      const next = copy(checkpoint!); action(next);
      const snapshot = seal(next);
      try { await onSave(copy(snapshot)); } catch (error) { persistenceError ??= error; throw error; }
      checkpoint = snapshot; record.reviewRevisionCheckpoint = copy(snapshot);
      active();
    });
    writes = task.catch(() => {});
    return task;
  };
  if (!checkpoint) {
    checkpoint = createArchitectureReviewRevision(record, source, candidateSchema);
    record.reviewRevisionSource = designHash(checkpoint.source);
    await save(() => {});
  }
  const base = validate(copy(source.design));
  const validateCandidate = (value: unknown) => {
    const candidate = validate(copy(value));
    if (designHash(candidate) === expected.candidateHash) throw contentError("修订必须实际解决评审问题；原候选不能换取新的评审额度。");
    for (const field of ["components", "steps", "decisions", "acceptance", "platformClaims"] as const) {
      const ids = new Set((candidate[field] ?? []).map(item => item.id));
      if ((base[field] ?? []).some(item => !ids.has(item.id))) throw contentError(`评审修订必须保留${field}的原编号及验收义务，不能删除后重建。`);
    }
    for (const row of base.acceptance ?? []) {
      const revised = candidate.acceptance.find(item => item.id === row.id);
      if (revised!.kind !== row.kind || designHash(revised!.requirementIds) !== designHash(row.requirementIds))
        throw contentError("评审修订必须保留每条原验收的类型和正式需求归属，不能转移或减少原义务。");
    }
    return candidate;
  };
  if (checkpoint!.result) return validateCandidate(checkpoint!.result);
  if (checkpoint!.schemaVersion === 2) {
    if (!runWorker) throw invalid();
    if (repairHash(checkpoint!.dispatch!.issues) !== repairHash(repairIssues(source))) throw invalid();
    const result = validateCandidate(await runRepairSchedule({ checkpoint: checkpoint!.dispatch!, base, binding: expected, signal,
      run: runWorker, save: dispatch => save(next => { next.dispatch = dispatch; next.modelCalls = dispatch.calls; }) }));
    const paths = repairIssues(source).flatMap(issue => issue.paths);
    for (const [index, row] of base.acceptance.entries()) {
      if (!paths.some(path => path === "/acceptance" || path === `/acceptance/${index}` || path.startsWith(`/acceptance/${index}/`))
        && designHash(row) !== designHash(result.acceptance.find(item => item.id === row.id))) throw contentError("未涉及反馈的验收必须完整保留。");
    }
    await save(next => { next.result = result; next.resultHash = designHash(result); });
    return result;
  }
  const referenceRetry = formatSubmissionIssue?.reason === "invalid_reference"
    && checkpoint!.modelCalls >= ARCHITECTURE_REVIEW_REVISION_CALL_LIMIT
    && checkpoint!.modelCalls < ARCHITECTURE_FORMAT_SUBMISSION_LIMIT;
  const acceptanceRetry = formatSubmissionIssue?.reason === "missing_coverage"
    && checkpoint!.modelCalls < ARCHITECTURE_FORMAT_SUBMISSION_LIMIT;
  const contentStop = Boolean(formatSubmissionIssue) && !isArchitectureFormatSubmissionIssue(formatSubmissionIssue)
    && !referenceRetry && !acceptanceRetry;
  const formatResume = !contentStop && checkpoint!.modelCalls < ARCHITECTURE_FORMAT_SUBMISSION_LIMIT
    && (isArchitectureFormatSubmissionIssue(formatSubmissionIssue) && checkpoint!.modelCalls >= ARCHITECTURE_REVIEW_REVISION_CALL_LIMIT
      || checkpoint!.modelCalls > ARCHITECTURE_REVIEW_REVISION_CALL_LIMIT
      || acceptanceRetry || referenceRetry);
  if (checkpoint!.modelCalls >= (formatResume ? ARCHITECTURE_FORMAT_SUBMISSION_LIMIT : ARCHITECTURE_REVIEW_REVISION_CALL_LIMIT))
    throw new InputError("本次评审修订额度已用完，原候选及已保存材料保留。");
  const issues: RevisionIssue[] = (isArray(source.issues) ? source.issues : []).filter((item): item is RevisionIssue => {
    const issue = objectFields(item);
    if ([issue.candidatePaths, issue.candidateFields].some(value => value !== undefined && (!isArray(value) || value.some(field => typeof field !== "string")))) throw invalid();
    return Boolean(issue.blocking);
  });
  const paths = issues.flatMap(item => item.candidatePaths?.length ? item.candidatePaths : (item.candidateFields ?? []).map(field => `/${field}`));
  const at = (value: unknown, pointer: string) => pointer.slice(1).split("/").reduce<unknown>((current, key) => objectFields(current)[key.replaceAll("~1", "/").replaceAll("~0", "~")], value);
  const roots = [...new Set(["instructions", ...issues.flatMap(item => [...item.candidateFields ?? [], ...item.candidatePaths ?? []])
    .map(path => path.replace(/^\//u, "").split("/")[0]).filter((field): field is string => field !== undefined && Object.hasOwn(base, field))])];
  const repair = createArchitectureSubmissionRepair({ schema: candidateSchema });
  const reference = repair.capture(base, { signal });
  const parameters: ToolSchema = { type: "object", additionalProperties: false, required: ["baseHash", "updates"], properties: {
    baseHash: { type: "string", const: expected.candidateHash },
    updates: { ...repair.parameters.properties.updates, items: { ...repair.parameters.properties.updates.items,
      properties: { ...repair.parameters.properties.updates.items.properties,
        path: { type: "string", minLength: 1, maxLength: 500, pattern: `^/(?:${roots.join("|")})(?:/|$)` } } } },
  } };
  const validateSubmission = (value: unknown) => {
    const submission = objectFields(value);
    if (submission.baseHash !== expected.candidateHash || !isArray(submission.updates)
      || submission.updates.some(item => { const path = objectFields(item).path; return typeof path !== "string" || !roots.includes(path.slice(1).split("/")[0] ?? ""); })) throw invalid();
    const candidate = validateCandidate(repair.apply({ ...reference, updates: submission.updates }, { signal }));
    if (!paths.some(path => designHash(at(base, path) ?? null) !== designHash(at(candidate, path) ?? null)))
      throw contentError("修订尚未改变任何阻断意见对应的字段，不能仅改无关说明后重新评审。");
    for (const [index, row] of (base.acceptance ?? []).entries()) {
      const pointer = `/acceptance/${index}`;
      if (!paths.some(path => path === "/acceptance" || path === pointer || path.startsWith(pointer + "/"))
        && designHash(row) !== designHash(candidate.acceptance.find(item => item.id === row.id)))
        throw contentError("未涉及当前反馈的验收行必须完整保留。");
    }
    return candidate;
  };
  const result = await runRole({ parameters, validate: validateSubmission, candidate: base, issues,
    baseHash: expected.candidateHash, allowedRoots: roots, modelCalls: checkpoint!.modelCalls, modelCallLimit: ARCHITECTURE_REVIEW_REVISION_CALL_LIMIT,
    formatSubmissionLimit: ARCHITECTURE_FORMAT_SUBMISSION_LIMIT,
    resumeSubmissionIssue: formatResume && formatSubmissionIssue
      && (isArchitectureFormatSubmissionIssue(formatSubmissionIssue) || ["invalid_reference", "missing_coverage"].includes(formatSubmissionIssue.reason))
      ? { path: formatSubmissionIssue.path, reason: formatSubmissionIssue.reason } : undefined,
    sessionStorage: { directory: sessionDirectory, binding: { version: 1, role: "architecture-review-revision",
      bindingHash: checkpoint.bindingHash, schemaHash: checkpoint.schemaHash, sourceHash: designHash(expected) },
      ...(checkpoint!.sessionRef ? { file: checkpoint!.sessionRef.file } : {}) },
    onSessionRef: async value => {
      const reference = objectFields(value);
      if (!reference || Object.keys(reference).join() !== "file" || typeof reference.file !== "string" || !/^[A-Za-z0-9_.-]+\.jsonl$/u.test(reference.file)
        || checkpoint!.sessionRef && checkpoint!.sessionRef.file !== reference.file) throw invalid();
      const checkedReference = { file: reference.file };
      await save(next => {
        if (next.sessionRef && next.sessionRef.file !== reference.file) throw invalid();
        next.sessionRef = copy(checkedReference);
      });
    },
    onModelCall: async (input = {}) => {
      const event = objectFields(input);
      active();
      if (Number(event.retryAttempt ?? 0) > 0) return;
      await save(next => {
        const limit = event.formatSubmission ? ARCHITECTURE_FORMAT_SUBMISSION_LIMIT : ARCHITECTURE_REVIEW_REVISION_CALL_LIMIT;
        if (!next.sessionRef || next.result || next.modelCalls >= limit) throw invalid();
        next.modelCalls++;
      });
    },
    onResult: async value => {
      active();
      const result = validateCandidate(value);
      if (!checkpoint!.modelCalls || !checkpoint!.sessionRef) throw invalid();
      await save(next => {
        if (next.result && next.resultHash !== designHash(result)) throw invalid();
        next.result = result; next.resultHash = designHash(result);
      });
    } });
  if (!checkpoint!.result || designHash(result) !== checkpoint!.resultHash) throw new ProviderError("评审修订尚未正式保存，不能进入独立评审。", {
    stage: "architecture", reason: "submission_incomplete", role: "designer", phase: "designing" });
  return validateCandidate(copy(checkpoint!.result));
}
