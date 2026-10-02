const SOURCES = new Set(["user", "inferred", "default", "unknown"]);
const USAGE_MODES = new Set(["on_demand", "scheduled", "event", "unclear"]);
const ACTION_MODES = new Set(["none", "possible", "requested"]);
const GAP_ORDER = ["goal", "scenario", "source", "task", "deliverable", "boundary",
  "conflict", "external_boundary", "trigger"];
const GAP_SET = new Set([...GAP_ORDER, "none"]);
const LEGACY_CONFIRMATION_QUESTION = "这是你想要的吗？如果没有需要修改的地方，我们就可以进入下一步创建。";
export const CONFIRMATION_QUESTION = "这份需求可以确认吗？请回复“确认”，或直接说需要修改的地方。";
const CONFIRMATION_CLARIFICATION_QUESTION = "你说的“没有”，是没有需要修改、可以确认吗？请回复“确认”；如果这份需求不对，请说要改哪里。";
const CONFIRMATION_OPTIONS_QUESTION = "请回复“确认”，或直接说要修改哪一部分。";
const REVISION_QUESTION = "我们先找出偏差：1）目标理解错了；2）处理方式不合适；3）结果的形式或深度不合适；4）我还说不清。你只需选一个，我再接着问。";
const BOUNDARY_QUESTION = "这件事做到什么程度才算合格？有没有必须遵守或绝对不能做的事？";

export class InputError extends Error {}
export class ProviderError extends Error {
  constructor(message, diagnostic = { stage: "provider", reason: "unknown" }) {
    super(message);
    this.diagnostic = diagnostic;
  }
}

function cleanText(value, max = 1200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function shortReply(value) {
  return value.replace(/[\s，,。.!！?？]/g, "");
}

function isConfirmationPrompt(question) {
  return [LEGACY_CONFIRMATION_QUESTION, CONFIRMATION_QUESTION,
    CONFIRMATION_CLARIFICATION_QUESTION, CONFIRMATION_OPTIONS_QUESTION].includes(question);
}

function isApproval(value) {
  return new Set(["确认", "确认需求", "是", "是的", "是的就是这样", "对",
    "对的就是这样", "可以", "可以确认",
    "没问题", "没有修改", "没有需要修改", "不需要修改", "就这样",
    "就这样吧", "先这样吧"]).has(shortReply(value));
}

function isRejection(value) {
  return new Set(["没有", "不", "不是", "不对", "不是这样", "不能确认",
    "要修改", "都不对", "全部不对", "不太对", "不是我想要的", "不合适"]).has(shortReply(value));
}

function userMessagesForTurn(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12
      || value.some((item) => typeof item !== "string" || item.length > 4000)
      || value.reduce((total, item) => total + item.length, 0) > 12000) {
    throw new InputError("当前对话原文格式无效或过长");
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function declinesExtraBoundary(value, lastQuestion) {
  return lastQuestion === BOUNDARY_QUESTION && new Set([
    "我不太说得好", "目前我不太说得好", "不太说得好", "暂时说不好",
    "还没想好", "暂时没有额外标准", "没有额外标准",
  ]).has(shortReply(value));
}

function field(value = "", source = "unknown") {
  return { value: cleanText(value), source: SOURCES.has(source) ? source : "unknown" };
}

export function emptyDraft() {
  return {
    name: field(),
    agentType: field(),
    goal: field(),
    scenario: field(),
    inputSource: field(),
    task: field(),
    deliverable: field(),
    successCriteria: field(),
    routingCondition: field(),
    constraints: [],
    usage: { mode: "on_demand", detail: "按需调用", source: "default" },
    externalAction: {
      mode: "none", operation: "", target: "", scope: "", trigger: "", source: "default",
    },
    capabilityDependencies: [],
    unresolved: [],
    conflict: null,
  };
}

function normalizeField(value) {
  return field(value?.value, value?.source);
}

function normalizeStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => cleanText(item, 500)).filter(Boolean);
}

