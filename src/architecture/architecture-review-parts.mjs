import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { InputError } from "../requirements/core.mjs";
import { hashValue } from "../development/development-contract.mjs";
import { copyArchitectureReviewJson } from "./architecture-review-binding.mjs";
import { architectureToolValidation } from "./architecture-tool-diagnostics.mjs";
import { architectureReviewPathExists, validateArchitectureReviewEvidence } from "./architecture-review-evidence.mjs";
import { architecturePriorFindingClosureIssues } from "./architecture-prior-findings.mjs";

export const REVIEW_PARTS_MAX_BYTES = 256 * 1024;
const keys = { checks: "id", issues: "id", acceptanceScopeChecks: "acceptanceId", priorFindingDecisions: "findingId" };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const hashSchema = { type: "string", pattern: "^[a-f0-9]{64}$" };
const copy = (value) => copyArchitectureReviewJson(value, { maxDepth: 32, maxNodes: 100_000, maxBytes: REVIEW_PARTS_MAX_BYTES });
const empty = (candidateHash) => ({ candidateHash, checks: [], issues: [], acceptanceScopeChecks: [], priorFindingDecisions: [] });
const fail = (path, reason, message) => { throw Object.assign(new InputError(message), { validationIssue: { path, reason } }); };

function rejectIssues(values, omitted = 0) {
  const all = [...new Map(values.map(issue => [JSON.stringify([issue.path, issue.reason, issue.candidatePath]), issue])).values()];
  if (!all.length) return;
  const issues = all.slice(0, 64), total = all.length + omitted, truncated = total > issues.length;
  throw Object.assign(new InputError("评审分项尚有可确定的问题：" + JSON.stringify({ issues, total, truncated })), {
    validationIssue: issues[0], validationIssues: issues, validationIssueTotal: total, validationIssuesTruncated: truncated,
  });
}

function partIssues(parts, { context, priorFindings, complete = false }) {
  const issues = [];
  let omitted = 0;
  if (context) {
    try { validateArchitectureReviewEvidence(parts, context, { partial: !complete }); }
    catch (error) {
      if (!(error instanceof InputError) || !error.validationIssue) throw error;
      const kept = error.validationIssues ?? [error.validationIssue];
      issues.push(...kept); omitted += Math.max(0, (error.validationIssueTotal ?? kept.length) - kept.length);
    }
  }
  const findings = new Set((priorFindings?.findings ?? []).map(row => row.findingId));
  for (const [index, row] of parts.priorFindingDecisions.entries()) {
    if (!findings.has(row.findingId)) issues.push({ path: `reviewParts.priorFindingDecisions[${index}].findingId`, reason: "invalid_reference",
      remedy: "历史问题编号必须来自当前清单；优先选择本轮findingRef，由宿主填回完整编号。" });
    if (context && row.candidatePaths.some(path => !architectureReviewPathExists(context.candidate, path)))
      issues.push({ path: `reviewParts.priorFindingDecisions[${index}].candidatePaths`, reason: "candidate_path_missing",
        remedy: "历史问题决定必须引用当前候选实际存在的位置。" });
  }
  return { issues, omitted };
}

function validatePartIssues(parts, options, additional = []) {
  const { issues, omitted } = partIssues(parts, options);
  rejectIssues([...issues, ...additional], omitted);
}

function partialSchema(schema) {
  return object({ candidateHash: hashSchema, ...Object.fromEntries(Object.keys(keys).map((key) =>
    [key, { ...structuredClone(schema.properties[key]), minItems: 0 }])) });
}

function shortScopeItems(items) {
  const branch = (field) => items?.anyOf?.find((value) => value.additionalProperties === false
    && ["acceptanceId", field, "sufficient", "reason"].every((key) => Object.hasOwn(value.properties ?? {}, key))
    && Object.keys(value.properties ?? {}).length === 4 && value.required?.length === 4 && new Set(value.required).size === 4
    && value.required.every((key) => ["acceptanceId", field, "sufficient", "reason"].includes(key)));
  const selector = branch("adapterRulePath"), receipt = branch("scopeReceiptId");
  return selector && receipt ? { anyOf: [structuredClone(selector), structuredClone(receipt)] } : items;
}

