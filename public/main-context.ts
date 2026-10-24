import type { AgentRequirement, RequirementDraft, RequirementHandoff } from "./ui-types.js";
import type { CollaborationApi, GroupView, MainPanelContext } from "./ui-api-types.js";
import type { RuntimeChanged } from "./browser-events.js";
type RequirementFieldKey = "name" | "agentType" | "goal" | "scenario" | "inputSource" | "task" | "deliverable" | "successCriteria" | "routingCondition";
interface PanelCapture { context: MainPanelContext | null; open: boolean; suppressed: string | null }
import { pageElement, type PageElements } from "./page-elements.js";
import { errorInfo } from "./ui-types.js";
import { button, internalLinks, node, notice, renderTasks } from "./group-view.js";
import { agentBuildState } from "./agent-runtime.js";

const buildLabels: Record<string, string> = { checking: "正在读取制作进度…", unchecked: "正在读取制作进度…",
  building: "正在制作智能体…", designing: "正在设计方案…", evaluating: "正在检查方案…", developing: "正在开发与验收…",
  needs_connection: "需要配置连接，请打开智能体查看。", needs_development: "制作尚未完成，请打开智能体继续。",
  needs_input: "需要补充影响交付的关键选择。",
  cancelled: "制作已停止，可以打开智能体继续。" };

