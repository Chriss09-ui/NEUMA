import { readReply } from "./chat-ui.js";

export function agentSourceKey(agent) {
  return JSON.stringify({ name: agent.name, draft: agent.draft });
}

export function agentHistory(messages, revision) {
  const history = [];
  for (let index = 0; index < messages.length - 1; index++) {
    const user = messages[index], reply = messages[index + 1];
    if (user.role !== "user" || user.delivery !== "sent" || user.revision !== String(revision)
      || reply.role !== "assistant" || reply.status !== "complete" || reply.revision !== String(revision)
      || [user, reply].some((entry) => typeof entry.content !== "string" || !entry.content.trim() || entry.content.length > 12_000)) continue;
    history.push({ role: "user", content: user.content, revision: String(revision) },
      { role: "assistant", content: reply.content, revision: String(revision) });
    index++;
  }
  const selected = history.slice(-40), encoder = new TextEncoder();
  while (selected.length && (selected.reduce((total, entry) => total + entry.content.length, 0) > 48_000
    || encoder.encode(JSON.stringify(selected)).length > 100_000)) selected.splice(0, 2);
  return selected;
}

export function createAgentRuntime(request = fetch) {
  async function json(path, body, { signal } = {}) {
    const options = body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    };
    if (signal) options.signal = signal;
    const response = await request(path, options);
    const result = await response.json();
    signal?.throwIfAborted();
    if (!response.ok) throw new Error(result.error || "智能体请求失败，请重试。");
    return result;
  }

  async function stream(path, body, { signal, onProgress = () => {} } = {}, options) {
    const response = await request(path, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify(body), signal,
    });
    const result = await readReply(response, onProgress, options);
    signal?.throwIfAborted();
    if (!response.ok) throw new Error(result.error || "智能体请求失败，请重试。");
    if (!options.isComplete(result)) throw new Error(options.incompleteMessage);
    return result;
  }

  return {
    inspect: (id) => json(`/api/agents/${encodeURIComponent(id)}`),
    listProfiles: (options) => json("/api/agent-profiles", undefined, options),
    saveProfile: (id, profile, options) => json(`/api/agents/${encodeURIComponent(id)}/profile`, profile, options),
    getMemory: (id, options) => json(`/api/agents/${encodeURIComponent(id)}/memory`, undefined, options),
    saveMemory: (id, memory, options) => json(`/api/agents/${encodeURIComponent(id)}/memory`, { memory }, options),
    listFiles: (id, options) => json(`/api/agents/${encodeURIComponent(id)}/files`, undefined, options),
    readFile: (id, path, options) => json(`/api/agents/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`, undefined, options),
    build: (agent, options) => stream("/api/agents/build", { id: agent.id, name: agent.name, draft: agent.draft }, options, {
      isComplete: (result) => result?.agent?.id === agent.id && result.agent.status === "ready",
      incompleteMessage: "生成连接中断，智能体尚未确认完成，请重新生成。",
    }),
    turn: (body, options) => stream("/api/agents/turn", body, options, {
      isComplete: (result) => typeof result?.reply === "string" && result.status === "complete"
        && result.agentId === body.agentId && result.sessionId === body.sessionId,
      incompleteMessage: "连接中断，回复尚未完成。已显示的内容保留，可以重新编辑后重试。",
    }),
    cancel: (sessionId) => json("/api/agents/cancel", { sessionId }),
  };
}
