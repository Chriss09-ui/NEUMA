import { observeOperation } from "./operation-view.js";
import type { MainOperationSnapshot } from "./ui-api-types.js";
import type { OperationView } from "./operation-view.js";
import type { BrowserRequest } from "./ui-types.js";
import type { CollaborationApi } from "./ui-api-types.js";
import type { FrontendError, RequestOptions } from "./ui-types.js";
import { readReply } from "./chat-ui.js";

const part = encodeURIComponent;

export function createCollaborationApi(request: BrowserRequest = fetch): CollaborationApi {
  async function json<T>(path: string, body?: unknown, { signal }: RequestOptions = {}): Promise<T> {
    const response = await request(path, { ...(body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), ...(signal ? { signal } : {}) });
    const result = await response.json() as T & { error?: string; reason?: string };
    signal?.throwIfAborted();
    if (!response.ok) {
      const error: FrontendError = new Error(result.error || "请求未完成，请重试。");
      error.status = response.status; error.reason = result.reason;
      throw error;
    }
    return result;
  }
  const groupPath = (id: string) => `/api/groups/${part(id)}`;
  return {
    groups: () => json("/api/groups"),
    agents: () => json("/api/collaboration/agents"),
    group: (id, options) => json(groupPath(id), undefined, options),
    createGroup: (body) => json("/api/groups", body),
    updateGroup: (id, body) => json(groupPath(id), body),
    send: (id, body) => json(`${groupPath(id)}/messages`, body),
    cancelTask: (id, taskId) => json(`${groupPath(id)}/tasks/${part(taskId)}/cancel`, {}),
    removeGroupConversation: (id, conversationId, body) => json(`${groupPath(id)}/conversations/${part(conversationId)}/remove`, body),
    events: (id, after = 0) => json(`${groupPath(id)}/events?after=${after}`),
    share: (id, body) => json(`${groupPath(id)}/share`, body),
    async upload(id, file) {
      const response = await request(`${groupPath(id)}/materials`, { method: "POST",
        headers: { "content-type": file.type || "application/octet-stream", "x-file-name": part(file.name) }, body: file });
      const result = await response.json() as { material: import("./ui-types.js").Material; error?: string };
      if (!response.ok) throw new Error(result.error || "材料上传失败，请重试。");
      return result;
    },
    materialPreview: (id, materialId) => json(`${groupPath(id)}/materials/${part(materialId)}/preview`),
    materialUrl: (id, materialId, download = false) => `${groupPath(id)}/materials/${part(materialId)}/raw${download ? "?download=1" : ""}`,
    artifact: (id, artifactId) => json(`${groupPath(id)}/artifacts/${part(artifactId)}`),
    agentMaterials: (id) => json(`/api/agents/${part(id)}/attachments`),
    agentFiles: (id) => json(`/api/agents/${part(id)}/files`),
    activity: () => json("/api/activity"),
    conversations: () => json("/api/main/conversations"),
    createConversation: () => json("/api/main/conversations", { mutationId: crypto.randomUUID() }),
    conversation: (id) => json(`/api/main/conversations/${part(id)}`),
    removeConversation: (id, body) => json(`/api/main/conversations/${part(id)}/remove`, body),
    activateRequirements: (id, body) => json(`/api/main/conversations/${part(id)}/requirements`, body),
    inspectAgent: (id, options) => json(`/api/agents/${part(id)}`, undefined, options),
    mainMaterials: (id) => json(`/api/main/conversations/${part(id)}/materials`),
    mainMaterialUrl: (id, materialId) => `/api/main/conversations/${part(id)}/materials/${part(materialId)}/raw`,
    async uploadMainMaterial(id, file) {
      const response = await request(`/api/main/conversations/${part(id)}/materials`, { method: "POST",
        headers: { "content-type": file.type || "application/octet-stream", "x-file-name": part(file.name) }, body: file });
      const result = await response.json() as { attachment: import("./ui-types.js").Material; error?: string };
      if (!response.ok) throw new Error(result.error || "主助理材料上传失败，请重试。");
      return result;
    },
    cancelMain: (id) => json(`/api/main/conversations/${part(id)}/cancel`, {}),
    submitMain: (id, body, options) => json(`/api/main/conversations/${part(id)}/operations`, body, options),
    mainOperation: (id, operationId, after, options) => json(`/api/main/conversations/${part(id)}/operations/${part(operationId)}${after ? `?after=${part(after)}` : ""}`, undefined, options),
    stopMainOperation: reference => json(`/api/main/conversations/${part(reference.ownerId)}/operations/${part(reference.operationId)}/cancel`, { generation: reference.generation }),
    async mainTurnBackground(id, body, { signal, onProgress = () => {} } = {}) {
      const base = `/api/main/conversations/${part(id)}/operations`;
      const accepted = await json<OperationView<MainOperationSnapshot>>(base, body, { signal });
      onProgress({ type: "operation", operation: accepted.operation });
      const result = await observeOperation(cursor => json<OperationView<MainOperationSnapshot>>(`${base}/${part(accepted.operation.operationId)}${cursor ? `?after=${part(cursor)}` : ""}`, undefined, { signal }), accepted.operation, {
        signal, disconnected: () => onProgress({ type: "status", label: "连接中断，正在重新连接；后台任务继续执行。" }),
        update(snapshot) {
          onProgress({ type: "status", label: snapshot.status === "running" ? "正在处理，进度已保存…" : "" });
          onProgress({ type: "text-start" }); onProgress({ type: "text-delta", delta: snapshot.reply });
          onProgress({ type: "context", context: snapshot.context });
          return snapshot.status !== "running";
        },
      });
      if (result.status !== "complete") {
        const error: FrontendError = new Error(result.error || "回复未完成，已保存的内容保留。"); error.reason = result.reason || result.status; throw error;
      }
      return { reply: result.reply, conversation: result.conversation, context: result.context, actions: result.actions, sources: result.sources };
    },
    async mainTurn(id, body, { signal, onProgress = () => {} } = {}) {
      const response = await request(`/api/main/conversations/${part(id)}/messages`, { method: "POST",
        headers: { "content-type": "application/json", accept: "application/x-ndjson" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
      return readReply(response, onProgress, { isComplete: (result) => typeof result?.reply === "string" && result.conversation?.id === id,
        incompleteMessage: "主助理回复中断，已保存的消息会在重新加载后显示。" });
    },
  };
}
