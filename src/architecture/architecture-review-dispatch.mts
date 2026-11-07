import type { ReviewParts } from "../contracts/architecture.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import type { NeumaTool, SessionMessage } from "../runtime/execution-port.mjs";
import type { RepairCheckpoint, RepairWorker } from "../runtime/repair-scheduler.mjs";
import { createReviewTaskCheckpoint, readReviewTaskCheckpoint, repairHash, runReviewTaskSchedule } from "../runtime/repair-scheduler.mjs";
import { modelSubmissionArguments } from "../runtime/model-submission-arguments.mjs";
import { objectFields, isPlainRecord } from "../runtime/type-boundary.mjs";
import { InputError } from "../requirements/core.mjs";
import { createArchitectureEvidenceReader } from "./architecture-evidence-reader.mjs";
import { prepareReviewArguments } from "./architecture-review-evidence.mjs";
import { canonicalArchitectureReviewParts } from "./architecture-review-parts.mjs";

type SliceField = "checks" | "acceptanceScopeChecks" | "priorFindingDecisions";
interface Assignment { id: string; field: SliceField; ids: string[] }
interface SliceResult { summary: string; parts: ReviewParts }
export interface ReviewDispatchCheckpoint { version: 1; candidateHash: string; bindingHash: string; dispatch: RepairCheckpoint<null> }
export interface ReviewSliceRole { assignment: Assignment; worker: RepairWorker<null>; parameters: ToolSchema; tools: NeumaTool[];
  payload: UnknownRecord; prepareArguments(input: unknown): unknown; recoverReviewReferences(messages: readonly SessionMessage[]): UnknownRecord | undefined;
  validate(value: unknown): SliceResult }
const rowId = { checks: "id", acceptanceScopeChecks: "acceptanceId", priorFindingDecisions: "findingId" } as const;
const rows = (value: unknown): UnknownRecord[] => Array.isArray(value) ? value.map(objectFields) : [];
function fail(message: string): never { throw new InputError(message); }

function assignments(schema: ToolSchema, context: unknown, prior: unknown): Assignment[] {
  const items: Record<SliceField, string[]> = {
    checks: (schema.properties!.checks!.items!.properties!.id!.enum as string[]).slice(),
    acceptanceScopeChecks: rows(objectFields(objectFields(context).candidate).acceptance).map(row => String(row.id)),
    priorFindingDecisions: rows(objectFields(prior).findings).map(row => String(row.findingId)),
  };
  const sizes = { checks: 2, acceptanceScopeChecks: 6, priorFindingDecisions: 4 };
  return (Object.keys(items) as SliceField[]).flatMap(field => {
    const result: Assignment[] = [];
    for (let offset = 0; offset < items[field].length; offset += sizes[field])
      result.push({ id: `review_${field}_${offset / sizes[field]}`, field, ids: items[field].slice(offset, offset + sizes[field]) });
    return result;
  });
}

export function shouldDistributeArchitectureReview(context: unknown, prior: unknown) {
  return rows(objectFields(context).requirements).length > 24
    || rows(objectFields(objectFields(context).candidate).acceptance).length > 10 || rows(objectFields(prior).findings).length > 6;
}

export function architectureReviewDispatchRecovery(record: UnknownRecord | null | undefined) {
  if (!record || !["failed", "cancelled"].includes(String(record.status)) || record.reviewDispatchSource === undefined) return null;
  try {
    const checkpoint = objectFields(record.reviewDispatchCheckpoint);
    if (checkpoint.version !== 1 || checkpoint.candidateHash !== record.candidateHash || checkpoint.bindingHash !== record.reviewDispatchSource)
      return { kind: "review_specialists", status: "blocked", message: "分组评审进度缺失或绑定不符，已停止恢复。" };
    const dispatch = readReviewTaskCheckpoint(checkpoint.dispatch), pending = dispatch.groups.filter(group => !group.result);
    if (dispatch.bindingHash !== checkpoint.bindingHash) fail("分组评审绑定不符。");
    if (!pending.length) return null;
    const blocked = pending.some(group => group.rejection?.count === 3);
    return { kind: "review_specialists", status: blocked ? "blocked" : "continuing", stage: "evaluating", stageKey: "review_specialists",
      actionLabel: blocked ? "查看分组评审阻断" : "继续分组评审", modelCalls: dispatch.calls,
      message: blocked ? "评审子组连续三次因同一问题提交失败，已保存分项、原会话和累计用量。"
        : `已保存${dispatch.groups.length - pending.length}/${dispatch.groups.length}组独立评审，只继续未完成组。` };
  } catch { return { kind: "review_specialists", status: "blocked", message: "分组评审进度无法核验，已停止恢复。" }; }
}

