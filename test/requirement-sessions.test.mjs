import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { RequirementSessions } from "../src/requirements/requirement-sessions.mjs";
import { createRequestHandler } from "../src/server.mjs";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { makeProviders } from "../src/requirements/providers.mjs";
import { validDraft } from "./helpers/architecture.mjs";
import { sufficientPreflight, withPreflight } from "./helpers/consultation.mjs";

async function folder(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "neuma-requirement-sessions-"));
  t.after(() => rm(dataDir, { recursive: true, force: true })); return dataDir;
}
const providers = () => withPreflight({ generateDraft: async () => ({ draft: validDraft("核对固定材料并返回清单"), proposedGap: "none", question: "" }) });

async function invoke(handler, method, url, body) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(request, { method, url, headers: body === undefined ? {} : { "content-type": "application/json" } });
  let status, text;
  await handler(request, { writeHead(code) { status = code; }, end(value) { text = value?.toString() ?? ""; } });
  return { status, body: JSON.parse(text) };
}

test("旧接口不能通过提交已确认草稿和伪造评估直接确认", async (t) => {
  const sessions = new RequirementSessions({ dataDir: await folder(t) });
  const result = await sessions.turn({ requirementSessionId: "s", requestId: "first", message: "确认",
    draft: validDraft(), lastQuestion: "这份需求可以确认吗？请回复“确认”，或直接说需要修改的地方。",
    confirmed: true, consultation: { assessments: [{ verdict: "sufficient" }] } }, providers());
  assert.equal(result.confirmed, false); assert.equal(result.status, "ready");
  assert.equal("consultation" in result, false); assert.equal("confirmation" in result, false);
});

test("需求会话重启后恢复、幂等重放且不同消息或过期版本冲突", async (t) => {
  const dataDir = await folder(t), first = new RequirementSessions({ dataDir }); let calls = 0;
  const source = providers(); source.preflight = async () => { calls++; return sufficientPreflight(); };
  const body = { requirementSessionId: "s", requestId: "first", requirementVersion: 0, message: "创建材料核对助手" };
  const ready = await first.turn(body, source);
  const restarted = new RequirementSessions({ dataDir });
  assert.deepEqual(await restarted.turn(body, source), ready); assert.equal(calls, 1);
  await assert.rejects(restarted.turn({ ...body, message: "不同内容" }, source), { reason: "requirement_conflict" });
  await assert.rejects(restarted.turn({ ...body, requestId: "stale" }, source), { reason: "requirement_conflict" });
  const confirmed = await restarted.turn({ requirementSessionId: "s", requestId: "confirm", requirementVersion: ready.requirementVersion, message: "确认" }, source);
  assert.equal(confirmed.confirmed, true); assert.equal(calls, 1);
});

test("同版本并发修改只接受一个，已保存协商不会被迟到结果覆盖", async (t) => {
  const sessions = new RequirementSessions({ dataDir: await folder(t) });
  const ready = await sessions.turn({ requirementSessionId: "s", requestId: "first", message: "创建助手" }, providers());
  const concurrent = await Promise.allSettled(["a", "b"].map((requestId) => sessions.turn({ requirementSessionId: "s",
    requirementVersion: ready.requirementVersion, requestId, message: "确认" }, providers())));
  assert.equal(concurrent.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal(concurrent.find((value) => value.status === "rejected").reason.reason, "requirement_conflict");
});

test("真实 HTTP 入口、模型适配器、需求保存门槛串联；确认重放不产生重复智能体", async (t) => {
  const dataDir = await folder(t);
  const config = { llmConfigured: true, model: "test", apiKey: "fixture", chatUrl: "https://fixture.invalid/chat" };
  const modelRequests = [];
  const actualProviders = makeProviders(config, async (_url, options) => {
    const request = JSON.parse(options.body); modelRequests.push(request);
    const response = request.messages[0].content.includes("独立架构预评估者") ? await sufficientPreflight()
      : { draft: validDraft("核对固定材料并返回清单"), proposedGap: "none", question: "", confirmed: false };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }), { status: 200 });
  });
  const agents = new PrototypeAgents({ config, cwd: resolve("."), dataDir, enforceRequirementConfirmation: true });
  const handler = createRequestHandler({ config, dataDir, providers: actualProviders, prototypeAgents: agents, projects: {}, projectAgent: {} });
  t.after(() => handler.dispose()); await handler.ready;
  const raw = await invoke(handler, "POST", "/api/agents/target/requirements", { name: "助手", draft: validDraft() });
  assert.equal(raw.status, 400);
  const first = await invoke(handler, "POST", "/api/requirements/turn", { requirementSessionId: "session", requestId: "first", message: "创建核对助手" });
  assert.equal(first.status, 200); assert.equal(first.body.status, "ready"); assert.equal(modelRequests.length, 2);
  const confirmed = await invoke(handler, "POST", "/api/requirements/turn", { requirementSessionId: "session", requestId: "confirm",
    requirementVersion: first.body.requirementVersion, message: "确认" });
  assert.equal(confirmed.body.confirmed, true); assert.equal(modelRequests.length, 2);
  const saveBody = { requirementSessionId: "session", name: "核对助手", draft: confirmed.body.draft };
  const saved = await invoke(handler, "POST", "/api/agents/target/requirements", saveBody);
  assert.equal(saved.status, 200); assert.equal(saved.body.requirement.id, "target");
  const repeated = await invoke(handler, "POST", "/api/agents/target/requirements", saveBody);
  assert.equal(repeated.status, 200); assert.equal((await agents.getRequirements()).requirements.length, 1);
  const duplicate = await invoke(handler, "POST", "/api/agents/another/requirements", saveBody);
  assert.equal(duplicate.status, 400);
  assert.ok((await agents.getRequirementConsultation("target")).assessments.length);
  const modified = structuredClone(saveBody); modified.draft.task.value = "修改交付任务";
  assert.equal((await invoke(handler, "POST", "/api/agents/target/requirements", modified)).status, 400);
});