export function normalizeDraft(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const usage = raw.usage && typeof raw.usage === "object" ? raw.usage : {};
  const action = raw.externalAction && typeof raw.externalAction === "object"
    ? raw.externalAction : {};
  const usageMode = USAGE_MODES.has(usage.mode) ? usage.mode : "on_demand";
  const conflict = raw.conflict && typeof raw.conflict === "object"
    ? { left: cleanText(raw.conflict.left, 500), right: cleanText(raw.conflict.right, 500) }
    : null;
  return {
    name: normalizeField(raw.name),
    agentType: normalizeField(raw.agentType),
    goal: normalizeField(raw.goal),
    scenario: normalizeField(raw.scenario),
    inputSource: normalizeField(raw.inputSource),
    task: normalizeField(raw.task),
    deliverable: normalizeField(raw.deliverable),
    successCriteria: normalizeField(raw.successCriteria),
    routingCondition: normalizeField(raw.routingCondition),
    constraints: Array.isArray(raw.constraints)
      ? raw.constraints.slice(0, 20).map((item) => ({
          text: cleanText(item?.text, 500),
          source: SOURCES.has(item?.source) ? item.source : "unknown",
        })).filter((item) => item.text)
      : [],
    usage: {
      mode: usageMode,
      detail: cleanText(usage.detail, 500) || (usageMode === "on_demand" ? "按需调用" : ""),
      source: SOURCES.has(usage.source) ? usage.source : "default",
    },
    externalAction: {
      mode: ACTION_MODES.has(action.mode) ? action.mode : "none",
      operation: cleanText(action.operation, 500),
      target: cleanText(action.target, 500),
      scope: cleanText(action.scope, 500),
      trigger: cleanText(action.trigger, 500),
      source: SOURCES.has(action.source) ? action.source : "default",
    },
    capabilityDependencies: normalizeStrings(raw.capabilityDependencies),
    unresolved: normalizeStrings(raw.unresolved),
    conflict: conflict?.left && conflict?.right ? conflict : null,
  };
}

function requireModelDraft(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("需求模型未返回有效的需求草稿",
      { stage: "llm", reason: "invalid_draft" });
  }
  for (const key of Object.keys(emptyDraft())) {
    if (!(key in value)) throw new ProviderError(`需求模型缺少字段：${key}`,
      { stage: "llm", reason: "invalid_draft", field: key });
  }
  for (const key of ["name", "agentType", "goal", "scenario", "inputSource", "task",
    "deliverable", "successCriteria", "routingCondition"]) {
    if (!value[key] || typeof value[key].value !== "string" || !SOURCES.has(value[key].source)) {
      throw new ProviderError(`需求模型字段格式错误：${key}`,
        { stage: "llm", reason: "invalid_draft", field: key });
    }
  }
  if (!Array.isArray(value.constraints) || !Array.isArray(value.capabilityDependencies)
      || !Array.isArray(value.unresolved) || !USAGE_MODES.has(value.usage?.mode)
      || !ACTION_MODES.has(value.externalAction?.mode)) {
    throw new ProviderError("需求模型返回的草稿格式不完整",
      { stage: "llm", reason: "invalid_draft" });
  }
  return normalizeDraft(value);
}

function hasGroundedFact(item) {
  return Boolean(item.value) && ["user", "inferred"].includes(item.source);
}

function addGap(gaps, gap) {
  if (!gaps.includes(gap)) gaps.push(gap);
}

function validJevAnswers(result) {
  const answers = result?.answers;
  if (!answers || typeof answers !== "object") return false;
  for (const key of [
    "goal_clear", "scenario_clear", "source_clear", "task_clear", "deliverable_clear",
    "boundary_clear", "has_blocking_conflict",
    "has_external_action", "external_boundary_clear",
  ]) {
    const answer = answers[key];
    if (answer?.type !== "noul" || typeof answer.noul !== "number"
        || answer.noul < 0 || answer.noul > 1) return false;
  }
  const next = answers.next_gap;
  return next?.type === "choice" && GAP_SET.has(next.choice)
    && typeof next.confidence === "number" && next.confidence >= 0
    && next.confidence <= 1;
}

