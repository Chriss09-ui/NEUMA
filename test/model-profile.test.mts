import { objectFields } from "../src/runtime/type-boundary.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { checkedModelProfile, readModelProfile, resolvedModelProfile, modelProfileHash } from "../src/runtime/model-profile.mjs";
import { modelOutputBudget, architectureModelOutputBudget, developmentModelOutputBudget } from "../src/runtime/model-limits.mjs";
import type { ExplicitModelProfile } from "../src/contracts/model.mjs";

const target = { chatUrl: "https://gateway.example.test/v1/chat/completions", model: "private-alias" };
const explicit = (updates = {}) => ({ schemaVersion: 1, target, api: "openai-completions", contextWindow: 65536,
  maxOutputTokens: 12000, reasoning: true, input: ["text"], compat: { maxTokensField: "max_tokens", thinkingFormat: "zai", supportsReasoningEffort: false }, ...updates });

test("自动能力读取精确官方本地目录，不按品牌猜型号或协议", () => {
  for (const [chatUrl, model, contextWindow, maxOutputTokens, input] of [
    ["https://api.xiaomimimo.com/v1/chat/completions", "mimo-v2.6-pro", 1048576, 131072, ["text", "image"]],
    ["https://api.deepseek.com/chat/completions", "deepseek-v4-pro", 1000000, 384000, ["text"]],
    ["https://api.z.ai/api/coding/paas/v4/chat/completions", "glm-5.3", 1000000, 131072, ["text"]],
  ] as const) {
    const profile = resolvedModelProfile({ chatUrl, model, apiKey: "secret-not-profile" });
    assert.equal(profile.source.kind, "pi-local-catalog"); assert.equal(profile.source.packageVersion, "1.0.0");
    assert.equal(profile.api, "openai-completions"); assert.equal(profile.contextWindow, contextWindow);
    assert.equal(profile.maxOutputTokens, maxOutputTokens); assert.equal(profile.reasoning, true); assert.deepEqual(profile.input, input);
    assert.doesNotMatch(JSON.stringify(profile), /secret-not-profile|headers|apiKey/);
  }
  assert.equal(resolvedModelProfile({ chatUrl: "https://api.z.ai/api/coding/paas/v4/chat/completions", model: "glm-5.3" }).thinkingLevelMap!.off, null);
});

test("同名模型跨网关、假域名、不同路径或不同协议不自动继承能力", () => {
  for (const [chatUrl, model] of [
    [target.chatUrl, "mimo-v2.6-pro"], ["https://api.xiaomimimo.com.evil.test/v1/chat/completions", "mimo-v2.6-pro"],
    ["https://api.xiaomimimo.com/other/chat/completions", "mimo-v2.6-pro"],
    ["https://api.z.ai/api/paas/v4/chat/completions", "glm-5.3"], ["https://api.deepseek.com/chat/completions", "deepseek-chat"],
    ["https://api.openai.com/v1/chat/completions", "gpt-5"],
  ]) {
    const profile = resolvedModelProfile({ chatUrl, model });
    assert.equal(profile.source.kind, "fallback"); assert.equal(profile.reasoning, false);
    assert.equal(profile.contextWindow, 32768); assert.equal(profile.maxOutputTokens, 16384); assert.deepEqual(profile.input, ["text"]);
  }
});

test("未知网关别名可显式配置，声明精确绑定且不覆盖可信目录", () => {
  const profile = checkedModelProfile(explicit({ input: ["image", "text"] }));
  const config = { ...target, modelProfile: profile };
  const resolved = resolvedModelProfile(config);
  assert.equal(resolved.source.kind, "explicit"); assert.equal(resolved.contextWindow, 65536);
  assert.deepEqual(resolved.input, ["text", "image"]); assert.equal(resolved.compat.thinkingFormat, "zai");
  assert.equal(objectFields(resolvedModelProfile({ ...config, model: "changed-alias" }).source).reason, "explicit_target_mismatch");
  assert.equal(objectFields(resolvedModelProfile({ ...config, chatUrl: "https://other.test/v1/chat/completions" }).source).reason, "explicit_target_mismatch");
  const official = { chatUrl: "https://api.xiaomimimo.com/v1/chat/completions", model: "mimo-v2.6-pro" };
  assert.equal(resolvedModelProfile({ ...official, modelProfile: explicit({ target: official }) }).source.kind, "pi-local-catalog");
});

