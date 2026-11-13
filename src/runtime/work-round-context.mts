import type { ContextEvent, SessionMessage } from "./execution-port.mjs";

const textOf = (message: SessionMessage) => typeof message.content === "string" ? message.content
  : message.content?.length === 1 && message.content[0]?.type === "text" ? message.content[0].text : undefined;

const keyOf = (message: SessionMessage) => JSON.stringify({ role: message.role,
  content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
  ...("toolCallId" in message ? { toolCallId: message.toolCallId } : {}) });

export function createWorkRoundProjection(prior: SessionMessage[]) {
  const excluded = new Set(prior.map(keyOf));
  return (messages: ContextEvent["messages"], opening: string): ContextEvent["messages"] => projectWorkRound(messages, opening, excluded);
}

export function projectWorkRound(messages: ContextEvent["messages"], opening: string, excluded?: ReadonlySet<string>): ContextEvent["messages"];
export function projectWorkRound(messages: SessionMessage[], opening: string, excluded?: ReadonlySet<string>): SessionMessage[];
/** Request projection only. Native history is neither deleted nor rewritten. */
export function projectWorkRound(messages: SessionMessage[], opening: string, excluded: ReadonlySet<string> = new Set()): SessionMessage[] {
  const start = messages.findLastIndex(message => message.role === "user" && textOf(message) === opening);
  if (start >= 0) return messages.slice(start);
  // Compaction may remove the opening. Retain this round's complete tool cycles, excluding archived rounds and lossy summaries.
  const current = messages.filter(message => ["assistant", "toolResult"].includes(message.role) && !excluded.has(keyOf(message)));
  const calls = new Set<string>();
  const complete = current.filter(message => {
    if (message.role === "assistant" && Array.isArray(message.content)) for (const block of message.content)
      if (block.type === "toolCall" && "id" in block && typeof block.id === "string") calls.add(block.id);
    return message.role !== "toolResult" || "toolCallId" in message && typeof message.toolCallId === "string" && calls.has(message.toolCallId);
  });
  return [{ role: "user", content: [{ type: "text", text: opening }] }, ...complete];
}