export function decideNext(draft, modelSuggestion = {}, jevResult = null,
  { skipOptionalBoundary = false } = {}) {
  const gaps = [];
  if (!hasGroundedFact(draft.goal)) addGap(gaps, "goal");
  if (!hasGroundedFact(draft.scenario)) addGap(gaps, "scenario");
  for (const [key, gap] of [["inputSource", "source"], ["task", "task"],
    ["deliverable", "deliverable"]]) {
    if (!draft[key].value || draft[key].source !== "user") addGap(gaps, gap);
  }
  if ((draft.successCriteria.value && draft.successCriteria.source === "inferred")
      || draft.constraints.some((item) => item.source === "inferred")) {
    addGap(gaps, "boundary");
  }
  for (const unresolved of draft.unresolved) {
    addGap(gaps, GAP_SET.has(unresolved) && unresolved !== "none" ? unresolved : "boundary");
  }
  const proposedGap = modelSuggestion.proposedGap;
  if (GAP_SET.has(proposedGap) && proposedGap !== "none"
      && !(skipOptionalBoundary && proposedGap === "boundary")) {
    addGap(gaps, proposedGap);
  }
  if (draft.conflict) addGap(gaps, "conflict");

  const action = draft.externalAction;
  if (action.mode === "possible" || (action.mode === "requested"
      && (action.source !== "user" || !action.operation || !action.target
        || !action.scope || !action.trigger))) {
    addGap(gaps, "external_boundary");
  }
  if (draft.usage.mode === "unclear" || (["scheduled", "event"].includes(draft.usage.mode)
      && (!draft.usage.detail || draft.usage.source !== "user"))) {
    addGap(gaps, "trigger");
  }
  const ruleGaps = GAP_ORDER.filter((gap) => gaps.includes(gap));

  if (jevResult && validJevAnswers(jevResult)) {
    const a = jevResult.answers;
    if (a.goal_clear.noul <= 0.2) addGap(gaps, "goal");
    if (a.scenario_clear.noul <= 0.2) addGap(gaps, "scenario");
    if (a.source_clear.noul <= 0.2) addGap(gaps, "source");
    if (a.task_clear.noul <= 0.2) addGap(gaps, "task");
    if (a.deliverable_clear.noul <= 0.2) addGap(gaps, "deliverable");
    if (!skipOptionalBoundary && a.boundary_clear.noul <= 0.2) addGap(gaps, "boundary");
    if (a.has_blocking_conflict.noul >= 0.8) addGap(gaps, "conflict");
    if (a.has_external_action.noul >= 0.8 && action.mode === "none") {
      addGap(gaps, "external_boundary");
    }
    if ((action.mode !== "none" || a.has_external_action.noul >= 0.8)
        && a.external_boundary_clear.noul <= 0.2) {
      addGap(gaps, "external_boundary");
    }
    if (a.next_gap.confidence >= 0.8 && a.next_gap.choice !== "none"
        && !(skipOptionalBoundary && a.next_gap.choice === "boundary")) {
      addGap(gaps, a.next_gap.choice);
    }
  }

  const ordered = GAP_ORDER.filter((gap) => gaps.includes(gap));
  const jevAddedGaps = ordered.filter((gap) => !ruleGaps.includes(gap));
  const next = jevResult?.answers?.next_gap;
  const selectedBy = next?.confidence >= 0.8 && ordered.includes(next.choice)
    ? "jev" : ordered.includes(modelSuggestion.proposedGap) ? "model" : "gap_order";
  const selectedGap = selectedBy === "jev" ? next.choice
    : selectedBy === "model" ? modelSuggestion.proposedGap : ordered[0] ?? "none";
  const suggestedQuestion = cleanText(modelSuggestion.question, 500);
  const questionSource = selectedGap === "none" ? "none"
    : modelSuggestion.proposedGap === selectedGap && suggestedQuestion ? "model" : "fallback";
  const question = selectedGap === "none" ? null
    : questionSource === "model"
      ? suggestedQuestion : questionForGap(selectedGap, draft);
  return { status: selectedGap === "none" ? "ready" : "needs_input", question, selectedGap,
    gaps: ordered, ruleGaps, jevAddedGaps, selectedBy, questionSource };
}

