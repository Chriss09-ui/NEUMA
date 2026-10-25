import type { Providers } from "../../src/requirements/requirement-provider-port.mjs";
import type { TestFailure } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { CONFIRMATION_QUESTION, decideNext, emptyDraft, normalizeDraft, processTurn, ProviderError } from "../../src/requirements/core.mjs";
import { REQUIREMENT_DRAFT_MAX_BYTES, REQUIREMENT_MESSAGE_MAX_CHARACTERS, REQUIREMENT_NAME_MAX_CHARACTERS } from "../../src/requirements/requirement-limits.mjs";
import { emptyTaskSpec } from "../../src/requirements/task-spec.mjs";
import { withPreflight } from "../helpers/consultation.mjs";

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

function jevAnswers({ score = 2, confidence = 1, probabilities = { "0": 0, "1": 0, "2": 1 } } = {}) {
  return {
    model: "jev-1.14.0",
    answers: {
      point_sufficiency: {
        type: "score", score, confidence, probabilities,
        legend: {
          "0": "The user's words miss the matched requirement, or a part that requirement names is absent.",
          "1": "The user's words touch the matched requirement, but something still vague or missing would change what the agent does.",
          "2": "The user's own words settle the matched requirement, including every part that requirement names.",
        },
      },
    },
  };
}

test("需求接收完整12000个Unicode字符，规范化不截断合法非BMP字段", async () => {
  const message = "😀".repeat(REQUIREMENT_MESSAGE_MAX_CHARACTERS), draft = completeDraft();
  draft.goal.value = "𠮷".repeat(1200);
  let seen;
  const result = await processTurn({ message, userMessages: [message] }, {
    generateDraft: async (input) => { seen = input; return { draft, proposedGap: "none" }; },
  });
  assert.equal(seen!.message!, message); assert.deepEqual(seen!.userMessages!, [message]);
  assert.equal(result.draft.goal.value, draft.goal.value);
  await assert.rejects(processTurn({ message: `${message}字` }, {
    generateDraft: async () => assert.fail("超限输入不能进入模型"),
  }), /12000/);
});

test("名称源字段与保存上限同为120个Unicode字符，超限明确拒绝而不截短", async () => {
  const draft = completeDraft(); draft.name.value = "😀".repeat(REQUIREMENT_NAME_MAX_CHARACTERS);
  assert.deepEqual(normalizeDraft(draft), draft);
  const invalid = structuredClone(draft); invalid.name.value += "字";
  assert.throws(() => normalizeDraft(invalid), (error: TestFailure) => error.reason === "requirement_name_too_long"
    && error.field === "name.value" && error.limitCharacters === REQUIREMENT_NAME_MAX_CHARACTERS);
  await assert.rejects(processTurn({ message: "创建这个助手" }, { generateDraft: async () => ({ draft: invalid }) }),
    (error: TestFailure) => error instanceof ProviderError && error.diagnostic.reason === "requirement_name_too_long"
      && error.diagnostic.field === "name.value" && error.diagnostic.limitCharacters === REQUIREMENT_NAME_MAX_CHARACTERS);
  assert.equal(invalid.name.value, `${draft.name.value}字`);
});

test("合法单项组成的超量需求在生成接收时整体拒绝，不裁剪依据", async () => {
  const draft = completeDraft();
  draft.taskSpec = { version: 1, items: Array.from({ length: 120 }, (_, index) => ({ id: `requirement_${index}`,
    dimension: "processing", applicability: "applies", content: "任务".repeat(1000), critical: false,
    source: { kind: "user", evidence: Array.from({ length: 12 }, () => ({ messageId: "user_original", quote: "原文".repeat(2000) })) } })) };
  const before = structuredClone(draft);
  assert.throws(() => normalizeDraft(draft), (error: TestFailure) => error.reason === "requirement_draft_too_large"
    && error.bytes! > REQUIREMENT_DRAFT_MAX_BYTES && error.limitBytes === REQUIREMENT_DRAFT_MAX_BYTES);
  await assert.rejects(processTurn({ message: "描述任务" }, { generateDraft: async () => ({ draft }) }),
    (error: TestFailure) => error instanceof ProviderError && error.diagnostic.reason === "requirement_draft_too_large"
      && error.diagnostic.limitBytes === REQUIREMENT_DRAFT_MAX_BYTES);
  assert.deepEqual(draft, before);
});

