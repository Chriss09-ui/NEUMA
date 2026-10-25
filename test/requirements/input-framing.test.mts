import { callFixture } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { applicationTaskInput, canonicalGatewayRequest, managedRunMessage, INPUT_CAPACITY_SCOPE, INPUT_FRAMING_FACTS, measureConnectionFraming, normalizeVerificationContext } from "../../src/applications/input-framing.mjs";

const uuid = "00000000-0000-4000-8000-000000000000";
const snapshot = () => ({ agentId: "server_bound", version: 17, profile: "f".repeat(64), connections: [
  { id: "PRIVATE_CONNECTION_IDENTIFIER", kind: "business", version: 16, generation: uuid, grantEpoch: 2 },
] });
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

test("同源构造保留原任务字段/顺序和run协议，输入作为值嵌入一次", () => {
  const input = { text: '中文😀\n"\\' }, connections = snapshot(), source = { kind: "application", scope: "private", gatewayGrant: uuid };
  const task = applicationTaskInput({ actionId: "summarize", input, mutationId: "fixed-mutation", source,
    deliveryVersion: "dev_one:" + "a".repeat(64), revision: 3, connectionSnapshot: connections, allowNetwork: false });
  assert.deepEqual(task, { actionId: "summarize", input, mutationId: "fixed-mutation", source, deliveryVersion: "dev_one:" + "a".repeat(64),
    revision: 3, configVersion: 17, connectionProfile: "f".repeat(64), connectionVersions: connections.connections, allowNetwork: false });
  assert.equal(task.input, input); assert.equal(task.source, source); assert.equal(task.connectionVersions, connections.connections);
  assert.deepEqual(managedRunMessage({ actionId: "summarize", requestId: uuid, input }), { type: "run", protocolVersion: 1, requestId: uuid, actionId: "summarize", input });
  assert.equal(size(task), size({ ...task, input: null }) - 4 + size(input));
});

test("规范API和真实run框架的最大标识上界独立核算，IPC包含LF且不含任务元数据", () => {
  const actionId = "a".repeat(80), deliveryVersion = "d".repeat(80) + ":" + "a".repeat(64);
  assert.equal(INPUT_FRAMING_FACTS.api.canonicalMetadataUpperBoundBytes,
    Buffer.byteLength(`{"actionId":"${actionId}","input":null,"mutationId":"${"m".repeat(100)}","deliveryVersion":"${deliveryVersion}"}`) - 4);
  assert.equal(INPUT_FRAMING_FACTS.managedRun.metadataUpperBoundBytes,
    Buffer.byteLength(`{"type":"run","protocolVersion":1,"requestId":"${uuid}","actionId":"${actionId}","input":null}\n`) - 4);
  assert.equal(INPUT_FRAMING_FACTS.managedRun.metadataUpperBoundBytes, 189);
  assert.equal(INPUT_FRAMING_FACTS.task.limitBytes, 128 * 1024); assert.equal(INPUT_FRAMING_FACTS.managedRun.limitBytes, 2 * 1024 * 1024);
  assert.match(INPUT_FRAMING_FACTS.mcp.scope, /完整JSON-RPC/); assert.match(INPUT_FRAMING_FACTS.mcp.scope, /不能把API/);
});

test("规范API/MCP合法请求见证分别精确核算；可选外壳增大由实际信封准入限制", () => {
  const actionId = "a".repeat(80), mutationId = "m".repeat(100), deliveryVersion = "d".repeat(80) + ":" + "f".repeat(64);
  const input = { text: '中文😀\n"\\', rows: [{ n: 7 }] };
  for (const protocol of ["api", "mcp"]) {
    const request = canonicalGatewayRequest({ protocol, actionId, input, mutationId, deliveryVersion });
    const metadata = INPUT_CAPACITY_SCOPE.requestWitnesses![protocol]!.metadataUpperBoundBytes;
    assert.equal(size(request), size(input) + metadata);
    const independent = protocol === "api" ? { actionId, input, mutationId, deliveryVersion }
      : { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `run_${actionId}`, arguments: { input, mutationId, deliveryVersion } } };
    assert.deepEqual(request, independent);
    if (protocol === "mcp") {
      const enlarged = { ...request, id: "x".repeat(262144), params: { ...request.params!, _meta: { extra: "y".repeat(262144) } } };
      assert.ok(size(enlarged) > INPUT_CAPACITY_SCOPE.requestWitnesses!.mcp!.bodyLimitBytes);
      assert.ok(size(request) < INPUT_CAPACITY_SCOPE.requestWitnesses!.mcp!.bodyLimitBytes);
    }
  }
  assert.equal(INPUT_CAPACITY_SCOPE.encoding.inputEmbedding, "json_value_once");
  assert.throws(() => callFixture(canonicalGatewayRequest, undefined, [{ protocol: "other" }]), TypeError);
});

