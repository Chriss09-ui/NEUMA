import type { ReviewParts, ArchitectureReview, ArchitectureEvidenceContext, ReviewDiagnosticIssue } from "../contracts/architecture.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import { objectFields, isArray } from "../runtime/type-boundary.mjs";
type PartKey = "checks" | "issues" | "acceptanceScopeChecks" | "priorFindingDecisions";
type PriorFindings = { findings: { findingId: string }[] };
type PartOptions = { schema: ToolSchema; candidateHash: string; context?: unknown; priorFindings?: unknown; signal?: AbortSignal | undefined };
type PartIssueOptions = Pick<PartOptions, "context" | "priorFindings"> & { complete?: boolean };
type RawParts = { candidateHash: unknown } & Record<PartKey, UnknownRecord[]>;
function rawParts(parts: ReviewParts): RawParts { return { candidateHash: parts.candidateHash, checks: parts.checks.map(objectFields), issues: parts.issues.map(objectFields), acceptanceScopeChecks: parts.acceptanceScopeChecks.map(objectFields), priorFindingDecisions: parts.priorFindingDecisions.map(objectFields) }; }
function getRows(value: unknown): UnknownRecord[] { if (!isArray(value)) throw new TypeError("Review part rows are invalid"); return value.map(objectFields); }
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { InputError } from "../requirements/core.mjs";
import { hashValue } from "../development/development-contract.mjs";
import { copyArchitectureReviewJson } from "./architecture-review-binding.mjs";
import { architectureToolValidation } from "./architecture-tool-diagnostics.mjs";
import { architectureReviewPathExists, validateArchitectureReviewEvidence } from "./architecture-review-evidence.mjs";
import { architecturePriorFindingClosureIssues } from "./architecture-prior-findings.mjs";

