import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentMakingState } from "../public/agent-build-view.js";
import { agentBuildState } from "../public/agent-runtime.js";
import { agentDisplayName } from "../public/state.js";
import { browserResult, testBrowser } from "./helpers/browser.mjs";

const agent = { id: "making-one", name: "微积分可视化学习助手", draft: { goal: { value: "通过动态几何理解微积分" } } };
const architecture = (overrides = {}) => ({ agentId: agent.id, name: agent.name, draft: agent.draft, version: 1,
  candidateHash: "candidate-1", status: "passed", delivery: "needs_development", design: { profile: "workflow" }, ...overrides });
const development = (overrides = {}) => ({ agentId: agent.id, id: "development-one", status: "running", phase: "implementing",
  architectureRef: { version: 1, candidateHash: "candidate-1" }, delivery: "needs_development", tasks: [], ...overrides });
const currentStage = (presentation) => presentation.stages.find((stage) => stage.status === "current")?.id;

test("显式重开停在架构起点并提供可用的手动开始按钮", () => {
  const pending = architecture({ status: "pending", delivery: "blocked", candidateHash: null, design: null, review: null });
  const state = agentBuildState(agent, { architecture: pending });
  assert.equal(state.status, "pending");
  const result = agentMakingState(agent, { ...state, architecture: pending });
  assert.equal(result.active, false); assert.equal(result.failed, false);
  assert.equal(result.phase, "designing"); assert.equal(result.canRetry, true);
  assert.equal(result.actionLabel, "从架构蓝图开始");
  assert.match(result.summary, /原方案与检查结果已保留/u);
  assert.deepEqual(result.stages.map(row => row.status), ["complete", "waiting", "pending", "pending", "pending"]);
});

test("阶段额度耗尽显示显式修复入口与具体原因，二次耗尽不再出现无效重生成按钮", () => {
  for (const status of ["available", "continuing", "blocked"]) {
    const result = agentMakingState(agent, { status: "failed", error: "旧的通用错误",
      architecture: architecture({ status: "failed", designRecovery: { status, message: "执行步骤尚未覆盖组件，已保留成果。" } }) });
    assert.match(result.summary, /执行步骤/u);
    assert.equal(result.canRetry, status !== "blocked");
    assert.equal(result.actionLabel, status === "available" ? "修复未完成阶段（最多2轮）"
      : status === "continuing" ? "继续修复未完成阶段" : "本次修复额度已用尽");
  }
});

test("全部模块已保存时明确继续整合，不要求重新生成或重新授权模块修复", () => {
  const result = agentMakingState(agent, { status: "failed", architecture: architecture({ status: "failed",
    designRecovery: { status: "continuing", actionLabel: "继续整合与评审", message: "全部模块已保存，不会重跑已完成模块。" } }) });
  assert.equal(result.canRetry, true); assert.equal(result.actionLabel, "继续整合与评审");
  assert.match(result.summary, /全部模块已保存/u);
});

test("已有独立评审时显示评审修订入口和专属阻断说明", () => {
  const result = agentMakingState(agent, { status: "failed", architecture: architecture({ status: "failed",
    designRecovery: { status: "available", actionLabel: "按评审修订（最多3轮）", message: "完整方案及独立评审意见已保存。" } }) });
  assert.equal(result.canRetry, true); assert.equal(result.actionLabel, "按评审修订（最多3轮）");
  assert.match(result.summary, /完整方案及独立评审/u);
});

test("未完成评审的一次手动续评显示按钮，额度耗尽后保留真实失败且关闭入口", () => {
  for (const status of ["available", "continuing", "blocked"]) {
    const result = agentMakingState(agent, { status: "failed", architecture: architecture({ status: "failed",
      diagnostic: { phase: "evaluating" }, designRecovery: { kind: "review_retry", status,
        actionLabel: "手动继续评审（最多2次）", message: "独立评审引用未通过校验，尚未形成正式结论。" } }) });
    assert.equal(result.canRetry, status !== "blocked");
    assert.equal(result.actionLabel, "手动继续评审（最多2次）");
    assert.equal(result.phase, "evaluating"); assert.match(result.summary, /尚未形成正式结论/u);
  }
});