/** Structurally valid, canonical fields only; rejected drafts grant no evidence or review status. */
export function canonicalArchitectureReviewPartsDraft(value, { schema, candidateHash } = {}) {
  let parts;
  try { parts = copy(value); } catch { fail("reviewParts", "invalid_type", "评审分项必须是有界普通JSON，不能包含访问器或会话引用。"); }
  const feedback = architectureToolValidation(parts, partialSchema(schema), { root: "reviewParts" });
  if (!feedback.valid) throw Object.assign(new InputError("评审分项格式无效：" + JSON.stringify(feedback)), { validationIssue: feedback.issues[0], validationIssues: feedback.issues });
  if (parts.candidateHash !== candidateHash) fail("reviewParts.candidateHash", "candidate_mismatch", "评审分项不属于当前候选。");
  for (const [key, id] of Object.entries(keys)) {
    const ids = parts[key].map((row) => row[id]);
    if (new Set(ids).size !== ids.length) fail(`reviewParts.${key}`, "invalid_reference", "同一分项编号不能重复。");
  }
  return parts;
}

/** Saved rows contain exact canonical evidence, never live receipts or a final verdict. */
export function canonicalArchitectureReviewParts(value, { schema, candidateHash, context, priorFindings, signal } = {}) {
  signal?.throwIfAborted();
  const parts = canonicalArchitectureReviewPartsDraft(value, { schema, candidateHash });
  validatePartIssues(parts, { context, priorFindings });
  signal?.throwIfAborted();
  return parts;
}

