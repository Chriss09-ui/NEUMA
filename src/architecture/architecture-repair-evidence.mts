import type { ArchitectureDesign, ArchitectureReview, ArchitectureIssue, ArchitectureEvidenceContext } from "../contracts/architecture.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
interface RepairAnchor { path: string; kind: string; id?: unknown; coreHash: string }
interface RepairBasis { version: 1; candidateHash: string; anchors: RepairAnchor[]; hash: string }
interface PriorDecision { status: string; candidatePaths: string[]; checkIds?: string[] }
interface RepairFinding { kind?: string; closureEvidenceRequired?: boolean; issue?: unknown; repairBasis?: unknown; findingId: string }
function candidateRows(candidate: unknown, field: string) { const value = objectFields(candidate)[field] ?? []; if (!Array.isArray(value)) throw new TypeError("候选条目必须为数组"); return value.map(objectFields); }
import { InputError } from "../requirements/core.mjs";
import { designHash } from "./architecture-contract.mjs";
import { copyArchitectureReviewJson } from "./architecture-review-binding.mjs";
import { architectureReviewEvidenceContext, validateArchitectureReviewEvidence } from "./architecture-review-evidence.mjs";
import { validateArchitecturePlatformClaims } from "./architecture-platform-claims.mjs";

const beneath = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
const contextFields = ["requirements", "runtimeCapabilities", "evidence", "confirmedRequirementContext", "deferredVerifications", "acceptanceAdapterGuide"];
const entityFields: Record<string, string[]> = {
  decision: ["choice"], acceptance: ["kind", "input", "expected", "verification"],
  component: ["purpose", "necessity", "inputs", "outputs"], step: ["componentId", "dependsOn", "input", "output", "completion"],
  failure: ["scenario", "response"], capability: ["id", "status"], connection: ["purpose", "required", "protocol", "configFields", "operations"],
  state: ["mode"], interaction: ["defaultEntry", "page", "operations", "inputs", "results", "persistentData"],
  execution: ["language", "hosting"], selectionBasis: ["capacity", "process", "quality", "assumptions"],
};
function fail(path: string, reason: string, remedy: string): never { throw Object.assign(new InputError(`历史修订依据无效：${remedy}`), {
  validationIssue: { path, reason, remedy }, validationIssues: [{ path, reason, remedy }],
  validationIssueTotal: 1, validationIssuesTruncated: false,
}); };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(objectFields(value)[key])])) : value;
}

function core(row: unknown, kind: string) {
  return Object.fromEntries(entityFields[kind]!.filter((key) => Object.hasOwn(row as object, key)).map((key) => [key, objectFields(row)[key]]));
}

function anchors(candidate: unknown): RepairAnchor[] {
  const components = new Map(candidateRows(candidate, "components").map((row) => [row.id, designHash(canonical(core(row, "component")))]));
  const steps = new Map(candidateRows(candidate, "steps").map((row) => [row.id, designHash(canonical({ input: row.input, output: row.output, completion: row.completion }))]));
  const arrayFields: Record<string, string> = { decisions: "decision", acceptance: "acceptance", components: "component", steps: "step",
    failureHandling: "failure", capabilities: "capability", connections: "connection" };
  const rows = Object.entries(arrayFields).flatMap(([field, kind]) => candidateRows(candidate, field).map((row, index) => {
    const value = core(row, kind);
    if (kind === "step") {
      value.componentId = components.get(row.componentId) ?? row.componentId;
      value.dependsOn = (objectFields(row).dependsOn as string[] ?? []).map((id) => steps.get(id) ?? id).sort();
    }
    return { path: `/${field}/${index}`, kind, ...(row.id ? { id: row.id } : {}), coreHash: designHash(canonical(value)) };
  }));
  for (const kind of ["state", "interaction", "execution", "selectionBasis"]) if (objectFields(candidate)[kind])
    rows.push({ path: `/${kind}`, kind, coreHash: designHash(canonical(core(objectFields(candidate)[kind], kind))) });
  if (typeof objectFields(candidate).instructions === "string") rows.push({ path: "/instructions", kind: "instructions", coreHash: designHash(objectFields(candidate).instructions) });
  return rows;
}

function materialPath(path: string, anchor: RepairAnchor) {
  if (path === anchor.path) return true;
  const fields = entityFields[anchor.kind] ?? [];
  return fields.some((field) => beneath(path, `${anchor.path}/${field}`));
}