test("评审额度耗尽仍显示继续设计，等待用户点击再开启一轮并保留真实未完成状态", () => {
  const result = agentMakingState(agent, { status: "failed", architecture: architecture({ status: "failed",
    diagnostic: { phase: "evaluating" }, designRecovery: { kind: "review_retry", status: "available", modelCalls: 9, modelCallLimit: 14,
      actionLabel: "继续设计", message: "方案和检查结果已保留，点击继续当前未完成的独立评估。",
      request: { kind: "review_continue", version: 30 } } }) });
  assert.equal(result.canRetry, true); assert.equal(result.actionLabel, "继续设计");
  assert.equal(result.phase, "evaluating"); assert.equal(result.failed, true);
  assert.equal(result.active, false); assert.equal(result.stages.at(-1).status, "pending");
});

test("本次构建错误优先于旧恢复提示，仍保留修订操作，进行中不残留失败原因", () => {
  const saved = architecture({ status: "failed", designRecovery: { status: "available", actionLabel: "按评审修订（最多3轮）",
    message: "完整方案已保存，可继续修订。" } });
  const result = agentMakingState(agent, { status: "failed", architecture: saved, error: "旧的通用额度错误",
    buildError: "本次来源摘要与冻结评审不一致" });
  assert.equal(result.summary, "本次来源摘要与冻结评审不一致");
  assert.equal(result.canRetry, true); assert.equal(result.actionLabel, "按评审修订（最多3轮）");
  const active = agentMakingState(agent, { status: "building", architecture: saved, buildError: "旧的失败",
    operation: { phase: "designing", label: "正在修订原方案" } });
  assert.equal(active.summary, "正在修订原方案");
});

test("制作阶段以当前控制器和持久记录为准，重连与方案修订保留真实阶段", () => {
  for (const phase of ["researching", "designing", "designer", "specialist"]) {
    const result = agentMakingState(agent, { status: "building", operation: { phase } });
    assert.equal(currentStage(result), "designing");
  }
  for (const phase of ["evaluating", "reviewer"]) {
    const result = agentMakingState(agent, { status: "building", operation: { phase } });
    assert.equal(currentStage(result), "evaluating");
  }
  const revised = agentMakingState(agent, { status: "building", operation: { phase: "designing" } });
  assert.equal(revised.stages.find((stage) => stage.id === "evaluating").status, "pending");
  const restored = agentMakingState(agent, { status: "evaluating", architecture: architecture({ status: "evaluating" }) });
  assert.equal(restored.active, true);
  assert.equal(currentStage(restored), "evaluating");
  const outdated = agentMakingState({ ...agent, draft: { goal: { value: "新的需求" } } },
    { status: "missing", architecture: architecture({ status: "evaluating" }) });
  assert.equal(outdated.active, false);
  assert.equal(currentStage(outdated), undefined);
});

test("读取、取消、失败和轻量交付不冒充已生成，研发整理交付单独展示", () => {
  const reading = agentMakingState(agent, { status: "checking" });
  assert.equal(reading.reading, true);
  assert.equal(reading.canRetry, false);
  assert.deepEqual(reading.stages.slice(1).map((stage) => stage.status), ["pending", "pending", "pending", "pending"]);

  const stopped = agentMakingState(agent, { status: "cancelled", architecture: architecture({ status: "cancelled" }) });
  assert.equal(stopped.headline, "生成已终止");
  assert.equal(stopped.canRetry, true);
  assert.equal(stopped.stages.find((stage) => stage.id === "designing").status, "stopped");
  const failed = agentMakingState(agent, { status: "failed",
    architecture: architecture({ status: "failed", diagnostic: { phase: "evaluating" } }) });
  assert.equal(failed.stages.find((stage) => stage.id === "evaluating").status, "blocked");
  assert.equal(failed.stages.at(-1).status, "pending");

  const preparing = agentMakingState(agent, { status: "building", operation: { phase: "packaging" },
    architecture: architecture({ design: { profile: "light" }, delivery: "blocked" }) });
  assert.equal(preparing.stages.find((stage) => stage.id === "development").status, "skipped");
  assert.equal(preparing.stages.at(-1).status, "current");
  const ready = agentMakingState(agent, { status: "ready",
    architecture: architecture({ design: { profile: "light" }, delivery: "ready" }) });
  assert.equal(ready.stages.at(-1).status, "complete");
  const developing = agentMakingState(agent, { status: "developing", architecture: architecture(), development: development() });
  assert.equal(currentStage(developing), "development");
  const packaging = agentMakingState(agent, { status: "developing", architecture: architecture(),
    development: development({ phase: "packaging" }) });
  assert.equal(currentStage(packaging), "delivery");
});

