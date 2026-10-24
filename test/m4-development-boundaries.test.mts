import test from "node:test";
import assert from "node:assert/strict";
import { emptyDraft } from "../src/requirements/core.mjs";
import { checkedAgentDefinition, checkedActivationTransaction, checkedDeliveryHistory } from "../src/agents/prototype-storage-boundary.mjs";
import { readDevelopmentDeliveryRecord, readDevelopmentRunRecord } from "../src/development/development-record.mjs";
import { developmentCaseFacts } from "../src/development/development-case-facts.mjs";

const definition = () => ({ id: "sample", name: "旧定义", draft: emptyDraft(), fingerprint: "f".repeat(64),
  instructions: "仅按已提供的材料处理任务。", revision: 1, toolIds: [], historicField: { retained: true } });

test("Agent 持久化边界保留旧记录身份、额外字段和缺省版本字段", () => {
  const source = definition(), before = JSON.stringify(source);
  assert.equal(checkedAgentDefinition(source), source);
  assert.equal(JSON.stringify(source), before);
  assert.equal(Object.hasOwn(source, "mode"), false);
  assert.equal(Object.hasOwn(source, "execution"), false);
  const { toolIds: _toolIds, ...legacy } = source;
  assert.equal(checkedAgentDefinition(legacy), legacy);
  assert.equal(Object.hasOwn(legacy, "toolIds"), false);
  assert.throws(() => checkedAgentDefinition({ ...source, toolIds: [42] }), /定义文件格式无效/);
});

test("激活事务读取不创建绑定，拒绝损坏的嵌套历史定义", () => {
  const transaction = { status: "preparing", deliveryVersion: "old-build:old-hash", prior: definition() };
  const before = JSON.stringify(transaction);
  assert.equal(checkedActivationTransaction(transaction), transaction);
  assert.equal(JSON.stringify(transaction), before);
  assert.equal(Object.hasOwn(transaction, "developmentBinding"), false);
  assert.equal(checkedActivationTransaction(null), null);
  assert.throws(() => checkedActivationTransaction({ ...transaction, prior: { ...definition(), revision: "1" } }), /激活恢复记录格式无效/);
  assert.throws(() => checkedDeliveryHistory([{ deliveryVersion: "old", agent: { ...definition(), draft: {} }, stateVersion: 1,
    dataVersion: 1, language: "javascript", host: "builtin" }]), /需求草稿字段格式无效/);
});

test("历史计划实测只读取声明的用例，不要求完整交付计划或写入版本", () => {
  const plan = { runtime: "node-json", cases: [{ id: "example", acceptanceId: "criteria", input: "中文输入" }] };
  const before = JSON.stringify(plan), result = developmentCaseFacts(plan);
  assert.equal(result.measuredInputs, 1);
  assert.equal(result.planSchemaVersion, 1);
  assert.equal(JSON.stringify(plan), before);
  assert.equal(Object.hasOwn(plan, "schemaVersion"), false);
  assert.throws(() => developmentCaseFacts({ runtime: "node-json", cases: {} }), /有效协议或用例分组/);
});

test("旧 value 约束保留原文和字段名，不归一化已绑定的需求摘要", () => {
  const agent = definition();
  agent.draft.constraints = [{ value: "禁止联网", source: "user" }];
  const before = JSON.stringify(agent);
  assert.equal(checkedAgentDefinition(agent), agent);
  assert.equal(JSON.stringify(agent), before);
  assert.equal(Object.hasOwn(agent.draft.constraints[0]!, "text"), false);
});


test("只读交付投影接受旧包，不能据此声称拥有研发恢复预算", () => {
  const delivery = { id: "old", agentId: "sample", status: "completed", delivery: "ready", planHash: "plan",
    architectureRef: { version: 1, candidateHash: "candidate" },
    package: { codeHash: "code", planHash: "plan", application: { legacy: true }, snapshot: { legacy: true } } };
  const before = JSON.stringify(delivery);
  assert.equal(readDevelopmentDeliveryRecord(delivery), delivery);
  assert.equal(JSON.stringify(delivery), before);
  assert.equal(Object.hasOwn(delivery, "budgets"), false);
  assert.throws(() => readDevelopmentRunRecord(delivery), /研发检查点字段已损坏/);
  assert.throws(() => readDevelopmentDeliveryRecord({ ...delivery, planHash: 42 }), /应用交付与当前/);
});
