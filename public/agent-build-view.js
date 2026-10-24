import { agentDevelopmentState, agentSourceKey } from "./agent-runtime.js";
import { agentDisplayName } from "./state.js";
import { renderAgentAvatar } from "./agent-avatar.js";

const THOUGHT_ROLES = { designer: "架构设计", reviewer: "独立评估", specialist: "模块顾问" };
const THOUGHT_LIMIT = 24_000;

export function rememberArchitectureThought(segments = [], event) {
  if (!THOUGHT_ROLES[event?.role]) return segments;
  const next = segments.map((item) => ({ role: item.role, text: item.text, closed: item.closed === true }));
  const last = next.at(-1);
  if (event.break) {
    if (last) last.closed = true;
    return next;
  }
  const delta = typeof event.delta === "string" ? event.delta.slice(0, 2000) : "";
  if (!delta) return segments;
  if (last?.role === event.role && !last.closed) last.text += delta;
  else next.push({ role: event.role, text: delta, closed: false });
  let total = next.reduce((sum, item) => sum + item.text.length, 0);
  while (total > THOUGHT_LIMIT && next.length > 1) total -= next.shift().text.length;
  if (next[0]?.text.length > THOUGHT_LIMIT) next[0].text = next[0].text.slice(-THOUGHT_LIMIT);
  return next.filter((item) => item.text);
}

const makingStages = [["requirements", "需求确认"], ["designing", "架构设计"], ["evaluating", "独立评估"],
  ["development", "按需研发"], ["delivery", "运行交付"]];

export function agentMakingState(agent, state) {
  const architecture = state.architecture?.agentId === agent.id && agentSourceKey(state.architecture) === agentSourceKey(agent)
    ? state.architecture : null;
  const development = agentDevelopmentState(agent, state);
  const recovery = architecture?.designRecovery;
  const operation = state.operation;
  const active = Boolean(operation || ["designing", "evaluating"].includes(architecture?.status) || development.active);
  const stopping = Boolean(operation?.stopping || operation?.controller?.signal.aborted);
  const reading = ["checking", "unchecked"].includes(state.status) && !active;
  const hasDevelopment = Boolean(development.record || ["workflow", "custom"].includes(architecture?.design?.profile));
  let phase = "designing";
  if (operation?.phase ? ["evaluating", "reviewer"].includes(operation.phase) : architecture?.status === "evaluating") phase = "evaluating";
  if (architecture?.status === "passed") phase = hasDevelopment ? "development" : "delivery";
  if (development.record?.phase === "packaging" || operation?.phase === "packaging") phase = "delivery";
  if (architecture?.diagnostic?.phase === "evaluating") phase = "evaluating";
  const stopped = architecture?.status === "cancelled" || development.record?.status === "cancelled" || state.status === "cancelled";
  const failed = ["failed", "error", "infeasible", "needs_changes", "needs_evidence", "blocked"].includes(state.status)
    || ["failed", "blocked", "interrupted"].includes(development.record?.status);
  const headline = stopping ? "正在终止生成" : reading ? "正在读取制作进度" : active ? "正在制作你的 Agent"
    : stopped ? "生成已终止" : failed ? "制作暂未完成" : development.canResume ? "等待继续制作"
      : state.status === "needs_connection" ? "等待连接所需能力" : "准备制作你的 Agent";
  const summary = stopping ? "正在停止当前操作并保存进度，请稍候。"
    : reading ? "正在核实这个智能体已保存的状态。"
      : (!active && state.buildError) || (!active && recovery?.message) || state.error || (active ? operation?.label || state.label : development.visible ? development.summary : state.label)
        || "需求已经确认，可以开始设计与检查。";
  const index = makingStages.findIndex(([id]) => id === phase);
  const stages = makingStages.map(([id, title], position) => {
    let status = "pending", label = "待开始";
    if (id === "requirements") { status = "complete"; label = "已确认"; }
    else if (!reading && position < index) { status = "complete"; label = "已完成"; }
    if (id === "development" && architecture?.status === "passed" && !hasDevelopment) { status = "skipped"; label = "无需研发"; }
    if (id === "delivery" && state.status === "ready") { status = "complete"; label = "已就绪"; }
    else if (!reading && position === index) {
      status = active ? "current" : stopped ? "stopped" : failed ? "blocked" : "waiting";
      label = stopping ? "正在停止" : active ? "进行中" : stopped ? "已终止" : failed ? "未完成" : "待继续";
    }
    return { id, title, status, label };
  });
  return { active, stopping, reading, stopped, failed, phase, headline, summary, stages, development,
    canRetry: !active && !reading && recovery?.status !== "blocked", actionLabel: development.canStart || development.canResume ? development.actionLabel
      : architecture?.status === "pending" ? "从架构蓝图开始"
      : recovery?.status === "available" ? recovery.actionLabel || "修复未完成阶段（最多2轮）"
        : recovery?.status === "continuing" ? recovery.actionLabel || "继续修复未完成阶段"
          : recovery?.status === "blocked" ? recovery.actionLabel || "本次修复额度已用尽"
      : stopped || failed ? "重新生成" : "开始生成" };
}