/** Host-generated comparison only: names, array order and explanatory prose do not prove a repair. */
export function historicalRepairSnapshot(candidate: unknown, candidatePaths: string[] = []) {
  const safe = copyArchitectureReviewJson(candidate), selected = anchors(safe).filter((anchor) => !candidatePaths.length
    || candidatePaths.some((path) => materialPath(path, anchor)));
  const body = { version: 1, candidateHash: designHash(safe), anchors: selected };
  return { ...body, hash: designHash(body) };
}

function currentContext(candidate: unknown, context: unknown, path: string) {
  try {
    const safe = objectFields(copyArchitectureReviewJson(context, { maxBytes: 32 * 1024 * 1024, maxNodes: 1_000_000 }));
    if (designHash(safe.candidate) !== designHash(candidate)) throw new TypeError();
    const rebuilt = architectureReviewEvidenceContext({ design: candidate,
      ...Object.fromEntries(contextFields.map((key) => [key, objectFields(safe)[key]])), requirements: safe.requirements, runtimeCapabilities: safe.runtimeCapabilities, evidence: safe.evidence });
    if (designHash(rebuilt.contextManifest) !== designHash(safe.contextManifest)) throw new TypeError();
    return rebuilt;
  } catch { fail(path, "repair_context_unavailable", "必须使用当前候选和完整、摘要吻合的冻结评审来源，历史意见和候选自述不能代替平台事实。"); }
}

function materialReference(reference: NonNullable<ArchitectureIssue["references"]>[number], anchor: RepairAnchor, candidate: unknown) {
  if (reference.source !== "candidate" || !materialPath(reference.path, anchor)) return false;
  if (reference.path !== anchor.path || anchor.kind === "instructions") return true;
  const segments = anchor.path.slice(1).split("/");
  const group = objectFields(candidate)[segments[0]!];
  const row = objectFields(segments.length === 2 ? (group as unknown[])[Number(segments[1])] : group);
  const values = (entityFields[anchor.kind] ?? []).filter((field) => !["id", "kind", "componentId", "dependsOn"].includes(field))
    .map((field) => typeof row[field] === "string" ? row[field] : Object.hasOwn(row, field) ? JSON.stringify(row[field]) : null);
  return values.some((value) => typeof value === "string" && typeof reference.quote === "string"
    && (value.includes(reference.quote) || reference.quote.includes(value)));
}

function validBasis(basis: unknown): RepairBasis | null {
  try {
    const safe = objectFields(copyArchitectureReviewJson(basis, { maxBytes: 256 * 1024 })), { hash, ...body } = objectFields(safe);
    return safe.version === 1 && typeof safe.candidateHash === "string" && /^[a-f0-9]{64}$/u.test(safe.candidateHash)
      && Array.isArray(safe.anchors) && safe.anchors.length > 0 && safe.anchors.length <= 1000
      && safe.anchors.every((anchor) => [...Object.keys(entityFields), "instructions"].includes(objectFields(anchor).kind as string)
        && typeof objectFields(anchor).path === "string" && typeof objectFields(anchor).coreHash === "string" && /^[a-f0-9]{64}$/u.test(objectFields(anchor).coreHash as string))
      && hash === designHash(body) ? { version: 1, candidateHash: safe.candidateHash, anchors: safe.anchors as RepairAnchor[], hash: hash as string } : null;
  } catch { return null; }
}

function relatedClaims(candidate: unknown, selected: RepairAnchor[], explanation: ArchitectureIssue, context: object, path: string) {
  const decisions = new Set(selected.filter((entry) => entry.kind === "decision").map((entry) => entry.id));
  const acceptance = new Set(selected.filter((entry) => entry.kind === "acceptance").map((entry) => entry.id));
  const claims = candidateRows(candidate, "platformClaims").filter((claim) => (claim.decisionIds as unknown[] | undefined)?.some((id) => decisions.has(id))
    || (claim.acceptanceIds as unknown[] | undefined)?.some((id) => acceptance.has(id)));
  if (!claims.length) fail(`${path}.candidatePaths`, "repair_platform_basis_missing",
    "关闭历史研发意见须给出与当前相关决策或验收关联的platformClaims，并逐字引用其当前平台来源；仅引用历史建议或无关真实材料不足以关闭。");
  validateArchitecturePlatformClaims(candidate, context);
  if (!explanation.references!.some((reference) => claims.some((claim) => reference.source === claim.source && reference.path === claim.path)))
    fail(`${path}.status`, "repair_platform_reference_unrelated", "反证必须逐字引用相关platformClaims所核对的当前平台事实，不能引用无关规则或版本编号。");
}