export function createMainContext({ api, current, submit, edit, build }: { api: CollaborationApi; current: () => { id: string } | null; submit: (message: string) => unknown; edit: (message: string) => unknown; build: (agentId: string | undefined, requirement: AgentRequirement | undefined) => unknown }) {
  const byId = <K extends keyof PageElements>(id: K) => pageElement(document, id);
  const disclosureState = new Map<string, boolean>();
  let context: MainPanelContext | null = null, open = false, page = "chat", generation = 0, controller: AbortController | null = null, timer: number | undefined, polling = false, groupView: GroupView | null = null, suppressed: string | null = null;
  const identity = () => JSON.stringify({ conversationId: current()?.id, type: context?.type, groupId: context?.groupId, taskId: context?.taskId, agentId: context?.agentId });
  function stopPolling() { generation++; controller?.abort(); controller = null; clearInterval(timer); timer = undefined; polling = false; }
  function layout() {
    const visible = Boolean(open && context && page === "chat");
    const isRequirement = context?.type === "requirements";
    const panel = byId("main-context-panel"), opener = byId("main-context-open");
    opener.hidden = !context || visible;
    if (!visible && page === "chat" && panel.contains?.(document.activeElement)) byId(context ? "main-context-open" : "main-message").focus();
    panel.inert = !visible; panel.setAttribute("aria-hidden", String(!visible));
    panel.classList.toggle("side-panel", isRequirement);
    panel.classList.toggle("main-requirements-panel", isRequirement);
    byId("main-context-requirement-status").hidden = !isRequirement;
    byId("main-workspace").classList.toggle("context-open", visible);
    byId("main-context-open").textContent = context?.type === "requirements" ? "需求说明" : "群任务";
    byId("main-context-open").setAttribute("aria-expanded", String(visible));
  }
  function requirements() {
    const target = byId("main-context-content"), draft: Partial<RequirementDraft> = context!.draft || {};
    const fields = [["name", "Agent 名称"], ["agentType", "初步类型", "待判断"], ["goal", "核心目标"], ["scenario", "使用场景"],
      ["inputSource", "每次输入"], ["task", "核心任务与处理方式"], ["deliverable", "输出结果"], ["successCriteria", "完成标准", "暂无额外标准"]] as const;
    const valueOf = (key: RequirementFieldKey) => typeof draft[key] === "string" ? draft[key] : draft[key]?.value;
    const hasDraft = fields.some(([key]) => valueOf(key)) || valueOf("routingCondition") || draft.constraints?.length || draft.unresolved?.length;
    byId("main-context-title").textContent = "需求说明";
    const status = byId("main-context-requirement-status"); status.className = `status ${context!.status}`;
    status.textContent = context!.confirmed ? "需求已确认" : context!.status === "ready" ? "待你确认" : hasDraft ? "待补充" : "等待描述";
    target.append(node("p", "muted-note", "边聊边整理，你随时可以修改。"));
    const steps = node("ol", "brief-steps"); steps.setAttribute("aria-label", "创建进度");
    const currentStep = context!.confirmed ? 2 : context!.status === "ready" ? 1 : 0;
    for (const [index, label] of ["描述想法", "确认需求", "生成并使用"].entries()) {
      const step = node("li"); step.append(node("span", "", String(index + 1)), node("span", "brief-step-label", label));
      if (index === currentStep) step.setAttribute("aria-current", "step"); steps.append(step);
    }
    target.append(steps);
    const content = node("div", "draft-content");
    if (!hasDraft) {
      const empty = node("div", "brief-empty"), illustration = node("div", "brief-illustration");
      illustration.setAttribute("aria-hidden", "true"); illustration.append(node("span"), node("span"), node("span"));
      empty.append(illustration, node("h3", "", "想法在这里成形"), node("p", "", "聊过的目标、材料和预期结果，\n会整理成一份清晰的需求说明。")); content.append(empty);
    } else {
      const sourceLabels: Record<string, string> = { user: "用户说明", inferred: "直接推导", default: "系统暂定", unknown: "未明确" };
      const choiceFields = new Set(["每次输入", "核心任务与处理方式", "输出结果", "完成标准"]);
      const typeLabels: Record<string, string> = { "Knowledge Agent": "知识类", "Analysis Agent": "分析类", "Generation Agent": "生成类", "Data Agent": "数据类", "Workflow Agent": "流程类" };
      const appendField = (label: string, value: string | undefined, source?: string, emptyLabel = "尚未明确") => {
        const row = node("div", "draft-field"), heading = node("div", "field-label"); heading.append(node("span", "", label));
        if (sourceLabels[source!]) heading.append(node("span", "source", source === "inferred" && choiceFields.has(label) ? "建议，待核对" : sourceLabels[source!]));
        row.append(heading, node("div", `field-value${value ? "" : " empty"}`, value || emptyLabel)); content.append(row);
      };
      for (const [key, label, emptyLabel] of fields) appendField(label, key === "agentType" ? typeLabels[valueOf(key)!] || valueOf(key) : valueOf(key), draft[key]?.source, emptyLabel);
      appendField("工作限制", draft.constraints?.map((item) => item.text || item).join("；"));
      appendField("建议调用场景", valueOf("routingCondition"), draft.routingCondition?.source);
      appendField("使用方式", draft.usage?.detail, draft.usage?.source);
      const action = draft.externalAction;
      const actionText = action?.mode === "none" ? "不执行对外动作" : action?.mode === "possible" ? "是否执行对外动作仍需明确"
        : [action?.operation, action?.target, action?.scope, action?.trigger].filter(Boolean).join("；");
      appendField("对外动作", actionText, action?.source);
      appendField("能力连接状态", "运行原型支持文字任务和专属目录文件读写；其他外部能力需后续连接");
      appendField("能力依赖", draft.capabilityDependencies?.join("；"), "", "暂无已知依赖");
      appendField("未解决事项", draft.unresolved?.join("；"), "", "暂无");
    }
    target.append(content);
    if (hasDraft && !context!.confirmed && context!.lastQuestion) { const question = node("div", "main-context-question"); question.append(node("h3", "", "当前待确认"), node("p", "", context!.lastQuestion)); target.append(question); }
    const actions = node("div", "panel-actions");
    if (!context!.confirmed && context!.status === "ready") actions.append(button("确认需求并开始制作", () => submit("确认需求"), "primary"));
    const handoff = context!.buildState?.handoff || context!.buildState?.updateStatus?.handoff;
    if (handoff) actions.append(button("继续澄清需求", () => submit("继续澄清这个智能体的需求"), "primary"));
    else if (context!.confirmed && context!.agentId) actions.append(button("制作智能体", () => build(context!.agentId, context!.requirement), "primary"));
    if (actions.children.length) target.append(actions);
    const buildStatus = context!.buildState?.status || context!.buildStatus;
    if (buildStatus && buildStatus !== "ready") target.append(node("p", "main-context-status",
      buildLabels[buildStatus] || "制作尚未完成，请打开智能体查看。"));
    else if (!buildStatus && context!.confirmed) target.append(node("p", "muted-note small", "需求确认后仍需架构评估与运行检查，进度会依据实际状态更新。"));
    const disclosure = (label: string) => {
      const details = node("details", "panel-disclosure"), summary = node("summary", "", label), mark = node("span", "", "＋");
      const key = `${identity()}:${label}`; details.open = disclosureState.get(key) === true;
      details.addEventListener("toggle", () => disclosureState.set(key, details.open));
      mark.setAttribute("aria-hidden", "true"); summary.append(mark);
      const body = node("div", "disclosure-content"); details.append(summary, body); target.append(details); return body;
    };
    const taskItems = (draft.taskSpec?.items || []).filter((item) => item.applicability === "applies" && item.content);
    if (taskItems.length) {
      const requirements = disclosure(`具体任务要求（${taskItems.length}项）`), list = node("ul", "task-spec-list");
      const labels: Record<string, string> = { input_scale: "输入与规模", processing: "处理要求", delivery: "交付标准", workflow: "工作过程",
        data_lifecycle: "数据保存与使用", external_conditions: "外部条件" };
      for (const item of taskItems) {
        const row = node("li"); row.append(node("strong", "", labels[item.dimension] || "任务要求"), node("p", "", item.content)); list.append(row);
      }
      requirements.append(list);
    }
    const tools = disclosure("保存与导出"), toolActions = node("div", "panel-actions");
    toolActions.append(button("继续修改", () => edit("我想修改这项需求："), "secondary"));
    const exportButton = button("导出需求 JSON", () => {
      const blob = new Blob([JSON.stringify({ agentId: context!.agentId, status: context!.status, confirmed: context!.confirmed, draft,
        exportedAt: new Date().toISOString() }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob), link = node("a"); link.href = url; link.download = "neuma-agent-requirements.json";
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }, "secondary"); exportButton.disabled = !hasDraft; toolActions.append(exportButton);
    tools.append(toolActions, node("p", "muted-note small", "需求与对话自动保存，重新打开这份对话可继续。"));
    disclosure("关于这份需求").append(node("p", "muted-note", "确认后，智能体会拥有左侧的独立入口。后续可以回到 NEUMA 继续迭代。"));
    target.append(node("p", "panel-footnote", "确认后生成可对话的助手\n先试用，再逐步完善"));
  }
  function group() {
    const target = byId("main-context-content"); byId("main-context-title").textContent = groupView?.group?.name || "群任务";
    if (!groupView) { target.append(node("p", "muted-note", "正在读取这个群的实际进展…")); return; }
    if (groupView.group.purpose) target.append(node("p", "muted-note", groupView.group.purpose));
    const tasks = context!.taskId ? groupView.tasks.filter((task) => task.id === context!.taskId) : groupView.tasks;
    const taskTarget = node("div", "main-context-tasks");
    renderTasks(taskTarget, tasks, context!.taskId || "", { members: groupView.members, onSelect(taskId) { set({ ...context!, taskId }, { reveal: true }); },
      async onStop(taskId) {
        const key = identity(), id = context!.groupId;
        try { await api.cancelTask(id!, taskId); if (key === identity()) await readGroup(); }
        catch (caught) { const error = errorInfo(caught); if (key === identity() && open) notice(byId("main-context-error"), error.message, true); }
      } });
    target.append(taskTarget, internalLinks(`#group/${context!.groupId}`));
    if (context!.taskId && !tasks.length) target.append(node("p", "muted-note", "当前任务未找到，可打开群组查看其他已保存记录。"));
  }
  function render() { layout(); if (!open || !context || page !== "chat") return; byId("main-context-content").replaceChildren(); if (context!.type === "requirements") requirements(); else group(); }
  async function readGroup() {
    if (!open || page !== "chat" || context?.type !== "group" || polling) return;
    const token = generation, key = identity(), id = context!.groupId;
    const request = new AbortController(); controller = request; polling = true;
    try {
      const result = await api.group(id!, { signal: request.signal });
      if (generation !== token || key !== identity() || !open || page !== "chat") return;
      if (result.group?.id !== id) throw new Error("群资料身份尚未确认。");
      const changed = JSON.stringify(groupView) !== JSON.stringify(result);
      groupView = result; notice(byId("main-context-error"), ""); if (changed) render();
    } catch (caught) { const error = errorInfo(caught); if (!request.signal.aborted && token === generation && key === identity()) notice(byId("main-context-error"), `进度暂时无法读取：${error.message}`, true); }
    finally { if (token === generation) { polling = false; controller = null; } }
  }
  async function readRequirement() {
    if (!open || page !== "chat" || context?.type !== "requirements" || !context!.confirmed || !context!.agentId || polling) return;
    const token = generation, key = identity(); controller = new AbortController(); polling = true;
    try {
      const result = await api.inspectAgent(context!.agentId, { signal: controller.signal });
      if (token !== generation || key !== identity() || !open || page !== "chat") return;
      const requirement = context!.requirement || { id: context!.agentId, name: context!.name || context!.draft?.name?.value, draft: context!.draft };
      const buildState = agentBuildState(requirement, result), changed = JSON.stringify(context!.buildState) !== JSON.stringify(buildState);
      context = { ...context, buildState }; notice(byId("main-context-error"), ""); if (changed) render();
    } catch (caught) { const error = errorInfo(caught); if (token === generation && !controller?.signal.aborted) notice(byId("main-context-error"), error.message, true); }
    finally { if (token === generation) { polling = false; controller = null; } }
  }
  function startPolling() {
    if (timer || !open || page !== "chat" || !context) return;
    if (context!.type === "requirements" && (!context!.confirmed || !context!.agentId)) return;
    const read = context!.type === "group" ? readGroup : readRequirement;
    void read(); timer = setInterval(() => { if (!document.hidden) void read(); }, 2500);
  }
  function set(value: MainPanelContext | null | undefined, { reveal = false, force = false } = {}) {
    if (value !== null && value !== undefined && !["requirements", "group"].includes(value.type)) return;
    const previous = identity(), previousValue = JSON.stringify(context); context = value || null;
    if (reveal && context && (force || suppressed !== identity())) open = true;
    if (!context) open = false;
    if (previous !== identity()) { stopPolling(); groupView = null; notice(byId("main-context-error"), ""); }
    if (previousValue !== JSON.stringify(context)) render(); else layout();
    if (open && page === "chat" && !timer) startPolling();
  }
  byId("main-context-close").addEventListener("click", () => { suppressed = identity(); open = false; stopPolling(); layout(); byId("main-context-open").focus(); });
  byId("main-context-open").addEventListener("click", () => { suppressed = null; open = true; render(); startPolling(); byId("main-context-close").focus(); });
  layout();
  return { set, capture() { return { context: structuredClone(context), open, suppressed }; },
    restore(value: PanelCapture) { stopPolling(); groupView = null; context = value.context; open = value.open; suppressed = value.suppressed; notice(byId("main-context-error"), ""); render(); startPolling(); },
    reset(value: MainPanelContext | null | undefined) { stopPolling(); groupView = null; context = null; open = false; suppressed = null; set(value, { reveal: Boolean(value) }); },
    route(value: string) { page = value; stopPolling(); render(); startPolling(); },
    runtime(detail: RuntimeChanged) { if (context?.type === "requirements" && context!.agentId === detail.agentId
      && JSON.stringify(context!.buildState) !== JSON.stringify(detail)) { context = { ...context, buildState: detail }; render(); } } };
}