function questionForGap(gap, draft) {
  switch (gap) {
    case "goal": return "你最希望这个 Agent 先帮你完成哪一件具体的事？";
    case "scenario": return "你通常在什么情况下会用到它？能说说最近一次类似任务吗？";
    case "source": return "它要依据什么资料工作？资料由你提供，还是从指定地方读取？";
    case "task": return "做这件事时，你最容易卡在哪一步？可以只说一个困难；还没想好也可以，我会给你几个选择。";
    case "deliverable": return draft.deliverable.value
      ? `我暂时建议交付“${cleanText(draft.deliverable.value, 180)}”。你希望按这个建议，还是换一种内容或形式？可以只说“按建议”或一个要调整的点。`
      : "完成后，你更希望拿到简短要点、详细解释，还是一份可直接使用的成品？可以只选一种。";
    case "boundary": return BOUNDARY_QUESTION;
    case "conflict": return draft.conflict
      ? `“${draft.conflict.left}”和“${draft.conflict.right}”如何取舍？请告诉我哪一项优先。`
      : "这些要求可能互相冲突。请说明哪些要求优先，或改写冲突的部分。";
    case "external_boundary": return "它只需生成草稿，还是要实际发送、修改或删除？如果要执行，目标、范围和触发时机是什么？";
    case "trigger": return "你希望它在什么时间或事件发生时运行？";
    default: return "请补充这项需求的关键细节。";
  }
}

function summaryFor(draft, status) {
  if (status !== "ready") {
    const known = [draft.goal.value, draft.task.source === "user" && draft.task.value
      && `主要工作：${draft.task.value}`].filter(Boolean);
    return known.length ? `我目前理解：${known.join("；")}` : "我先确认你最想解决的事。";
  }
  const boundary = [draft.successCriteria.value && `完成标准：${draft.successCriteria.value}`,
    ...draft.constraints.map((item) => item.text),
    draft.externalAction.mode === "none" ? "不执行对外动作"
      : draft.externalAction.mode === "requested"
        ? `对外动作：${[draft.externalAction.operation, draft.externalAction.target,
          draft.externalAction.scope, draft.externalAction.trigger].filter(Boolean).join("、")}`
        : "对外动作范围待明确"].filter(Boolean).join("；");
  return [
    `Agent 要解决的问题：${draft.goal.value || "待明确"}`,
    `核心使用场景：${draft.scenario.value || "待明确"}`,
    `输入：${draft.inputSource.value || "待明确"}`,
    `核心任务与处理方式：${draft.task.value || "待明确"}`,
    `输出：${draft.deliverable.value || "待明确"}`,
    `关键规则与边界：${boundary || "暂无额外要求"}`,
    `建议的调用场景：${draft.routingCondition.value || "待根据需求确定"}`,
  ].join("\n");
}

function confirmationOnly(draft, confirmed, question, reason) {
  const status = confirmed ? "ready" : "needs_input";
  return {
    draft, status, question, summary: summaryFor(draft, status), confirmed,
    confirmationQuestion: null,
    jev: { used: false, reason: "not_needed", selectedGap: null,
      model: null, appliedGap: confirmed ? "none" : "confirmation" },
    diagnostic: {
      model: { used: false, reason, proposedGap: null, question: null,
        confirmed, durationMs: 0 },
      jev: { used: false, durationMs: null, answers: null, failure: null },
      decision: { gaps: [], ruleGaps: [], jevAddedGaps: [],
        selectedGap: confirmed ? "none" : "confirmation",
        selectedBy: "confirmation", questionSource: confirmed ? "none" : "confirmation" },
    },
  };
}

