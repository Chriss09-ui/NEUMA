import { fixtureText } from "../helpers/m7-test-boundaries.mjs";
import { callFixture } from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { CONFIRMATION_QUESTION, InputError } from "../../src/requirements/core.mjs";
import { advanceRequirement, prepareRequirement, rememberRequirement, requirementContext } from "../../src/main/main-requirements.mjs";
import { validDraft } from "../helpers/architecture.mjs";
import { sufficientPreflight } from "../helpers/consultation.mjs";

const providers = { preflight: sufficientPreflight, generateDraft: async (_input?: unknown) => ({ draft: validDraft("核对用户提供的会议记录"), proposedGap: "none", question: "" }) };
const agents = { getRequirements: async () => ({ requirements: [{ id: "existing", name: "已有助手", draft: validDraft("已有任务") }] }),
  saveRequirements: async (id: string, input: unknown) => ({ requirement: { id, ...objectFields(input), name: fixtureText(objectFields(input).name), draft: objectFields(input).draft, updatedAt: "2026-10-11T00:00:00Z" } }) };

test("草稿身份按对话和幂等请求生成，明确新建不会覆盖先前 Agent", async () => {
  const input = { record: {}, conversationId: "one", mutationId: "activation", mode: "new" };
  const one = await prepareRequirement(input, agents), same = await prepareRequirement(input, agents);
  const other = await prepareRequirement({ ...input, conversationId: "two" }, agents);
  assert.equal(one.agentId, same.agentId); assert.notEqual(one.agentId, other.agentId);
  const record = {}; rememberRequirement(record, one);
  const later = await prepareRequirement({ ...input, record, mutationId: "second" }, agents); rememberRequirement(record, later);
  assert.notEqual(one.agentId, later.agentId); assert.equal(objectFields(objectFields(record).requirements).length, 2);
  assert.equal(objectFields(objectFields(record).requirement).agentId, later.agentId);
});

test("原需求确认规则保持，未确认不保存，明确确认保存同一身份和实际需求对象", async () => {
  let saved = 0, generated = 0;
  const customAgents = { ...agents, async saveRequirements(id: string, input: unknown) { saved++; return agents.saveRequirements(id, input); } };
  const draft = await prepareRequirement({ record: {}, conversationId: "one", mutationId: "new", mode: "new" }, customAgents);
  const drafted = await advanceRequirement(draft, "创建一个会议助手", { preflight: sufficientPreflight, generateDraft: async (input) => { generated++; return providers.generateDraft(input); } }, { agents: customAgents });
  assert.equal(drafted.requirement.status, "ready"); assert.equal(drafted.requirement.lastQuestion, CONFIRMATION_QUESTION);
  assert.equal(saved, 0); assert.match(drafted.reply, /这份需求可以确认吗/);
  const confirmed = await advanceRequirement(drafted.requirement, "确认需求", { generateDraft: async () => { throw new Error("明确确认不应请求模型"); } }, { agents: customAgents });
  assert.equal(confirmed.requirement.agentId, draft.agentId); assert.equal(confirmed.requirement.status, "needs_build");
  assert.equal(confirmed.context!.savedRequirement!.id, draft.agentId); assert.equal(confirmed.action!.requirement.id, draft.agentId);
  assert.equal(confirmed.source!.type, "agent_created"); assert.equal(saved, 1); assert.equal(generated, 1);
  assert.match(confirmed.reply, /需求已确认并保存/);
  assert.match(confirmed.reply, /正在打开左侧的这个智能体，开始架构评估与制作/);
  assert.doesNotMatch(confirmed.reply, /这份需求可以确认吗|Agent 要解决的问题/);
  assert.equal(draft.confirmed, false); assert.equal(drafted.requirement.confirmed, false);
});

