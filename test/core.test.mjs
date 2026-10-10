import test from "node:test";
import assert from "node:assert/strict";
import { CONFIRMATION_QUESTION, decideNext, emptyDraft, processTurn, ProviderError } from "../src/requirements/core.mjs";

function completeDraft() {
  const draft = emptyDraft();
  draft.name = { value: "会议纪要助手", source: "user" };
  draft.goal = { value: "让会后决定和责任人清楚可追踪", source: "user" };
  draft.scenario = { value: "会议结束后整理记录", source: "inferred" };
  draft.inputSource = { value: "用户提供的会议转写", source: "user" };
  draft.task = { value: "提取结论和待办事项", source: "user" };
  draft.deliverable = { value: "结论和待办列表", source: "user" };
  draft.routingCondition = { value: "用户要求整理会议转写时", source: "inferred" };
  return draft;
}

function jevAnswers(overrides = {}) {
  const noul = (value) => ({ type: "noul", noul: value });
  return {
    model: "jev-1.13.0",
    answers: {
      goal_clear: noul(0.95),
      scenario_clear: noul(0.95),
      source_clear: noul(0.95),
      task_clear: noul(0.95),
      deliverable_clear: noul(0.95),
      boundary_clear: noul(0.95),
      has_blocking_conflict: noul(0.05),
      has_external_action: noul(0.05),
      external_boundary_clear: noul(0.95),
      next_gap: { type: "choice", choice: "none", confidence: 0.95 },
      ...overrides,
    },
  };
}