export async function processTurn(request, { generateDraft, judgeJev }) {
  const message = cleanText(request?.message, 4000);
  if (!message) throw new InputError("请输入你希望 Agent 做什么，或说明要修改的内容");
  if (typeof request?.message !== "string" || request.message.length > 4000) {
    throw new InputError("本轮输入不能超过 4000 字");
  }
  const previousDraft = normalizeDraft(request.draft);
  const lastQuestion = cleanText(request.lastQuestion, 500);
  const userMessages = userMessagesForTurn(request.userMessages);
  const awaitingConfirmation = isConfirmationPrompt(lastQuestion);
  if (awaitingConfirmation && isRejection(message)) {
    if (lastQuestion === LEGACY_CONFIRMATION_QUESTION && shortReply(message) === "没有") {
      return confirmationOnly(previousDraft, false, CONFIRMATION_CLARIFICATION_QUESTION,
        "confirmation_unclear_or_rejected");
    }
    addGap(previousDraft.unresolved, "goal");
    const result = confirmationOnly(previousDraft, false, REVISION_QUESTION, "requirements_rejected");
    result.summary = "我先暂停这份方案，帮你定位偏差。";
    result.diagnostic.decision.selectedGap = "goal";
    result.diagnostic.decision.gaps = ["goal"];
    result.jev.appliedGap = "goal";
    return result;
  }
  if (awaitingConfirmation && decideNext(previousDraft).status === "ready") {
    if (isApproval(message)) {
      return confirmationOnly(previousDraft, true, null, "explicit_approval");
    }
  }
  const modelStartedAt = Date.now();
  const modelResult = await generateDraft({ message, previousDraft, lastQuestion, userMessages });
  const modelMs = Date.now() - modelStartedAt;
  const draft = requireModelDraft(modelResult?.draft);
  if (!draft.routingCondition.value && hasGroundedFact(draft.scenario)
      && hasGroundedFact(draft.task)) {
    draft.routingCondition = field(`当用户在${draft.scenario.value}需要${draft.task.value}时`, "inferred");
  }

  let jevResult = null;
  let jevFailure = null;
  let jevMs = null;
  let jev = { used: false, reason: "not_configured", selectedGap: null, model: null };
  if (judgeJev) {
    const jevStartedAt = Date.now();
    try {
      const result = await judgeJev({ message, draft, lastQuestion, userMessages });
      if (!validJevAnswers(result)) {
        throw new ProviderError("Jev 返回的判断格式无效",
          { stage: "jev", reason: "invalid_response" });
      }
      jevResult = result;
      jev = { used: true, reason: null, selectedGap: result.answers.next_gap.choice,
        model: cleanText(result.model, 80) || null };
    } catch (error) {
      jev = { used: false, reason: "unavailable", selectedGap: null, model: null };
      jevFailure = error instanceof ProviderError ? error.diagnostic
        : { stage: "jev", reason: "unknown" };
    }
    jevMs = Date.now() - jevStartedAt;
  }
  const skipOptionalBoundary = declinesExtraBoundary(message, lastQuestion);
  const decision = decideNext(draft, modelResult, jevResult, { skipOptionalBoundary });
  const draftChanged = JSON.stringify(draft) !== JSON.stringify(previousDraft);
  const confirmed = decision.status === "ready" && awaitingConfirmation && !draftChanged
    && modelResult?.confirmed === true;
  const needsConfirmationClarification = decision.status === "ready" && awaitingConfirmation
    && !confirmed && !draftChanged;
  const status = needsConfirmationClarification ? "needs_input" : decision.status;
  const question = needsConfirmationClarification ? CONFIRMATION_OPTIONS_QUESTION : decision.question;
  return {
    draft,
    status,
    question,
    summary: summaryFor(draft, status),
    confirmed,
    confirmationQuestion: status === "ready" && !confirmed ? CONFIRMATION_QUESTION : null,
    jev: { ...jev, appliedGap: decision.selectedGap },
    diagnostic: {
      model: { proposedGap: cleanText(modelResult?.proposedGap, 80) || null,
        question: cleanText(modelResult?.question, 500) || null,
        confirmed: modelResult?.confirmed === true, durationMs: modelMs },
      jev: { used: jev.used, durationMs: jevMs,
        answers: jevResult?.answers ?? null, failure: jevFailure },
      decision: { gaps: decision.gaps, ruleGaps: decision.ruleGaps,
        jevAddedGaps: decision.jevAddedGaps, selectedGap: decision.selectedGap,
        selectedBy: decision.selectedBy, questionSource: decision.questionSource,
        skipOptionalBoundary, needsConfirmationClarification },
    },
  };
}