test("迭代复用保存的 Agent 身份，恢复已确认草稿会回到待确认编辑态", async () => {
  const loaded = await prepareRequirement({ record: {}, conversationId: "one", mutationId: "edit", agentId: "existing", mode: "edit" }, agents);
  assert.equal(loaded.agentId, "existing"); assert.equal(loaded.mode, "edit"); assert.equal(loaded.draft.goal.value, "已有任务");
  const confirmed = await advanceRequirement(loaded, "确认", providers, { agents });
  assert.equal(confirmed.source!.type, "agent_updated"); const record = {}; rememberRequirement(record, confirmed.requirement);
  const reopened = await prepareRequirement({ record, conversationId: "one", mutationId: "edit_again", agentId: "existing", mode: "edit" }, agents);
  assert.equal(reopened.agentId, "existing"); assert.equal(reopened.confirmed, false); assert.equal(reopened.lastQuestion, CONFIRMATION_QUESTION);
  assert.equal(requirementContext!(reopened)!.needsBuild, false); assert.equal(objectFields(objectFields(record).requirement).confirmed, true);
});

test("显式迭代已确认草稿读取另一会话保存的新需求，确认不会回写旧版本", async () => {
  const original = await prepareRequirement({ record: {}, conversationId: "one", mutationId: "edit", agentId: "existing", mode: "edit" }, agents);
  const confirmed = await advanceRequirement(original, "确认需求", providers, { agents });
  const record = {}; rememberRequirement(record, confirmed.requirement); const before = structuredClone(record);
  const latest = { id: "existing", name: "新的助手需求", draft: validDraft("另一会话已确认的新任务") };
  let reads = 0, saved;
  const currentAgents = { async getRequirements() { reads++; return { requirements: [latest] }; },
    async saveRequirements(id: string, input: unknown) { saved = { id, ...objectFields(structuredClone(input)), name: fixtureText(objectFields(input).name), draft: objectFields(input).draft }; return { requirement: saved }; } };
  const edited = await prepareRequirement({ record, conversationId: "one", mutationId: "edit_again", agentId: "existing", mode: "edit" }, currentAgents);
  assert.equal(reads, 1); assert.equal(edited.agentId, "existing"); assert.deepEqual(edited.draft, latest.draft);
  assert.deepEqual(edited.savedRequirement, latest); assert.equal(edited.confirmed, false); assert.equal(edited.status, "ready");
  assert.equal(edited.version, confirmed.requirement.version + 1); assert.equal(edited.createdAt, confirmed.requirement.createdAt);
  await advanceRequirement(edited, "确认需求", { preflight: sufficientPreflight, generateDraft: async () => assert.fail("确认不请求需求重写模型") }, { agents: currentAgents });
  assert.deepEqual(saved!.draft!, { ...latest.draft, taskSpec: { version: 1, items: [] } }); assert.deepEqual(record, before);
});

test("显式迭代保留当前会话未确认的修改，不用已保存版本覆盖工作草稿", async () => {
  const local = await prepareRequirement({ record: {}, conversationId: "one", mutationId: "edit", agentId: "existing", mode: "edit" }, agents);
  local.draft = validDraft("尚未确认的本地修改"); const record = {}; rememberRequirement(record, local);
  const before = structuredClone(record);
  const edited = await prepareRequirement({ record, conversationId: "one", mutationId: "resume_edit", agentId: "existing", mode: "edit" }, {
    getRequirements: async () => assert.fail("未确认的本地草稿不应重新加载已保存需求"),
  });
  assert.deepEqual(edited.draft, local.draft); assert.equal(edited.agentId, local.agentId);
  assert.equal(edited.version, local.version); assert.equal(edited.confirmed, false); assert.deepEqual(record, before);
});

