import { observeOperation, type OperationReference, type OperationView } from "./operation-view.js";
import type { BrowserRequest } from "./ui-types.js";
import type { AgentRuntime } from "./ui-api-types.js";
import type { ActiveRuntime, AgentDefinition, ArchitectureView, BuildPresentation, DevelopmentView, FrontendError, Message, RequestOptions, RuntimeResult, RuntimeState, StreamOptions } from "./ui-types.js";
import type { ReplyOptions } from "./chat-ui.js";
import { readReply } from "./chat-ui.js";
import { agentAttachmentRefs } from "./state.js";

export function agentSourceKey(agent: { name?: string | undefined; draft?: unknown }) {
  return JSON.stringify({ name: agent.name, draft: agent.draft });
}

const architectureLabels: Record<string, string> = {
  pending: "已准备从架构蓝图重新开始；原方案与检查结果已保留，等待手动开始。",
  designing: "正在设计架构，尚未生成可运行的智能体。",
  evaluating: "正在检查架构，尚未生成可运行的智能体。",
  needs_input: "需要补充影响交付的关键选择，请继续澄清需求。",
  needs_changes: "架构需要调整，可查看需求与方案后重新检查。",
  needs_evidence: "架构待补充依据，补齐后才能继续生成。",
  infeasible: "当前方案无法满足需求，请调整需求或所需能力。",
  failed: "架构处理失败，可以重新设计与检查。",
  cancelled: "架构处理已停止，可以重新设计与检查。",
};

export const developmentPhases = [["intake", "接收设计"], ["planning", "拆分任务"], ["implementing", "开发任务"],
  ["verifying", "检查验收"], ["packaging", "整理交付"]] as const;
const developmentLabels: Record<string, string> = { running: "研发进行中", completed: "研发已完成", blocked: "研发受阻", failed: "研发失败",
  cancelled: "研发已取消", interrupted: "研发已中断" };
const developmentDeliveries: Record<string, string> = { blocked: "暂时不能运行", needs_development: "仍需研发或运行适配", needs_connection: "待连接所需能力", ready: "已通过运行检查" };

function matchingDevelopment(agent: { id: string }, architecture: ArchitectureView | null | undefined, development: DevelopmentView | null | undefined) {
  return Boolean(architecture && development?.agentId === agent.id && development.architectureRef?.version === architecture.version
    && typeof architecture.candidateHash === "string" && architecture.candidateHash
    && development.architectureRef?.candidateHash === architecture.candidateHash);
}

function activeApplicationAwaitingGateway(definition: AgentDefinition | null | undefined, active: ActiveRuntime | null | undefined) {
  const architecture = active?.architecture, record = active?.development, reference = definition?.developmentRef;
  const execution = definition?.execution, delivered = record?.package;
  return Boolean(definition?.mode === "designed" && definition.status === "ready" && !definition.dataRecoveryRequired
    && ["node-action", "managed-service"].includes(execution?.kind!)
    && architecture?.agentId === definition.id && architecture.status === "passed" && architecture.delivery === "ready"
    && !architecture.issues?.some((issue) => issue.blocking)
    && /^[a-f0-9]{64}$/.test(architecture.sourceFingerprint ?? "")
    && (definition.fingerprint === undefined || architecture.sourceFingerprint === definition.fingerprint)
    && agentSourceKey(architecture) === agentSourceKey(definition)
    && Number.isSafeInteger(architecture.version) && architecture.version > 0
    && /^[a-f0-9]{64}$/.test(architecture.candidateHash ?? "")
    && definition.architectureRef?.version === architecture.version && definition.architectureRef?.candidateHash === architecture.candidateHash
    && record?.agentId === definition.id && record.status === "completed" && record.delivery === "needs_connection"
    && record.architectureRef?.version === architecture.version && record.architectureRef?.candidateHash === architecture.candidateHash
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(record.id ?? "") && reference?.id === record.id && execution!.buildId === record.id
    && /^[a-f0-9]{64}$/.test(reference.codeHash ?? "") && /^[a-f0-9]{64}$/.test(reference.planHash ?? "")
    && delivered?.codeHash === reference.codeHash && execution!.codeHash === reference.codeHash && delivered!.planHash === reference.planHash
    && active!.application?.deliveryVersion === `${record.id}:${reference.codeHash}`
    && active!.application?.manifest?.runtime === execution!.kind);
}

