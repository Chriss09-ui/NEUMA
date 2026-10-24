import type { TaskSpecV1 } from "../contracts/versions.mjs";
import type { EvidenceMessage, EvidenceMessageInput } from "../contracts/requirements.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import { createHash } from "node:crypto";
import { textWithinLimit } from "../runtime/text-length.mjs";
import { assertRequirementDraftSize, REQUIREMENT_SIZE_GUIDE, TASK_SPEC_LIMITS } from "./requirement-limits.mjs";

export const TASK_DIMENSIONS = Object.freeze(["input_scale", "processing", "delivery", "workflow", "data_lifecycle", "external_conditions"]);
const SOURCES = new Set(["user", "accepted", "measured", "inferred", "unknown"]);
const APPLICABILITY = Object.freeze(["applies", "not_applicable", "unknown"]);
const LIMITS = TASK_SPEC_LIMITS;
const ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const text = (value: unknown, max = 2000): value is string => textWithinLimit(value, max) && Boolean(value.trim());
const validId = (value: unknown): value is string => typeof value === "string" && ID.test(value);

const REJECTIONS = Object.freeze({
  task_spec_shape: "taskSpec", task_spec_too_large: "taskSpec", version_invalid: "taskSpec.version", items_invalid: "taskSpec.items",
  item_shape: "taskSpec.items[]", item_id_invalid: "taskSpec.items[].id", item_id_duplicate: "taskSpec.items[].id",
  dimension_invalid: "taskSpec.items[].dimension", applicability_invalid: "taskSpec.items[].applicability",
  content_invalid: "taskSpec.items[].content", critical_invalid: "taskSpec.items[].critical",
  source_invalid: "taskSpec.items[].source", source_kind_invalid: "taskSpec.items[].source.kind",
  evidence_invalid: "taskSpec.items[].source.evidence", evidence_missing: "taskSpec.items[].source.evidence",
  evidence_message_id_invalid: "taskSpec.items[].source.evidence[].messageId", evidence_quote_invalid: "taskSpec.items[].source.evidence[].quote",
  inferred_reason_missing: "taskSpec.items[].source.reason", retired_invalid: "taskSpec.retired", retirement_invalid: "taskSpec.retired[]",
  retirement_id_invalid: "taskSpec.retired[].id", retirement_reason_invalid: "taskSpec.retired[].reason",
  retirement_evidence_invalid: "taskSpec.retired[].evidence", retirement_message_id_invalid: "taskSpec.retired[].evidence[].messageId",
  retirement_quote_invalid: "taskSpec.retired[].evidence[].quote",
});

function invalidSpec(rejection: keyof typeof REJECTIONS, message: string, details: UnknownRecord = {}) {
  return Object.assign(new Error(message), { taskSpecRejection: rejection, ...details });
}

export function taskSpecDiagnostic(input: unknown) {
  const error = objectFields(input);
  const rejection = error?.taskSpecRejection;
  return typeof rejection === "string" && Object.hasOwn(REJECTIONS, rejection)
    ? { rejection, paths: [REJECTIONS[rejection as keyof typeof REJECTIONS]], ...(rejection === "task_spec_too_large"
      && Number.isSafeInteger(error.bytes) && Number.isSafeInteger(error.limitBytes) ? { bytes: error.bytes, limitBytes: error.limitBytes } : {}) }
    : { rejection: "task_spec_shape", paths: ["taskSpec"] };
}

