import type { UnknownRecord } from "../contracts/json.mjs";
import type { ContextEvent, SessionMessage } from "../runtime/execution-port.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import { createArchitectureMaterialFiles, type ArchitectureMaterialFile } from "./architecture-material-files.mjs";

type Messages = ContextEvent["messages"];

function text(message: SessionMessage) {
  return typeof message.content === "string" ? message.content
    : message.content?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
}

/** Keep the last complete submission transaction and every read in the current round. */
function roundStart(messages: Messages, submissions: ReadonlySet<string>) {
  let start = 0;
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const calls = message.content.filter(part => part.type === "toolCall");
    if (calls.some(call => submissions.has(call.name)) && calls.every(call => messages.slice(index + 1).some(
      result => result.role === "toolResult" && result.toolCallId === call.id))) start = index;
    // Structured submissions and missing-submit reminders use a native text response followed by host feedback.
    else if (!calls.length && message.stopReason === "stop" && text(message)
      && messages.slice(index + 1).some(next => next.role === "user")) start = index;
  }
  return start;
}

function publicMessage(message: SessionMessage): UnknownRecord {
  return { role: message.role, content: typeof message.content === "string" ? message.content
    : message.content?.flatMap(part => part.type === "text" || part.type === "toolCall" ? [part] : []),
    ...(message.toolName ? { toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError === true } : {}),
    ...(message.stopReason ? { stopReason: message.stopReason } : {}) };
}

function taskPacket(message: SessionMessage) {
  if (message.role !== "user") return false;
  try {
    const value = objectFields(JSON.parse(text(message)));
    return Boolean(value.contextIndex || value.materialDelivery || value.roundContext || value.modelBudget || value.repairAssignment
      || value.contextHash && (value.candidate || value.requirements));
  } catch { return false; }
}

/** Only the request view changes. Native messages, submission receipts and counters remain untouched. */
export function createArchitectureRoundContext(options: {
  directory: string; submissions: readonly string[]; materials: () => UnknownRecord;
  packet: (source: UnknownRecord, files: ArchitectureMaterialFile[]) => UnknownRecord;
}) {
  const files = createArchitectureMaterialFiles(options.directory), submissions = new Set(options.submissions);
  let history: UnknownRecord[] = [];
  const source = () => ({ ...options.materials(), conversationHistory: history });
  const packet = async () => {
    const current = source(), catalog = await files.publish(current);
    return { ...options.packet(current, catalog), roundContext: {
      policy: "latest-submission-v1", historyFile: "conversationHistory.json",
      instruction: "以当前稿件、最近一次提交及其反馈、尚未解决的问题继续。历史稿件和旧交互仅按需读取；被拒提交是待修稿，不代表已接受。本轮已读资料保留到正式提交，退回次数仍按原任务累计。",
    } };
  };
  return { tool: files.tool, source,
    preparePrompt: async () => JSON.stringify(await packet()),
    transformContext: async (messages: Messages): Promise<Messages> => {
      const start = roundStart(messages, submissions);
      history = messages.slice(0, start).map(publicMessage);
      const tail = messages.slice(start);
      const latestControl = tail.findLast(message => message.role === "user" && !taskPacket(message));
      return [{ role: "user", content: JSON.stringify(await packet()), timestamp: 0 },
        ...tail.filter(message => message.role !== "user" || message === latestControl)];
    },
  };
}