/** Check change and source facts; the independent reviewer still judges whether they resolve the business/technical issue. */
export function validateHistoricalRepairDecision(row: PriorDecision, finding: RepairFinding, review: Pick<ArchitectureReview, "checks" | "issues" | "acceptanceScopeChecks">, candidate: unknown, evidenceContext: unknown, path = "review.priorFindingDecisions") {
  if (!(finding?.kind === "historical-development-review" || finding?.closureEvidenceRequired === true)
    || !["resolved", "unsupported"].includes(row.status)) return;
  const platformRequired = finding.kind === "historical-development-review" || ["platform", "context"].some(kind => kind === objectFields(finding.issue).kind);
  const context = currentContext(candidate, evidenceContext, path);
  const currentAnchors = anchors(candidate);
  const selected = currentAnchors.filter((anchor) => row.candidatePaths?.some((pointer) => materialPath(pointer, anchor)));
  if (!selected.length || row.candidatePaths.some((pointer) => !selected.some((anchor) => materialPath(pointer, anchor))))
    fail(`${path}.candidatePaths`, "repair_candidate_basis_missing", "必须指向相关决策、验收、处理步骤、失败处理、状态或运行配置的实际功能字段；只改编号、理由、排序或平台声明不是已修复依据。");
  if (row.status === "resolved") {
    const basis = validBasis(finding.repairBasis);
    if (!basis) fail(`${path}.status`, "repair_source_basis_unavailable", "缺少宿主封存的修订前内容依据，不能声称已修改；可提供当前反证解释旧意见不成立，或保留未解决。");
    if (selected.some((entry) => basis.anchors.some((old) => old.kind === entry.kind && old.coreHash === entry.coreHash)))
      fail(`${path}.status`, "repair_basis_unchanged", "关联技术内容仍与旧候选相同；改编号、换位置、修改理由或其他无关内容不能证明已修复。");
    for (const entry of selected) {
      const byId = typeof entry.id === "string" ? basis.anchors.filter((old) => old.kind === entry.kind && old.id === entry.id) : [];
      const counterparts = byId.length ? byId : basis.anchors.filter((old) => old.kind === entry.kind && old.path === entry.path);
      if (!counterparts.length) fail(`${path}.candidatePaths`, "repair_candidate_basis_unrelated",
        "当前所选实体没有对应的旧编号或旧位置，不能用新添无关方案冒充修复；保留可核对的原编号或原位置，或提供当前反证解释原意见不成立。");
      if (counterparts.every((old) => currentAnchors.some((current) => current.kind === old.kind && current.coreHash === old.coreHash)))
        fail(`${path}.status`, "repair_basis_unchanged", "对应旧技术内容仍完整存在于当前候选，不能靠新增或移动另一项方案将它关闭。");
    }
  }
  const explanationIndex = (review.issues ?? []).findIndex((issue) => issue.id === finding.findingId && issue.blocking === false
    && row.checkIds?.includes(issue.checkId ?? ""));
  const explanation = review.issues?.[explanationIndex];
  if (!explanation) fail(`${path}.status`, "repair_counterevidence_missing",
    "关闭历史意见必须有id等于findingId的非阻断解释，关联本轮检查并提供当前候选及平台事实的逐字依据；一句reason不足以关闭。");
  validateArchitectureReviewEvidence({ checks: [], issues: [explanation], acceptanceScopeChecks: [] }, context, { partial: true });
  const missing = selected.flatMap((anchor) => [
    ...(!explanation.candidatePaths?.some((pointer) => materialPath(pointer, anchor)) ? [{
      path: `review.issues[${explanationIndex}].candidatePaths`, reason: "repair_candidate_reference_unrelated", candidatePath: anchor.path,
      remedy: `关闭说明尚未关联当前条款 ${anchor.path}；在本说明的 candidatePaths 中关联该条款的实际功能字段。`,
    }] : []),
    ...(!explanation.references?.some((reference) => materialReference(reference, anchor, candidate)) ? [{
      path: `review.issues[${explanationIndex}].references`, reason: "repair_candidate_reference_unrelated", candidatePath: anchor.path,
      remedy: `关闭说明缺少当前条款 ${anchor.path} 的功能原文依据；在 references 中提供 source=candidate 的对应实际字段及逐字引用，不能只引用编号或其他条款。`,
    }] : []),
  ]);
  if (missing.length) {
    const issues = missing.slice(0, 64);
    throw Object.assign(new InputError("历史问题关闭依据未逐条对应：" + JSON.stringify({ issues, total: missing.length, truncated: missing.length > issues.length })), {
      validationIssue: issues[0], validationIssues: issues, validationIssueTotal: missing.length, validationIssuesTruncated: missing.length > issues.length,
    });
  }
  if (platformRequired) relatedClaims(candidate, selected, explanation, context, path);
}