export function agentDevelopmentState(agent: { id: string; name?: string | undefined; draft?: unknown }, { architecture, development, definition, activeRuntime, updateStatus }: Pick<Partial<RuntimeState>, "architecture" | "development" | "definition" | "activeRuntime" | "updateStatus"> = {}) {
  const currentArchitecture = architecture?.agentId === agent.id && agentSourceKey(architecture) === agentSourceKey(agent);
  const record = currentArchitecture && matchingDevelopment(agent, architecture, development) ? development : null;
  const accepted = currentArchitecture && architecture.status === "passed";
  const active = record?.status === "running";
  const recheck = record?.status === "completed" && ["blocked", "needs_development", "needs_connection"].includes(record.delivery);
  const canConfigure = !updateStatus && record?.id === activeRuntime?.development?.id && activeApplicationAwaitingGateway(definition, activeRuntime);
  const canRestart = Boolean(!canConfigure && accepted && record?.status === "failed" && record.phase === "planning"
    && !record.tasks?.length && !record.currentTaskId && !record.package
    && record.continuation?.mode === "fresh" && record.continuation.sourceRunId === record.id);
  const canResume = Boolean(!canConfigure && !canRestart && record?.continuation?.mode !== "blocked" && accepted && record && (["blocked", "failed", "cancelled", "interrupted"].includes(record.status) || recheck));
  const canStart = Boolean(canRestart || accepted && !record && ["needs_development", "needs_connection"].includes(architecture.delivery));
  const statusLabel = record ? developmentLabels[record.status] || "研发状态待确认" : "准备研发";
  const deliveryLabel = record?.status === "completed" ? developmentDeliveries[record.delivery] || "运行状态待确认" : "";
  return { visible: Boolean(record || canStart), record, active, canResume, canStart, canConfigure, canRestart,
    actionLabel: canConfigure ? "配置本机接口" : canRestart ? "新一轮研发" : record?.continuation?.mode === "blocked" ? "需先处理阻断" : recheck ? "重新检查交付" : canResume ? "继续研发" : "开始研发",
    label: [statusLabel, deliveryLabel].filter(Boolean).join(" · "),
    summary: canRestart ? "本轮研发次数已用完，进度记录已保留。可以开启新一轮继续完善。" : typeof record?.summary === "string" && record.summary.trim() ? record.summary
      : record ? "研发进度已保存，下一步以实际检查结果为准。" : "方案已通过评估，开始后会按任务开发并检查验收。" };
}

export function agentBuildState(agent: { id: string; name?: string | undefined; draft?: unknown }, result: RuntimeResult = {}) {
  const latest = candidateBuildState(agent, result), active = result.activeRuntime;
  if (active && result.agent?.id === agent.id) {
    const running = candidateBuildState(result.agent, { agent: result.agent, architecture: active.architecture, development: active.development });
    const gatewayPending = activeApplicationAwaitingGateway(result.agent, active);
    if (running.status === "ready" || gatewayPending) {
      const updating = result.architecture?.version !== active.architecture.version || agentSourceKey(agent) !== agentSourceKey(result.agent);
      const label = gatewayPending ? "内部功能已可用，本机接口待配置。" : running.label;
      return { ...running, status: "ready", gatewayPending, activeRuntime: active, updateStatus: updating ? latest : null,
        label: updating ? `当前继续使用已激活版本。更新状态：${latest.label}` : label };
    }
  }
  return { ...latest, gatewayPending: false, activeRuntime: null, updateStatus: null };
}

