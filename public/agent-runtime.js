import { readReply } from "./chat-ui.js";

export function agentSourceKey(agent) {
  return JSON.stringify({ name: agent.name, draft: agent.draft });
}

const architectureLabels = {
  designing: "正在设计架构，尚未生成可运行的智能体。",
  evaluating: "正在检查架构，尚未生成可运行的智能体。",
  needs_changes: "架构需要调整，请根据下列问题修改需求或重新检查。",
  needs_evidence: "架构待补充依据，补齐后才能继续生成。",
  infeasible: "当前方案无法满足需求，请调整需求或所需能力。",
  failed: "架构处理失败，可以重新设计与检查。",
  cancelled: "架构处理已停止，可以重新设计与检查。",
};

export const developmentPhases = [["intake", "接收设计"], ["planning", "拆分任务"], ["implementing", "开发任务"],
  ["verifying", "检查验收"], ["packaging", "整理交付"]];
const developmentLabels = { running: "研发进行中", completed: "研发已完成", blocked: "研发受阻", failed: "研发失败",
  cancelled: "研发已取消", interrupted: "研发已中断" };
const developmentDeliveries = { blocked: "暂时不能运行", needs_development: "仍需研发或运行适配", needs_connection: "待连接所需能力", ready: "已通过运行检查" };

function matchingDevelopment(agent, architecture, development) {
  return Boolean(architecture && development?.agentId === agent.id && development.architectureRef?.version === architecture.version
    && typeof architecture.candidateHash === "string" && architecture.candidateHash
    && development.architectureRef?.candidateHash === architecture.candidateHash);
}

export function agentDevelopmentState(agent, { architecture, development } = {}) {
  const currentArchitecture = architecture?.agentId === agent.id && agentSourceKey(architecture) === agentSourceKey(agent);
  const record = currentArchitecture && matchingDevelopment(agent, architecture, development) ? development : null;
  const accepted = currentArchitecture && architecture.status === "passed";
  const active = record?.status === "running";
  const recheck = record?.status === "completed" && ["blocked", "needs_development", "needs_connection"].includes(record.delivery);
  const canResume = Boolean(accepted && record && (["blocked", "failed", "cancelled", "interrupted"].includes(record.status) || recheck));
  const canStart = Boolean(accepted && !record && ["needs_development", "needs_connection"].includes(architecture.delivery));
  const statusLabel = record ? developmentLabels[record.status] || "研发状态待确认" : "准备研发";
  const deliveryLabel = record?.status === "completed" ? developmentDeliveries[record.delivery] || "运行状态待确认" : "";
  return { visible: Boolean(record || canStart), record, active, canResume, canStart,
    actionLabel: recheck ? "重新检查交付" : canResume ? "继续研发" : "开始研发",
    label: [statusLabel, deliveryLabel].filter(Boolean).join(" · "),
    summary: typeof record?.summary === "string" && record.summary.trim() ? record.summary
      : record ? "研发进度已保存，下一步以实际检查结果为准。" : "方案已通过评估，开始后会按任务开发并检查验收。" };
}

export function agentBuildState(agent, { agent: definition, architecture, development } = {}) {
  const sourceKey = agentSourceKey(agent);
  const matchingDefinition = definition?.id === agent.id && agentSourceKey(definition) === sourceKey;
  if (architecture) {
    if (architecture.agentId !== agent.id || agentSourceKey(architecture) !== sourceKey) {
      return { status: definition ? "stale" : "missing", label: "需求已更新，请重新设计与检查。" };
    }
    const details = [architecture.summary, ...(Array.isArray(architecture.issues) ? architecture.issues : [])
      .flatMap((issue) => [issue?.description, issue?.remedy])]
      .filter((text) => typeof text === "string" && text.trim());
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
          || !reference.codeHash || reference.codeHash !== delivered.codeHash || !reference.planHash || reference.planHash !== delivered.planHash) {
          status = "blocked"; label = "研发交付版本尚未核实，暂时不能运行。";
        }
      }
    }
    if (!label) { status = "blocked"; label = "架构状态尚未确认，请重新设计与检查。"; }
    return { status, label: [label, ...new Set(details)].join(" ") };
  }
  if (!definition) return { status: "missing", label: "需求已确认，点击生成智能体开始设计与检查。" };
  return { status: "blocked", label: "旧原型已停用，请重新设计与检查后运行。" };
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
    getDevelopment: (id, options) => json(`/api/agents/${encodeURIComponent(id)}/development`, undefined, options),
    develop: (id, { resume = false, ...options } = {}) => stream(`/api/agents/${encodeURIComponent(id)}/development/stream`, { resume }, options, {
      isComplete: (result) => result?.development?.agentId === id
        && ["completed", "blocked", "failed", "cancelled", "interrupted"].includes(result.development.status),
      incompleteMessage: "研发连接中断，完成情况尚未确认；正在核实已保存的进度。",
    }),
    cancelDevelopment: (id) => json(`/api/agents/${encodeURIComponent(id)}/development/cancel`, {}),
    build: (agent, options) => stream("/api/agents/build", { id: agent.id, name: agent.name, draft: agent.draft }, options, {
      isComplete: (result) => result?.architecture
        ? result.architecture.agentId === agent.id && (result.architecture.status === "passed"
          || Object.hasOwn(architectureLabels, result.architecture.status))
        : result?.agent?.id === agent.id && result.agent.status === "ready",
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
