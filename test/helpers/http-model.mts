import assert from "node:assert/strict";
import type { Server } from "node:http";

export interface FixtureToolCall { id?: string; function: { name: string; arguments: string } }
export interface FixtureChatMessage { role: string; content?: string | { text?: string; [key: string]: unknown }[] | null; tool_calls?: FixtureToolCall[]; tool_call_id?: string }
export interface FixtureChatRequest { messages: FixtureChatMessage[]; tools?: { function: { name: string } }[]; [key: string]: unknown }
export function fixtureChatRequest(text: string): FixtureChatRequest {
  const value: unknown = JSON.parse(text);
  assert.ok(value && typeof value === "object" && "messages" in value && Array.isArray(value.messages));
  for (const message of value.messages) {
    assert.ok(message && typeof message === "object" && typeof message.role === "string");
    assert.ok(message.content === undefined || message.content === null || typeof message.content === "string" || Array.isArray(message.content));
    if (Array.isArray(message.content)) for (const part of message.content) assert.ok(part && typeof part === "object" && (part.text === undefined || typeof part.text === "string"));
    if (message.tool_calls !== undefined) {
      assert.ok(Array.isArray(message.tool_calls));
      for (const call of message.tool_calls) assert.ok(call && typeof call === "object" && call.function && typeof call.function.name === "string" && typeof call.function.arguments === "string");
    }
  }
  if ("tools" in value && value.tools !== undefined) {
    assert.ok(Array.isArray(value.tools));
    for (const tool of value.tools) assert.ok(tool && typeof tool === "object" && tool.function && typeof tool.function.name === "string");
  }
  return value as FixtureChatRequest;
}
export const fixtureText = (content: FixtureChatMessage["content"]) => typeof content === "string" ? content : (content ?? []).map(part => part.text ?? "").join("");
export function fixturePort(server: Server) { const address = server.address(); assert.ok(address && typeof address === "object"); return address.port; }

export function fixtureJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
export function fixtureRequirements(value: unknown): { id: string; text: string }[] {
  assert.ok(Array.isArray(value));
  for (const item of value) assert.ok(item && typeof item === "object" && typeof item.id === "string" && typeof item.text === "string");
  return value as { id: string; text: string }[];
}
export function fixtureAcceptanceIds(value: unknown): { acceptance: { id: string }[] } {
  assert.ok(value && typeof value === "object" && "acceptance" in value && Array.isArray(value.acceptance));
  for (const item of value.acceptance) assert.ok(item && typeof item === "object" && typeof item.id === "string");
  return value as { acceptance: { id: string }[] };
}

export function fixtureString(value: unknown): string { assert.equal(typeof value, "string"); return value as string; }
