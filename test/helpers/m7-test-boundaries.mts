import assert from "node:assert/strict";
import type { RegisteredTool } from "../../src/runtime/pi-port.mjs";
import type { ToolSchema } from "../../src/contracts/tools.mjs";
/** Metadata consumed by existing assertion predicates; each test still checks its expected values. */
export interface TestFailure extends Error {
  [key: string]: unknown;
  reason?: string;
  code?: string;
  bytes?: number; limitBytes?: number;
  artifactIssue?: { indexField?: string; parseError?: string; location?: { offset?: number; line: number; column: number }; [key: string]: unknown };
  restoreState?: { restored?: boolean; currentMatchesSource?: boolean; currentFileHash?: string; [key: string]: unknown };
  diagnostic?: { [key: string]: unknown; stage?: string; reason?: string; providerModel?: string | null; requirementFidelity?: { verdict?: string } };
  fidelityDiagnostic?: import("../../src/architecture/requirement-fidelity.mjs").FidelityDiagnostic;
  validationIssues?: { path: string; reason: string; [key: string]: unknown }[];
  validationIssue?: { [key: string]: unknown; path: string; reason: string; message?: string };
  developmentIssue?: { [key: string]: unknown; path: string; reason: string };
}

export function fixtureDeferred<T = unknown>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T | undefined>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function listeningAddress(server: Pick<import("node:net").Server, "address">) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务尚未监听 TCP 地址");
  return address;
}

export interface FixtureTool {
  name: string;
  parameters: ToolSchema;
  description: string;
  execute(id: string, input: unknown, signal?: AbortSignal): Promise<import("../../src/contracts/tools.mjs").ToolResult>;
}
export function fixtureTools(tools: import("../../src/runtime/pi-port.mjs").RegisteredTool[] = []): Record<string, FixtureTool> {
  return Object.fromEntries(tools.map(tool => [tool.name, {
    name: tool.name, description: tool.description, parameters: fixtureSchema(tool.parameters),
    async execute(id: string, input: unknown, signal?: AbortSignal) {
      const result: unknown = await Reflect.apply(tool.execute, tool, [id, input, signal]);
      if (!result || typeof result !== "object" || !Array.isArray(Reflect.get(result, "content"))) throw new Error("测试工具未返回内容数组");
      const content: unknown[] = Reflect.get(result, "content");
      if (!content.every(part => part && typeof part === "object" && (
        Reflect.get(part, "type") === "text" && typeof Reflect.get(part, "text") === "string" ||
        Reflect.get(part, "type") === "image" && typeof Reflect.get(part, "data") === "string" && typeof Reflect.get(part, "mimeType") === "string"))) throw new Error("测试工具返回内容无效");
      return result as import("../../src/contracts/tools.mjs").ToolResult;
    },
  }] as const));
}

export function toolText(result: unknown): string {
  if (!result || typeof result !== "object") throw new Error("测试工具没有返回对象");
  const content: unknown = Reflect.get(result, "content");
  if (!Array.isArray(content) || !content[0] || typeof content[0] !== "object" || Reflect.get(content[0], "type") !== "text" || typeof Reflect.get(content[0], "text") !== "string") throw new Error("测试工具首项不是文本结果");
  return Reflect.get(content[0], "text");
}

export function recordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new Error("测试记录必须为对象数组");
  return value;
}

/** Model fixtures intentionally emit the host-facing event subset through an unknown wire boundary. */
export function dispatchModelEvent(listener: Parameters<NonNullable<import("../../src/runtime/pi-port.mjs").PiSessionPort["subscribe"]>>[0] | null | undefined, event: unknown): unknown {
  return listener ? Reflect.apply(listener, undefined, [event]) : undefined;
}

export interface FixtureModelPart { type: string; text?: string; id?: string; image_url?: { url: string } }
export interface FixtureModelMessage {
  role: string; content: string | FixtureModelPart[];
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string; reasoning_content?: string;
}
export interface FixtureModelSchema { [key: string]: unknown; properties: Record<string, FixtureModelSchema>; items: FixtureModelSchema; anyOf: FixtureModelSchema[]; maxItems: number }
export interface FixtureModelRequest {
  [key: string]: unknown; model?: string; messages: FixtureModelMessage[];
  tools?: { function: { name: string; parameters: FixtureModelSchema } }[];
}
export function fixtureToolAt(tools: RegisteredTool[] = [], index = 0): FixtureTool {
  const tool = tools[index]; assert.ok(tool, `Missing fixture tool at ${index}`);
  return fixtureTools([tool])[tool.name]!;
}

export function fixtureSchema(value: unknown): ToolSchema {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const fields = value as Record<string, unknown>;
  if (fields.properties !== undefined) {
    assert.ok(fields.properties && typeof fields.properties === "object" && !Array.isArray(fields.properties));
    for (const schema of Object.values(fields.properties)) fixtureSchema(schema);
  }
  if (fields.items !== undefined) fixtureSchema(fields.items);
  for (const key of ["anyOf", "oneOf", "allOf"]) if (fields[key] !== undefined) {
    assert.ok(Array.isArray(fields[key])); for (const schema of fields[key]) fixtureSchema(schema);
  }
  if (fields.type !== undefined) assert.ok(typeof fields.type === "string" || Array.isArray(fields.type) && fields.type.every(type => typeof type === "string"));
  if (fields.required !== undefined) assert.ok(Array.isArray(fields.required) && fields.required.every(key => typeof key === "string"));
  return value as ToolSchema;
}
export function fixtureFailure(value: unknown): TestFailure {
  assert.ok(value instanceof Error); return value as TestFailure;
}
/** Invalid and historical fixture arguments cross an unknown input boundary; the real function keeps its return contract. */
export function callFixture<F extends (...args: never[]) => unknown>(fn: F, receiver: unknown, args: unknown[]): ReturnType<F> {
  return Reflect.apply(fn, receiver, args);
}
export function fixtureText(value: unknown): string {
  assert.ok(typeof value === "string", "Fixture text must be a string"); return value;
}

export function fixtureNumber(value: unknown): number { assert.ok(typeof value === "number"); return value; }
