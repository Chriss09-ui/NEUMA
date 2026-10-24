import { callFixture } from "./helpers/m7-test-boundaries.mjs";
import { fixtureTools } from "./helpers/m7-test-boundaries.mjs";
import type { PiSessionPort } from "../src/runtime/pi-port.mjs";
interface MaterialRecord { options: PiSessionOptions; prompts: { text: string; promptOptions?: Parameters<PiSessionPort["prompt"]>[1] }[] }
type MaterialWork = (record: MaterialRecord, session: PiSessionPort) => unknown | Promise<unknown>;
import type { PiSessionOptions } from "../src/runtime/pi-port.mjs";
import type { SessionMessage } from "../src/runtime/pi-port.mjs";
import { toolText } from "./helpers/m7-test-boundaries.mjs";
import type { TestFailure } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { LEGACY_CAPABILITIES } from "../src/architecture/architecture-contract.mjs";
import { ProviderError } from "../src/requirements/core.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";

function sessions(records: MaterialRecord[], work: MaterialWork = async () => {}, designOverrides = {}) {
  return async (options: PiSessionOptions) => {
    const designer = fixtureTools(options.customTools).submit_architecture;
    const reviewer = fixtureTools(options.customTools).submit_architecture_review;
    const record: MaterialRecord = { options, prompts: [] };
    const session = { messages: [] as SessionMessage[], subscribe: () => () => {},
      async prompt(text: string, promptOptions?: Parameters<PiSessionPort["prompt"]>[1]) {
        if (designer) await designer.execute("design", validDesign(JSON.parse(String(text)).requirements, designOverrides));
        else if (reviewer) await reviewer.execute("review", passingReview(JSON.parse(String(text)).candidateHash));
        else { record.prompts.push({ text, promptOptions }); await work(record, session); }
      },
      getLastAssistantText: () => "已基于材料回答。", abort: async () => {}, dispose() {} };
    if (!designer && !reviewer) records.push(record);
    return session;
  };
}

