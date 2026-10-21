import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { InputError } from "../requirements/core.mjs";
import { ACCEPTANCE_ADAPTERS, ACCEPTANCE_ADAPTER_GUIDE, validateAcceptanceVerification } from "../verification/acceptance-contract.mjs";

const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const text = (maxLength = 2000) => ({ type: "string", minLength: 1, maxLength });
const sources = ["candidate", "requirements", "runtimeCapabilities", "contextManifest", "evidence", "confirmedRequirementContext", "deferredVerifications", "acceptanceAdapterGuide"];
const source = { type: "string", enum: sources };
const pointer = { type: "string", minLength: 0, maxLength: 500 };
export const REVIEW_ISSUE_EVIDENCE_PROPERTIES = Object.freeze({
  checkId: { type: "string", enum: ["requirements", "feasibility", "minimality", "interfaces", "failure_handling", "verification", "requirement_sufficiency", "acceptance_quality"] },
  kind: { type: "string", enum: ["design", "platform", "context"] },
  candidatePaths: { type: "array", items: pointer, minItems: 1, maxItems: 12, uniqueItems: true },
  references: { type: "array", minItems: 1, maxItems: 12, items: object({ source, path: pointer, quote: text(1000) }) },
  factClaims: { type: "array", minItems: 0, maxItems: 12, items: object({ source: { type: "string", enum: ["runtimeCapabilities", "contextManifest"] },
    path: pointer, expectedJson: text(4000) }) },
});

export const ACCEPTANCE_SCOPE_CHECKS_SCHEMA = {
  type: "array", minItems: 1, maxItems: 80,
  items: object({ acceptanceId: text(80), adapterId: { type: "string", enum: Object.keys(ACCEPTANCE_ADAPTERS) },
    scope: { type: "string", enum: Object.values(ACCEPTANCE_ADAPTERS).map((item) => item.scope) }, sufficient: { type: "boolean" },
    reason: text(1200), criterionQuote: text(1000), adapterQuote: text(1000) }),
  description: "每项候选验收恰好一行，逐字引用该项 expected 及其适配器指南，独立判断检查范围能否证明完整承诺；不足时 acceptance_quality 必须失败并附引用该验收路径的阻断。跨范围承诺应拆分。",
};

function evidenceErrors() {
  const issues = [], seen = new Set();
  let total = 0;
  return {
    add(path, reason, remedy) {
      const key = `${path}:${reason}`;
      if (seen.has(key)) return;
      seen.add(key); total++;
      if (issues.length < 64) issues.push({ path, reason, remedy });
    },
    reject() {
      if (!issues.length) return;
      const { path, reason, remedy } = issues[0];
      throw Object.assign(new InputError(`架构评审依据无效：${path} ${remedy}`), {
        validationIssue: { path, reason }, validationIssues: issues,
        validationIssueTotal: total, validationIssuesTruncated: total > issues.length,
      });
    },
  };
}

