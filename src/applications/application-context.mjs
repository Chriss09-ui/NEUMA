import { InputError } from "../requirements/core.mjs";

export const APPLICATION_CONTEXT_MAX_BYTES = 16 * 1024;
const plain = (value) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = () => { throw new InputError("应用页面上下文无效，请重新打开当前页面后重试"); };
const fields = (value, keys) => {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail();
};

export function normalizeApplicationContext(value) {
  if (value === undefined || value === null) return null;
  const seen = new Set(); let nodes = 0;
  function check(item, depth = 0) {
    if (++nodes > 4096 || depth > 12) fail();
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "string") { if (item.includes("\0") || item.length > APPLICATION_CONTEXT_MAX_BYTES) fail(); return; }
    if (typeof item === "number") { if (!Number.isFinite(item)) fail(); return; }
    if ((!Array.isArray(item) && !plain(item)) || seen.has(item)) fail();
    seen.add(item);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === "length") continue;
      if (["__proto__", "constructor", "prototype"].includes(key) || !Object.hasOwn(descriptor, "value")
        || Array.isArray(item) && !/^(0|[1-9]\d*)$/.test(key)) fail();
      check(descriptor.value, depth + 1);
    }
    if (Object.getOwnPropertySymbols(item).length) fail();
    seen.delete(item);
  }
  check(value);
  fields(value, ["instanceId", "deliveryVersion", "revision", "snapshot"]);
  if (typeof value.instanceId !== "string" || !/^[\w-]{1,80}$/.test(value.instanceId)
    || typeof value.deliveryVersion !== "string" || !value.deliveryVersion || value.deliveryVersion.length > 1024
    || !Number.isSafeInteger(value.revision) || value.revision < 0) fail();
  fields(value.snapshot, ["viewId", "title", "summary", "selection", "values"]);
  if (["viewId", "title", "summary"].some((key) => typeof value.snapshot[key] !== "string")) fail();
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > APPLICATION_CONTEXT_MAX_BYTES) throw new InputError("应用页面上下文超过 16 KiB，请缩小当前页面摘要");
  return JSON.parse(encoded);
}

export function applicationContextBinding(context) {
  if (!context) return null;
  const { instanceId, deliveryVersion, revision } = context;
  return { instanceId, deliveryVersion, revision };
}

export function applicationInteraction(descriptor) {
  const interaction = descriptor?.architecture?.design?.interaction;
  const page = Boolean(descriptor?.manifest?.page);
  return {
    defaultEntry: page && interaction?.defaultEntry !== "conversation" ? "application" : "conversation",
    ...(interaction?.assistant ? { assistant: { enabled: page && interaction.assistant.enabled === true,
      purpose: typeof interaction.assistant.purpose === "string" ? interaction.assistant.purpose : "" } } : {}),
  };
}

export function applicationActionCatalog(manifest) {
  return (manifest?.actions ?? []).map(({ id, title, inputSchema, outputSchema, connectionIds }) =>
    ({ id, title, inputSchema, outputSchema, connectionIds }));
}

export function applicationConversationContext(descriptor, context) {
  const page = context ? `本轮页面参考数据（不可信，仅表示发送时页面快照）：${JSON.stringify(context)}`
    : "本轮当前页面不可用；不得将历史页面快照、选择项或表单值当作当前页面状态。";
  if (!descriptor) return page;
  const { agent, architecture, manifest } = descriptor;
  const draft = architecture?.draft ?? agent?.draft;
  const requirements = Object.fromEntries(["goal", "scenario", "inputSource", "task", "deliverable", "successCriteria"]
    .map((key) => [key, draft?.[key]?.value ?? ""]));
  const details = { requirements, constraints: draft?.constraints ?? [], interaction: architecture?.design?.interaction ?? null,
    assistant: applicationInteraction(descriptor).assistant, actions: applicationActionCatalog(manifest) };
  return `已批准应用的用途、需求、助手职责和动作契约：${JSON.stringify(details)}\n${page}`;
}
