import test from "node:test";
import assert from "node:assert/strict";
import { groupMentionIds, validateGroupMentions } from "../src/collaboration/group-mentions.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollaborationService } from "../src/collaboration/groups.mjs";

const members = [{ id: "research", name: "资料研究员" }, { id: "plan", name: "方案搭建员" },
  { id: "jarvis", name: "JARVIS" }, { id: "short", name: "资料" }];

test("准确 @ 本群成员，按首次出现顺序去重并识别最长完整名称", () => {
  assert.deepEqual(groupMentionIds("@资料研究员，@方案搭建员 你们分别介绍一下。@资料研究员 再说说边界", members), ["research", "plan"]);
  assert.deepEqual(groupMentionIds("请 @JARVIS 回答", members), ["jarvis"]);
  assert.deepEqual(groupMentionIds("@资料研究员之外 @未知成员 @JARVIS-外部", members), []);
});

test("代码、链接、引用、转义和邮箱中的 @ 不能暗中点名", () => {
  const examples = ["`@资料研究员`", "```txt\n@资料研究员\n```", "~~~txt\n@资料研究员\n~~~",
    "[@资料研究员](https://example.com)", "![图 @资料研究员](https://example.com/a.png)",
    "> @资料研究员", "\\@资料研究员", "someone@JARVIS.example.com", "https://example.com/@JARVIS"];
  for (const example of examples) assert.deepEqual(groupMentionIds(example, members), [], example);
  assert.deepEqual(groupMentionIds("`@资料研究员`，请 @方案搭建员 回答", members), ["plan"]);
});

test("同名成员不猜测身份，Markdown 普通文字的明确 @ 仍可点名", () => {
  assert.deepEqual(groupMentionIds("@资料研究员 说说吧", [...members, { id: "duplicate", name: "资料研究员" }]), []);
  assert.deepEqual(groupMentionIds("**@资料研究员** 和 * @方案搭建员 *", members), ["research", "plan"]);
  assert.deepEqual(groupMentionIds("@JARVIS", [...members, { id: "jarvis", name: "JARVIS" }]), ["jarvis"]);
});

test("从补全选择的同名成员按正文位置绑定真实身份，编辑后不沿用旧目标", () => {
  const same = [...members, { id: "duplicate", name: "资料研究员" }], content = "你好，@资料研究员 请回复";
  const mention = { memberId: "duplicate", start: 3, end: 9, text: "@资料研究员" };
  assert.deepEqual(validateGroupMentions(content, [mention], same), [mention]);
  assert.throws(() => validateGroupMentions(content.replace("研究", "整理"), [mention], same), /已变化/);
  assert.throws(() => validateGroupMentions(content, [{ ...mention, memberId: "outside" }], same), /已变化/);
  assert.throws(() => validateGroupMentions(content, [mention, mention], same), /重叠/);
  assert.throws(() => validateGroupMentions(content, [{ ...mention, start: -1 }], same), /位置无效/);
  assert.throws(() => validateGroupMentions(content, [{ ...mention, extra: true }], same), /位置无效/);
});

test("提及绑定不接受代码、引用、链接、转义及邮箱里的伪造选择", () => {
  for (const content of ["`@资料研究员`", "> @资料研究员", "[@资料研究员](https://example.com)", "\\@资料研究员", "email@资料研究员"]) {
    const start = content.indexOf("@");
    assert.throws(() => validateGroupMentions(content, [{ memberId: "research", start, end: start + 6, text: "@资料研究员" }], members), /消息正文/, content);
  }
});

test("显式同名选择保存成员身份与正文片段，幂等不重复且删除选择后不会继承", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-selected-mentions-"));
  const cards = ["first", "second"].map((id) => ({ id, name: "资料研究员", ready: true, revision: 1 }));
  const service = new CollaborationService({ dataDir: root, agents: { ready: Promise.resolve(), capabilityCards: async () => ({ agents: cards }) },
    materials: { resolve: async () => [], list: async () => ({ attachments: [] }), close: async () => {} } });
  service.start = () => {};
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const { group } = await service.createGroup({ name: "同名验证", memberIds: ["first", "second"], mutationId: "create" });
  const input = { content: "@资料研究员 你好", mentions: [{ memberId: "second", start: 0, end: 6, text: "@资料研究员" }], mutationId: "selected" };
  const result = await service.postMessage(group.id, input);
  assert.deepEqual(result.task!.requestedRecipientIds, ["second"]);
  assert.deepEqual(result.message!.mentions, input.mentions);
  assert.equal((await service.postMessage(group.id, input)).message!.id, result.message!.id);
  const plain = await service.postMessage(group.id, { content: "你好", mutationId: "plain" });
  assert.equal(plain.task!.requestedRecipientIds, undefined);
  assert.equal(plain.message!.mentions, undefined);
  cards[1]!.ready = false;
  await assert.rejects(service.postMessage(group.id, { ...input, mutationId: "unready" }), /尚未就绪/);
  assert.equal((await service.getGroup(group.id)).messages.length, 2);
});

test("用户明确点名保存真实目标且幂等，群外文字不派发，未就绪成员不接受发送", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-group-mentions-"));
  const cards = [...members.map((member) => ({ ...member, ready: true, revision: 1 })),
    { id: "offline", name: "未就绪成员", ready: false, revision: 1 }, { id: "outside", name: "群外成员", ready: true, revision: 1 }];
  const agents = { ready: Promise.resolve(), capabilityCards: async () => ({ agents: cards }) };
  const service = new CollaborationService({ dataDir: root, agents,
    materials: { resolve: async () => [], list: async () => ({ attachments: [] }), close: async () => {} } });
  // Exercise message acceptance separately from model execution.
  service.start = () => {};
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const { group } = await service.createGroup({ name: "点名验证", memberIds: ["research", "plan", "offline"], mutationId: "create" });
  const input = { content: "@资料研究员 @方案搭建员 你们各自介绍一下", mutationId: "first" };
  const first = await service.postMessage(group.id, input);
  assert.deepEqual(first.task!.requestedRecipientIds, ["research", "plan"]);
  assert.deepEqual(first.message!.mentionIds, ["research", "plan"]);
  assert.equal((await service.postMessage(group.id, input)).message!.id, first.message!.id);
  const outside = await service.postMessage(group.id, { content: "@群外成员 这只是本群外的名字", mutationId: "outside" });
  assert.equal(outside.task!.requestedRecipientIds, undefined);
  await assert.rejects(service.postMessage(group.id, { content: "@未就绪成员 你好", mutationId: "offline" }), /尚未就绪/);
  assert.equal((await service.getGroup(group.id)).messages.length, 2);
  await service.store.change(group.id, (record) => {
    const task = record.tasks.find((task) => task.id === first.task!.id);
    task!.phase = "conversation"; task!.status = "needs_input"; task!.ownerId = "research";
    task!.replyAudience = { mode: "members", memberIds: ["research", "plan"] };
  });
  const followup = await service.postMessage(group.id, { content: "@方案搭建员 我补充一下", taskId: first.task!.id, mutationId: "followup" });
  assert.equal(followup.task!.id, first.task!.id);
  assert.deepEqual(followup.task!.requestedRecipientIds, ["plan"]);
  assert.equal(followup.task!.replyAudience, undefined);
  assert.equal(followup.task!.requestedRecipientId, null);
});