function candidateBuildState(agent: { id: string; name?: string | undefined; draft?: unknown }, { agent: definition, architecture, development }: RuntimeResult = {}): BuildPresentation {
  const sourceKey = agentSourceKey(agent);
  const matchingDefinition = definition?.id === agent.id && agentSourceKey(definition) === sourceKey;
  if (architecture) {
    if (architecture.agentId !== agent.id || agentSourceKey(architecture) !== sourceKey) {
      return { status: definition ? "stale" : "missing", label: "需求已更新，请重新设计与检查。" };
    }
    let status = architecture.status, label = Object.hasOwn(architectureLabels, status) ? architectureLabels[status] : null;
    if (status === "passed") {
      status = architecture.delivery === "needs_connection" ? "needs_connection"
        : architecture.delivery === "needs_development" ? "needs_development" : "blocked";
      label = status === "needs_connection" ? "架构评估已通过，仍需连接所需能力，暂时不能运行。"
        : status === "needs_development" ? "架构评估已通过，仍需研发实现，暂时不能运行。"
          : "架构评估已通过，执行定义尚未就绪，请重新生成。";
      const reference = definition?.architectureRef;
      if (architecture.delivery === "ready" && matchingDefinition && definition.status === "ready"
        && definition.mode === "designed" && Number.isSafeInteger(architecture.version) && architecture.version > 0
        && reference?.version === architecture.version
        && typeof architecture.candidateHash === "string" && architecture.candidateHash
        && reference.candidateHash === architecture.candidateHash) {
        status = "ready";
        label = "架构评估已通过，智能体已生成，可以开始任务。";
      }
      const developmentState = agentDevelopmentState(agent, { architecture, development });
      const record = developmentState.record;
      if (record && (record.status !== "completed" || record.delivery !== "ready")) {
        status = record.status === "running" ? "developing" : record.status === "completed" && record.delivery === "needs_connection"
          ? "needs_connection" : "needs_development";
        label = `${developmentState.label}。${developmentState.summary}`;
      }
      if (definition?.developmentRef && status === "ready") {
        const reference = definition.developmentRef, delivered = record?.package || record;
        if (!record || record.status !== "completed" || record.delivery !== "ready" || reference.id !== record.id
          || !reference.codeHash || reference.codeHash !== delivered!.codeHash || !reference.planHash || reference.planHash !== delivered!.planHash) {
          status = "blocked"; label = "研发交付版本尚未核实，暂时不能运行。";
        }
      }
    }
    if (!label) { status = "blocked"; label = "架构状态尚未确认，请重新设计与检查。"; }
    const summary = typeof architecture.summary === "string" ? architecture.summary.trim() : "";
    if (["needs_input", "needs_changes", "needs_evidence", "infeasible", "failed", "cancelled"].includes(status)
      && summary && summary.length <= 160 && !/[\r\n]/u.test(summary)) label += ` ${summary}`;
    return { status, label, ...(architecture.handoff ? { handoff: architecture.handoff } : {}) };
  }
  if (!definition) return { status: "missing", label: "需求已确认，点击生成智能体开始设计与检查。" };
  return { status: "blocked", label: "旧原型已停用，请重新设计与检查后运行。" };
}

export function agentHistory(messages: Message[], revision: string | number) {
  const history: Message[] = [];
  for (let index = 0; index < messages.length - 1; index++) {
    const user = messages[index]!, reply = messages[index + 1]!;
    if (user.role !== "user" || user.delivery !== "sent" || user.revision !== String(revision)
      || reply.role !== "assistant" || reply.status !== "complete" || reply.revision !== String(revision)
      || [user, reply].some((entry) => typeof entry.content !== "string" || entry.content.length > 12_000)
      || (!user.content.trim() && !user.attachments?.length) || !reply.content.trim()) continue;
    let attachments;
    try { attachments = agentAttachmentRefs(user.attachments); } catch { continue; }
    history.push({ role: "user", content: user.content, revision: String(revision), ...(attachments.length ? { attachments } : {}) },
      { role: "assistant", content: reply.content, revision: String(revision) });
    index++;
  }
  const selected = history.slice(-40), encoder = new TextEncoder();
  while (selected.length && (selected.reduce((total, entry) => total + entry.content.length, 0) > 48_000
    || encoder.encode(JSON.stringify(selected)).length > 100_000)) selected.splice(0, 2);
  return selected;
}

