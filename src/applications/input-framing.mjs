import { createHash } from "node:crypto";

export function applicationTaskInput({ actionId, input, mutationId, source, deliveryVersion, revision, connectionSnapshot, allowNetwork }) {
  return { actionId, input, mutationId, source, deliveryVersion, revision,
    configVersion: connectionSnapshot.version, connectionProfile: connectionSnapshot.profile,
    connectionVersions: connectionSnapshot.connections, allowNetwork };
}

export function managedRunMessage({ requestId, actionId, input }) {
  return { type: "run", protocolVersion: 1, requestId, actionId, input };
}

// A capacity witness uses an ordinary compact client request. Optional JSON-RPC
// metadata remains subject to the transport's actual whole-body admission limit.
export function canonicalGatewayRequest({ protocol, actionId, input, mutationId, deliveryVersion }) {
  if (protocol === "api") return { actionId, input, mutationId, deliveryVersion };
  if (protocol === "mcp") return { jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: `run_${actionId}`, arguments: { input, mutationId, deliveryVersion } } };
  throw new TypeError("Unsupported gateway protocol");
}

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const overhead = (frame, newline = false) => bytes(frame) - 4 + Number(newline);
const maxActionId = "a".repeat(80), maxDeliveryVersion = "d".repeat(80) + ":" + "f".repeat(64);
const uuid = "00000000-0000-4000-8000-000000000000";
const gatewayTask = (connectionSnapshot) => applicationTaskInput({ actionId: maxActionId, input: null,
  mutationId: "f".repeat(64), source: { kind: "application", scope: "private", gatewayGrant: uuid },
  deliveryVersion: maxDeliveryVersion, revision: Number.MAX_SAFE_INTEGER, connectionSnapshot, allowNetwork: false });

// Separate from INPUT_FRAMING_FACTS so existing frozen evidence and derivation
// bindings are not rewritten when this additional proof scope is exposed.
export const INPUT_CAPACITY_SCOPE = Object.freeze({
  encoding: { serializer: "JSON.stringify", byteEncoding: "utf8", inputEmbedding: "json_value_once",
    inputByteMeasure: "Buffer.byteLength(JSON.stringify(actual_action_input))",
    boundary: "after_application_mapping_not_raw_material_bytes" },
  requestWitnesses: Object.fromEntries(["api", "mcp"].map((protocol) => [protocol, {
    metadataUpperBoundBytes: overhead(canonicalGatewayRequest({ protocol, actionId: maxActionId, input: null,
      mutationId: "m".repeat(100), deliveryVersion: maxDeliveryVersion })),
    condition: protocol === "api" ? "compact_json_valid_identifiers" : "compact_json_id_1_no_optional_meta_valid_identifiers",
    bodyLimitBytes: 256 * 1024,
  }])),
  admission: "actual_complete_envelope_bytes_including_optional_metadata_and_whitespace",
  optionalEnvelopeGrowth: "runtime_admission_not_unbounded_success_guarantee",
  configuration: "current_bound_snapshot_recheck_before_activation_and_after_change",
  additionalSources: "prove_only_if_required_by_current_delivery",
});

