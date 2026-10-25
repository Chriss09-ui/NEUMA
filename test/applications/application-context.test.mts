import type { ApplicationContextDescriptor } from "../../src/applications/application-context.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeApplicationContext, applicationContextBinding, applicationInteraction,
  applicationConversationContext } from "../../src/applications/application-context.mjs";

const context = () => ({ instanceId: "page-one", deliveryVersion: "build:hash", revision: 1,
  snapshot: { viewId: "question", title: "微积分练习", summary: "当前选中第一题", selection: ["question-1"], values: { answer: "x²" } } });

test("页面上下文只接受有界结构化快照，绑定不携带页面内容", () => {
  const input = context(), value = normalizeApplicationContext(input);
  assert.deepEqual(value, input); objectFields(value!.snapshot.values).answer = "changed";
  assert.equal(input.snapshot.values.answer, "x²");
  assert.deepEqual(applicationContextBinding(input), { instanceId: "page-one", deliveryVersion: "build:hash", revision: 1 });
  assert.equal(normalizeApplicationContext(undefined), null); assert.equal(normalizeApplicationContext(null), null);
  for (const invalid of [{ ...input, revision: -1 }, { ...input, agentId: "other" },
    { ...input, snapshot: { ...input.snapshot, summary: 2 } },
    { ...input, snapshot: { ...input.snapshot, values: { answer: Infinity } } }]) assert.throws(() => normalizeApplicationContext(invalid), /上下文无效/);
  const dangerous = JSON.parse(String(JSON.stringify(input))); dangerous.snapshot.values = JSON.parse(String('{"__proto__":{"forged":true}}'));
  assert.throws(() => normalizeApplicationContext(dangerous), /上下文无效/);
  const cyclic = context(); Reflect.set(cyclic.snapshot.values, "self", cyclic);
  assert.throws(() => normalizeApplicationContext(cyclic), /上下文无效/);
  const oversized = context(); oversized.snapshot.summary = "字".repeat(6000);
  assert.throws(() => normalizeApplicationContext(oversized), /16 KiB/);
});

test("助手摘要区分旧缺省与显式禁用，默认入口来自已批准交互", () => {
  const descriptor: ApplicationContextDescriptor = { manifest: { page: {} }, architecture: { design: { interaction: { defaultEntry: "conversation" } } } };
  assert.deepEqual(applicationInteraction(descriptor), { defaultEntry: "conversation" });
  descriptor.architecture!.design!.interaction!.assistant = { enabled: false, purpose: "" };
  assert.deepEqual(applicationInteraction(descriptor).assistant, { enabled: false, purpose: "" });
  descriptor.architecture!.design!.interaction! = { defaultEntry: "application", assistant: { enabled: true, purpose: "讲解当前练习并执行已交付动作" } };
  assert.deepEqual(applicationInteraction(descriptor), { defaultEntry: "application", assistant: { enabled: true, purpose: "讲解当前练习并执行已交付动作" } });
  descriptor.manifest!.page = null;
  assert.equal(applicationInteraction(descriptor).defaultEntry, "conversation"); assert.equal(applicationInteraction!(descriptor).assistant!.enabled, false);
});

test("每轮应用参考包含用途和动作契约，缺少快照明确禁止沿用历史页面", () => {
  const descriptor: ApplicationContextDescriptor = { agent: { draft: { goal: { value: "学习微积分" } } },
    architecture: { design: { interaction: { assistant: { enabled: true, purpose: "讲解练习" } } } },
    manifest: { page: {}, actions: [{ id: "check", title: "批改", inputSchema: { type: "object" }, outputSchema: { type: "string" }, connectionIds: [] }] } };
  const prompt = applicationConversationContext(descriptor, context());
  assert.match(prompt, /学习微积分.*讲解练习.*inputSchema.*outputSchema/s);
  assert.match(prompt, /不可信.*question-1/s);
  const cleared = applicationConversationContext(descriptor, null);
  assert.match(cleared, /本轮当前页面不可用.*不得将历史页面快照/);
  assert.doesNotMatch(cleared, /question-1/);
});