const [stylesheet, html, runtimeSource, makingSource, agentsSource, historySource] = await Promise.all([
  "style.css", "index.html", "agent-runtime.js", "agent-build-view.js", "agents.js", "sidebar-history.js",
].map((file) => readFile(new URL(`../public/${file}`, import.meta.url), "utf8")));
const stripModule = (source) => source.replace(/^import [\s\S]*?;\n/gm, "").replace(/^export /gm, "");
const literal = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");
const pageStart = html.indexOf('<section id="page-agent"');
const pageEnd = html.indexOf('<section id="page-projects"', pageStart);
assert.ok(pageStart >= 0 && pageEnd > pageStart);
const pageMarkup = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
const renderStart = agentsSource.indexOf("function renderMaking(");
const renderEnd = agentsSource.indexOf("\nfunction clearInspectionTimer", renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart);

const browserPrelude = `
  ${stripModule(runtimeSource.slice(0, runtimeSource.indexOf("export function agentHistory")))}
  ${agentDisplayName.toString()}
  function renderAgentAvatar(target) { target.textContent = "✦"; target.style.cssText = "display:grid;place-items:center;height:100%;font-size:64px;color:#409af0"; }
  ${stripModule(makingSource)}
  ${stripModule(historySource)}
  const style = document.createElement("style"); style.textContent = ${literal(stylesheet)}; document.head.append(style);
  document.body.insertAdjacentHTML("beforeend", ${literal(pageMarkup)});
  const byId = (id) => document.getElementById(id);
  for (const page of document.querySelectorAll(".page")) page.hidden = page.id !== "page-agent";
  const historyView = createSidebarHistory({ document, id: "making-history", title: ${literal(agent.name)}, href: "#agent/making-one" });
  byId("sidebar-agent-list").append(historyView.root); historyView.setExpanded(true);
  historyView.update({ records: [{ id: "first", title: "现有对话" }], renderRow(record) {
    const row = document.createElement("button"); row.className = "sidebar-history-item"; row.textContent = record.title; return row;
  } });
  byId("agent-title").textContent = ${literal(agent.name)};
  byId("agent-subtitle").textContent = ${literal(agent.draft.goal.value)};
  let currentState, makingView = null, stopped = 0, started = 0, details = 0;
  const runtime = () => currentState;
  const conversation = () => ({ turn: null });
  const stopMaking = () => stopped++;
  const developAgent = () => started++;
  const buildAgent = () => started++;
  byId("agent-panel-toggle").addEventListener("click", () => details++);
  ${agentsSource.slice(renderStart, renderEnd)}
  const agent = ${literal(agent)};
  const visible = (id) => byId(id).getClientRects().length > 0;
  const stageFacts = () => [...document.querySelectorAll(".agent-making-step")].map((step) => ({
    label: step.querySelector("strong").textContent, state: step.dataset.state, current: step.getAttribute("aria-current"),
    rect: { left: step.getBoundingClientRect().left, right: step.getBoundingClientRect().right },
  }));
`;

