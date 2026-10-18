import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { connectionHeaders, validateSchema } from "./http-adapter.mjs";

const fail = (reason, message) => Object.assign(new Error(message), { reason });
const canonical = (value) => value && typeof value === "object" ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const contractHash = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
async function pages(client, method, key, signal) {
  const all = []; let cursor;
  for (let page = 0; page < 20; page++) {
    const result = await client[method](cursor ? { cursor } : undefined, { signal, timeout: 60000, cache: "no-store" });
    all.push(...(result[key] ?? [])); cursor = result.nextCursor;
    if (!cursor) return all;
  }
  throw fail("discovery_limit", "服务工具目录过大，请限制当前服务暴露的工具范围");
}
export class MCPAdapter {
  constructor({ fetchImpl = fetch } = {}) { this.fetchImpl = fetchImpl; this.clients = new Set(); }
  async withClient(connection, signal, work) {
    const origin = new URL(connection.baseUrl).origin;
    const guardedFetch = async (value, init = {}) => {
      const url = new URL(typeof value === "string" || value instanceof URL ? value : value.url);
      if (url.origin !== origin) throw fail("redirect_rejected", "MCP 请求不能将认证信息发送至其他来源");
      const response = await this.fetchImpl(value, { ...init, redirect: "manual", signal: signal ? AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]) : init.signal });
      if (response.status >= 300 && response.status < 400) throw fail("redirect_rejected", "MCP 服务重定向，已停止发送认证信息");
      return response;
    };
    const transport = new StreamableHTTPClientTransport(new URL(connection.baseUrl), { requestInit: { headers: connectionHeaders(connection), redirect: "manual" }, fetch: guardedFetch });
    const client = new Client({ name: "NEUMA", version: "1.0.0" }); this.clients.add(client);
    try { await client.connect(transport, { signal, timeout: 60000 }); return await work(client); }
    catch (error) { if (signal?.aborted) throw signal.reason; if (error.reason) throw error; throw fail("mcp_failed", "MCP 服务调用未完成，请检查授权、工具与服务状态"); }
    finally { this.clients.delete(client); await client.close().catch(() => {}); }
  }
  async discover(connection, { signal } = {}) {
    return this.withClient(connection, signal, async (client) => {
      const capabilities = client.getServerCapabilities();
      const tools = capabilities?.tools ? await pages(client, "listTools", "tools", signal) : [];
      const resources = capabilities?.resources ? await pages(client, "listResources", "resources", signal) : [];
      return { tools: tools.map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({ name, title, description, inputSchema, outputSchema, annotations, contractHash: contractHash({ name, inputSchema, outputSchema }) })),
        resources: resources.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType, contractHash: contractHash({ uri, mimeType }) })) };
    });
  }
  async call(connection, operation, input, { signal, discovery } = {}) {
    validateSchema(operation.inputSchema, input);
    return this.withClient(connection, signal, async (client) => {
      if (operation.tool) {
        const tools = await pages(client, "listTools", "tools", signal), tool = tools.find((entry) => entry.name === operation.tool);
        const approved = discovery?.tools?.find((entry) => entry.name === operation.tool);
        if (!tool || !approved || approved.contractHash !== contractHash({ name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema })) throw fail("connection_contract_changed", "MCP 工具契约已变化，请重新发现并核验连接");
        validateSchema(tool.inputSchema, input);
        const result = await client.callTool({ name: operation.tool, arguments: input }, { signal, timeout: operation.timeoutMs ?? 60000 });
        if (result.isError) throw fail("service_failed", "MCP 工具报告操作未完成");
        validateSchema(operation.outputSchema, result.structuredContent ?? result, "invalid_response"); return result;
      }
      if (operation.resourceUri) {
        const resources = await pages(client, "listResources", "resources", signal), resource = resources.find((entry) => entry.uri === operation.resourceUri);
        const approved = discovery?.resources?.find((entry) => entry.uri === operation.resourceUri);
        if (!resource || !approved || approved.contractHash !== contractHash({ uri: resource.uri, mimeType: resource.mimeType })) throw fail("connection_contract_changed", "MCP 资源范围已变化，请重新核验连接");
        return client.readResource({ uri: operation.resourceUri }, { signal, timeout: 60000, cache: "no-store" });
      }
      throw fail("operation_not_designed", "未指定已评审的 MCP 工具或资源");
    });
  }
  async close() { await Promise.all([...this.clients].map((client) => client.close().catch(() => {}))); this.clients.clear(); }
}