test("原材料JSON文本作为业务字符串时先计转义和字段外壳，不能将原材料字节当实际动作B", () => {
  const material = [{ path: 'dir/"quoted"\\file', lines: 7 }], sourceText = JSON.stringify(material);
  const actual = { recordsJson: sourceText, outputKey: "complete" };
  const native = { records: material, outputKey: "complete" };
  assert.ok(size(actual) > Buffer.byteLength(sourceText)); assert.ok(size(actual) > size(native));
  const request = canonicalGatewayRequest({ protocol: "api", actionId: "a".repeat(80), input: actual,
    mutationId: "m".repeat(100), deliveryVersion: "d".repeat(80) + ":" + "f".repeat(64) });
  assert.equal(size(request), size(actual) + INPUT_CAPACITY_SCOPE.requestWitnesses!.api!.metadataUpperBoundBytes);
  assert.notEqual(size(request), Buffer.byteLength(sourceText) + INPUT_CAPACITY_SCOPE.requestWitnesses!.api!.metadataUpperBoundBytes);
  assert.equal(INPUT_CAPACITY_SCOPE.encoding.boundary, "after_application_mapping_not_raw_material_bytes");
});

test("当前连接测量仅输出受控字节/计数/摘要，未使用连接也改变完整任务上界", () => {
  const input = snapshot(), before = structuredClone(input);
  Reflect.set(input, "secret", "PRIVATE_CREDENTIAL_VALUE"); Reflect.set(input, "baseUrl", "https://PRIVATE_URL.invalid");
  const result = measureConnectionFraming(input, "server_bound"); assert.ok("fieldBytes" in result);
  const fields = { configVersion: 17, connectionProfile: input.profile, connectionVersions: before.connections };
  assert.equal(result.status, "measured"); assert.equal(result.configVersion, 17); assert.equal(result.connectionCount, 1);
  assert.equal(result.connectionFieldsJsonBytes, size(fields));
  assert.deepEqual(result.fieldBytes, { configVersion: size(17), connectionProfile: size(input.profile), connectionVersions: size(before.connections) });
  assert.equal(result.sha256, createHash("sha256").update(JSON.stringify([input.agentId, fields])).digest("hex"));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|baseUrl|generation|server_bound|f{64}/);
  const maximal = applicationTaskInput({ actionId: "a".repeat(80), input: null, mutationId: "f".repeat(64),
    source: { kind: "application", scope: "private", gatewayGrant: uuid }, deliveryVersion: "d".repeat(80) + ":" + "f".repeat(64),
    revision: Number.MAX_SAFE_INTEGER, connectionSnapshot: input, allowNetwork: false });
  assert.equal(result.gatewayTaskMetadataUpperBoundBytes, size(maximal) - 4);
  const more = structuredClone(input); more.connections.push({ ...more.connections[0]!, id: "unused_connection" });
  const next = measureConnectionFraming(more, "server_bound"); assert.ok("fieldBytes" in next);
  assert.ok(next.gatewayTaskMetadataUpperBoundBytes > result.gatewayTaskMetadataUpperBoundBytes); assert.notEqual(next.sha256, result.sha256);
  assert.match(result.scope, /当前测量不是未来配置上界/); assert.match(result.scope, /激活及连接配置变化/);
});

test("缺少绑定、损坏快照、未知类型和getter保留unknown，额外字段不被求值", () => {
  for (const mutate of [
    (value: { agentId: string; }) => { value.agentId = "other"; }, (value: { version: string; }) => { value.version = "17"; }, (value: { profile: string; }) => { value.profile = "invalid"; },
    (value: { connections: { grantEpoch: null; }[]; }) => { value.connections![0]!.grantEpoch = null; }, (value: { connections: { generation: string; }[]; }) => { value.connections![0]!.generation = "unbounded"; },
    (value: { connections: { version: number; }[]; }) => { value.connections![0]!.version = Number.MAX_SAFE_INTEGER + 1; }, (value: { connections: { kind: string; }[]; }) => { value.connections![0]!.kind = "unknown"; },
    (value: { connections: unknown[]; }) => { value.connections.push(value.connections[0]); }, (value: { connections: unknown; }) => { Object.setPrototypeOf(value.connections, {}); },
  ]) { const value = snapshot(); callFixture(mutate, undefined, [value]); assert.equal(measureConnectionFraming(value, "server_bound").status, "unknown"); }
  assert.equal(callFixture(measureConnectionFraming, undefined, [snapshot()]).status, "unknown");
  let invoked = false;
  const value = snapshot(); Object.defineProperty(value.connections[0], "version", { get() { invoked = true; return 1; } });
  assert.equal(measureConnectionFraming(value, "server_bound").status, "unknown"); assert.equal(invoked, false);
  const extra = snapshot(); Object.defineProperty(extra.connections[0], "token", { get() { invoked = true; return "PRIVATE_VALUE"; } });
  assert.equal(measureConnectionFraming(extra, "server_bound").status, "unknown"); assert.equal(invoked, false);
  assert.deepEqual(normalizeVerificationContext({ agentId: "server_bound", secret: "PRIVATE_VALUE" }), { agentId: "server_bound" });
  assert.equal(normalizeVerificationContext({ agentId: "../other" }), undefined);
  const context = {}; Object.defineProperty(context, "agentId", { get() { invoked = true; return "server_bound"; } });
  assert.equal(normalizeVerificationContext(context), undefined); assert.equal(invoked, false);
});
