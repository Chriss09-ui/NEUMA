import type { UnknownRecord } from "../contracts/json.mjs";
import { objectFields, isArray, isInteger } from "./type-boundary.mjs";
import { createHash } from "node:crypto";
import { MAX_RUNTIME_FILE_BYTES } from "./file-limits.mjs";
import { VALUE_SCHEMA_RULES, JSON_VALUE_SCHEMA_DESCRIPTION } from "../applications/value-schema-rules.mjs";
import { SERVICE_HOSTS, SERVICE_LANGUAGES } from "../services/service-runtime-options.mjs";
import { InputError } from "../requirements/core.mjs";
export interface HostDeliveryCapability { id: string; version: number; status: "available"; scope: string }

export const WORKSPACE_TEXT_WRITE_CODE_UNITS = 120_000;
export const WORKSPACE_TEXT_READ_CODE_UNITS = 24_000;
export const WORKSPACE_LIST_PAGE_ITEMS = 120;
export const MANAGED_SERVICE_MESSAGE_BYTES = 2 * 1024 * 1024;
export const APPLICATION_STATE_VALUE_BYTES = 900 * 1024;
export const APPLICATION_STATE_RECORD_BYTES = 1024 * 1024;
export const APPLICATION_ACTION_VALUE_BYTES = 1024 * 1024;
export const APPLICATION_TASK_INPUT_BYTES = 128 * 1024;
export const GATEWAY_REQUEST_BYTES = 256 * 1024;

const freeze = <T extends object>(value: T): Readonly<T> => {
  for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
  return Object.freeze(value);
};
const hostDeliveryCapabilities = [
  ...SERVICE_HOSTS.flatMap((host) => SERVICE_LANGUAGES.map((language) => ({ id: `${host}_${language}_runtime`, version: 1, status: "available",
    scope: `工作台已实现${host}方式的${language}代码交付通道；这是平台机制而非工作工具。当前交付仍须研发、依赖准备、实际隔离探测及启动验收；不证明此电脑环境就绪或业务规模已经通过。` }))),
  { id: "gateway_http_api", version: 1, status: "available", scope: "工作台已实现回环HTTP API网关；这是平台机制而非工作工具。须显式选择动作、授权并绑定交付版本，真实检查通过后才可用；不证明当前已开启或任何业务结果已经通过。" },
  { id: "gateway_mcp", version: 1, status: "available", scope: "工作台已实现回环Streamable HTTP MCP网关；这是平台机制而非工作工具。仅公开选定动作和授权任务，需实际协议检查；不证明当前已开启、已授权或业务结果已经通过。" },
];

export function hostDeliveryCapabilityCatalog(runtimeCapabilities: unknown): HostDeliveryCapability[] {
  const entries = objectFields(runtimeCapabilities).hostDeliveryCapabilities;
  if (entries === undefined) return [];
  if (!isArray(entries) || entries.length > 40 || new Set(entries.map((item) => objectFields(item).id)).size !== entries.length
    || entries.some((raw) => { const item = objectFields(raw); return !raw || typeof item !== "object" || isArray(item)
      || Object.keys(item).length !== 4 || !["id", "version", "status", "scope"].every((key) => Object.hasOwn(item, key))
      || typeof item.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(item.id)
      || !isInteger(item.version) || item.version < 1 || item.status !== "available"
      || typeof item.scope !== "string" || !item.scope.trim() || item.scope.length > 4000 || item.scope.includes("\0"); }))
    throw new InputError("冻结的平台交付能力目录无效");
  return structuredClone(entries) as HostDeliveryCapability[];
}