interface BuildObservation { running: boolean; interrupted: boolean; error: string | null; phase?: string; label?: string; result: import("./ui-types.js").RuntimeResult }
export function createAgentRuntime(request: BrowserRequest = fetch): AgentRuntime {
  async function json<T>(path: string, body?: unknown, { signal }: RequestOptions = {}): Promise<T> {
    const options: RequestInit = body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    };
    if (signal) options.signal = signal;
    const response = await request(path, options);
    const result = await response.json() as T & { error?: string; reason?: string };
    signal?.throwIfAborted();
    if (!response.ok) {
      const error: FrontendError = new Error(result.error || "智能体请求失败，请重试。");
      error.status = response.status;
      if (typeof result.reason === "string") error.reason = result.reason;
      throw error;
    }
    return result;
  }

  const pendingOperations = new Map<string, { input: string; mutationId: string }>();
  function releaseSettledOperation(reference: OperationReference, snapshot: BuildObservation | null) {
    if (snapshot?.running !== false) return;
    const key = `${reference.domain}:${reference.ownerId}`;
    // A confirmed terminal receipt permits a new request; a lost response does not.
    if (pendingOperations.get(key)?.mutationId === reference.operationId) pendingOperations.delete(key);
  }
  const operationPath = (reference: OperationReference) => `/api/agents/${encodeURIComponent(reference.ownerId)}/operations/${encodeURIComponent(reference.operationId)}`;
  async function watchOperation(reference: OperationReference, { signal, onProgress = () => {} }: StreamOptions = {}) {
    const completed = await observeOperation(cursor => json<OperationView<BuildObservation>>(`${operationPath(reference)}${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`, undefined, { signal }), reference, {
      signal, disconnected: () => onProgress({ type: "status", label: "连接中断，正在重新连接；后台任务继续执行。" }),
      update(snapshot) {
        releaseSettledOperation(reference, snapshot);
        onProgress({ type: "status", ...(snapshot.result.architecture ? { architecture: snapshot.result.architecture } : {}), ...(snapshot.result.development ? { development: snapshot.result.development } : {}), phase: snapshot.phase, label: snapshot.label || "正在处理，进度已保存…" });
        return !snapshot.running;
      },
    });
    if (completed.interrupted) throw new Error("后台进程曾中断，已保存进度保留，请按原条件继续。");
    if (completed.error) throw new Error(completed.error);
    return completed.result;
  }
  async function background(kind: "build" | "development", id: string, body: unknown, options: StreamOptions = {}) {
    const key = `${kind}:${id}`, input = JSON.stringify(body), prior = pendingOperations.get(key);
    const receipt = prior?.input === input ? prior : { input, mutationId: crypto.randomUUID() }; pendingOperations.set(key, receipt);
    const accepted = await json<OperationView<BuildObservation>>(`/api/agents/${encodeURIComponent(id)}/operations`, { ...body as object, kind, mutationId: receipt.mutationId }, { signal: options.signal });
    releaseSettledOperation(accepted.operation, accepted.snapshot);
    options.onProgress?.({ type: "operation", operation: accepted.operation });
    return watchOperation(accepted.operation, options);
  }
  async function stream(path: string, body: unknown, { signal, onProgress = () => {} }: StreamOptions = {}, options: ReplyOptions) {
    const response = await request(path, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify(body), ...(signal ? { signal } : {}),
    });
    const result = await readReply(response, onProgress, options);
    signal?.throwIfAborted();
    if (!response.ok) throw new Error(result.error || "智能体请求失败，请重试。");
    if (!options.isComplete!(result)) throw new Error(options.incompleteMessage);
    return result;
  }

  return {
    uploadAttachment: async (id, file, { signal } = {}) => {
      const path = `/api/agents/${encodeURIComponent(id)}/attachments?name=${encodeURIComponent(file.name)}&mimeType=${encodeURIComponent(file.type || "")}`;
      const response = await request(path, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file, ...(signal ? { signal } : {}) });
      const result = await response.json() as { attachment: import("./ui-types.js").Material; error?: string }; signal?.throwIfAborted();
      if (!response.ok) throw new Error(result.error || "材料上传失败，请重试。");
      return result;
    },
    listAttachments: (id, options) => json(`/api/agents/${encodeURIComponent(id)}/attachments`, undefined, options),
    getAttachment: (id, attachmentId, options) => json(`/api/agents/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`, undefined, options),
    readAttachmentImage: async (id, attachmentId, page = 1, { signal } = {}) => {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/image?page=${page}`, { ...(signal ? { signal } : {}) });
      signal?.throwIfAborted();
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error || "材料页图预览失败，可以下载原文件。");
      }
      const blob = await response.blob(); signal?.throwIfAborted();
      const headerNumber = (name: string) => {
        const value = Number(response.headers.get(name)); return Number.isSafeInteger(value) && value > 0 ? value : null;
      };
      return { blob, page: headerNumber("x-material-page") || page, pageCount: headerNumber("x-material-page-count") };
    },
    previewAttachment: (id, attachmentId, offset = 0, options) => json(`/api/agents/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/preview?offset=${offset}`, undefined, options),
    attachmentRawUrl: (id, attachmentId, download = false) => `/api/agents/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/raw${download ? "?download=1" : ""}`,
    attachmentImageUrl: (id, attachmentId, page = 1, imageId) => `/api/agents/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/image?page=${page}${imageId ? `&imageId=${encodeURIComponent(imageId)}` : ""}`,
    inspect: (id) => json(`/api/agents/${encodeURIComponent(id)}`),
    listRequirements: (options) => json("/api/agent-requirements", undefined, options),
    saveRequirements: (id, requirement, options) => json(`/api/agents/${encodeURIComponent(id)}/requirements`, requirement, options),
    getConversation: (id, options) => json(`/api/agents/${encodeURIComponent(id)}/conversation`, undefined, options),
    saveConversation: (id, conversation, options) => json(`/api/agents/${encodeURIComponent(id)}/conversation`, conversation, options),
    listConversations: (id, options) => json(`/api/agents/${encodeURIComponent(id)}/conversations`, undefined, options),
    getHistoryConversation: (id, conversationId, options) => json(`/api/agents/${encodeURIComponent(id)}/conversations/${encodeURIComponent(conversationId)}`, undefined, options),
    saveHistoryConversation: (id, conversationId, conversation, options) => json(`/api/agents/${encodeURIComponent(id)}/conversations/${encodeURIComponent(conversationId)}`, conversation, options),
    removeConversation: (id, conversationId, options) => json(`/api/agents/${encodeURIComponent(id)}/conversations/${encodeURIComponent(conversationId)}/remove`, {}, options),
    listProfiles: (options) => json("/api/agent-profiles", undefined, options),
    saveProfile: (id, profile, options) => json(`/api/agents/${encodeURIComponent(id)}/profile`, profile, options),
    getMemory: (id, options) => json(`/api/agents/${encodeURIComponent(id)}/memory`, undefined, options),
    saveMemory: (id, memory, options) => json(`/api/agents/${encodeURIComponent(id)}/memory`, { memory }, options),
    listFiles: (id, options) => json(`/api/agents/${encodeURIComponent(id)}/files`, undefined, options),
    readFile: (id, path, options) => json(`/api/agents/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`, undefined, options),
    fileDownloadUrl: (id, path) => `/api/agents/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}&download=1`,
    async downloadFile(id, path) {
      const response = await request(`/api/agents/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}&download=1`);
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || "文件下载未完成，请重试。");
      }
      return response.blob();
    },
    getDevelopment: (id, options) => json(`/api/agents/${encodeURIComponent(id)}/development`, undefined, options),
    develop: (id, { resume = false, ...options } = {}) => stream(`/api/agents/${encodeURIComponent(id)}/development/stream`, { resume }, options, {
      isComplete: result => result?.development?.agentId === id && ["completed", "blocked", "failed", "cancelled", "interrupted"].includes(result.development.status),
      incompleteMessage: "研发连接中断，完成情况尚未确认；正在核实已保存的进度。",
    }),
    build: (agent, { architectureRepair, ...options } = {}) => stream("/api/agents/build", { id: agent.id, name: agent.name, draft: agent.draft,
      ...(architectureRepair !== undefined ? { architectureRepair } : {}) }, options, {
      isComplete: result => result?.architecture ? result.architecture.agentId === agent.id && (result.architecture.status === "passed" || Object.hasOwn(architectureLabels, result.architecture.status))
        : result?.agent?.id === agent.id && result.agent.status === "ready",
      incompleteMessage: "生成连接中断，智能体尚未确认完成，请重新生成。",
    }),
    startDevelopment: (id, { resume = false, ...options } = {}) => background("development", id, { resume }, options),
    cancelDevelopment: (id) => json(`/api/agents/${encodeURIComponent(id)}/development/cancel`, {}),
    cancelBuild: (id) => json(`/api/agents/${encodeURIComponent(id)}/build/cancel`, {}),
    watchOperation,
    cancelOperation: async reference => {
      const result = await json<OperationView<BuildObservation>>(`${operationPath(reference)}/cancel`, { generation: reference.generation });
      releaseSettledOperation(reference, result.snapshot);
      return result.snapshot!.result;
    },
    startBuild: (agent, { architectureRepair, ...options } = {}) => background("build", agent.id, { name: agent.name, draft: agent.draft,
      ...(architectureRepair !== undefined ? { architectureRepair } : {}) }, options),
    turn: (body, options) => stream("/api/agents/turn", body, options, {
      isComplete: (result) => typeof result?.reply === "string" && result.status === "complete"
        && result.agentId === body.agentId && result.sessionId === body.sessionId,
      incompleteMessage: "连接中断，回复尚未完成。已显示的内容保留，可以重新编辑后重试。",
    }),
    cancel: (sessionId) => json("/api/agents/cancel", { sessionId }),
  };
}
