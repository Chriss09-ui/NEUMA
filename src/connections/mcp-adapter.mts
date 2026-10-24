import type { ConnectionRuntimeConfiguration, ConnectionOperation, ConnectionDiscovery } from "../contracts/connection.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import { objectFields, errorField } from "../runtime/type-boundary.mjs";
type Tool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type Resource = Awaited<ReturnType<Client["listResources"]>>["resources"][number];
import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { connectionHeaders, validateSchema } from "./http-adapter.mjs";

const fail = (reason: string, message: string) => Object.assign(new Error(message), { reason });
const canonical = (value: unknown): unknown => value && typeof value === "object" ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(objectFields(value)[key])])) : value;
export const contractHash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
async function pages(client: Client, method: "listTools", key: "tools", signal?: AbortSignal): Promise<Tool[]>;
async function pages(client: Client, method: "listResources", key: "resources", signal?: AbortSignal): Promise<Resource[]>;
async function pages(client: Client, method: "listTools" | "listResources", key: "tools" | "resources", signal?: AbortSignal): Promise<(Tool | Resource)[]> {
  const all: (Tool | Resource)[] = []; let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const options = { ...(signal ? { signal } : {}), timeout: 60000, cache: "no-store" };
    const result: { nextCursor?: string | undefined; tools?: Tool[]; resources?: Resource[] } = await client[method](cursor ? { cursor } : undefined, options);
    all.push(...(result[key] ?? [])); cursor = result.nextCursor;
    if (!cursor) return all;
  }
  throw fail("discovery_limit", "服务工具目录过大，请限制当前服务暴露的工具范围");
}
export class MCPAdapter {
  fetchImpl: typeof fetch; clients: Set<Client>;
  constructor({ fetchImpl = fetch } = {}) { this.fetchImpl = fetchImpl; this.clients = new Set(); }
  async withClient<T>(connection: ConnectionRuntimeConfiguration, signal: AbortSignal | undefined, work: (client: Client) => Promise<T>): Promise<T> {
    const origin = new URL(String(connection.baseUrl)).origin;
    const guardedFetch: typeof fetch = async (value, init = {}) => {
      const url = new URL(typeof value === "string" || value instanceof URL ? value : value.url);
      if (url.origin !== origin) throw fail("redirect_rejected", "MCP 请求不能将认证信息发送至其他来源");
      const response = await this.fetchImpl(value, { ...init, redirect: "manual", signal: signal ? AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]) : init.signal ?? null });
      if (response.status >= 300 && response.status < 400) throw fail("redirect_rejected", "MCP 服务重定向，已停止发送认证信息");
      return response;
    };
    const transport = new StreamableHTTPClientTransport(new URL(String(connection.baseUrl)), { requestInit: { headers: connectionHeaders(connection), redirect: "manual" }, fetch: guardedFetch });
    const client = new Client({ name: "NEUMA", version: "1.0.0" }); this.clients.add(client);
    try { await client.connect(transport, { ...(signal ? { signal } : {}), timeout: 60000 }); return await work(client); }
    catch (error) { if (signal?.aborted) throw signal.reason; if (errorField(error, "reason")) throw error; throw fail("mcp_failed", "MCP 服务调用未完成，请检查授权、工具与服务状态"); }
    finally { this.clients.delete(client); await client.close().catch(() => {}); }
  }
  async discover(connection: ConnectionRuntimeConfiguration, { signal }: { signal?: AbortSignal | undefined } = {}) {
    return this.withClient(connection, signal, async (client) => {
      const capabilities = client.getServerCapabilities();
      const tools = capabilities?.tools ? await pages(client, "listTools", "tools", signal) : [];
      const resources = capabilities?.resources ? await pages(client, "listResources", "resources", signal) : [];
      return { tools: tools.map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({ name, title, description, inputSchema, outputSchema, annotations, contractHash: contractHash({ name, inputSchema, outputSchema }) })),
        resources: resources.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType, contractHash: contractHash({ uri, mimeType }) })) };
    });
  }
  async call(connection: ConnectionRuntimeConfiguration, operation: ConnectionOperation, input: UnknownRecord, { signal, discovery }: { signal?: AbortSignal | undefined; discovery?: ConnectionDiscovery | undefined } = {}) {
    validateSchema(operation.inputSchema, input);
    return this.withClient(connection, signal, async (client) => {
      if (operation.tool) {
        const tools = await pages(client, "listTools", "tools", signal), tool = tools.find((entry) => entry.name === operation.tool);
        const approved = discovery?.tools?.find((entry) => entry.name === operation.tool);
        if (!tool || !approved || approved.contractHash !== contractHash({ name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema })) throw fail("connection_contract_changed", "MCP 工具契约已变化，请重新发现并核验连接");
        validateSchema(tool.inputSchema, input);
        const result = await client.callTool({ name: operation.tool, arguments: input }, { ...(signal ? { signal } : {}), timeout: operation.timeoutMs ?? 60000 });
        if (result.isError) throw fail("service_failed", "MCP 工具报告操作未完成");
        validateSchema(operation.outputSchema, result.structuredContent ?? result, "invalid_response"); return result;
      }
      if (operation.resourceUri) {
        const resources = await pages(client, "listResources", "resources", signal), resource = resources.find((entry) => entry.uri === operation.resourceUri);
        const approved = discovery?.resources?.find((entry) => entry.uri === operation.resourceUri);
        if (!resource || !approved || approved.contractHash !== contractHash({ uri: resource.uri, mimeType: resource.mimeType })) throw fail("connection_contract_changed", "MCP 资源范围已变化，请重新核验连接");
        const options = { ...(signal ? { signal } : {}), timeout: 60000, cache: "no-store" };
        return client.readResource({ uri: operation.resourceUri }, options);
      }
      throw fail("operation_not_designed", "未指定已评审的 MCP 工具或资源");
    });
  }
  async close() { await Promise.all([...this.clients].map((client) => client.close().catch(() => {}))); this.clients.clear(); }
}