test("正式迭代只确认相对已保存版本的增删改，确认后仍完整交付同一助手", async () => {
  const base = validDraft("这个旧目标已经确认");
  base.constraints = [{ text: "保留原文证据", source: "user" }, { text: "分两栏", source: "user" }];
  const saved = { id: "existing", name: base.name.value, draft: base };
  const api = { ...agents, getRequirements: async () => ({ requirements: [saved] }) };
  const edit = await prepareRequirement({ record: {}, conversationId: "one", mutationId: "open", agentId: saved.id, mode: "edit" }, api);
  const changed = structuredClone(base);
  changed.deliverable.value += "，附上行动清单";
  changed.constraints.pop(); changed.constraints.push({ text: "保留负责人", source: "user" });
  const result = await advanceRequirement(edit, "附上行动清单，保留负责人，取消分栏", {
    preflight: sufficientPreflight, generateDraft: async () => ({ draft: changed, proposedGap: "none", question: "" }),
  }, { agents: api });
  assert.deepEqual(result.context.changes, ["补充输出：附上行动清单", "新增工作约束：保留负责人", "移除工作约束：分两栏"]);
  assert.doesNotMatch(result.reply, /这个旧目标|保留原文证据|核心使用场景|这份需求可以确认吗/);
  assert.match(result.reply, /确认本次修改/);
  assert.equal(result.action, undefined);
  const approved = await advanceRequirement(result.requirement, "确认修改", {
    generateDraft: async () => assert.fail("确认当前差异不重写需求"),
  }, { agents: api });
  assert.equal(approved.action?.agentId, "existing"); assert.equal(approved.requirement.draft.goal.value, base.goal.value);
  assert.deepEqual(approved.requirement.draft.constraints, changed.constraints);
});

test("另一会话在确认前保存了需求，会先展示最新差异，再接受确认", async () => {
  const base = validDraft("整理会议"), newer = structuredClone(base);
  newer.constraints.push({ text: "保留发言人", source: "user" });
  const api = { ...agents, getRequirements: async () => ({ requirements: [{ id: "existing", name: base.name.value, draft: base }] }) };
  const opened = await prepareRequirement({ record: {}, conversationId: "chat", mutationId: "open", agentId: "existing", mode: "edit" }, api);
  const candidate = structuredClone(base); candidate.deliverable.value += "，附术语表";
  const proposal = await advanceRequirement(opened, "附术语表", { ...providers, generateDraft: async () => ({ draft: candidate, proposedGap: "none", question: "" }) }, { agents: api });
  const latest = { id: "existing", name: newer.name.value, draft: newer };
  const conflict = await advanceRequirement(proposal.requirement, "确认修改", providers, { agents: { getRequirements: async () => ({ requirements: [latest] }),
    saveRequirements: async (_id, _input, options) => {
      assert.deepEqual(options?.expectedDraft, base); throw Object.assign(new InputError("其他窗口更新了需求"), { reason: "requirement_version_conflict" });
    } } });
  assert.equal(conflict.action, undefined); assert.equal(conflict.requirement.confirmed, false);
  assert.match(conflict.reply, /移除工作约束：保留发言人/); assert.match(conflict.reply, /补充输出：附术语表/);
  const approved = await advanceRequirement(conflict.requirement, "确认修改", providers, { agents: { ...api,
    saveRequirements: async (id, input, options) => { assert.deepEqual(options?.expectedDraft, newer); return agents.saveRequirements(id, input); } } });
  assert.equal(approved.action?.agentId, latest.id);
});

test("取消、模型错误和无效输入不改变旧草稿，不保存 Agent", async () => {
  const draft = await prepareRequirement({ record: {}, conversationId: "one", mutationId: "new", mode: "new" }, agents), snapshot = structuredClone(draft);
  const controller = new AbortController(); let saved = 0;
  const noSave = { ...agents, async saveRequirements() { saved++; throw new Error("不可保存"); } };
  await assert.rejects(callFixture(advanceRequirement, undefined, [draft, "创建助手", { generateDraft: async () => { controller.abort(); return providers.generateDraft(); } }, { agents: noSave, signal: controller.signal }]), { name: "AbortError" });
  await assert.rejects(callFixture(advanceRequirement, undefined, [draft, "创建助手", { generateDraft: async () => { throw new Error("模型故障"); } }, { agents: noSave }]), /模型故障/);
  await assert.rejects(callFixture(advanceRequirement, undefined, [draft, "过".repeat(12001), providers, { agents: noSave }]), InputError);
  assert.deepEqual(draft, snapshot); assert.equal(saved, 0);
});