export const isHostDeliveryCapability = (id: unknown, runtimeCapabilities: unknown) => hostDeliveryCapabilityCatalog(runtimeCapabilities).some((item) => item.id === id);
const methods = {
  "files.write": {
    method: "ctx.files.write", input: { file: "safe workspace-relative path", content: "complete UTF-8 text; replaces existing file" },
    returns: { saved: "boolean", file: "relative path", characters: "UTF-16 code units", integrity: { sha256: "raw UTF-8 SHA-256", bytes: "raw UTF-8 bytes", utf16Units: "raw text UTF-16 units" } },
    limits: { content: WORKSPACE_TEXT_WRITE_CODE_UNITS, unit: "utf16_code_units", nul: "allowed_in_utf8_body_only" },
    permissions: "current agent and private/group scope only; no hidden names, credentials, links or uploaded-input overwrite",
    behavior: "atomic whole-file replacement; no append or chunk-write method; successful action calls register a task artifact",
  },
  "files.read": {
    method: "ctx.files.read", input: { file: "safe workspace-relative path", offset: "optional nonnegative UTF-16 offset; default 0" },
    returns: { file: "relative path", text: "credential-redacted text page", truncated: "boolean", nextOffset: "next UTF-16 offset or null", integrity: { sha256: "raw UTF-8 SHA-256", bytes: "raw UTF-8 bytes", utf16Units: "raw text UTF-16 units", redacted: "whether returned view differs from raw text" } },
    limits: { fileBytes: MAX_RUNTIME_FILE_BYTES, pageCodeUnits: WORKSPACE_TEXT_READ_CODE_UNITS, encoding: "utf8", nul: "allowed_in_utf8_body_only" },
    permissions: "same workspace restrictions as files.write; uploaded inputs may be read",
    behavior: "offset and nextOffset address the credential-redacted text view; use nextOffset until null; this view is not raw bytes; compare integrity.sha256 and bytes to the write receipt to verify the complete stored file without relaying/redacting its body",
  },
  "files.list": {
    method: "ctx.files.list", input: { directory: "optional safe relative directory; default .", offset: "optional nonnegative item offset" },
    returns: { directory: "relative directory", files: "array of {name,directory:boolean}", truncated: "boolean", nextOffset: "item offset or null" },
    limits: { pageItems: WORKSPACE_LIST_PAGE_ITEMS }, permissions: "same workspace restrictions as files.read",
    behavior: "names are sorted; hidden, credential and link entries are omitted",
  },
  "state.get": {
    method: "ctx.state.get", input: {}, returns: { state: "JSON value", version: "integer", stateVersion: "delivery data version" },
    limits: { recordBytes: APPLICATION_STATE_RECORD_BYTES }, permissions: "current agent and scope business state; separate from page draft",
    behavior: "empty state has version 0; incompatible stateVersion fails; not required for stateless file delivery",
  },
  "state.set": {
    method: "ctx.state.set", input: { state: "JSON value", expectedVersion: "version returned by state.get" },
    returns: { state: "saved JSON value", version: "incremented integer", stateVersion: "delivery data version" },
    limits: { valueBytes: APPLICATION_STATE_VALUE_BYTES, recordBytes: APPLICATION_STATE_RECORD_BYTES, measure: "JSON.stringify UTF-8 bytes" },
    permissions: "same business-state scope as state.get", behavior: "compare-and-set; stale expectedVersion fails rather than overwriting",
  },
};
const contract = {
  version: 1, scope: "existing scoped application host methods; not a claim that unlisted methods are absent",
  hostDeliveryCapabilities,
  invocation: { javascript: "await ctx.<group>.<method>({...})", python: "ctx.<group>.<method>({...}); synchronous host RPC, do not await",
    argumentShape: "one object argument", transport: "host capability calls, no model relay of file bodies" },
  transport: { messageBytes: MANAGED_SERVICE_MESSAGE_BYTES, measure: "entire compact JSON protocol message plus LF in UTF-8",
    permissions: "managed-service methods must also appear in service.capabilities; external connections require declared action connectionIds",
    workerAccess: "no direct host filesystem, network, listener, subprocess or credentials" },
  valueSchemas: { rules: VALUE_SCHEMA_RULES, guide: JSON_VALUE_SCHEMA_DESCRIPTION },
  admission: { actionValueBytes: APPLICATION_ACTION_VALUE_BYTES, taskEnvelopeBytes: APPLICATION_TASK_INPUT_BYTES,
    gatewayBodyBytes: GATEWAY_REQUEST_BYTES, measure: "JSON.stringify UTF-8 bytes; each actual envelope independently checked" },
  gateway: {
    exposure: "opt-in loopback HTTP and Streamable HTTP MCP; only selected delivered actions, current client grant and delivery version",
    api: { actions: "GET /v1/agents/:agentId/actions", submit: "POST /v1/agents/:agentId/tasks", task: "GET /v1/agents/:agentId/tasks/:taskId?deliveryVersion=...",
      artifact: "GET /v1/agents/:agentId/tasks/:taskId/artifacts/:artifactIndex?deliveryVersion=...&offset=0&limit=65536" },
    mcp: { submit: "run_<actionId>", task: "get_task", cancel: "cancel_task", artifact: "read_artifact({taskId,artifactIndex,deliveryVersion,offset?,limit?})" },
    artifactResult: { name: "file name", size: "full raw byte count", sha256: "full raw bytes SHA-256", encoding: "base64", data: "byte page", offset: "byte offset", nextOffset: "byte offset or null" },
    artifactPageBytes: 65536,
    artifactPermissions: "only immutable snapshots registered by this grant's task and selected action; old tasks without snapshots fail explicitly; arbitrary paths denied",
    verification: "catalog discovery proves HTTP/MCP protocol and authorization only; business contents require actual action execution and file checks",
  },
  methods,
};
export const RUNTIME_CAPABILITY_CONTRACT = freeze({ ...contract,
  hash: createHash("sha256").update(JSON.stringify(contract)).digest("hex") });

export const runtimeCapabilityContract = () => structuredClone(RUNTIME_CAPABILITY_CONTRACT);
