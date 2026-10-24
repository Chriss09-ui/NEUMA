import type { UnknownRecord } from "../contracts/json.mjs";
import type { RequirementDraft, SystemCheck } from "../contracts/requirements.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import { objectFields, isInteger, isArray, isRecord } from "../runtime/type-boundary.mjs";
interface RequirementFact { id: string; issueId: string; reference: string; path: string; sourceHash: string; status: string; value: unknown; valueType: string; scope: string }
type ProofScope = ReturnType<typeof requirementProofScope>;
import { INPUT_CAPACITY_SCOPE, INPUT_FRAMING_FACTS } from "../applications/input-framing.mjs";
import { contentHash, substantiveRequirementHash } from "./task-spec.mjs";
import { textWithinLimit } from "../runtime/text-length.mjs";

const text = (value: unknown) => textWithinLimit(value, 3000) && value.trim();
const integer = (value: unknown) => isInteger(value) && value >= 0;
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const factId = (value: unknown): value is string => typeof value === "string" && /^fact_[a-f0-9]{32}$/.test(value);
const shape = (value: unknown, keys: string[]): value is UnknownRecord => isRecord(value)
  && Object.keys(value).every((key) => keys.includes(key));
const at = (object: unknown, path: string): unknown => path.split(".").reduce<unknown>((value, key) => objectFields(value)[key], object);
const contractPaths = ["encoding", ...["api", "mcp", "task", "managedRun"].flatMap((route) => [
  `${route}.limitBytes`, `${route}.template`, `${route}.scope`,
]), "api.canonicalMetadataUpperBoundBytes", "managedRun.metadataUpperBoundBytes"];
const measurementPaths = ["configVersion", "connectionCount", "fieldBytes.configVersion", "fieldBytes.connectionProfile",
  "fieldBytes.connectionVersions", "connectionFieldsJsonBytes", "gatewayTaskMetadataUpperBoundBytes", "sha256"];

// Only two host-owned fact types are projected. External JSON, credentials and
// arbitrary evidence details never become authoritative model-visible values.
export function projectRequirementFacts(systemChecks: SystemCheck[] = []): RequirementFact[] {
  const facts: RequirementFact[] = [], seen = new Set<string>();
  for (const check of systemChecks) for (const evidence of check.evidence ?? []) {
    if (evidence.source !== "platform" || evidence.reference !== "platform.runtime") continue;
    let value: UnknownRecord;
    try { value = objectFields(JSON.parse(evidence.detail) as unknown); } catch { continue; }
    let paths, scope, prefix;
    if (value?.type === "input_framing_contract") {
      if (contentHash(value) !== contentHash({ type: "input_framing_contract", ...INPUT_FRAMING_FACTS })) continue;
      value = { ...value, capacityProofScope: INPUT_CAPACITY_SCOPE };
      paths = [...contractPaths, ...Object.keys(INPUT_CAPACITY_SCOPE).map((key) => `capacityProofScope.${key}`)];
      scope = "宿主当前实际输入封装契约；规范 JSON 编码，模板中 input 是 JSON 值；规范请求见证证明存在合法提交方式，不承诺任意外壳均能成功。"; prefix = "inputFraming";
    } else if (value?.type === "current_connection_framing") {
      if (!shape(value, ["type", "status", "reason", "scope", "configVersion", "connectionCount", "fieldBytes", "connectionFieldsJsonBytes", "gatewayTaskMetadataUpperBoundBytes", "sha256"])
        || !["measured", "unknown"].some(status => status === value.status)) continue;
      if (value.status === "measured" && (!integer(value.configVersion) || !integer(value.connectionCount)
        || !shape(value.fieldBytes, ["configVersion", "connectionProfile", "connectionVersions"])
        || !measurementPaths.filter((path) => path !== "sha256").every((path) => integer(at(value, path))) || !hash(value.sha256))) continue;
      paths = measurementPaths; scope = "当前绑定智能体的连接快照及本机网关任务元数据；不含 input。配置变化须复测；页面、群来源不在此范围。"; prefix = "currentConnectionFraming";
    } else continue;
    const sourceHash = contentHash(value);
    for (const path of paths) {
      const current = at(value, path), available = value.type === "input_framing_contract" || value.status === "measured";
      const identity = { issueId: check.id, reference: evidence.reference, path: `${prefix}.${path}`, sourceHash };
      const id = `fact_${contentHash(identity).slice(0, 32)}`;
      if (seen.has(id)) continue; seen.add(id);
      facts.push({ id, ...identity, status: available ? "available" : "unknown", value: available ? current : null,
        valueType: available ? typeof current === "number" ? "integer" : typeof current === "string" ? "string" : "json" : "unknown", scope });
    }
  }
  return facts;
}

export function requirementProofScope(draft: RequirementDraft | null | undefined, platform: unknown, facts: RequirementFact[]) {
  const statements: { id: string; text: string }[] = [];
  const add = (id: string, value: unknown) => { if (value !== undefined && value !== null) statements.push({ id, text: typeof value === "string" ? value : JSON.stringify(value) }); };
  for (const key of ["goal", "scenario", "inputSource", "task", "deliverable", "successCriteria", "routingCondition", "constraints", "usage", "externalAction", "interaction", "connections"])
    add(key, typeof objectFields(objectFields(draft)[key]).value === "string" ? objectFields(objectFields(draft)[key]).value : objectFields(draft)[key]);
  for (const [prefix, values] of [["constraint", draft?.constraints], ["capability", draft?.capabilityDependencies],
    ["operation", draft?.interaction?.operations], ["connection", draft?.connections]] as const)
    for (const [index, value] of (values ?? []).entries()) add(`${prefix}_${index + 1}`, value);
  for (const item of draft?.taskSpec?.items ?? []) if (item.applicability === "applies") {
    add(item.id, item.content); add(`spec_${contentHash(item.id).slice(0, 24)}`, item.content);
  }
  const binding = { requirementHash: substantiveRequirementHash(draft), platformHash: contentHash(platform),
    factIds: facts.map((fact) => fact.id).sort() };
  return { bindingHash: contentHash(binding), ...binding, statements,
    evaluation: "current_delivery", configuration: "current_bound_snapshot",
    requestProof: "canonical_legal_request_witness_and_actual_whole_envelope_admission",
    configurationChanges: "reverify_changed_configuration_not_assume_old_measurement",
    unrequestedSources: "not_part_of_current_proof_without_explicit_requirement_quote",
    enabledPage: draft?.interaction?.page === true };
}