async function desktopBrowser(t, { reducedMotion = false } = {}) {
  const browser = await testBrowser(t);
  if (!browser) return null;
  const directory = await mkdtemp(join(tmpdir(), "neuma-making-browser-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const wrapper = join(directory, "browser");
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const flags = ["--window-size=1440,1000", ...(reducedMotion ? ["--force-prefers-reduced-motion"] : [])];
  await writeFile(wrapper, `#!/bin/sh\nexec ${[browser, ...flags].map(quote).join(" ")} "$@"\n`, { mode: 0o700 });
  return wrapper;
}

test("真实桌面浏览器制作界面隐藏原工作区，保留设置，动态阶段与终止操作可用", { timeout: 20_000 }, async (t) => {
  const browser = await desktopBrowser(t);
  if (!browser) return;
  const facts = await browserResult(t, browser, `${browserPrelude}
    currentState = { status: "building", label: "正在核实技术资料…", operation: { phase: "researching" } };
    renderMaking(agent);
    const active = {
      width: innerWidth, panel: visible("agent-making-panel"), historyVisible: visible("making-history"),
      historyInNavigation: byId("sidebar-agent-list").contains(historyView.root),
      conversation: visible("agent-conversation"), composer: visible("agent-chat-form"), artifacts: visible("agent-artifacts-open"),
      title: visible("agent-title"), settings: visible("agent-panel-toggle"), workspace: getComputedStyle(byId("agent-workspace")).display,
      stages: stageFacts(), animation: getComputedStyle(document.querySelector(".agent-making-satellite")).animationName,
      pulse: getComputedStyle(document.querySelector('[aria-current="step"] .agent-making-marker')).animationName,
      stop: makingView.stop.textContent, stopDisabled: makingView.stop.disabled,
    };
    makingView.stop.click(); makingView.details.click();
    makingView.stop.focus(); renderMaking(agent);
    const focusPreserved = document.activeElement === makingView.stop;
    currentState = { ...currentState, operation: { phase: "evaluating", stopping: true } };
    renderMaking(agent);
    const stopping = { disabled: makingView.stop.disabled, label: makingView.stop.textContent, state: makingView.root.dataset.state };
    makingView.stop.click();
    currentState = { status: "ready" }; renderMaking(agent);
    return { active, stopped, details, focusPreserved, stopping,
      ready: { panel: visible("agent-making-panel"), historyVisible: visible("making-history"),
      historyInNavigation: byId("sidebar-agent-list").contains(historyView.root), conversation: visible("agent-conversation") } };
  `);
  assert.ok(facts.active.width >= 1200);
  assert.equal(facts.active.panel, true);
  assert.equal(facts.active.historyInNavigation, true); assert.equal(facts.active.historyVisible, true);
  for (const key of ["conversation", "composer", "artifacts"]) assert.equal(facts.active[key], false);
  assert.equal(facts.active.title, true);
  assert.equal(facts.active.settings, true);
  assert.equal(facts.active.workspace, "block");
  assert.deepEqual(facts.active.stages.map((stage) => stage.state), ["complete", "current", "pending", "pending", "pending"]);
  assert.equal(facts.active.stages[1].current, "step");
  assert.ok(facts.active.stages.every((stage, index, stages) => !index || stage.rect.left >= stages[index - 1].rect.right - 1));
  assert.equal(facts.active.animation, "agent-making-orbit");
  assert.equal(facts.active.pulse, "agent-making-pulse");
  assert.equal(facts.active.stop, "终止生成");
  assert.equal(facts.active.stopDisabled, false);
  assert.equal(facts.stopped, 1);
  assert.equal(facts.details, 1);
  assert.equal(facts.focusPreserved, true);
  assert.deepEqual(facts.stopping, { disabled: true, label: "正在终止…", state: "stopping" });
  assert.deepEqual(facts.ready, { panel: false, historyVisible: true, historyInNavigation: true, conversation: true });
});

test("真实浏览器减少动态效果时停止动画，失败文字安全展示并可重新生成", { timeout: 20_000 }, async (t) => {
  const browser = await desktopBrowser(t, { reducedMotion: true });
  if (!browser) return;
  const unsafeText = '<img src="x" onerror="window.makingInjected=true"><script>window.makingInjected=true</script>';
  const facts = await browserResult(t, browser, `${browserPrelude}
    currentState = { status: "building", operation: { phase: "evaluating" } }; renderMaking(agent);
    const animations = [...document.querySelectorAll(".agent-making-satellite,.agent-making-avatar,.agent-making-marker")]
      .map((node) => getComputedStyle(node).animationName);
    currentState = { status: "failed", error: ${literal(unsafeText)} };
    renderMaking({ ...agent, profile: { name: ${literal(unsafeText)} } });
    const failed = { summary: document.querySelector(".agent-making-status-copy p").textContent,
      name: document.querySelector(".agent-making-name").textContent,
      activeContent: makingView.root.querySelectorAll("script,img,iframe").length,
      injected: Boolean(window.makingInjected), alert: document.querySelector(".agent-making-status").dataset.error,
      state: makingView.root.dataset.state, stop: makingView.stop, start: makingView.start.textContent };
    makingView.start.click();
    return { reduced: matchMedia("(prefers-reduced-motion: reduce)").matches, animations, failed, started };
  `);
  assert.equal(facts.reduced, true);
  assert.deepEqual(facts.animations, Array(facts.animations.length).fill("none"));
  assert.equal(facts.failed.summary, unsafeText);
  assert.equal(facts.failed.name, unsafeText);
  assert.equal(facts.failed.activeContent, 0);
  assert.equal(facts.failed.injected, false);
  assert.equal(facts.failed.alert, "true");
  assert.equal(facts.failed.state, "paused");
  assert.equal(facts.failed.stop, null);
  assert.equal(facts.failed.start, "重新生成");
  assert.equal(facts.started, 1);
});