test("页面入口与助手选择进入确认摘要，旧草稿不回填助手", async () => {
  const legacy = completeDraft();
  assert.deepEqual(normalizeDraft(legacy), legacy);
  legacy.interaction = { defaultEntry: "conversation", page: false, operations: [], inputs: "", results: "", persistentData: "" };
  assert.equal(Object.hasOwn(normalizeDraft(legacy).interaction!, "assistant"), false);
  for (const assistant of [{ enabled: false, purpose: "" }, { enabled: true, purpose: "解释当前图形并调整已有参数" }]) {
    const draft = { ...completeDraft(), interaction: { ...legacy.interaction, defaultEntry: "application", page: true, assistant } };
    const result = await processTurn({ message: "以后打开这个页面使用", draft: null }, {
      generateDraft: async () => ({ draft, proposedGap: "none", question: "" }),
    });
    assert.equal(result.status, "ready"); assert.equal(result.confirmed, false);
    assert.deepEqual(result.draft!.interaction!.assistant, assistant);
    assert.match(result.summary, /打开方式：以交互页面为主/);
    assert.ok(result.summary.includes(assistant.enabled ? assistant.purpose : "无需浮窗助手"));
    const confirmed = await processTurn({ message: "确认", draft: result.draft, lastQuestion: result.confirmationQuestion }, {
      generateDraft: async () => assert.fail("明确确认无需再次生成"),
    });
    assert.equal(confirmed.confirmed, true); assert.deepEqual(confirmed.draft, result.draft);
  }
});

test("缺少页面或用途的助手选择不能交接，模型不能用字符串伪造开关", async () => {
  const draft = completeDraft();
  for (const interaction of [{ defaultEntry: "application", page: false },
    { page: true, assistant: { enabled: true, purpose: "" } },
    { page: false, assistant: { enabled: true, purpose: "解释图形" } }]) {
    assert.equal(decideNext(normalizeDraft({ ...draft, interaction })).status, "needs_input");
  }
  await assert.rejects(processTurn({ message: "需要页面", draft: null }, {
    generateDraft: async () => ({ draft: { ...draft, interaction: { page: true, assistant: { enabled: "false", purpose: "" } } } }),
  }), ProviderError);
});