test("完整会议需求直接可交接，不安排例行追问", async () => {
  const result = await processTurn({ message: "我提供会议转写，请提取结论和待办，输出结论和待办列表，方便会后追踪责任人", draft: null }, {
    generateDraft: async () => ({ draft: completeDraft(), proposedGap: "none", question: "" }),
    judgeJev: async () => jevAnswers(),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.question, null);
  assert.equal(result.confirmationQuestion, CONFIRMATION_QUESTION);
  assert.equal(result.jev.used, true);
  assert.match(result.summary, /会议转写/);
  assert.match(result.summary, /建议的调用场景/);
  assert.deepEqual(result.diagnostic.decision.gaps, []);
  assert.equal(result.diagnostic.decision.questionSource, "none");
  assert.equal(result.diagnostic.model.proposedGap, "none");
  assert.equal(result.diagnostic.jev.answers.next_gap.choice, "none");
});

test("场景和核心工作不清楚时不能提前确认", () => {
  const draft = completeDraft();
  draft.scenario = { value: "", source: "unknown" };
  draft.task = { value: "", source: "unknown" };
  const decision = decideNext(draft, { proposedGap: "task", question: "你现在通常怎么处理会议转写？" });
  assert.equal(decision.status, "needs_input");
  assert.equal(decision.selectedGap, "task");
  assert.equal(decision.question, "你现在通常怎么处理会议转写？");
});

test("低风险场景可直接推导，系统暂定不能填补关键缺口", () => {
  const draft = completeDraft();
  assert.equal(decideNext(draft).status, "ready");
  draft.scenario.source = "default";
  assert.equal(decideNext(draft).selectedGap, "scenario");
});

test("建议调用场景可从已明确的场景和任务生成", async () => {
  const draft = completeDraft();
  draft.routingCondition = { value: "", source: "unknown" };
  const result = await processTurn({ message: "创建会议纪要助手" }, {
    generateDraft: async () => ({ draft, proposedGap: "none", question: "" }),
  });
  assert.equal(result.draft.routingCondition.source, "inferred");
  assert.match(result.draft.routingCondition.value, /会议结束后/);
});

test("Jev 高确定性认为关键规则不清楚时必须追问", () => {
  const jev = jevAnswers({ boundary_clear: { type: "noul", noul: 0.1 },
    next_gap: { type: "choice", choice: "boundary", confidence: 0.9 } });
  assert.equal(decideNext(completeDraft(), {}, jev).selectedGap, "boundary");
});

test("只说周报助手时追问资料来源，而且只问一个问题", () => {
  const draft = completeDraft();
  draft.inputSource = { value: "", source: "unknown" };
  const decision = decideNext(draft, { proposedGap: "source", question: "工作记录由你发给它吗？" });
  assert.equal(decision.status, "needs_input");
  assert.equal(decision.question, "工作记录由你发给它吗？");
  assert.deepEqual(decision.gaps, ["source"]);
});

test("要求直接发送但目标不明确时不能交接", () => {
  const draft = completeDraft();
  draft.externalAction = {
    mode: "requested", operation: "发送", target: "", scope: "客户回复",
    trigger: "用户要求时", source: "user",
  };
  const decision = decideNext(draft);
  assert.equal(decision.status, "needs_input");
  assert.equal(decision.selectedGap, "external_boundary");
  assert.match(decision.question, /目标/);
});

test("对外动作不能仅凭系统暂定的信息标为可交接", () => {
  const draft = completeDraft();
  draft.externalAction = {
    mode: "requested", operation: "发送", target: "客户", scope: "回复邮件",
    trigger: "用户确认后", source: "default",
  };
  assert.equal(decideNext(draft).selectedGap, "external_boundary");
});

test("冲突要求必须澄清，不能用轮数强制完成", () => {
  const draft = completeDraft();
  draft.conflict = { left: "写详细报告", right: "只能写一句话" };
  const decision = decideNext(draft);
  assert.equal(decision.status, "needs_input");
  assert.match(decision.question, /写详细报告/);
});

test("定时执行未给具体时间时追问触发条件", () => {
  const draft = completeDraft();
  draft.usage = { mode: "scheduled", detail: "", source: "user" };
  const decision = decideNext(draft);
  assert.equal(decision.selectedGap, "trigger");
});

test("Jev 高确定性结果可在多个缺口中选择下一问", () => {
  const draft = completeDraft();
  draft.inputSource = { value: "", source: "unknown" };
  draft.deliverable = { value: "", source: "unknown" };
  const jev = jevAnswers({
    source_clear: { type: "noul", noul: 0.1 },
    deliverable_clear: { type: "noul", noul: 0.1 },
    next_gap: { type: "choice", choice: "deliverable", confidence: 0.91 },
  });
  assert.equal(decideNext(draft, {}, jev).selectedGap, "deliverable");
  jev.answers.next_gap.confidence = 0.3;
  assert.equal(decideNext(draft, {}, jev).selectedGap, "source");
});

test("Jev 认为已填字段仍不清楚时会阻止提前交接", () => {
  const jev = jevAnswers({ source_clear: { type: "noul", noul: 0.1 } });
  const decision = decideNext(completeDraft(), {}, jev);
  assert.equal(decision.selectedGap, "source");
  assert.deepEqual(decision.ruleGaps, []);
  assert.deepEqual(decision.jevAddedGaps, ["source"]);
  assert.equal(decision.questionSource, "fallback");
});

test("Jev 故障时按草稿缺口继续", async () => {
  const draft = completeDraft();
  draft.inputSource = { value: "", source: "unknown" };
  const result = await processTurn({ message: "做周报助手" }, {
    generateDraft: async () => ({ draft, proposedGap: "source", question: "资料从哪里来？" }),
    judgeJev: async () => { throw new Error("timeout"); },
  });
  assert.equal(result.status, "needs_input");
  assert.equal(result.question, "资料从哪里来？");
  assert.equal(result.jev.used, false);
  assert.equal(result.jev.reason, "unavailable");
  assert.equal(result.diagnostic.jev.failure.reason, "unknown");
});

test("用户纠正长期要求时返回更新后的同一份草稿", async () => {
  const previous = completeDraft();
  previous.constraints = [{ text: "直接发送", source: "user" }];
  const updated = completeDraft();
  updated.constraints = [{ text: "只生成草稿，不发送", source: "user" }];
  let received;
  const result = await processTurn({ message: "不对，以后只生成草稿", draft: previous }, {
    generateDraft: async ({ previousDraft }) => {
      received = previousDraft;
      return { draft: updated, proposedGap: "none", question: "" };
    },
  });
  assert.equal(received.constraints[0].text, "直接发送");
  assert.deepEqual(result.draft.constraints, [{ text: "只生成草稿，不发送", source: "user" }]);
});

test("用户明确确认后停止追问，但不进入创建阶段", async () => {
  let providerCalls = 0;
  const result = await processTurn({ message: "是的，就是这样", draft: completeDraft(),
    lastQuestion: CONFIRMATION_QUESTION }, {
    generateDraft: async () => {
      providerCalls += 1;
      return { draft: completeDraft(), proposedGap: "none", question: "", confirmed: true };
    },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.confirmed, true);
  assert.equal(result.confirmationQuestion, null);
  assert.equal(providerCalls, 0);
});

test("简短明确同意直接确认，不让 Jev 重新打开已完成的缺口", async () => {
  let calls = 0;
  const result = await processTurn({ message: "先这样吧", draft: completeDraft(),
    lastQuestion: CONFIRMATION_QUESTION }, {
    generateDraft: async () => { calls += 1; throw new Error("should not call model"); },
    judgeJev: async () => { calls += 1; throw new Error("should not call Jev"); },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.confirmed, true);
  assert.equal(result.jev.reason, "not_needed");
  assert.equal(calls, 0);
});

test("旧版双重问句后的‘没有’只澄清含义，不重复需求说明", async () => {
  const legacyQuestion = "这是你想要的吗？如果没有需要修改的地方，我们就可以进入下一步创建。";
  const providers = { generateDraft: async () => { throw new Error("should not call model"); } };
  const first = await processTurn({ message: "没有", draft: completeDraft(),
    lastQuestion: legacyQuestion }, providers);
  assert.equal(first.status, "needs_input");
  assert.equal(first.confirmed, false);
  assert.equal(first.confirmationQuestion, null);
  assert.match(first.question, /你说的“没有”/);
  assert.notEqual(first.question, legacyQuestion);

  const second = await processTurn({ message: "确认", draft: first.draft,
    lastQuestion: first.question }, providers);
  assert.equal(second.confirmed, true);
});

test("新版确认问题后的否定回答提供纠正方向，不要求用户重写需求", async () => {
  const result = await processTurn({ message: "没有", draft: completeDraft(),
    lastQuestion: CONFIRMATION_QUESTION }, {
    generateDraft: async () => { throw new Error("should not call model"); },
  });
  assert.equal(result.status, "needs_input");
  assert.match(result.question, /目标理解错了/);
  assert.match(result.question, /只需选一个/);
  assert.deepEqual(result.draft.unresolved, ["goal"]);
});

test("快速读懂论文的愿望加系统推测不能直接进入确认，Jev 同意也不能放行", async () => {
  const draft = completeDraft();
  draft.goal = { value: "从零快速读懂一篇论文", source: "user" };
  draft.inputSource = { value: "PDF、Word、截图或粘贴文字", source: "inferred" };
  draft.task = { value: "拆解背景、方法、论证、创新和局限", source: "inferred" };
  draft.deliverable = { value: "八个章节的论文解读报告", source: "inferred" };
  draft.successCriteria = { value: "无需再读原文", source: "inferred" };
  const result = await processTurn({ message: "帮我从0到1分析一篇论文，让我能快速读懂", draft: null }, {
    generateDraft: async () => ({ draft, proposedGap: "task",
      question: "读论文时最困扰你的是术语、方法、论证过程，还是抓重点？" }),
    judgeJev: async () => jevAnswers(),
  });
  assert.equal(result.status, "needs_input");
  assert.equal(result.confirmationQuestion, null);
  assert.match(result.question, /最困扰/);
  assert.doesNotMatch(result.summary, /拆解背景/);
  assert.deepEqual(result.diagnostic.decision.gaps, ["source", "task", "deliverable", "boundary"]);
});

test("已填满的字段仍保留有效追问，未解决事项不能被忽略", () => {
  const draft = completeDraft();
  const proposed = decideNext(draft, { proposedGap: "task", question: "处理重点是结论还是讨论过程？" });
  assert.equal(proposed.status, "needs_input");
  assert.match(proposed.question, /处理重点/);
  draft.unresolved = ["goal"];
  assert.equal(decideNext(draft).selectedGap, "goal");
  draft.unresolved = ["遇到材料缺失时是否继续写结论尚未确定"];
  assert.equal(decideNext(draft).status, "needs_input");
});

test("用户接受已展示的具体处理和输出建议后可以进入最终确认", async () => {
  const previous = completeDraft();
  previous.task.source = "inferred";
  previous.deliverable.source = "inferred";
  previous.unresolved = ["task", "deliverable"];
  const result = await processTurn({ message: "按这个建议就行", draft: previous,
    lastQuestion: "我建议提取结论和待办事项，输出结论和待办列表，这符合你的需要吗？" }, {
    generateDraft: async () => ({ draft: completeDraft(), proposedGap: "none", question: "" }),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.confirmed, false);
  assert.equal(result.confirmationQuestion, CONFIRMATION_QUESTION);
});

test("旧草稿中仍有系统推测时，简短确认不能跳过关键澄清", async () => {
  const draft = completeDraft();
  draft.deliverable.source = "inferred";
  const result = await processTurn({ message: "确认", draft,
    lastQuestion: CONFIRMATION_QUESTION }, {
    generateDraft: async () => ({ draft, proposedGap: "deliverable", question: "先要简短要点还是详细解释？" }),
  });
  assert.equal(result.status, "needs_input");
  assert.equal(result.confirmed, false);
  assert.match(result.question, /简短要点/);
});

test("都不对也可用短选项纠正，后续编号不会直接确认旧方案", async () => {
  const rejected = await processTurn({ message: "都不对", draft: completeDraft(),
    lastQuestion: CONFIRMATION_QUESTION }, {
    generateDraft: async () => { throw new Error("no model needed to offer correction directions"); },
  });
  assert.match(rejected.question, /3）结果的形式或深度/);
  assert.doesNotMatch(rejected.summary, /会议|主要工作/);
  assert.equal(rejected.confirmed, false);
  const next = await processTurn({ message: "3", draft: rejected.draft,
    lastQuestion: rejected.question }, {
    generateDraft: async ({ lastQuestion }) => {
      assert.equal(lastQuestion, rejected.question);
      const draft = completeDraft();
      draft.unresolved = ["deliverable"];
      return { draft, proposedGap: "deliverable", question: "你更想要一页要点还是详细解释？" };
    },
  });
  assert.equal(next.status, "needs_input");
  assert.match(next.question, /一页要点/);
  assert.equal(next.confirmationQuestion, null);
});

test("模型和 Jev 收到当前用户原话，下一份请求不会继承前一份对话", async () => {
  const seen = [];
  const providers = {
    generateDraft: async ({ message, userMessages, lastQuestion }) => {
      seen.push({ message, userMessages, lastQuestion });
      return { draft: completeDraft(), proposedGap: "none", question: "" };
    },
    judgeJev: async ({ message, userMessages, lastQuestion }) => {
      seen.push({ message, userMessages, lastQuestion });
      return jevAnswers();
    },
  };
  const current = { message: "简短要点", userMessages: ["我提供会议转写", "提取结论和待办"], lastQuestion: "先要简短要点还是详细解释？" };
  await processTurn(current, providers);
  await processTurn({ message: "全新任务" }, providers);
  assert.deepEqual(seen, [current, current,
    { message: "全新任务", userMessages: [], lastQuestion: "" },
    { message: "全新任务", userMessages: [], lastQuestion: "" }]);
});

test("用户暂时说不出额外标准时不重复追问同一个边界问题", async () => {
  const jev = jevAnswers({ boundary_clear: { type: "noul", noul: 0.1 },
    next_gap: { type: "choice", choice: "boundary", confidence: 0.9 } });
  const result = await processTurn({ message: "我不太说得好", draft: completeDraft(),
    lastQuestion: "这件事做到什么程度才算合格？有没有必须遵守或绝对不能做的事？" }, {
    generateDraft: async () => ({ draft: completeDraft(), proposedGap: "boundary",
      question: "还有什么额外标准？" }),
    judgeJev: async () => jev,
  });
  assert.equal(result.status, "ready");
  assert.equal(result.question, null);
  assert.equal(result.confirmationQuestion, CONFIRMATION_QUESTION);
  assert.equal(result.diagnostic.decision.skipOptionalBoundary, true);
});

test("确认阶段含糊回复不会原样重复整份需求", async () => {
  const result = await processTurn({ message: "嗯", draft: completeDraft(),
    lastQuestion: CONFIRMATION_QUESTION }, {
    generateDraft: async () => ({ draft: completeDraft(), proposedGap: "none",
      question: "", confirmed: false }),
  });
  assert.equal(result.status, "needs_input");
  assert.equal(result.confirmationQuestion, null);
  assert.match(result.question, /请回复“确认”/);
});

test("确认问题后提出修改时更新草稿并重新确认", async () => {
  const updated = completeDraft();
  updated.task = { value: "提取结论、待办和风险", source: "user" };
  const result = await processTurn({ message: "再加上风险", draft: completeDraft(),
    lastQuestion: CONFIRMATION_QUESTION }, {
    generateDraft: async () => ({ draft: updated, proposedGap: "none",
      question: "", confirmed: true }),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.confirmed, false);
  assert.equal(result.draft.task.value, "提取结论、待办和风险");
  assert.equal(result.confirmationQuestion, CONFIRMATION_QUESTION);
});

test("首次描述即使模型误报确认也必须等待用户确认", async () => {
  const result = await processTurn({ message: "创建会议纪要助手", draft: null }, {
    generateDraft: async () => ({ draft: completeDraft(), proposedGap: "none", question: "",
      confirmed: true }),
  });
  assert.equal(result.confirmed, false);
  assert.equal(result.confirmationQuestion, CONFIRMATION_QUESTION);
});

test("模型缺少关键字段时拒绝把残缺草稿标为完成", async () => {
  await assert.rejects(
    processTurn({ message: "创建助手" }, { generateDraft: async () => ({ draft: { goal: "任务" } }) }),
    ProviderError,
  );
});
