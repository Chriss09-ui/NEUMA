import { readReply } from "./chat-ui.js";

const part = encodeURIComponent;

export function createCollaborationApi(request = fetch) {
  async function json(path, body, { signal } = {}) {
    const response = await request(path, { ...(body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), ...(signal ? { signal } : {}) });
    const result = await response.json();
    signal?.throwIfAborted();
    if (!response.ok) {
      const error = new Error(result.error || "请求未完成，请重试。");
      error.status = response.status; error.reason = result.reason;
      throw error;
    }
    return result;
  }
  const groupPath = (id) => `/api/groups/${part(id)}`;
  return {
    groups: () => json("/api/groups"),
    agents: () => json("/api/collaboration/agents"),
    group: (id, options) => json(groupPath(id), undefined, options),
    createGroup: (body) => json("/api/groups", body),
    updateGroup: (id, body) => json(groupPath(id), body),
    send: (id, body) => json(`${groupPath(id)}/messages`, body),
    cancelTask: (id, taskId) => json(`${groupPath(id)}/tasks/${part(taskId)}/cancel`, {}),
    events: (id, after = 0) => json(`${groupPath(id)}/events?after=${after}`),
    share: (id, body) => json(`${groupPath(id)}/share`, body),
    async upload(id, file) {
      const response = await request(`${groupPath(id)}/materials`, { method: "POST",
        headers: { "content-type": file.type || "application/octet-stream", "x-file-name": part(file.name) }, body: file });
      const result = await response.json();
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
    activateRequirements: (id, body) => json(`/api/main/conversations/${part(id)}/requirements`, body),
    inspectAgent: (id, options) => json(`/api/agents/${part(id)}`, undefined, options),
    mainMaterials: (id) => json(`/api/main/conversations/${part(id)}/materials`),
    mainMaterialUrl: (id, materialId) => `/api/main/conversations/${part(id)}/materials/${part(materialId)}/raw`,
    async uploadMainMaterial(id, file) {
      const response = await request(`/api/main/conversations/${part(id)}/materials`, { method: "POST",
        headers: { "content-type": file.type || "application/octet-stream", "x-file-name": part(file.name) }, body: file });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "主助理材料上传失败，请重试。");
      return result;
    },
    cancelMain: (id) => json(`/api/main/conversations/${part(id)}/cancel`, {}),
    async mainTurn(id, body, { signal, onProgress = () => {} } = {}) {
      const response = await request(`/api/main/conversations/${part(id)}/messages`, { method: "POST",
        headers: { "content-type": "application/json", accept: "application/x-ndjson" }, body: JSON.stringify(body), signal });
      return readReply(response, onProgress, { isComplete: (result) => typeof result?.reply === "string" && result.conversation?.id === id,
        incompleteMessage: "主助理回复中断，已保存的消息会在重新加载后显示。" });
    },
  };
}