export const INPUT_FRAMING_FACTS = Object.freeze({
  encoding: "B=Buffer.byteLength(JSON.stringify(input))；输入作为JSON值嵌入一次，不把整个输入再编码成JSON字符串。",
  api: { limitBytes: 256 * 1024, template: { actionId: "<actionId>", input: null, mutationId: "<mutationId>", deliveryVersion: "<deliveryVersion>" },
    canonicalMetadataUpperBoundBytes: overhead({ actionId: maxActionId, input: null, mutationId: "m".repeat(100), deliveryVersion: maxDeliveryVersion }),
    scope: "仅规范紧凑请求体；额外空白也占请求体。actionId<=80个ASCII字符；mutationId<=100个ASCII字符；deliveryVersion=研发记录id<=80个ASCII字符+冒号+64位摘要。" },
  mcp: { limitBytes: 256 * 1024,
    template: { jsonrpc: "2.0", id: "<client request id>", method: "tools/call", params: { name: "run_<actionId>", arguments: { input: null, mutationId: "<mutationId>", deliveryVersion: "<deliveryVersion>" } } },
    scope: "256KiB含完整JSON-RPC信封；客户端请求id、可选_meta、空白等也计入。工具参数随后转为同一API提交对象，不能把API元数据上界当整个MCP信封上界。" },
  task: { limitBytes: 128 * 1024,
    template: applicationTaskInput({ actionId: "<actionId>", input: null, mutationId: "<mutationId>", source: "<source>",
      deliveryVersion: "<deliveryVersion>", revision: "<revision>", connectionSnapshot: { version: "<version>", profile: "<profile>", connections: "<all unrevoked connections>" }, allowNetwork: "<boolean>" }),
    scope: "B+JSON.stringify(以上完整任务对象将input换null)的UTF-8字节数-4，须<=128KiB。连接快照包含全部未撤销连接，不仅本动作依赖；无通用固定连接数量/封装余量。task UUID、时间、事件在此检查后加入，另受16MiB任务存档限制。页面source只含上下文instanceId/deliveryVersion/revision绑定，不含完整页面snapshot；群/页面来源须另算。" },
  managedRun: { limitBytes: 2 * 1024 * 1024, template: managedRunMessage({ requestId: "<UUID>", actionId: "<actionId>", input: null }),
    metadataUpperBoundBytes: overhead(managedRunMessage({ requestId: uuid, actionId: maxActionId, input: null }), true),
    scope: "单条紧凑JSON加LF；requestId为UUID36，actionId<=80个ASCII字符。无source/交付版本/连接快照；B+此元数据上界<=2MiB。" },
});

const plain = (value) => value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => {
  const descriptor = value && Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
};
const counter = (value) => Number.isSafeInteger(value) && value >= 0;
const identifier = (value) => typeof value === "string" && /^[\w-]{1,80}$/.test(value);
const unknown = () => ({ status: "unknown", reason: "snapshot_invalid" });

export function normalizeVerificationContext(value) {
  const agentId = plain(value) ? own(value, "agentId") : undefined;
  return identifier(agentId) ? { agentId } : undefined;
}

export function measureConnectionFraming(snapshot, boundAgentId) {
  if (!plain(snapshot) || !identifier(boundAgentId) || own(snapshot, "agentId") !== boundAgentId) return unknown();
  const version = own(snapshot, "version"), profile = own(snapshot, "profile"), connections = own(snapshot, "connections");
  if (!counter(version) || typeof profile !== "string" || profile !== "legacy" && !/^[a-f0-9]{64}$/.test(profile)
    || !Array.isArray(connections) || Object.getPrototypeOf(connections) !== Array.prototype) return unknown();
  const projected = [], ids = new Set();
  for (let index = 0; index < connections.length; index++) {
    const entry = own(connections, String(index));
    if (!plain(entry) || Reflect.ownKeys(entry).some((key) => !["id", "kind", "version", "generation", "grantEpoch"].includes(key))) return unknown();
    const id = own(entry, "id"), kind = own(entry, "kind"), currentVersion = own(entry, "version"), generation = own(entry, "generation"), grantEpoch = own(entry, "grantEpoch");
    if (!identifier(id) || Object.hasOwn(Object.prototype, id) || ids.has(id) || !["search", "model", "business"].includes(kind) || !counter(currentVersion) || !counter(grantEpoch)
      || typeof generation !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(generation)) return unknown();
    ids.add(id); projected.push({ id, kind, version: currentVersion, generation, grantEpoch });
  }
  const fields = { configVersion: version, connectionProfile: profile, connectionVersions: projected };
  const serialized = JSON.stringify(fields);
  if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) return unknown();
  return { status: "measured", configVersion: version, connectionCount: projected.length,
    fieldBytes: { configVersion: bytes(version), connectionProfile: bytes(profile), connectionVersions: bytes(projected) },
    connectionFieldsJsonBytes: Buffer.byteLength(serialized),
    sha256: createHash("sha256").update(JSON.stringify([boundAgentId, fields])).digest("hex"),
    gatewayTaskMetadataUpperBoundBytes: overhead(gatewayTask({ version, profile, connections: projected })),
    scope: "仅当前绑定智能体的受控连接版本字段；摘要不含凭据。gatewayTaskMetadataUpperBoundBytes覆盖当前快照、最大合法动作/交付标识、网关64位幂等摘要、UUID授权、私聊来源、正安全整数revision及布尔联网值；仅适用API/MCP本机网关提交，不含input。当前测量不是未来配置上界，激活及连接配置变化须重新检查，不单独解决业务或容量阻断。" };
}