export function createArchitectureReviewParts({ schema, toolSchema = schema, candidateHash, context, priorFindings, initial, initialRejected,
  resolve = (value) => value, signal, onSave, onRejected, remainingModelCalls } = {}) {
  const nonce = randomUUID(), options = { schema, candidateHash, context, priorFindings, signal };
  let parts = canonicalArchitectureReviewParts(initial ?? empty(candidateHash), options);
  let rejectedParts = initialRejected == null ? null : canonicalArchitectureReviewPartsDraft(initialRejected, options), persistenceError;
  const assertActive = () => { signal?.throwIfAborted(); if (persistenceError) throw persistenceError; };
  const persist = async (callback, value) => {
    assertActive();
    try { await callback?.(value); } catch (error) { persistenceError ??= error; throw error; }
    assertActive();
  };
  const rejectedPartsHash = () => rejectedParts ? hashValue({ nonce, candidateHash, rejectedParts }) : null;
  const closureIssues = (value = parts) => architecturePriorFindingClosureIssues(value, priorFindings, context?.candidate, context);
  const requiredChecks = schema.properties.checks.items.properties.id.enum.slice(0,
    context?.candidate.schemaVersion >= 3 ? undefined : schema.properties.checks.minItems);
  const needed = { checks: requiredChecks,
    acceptanceScopeChecks: schema.required.includes("acceptanceScopeChecks") ? (context?.candidate.acceptance ?? []).map((row) => row.id) : [],
    priorFindingDecisions: schema.required.includes("priorFindingDecisions") ? (priorFindings?.findings ?? []).map((row) => row.findingId) : [] };
  const rejectedDiagnostics = value => {
    const complete = Object.entries(needed).every(([key, ids]) => ids.every(id => value[key].some(row => row[keys[key]] === id)));
    try { validatePartIssues(value, { ...options, complete }, closureIssues(value)); return []; }
    catch (error) {
      if (!(error instanceof InputError) || !error.validationIssue) throw error;
      return (error.validationIssues ?? [error.validationIssue]).slice(0, 64);
    }
  };
  let rejectedPartsIssues = rejectedParts ? rejectedDiagnostics(rejectedParts) : [];
  const legacyIncomplete = new Set(closureIssues().map((issue) => issue.findingId));
  const missing = (issues = closureIssues()) => {
    const incomplete = new Set(issues.map((issue) => issue.findingId));
    return Object.fromEntries(Object.entries(needed).map(([key, ids]) =>
      [key, ids.filter((id) => !parts[key].some((row) => row[keys[key]] === id) || key === "priorFindingDecisions" && incomplete.has(id))]));
  };
  const progressHash = () => hashValue({ nonce, candidateHash, parts });
  const batch = (gaps = missing()) => {
    if (typeof remainingModelCalls !== "function") return undefined;
    const queue = ["acceptanceScopeChecks", "priorFindingDecisions", "checks"]
      .flatMap((key) => gaps[key].map((id) => ({ key, id }))), remaining = remainingModelCalls();
    const reservedModelCalls = 2, slots = Math.max(1, remaining - reservedModelCalls);
    const count = Math.max(Math.min(6, queue.length), Math.ceil(queue.length / slots));
    const ids = { acceptanceScopeChecks: [], priorFindingDecisions: [], checks: [] };
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
  const verify = (value) => {
    signal?.throwIfAborted();
    if (value.candidateHash !== candidateHash || value.progressHash !== progressHash())
      fail("reviewParts.progressHash", "invalid_reference", "分项版本已变化或不属于本轮，请使用宿主最新reviewParts.progressHash。");
  };
  const arrayProperties = Object.fromEntries(Object.keys(keys).map((key) => [key, { ...structuredClone(toolSchema.properties[key]), minItems: 0 }]));
  if (typeof remainingModelCalls === "function" && Array.isArray(arrayProperties.acceptanceScopeChecks.items?.anyOf))
    arrayProperties.acceptanceScopeChecks.items = shortScopeItems(arrayProperties.acceptanceScopeChecks.items);
  const saveParameters = object({ candidateHash: hashSchema, progressHash: hashSchema, ...arrayProperties,
    rejectedPartsHash: hashSchema,
    removeIssueIds: { type: "array", maxItems: schema.properties.issues.maxItems, uniqueItems: true, items: schema.properties.issues.items.properties.id } }, ["candidateHash", "progressHash"]);
  const assembleParameters = object({ candidateHash: hashSchema, progressHash: hashSchema,
    verdict: structuredClone(schema.properties.verdict), summary: structuredClone(schema.properties.summary) });
  const submitParameters = { ...structuredClone(assembleParameters), properties: { ...structuredClone(assembleParameters.properties),
    ...structuredClone(arrayProperties), rejectedPartsHash: hashSchema, removeIssueIds: structuredClone(saveParameters.properties.removeIssueIds) } };
  const handlers = { saveParameters, submitParameters, reference, snapshot: () => copy(parts),
    rejectedSnapshot: () => rejectedParts ? copy(rejectedParts) : null, assertActive,
    validateSubmission(value) {
      assertActive();
      const draft = canonicalArchitectureReviewPartsDraft({ ...empty(candidateHash), candidateHash: value.candidateHash,
        ...Object.fromEntries(Object.keys(keys).filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) }, options);
      validatePartIssues(draft, options, closureIssues(draft));
    },
    async save(input, { complete = false } = {}) {
      assertActive();
      const value = copy(input), feedback = architectureToolValidation(value, saveParameters, { root: "reviewParts" });
      if (!feedback.valid) throw Object.assign(new InputError("评审分项保存参数无效：" + JSON.stringify(feedback)), { validationIssue: feedback.issues[0] });
      verify(value);
      if (Object.hasOwn(value, "rejectedPartsHash") && (!rejectedParts || value.rejectedPartsHash !== rejectedPartsHash()))
        fail("reviewParts.rejectedPartsHash", "invalid_reference", "被拒草稿编号已变化或不属于当前会话，请使用最新 rejectedPartsHash。");
      if (!Object.keys(keys).some((key) => value[key]?.length) && !value.removeIssueIds?.length)
        fail("reviewParts", "required_field", "至少保存一个真实分项或明确移除已有问题。");
      const next = copy(value.rejectedPartsHash ? rejectedParts : parts), supplied = resolve({ candidateHash,
        ...Object.fromEntries(Object.keys(keys).filter((key) => value[key]).map((key) => [key, value[key]])) });
      for (const id of value.removeIssueIds ?? []) {
        if (!next.issues.some((row) => row.id === id)) fail("reviewParts.removeIssueIds", "invalid_reference", "只能明确移除已保存的问题编号。");
        next.issues = next.issues.filter((row) => row.id !== id);
      }
      for (const [key, id] of Object.entries(keys)) {
        const rows = supplied[key] ?? [], ids = rows.map((row) => row[id]);
        if (new Set(ids).size !== ids.length) fail(`reviewParts.${key}`, "invalid_reference", "一次保存不能重复同一编号。");
        for (const row of rows) {
          const index = next[key].findIndex((old) => old[id] === row[id]);
          if (index < 0) next[key].push(row); else next[key][index] = row;
        }
      }
      const draft = canonicalArchitectureReviewPartsDraft(next, options);
      let checked, pending;
      const touched = new Set([
        ...(supplied.priorFindingDecisions ?? []).map((row) => row.findingId),
        ...(supplied.issues ?? []).map((row) => row.id), ...(value.removeIssueIds ?? []),
      ]);
      try {
        checked = draft;
        pending = closureIssues(checked);
        const rejected = pending.filter((issue) => !legacyIncomplete.has(issue.findingId) || touched.has(issue.findingId));
        validatePartIssues(checked, { ...options, complete }, rejected);
      } catch (error) {
        if (!(error instanceof InputError) || !error.validationIssue) throw error;
        await persist(onRejected, copy(draft)); rejectedParts = draft;
        rejectedPartsIssues = (error.validationIssues ?? [error.validationIssue]).slice(0, 64);
        error.message += "；被拒内容仅作为未通过草稿保留。可用最新 rejectedPartsHash 为基底，仅重交需修正的行；所有行仍须完整校验："
          + JSON.stringify({ candidateHash, progressHash: progressHash(), rejectedPartsHash: rejectedPartsHash() });
        throw error;
      }
      const ordered = (value) => Object.fromEntries(Object.entries(keys).map(([key, id]) =>
        [key, value[key].slice().sort((left, right) => left[id].localeCompare(right[id]))]));
      const changed = !isDeepStrictEqual(ordered(checked), ordered(parts));
      if (typeof remainingModelCalls === "function" && !changed)
        fail("reviewParts", "no_progress", "本次保存没有改变真实分项；继续当前待办或明确修正已有判断，不能重复保存刷新进度。");
      await persist(onSave, checked); parts = checked; rejectedParts = null; rejectedPartsIssues = [];
      const stillIncomplete = new Set(pending.map((issue) => issue.findingId));
      for (const id of legacyIncomplete) if (!stillIncomplete.has(id)) legacyIncomplete.delete(id);
      return { saved: true, changed, submitted: false, ...reference() };
    },
    assemble(input) {
      assertActive();
      const value = copy(input), feedback = architectureToolValidation(value, assembleParameters, { root: "reviewParts" });
      if (!feedback.valid) fail(feedback.issues[0].path, feedback.issues[0].reason, "最终分项提交参数无效。");
      verify(value);
      const gaps = missing();
      if (Object.values(gaps).some((ids) => ids.length)) fail("reviewParts", "missing_coverage", "评审分项尚未完整：" + JSON.stringify(gaps));
      const review = { candidateHash, verdict: value.verdict, checks: copy(parts.checks), issues: copy(parts.issues), summary: value.summary };
      for (const key of ["acceptanceScopeChecks", "priorFindingDecisions"])
        if (schema.required.includes(key) || parts[key].length) review[key] = copy(parts[key]);
      return review;
    },
    async finalize(input) {
      assertActive();
      const value = copy(input), feedback = architectureToolValidation(value, submitParameters, { root: "reviewParts" });
      if (!feedback.valid) fail(feedback.issues[0].path, feedback.issues[0].reason, "最终分项提交参数无效。");
      verify(value);
      const updateKeys = [...Object.keys(keys), "removeIssueIds", "rejectedPartsHash"].filter((key) => Object.hasOwn(value, key));
      if (updateKeys.length) await handlers.save({ candidateHash, progressHash: value.progressHash,
        ...Object.fromEntries(updateKeys.map((key) => [key, value[key]])) }, { complete: true });
      return handlers.assemble({ candidateHash, progressHash: progressHash(), verdict: value.verdict, summary: value.summary });
    },
  };
  return handlers;
}