export function trustedFactProgressSchema<T extends ToolSchema>(base: T, facts: RequirementFact[], { required = false, proofScope }: { required?: boolean; proofScope?: ProofScope } = {}) {
  if (!facts.length) return base;
  return { ...base, properties: { ...base.properties,
    missingFacts: { type: "array", maxItems: facts.length, items: { type: "object", additionalProperties: false,
      required: ["factId", "status", "detail"], properties: { factId: { type: "string", enum: facts.map((fact) => fact.id) },
        status: { type: "string", enum: ["unknown", "conflict"] }, detail: { type: "string", minLength: 1, maxLength: 3000 },
        ...(proofScope ? { counterFactId: { type: "string", enum: facts.map((fact) => fact.id) } } : {}) },
      ...(proofScope ? { allOf: [{ if: { properties: { status: { const: "conflict" } } }, then: { required: ["counterFactId"] } }] } : {}) } },
    ...(proofScope ? { proofScopeHash: { type: "string", const: proofScope.bindingHash }, unsupportedScope: {
      type: "object", additionalProperties: false, required: ["requirementId", "quote", "target", "detail"], properties: {
        requirementId: proofScope.statements.length ? { type: "string", enum: proofScope.statements.map((item) => item.id) } : false,
        quote: { type: "string", minLength: 1, maxLength: 3000 }, target: { const: "required_current_behavior" },
        detail: { type: "string", minLength: 1, maxLength: 3000 },
      } } } : { unsupportedScope: { type: "string", minLength: 1, maxLength: 3000 } }),
  }, ...(proofScope && required ? { required: [...new Set([...(base.required ?? []), "proofScopeHash"])] } : {}),
    ...(required ? { anyOf: [{ required: ["missingFacts"], properties: { missingFacts: { type: "array", minItems: 1 } } },
    { required: ["unsupportedScope"] }] } : {}) };
}

export function checkedFactProgress(input: unknown, facts: RequirementFact[], { required = false, proofScope, requirementIds }: { required?: boolean; proofScope?: ProofScope; requirementIds?: string[] } = {}) {
  const progress = objectFields(input);
  function reject(): never { throw Object.assign(new Error("系统缺口必须指向本轮未知事实、解释冲突或尚未覆盖的范围"), { reason: "system_basis_stale" }); };
  if (!input) { if (required) reject(); return {}; }
  const missing = progress.missingFacts, unsupported = progress.unsupportedScope, unsupportedFields = objectFields(unsupported);
  if (proofScope && required && progress.proofScopeHash !== proofScope.bindingHash) reject();
  if (required && !(Array.isArray(missing) && missing.length) && unsupported === undefined) reject();
  if (unsupported !== undefined) {
    if (!proofScope) { if (!text(unsupported)) reject(); }
    else {
      const matchesStatement = proofScope.statements.some((item) => item.id === unsupportedFields.requirementId
        && typeof unsupportedFields.quote === "string" && item.text.includes(unsupportedFields.quote));
      if (!shape(unsupported, ["requirementId", "quote", "target", "detail"]) || !matchesStatement || !text(unsupportedFields.quote)
        || !text(unsupportedFields.detail) || unsupportedFields.target !== "required_current_behavior"
        || requirementIds && !requirementIds.some(id => id === unsupportedFields.requirementId)) reject();
    }
  }
  if (missing !== undefined && (!Array.isArray(missing) || missing.length > facts.length)) reject();
  const ids = new Set();
  const claims: { factId: string; status: string; detail: string; counterFactId?: unknown }[] = [];
  for (const input of missing === undefined ? [] : missing as unknown[]) {
    const claim = objectFields(input);
    const fact = facts.find((item) => item.id === claim?.factId);
    if (!shape(claim, ["factId", "status", "detail", ...(proofScope ? ["counterFactId"] : [])]) || !factId(claim.factId) || !fact || ids.has(claim.factId)
      || !["unknown", "conflict"].some(status => status === claim.status) || !text(claim.detail)
      || claim.status === "unknown" && fact.status === "available") reject();
    if (proofScope && claim.status === "conflict") {
      const counter = facts.find((item) => item.id === claim.counterFactId);
      if (!counter || counter.id === fact.id || counter.status !== "available" || fact.status !== "available"
        || counter.path !== fact.path || counter.scope !== fact.scope || counter.valueType !== fact.valueType
        || contentHash(counter.value) === contentHash(fact.value)) reject();
    }
    ids.add(claim.factId);
    claims.push({ factId: claim.factId, status: claim.status as string, detail: claim.detail as string, ...(claim.counterFactId ? { counterFactId: claim.counterFactId } : {}) });
  }
  return { ...(missing ? { missingFacts: claims.map(({ factId, status, detail, counterFactId }) => ({ factId, status, detail,
    ...(counterFactId ? { counterFactId } : {}) })) } : {}),
    ...(unsupported ? { unsupportedScope: structuredClone(unsupported) } : {}),
    ...(proofScope ? { proofScopeHash: proofScope.bindingHash } : {}) };
}