// This describes structure only; exact quotes, source roles, unique item IDs and semantic support have separate guards.
export function taskSpecSchema({ messageIds }: { messageIds?: unknown[] } = {}) {
  const nonempty = (maxLength: number) => ({ type: "string", minLength: 1, maxLength, pattern: "\\S" });
  const evidence = { type: "array", maxItems: LIMITS.evidence, items: { $ref: "#/definitions/evidenceReference" } };
  const schema = { type: "object", description: REQUIREMENT_SIZE_GUIDE, required: ["version", "items"], definitions: {
    evidenceReference: { type: "object", required: ["messageId", "quote"], properties: {
      messageId: { type: "string", pattern: ID.source } as ToolSchema | false, quote: nonempty(LIMITS.quote),
    } },
  }, properties: {
    version: { type: "number", const: 1 },
    items: { type: "array", maxItems: LIMITS.items, description: "每条id须唯一且保留未改变条目的稳定编号；唯一性由程序额外检查。", items: {
      type: "object", required: ["id", "dimension", "content", "applicability", "critical", "source"], properties: {
        id: { type: "string", pattern: ID.source }, dimension: { type: "string", enum: [...TASK_DIMENSIONS] },
        content: { type: "string", maxLength: LIMITS.content }, applicability: { type: "string", enum: [...APPLICABILITY] }, critical: { type: "boolean" },
        source: { type: "object", required: ["kind", "evidence"], properties: {
          kind: { type: "string", enum: [...SOURCES] }, evidence: structuredClone(evidence),
          reason: { description: "inferred时必填非空推导说明，其他来源可省略；无效的历史可选说明按旧规则忽略。" },
        }, allOf: [
          { if: { properties: { kind: { enum: [...SOURCES].filter((kind) => kind !== "unknown") } }, required: ["kind"] },
            then: { properties: { evidence: { type: "array", minItems: 1 } } } },
          { if: { properties: { kind: { const: "inferred" } }, required: ["kind"] },
            then: { required: ["reason"], properties: { reason: nonempty(LIMITS.content) } } },
        ] },
      }, allOf: [{ if: { properties: { applicability: { const: "applies" } }, required: ["applicability"] },
        then: { properties: { content: nonempty(LIMITS.content) } } }] } },
    retired: { type: "array", maxItems: LIMITS.items, items: { type: "object", required: ["id", "reason", "evidence"], properties: {
      id: { type: "string", pattern: ID.source }, reason: nonempty(LIMITS.content), evidence: { ...structuredClone(evidence), minItems: 1 },
    } } },
  } };
  if (messageIds !== undefined) {
    const allowed = [...new Set(messageIds.filter(validId))];
    schema.definitions.evidenceReference.properties.messageId = allowed.length ? { type: "string", enum: allowed } : false;
  }
  return schema;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(objectFields(value)[key])]));
  return value;
}

export const contentHash = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
export const emptyTaskSpec = (): TaskSpecV1 => ({ version: 1, items: [] });

export function taskSpecRequirementItems(draft: { taskSpec?: unknown } | null | undefined) {
  if (!draft?.taskSpec) return [];
  return normalizeTaskSpec(draft.taskSpec).items.filter((item) => item.applicability === "applies")
    .map((item) => ({ id: item.id, text: item.content, source: item.source.kind, dimension: item.dimension, critical: item.critical }));
}

// Presentation and consultation metadata do not invalidate the implementation decision.
export function substantiveRequirementHash(draft: unknown) {
  const { name, agentType, routingCondition, ...requirements } = objectFields(draft);
  return contentHash(requirements);
}