/** Disjoint review slices share a durable dispatcher; only the main reviewer can submit the final verdict. */
export async function runArchitectureReviewDispatch(options: { record: UnknownRecord; candidateHash: string; platformHash: string;
  context: unknown; priorFindings?: unknown; schema: ToolSchema; signal?: AbortSignal | undefined;
  save(checkpoint: ReviewDispatchCheckpoint): Promise<void>; runRole(node: ReviewSliceRole): Promise<unknown> }) {
  const { record, candidateHash, schema, context, priorFindings, signal } = options;
  const plan = assignments(schema, context, priorFindings);
  let binding = { version: 1, candidateHash, platformHash: options.platformHash, contextHash: repairHash(context),
    priorHash: repairHash(priorFindings ?? null), schemaHash: repairHash(schema), plan };
  let bindingHash = repairHash(binding);
  const base = { slices: Object.fromEntries(plan.map(item => [item.id, null])) };
  const issues = plan.map(item => ({ id: item.id, owner: item.id, paths: [`/slices/${item.id}`],
    description: `独立核对${item.field}中的指定编号：${item.ids.join("、")}`, remedy: "按真实候选和冻结依据提交本组检查分项；不能修改候选或提前宣布整体通过。" }));
  let checkpoint: ReviewDispatchCheckpoint;
  if (record.reviewDispatchCheckpoint !== undefined) {
    const saved = objectFields(record.reviewDispatchCheckpoint);
    // Older dispatches bound the same review schema with factClaims required on every issue.
    if (saved.bindingHash !== bindingHash) {
      const oldSchema = structuredClone(schema), issue = oldSchema.properties?.issues?.items;
      if (issue?.required?.includes("kind") && !issue.required.includes("factClaims")) {
        issue.required.push("factClaims");
        const oldBinding = { ...binding, schemaHash: repairHash(oldSchema) };
        const oldHash = repairHash(oldBinding);
        if (saved.bindingHash === oldHash) { binding = oldBinding; bindingHash = oldHash; }
      }
    }
    if (Object.keys(saved).sort().join() !== "bindingHash,candidateHash,dispatch,version" || saved.version !== 1
      || saved.candidateHash !== candidateHash || saved.bindingHash !== bindingHash || record.reviewDispatchSource !== bindingHash)
      fail("分组评审的候选、材料或分派已变化，不能重开子会话刷新额度。");
    checkpoint = { version: 1, candidateHash, bindingHash, dispatch: readReviewTaskCheckpoint(saved.dispatch) };
    if (repairHash(checkpoint.dispatch.issues) !== repairHash(issues)) fail("分组评审任务与已保存分派不符。");
  } else {
    if (record.reviewDispatchSource !== undefined) fail("已分派评审的检查点缺失，不能重新领取额度。");
    checkpoint = { version: 1, candidateHash, bindingHash, dispatch: createReviewTaskCheckpoint(binding, base, issues) };
  }
  const save = async (dispatch: RepairCheckpoint<null>) => {
    signal?.throwIfAborted();
    const next = { version: 1 as const, candidateHash, bindingHash, dispatch };
    await options.save(next); checkpoint = next;
    record.reviewDispatchCheckpoint = structuredClone(next); record.reviewDispatchSource = bindingHash;
  };
  const checked = (value: unknown, assignment: Assignment): SliceResult => {
    const raw = objectFields(value);
    if (Object.keys(raw).sort().join() !== "parts,summary" || typeof raw.summary !== "string" || !raw.summary.trim() || raw.summary.length > 1500)
      fail("评审分组必须提交完整分项及有界摘要。");
    const parts = canonicalArchitectureReviewParts(raw.parts, { schema, candidateHash, context, priorFindings, signal });
    for (const field of Object.keys(rowId) as SliceField[]) {
      const ids = parts[field].map(row => String(objectFields(row)[rowId[field]]));
      const expected = field === assignment.field ? assignment.ids : [];
      if (repairHash(ids.slice().sort()) !== repairHash(expected.slice().sort())) fail("评审子任务必须恰好覆盖本组编号，不能遗漏或代交其他组。");
    }
    if (parts.issues.length > 4) fail("每组最多提交四条独立意见，请合并同因问题并保留具体依据。");
    return { summary: raw.summary, parts };
  };
  const ledger = (value: unknown) => {
    const slices = objectFields(objectFields(value).slices);
    if (Object.keys(objectFields(value)).join() !== "slices" || repairHash(Object.keys(slices).sort()) !== repairHash(plan.map(item => item.id).sort()))
      fail("评审分派结果范围不符。");
    for (const assignment of plan) if (slices[assignment.id] !== null) checked(slices[assignment.id], assignment);
    return slices;
  };
  const result = await runReviewTaskSchedule({ checkpoint: checkpoint.dispatch, base, binding, signal, save, validateCandidate: ledger,
    run: async worker => {
      const assignment = plan.find(item => worker.group.issueIds.includes(item.id));
      if (!assignment) fail("评审责任分组不存在。");
      const reader = createArchitectureEvidenceReader({ context, candidateHash, priorFindings, role: "reviewer" });
      const wire = reader.submissionSchema(schema);
      const properties: Record<string, ToolSchema> = { summary: { type: "string", minLength: 1, maxLength: 1500 } };
      for (const field of [assignment.field, "issues"] as const) {
        const selected = structuredClone(wire.properties![field]!);
        selected.minItems = field === "issues" ? 0 : assignment.ids.length;
        selected.maxItems = field === "issues" ? 4 : assignment.ids.length;
        properties[field] = selected;
      }
      const prepareArguments = (input: unknown) => {
        if (!isPlainRecord(input)) return input;
        const prepared = { ...objectFields(prepareReviewArguments(input)) };
        for (const field of Object.keys(rowId)) {
          if (field === assignment.field) continue;
          const value = modelSubmissionArguments(prepared[field], { type: "array" });
          // Prior native sessions may echo the empty columns from their original tool contract.
          if (Array.isArray(value) && value.length === 0) delete prepared[field];
        }
        return prepared;
      };
      const knownFindings = new Set(rows(objectFields(priorFindings).findings).map(row => String(row.findingId)));
      const normalize = (input: unknown) => {
        const raw = objectFields(prepareArguments(input));
        const resolved = objectFields(reader.resolveSubmission({ checks: [], acceptanceScopeChecks: [], priorFindingDecisions: [], ...raw, candidateHash }));
        const { summary: _summary, ...resolvedParts } = resolved;
        const scoped = { ...resolvedParts, candidateHash, issues: rows(resolved.issues).map(issue => ({ ...issue,
          id: assignment!.field === "priorFindingDecisions" && assignment!.ids.includes(String(issue.id)) && knownFindings.has(String(issue.id))
            ? issue.id : `${assignment!.id}_${repairHash(issue.id).slice(0, 16)}` })) };
        return checked({ summary: raw.summary, parts: scoped }, assignment!);
      };
      const parameters: ToolSchema = { type: "object", additionalProperties: false, properties, required: Object.keys(properties) };
      await options.runRole({ assignment: assignment!, worker, parameters, tools: [reader.tool], prepareArguments, validate: normalize,
        recoverReviewReferences: messages => reader.recoverHistory(messages, "submit_architecture_review_slice",
          draft => prepareArguments(modelSubmissionArguments(draft, parameters))),
        payload: { assignment, candidateHash, reviewEvidenceIndex: reader.index,
          requirements: objectFields(context).requirements, acceptanceAdapterGuide: objectFields(context).acceptanceAdapterGuide,
          design: objectFields(context).candidate,
          priorFindings: assignment!.field === "priorFindingDecisions" ? { ...objectFields(priorFindings),
            findings: rows(objectFields(priorFindings).findings).filter(row => assignment!.ids.includes(String(row.findingId))) } : null,
          instruction: `只提交 summary、issues 和本组的 ${assignment.field}。结果恰好覆盖 assignment.ids 中的编号。其他组的材料可用于核查依赖，发现相关问题写入本组 issues 并引用原文，由主评审统筹；其他组负责的结果留给对应组提交。引用由 read_architecture_evidence 核对，摘要说明阻断或不确定项。主评审完成总评后才形成整体结论。` } });
    } });
  const slices = ledger(result), parts: ReviewParts = { candidateHash, checks: [], issues: [], acceptanceScopeChecks: [], priorFindingDecisions: [] };
  for (const assignment of plan) {
    const slice = checked(slices[assignment.id], assignment);
    parts.checks.push(...slice.parts.checks); parts.issues.push(...slice.parts.issues);
    parts.acceptanceScopeChecks.push(...slice.parts.acceptanceScopeChecks); parts.priorFindingDecisions.push(...slice.parts.priorFindingDecisions);
  }
  const verified = canonicalArchitectureReviewParts(parts, { schema, candidateHash, context, priorFindings, signal });
  return { parts: verified, summary: { modelCalls: checkpoint.dispatch.calls, modelCallLimit: checkpoint.dispatch.callLimit,
    groups: plan.map(assignment => ({ assignment, summary: checked(slices[assignment.id], assignment).summary })),
    issues: verified.issues, failedChecks: verified.checks.filter(item => !item.passed),
    insufficientAcceptance: verified.acceptanceScopeChecks.filter(item => !item.sufficient),
    instruction: "分组结果已按同一候选和证据校验并保存在reviewParts；请核对组间冲突与整体充分性，必要时读取原文或修正分项，再提交总评。完整校验和独立需求范围复核仍执行。" } };
}