export const REVIEW_PARTS_MAX_BYTES = 256 * 1024;
const keys = { checks: "id", issues: "id", acceptanceScopeChecks: "acceptanceId", priorFindingDecisions: "findingId" } as const;
const partKeys = Object.keys(keys) as PartKey[];
const object = <T extends Record<string, ToolSchema>>(properties: T, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const hashSchema = { type: "string", pattern: "^[a-f0-9]{64}$" };
const copy = <T,>(value: T) => copyArchitectureReviewJson(value, { maxDepth: 32, maxNodes: 100_000, maxBytes: REVIEW_PARTS_MAX_BYTES });
const empty = (candidateHash: string): ReviewParts => ({ candidateHash, checks: [], issues: [], acceptanceScopeChecks: [], priorFindingDecisions: [] });
function fail(path: string, reason: string, message: string): never { throw Object.assign(new InputError(message), { validationIssue: { path, reason } }); }

function rejectIssues(values: ReviewDiagnosticIssue[], omitted = 0) {
  const all = [...new Map(values.map(issue => [JSON.stringify([issue.path, issue.reason, issue.candidatePath]), issue])).values()];
  if (!all.length) return;
  const issues = all.slice(0, 64), total = all.length + omitted, truncated = total > issues.length;
  throw Object.assign(new InputError("评审分项尚有可确定的问题：" + JSON.stringify({ issues, total, truncated })), {
    validationIssue: issues[0], validationIssues: issues, validationIssueTotal: total, validationIssuesTruncated: truncated,
  });
}

function partIssues(parts: ReviewParts, { context, priorFindings, complete = false }: PartIssueOptions) {
  const issues: ReviewDiagnosticIssue[] = [];
  let omitted = 0;
  if (context) {
    try { validateArchitectureReviewEvidence(parts, context, { partial: !complete }); }
    catch (error) {
      if (!(error instanceof InputError) || !error.validationIssue) throw error;
      const kept = (error.validationIssues ?? [error.validationIssue]) as ReviewDiagnosticIssue[];
      issues.push(...kept); omitted += Math.max(0, (typeof error.validationIssueTotal === "number" ? error.validationIssueTotal : kept.length) - kept.length);
    }
  }
  const findings = new Set(getRows(objectFields(priorFindings).findings ?? []).map(row => String(row.findingId)));
  for (const [index, row] of parts.priorFindingDecisions.entries()) {
    if (!findings.has(row.findingId)) issues.push({ path: `reviewParts.priorFindingDecisions[${index}].findingId`, reason: "invalid_reference",
      remedy: "历史问题编号必须来自当前清单；优先选择本轮findingRef，由宿主填回完整编号。" });
    if (context && row.candidatePaths.some(path => !architectureReviewPathExists(objectFields(context).candidate, path)))
      issues.push({ path: `reviewParts.priorFindingDecisions[${index}].candidatePaths`, reason: "candidate_path_missing",
        remedy: "历史问题决定必须引用当前候选实际存在的位置。" });
  }
  return { issues, omitted };
}

function validatePartIssues(parts: ReviewParts, options: PartIssueOptions, additional: ReviewDiagnosticIssue[] = []) {
  const { issues, omitted } = partIssues(parts, options);
  rejectIssues([...issues, ...additional], omitted);
}

function partialSchema(schema: ToolSchema) {
  return object({ candidateHash: hashSchema, ...Object.fromEntries(partKeys.map((key) =>
    [key, { ...structuredClone(schema.properties![key]!), minItems: 0 }])) });
}

function shortScopeItems(items: ToolSchema | undefined) {
  const branch = (field: string) => items?.anyOf?.find((value) => value.additionalProperties === false
    && ["acceptanceId", field, "sufficient", "reason"].every((key) => Object.hasOwn(value.properties ?? {}, key))
    && Object.keys(value.properties ?? {}).length === 4 && value.required?.length === 4 && new Set(value.required).size === 4
    && value.required.every((key) => ["acceptanceId", field, "sufficient", "reason"].includes(key)));
  const selector = branch("adapterRulePath"), receipt = branch("scopeReceiptId");
  return selector && receipt ? { anyOf: [structuredClone(selector), structuredClone(receipt)] } : items;
}

/** Structurally valid, canonical fields only; rejected drafts grant no evidence or review status. */
export function canonicalArchitectureReviewPartsDraft(value: unknown, { schema, candidateHash }: Pick<PartOptions, "schema" | "candidateHash">): ReviewParts {
  let input: unknown;
  try { input = copy(value); } catch { fail("reviewParts", "invalid_type", "评审分项必须是有界普通JSON，不能包含访问器或会话引用。"); }
  const feedback = architectureToolValidation(input, partialSchema(schema), { root: "reviewParts" });
  if (!feedback.valid) throw Object.assign(new InputError("评审分项格式无效：" + JSON.stringify(feedback)), { validationIssue: feedback.issues[0], validationIssues: feedback.issues });
  const parts = input as ReviewParts;
  if (parts.candidateHash !== candidateHash) fail("reviewParts.candidateHash", "candidate_mismatch", "评审分项不属于当前候选。");
  for (const key of partKeys) {
    const id = keys[key];
    const ids = parts[key].map((row) => objectFields(row)[id]);
    if (new Set(ids).size !== ids.length) fail(`reviewParts.${key}`, "invalid_reference", "同一分项编号不能重复。");
  }
  return parts;
}

/** Saved rows contain exact canonical evidence, never live receipts or a final verdict. */
export function canonicalArchitectureReviewParts(value: unknown, { schema, candidateHash, context, priorFindings, signal }: PartOptions) {
  signal?.throwIfAborted();
  const parts = canonicalArchitectureReviewPartsDraft(value, { schema, candidateHash });
  validatePartIssues(parts, { context, priorFindings });
  signal?.throwIfAborted();
  return parts;
}

export function createArchitectureReviewParts({ schema, toolSchema = schema, candidateHash, context, priorFindings, initial, initialRejected,
  resolve = (value) => value, signal, onSave, onRejected, remainingModelCalls }: PartOptions & { toolSchema?: ToolSchema; initial?: unknown; initialRejected?: unknown; resolve?: (value: unknown) => unknown; onSave?: ((value: ReviewParts) => unknown | Promise<unknown>) | undefined; onRejected?: ((value: ReviewParts) => unknown | Promise<unknown>) | undefined; remainingModelCalls?: (() => number) | undefined }) {
  const nonce = randomUUID(), options = { schema, candidateHash, context, priorFindings, signal };
  let parts = canonicalArchitectureReviewParts(initial ?? empty(candidateHash), options);
  let rejectedParts = initialRejected == null ? null : canonicalArchitectureReviewPartsDraft(initialRejected, options), persistenceError: unknown;
  const assertActive = () => { signal?.throwIfAborted(); if (persistenceError) throw persistenceError; };
  const persist = async (callback: ((value: ReviewParts) => unknown | Promise<unknown>) | undefined, value: ReviewParts) => {
    assertActive();
    try { await callback?.(value); } catch (error) { persistenceError ??= error; throw error; }
    assertActive();
  };
  const rejectedPartsHash = () => rejectedParts ? hashValue({ nonce, candidateHash, rejectedParts }) : null;
  const closureIssues = (value = parts) => architecturePriorFindingClosureIssues(value, priorFindings, objectFields(context).candidate, context);
  const checkSchema = schema.properties!.checks!;
  const requiredChecks = (checkSchema.items!.properties!.id!.enum! as string[]).slice(0,
    objectFields(objectFields(context).candidate).schemaVersion === 3 ? undefined : checkSchema.minItems as number | undefined);
  const needed = { checks: requiredChecks,
    acceptanceScopeChecks: schema.required!.includes("acceptanceScopeChecks") ? getRows(objectFields(objectFields(context).candidate).acceptance ?? []).map((row) => String(row.id)) : [],
    priorFindingDecisions: schema.required!.includes("priorFindingDecisions") ? getRows(objectFields(priorFindings).findings ?? []).map((row) => String(row.findingId)) : [] };
  const rejectedDiagnostics = (value: ReviewParts) => {
    const complete = (Object.keys(needed) as (keyof typeof needed)[]).every(key => needed[key].every(id => value[key].some(row => objectFields(row)[keys[key]] === id)));
    try { validatePartIssues(value, { ...options, complete }, closureIssues(value)); return []; }
    catch (error) {
      if (!(error instanceof InputError) || !error.validationIssue) throw error;
      return ((error.validationIssues ?? [error.validationIssue]) as ReviewDiagnosticIssue[]).slice(0, 64);
    }
  };
  let rejectedPartsIssues = rejectedParts ? rejectedDiagnostics(rejectedParts) : [];
  const legacyIncomplete = new Set(closureIssues().map((issue) => issue.findingId));
  const missing = (issues = closureIssues()): Record<"checks" | "acceptanceScopeChecks" | "priorFindingDecisions", string[]> => {
    const incomplete = new Set(issues.map((issue) => issue.findingId));
    return Object.fromEntries((Object.keys(needed) as (keyof typeof needed)[]).map(key =>
      [key, needed[key].filter((id) => !parts[key].some((row) => objectFields(row)[keys[key]] === id) || key === "priorFindingDecisions" && incomplete.has(id))])) as Record<"checks" | "acceptanceScopeChecks" | "priorFindingDecisions", string[]>;
  };
  const progressHash = () => hashValue({ nonce, candidateHash, parts });
  const batch = (gaps = missing()) => {
    if (typeof remainingModelCalls !== "function") return undefined;
    const queue = (["acceptanceScopeChecks", "priorFindingDecisions", "checks"] as const)
      .flatMap((key) => gaps[key].map((id) => ({ key, id }))), remaining = remainingModelCalls();
    const reservedModelCalls = 2, slots = Math.max(1, remaining - reservedModelCalls);
    const count = Math.max(Math.min(6, queue.length), Math.ceil(queue.length / slots));
    const ids: Record<"checks" | "acceptanceScopeChecks" | "priorFindingDecisions", string[]> = { acceptanceScopeChecks: [], priorFindingDecisions: [], checks: [] };
    for (const { key, id } of queue.slice(0, count)) ids[key].push(id);
    return { stage: remaining <= reservedModelCalls ? "final-only" : !queue.length ? "submit"
      : count === queue.length ? "submit-with-parts" : "save",
      ...ids, remainingModelCalls: remaining, reservedModelCalls };
  };
  const reference = () => {
    const pending = closureIssues(), gaps = missing(pending);
    return { candidateHash, progressHash: progressHash(), trust: "untrusted-progress", complete: false,
      saveToolName: "save_architecture_review_parts", submitToolName: "submit_architecture_review_parts", missing: gaps,
      ...(rejectedParts ? { rejectedPartsHash: rejectedPartsHash(), rejectedPartsTrust: "untrusted-reference", rejectedPartsIssues: copy(rejectedPartsIssues) } : {}),
      ...(pending.length ? { pendingNativeClosures: pending } : {}),
      ...(typeof remainingModelCalls === "function" ? { batch: batch(gaps) } : {}) };
  };
  const verify = (value: UnknownRecord) => {
    signal?.throwIfAborted();
    if (value.candidateHash !== candidateHash || value.progressHash !== progressHash())
      fail("reviewParts.progressHash", "invalid_reference", "分项版本已变化或不属于本轮，请使用宿主最新reviewParts.progressHash。");
  };
  const arrayProperties: Record<string, ToolSchema> = Object.fromEntries(partKeys.map((key) => [key, { ...structuredClone(toolSchema.properties![key]!), minItems: 0 }]));
  if (typeof remainingModelCalls === "function" && Array.isArray(arrayProperties.acceptanceScopeChecks!.items?.anyOf))
    arrayProperties.acceptanceScopeChecks!.items = shortScopeItems(arrayProperties.acceptanceScopeChecks!.items)!;
  const saveParameters = object({ candidateHash: hashSchema, progressHash: hashSchema, ...arrayProperties,
    rejectedPartsHash: hashSchema,
    removeIssueIds: { type: "array", maxItems: schema.properties!.issues!.maxItems, uniqueItems: true, items: schema.properties!.issues!.items!.properties!.id! } }, ["candidateHash", "progressHash"]);
  const assembleParameters = object({ candidateHash: hashSchema, progressHash: hashSchema,
    verdict: structuredClone(schema.properties!.verdict!), summary: structuredClone(schema.properties!.summary!) });
  const submitParameters = { ...structuredClone(assembleParameters), properties: { ...structuredClone(assembleParameters.properties),
    ...structuredClone(arrayProperties), rejectedPartsHash: hashSchema, removeIssueIds: structuredClone(saveParameters.properties.removeIssueIds) } };
  const handlers = { saveParameters, submitParameters, reference, snapshot: () => copy(parts),
    rejectedSnapshot: () => rejectedParts ? copy(rejectedParts) : null, assertActive,
    validateSubmission(input: unknown) {
      const value = objectFields(input);
      assertActive();
      const draft = canonicalArchitectureReviewPartsDraft({ ...empty(candidateHash), candidateHash: value.candidateHash,
        ...Object.fromEntries(partKeys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) }, options);
      validatePartIssues(draft, options, closureIssues(draft));
    },
    async save(input: unknown, { complete = false } = {}) {
      assertActive();
      const value = objectFields(copy(input)), feedback = architectureToolValidation(value, saveParameters, { root: "reviewParts" });
      if (!feedback.valid) throw Object.assign(new InputError("评审分项保存参数无效：" + JSON.stringify(feedback)), { validationIssue: feedback.issues[0] });
      verify(value);
      if (Object.hasOwn(value, "rejectedPartsHash") && (!rejectedParts || value.rejectedPartsHash !== rejectedPartsHash()))
        fail("reviewParts.rejectedPartsHash", "invalid_reference", "被拒草稿编号已变化或不属于当前会话，请使用最新 rejectedPartsHash。");
      if (!Object.keys(keys).some((key) => objectFields(value[key]).length) && !objectFields(value.removeIssueIds).length)
        fail("reviewParts", "required_field", "至少保存一个真实分项或明确移除已有问题。");
      const next = rawParts(copy(value.rejectedPartsHash ? rejectedParts! : parts)), supplied = objectFields(resolve({ candidateHash,
        ...Object.fromEntries(partKeys.filter((key) => value[key]).map((key) => [key, value[key]])) }));
      for (const id of (value.removeIssueIds ?? []) as string[]) {
        if (!next.issues.some((row) => row.id === id)) fail("reviewParts.removeIssueIds", "invalid_reference", "只能明确移除已保存的问题编号。");
        next.issues = next.issues.filter((row) => row.id !== id);
      }
      for (const key of partKeys) {
        const id = keys[key];
        const rows = getRows(supplied[key] ?? []), ids = rows.map((row) => row[id]);
        if (new Set(ids).size !== ids.length) fail(`reviewParts.${key}`, "invalid_reference", "一次保存不能重复同一编号。");
        for (const row of rows) {
          const index = next[key].findIndex((old) => old[id] === row[id]);
          if (index < 0) next[key].push(row); else next[key][index] = row;
        }
      }
      const draft = canonicalArchitectureReviewPartsDraft(next, options);
      let checked, pending;
      const touched = new Set([
        ...getRows(supplied.priorFindingDecisions ?? []).map((row) => row.findingId),
        ...getRows(supplied.issues ?? []).map((row) => row.id), ...((value.removeIssueIds ?? []) as string[]),
      ]);
      try {
        checked = draft;
        pending = closureIssues(checked);
        const rejected = pending.filter((issue) => !legacyIncomplete.has(issue.findingId) || touched.has(issue.findingId));
        validatePartIssues(checked, { ...options, complete }, rejected);
      } catch (error) {
        if (!(error instanceof InputError) || !error.validationIssue) throw error;
        await persist(onRejected, copy(draft)); rejectedParts = draft;
        rejectedPartsIssues = ((error.validationIssues ?? [error.validationIssue]) as ReviewDiagnosticIssue[]).slice(0, 64);
        error.message += "；被拒内容仅作为未通过草稿保留。可用最新 rejectedPartsHash 为基底，仅重交需修正的行；所有行仍须完整校验："
          + JSON.stringify({ candidateHash, progressHash: progressHash(), rejectedPartsHash: rejectedPartsHash() });
        throw error;
      }
      const ordered = (value: ReviewParts) => Object.fromEntries(partKeys.map(key =>
        [key, value[key].slice().sort((left, right) => String(objectFields(left)[keys[key]]).localeCompare(String(objectFields(right)[keys[key]])))]));
      const changed = !isDeepStrictEqual(ordered(checked), ordered(parts));
      if (typeof remainingModelCalls === "function" && !changed)
        fail("reviewParts", "no_progress", "本次保存没有改变真实分项；继续当前待办或明确修正已有判断，不能重复保存刷新进度。");
      await persist(onSave, checked); parts = checked; rejectedParts = null; rejectedPartsIssues = [];
      const stillIncomplete = new Set(pending.map((issue) => issue.findingId));
      for (const id of legacyIncomplete) if (!stillIncomplete.has(id)) legacyIncomplete.delete(id);
      return { saved: true, changed, submitted: false, ...reference() };
    },
    assemble(input: unknown): ArchitectureReview {
      assertActive();
      const value = objectFields(copy(input)), feedback = architectureToolValidation(value, assembleParameters, { root: "reviewParts" });
      if (!feedback.valid) fail(feedback.issues[0]!.path, feedback.issues[0]!.reason, "最终分项提交参数无效。");
      verify(value);
      const gaps = missing();
      if (Object.values(gaps).some((ids) => ids.length)) fail("reviewParts", "missing_coverage", "评审分项尚未完整：" + JSON.stringify(gaps));
      const review: ArchitectureReview = { candidateHash, verdict: value.verdict as ArchitectureReview["verdict"], checks: copy(parts.checks), issues: copy(parts.issues), summary: value.summary as string };
      for (const key of ["acceptanceScopeChecks", "priorFindingDecisions"] as const)
        if (schema.required!.includes(key) || parts[key].length) Object.assign(review, { [key]: copy(parts[key]) });
      return review;
    },
    async finalize(input: unknown) {
      assertActive();
      const value = objectFields(copy(input)), feedback = architectureToolValidation(value, submitParameters, { root: "reviewParts" });
      if (!feedback.valid) fail(feedback.issues[0]!.path, feedback.issues[0]!.reason, "最终分项提交参数无效。");
      verify(value);
      const updateKeys = [...Object.keys(keys), "removeIssueIds", "rejectedPartsHash"].filter((key) => Object.hasOwn(value, key));
      if (updateKeys.length) await handlers.save({ candidateHash, progressHash: value.progressHash,
        ...Object.fromEntries(updateKeys.map((key) => [key, value[key]])) }, { complete: true });
      return handlers.assemble({ candidateHash, progressHash: progressHash(), verdict: value.verdict, summary: value.summary });
    },
  };
  return handlers;
}