export function normalizeTaskSpec(input: unknown): TaskSpecV1 {
  const value = objectFields(input);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidSpec("task_spec_shape", "任务要求记录格式无效");
  if (value.version !== 1) throw invalidSpec("version_invalid", "任务要求记录版本无效");
  if (!Array.isArray(value.items) || value.items.length > LIMITS.items) throw invalidSpec("items_invalid", "任务要求记录格式无效");
  const ids = new Set();
  const items = (value.items as unknown[]).map((input): TaskSpecV1["items"][number] => {
    const item = objectFields(input);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidSpec("item_shape", "任务要求条目格式无效");
    if (!validId(item.id)) throw invalidSpec("item_id_invalid", "任务要求条目编号无效");
    if (ids.has(item.id)) throw invalidSpec("item_id_duplicate", "任务要求条目编号重复");
    if (!TASK_DIMENSIONS.some(dimension => dimension === item.dimension)) throw invalidSpec("dimension_invalid", "任务要求维度无效");
    if (!APPLICABILITY.some(applicability => applicability === item.applicability)) throw invalidSpec("applicability_invalid", "任务要求适用性无效");
    if (!textWithinLimit(item.content, LIMITS.content) || item.applicability === "applies" && !text(item.content))
      throw invalidSpec("content_invalid", "任务要求内容无效");
    if (typeof item.critical !== "boolean") throw invalidSpec("critical_invalid", "任务要求关键程度无效");
    if (!item.source || typeof item.source !== "object" || Array.isArray(item.source)) throw invalidSpec("source_invalid", "任务要求来源格式无效");
    const source = objectFields(item.source);
    if (typeof source.kind !== "string" || !SOURCES.has(source.kind)) throw invalidSpec("source_kind_invalid", "任务要求来源种类无效");
    if (!Array.isArray(source.evidence) || source.evidence.length > LIMITS.evidence)
      throw invalidSpec("evidence_invalid", "任务要求依据格式无效");
    ids.add(item.id);
    const evidence = (source.evidence as unknown[]).map((input) => {
      const entry = objectFields(input);
      if (!entry || !validId(entry.messageId)) throw invalidSpec("evidence_message_id_invalid", "任务要求依据编号无效");
      if (!text(entry.quote, LIMITS.quote)) throw invalidSpec("evidence_quote_invalid", "任务要求依据原文无效");
      return { messageId: entry.messageId, quote: entry.quote };
    });
    if (["user", "accepted", "measured", "inferred"].includes(source.kind) && !evidence.length)
      throw invalidSpec("evidence_missing", "任务要求缺少可核实的依据");
    if (source.kind === "inferred" && !text(source.reason, LIMITS.content)) throw invalidSpec("inferred_reason_missing", "推导要求必须说明依据");
    return { id: item.id, dimension: item.dimension as TaskSpecV1["items"][number]["dimension"], content: item.content.trim(), applicability: item.applicability as TaskSpecV1["items"][number]["applicability"],
      critical: item.critical, source: { kind: source.kind as TaskSpecV1["items"][number]["source"]["kind"], evidence,
        ...(text(source.reason, LIMITS.content) ? { reason: source.reason.trim() } : {}) } };
  });
  const retired = value.retired === undefined ? undefined : value.retired;
  if (retired !== undefined && (!Array.isArray(retired) || retired.length > LIMITS.items)) throw invalidSpec("retired_invalid", "失效要求记录格式无效");
  const retirements = (retired as unknown[] | undefined)?.map((input) => {
    const item = objectFields(input);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidSpec("retirement_invalid", "失效要求格式无效");
    if (!validId(item.id)) throw invalidSpec("retirement_id_invalid", "失效要求编号无效");
    if (!text(item.reason, LIMITS.content)) throw invalidSpec("retirement_reason_invalid", "失效要求必须说明修改原因");
    if (!Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > LIMITS.evidence)
      throw invalidSpec("retirement_evidence_invalid", "失效要求必须保留用户修改依据");
    const evidence = (item.evidence as unknown[]).map((input) => {
      const ref = objectFields(input);
      if (!ref || !validId(ref.messageId)) throw invalidSpec("retirement_message_id_invalid", "失效要求依据编号无效");
      if (!text(ref.quote, LIMITS.quote)) throw invalidSpec("retirement_quote_invalid", "失效要求依据原文无效");
      return { messageId: ref.messageId, quote: ref.quote };
    });
    return { id: item.id, reason: item.reason, evidence };
  });
  const normalized: TaskSpecV1 = { version: 1, items, ...(retirements ? { retired: retirements } : {}) };
  try { assertRequirementDraftSize(normalized); }
  catch (caught) {
    const error = objectFields(caught);
    if (error.reason !== "requirement_draft_too_large") throw caught;
    throw invalidSpec("task_spec_too_large", String(error.message), { reason: error.reason, bytes: error.bytes, limitBytes: error.limitBytes });
  }
  return normalized;
}

