import { InputError } from "../requirements/core.mjs";
import { hashValue } from "./development-contract.mjs";
import type { DevelopmentReview } from "../contracts/development.mjs";
import type { DevelopmentRunRecord } from "./development-controller-types.mjs";

export interface DevelopmentRetryPolicy {
  version: 1;
  legacy: { budgets: DevelopmentRunRecord["budgets"]; sourceHash: string };
  content: Record<string, { count: number; receipts: string[] }>;
  unresolved: Record<string, DevelopmentReview["issues"]>;
  continuations?: { owner: string; rejectedAt: number; receiptsHash: string; authorization: "explicit-user-resume" }[];
  hash: string;
}
export const DEVELOPMENT_CONTENT_LIMIT = 5;
export const DEVELOPMENT_FORMAT_LIMIT = 3;

export function sealDevelopmentPolicy(policy: DevelopmentRetryPolicy) {
  const { hash: _hash, ...body } = policy;
  policy.hash = hashValue(body);
  return policy;
}

export function readDevelopmentPolicy(policy: DevelopmentRetryPolicy) {
  const { hash, ...body } = policy;
  if (policy.version !== 1 || hash !== hashValue(body) || !policy.legacy
    || !/^[a-f0-9]{64}$/u.test(policy.legacy.sourceHash) || !policy.content || !policy.unresolved
    || Object.values(policy.content).some(row => !Number.isSafeInteger(row.count) || row.count < 0
      || !Array.isArray(row.receipts) || new Set(row.receipts).size !== row.receipts.length || row.receipts.length !== row.count
      || row.receipts.some(value => !/^[a-f0-9]{64}$/u.test(value)))
    || Object.values(policy.unresolved).some(rows => !Array.isArray(rows) || rows.some(row => row.blocking !== true)))
    throw new InputError("研发退回计数或未解决问题记录无效，不能清零恢复。");
  if (policy.continuations !== undefined && (!Array.isArray(policy.continuations)
    || policy.continuations.some(row => !row || typeof row.owner !== "string" || row.authorization !== "explicit-user-resume"
      || !Number.isSafeInteger(row.rejectedAt) || row.rejectedAt < DEVELOPMENT_CONTENT_LIMIT
      || !Object.hasOwn(policy.content, row.owner) || row.rejectedAt > policy.content[row.owner]!.count
      || row.receiptsHash !== hashValue(policy.content[row.owner]!.receipts.slice(0, row.rejectedAt)))
    || new Set(policy.continuations.map(row => `${row.owner}:${row.rejectedAt}`)).size !== policy.continuations.length))
    throw new InputError("研发续测授权与原退回回执不一致，不能增加重试机会。");
  return policy;
}

/** Only an explicitly recorded authorization extends a stopped task to its next content rejection. */
export function developmentContentLimit(record: { retryPolicy?: DevelopmentRetryPolicy }, owner: string) {
  if (!record.retryPolicy) return DEVELOPMENT_CONTENT_LIMIT;
  const policy = readDevelopmentPolicy(record.retryPolicy);
  return Math.max(DEVELOPMENT_CONTENT_LIMIT, ...policy.continuations?.filter(row => row.owner === owner).map(row => row.rejectedAt + 1) ?? []);
}

/** The user's policy upgrade retains original counters; no legacy quota is replenished. */
export function ensureDevelopmentPolicy(record: DevelopmentRunRecord) {
  if (record.retryPolicy) return readDevelopmentPolicy(record.retryPolicy);
  const source = { budgets: record.budgets, tasks: record.tasks.map(row => ({ id: row.id, repairs: row.repairs,
    integration: row.integration ?? false, nextAction: row.nextAction, feedback: row.feedback ?? null })), planAttempts: record.planAttempts };
  const policy: DevelopmentRetryPolicy = { version: 1, legacy: { budgets: structuredClone(record.budgets), sourceHash: hashValue(source) },
    content: {}, unresolved: {}, hash: "" };
  const inherit = (owner: string, count: number) => {
    if (!Number.isSafeInteger(count) || count < 0) throw new InputError("旧研发退回次数无法核验。");
    if (count) policy.content[owner] = { count, receipts: Array.from({ length: count }, (_, index) => hashValue({ legacy: policy.legacy.sourceHash, owner, index })) };
  };
  inherit("plan", record.planAttempts.filter(row => row.review.verdict !== "pass").length);
  for (const task of record.tasks.filter(row => !row.integration)) {
    const rejectedAtStop = task.feedback?.passed === false && task.nextAction === "verify" ? 1 : 0;
    inherit(`task:${task.id}`, task.repairs + rejectedAtStop);
    if (task.feedback?.passed === false) policy.unresolved[`task:${task.id}`] = task.feedback.review.issues.filter(row => row.blocking);
  }
  const integrationTasks = record.tasks.filter(row => row.integration);
  const pendingIntegration = record.feedback?.passed === false && record.phase === "verifying" && !record.currentTaskId
    && !integrationTasks.some(task => task.feedback?.report.id === (record.feedback?.report && "id" in record.feedback.report ? record.feedback.report.id : undefined));
  inherit("integration", integrationTasks.reduce((sum, task) => sum + 1 + task.repairs, 0) + (pendingIntegration ? 1 : 0));
  if (record.feedback?.review?.verdict !== "pass" && record.feedback?.review)
    policy.unresolved[record.feedback.rejectedPlan ? "plan" : "integration"] = record.feedback.review.issues.filter(row => row.blocking);
  record.retryPolicy = sealDevelopmentPolicy(policy);
  return policy;
}

export function unresolvedDevelopmentIssues(record: DevelopmentRunRecord) {
  return Object.entries(record.retryPolicy?.unresolved ?? {}).flatMap(([owner, issues]) => issues.map(issue => ({ owner, ...issue })));
}

export function noteDevelopmentRejection(record: DevelopmentRunRecord, owner: string, receipt: unknown, review?: DevelopmentReview) {
  const policy = ensureDevelopmentPolicy(record), key = hashValue(receipt), row = policy.content[owner] ??= { count: 0, receipts: [] };
  if (!row.receipts.includes(key)) { row.receipts.push(key); row.count++; }
  if (review) {
    const issues = new Map((policy.unresolved[owner] ?? []).map(issue => [hashValue(issue), issue]));
    for (const issue of review.issues.filter(issue => issue.blocking)) issues.set(hashValue(issue), structuredClone(issue));
    policy.unresolved[owner] = [...issues.values()];
  }
  sealDevelopmentPolicy(policy);
  return row.count;
}

export function closeDevelopmentFindings(record: DevelopmentRunRecord, owner?: string) {
  const policy = record.retryPolicy;
  if (!policy) return;
  if (owner) delete policy.unresolved[owner]; else policy.unresolved = {};
  sealDevelopmentPolicy(policy);
}

export function developmentPolicyBudget(record: DevelopmentRunRecord) {
  const policy = record.retryPolicy;
  if (!policy) return record.budgets;
  return { contentLimit: DEVELOPMENT_CONTENT_LIMIT, formatLimit: DEVELOPMENT_FORMAT_LIMIT, modelRequests: "usage-only",
    contentRejections: Object.fromEntries(Object.entries(policy.content).map(([owner, row]) => [owner, row.count])),
    ...(policy.continuations?.length ? { authorizedContentStops: Object.fromEntries(policy.continuations.map(row => [row.owner, developmentContentLimit(record, row.owner)])) } : {}) };
}
