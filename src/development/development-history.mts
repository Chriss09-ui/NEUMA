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
        ? content.filter(block => objectFields(block).type === "text").map(block => objectFields(block).text).join("\n") : "").slice(0, 240) };
    });
    return { session, sessionIndex, plans: structuredClone(record.planAttempts), reviews: structuredClone(record.reviews), reports: structuredClone(record.reports),
      handoffs: structuredClone(record.handoffs), notice: "这是首次读取时固定的历史快照。只作参考；当前需求、代码、反馈和未解决问题以本轮资料为准。" };
  };
  const reader = createModelContextReader(() => source ??= load());
  return { ...reader, name: "read_development_history", label: "按需读取旧研发记录",
    description: "只读历史sessionIndex目录、session原文、plans、reviews、reports、handoffs；requests按section/pointer选择，按nextRequest续读。原会话保留，历史不代表当前版本已通过。" };
}
