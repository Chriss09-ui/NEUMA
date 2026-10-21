import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import { normalizeTaskSpec, taskSpecDiagnostic, taskSpecSchema, validateTaskEvidence } from "../src/requirements/task-spec.mjs";
import { makeProviders } from "../src/requirements/providers.mjs";

const evidence = [{ messageId: "user_1", quote: "逐项检查" }];
const item = (kind = "user") => ({ id: "coverage", dimension: "processing", content: "逐项检查", applicability: "applies", critical: true,
  source: { kind, evidence: structuredClone(evidence), ...(kind === "inferred" ? { reason: "按原文直接推导" } : {}) } });
const spec = () => ({ version: 1, items: [item()] });
const config = { llmConfigured: true, chatUrl: "https://model.invalid/chat", model: "fixture", apiKey: "fixture" };
const messages = [{ id: "user_1", role: "user", content: "逐项检查，不要抽样。" },
  { id: "assistant_1", role: "assistant", content: "建议生成清单。" }, { id: "measurement_1", role: "measurement", content: "实际20项。" }];
const response = (value) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));

test("完整taskSpec结构与规范化共用枚举和边界，兼容合法历史扩展字段及可选说明", () => {
  const validate = new Ajv({ strict: true }).compile(taskSpecSchema());
  for (const kind of ["user", "accepted", "measured", "inferred", "unknown"]) {
    const value = { version: 1, items: [item(kind)], legacyExtension: { preservedOnlyInOriginal: true } };
    if (kind === "unknown") value.items[0].source.evidence = [];
    if (kind !== "inferred") value.items[0].source.reason = { oldOptionalValue: true };
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    const normalized = normalizeTaskSpec(value);
    assert.equal(normalized.items[0].source.kind, kind); assert.equal("legacyExtension" in normalized, false);
    if (kind !== "inferred") assert.equal("reason" in normalized.items[0].source, false);
  }
  const boundary = spec(); boundary.items[0].content = "字".repeat(2000); boundary.items[0].source.evidence[0].quote = "字".repeat(4000);
  assert.equal(validate(boundary), true); assert.doesNotThrow(() => normalizeTaskSpec(boundary));
  const retired = { version: 1, items: [], retired: [{ id: "old", reason: "用户明确取消", evidence }] };
  assert.equal(validate(retired), true); assert.deepEqual(normalizeTaskSpec(retired), retired);
});

test("schema和规范化拒绝缺失字段、错误类型、来源依据及长度越界，不能用数字编号冒充字符串", () => {
  const validate = new Ajv({ strict: true }).compile(taskSpecSchema());
  const invalid = [
    (v) => { v.version = 2; }, (v) => { v.items = {}; }, (v) => { v.items = Array.from({ length: 121 }, (_entry, n) => ({ ...item(), id: `i_${n}` })); },
    (v) => { delete v.items[0].id; }, (v) => { v.items[0].id = 12; }, (v) => { v.items[0].dimension = "处理"; },
    (v) => { v.items[0].applicability = "optional"; }, (v) => { v.items[0].content = "   "; },
    (v) => { v.items[0].content = "字".repeat(2001); }, (v) => { v.items[0].critical = "true"; },
    (v) => { v.items[0].source = []; }, (v) => { v.items[0].source.kind = "default"; },
    (v) => { delete v.items[0].source.evidence; }, (v) => { v.items[0].source.evidence = []; },
    (v) => { v.items[0].source.evidence = Array.from({ length: 13 }, () => ({ ...evidence[0] })); },
    (v) => { v.items[0].source.evidence[0].messageId = 123; }, (v) => { v.items[0].source.evidence[0].quote = "字".repeat(4001); },
    (v) => { v.items[0].source.kind = "inferred"; }, (v) => { v.retired = [{ id: "old", reason: "取消", evidence: [] }]; },
  ];
  for (const mutate of invalid) {
    const value = spec(); mutate(value);
    assert.equal(validate(value), false); assert.throws(() => normalizeTaskSpec(value));
  }
  const duplicate = spec(); duplicate.items.push({ ...item(), content: "不同内容也不能重复编号" });
  assert.throws(() => normalizeTaskSpec(duplicate), (error) => taskSpecDiagnostic(error).rejection === "item_id_duplicate");
});