function at(value, pointer) {
  if (pointer === "") return { found: true, value };
  if (typeof pointer !== "string" || !pointer.startsWith("/") || /~(?![01])/u.test(pointer)) return { found: false };
  let current = value;
  for (const part of pointer.slice(1).split("/").map((entry) => entry.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (["__proto__", "prototype", "constructor"].includes(part) || !current || typeof current !== "object") return { found: false };
    const entry = Object.getOwnPropertyDescriptor(current, part);
    if (!entry || !Object.hasOwn(entry, "value")) return { found: false };
    current = entry.value;
  }
  return { found: true, value: current };
}

export function architectureReviewEvidenceContext({ design, requirements, runtimeCapabilities, evidence = [], confirmedRequirementContext = null,
  deferredVerifications = null, acceptanceAdapterGuide = ACCEPTANCE_ADAPTER_GUIDE }) {
  const values = { candidate: design, requirements, runtimeCapabilities, evidence, confirmedRequirementContext, deferredVerifications, acceptanceAdapterGuide };
  const contextManifest = Object.fromEntries(Object.entries(values).map(([key, value]) => {
    const encoded = JSON.stringify(value);
    return [key, { delivery: "full", characters: encoded.length, sha256: createHash("sha256").update(encoded).digest("hex") }];
  }));
  return structuredClone({ ...values, contextManifest });
}

export function architectureReviewPathExists(value, pointer) { return at(value, pointer).found; }

export function validateArchitectureReviewEvidence(review, context, { partial = false } = {}) {
  const errors = evidenceErrors(), fail = errors.add;
  const checks = new Map(review.checks.map((entry) => [entry.id, entry]));
  for (const [index, issue] of review.issues.entries()) {
    const path = `review.issues[${index}]`;
    if (!issue.blocking && issue.checkId === undefined) continue;
    if (!partial && !checks.has(issue.checkId)) fail(`${path}.checkId`, "invalid_reference", "必须引用本次评审检查项");
    if (issue.blocking && checks.get(issue.checkId)?.passed) fail(`${path}.checkId`, "contradictory_review", "阻断必须关联未通过检查项，不能同时声称该项已通过");
    if (!Array.isArray(issue.candidatePaths) || !issue.candidatePaths.length)
      fail(`${path}.candidatePaths`, "candidate_path_missing", "候选路径不存在；必须引用当前候选中实际存在的 JSON Pointer 路径");
    else for (const [position, pointer] of issue.candidatePaths.entries()) if (!at(context.candidate, pointer).found)
      fail(`${path}.candidatePaths[${position}]`, "candidate_path_missing", "候选路径不存在；必须引用当前候选中实际存在的 JSON Pointer 路径");
    if (!Array.isArray(issue.references) || !issue.references.length) fail(`${path}.references`, "required_field", "必须给出当前材料的逐字依据");
    for (const [position, reference] of (Array.isArray(issue.references) ? issue.references : []).entries()) {
      if (!sources.includes(reference.source)) {
        fail(`${path}.references[${position}]`, "reference_source_invalid", "引用来源无效；请使用本轮提供的材料来源");
        continue;
      }
      const current = at(context[reference.source], reference.path);
      const serialized = current.found ? typeof current.value === "string" ? current.value : JSON.stringify(current.value) : "";
      if (!current.found) fail(`${path}.references[${position}]`, "reference_path_missing", "引用路径不存在；核对当前材料的 JSON Pointer 路径，可用 read_architecture_evidence 读取本轮原文并以 receiptId 引用");
      else if (typeof reference.quote !== "string" || !reference.quote.trim() || !serialized?.includes(reference.quote))
        fail(`${path}.references[${position}]`, "reference_quote_mismatch", "路径存在但逐字摘录不匹配；请复制本轮该路径的实际文本，不要沿用旧评语或改写，可用 read_architecture_evidence 读取本轮原文并以 receiptId 引用");
    }
    if (!Array.isArray(issue.factClaims) || ["platform", "context"].includes(issue.kind) && !issue.factClaims.length)
      fail(`${path}.factClaims`, "required_field", "平台或上下文缺失的阻断必须提交可由宿主核实的事实断言");
    for (const [position, claim] of (Array.isArray(issue.factClaims) ? issue.factClaims : []).entries()) {
      const current = ["runtimeCapabilities", "contextManifest"].includes(claim.source) ? at(context[claim.source], claim.path) : { found: false };
      let expected;
      try { expected = JSON.parse(claim.expectedJson); } catch {
        fail(`${path}.factClaims[${position}].expectedJson`, "invalid_value", "必须是完整 JSON 值");
        continue;
      }
      if (!current.found || !isDeepStrictEqual(current.value, expected))
        fail(`${path}.factClaims[${position}]`, "fact_mismatch", "当前宿主事实不支持此断言；在原评审会话内核对材料并纠正，不自动放行候选");
    }
  }
  for (const check of review.checks) if (!partial && !check.passed && !review.issues.some((entry) => entry.blocking && entry.checkId === check.id))
    fail("review.issues", "missing_check_issue", "每个未通过检查项必须有对应的具体阻断问题；不要另外复制检查项为新义务");
  if (context.candidate.schemaVersion >= 3) validateAcceptanceScopeChecks(review, context, checks, fail, partial);
  errors.reject();
  return structuredClone(review);
}

function matchesAdapterQuote(quote, guide, adapterId) {
  const adapter = guide?.adapters?.[adapterId];
  const contains = (values) => values.some((value) => typeof value === "string" && value.includes(quote));
  if (contains([adapter?.proves, adapter?.doesNotProve, adapter?.splitRule])) return true;
  // New explanatory fields are eligible evidence; identifiers and function names alone are not rules.
  if (/^[A-Za-z_$][\w$]*(?:[-.][A-Za-z_$][\w$]*)*$/u.test(quote.trim())) return false;
  const composition = guide?.composition, admission = guide?.admission?.[adapterId];
  return contains([adapter?.executionRule, composition?.caseSetRule, composition?.requirementCoverageRule, composition?.splitRule,
    ...(adapterId === "host-business" ? [composition?.hostBusinessRule] : []), admission?.rule, admission?.measure, admission?.outcomeRule,
    ...(Array.isArray(admission?.excludedProof) ? admission.excludedProof : [])]);
}

function validateAcceptanceScopeChecks(review, context, checks, fail, partial = false) {
  const acceptance = context.candidate.acceptance ?? [], rows = review.acceptanceScopeChecks;
  if (!Array.isArray(rows) || !partial && rows.length !== acceptance.length) fail("review.acceptanceScopeChecks", "missing_coverage", "每项当前验收必须恰好有一条验证范围判断");
  if (!Array.isArray(rows)) return;
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    const path = `review.acceptanceScopeChecks[${index}]`, position = acceptance.findIndex((item) => item.id === row.acceptanceId);
    if (position < 0 || seen.has(row.acceptanceId)) {
      fail(`${path}.acceptanceId`, "invalid_reference", "验收编号必须来自本轮候选且不能重复");
      continue;
    }
    seen.add(row.acceptanceId);
    const criterion = acceptance[position], descriptor = validateAcceptanceVerification(criterion);
    const adapter = context.acceptanceAdapterGuide?.adapters?.[descriptor.adapterId];
    if (!adapter || row.adapterId !== descriptor.adapterId || row.scope !== ACCEPTANCE_ADAPTERS[descriptor.adapterId].scope
      || adapter.scope !== ACCEPTANCE_ADAPTERS[descriptor.adapterId].scope)
      fail(`${path}.adapterId`, "scope_mismatch", "必须核对本条候选实际选择的适配器及其固定验证范围");
    if (typeof row.criterionQuote !== "string" || !row.criterionQuote.trim() || !criterion.expected.includes(row.criterionQuote))
      fail(`${path}.criterionQuote`, "reference_quote_mismatch", "必须逐字引用本条验收 expected 的实际承诺");
    if (typeof row.adapterQuote !== "string" || !row.adapterQuote.trim()
      || !matchesAdapterQuote(row.adapterQuote, context.acceptanceAdapterGuide, descriptor.adapterId))
      fail(`${path}.adapterQuote`, "reference_quote_mismatch", "必须逐字引用本条适配器的范围、当前准入说明或通用组合规则；专属规则不可跨适配器引用");
    if (!partial && !row.sufficient && (checks.get("acceptance_quality")?.passed !== false
      || !review.issues.some((issue) => issue.blocking && issue.checkId === "acceptance_quality"
        && issue.candidatePaths?.some((pointer) => pointer === `/acceptance/${position}` || pointer.startsWith(`/acceptance/${position}/`)))))
      fail(`${path}.sufficient`, "missing_scope_issue", "验证范围不足时 acceptance_quality 必须失败，并有准确引用本条验收的阻断问题");
  }
}

export function architectureReviewIssues(programIssues, review) {
  const result = programIssues.map((entry) => structuredClone(entry));
  const model = review.issues.map((entry) => ({ ...structuredClone(entry), source: "model" }));
  // Stable IDs or exact evidence identify repetitions; distinct remedies remain visible.
  for (const entry of model) {
    const duplicate = result.find((previous) => previous.source === "model" && (previous.id === entry.id
      || previous.checkId === entry.checkId && isDeepStrictEqual(previous.candidatePaths, entry.candidatePaths)
      && isDeepStrictEqual(previous.references, entry.references) && previous.description === entry.description && previous.remedy === entry.remedy));
    if (!duplicate) result.push(entry);
  }
  for (const check of review.checks.filter((entry) => !entry.passed)) if (!model.some((entry) => entry.blocking && entry.checkId === check.id))
    result.push({ id: `review_${check.id}`, blocking: true, description: check.evidence, remedy: "修正此检查项后重新评估", source: "model" });
  return result;
}
