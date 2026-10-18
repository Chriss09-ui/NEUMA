import { pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

export async function startMcpBridge({ url, token, input = process.stdin, output = process.stdout, fetchImpl = fetch }) {
  const address = new URL(url);
  if (address.protocol !== "http:" || address.hostname !== "127.0.0.1" || !address.port || address.username || address.password || address.search || address.hash
    || !/^\/mcp\/[\w-]+$/.test(address.pathname) || !/^[A-Za-z0-9_-]{43}$/.test(token ?? "")) throw new Error("请使用 NEUMA 提供的本机 MCP 地址和接口令牌");
  const client = new Client({ name: "NEUMA-local-bridge", version: "1.0.0" });
  const upstream = new StreamableHTTPClientTransport(address, { requestInit: { headers: { authorization: `Bearer ${token}` }, redirect: "manual" },
    fetch: async (target, options) => {
      const destination = new URL(typeof target === "string" || target instanceof URL ? target : target.url);
      if (destination.origin !== address.origin) throw new Error("本机桥接禁止改变接口来源");
      const response = await fetchImpl(target, { ...options, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) throw new Error("本机桥接不跟随重定向");
      return response;
    } });
  await client.connect(upstream);
  const server = new McpServer({ name: "NEUMA-local-bridge", version: "1.0.0" });
  try {
    const catalog = await client.listTools();
    for (const tool of catalog.tools) server.registerTool(tool.name, { title: tool.title, description: tool.description,
      inputSchema: fromJsonSchema(tool.inputSchema), ...(tool.outputSchema ? { outputSchema: fromJsonSchema(tool.outputSchema) } : {}) }, async (arguments_, context) => {
      try { return await client.callTool({ name: tool.name, arguments: arguments_ }, { signal: context.signal }); }
      catch { throw new Error("本机接口调用未完成；请检查 NEUMA 是否运行、接口是否授权及交付版本是否变化"); }
    });
    await server.connect(new StdioServerTransport(input, output));
  } catch (error) { await client.close(); await server.close(); throw error; }
  let closing;
  const close = () => closing ??= Promise.allSettled([client.close(), server.close()]);
  input.once("end", close); return { client, server, close };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startMcpBridge({ url: process.argv[2], token: process.env.NEUMA_MCP_TOKEN }).then((bridge) => {
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void bridge.close().finally(() => process.exit(0)); });
  }).catch(() => { process.stderr.write("NEUMA 本机 MCP 桥接启动失败，请检查接口地址、授权和运行状态。\n"); process.exitCode = 1; });
}