test("任务结构错误只返回受控拒绝原因与字段路径，不记录候选内容或增加模型调用", async () => {
  const secretMarker = "private-model-value-not-for-diagnostics";
  for (const [mutate, rejection, path] of [
    [(value) => { value.items[0].dimension = secretMarker; }, "dimension_invalid", "taskSpec.items[].dimension"],
    [(value) => { value.items[0].source.kind = secretMarker; }, "source_kind_invalid", "taskSpec.items[].source.kind"],
    [(value) => { value.items[0].source.evidence = []; }, "evidence_missing", "taskSpec.items[].source.evidence"],
    [(value) => { value.items[0].source.kind = "inferred"; }, "inferred_reason_missing", "taskSpec.items[].source.reason"],
  ]) {
    let calls = 0;
    const value = spec(); value.privateDetail = secretMarker; mutate(value);
    const provider = makeProviders(config, async () => { calls++; return response({ draft: { taskSpec: value } }); });
    await assert.rejects(provider.generateDraft({ message: "逐项检查", previousDraft: {}, taskSpecVersion: 1, evidenceMessages: messages }), (error) => {
      assert.deepEqual(error.diagnostic, { stage: "llm", reason: "invalid_task_spec", rejection, paths: [path] });
      assert.equal(JSON.stringify(error.diagnostic).includes(secretMarker), false); assert.equal(error.message.includes(secretMarker), false);
      return true;
    });
    assert.equal(calls, 1);
  }
  assert.deepEqual(taskSpecDiagnostic({ taskSpecRejection: secretMarker, message: secretMarker }), { rejection: "task_spec_shape", paths: ["taskSpec"] });
});

test("首次生成显式携带完整结构、实际消息编号和来源角色规则，结构正确但引文错仍只修复一次", async () => {
  const requests = [];
  const initial = spec(); initial.items[0].source.evidence[0].quote = "逐条核对";
  const provider = makeProviders(config, async (_url, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    if (requests.length === 1) return response({ draft: { taskSpec: initial }, confirmed: false });
    const context = JSON.parse(request.messages[1].content);
    return response({ items: [{ id: "coverage", evidenceRefIds: [context.evidenceReferences.find((entry) => entry.messageId === "user_1").referenceId] }], retired: [] });
  });
  const result = await provider.generateDraft({ message: messages[0].content, previousDraft: {}, taskSpecVersion: 1, evidenceMessages: messages });
  const context = JSON.parse(requests[0].messages[1].content);
  assert.deepEqual(context.taskSpecEvidence.allowedMessageIds, { user: ["user_1"], assistant: ["assistant_1"], measurement: ["measurement_1"] });
  assert.match(context.taskSpecEvidence.rules.accepted, /建议.*用户明确接受/); assert.match(context.taskSpecEvidence.rules.retired, /本轮用户明确修改/);
  assert.match(requests[0].messages[0].content, /taskSpecSchema给出完整结构/);
  const validate = new Ajv({ strict: true }).compile(context.taskSpecSchema);
  const forged = spec(); forged.items[0].source.evidence[0].messageId = "platform.runtime";
  assert.equal(validate(forged), false); assert.equal(validate(spec()), true);
  assert.equal(requests.length, 2); assert.equal(result.confirmed, false);
  assert.doesNotThrow(() => validateTaskEvidence(result.draft.taskSpec, messages));
  assert.deepEqual(result.draft.taskSpec.items[0].source.evidence, [{ messageId: "user_1", quote: messages[0].content }]);
  assert.equal("evidenceRefIds" in result.draft.taskSpec.items[0].source, false);
});