async function fixture(t: test.TestContext, work?: MaterialWork, designOverrides?: object) {
  const root = await mkdtemp(join(tmpdir(), "neuma-material-runtime-")), records: MaterialRecord[] = [];
  const options = { config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"), sessionFactory: sessions(records, work, designOverrides) };
  const agents = new PrototypeAgents(options);
  t.after(async () => { await agents.close(); await rm(root, { recursive: true, force: true }); });
  await agents.build({ id: "paper", name: "论文助手", draft: validDraft() });
  return { agents, records, options };
}

const turn = (message = "") => ({ agentId: "paper", sessionId: "materials-session-12345", message });

test("只声明对话的正式 Agent 继承公共材料工具，纯图片附件真正进入模型输入", async (t) => {
  const { agents, records } = await fixture(t);
  const png = await readFile(new URL("../public/assets/brand/neuma-mark.png", import.meta.url));
  const { attachment } = await agents.uploadAttachment("paper", { name: "图表.png", source: png });
  assert.deepEqual((await agents.get("paper"))!.toolIds!, []);
  const result = await agents.prompt({ ...turn(), attachments: [{ id: attachment.id }] });
  assert.equal(result.status, "complete");
  const { options, prompts } = records[0]!;
  assert.deepEqual(options.customTools!.map((tool: { name: unknown; }) => tool.name), ["list_materials", "read_material", "read_material_image", "web_search", "web_fetch"]);
  assert.equal(prompts[0]!.promptOptions!.images!.length, 1);
  assert.equal(prompts[0]!.promptOptions!.images![0]!.mimeType, "image/png");
  assert.ok(Buffer.from(prompts[0]!.promptOptions!.images![0]!.data, "base64").subarray(0, 8).equals(png.subarray(0, 8)));
  assert.match(prompts[0]!.text, /图表\.png/); assert.ok(prompts[0]!.text.includes(attachment.id));
  assert.doesNotMatch(prompts[0]!.text, /base64|private-thought/);
  assert.equal((await agents.files("paper")).files.length, 0);
});

test("附件归属、重复引用与十份限制在调用模型前执行", async (t) => {
  const { agents, records } = await fixture(t);
  await agents.build({ id: "other", name: "另一助手", draft: validDraft() });
  const { attachment } = await agents.uploadAttachment("other", { name: "说明.md", source: Buffer.from("# 材料") });
  await assert.rejects(agents.prompt({ ...turn("读取"), attachments: [{ id: attachment.id }] }), /没有找到/);
  await assert.rejects(agents.prompt({ ...turn("读取"), attachments: [{ id: "same" }, { id: "same" }] }), /唯一/);
  await assert.rejects(agents.prompt({ ...turn("读取"), attachments: Array.from({ length: 11 }, (_, i) => ({ id: `file-${i}` })) }), /10/);
  assert.equal(records.length, 0);
});

test("附件历史只保存引用，重建与压缩后仍可通过公共工具重读", async (t) => {
  const { agents, options } = await fixture(t);
  const { attachment } = await agents.uploadAttachment("paper", { name: "笔记.py", source: Buffer.from("# 中文说明\nprint('材料')\n") });
  const messages = [{ role: "user", content: "", attachments: [{ id: attachment.id }], revision: "1", delivery: "sent" },
    { role: "assistant", content: "已阅读笔记", revision: "1", status: "complete" }];
  await agents.saveConversationRecord("paper", "notes-chat", { schemaVersion: 4, messages, expectedVersion: 0, mutationId: "save-notes" });
  const restoredRecords: MaterialRecord[] = [], restored = new PrototypeAgents({ ...options, sessionFactory: sessions(restoredRecords) });
  t.after(() => restored.close());
  const { conversation } = await restored.getConversationRecord("paper", "notes-chat");
  assert.equal(conversation!.schemaVersion!, 4); assert.deepEqual(conversation!.messages![0]!.attachments, [{ id: attachment.id }]);
  await restored.prompt({ ...turn("继续分析"), history: conversation!.messages! });
  assert.ok(restoredRecords[0]!.prompts[0]!.text.includes(attachment.id));
  const tool = fixtureTools(restoredRecords[0]!.options.customTools).read_material!;
  const result = JSON.parse(String(toolText((await tool.execute("reread", { id: attachment.id })))));
  assert.match(result.text, /中文说明/); assert.equal(result.sourceInfo.id, attachment.id);
  await assert.rejects(restored.saveConversationRecord("paper", "notes-chat", { schemaVersion: 3,
    messages: messages.map(({ attachments, ...message }) => ({ ...message, content: message.content || "旧客户端遗漏了附件" })), expectedVersion: 1, mutationId: "old-client" }),
    (error: TestFailure) => error.reason === "conversation_schema_upgrade_required");
});

test("冻结 v1 目录的旧正式定义可运行，不改原指令或业务工具绑定", async (t) => {
  const { agents, records } = await fixture(t);
  const architecture = await agents.getArchitecture("paper"), definition = await agents.get("paper");
  delete architecture!.capabilityCatalogVersion; architecture!.capabilitySnapshot! = structuredClone(LEGACY_CAPABILITIES);
  await agents.architecture.save(architecture!);
  assert.equal(callFixture(agents.approvedDefinition, agents, [agents.agents.get("paper"), architecture]), true);
  await agents.prompt(turn("继续"));
  assert.equal((await agents.get("paper"))!.instructions!, definition!.instructions!);
  assert.deepEqual((await agents.get("paper"))!.architectureRef!, definition!.architectureRef!);
  assert.equal(records[0]!.options.customTools!.length, 5);
  agents.agents!.get("paper")!.mode = "prototype";
  await assert.rejects(agents.prompt({ ...turn("不能跳过评估"), sessionId: "old-prototype-session" }), /尚未生成/);
});

test("模型拒绝图片时报告真实失败并保留原文件，关闭后底座仍可复用", async (t) => {
  const { agents } = await fixture(t, async () => { throw new ProviderError("模型请求未完成", { stage: "model", reason: "api_error" }); });
  const png = await readFile(new URL("../public/assets/brand/neuma-mark.png", import.meta.url));
  const { attachment } = await agents.uploadAttachment("paper", { name: "图片.png", source: png });
  await assert.rejects(agents.prompt({ ...turn("分析图片"), attachments: [{ id: attachment.id }] }), /多模态/);
  const raw = await agents.attachmentRaw("paper", attachment.id); assert.deepEqual(await readFile(raw.path), png);
  await agents.close();
  const next = await agents.uploadAttachment("paper", { name: "后续.md", source: Buffer.from("后续材料") });
  assert.match((await callFixture(agents.attachmentPreview, agents, ["paper", next.attachment.id])).text, /后续材料/);
});

test("写文件工具不能覆盖已上传材料，但仍可保存独立产物", async (t) => {
  const { agents, records } = await fixture(t, undefined, { capabilities: [
    { id: "conversation", status: "available", reason: "处理用户材料" },
    { id: "write_workspace_file", status: "available", reason: "保存独立产物" },
  ] });
  const { attachment } = await agents.uploadAttachment("paper", { name: "原件.py", source: Buffer.from("print('original')") });
  await agents.prompt(turn("读取材料"));
  const writer = fixtureTools(records[0]!.options.customTools).write_workspace_file!;
  await assert.rejects(writer.execute("overwrite", { file: `inputs/${attachment.id}/${attachment.name}`, content: "modified" }), /不能覆盖/);
  const saved = await writer.execute("output", { file: "reports/analysis.md", content: "分析结果" });
  assert.equal(JSON.parse(String(toolText(saved))).saved, true);
  assert.equal(await readFile((await agents.attachmentRaw("paper", attachment.id)).path, "utf8"), "print('original')");
});

for (const action of ["remove", "close"]) test(`材料校验期间${action === "remove" ? "删除 Agent" : "关闭会话"}，不会创建迟到模型任务`, async (t) => {
  const { agents, records } = await fixture(t);
  const resolve = agents.materials.resolve.bind(agents.materials);
  let started: () => void, release: (() => void) | undefined;
  const beginning = new Promise<void>((done) => { started = done; }), waiting = new Promise<void>((done) => { release = done; });
  agents.materials.resolve = async (...args) => { started(); await waiting; return resolve(...args); };
  const task = agents.prompt(turn("准备材料"));
  const rejected = assert.rejects(task, /停止/);
  await beginning;
  const stopped = action === "remove" ? agents.remove("paper") : agents.close();
  release!(); await rejected; await stopped;
  assert.equal(records.length, 0);
  if (action === "remove") assert.equal(await agents.get("paper"), null);
});
