import { createHash } from "node:crypto";

export const TASK_DIMENSIONS = Object.freeze(["input_scale", "processing", "delivery", "workflow", "data_lifecycle", "external_conditions"]);
const SOURCES = new Set(["user", "accepted", "measured", "inferred", "unknown"]);
const ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const text = (value, max = 2000) => typeof value === "string" && value.trim() && value.length <= max;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export const contentHash = (value) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
export const emptyTaskSpec = () => ({ version: 1, items: [] });

export function taskSpecRequirementItems(draft) {
  if (!draft?.taskSpec) return [];
  return normalizeTaskSpec(draft.taskSpec).items.filter((item) => item.applicability === "applies")
    .map((item) => ({ id: item.id, text: item.content, source: item.source.kind, dimension: item.dimension, critical: item.critical }));
}

// Presentation and consultation metadata do not invalidate the implementation decision.
export function substantiveRequirementHash(draft) {
  const { name, agentType, routingCondition, ...requirements } = draft ?? {};
  return contentHash(requirements);
}

export function normalizeTaskSpec(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.items) || value.items.length > 120) throw new Error("任务要求记录格式无效");
  const ids = new Set();
  const items = value.items.map((item) => {
    if (!item || !ID.test(item.id) || ids.has(item.id) || !TASK_DIMENSIONS.includes(item.dimension)
      || !["applies", "not_applicable", "unknown"].includes(item.applicability)
      || typeof item.content !== "string" || item.content.length > 2000
      || typeof item.critical !== "boolean" || !SOURCES.has(item.source?.kind)
      || !Array.isArray(item.source.evidence) || item.source.evidence.length > 12
      || item.applicability === "applies" && !text(item.content)) throw new Error("任务要求条目格式无效");
    ids.add(item.id);
    const evidence = item.source.evidence.map((entry) => {
      if (!entry || !ID.test(entry.messageId) || !text(entry.quote, 4000)) throw new Error("任务要求依据格式无效");
      return { messageId: entry.messageId, quote: entry.quote };
    });
    if (["user", "accepted", "measured", "inferred"].includes(item.source.kind) && !evidence.length)
      throw new Error("任务要求缺少可核实的依据");
    if (item.source.kind === "inferred" && !text(item.source.reason, 2000)) throw new Error("推导要求必须说明依据");
    return { id: item.id, dimension: item.dimension, content: item.content.trim(), applicability: item.applicability,
      critical: item.critical, source: { kind: item.source.kind, evidence,
        ...(text(item.source.reason, 2000) ? { reason: item.source.reason.trim() } : {}) } };
  });
  const retired = value.retired === undefined ? undefined : value.retired;
  if (retired !== undefined && (!Array.isArray(retired) || retired.length > 120)) throw new Error("失效要求记录格式无效");
  const retirements = retired?.map((item) => {
    if (!item || !ID.test(item.id) || !text(item.reason) || !Array.isArray(item.evidence) || !item.evidence.length
      || item.evidence.length > 12 || item.evidence.some((ref) => !ID.test(ref.messageId) || !text(ref.quote, 4000)))
      throw new Error("失效要求必须保留用户修改依据");
    return { id: item.id, reason: item.reason, evidence: item.evidence.map(({ messageId, quote }) => ({ messageId, quote })) };
  });
  return { version: 1, items, ...(retirements ? { retired: retirements } : {}) };
}

export function validateTaskEvidence(taskSpec, evidenceMessages = []) {
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

export function validateTaskSpecTransition(previous, current, evidenceMessages, latestMessage) {
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

export function mergeEvidence(previous = [], incoming = []) {
  const messages = new Map();
  for (const entry of [...previous, ...incoming]) {
    if (!entry || !["user", "assistant", "measurement"].includes(entry.role) || !text(entry.content, 16000)) continue;
    const id = entry.id ?? `e_${contentHash({ role: entry.role, content: entry.content }).slice(0, 32)}`;
    if (!ID.test(id)) throw new Error("需求依据标识无效");
    const prior = messages.get(id);
    if (prior && (prior.content !== entry.content || prior.role !== entry.role)) throw new Error("需求依据标识与内容冲突");
    messages.set(id, { id, role: entry.role, content: entry.content });
  }
  const result = [...messages.values()];
  if (Buffer.byteLength(JSON.stringify(result)) > 1_000_000) throw new Error("需求依据记录过长，请拆分为独立需求");
  return result;
}
