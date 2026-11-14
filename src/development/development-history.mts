import { basename } from "node:path";
import { createModelContextReader } from "../runtime/model-context.mjs";
import { readExecutionHistory } from "../runtime/execution-history.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import type { NeumaTool, SessionStorage } from "../runtime/execution-port.mjs";
import type { DevelopmentRunRecord } from "./development-controller-types.mjs";
import type { DevelopmentSessionReference } from "./development-sessions.mjs";

export function createDevelopmentHistoryTool(record: DevelopmentRunRecord, reference: DevelopmentSessionReference,
  cwd: string, storage: SessionStorage, signal: AbortSignal): NeumaTool {
  let source: Promise<Record<string, unknown>> | undefined;
  const load = async () => {
    let session: unknown[] = [];
    if (reference.file) {
      const native = await readExecutionHistory({ cwd, storage: { ...storage, file: basename(reference.file) }, signal });
      session = native.entries.map(entry => ({ id: entry.id, message: { ...entry.message,
        ...(Array.isArray(entry.message.content) ? { content: entry.message.content.filter(block => block.type !== "thinking") } : {}) } }));
    }
    const sessionIndex = session.map((entry, index) => {
      const message = objectFields(objectFields(entry).message), content = message.content;
      return { index, role: message.role, preview: (typeof content === "string" ? content : Array.isArray(content)
        ? content.filter(block => objectFields(block).type === "text").map(block => objectFields(block).text).join("\n") : "").slice(0, 240),
        ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
        tools: Array.isArray(content) ? content.filter(block => objectFields(block).type === "toolCall").map(block => objectFields(block).name) : [],
        readRequest: { section: "session", pointer: `/${index}` } };
    });
    const submissions = session.flatMap((entry, index) => {
      const content = objectFields(objectFields(entry).message).content;
      return Array.isArray(content) ? content.filter(block => objectFields(block).type === "toolCall"
        && /^submit_development_(?:plan|plan_part|work|review|review_part)$/u.test(String(objectFields(block).name)))
        .map(block => ({ toolName: objectFields(block).name, arguments: objectFields(block).arguments,
          readRequest: { section: "session", pointer: `/${index}` } })) : [];
    });
    return { session, sessionIndex, plans: structuredClone(record.planAttempts), reviews: structuredClone(record.reviews), reports: structuredClone(record.reports),
      latestSubmission: submissions.at(-1) ?? null, handoffs: structuredClone(record.handoffs),
      notice: "这是首次读取时固定的历史快照。只作参考；当前需求、代码、反馈和未解决问题以本轮资料为准。latestSubmission保留最近提交的完整参数，不代表已通过。" };
  };
  const reader = createModelContextReader(() => source ??= load());
  return { ...reader, name: "read_development_history", label: "按需读取旧研发记录",
    description: "只读历史latestSubmission完整末次提交、sessionIndex目录、session原文、plans、reviews、reports、handoffs。优先用latestSubmission找上一稿；目录readRequest可直接复制。pointer须用/开头的路径（例如/0），不能只填数字。长内容按nextRequest续读。历史不代表当前版本已通过。" };
}