export function validateTaskEvidence(taskSpec: unknown, evidenceMessages: EvidenceMessage[] = []) {
  const spec = normalizeTaskSpec(taskSpec);
  const messages = new Map(evidenceMessages.map((message) => [message.id, message]));
  for (const item of spec.items) {
    const roles = new Set();
    for (const ref of item.source.evidence) {
      const evidence = messages.get(ref.messageId);
      if (!evidence || typeof evidence.content !== "string" || !evidence.content.includes(ref.quote))
        throw new Error(`任务要求 ${item.id} 的原文依据无法核对`);
      roles.add(evidence.role);
    }
    if (item.source.kind === "user" && !roles.has("user")) throw new Error("用户要求必须引用用户原话");
    if (item.source.kind === "accepted" && (!roles.has("user") || !roles.has("assistant")))
      throw new Error("接受建议必须同时保留建议和用户接受的原话");
    if (item.source.kind === "measured" && !roles.has("measurement")) throw new Error("测量结论必须引用实际测量记录");
  }
  for (const item of spec.retired ?? []) {
    if (!item.evidence.some((ref) => messages.get(ref.messageId)?.role === "user")) throw new Error("失效要求必须依据用户修改");
    if (item.evidence.some((ref) => !messages.get(ref.messageId)?.content.includes(ref.quote))) throw new Error("失效要求依据无法核对");
  }
  return spec;
}

export function validateTaskSpecTransition(previous: unknown, current: unknown, evidenceMessages: EvidenceMessage[], latestMessage: string) {
  if (!previous) return;
  const messages = new Map(evidenceMessages.map((item) => [item.id, item]));
  const next = normalizeTaskSpec(current);
  for (const item of normalizeTaskSpec(previous).items.filter((entry) => entry.critical)) {
    const replacement = next.items.find((entry) => entry.id === item.id);
    if (replacement?.critical) continue;
    if (replacement && ["user", "accepted"].includes(replacement.source.kind)
      && replacement.source.evidence.some((ref) => messages.get(ref.messageId)?.role === "user"
        && messages.get(ref.messageId)?.content === latestMessage && latestMessage.includes(ref.quote))) continue;
    const retirement = next.retired?.find((entry) => entry.id === item.id);
    if (!retirement?.evidence.some((ref) => messages.get(ref.messageId)?.role === "user"
      && messages.get(ref.messageId)?.content === latestMessage && latestMessage.includes(ref.quote)))
      throw new Error(`关键要求 ${item.id} 不能在没有用户修改依据时删除或降级`);
  }
}

export function mergeEvidence(previous: EvidenceMessageInput[] = [], incoming: EvidenceMessageInput[] = []): EvidenceMessage[] {
  const messages = new Map<string, EvidenceMessage>();
  for (const entry of [...previous, ...incoming]) {
    if (!entry || !["user", "assistant", "measurement"].includes(entry.role) || !text(entry.content, 16000)) continue;
    const id = entry.id ?? `e_${contentHash({ role: entry.role, content: entry.content }).slice(0, 32)}`;
    if (!ID.test(id)) throw new Error("需求依据标识无效");
    const prior = messages.get(id);
    if (prior && (prior.content !== entry.content || prior.role !== entry.role)) throw new Error("需求依据标识与内容冲突");
    messages.set(id, { id, role: entry.role as EvidenceMessage["role"], content: entry.content });
  }
  const result = [...messages.values()];
  if (Buffer.byteLength(JSON.stringify(result)) > 1_000_000) throw new Error("需求依据记录过长，请拆分为独立需求");
  return result;
}