export function createAgentMakingView(agent, state, { onStop, onStart, onDetails, thoughtsOpen = false } = {}, documentRef = document) {
  const make = (tag, className, text = "") => {
    const node = documentRef.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const presentation = agentMakingState(agent, state);
  const root = make("section", "agent-making");
  root.dataset.state = presentation.stopping ? "stopping" : presentation.active ? "active" : "paused";
  root.setAttribute("aria-label", "智能体制作进度");
  const hero = make("div", "agent-making-hero");
  const orbit = make("div", "agent-making-orbit"); orbit.setAttribute("aria-hidden", "true");
  const ring = make("span", "agent-making-ring"), satellite = make("span", "agent-making-satellite");
  const avatar = make("span", "agent-making-avatar"); renderAgentAvatar(avatar, agent, { document: documentRef });
  orbit.append(ring, satellite, avatar);
  const copy = make("div", "agent-making-copy");
  copy.append(make("span", "agent-making-eyebrow", "NEUMA · 智能体制作"), make("h2", "agent-making-title", presentation.headline),
    make("p", "agent-making-name", agentDisplayName(agent)));
  hero.append(orbit, copy); root.append(hero);
  const steps = make("ol", "agent-making-steps"); steps.setAttribute("aria-label", "智能体制作流程");
  for (const [index, stage] of presentation.stages.entries()) {
    const step = make("li", "agent-making-step"); step.dataset.state = stage.status;
    if (stage.status === "current") step.setAttribute("aria-current", "step");
    const marker = make("span", "agent-making-marker", stage.status === "complete" ? "✓" : stage.status === "skipped" ? "—" : String(index + 1));
    marker.setAttribute("aria-hidden", "true");
    step.append(marker, make("strong", "", stage.title), make("span", "agent-making-step-label", stage.label)); steps.append(step);
  }
  root.append(steps);
  const status = make("div", "agent-making-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  if (presentation.failed && !presentation.active) status.dataset.error = "true";
  const phase = presentation.reading ? "读取进度" : presentation.stages.find((stage) => stage.id === presentation.phase)?.title;
  status.append(make("span", "agent-making-status-dot"), make("div", "agent-making-status-copy"));
  status.children[1].append(make("strong", "", presentation.stopping ? "正在保存进度" : phase), make("p", "", presentation.summary));
  root.append(status);
  const thoughts = make("details", "agent-making-thoughts");
  thoughts.open = thoughtsOpen;
  const thoughtSummary = documentRef.createElement("summary");
  const thoughtMark = make("span", "agent-making-thoughts-mark"); thoughtMark.setAttribute("aria-hidden", "true");
  const thoughtTitle = make("span", "agent-making-thoughts-title", "架构思考");
  const thoughtMeta = make("span", "agent-making-thoughts-meta", "");
  const thoughtChevron = make("span", "agent-making-thoughts-chevron"); thoughtChevron.setAttribute("aria-hidden", "true");
  thoughtSummary.append(thoughtMark, thoughtTitle, thoughtMeta, thoughtChevron);
  const thoughtBody = make("div", "agent-making-thoughts-body");
  thoughts.append(thoughtSummary, thoughtBody);
  const showThoughts = () => {
    const segments = (state.architectureThoughts ?? []).filter((item) => item.text);
    const waiting = presentation.active && ["designing", "evaluating"].includes(presentation.phase);
    thoughts.hidden = !segments.length && !waiting;
    const latest = segments.at(-1);
    thoughtMeta.textContent = latest
      ? `${THOUGHT_ROLES[latest.role] || "架构设计"}${presentation.active ? " · 正在写" : ""}`
      : "思考会写在这里";
    const previous = thoughtBody.scrollTop;
    const nearEnd = thoughtBody.scrollHeight - previous - thoughtBody.clientHeight < 48;
    thoughtBody.replaceChildren();
    if (!segments.length) {
      thoughtBody.append(make("p", "agent-making-thought-empty", "设计者、独立评估和模块顾问的思考会写在这里。"));
      return;
    }
    for (const segment of segments) {
      const block = make("article", "agent-making-thought");
      block.append(make("p", "agent-making-thought-role", THOUGHT_ROLES[segment.role] || "架构设计"),
        make("p", "agent-making-thought-text", segment.text));
      thoughtBody.append(block);
    }
    thoughtBody.scrollTop = nearEnd ? thoughtBody.scrollHeight : previous;
  };
  showThoughts();
  root.append(thoughts);
  const actions = make("div", "agent-making-actions");
  const details = make("button", "ghost-button", "查看需求与方案"); details.type = "button"; details.addEventListener("click", onDetails); actions.append(details);
  let stop = null, start = null;
  if (presentation.active) {
    stop = make("button", "secondary agent-making-stop", presentation.stopping ? "正在终止…" : "终止生成");
    stop.type = "button"; stop.disabled = presentation.stopping; stop.addEventListener("click", onStop); actions.append(stop);
  } else if (presentation.canRetry) {
    start = make("button", "primary", presentation.actionLabel); start.type = "button"; start.addEventListener("click", onStart); actions.append(start);
  }
  root.append(actions);
  return { root, stop, start, details, presentation, thoughts, thoughtBody, syncThoughts: showThoughts };
}