test("能力配置严格类型、有界、无秘密及任意请求覆盖入口", () => {
  const bad = [explicit({ api: "anthropic-messages" }), explicit({ contextWindow: "65536" }), explicit({ maxOutputTokens: 1000000 }),
    explicit({ contextWindow: 4096, maxOutputTokens: 512 }), explicit({ contextWindow: 8191, maxOutputTokens: 512 }),
    explicit({ reasoning: "true" }), explicit({ input: ["text", "video"] }), explicit({ input: ["text", "text"] }),
    explicit({ apiKey: "forbidden" }), explicit({ headers: { authorization: "forbidden" } }), explicit({ samplingParams: { tools: [] } }),
    explicit({ compat: { maxTokensField: "guessed" } }), explicit({ compat: { arbitrary: "secret" } }),
    explicit({ compat: { supportsFinishReason: false } }),
    explicit({ target: { ...target, chatUrl: "https://user:secret@gateway.test/v1/chat/completions" } }),
    explicit({ target: { ...target, chatUrl: target.chatUrl + "?key=secret" } }), explicit({ target: { ...target, model: "x".repeat(9000) } }),
    explicit({ thinkingLevelMap: { off: { arbitrary: true } } }), explicit({ input: ["text", ,] }),
  ];
  for (const value of bad) assert.throws(() => checkedModelProfile(value), /模型能力配置无效/);
  let accessed = false;
  const value = explicit(); Object.defineProperty(value, "apiKey", { enumerable: true, get() { accessed = true; throw new Error("secret"); } });
  assert.throws(() => checkedModelProfile(value), /模型能力配置无效/); assert.equal(accessed, false);
  assert.throws(() => readModelProfile('{"__proto__":{"secret":true}}'), /模型能力配置无效/);
});

test("有效能力hash稳定且所有实际能力变动都改变绑定", () => {
  const a = checkedModelProfile(explicit()), b = checkedModelProfile({ ...explicit(), compat: { supportsReasoningEffort: false, thinkingFormat: "zai", maxTokensField: "max_tokens" } });
  const resolved = (profile: ExplicitModelProfile) => resolvedModelProfile({ ...target, modelProfile: profile });
  assert.equal(modelProfileHash(resolved(a)), modelProfileHash(resolved(b)));
  for (const update of [{ contextWindow: 131072 }, { maxOutputTokens: 11000 }, { reasoning: false }, { input: ["text", "image"] },
    { compat: { ...a.compat, supportsUsageInStreaming: false } }, { thinkingLevelMap: { off: null, high: "high" } }])
    assert.notEqual(modelProfileHash(resolved(a)), modelProfileHash(resolved(checkedModelProfile(explicit(update)))));
  assert.ok(Object.isFrozen(resolved(a))); assert.ok(Object.isFrozen(resolved(a).compat));
  assert.deepEqual(readModelProfile(JSON.stringify(a)), a); assert.equal(readModelProfile(""), null);
});

test("角色请求量不等同模型能力上限，网关和官方模型复用相同计算", () => {
  const config = { ...target, modelProfile: checkedModelProfile(explicit()) };
  assert.equal(modelOutputBudget(config), 4096); assert.equal(modelOutputBudget(config, 8192), 8192);
  assert.equal(modelOutputBudget(config, 30000), 12000);
  assert.equal(architectureModelOutputBudget(config, "designer"), 12000);
  assert.equal(architectureModelOutputBudget(config, "reviewer"), 12000);
  assert.equal(developmentModelOutputBudget(config, "developer"), 12000);
  assert.equal(architectureModelOutputBudget(target, "designer"), 8192);
  assert.throws(() => architectureModelOutputBudget(config, "__proto__"));
});

test("架构设计与模块思考预算按角色扩大，评审及模型能力上限仍独立约束", () => {
  const official = { chatUrl: "https://api.xiaomimimo.com/v1/chat/completions", model: "mimo-v2.6-pro" };
  const gateway = { ...target, modelProfile: checkedModelProfile(explicit({ contextWindow: 131072, maxOutputTokens: 100000 })) };
  const budgets = { designer: 65536, module: 32768, specialist: 32768, reviewer: 16384 };
  for (const config of [official, gateway]) {
    for (const [role, expected] of Object.entries(budgets)) assert.equal(architectureModelOutputBudget(config, role), expected);
  }
  const capped = { ...target, modelProfile: checkedModelProfile(explicit({ maxOutputTokens: 24000 })) };
  assert.equal(architectureModelOutputBudget(capped, "designer"), 24000);
  assert.equal(architectureModelOutputBudget(capped, "module"), 24000);
  assert.equal(architectureModelOutputBudget(capped, "specialist"), 24000);
  assert.equal(architectureModelOutputBudget(capped, "reviewer"), 16384);
});

test("架构扩额保留未知与非思考模型的保守额度，不改变研发角色预算", () => {
  const gateway = { ...target, modelProfile: checkedModelProfile(explicit({ contextWindow: 131072, maxOutputTokens: 100000 })) };
  const nonReasoning = { ...target, modelProfile: checkedModelProfile(explicit({ reasoning: false, maxOutputTokens: 32000 })) };
  const mismatched = { ...gateway, model: "changed-alias" };
  const fallbackBudgets = { designer: 8192, module: 4096, specialist: 4096, reviewer: 4096 };
  for (const config of [target, nonReasoning, mismatched]) {
    for (const [role, expected] of Object.entries(fallbackBudgets)) assert.equal(architectureModelOutputBudget(config, role), expected);
  }
  const official = { chatUrl: "https://api.xiaomimimo.com/v1/chat/completions", model: "mimo-v2.6-pro" };
  const developmentBudgets = { planner: 32768, developer: 65536, reviewer: 16384 };
  for (const config of [official, gateway]) {
    for (const [role, expected] of Object.entries(developmentBudgets)) assert.equal(developmentModelOutputBudget(config, role), expected);
  }
});