test("完整会议需求直接可交接，不安排例行追问", async () => {
  const result = await processTurn({ message: "我提供会议转写，请提取结论和待办，输出结论和待办列表，方便会后追踪责任人", draft: null }, {
    generateDraft: async () => ({ draft: completeDraft(), proposedGap: "none", question: "", answeredPoint: "deliverable" }),
    judgeJev: async () => jevAnswers(),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.question, null);
  assert.equal(result.confirmationQuestion, CONFIRMATION_QUESTION);
  assert.equal(result.jev.used, true);
  assert.equal(result.jev.reason, "sufficient");
  assert.match(result.summary, /会议转写/);
  assert.match(result.summary, /建议的调用场景/);
  assert.deepEqual(result.diagnostic.decision.gaps, []);
  assert.equal(result.diagnostic.decision.questionSource, "none");
  assert.equal(result.diagnostic.model.proposedGap, "none");
  assert.equal(result.diagnostic.model.answeredPoint, "deliverable");
  assert.equal(result.diagnostic!.jev.answers!.point_sufficiency.score, 2);
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

test("低于通过线时由草稿整理决定再问，而且只问匹配到的点", async () => {
  const draft = completeDraft();
  draft.inputSource = { value: "", source: "unknown" };
  draft.deliverable = { value: "", source: "unknown" };
  let seen;
  const result = await processTurn({ message: "资料我发你" }, {
    generateDraft: async () => ({ draft, proposedGap: "deliverable", question: "要什么样的结果？", answeredPoint: "source" }),
    judgeJev: async () => jevAnswers({ score: 0.2, confidence: 0.95, probabilities: { "0": 0.8, "1": 0.2, "2": 0 } }),
    decideReask: async (input) => {
      seen = input;
      return { reask: true, question: "这些资料大概有多少？" };
    },
  });
  assert.equal(seen!.answeredPoint!, "source");
  assert.equal(seen!.score!, 0.2);
  assert.equal(seen!.passLine!.score, 1.5);
  assert.equal(seen!.passLine!.confidence, 0.6);
  assert.equal(result.diagnostic.decision.selectedBy, "reask");
  assert.equal(result.diagnostic.decision.selectedGap, "source");
  assert.equal(result.question, "这些资料大概有多少？");
  assert.equal(result.jev.reason, "reask");
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
  assert.match(decision.question!, /目标/);
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
  assert.match(decision.question!, /写详细报告/);
});

test("定时执行未给具体时间时追问触发条件", () => {
  const draft = completeDraft();
  draft.usage = { mode: "scheduled", detail: "", source: "user" };
  const decision = decideNext(draft);
  assert.equal(decision.selectedGap, "trigger");
});

test("草稿整理认为低于通过线仍可接受时，不改问另一项", async () => {
  const draft = completeDraft();
  draft.inputSource = { value: "", source: "unknown" };
  draft.deliverable = { value: "", source: "unknown" };
  const result = await processTurn({ message: "资料我发你" }, {
    generateDraft: async () => ({ draft, proposedGap: "deliverable", question: "要什么样的结果？", answeredPoint: "source" }),
    judgeJev: async () => jevAnswers({ score: 1.2, confidence: 0.9, probabilities: { "0": 0, "1": 0.8, "2": 0.2 } }),
    decideReask: async () => ({ reask: false, question: "" }),
  });
  assert.equal(result.question, "要什么样的结果？");
  assert.equal(result.diagnostic.decision.selectedGap, "deliverable");
  assert.equal(result.jev.reason, "waived");
});

test("已填字段低于通过线且草稿整理决定再问时，阻止提前交接", async () => {
  const result = await processTurn({ message: "会议记录我发你" }, {
    generateDraft: async () => ({ draft: completeDraft(), proposedGap: "none", question: "", answeredPoint: "source" }),
    judgeJev: async () => jevAnswers({ score: 0.4, confidence: 0.9, probabilities: { "0": 0.7, "1": 0.2, "2": 0.1 } }),
    decideReask: async () => ({ reask: true, question: "你希望以什么形式交这些资料，通常大概有多少？" }),
  });
  assert.equal(result.status, "needs_input");
  assert.equal(result.confirmationQuestion, null);
  assert.equal(result.diagnostic.decision.selectedBy, "reask");
  assert.deepEqual(result.diagnostic.decision.ruleGaps, []);
  assert.deepEqual(result.diagnostic.decision.jevAddedGaps, ["source"]);
  assert.match(result.question!, /形式/);
  assert.match(result.question!, /多少/);
});

test("达到通过线时直接放行，不再交给草稿整理", async () => {
  let reviews = 0;
  const result = await processTurn({ message: "我每次在对话里粘贴，大概三五页" }, {
    generateDraft: async () => ({ draft: completeDraft(), proposedGap: "none", question: "", answeredPoint: "source" }),
    judgeJev: async () => jevAnswers(),
    decideReask: async () => { reviews += 1; return { reask: true, question: "不该再问" }; },
  });
  assert.equal(reviews, 0);
  assert.equal(result.status, "ready");
  assert.equal(result.question, null);
  assert.equal(result.jev.reason, "sufficient");
});

test("低于置信度线时交给草稿整理，它也可以决定不再问", async () => {
  const result = await processTurn({ message: "结论和待办列表" }, {
    generateDraft: async () => ({ draft: completeDraft(), proposedGap: "none", question: "", answeredPoint: "deliverable" }),
    judgeJev: async () => jevAnswers({ score: 1.6, confidence: 0.4, probabilities: { "0": 0, "1": 0.4, "2": 0.6 } }),
    decideReask: async (input) => {
      assert.equal(input.confidence, 0.4);
      return { reask: false, question: "" };
    },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.jev.reason, "waived");
  assert.equal(result.diagnostic!.review!.used, true);
});

test("Jev 故障时按草稿缺口继续", async () => {
  const draft = completeDraft();
  draft.inputSource = { value: "", source: "unknown" };
  const result = await processTurn({ message: "做周报助手" }, {
    generateDraft: async () => ({ draft, proposedGap: "source", question: "资料从哪里来？", answeredPoint: "source" }),
    judgeJev: async () => { throw new Error("timeout"); },
  });
  assert.equal(result.status, "needs_input");
  assert.equal(result.question, "资料从哪里来？");
  assert.equal(result.jev.used, false);
  assert.equal(result.jev.reason, "unavailable");
  assert.equal(result.diagnostic!.jev.failure!.reason, "unknown");
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
  assert.equal(received!.constraints![0].text, "直接发送");
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
  assert.match(first.question!, /你说的“没有”/);
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
  assert.match(result.question!, /目标理解错了/);
  assert.match(result.question!, /只需选一个/);
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
    generateDraft: async () => ({ draft, proposedGap: "task", answeredPoint: "goal",
      question: "读论文时最困扰你的是术语、方法、论证过程，还是抓重点？" }),
    judgeJev: async () => jevAnswers(),
  });
  assert.equal(result.status, "needs_input");
  assert.equal(result.confirmationQuestion, null);
  assert.match(result.question!, /最困扰/);
  assert.doesNotMatch(result.summary, /拆解背景/);
  assert.deepEqual(result.diagnostic.decision.gaps, ["source", "task", "deliverable", "boundary"]);
});

test("已填满的字段仍保留有效追问，未解决事项不能被忽略", () => {
  const draft = completeDraft();
  const proposed = decideNext(draft, { proposedGap: "task", question: "处理重点是结论还是讨论过程？" });
  assert.equal(proposed.status, "needs_input");
  assert.match(proposed.question!, /处理重点/);
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
  assert.match(result.question!, /简短要点/);
});

test("都不对也可用短选项纠正，后续编号不会直接确认旧方案", async () => {
  const rejected = await processTurn({ message: "都不对", draft: completeDraft(),
    lastQuestion: CONFIRMATION_QUESTION }, {
    generateDraft: async () => { throw new Error("no model needed to offer correction directions"); },
  });
  assert.match(rejected.question!, /3）结果的形式或深度/);
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
  assert.match(next.question!, /一页要点/);
  assert.equal(next.confirmationQuestion, null);
});

test("模型和 Jev 收到当前用户原话，下一份请求不会继承前一份对话", async () => {
  const seen: ({ "message": (unknown); "userMessages": (unknown); "lastQuestion": (unknown); "answeredPoint"?: (unknown); })[] = [];
  const providers: Providers = {
    generateDraft: async ({ message, userMessages, lastQuestion }) => {
      seen.push({ message, userMessages, lastQuestion });
      return { draft: completeDraft(), proposedGap: "none", question: "", answeredPoint: "deliverable" };
    },
    judgeJev: async ({ message, userMessages, lastQuestion, answeredPoint }) => {
      seen.push({ message, userMessages, lastQuestion, answeredPoint });
      return jevAnswers();
    },
  };
  const current = { message: "简短要点", userMessages: ["我提供会议转写", "提取结论和待办"], lastQuestion: "先要简短要点还是详细解释？" };
  await processTurn(current, providers);
  await processTurn({ message: "全新任务" }, providers);
  assert.deepEqual(seen, [current, { ...current, answeredPoint: "deliverable" },
    { message: "全新任务", userMessages: [], lastQuestion: "" },
    { message: "全新任务", userMessages: [], lastQuestion: "", answeredPoint: "deliverable" }]);
});

test("用户暂时说不出额外标准时不重复追问同一个边界问题", async () => {
  const jev = jevAnswers({ score: 0.2, confidence: 1, probabilities: { "0": 0.8, "1": 0.2, "2": 0 } });
  const result = await processTurn({ message: "我不太说得好", draft: completeDraft(),
    lastQuestion: "这件事做到什么程度才算合格？有没有必须遵守或绝对不能做的事？" }, {
    generateDraft: async () => ({ draft: completeDraft(), proposedGap: "boundary",
      answeredPoint: "boundary", question: "还有什么额外标准？" }),
    judgeJev: async () => jev,
    decideReask: async () => { throw new Error("用户已放弃额外标准，不应再复核"); },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.question, null);
  assert.equal(result.confirmationQuestion, CONFIRMATION_QUESTION);
  assert.equal(result.jev.used, true);
  assert.equal(result.jev.reason, "sufficient");
  assert.equal(result.diagnostic.decision.skipOptionalBoundary, true);
});

test("未提供 Jev API 时跳过打分，草稿里的问题照常提出", async () => {
  const phases: ((unknown))[] = [];
  const draft = completeDraft();
  draft.inputSource = { value: "", source: "unknown" };
  const result = await processTurn({ message: "做周报助手" }, {
    generateDraft: async () => ({ draft, proposedGap: "source", question: "资料从哪里来？", answeredPoint: "source" }),
    judgeJev: null,
  }, { onProgress: (event) => phases.push(event.phase) });
  assert.equal(result.jev.used, false);
  assert.equal(result.jev.reason, "not_configured");
  assert.equal(result.diagnostic.jev.failure, null);
  assert.equal(result.diagnostic.jev.answers, null);
  assert.equal(result.status, "needs_input");
  assert.equal(result.question, "资料从哪里来？");
  assert.equal(phases.includes("checking"), false);
});

test("没有匹配到回答点时不调用 Jev", async () => {
  let calls = 0;
  const result = await processTurn({ message: "做周报助手" }, {
    generateDraft: async () => ({ draft: completeDraft(), proposedGap: "none", question: "", answeredPoint: "none" }),
    judgeJev: async () => { calls += 1; throw new Error("should not call"); },
  });
  assert.equal(calls, 0);
  assert.equal(result.jev.reason, "no_matched_point");
  assert.equal(result.status, "ready");
});

test("Jev 分数格式无效时按草稿继续", async () => {
  const draft = completeDraft();
  draft.inputSource = { value: "", source: "unknown" };
  const result = await processTurn({ message: "做周报助手" }, {
    generateDraft: async () => ({ draft, proposedGap: "source", question: "资料从哪里来？", answeredPoint: "source" }),
    judgeJev: async () => ({ answers: { point_sufficiency: { type: "noul", noul: 1 } } }),
  });
  assert.equal(result.question, "资料从哪里来？");
  assert.equal(result.jev.reason, "unavailable");
  assert.equal(result.diagnostic!.jev.failure!.reason, "invalid_response");
});

test("预评估已通过时，Jev 低分仍重问匹配到的点", async () => {
  const draft = completeDraft();
  draft.taskSpec = emptyTaskSpec();
  const result = await processTurn({ message: "会议转写", draft, lastQuestion: "资料从哪来？" }, withPreflight({
    generateDraft: async () => ({ draft: structuredClone(draft), proposedGap: "none", question: "", answeredPoint: "source" }),
    judgeJev: async () => jevAnswers({ score: 0.4, confidence: 0.9, probabilities: { "0": 0.7, "1": 0.2, "2": 0.1 } }),
    decideReask: async () => ({ reask: true, question: "你希望以什么形式交这些资料，通常大概有多少？" }),
  }), { enforceConsultation: true, platform: { version: 1 }, requestId: "jev_reask" });
  assert.equal(result.diagnostic.decision.selectedBy, "reask");
  assert.equal(result.status, "needs_input");
  assert.equal(result.confirmationQuestion, null);
  assert.match(result.question!, /形式/);
  assert.match(result.question!, /多少/);
});

test("确认阶段含糊回复不会原样重复整份需求", async () => {
  const result = await processTurn({ message: "嗯", draft: completeDraft(),
    lastQuestion: CONFIRMATION_QUESTION }, {
    generateDraft: async () => ({ draft: completeDraft(), proposedGap: "none",
      question: "", confirmed: false }),
  });
  assert.equal(result.status, "needs_input");
  assert.equal(result.confirmationQuestion, null);
  assert.match(result.question!, /请回复“确认”/);
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
