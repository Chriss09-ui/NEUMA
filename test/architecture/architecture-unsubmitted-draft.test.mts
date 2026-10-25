import {callFixture,recordArray,fixtureNumber} from "../helpers/m7-test-boundaries.mjs";
import {fixturePort,fixtureJsonObject,type FixtureChatMessage} from "../helpers/http-model.mjs";
import type {ArchitectureRoleOptions,ArchitectureRoleDiagnostic} from "../../src/architecture/architecture-controller-port.mjs";
import type {ToolSchema,ToolResult} from "../../src/contracts/tools.mjs";
import type {RequirementItem} from "../../src/contracts/architecture.mjs";
interface SafeDraftDiagnostic {status:string;reason:string;textBytes?:number;textLength?:number;jsonOffset?:number;issues?:{path:string;reason:string;allowedFields?:string[];requiredFields?:string[];allowedFieldsTruncated?:boolean;requiredFieldsTruncated?:boolean}[];issuesTruncated?:boolean}
interface TestDiagnostic extends ArchitectureRoleDiagnostic {unsubmittedDraftDiagnostics?:SafeDraftDiagnostic[]}
interface ModelPayload extends Record<string,unknown> {requirements:RequirementItem[];design:ReturnType<typeof validDesign>;candidateHash:string;unsubmittedDraftDiagnostic:SafeDraftDiagnostic;rejectedSubmission:{submissionHash:string};modelBudget:unknown;structuredSubmissionFeedback:string}
type ModelResponse={kind:"error"}|{kind:"tool";name:string;args:unknown}|{kind:"text";text:string;finishReason?:string};
import { fixtureChatRequest, type FixtureChatRequest } from "../helpers/http-model.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { failureFields } from "../helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchitectureUnsubmittedDraft, createArchitectureSubmissionRepair } from "../../src/architecture/architecture-submission-repair.mjs";
import { ArchitectureDesigner } from "../../src/architecture/architecture.mjs";
import { REVIEW_PROMPT } from "../../src/architecture/architecture-prompts.mjs";
import { createPiSession } from "../../src/runtime/pi-runtime.mjs";
import { InputError } from "../../src/requirements/core.mjs";
import { designSubmissionSchema, requirementItems, validateDesign, designHash, reviewSubmissionSchema, validateReview } from "../../src/architecture/architecture-contract.mjs";
import { validDraft, validDesign, passingReview } from "../helpers/architecture.mjs";
import type { NeumaPiSession } from "../../src/runtime/pi-port.mjs";
import type { ArchitectureReview } from "../../src/contracts/architecture.mjs";

const schema = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" }, data: {} } };
const make = (binding: {role:string;contextHash:string;candidateHash:string|null} = { role: "designer", contextHash: "current", candidateHash: null }) => createArchitectureUnsubmittedDraft({ schema, binding });
const assistant = (text: string, extra = {}) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text" as const, text }], ...extra });
const textContent = (content: FixtureChatMessage["content"]) => typeof content === "string" ? content : content!.filter((item) => item.type === "text").map((item) => item.text).join("\n");
const lastUser = (body:FixtureChatRequest) => fixtureJsonObject(textContent(body.messages.findLast((item) => item.role === "user")!.content)) as ModelPayload;
const lastTool = (body:FixtureChatRequest) => textContent(body.messages.findLast((item) => item.role === "tool")!.content);

test("未提交槽仅接受唯一完整JSON正文且保持独立，不覆盖语义拒稿；引用一次消费且绑定角色/上下文/候选", () => {
  const staged = make(), repair = createArchitectureSubmissionRepair({ schema });
  const rejected = repair.capture({ answer: "旧语义拒稿" });
  const text = JSON.stringify({ answer: "本轮已有草稿", data: { a: [1, true, null] } });
  const ref = staged.captureAssistant(assistant(text));
  assert.deepEqual(Object.keys(ref!), ["draftHash", "submitToolName"]); assert.equal(ref!.submitToolName, "submit_architecture_draft");
  assert.doesNotMatch(JSON.stringify(ref), /本轮已有草稿/u);
  for (const binding of [{ role: "reviewer", contextHash: "current", candidateHash: null },
    { role: "designer", contextHash: "next", candidateHash: "different" }, { role: "designer", contextHash: "current", candidateHash: null }]) {
    const other = make(binding); const otherRef = other.captureAssistant(assistant(text));
    assert.notEqual(otherRef!.draftHash, ref!.draftHash);
    assert.throws(() => other.consume({ draftHash: ref!.draftHash }), /已失效|不存在/u);
    assert.equal(other.reference(), null);
  }
  const value = staged.consume({ draftHash: ref!.draftHash }); assert.deepEqual(value, JSON.parse(text));
  objectFields(value).answer = "外部修改"; assert.equal(staged.reference(), null);
  assert.throws(() => staged.consume({ draftHash: ref!.draftHash }), /不存在/u);
  assert.deepEqual(repair.reference(), rejected);
});

test("正文围栏、噪声、缺字段、额外字段、数组、混合block、异常结束与超限均不暂存或修复", () => {
  const staged = make(), json = '{"answer":"完整"}';
  for (const message of [assistant(`说明${json}`), assistant(`\u0060\u0060\u0060json\n${json}\n\u0060\u0060\u0060`), assistant('{"answer":'), assistant('{}'),
    assistant('{"answer":false}'), assistant('{"answer":"x","unknown":1}'), assistant('[]'), assistant('null'),
    assistant('{"answer":"x","data":{"__proto__":{}}}'), assistant(JSON.stringify({ answer: "x".repeat(256 * 1024) })),
    assistant(json, { stopReason: "length" }), assistant(json, { stopReason: "error" }), assistant(json, { stopReason: "aborted" }),
    assistant(json, { content: [{ type: "text", text: json }, { type: "thinking", thinking: "private" }] }),
    assistant(json, { content: [{ type: "text", text: json }, { type: "toolCall", name: "anything" }] })]) {
    assert.equal(staged.captureAssistant(message), null); assert.equal(staged.reference(), null);
  }
  let nested = null; for (let index = 0; index < 34; index++) nested = [nested];
  assert.equal(staged.captureAssistant(assistant(JSON.stringify({ answer: "x", data: nested }))), null);
  assert.equal(staged.captureAssistant(assistant(JSON.stringify({ answer: "x", data: Array(99_999).fill(0) }))), null);
});

test("取消、混合参数、未知hash与显式清槽不能重用已暂存正文", () => {
  const staged = make(), ref = staged.captureAssistant(assistant('{"answer":"完整"}'));
  assert.throws(() => staged.consume({ draftHash: ref!.draftHash, answer: "替换" }), /已失效|不存在/u);
  assert.equal(staged.reference(), null);
  const next = staged.captureAssistant(assistant('{"answer":"完整"}')); const controller = new AbortController(); controller.abort(new Error("cancelled"));
  assert.throws(() => staged.consume({ draftHash: next!.draftHash }, { signal: controller.signal }), /cancelled/u);
  assert.throws(() => staged.captureAssistant(assistant('{"answer":"完整"}'), { signal: controller.signal }), /cancelled/u);
  staged.clear(); assert.throws(() => staged.consume({ draftHash: next!.draftHash }), /不存在/u);
});

test("未提交草稿诊断只含固定失败类型、数值尺寸与声明字段，不保存正文或解析器原始错误", () => {
  const staged = make();
  for (const [text, reason] of [['PRIVATE_RESPONSE_NOT_JSON', "invalid_json"], ['{"answer":false,"PRIVATE_KEY":"PRIVATE_VALUE"}', "schema_rejected"],
    ['["PRIVATE_VALUE"]', "not_object"], [JSON.stringify({ answer: "x".repeat(256 * 1024) }), "text_size_limit"]]) {
    assert.equal(staged.captureAssistant(assistant(text!)), null);
    const diagnostic:SafeDraftDiagnostic|null = staged.diagnostic(); assert.equal(diagnostic!.status, "ineligible"); assert.equal(diagnostic!.reason, reason);
    assert.equal(diagnostic!.textBytes, Buffer.byteLength(text!)); assert.equal(diagnostic!.textLength, text!.length);
    assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_|Unexpected|JSON at position/u);
    assert.ok(JSON.stringify(diagnostic).length <= 1024);
    if (diagnostic!.jsonOffset !== undefined) assert.ok(Number.isSafeInteger(diagnostic!.jsonOffset) && diagnostic!.jsonOffset >= 0 && diagnostic!.jsonOffset <= text!.length);
    if (diagnostic!.issues) assert.ok(diagnostic!.issues.every((issue) => Object.keys(issue).every((key) =>
      ["path", "reason", "allowedFields", "requiredFields", "allowedFieldsTruncated", "requiredFieldsTruncated"].includes(key))
      && ["submission", "submission.answer"].includes(issue.path)));
  }
  const text = '{"answer":"PRIVATE_FINAL_JSON"}';
  assert.equal(staged.captureAssistant(assistant(text), { retain: false }), null);
  assert.equal(staged.reference(), null); assert.equal(staged.diagnostic()!.reason, "schema_valid_unsubmitted");
  assert.equal(staged.diagnostic()!.status, "eligible_unsubmitted");
  assert.doesNotMatch(JSON.stringify(staged.diagnostic()), /PRIVATE_|draftHash/u);
  const copy = staged.diagnostic(); copy!.reason = "changed"; assert.equal(staged.diagnostic()!.reason, "schema_valid_unsubmitted");
});

test("schema诊断最多保留四条安全字段且整体不超过1024字符，不改变同源schema拒绝", () => {
  const properties = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`declared_${index}`, { type: "string" }]));
  const staged = createArchitectureUnsubmittedDraft({ schema: { type: "object", required: Object.keys(properties), properties, additionalProperties: false },
    binding: { role: "reviewer", contextHash: "fixed" } });
  assert.equal(staged.captureAssistant(assistant('{"PRIVATE_UNKNOWN_KEY":"PRIVATE_DATA"}')), null);
  const diagnostic:SafeDraftDiagnostic|null = staged.diagnostic(); assert.equal(diagnostic!.reason, "schema_rejected");
  assert.equal(diagnostic!.issues!.length, 4); assert.equal(diagnostic!.issuesTruncated, true);
  assert.ok(diagnostic!.issues!.every((issue) => /^submission\.declared_[0-9]+$/u.test(issue.path) && issue.reason === "required_field"));
  assert.ok(JSON.stringify(diagnostic).length <= 1024); assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_/u);
});

test("未提交诊断透传当前schema字段提示，长声明列表缩减后仍不超过原1024字符", () => {
  const properties = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`declared_${index}_${"x".repeat(60)}`, { type: "string" }]));
  const itemSchema = { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
  const staged = createArchitectureUnsubmittedDraft({ schema: { type: "object", properties: { checks: { type: "array", items: itemSchema } },
    required: ["checks"], additionalProperties: false }, binding: { role: "reviewer", contextHash: "fixed" } });
  const item = Object.fromEntries(Object.keys(properties).map((field) => [field, "PRIVATE_DECLARED_VALUE"]));
  item.PRIVATE_UNKNOWN_NAME = "PRIVATE_UNKNOWN_VALUE";
  assert.equal(staged.captureAssistant(assistant(JSON.stringify({ checks: [item] }))), null);
  const diagnostic = staged.diagnostic(), issue = diagnostic!.issues![0];
  assert.equal(issue!.path, "submission.checks[0]"); assert.equal(issue!.reason, "unknown_field");
  assert.equal(issue!.allowedFieldsTruncated, true); assert.equal(issue!.requiredFieldsTruncated, true);
  assert.ok(issue!.allowedFields!.length <= 32 && issue!.requiredFields!.length <= 32);
  assert.ok(issue!.allowedFields!.length + issue!.requiredFields!.length > 0);
  assert.ok(JSON.stringify(diagnostic).length <= 1024); assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_/u);
  assert.equal(staged.reference(), null);
});

async function actualPi(t: test.TestContext, respond:(body:FixtureChatRequest,turn:number)=>ModelResponse|Promise<ModelResponse>) {
  const root = await mkdtemp(join(tmpdir(), "neuma-unsubmitted-draft-")), requests: FixtureChatRequest[] = [], sessions: NeumaPiSession[] = [];
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")); requests.push(body); const next = await respond(body, requests.length);
      if (next.kind === "error") { response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":{"message":"fixture unavailable"}}'); return; }
      const delta = next.kind === "tool" ? { role: "assistant", tool_calls: [{ index: 0, id: `draft_${requests.length}`, type: "function",
        function: { name: next.name, arguments: JSON.stringify(next.args) } }] } : { role: "assistant", content: next.text };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "draft-fixture", object: "chat.completion.chunk", model: "fixture-model",
        choices: [{ index: 0, delta, finish_reason: next.kind === "tool" ? "tool_calls" : next.finishReason ?? "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: failureFields(error).message } })); }
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only",
    chatUrl: `http://127.0.0.1:${fixturePort(model)}/v1/chat/completions` }, cwd: root, dataDir: join(root, "data"),
    sessionFactory: async (options) => {
      const session = await createPiSession(options); sessions.push(session);
      session.setAutoCompactionEnabled(false); session.setAutoRetryEnabled(false); return session;
    } });
  await designer.ready;
  t.after(async () => { await designer.persistence; model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  return { designer, requests, sessions };
}

const roleNames:Record<string,string> = { designer: "submit_architecture", reviewer: "submit_architecture_review", specialist: "submit_module_design" };
type RoleFixtureOptions=Partial<Omit<ArchitectureRoleOptions<unknown>,"tools">> & {tools?:{name:string;label:string;description:string;parameters:ToolSchema;execute:(...args:never[])=>Promise<Pick<ToolResult,"content">>}[]};
const role = (designer: ArchitectureDesigner, roleName = "designer", options:RoleFixtureOptions = {}) => callFixture(designer.role,designer,[{ role: roleName, systemPrompt: "固定本地平台协议测试；使用本轮公开的正式工具或结构化提交通道。",
  payload: {}, onProgress() {}, submitName: roleNames[roleName]!, parameters: schema, validate: (value:unknown) => structuredClone(value), ...options }]);

test("真实Pi评审合法JSON正文单次执行同一正式校验，不再追加工具交接请求", { timeout: 15000 }, async (t) => {
  const draft = validDraft(), requirements = requirementItems(draft), candidate = validDesign(requirements), candidateHash = designHash(candidate);
  const good = passingReview(candidateHash); let validations = 0, diagnostic:TestDiagnostic|undefined;
  const f = await actualPi(t, (body, turn) => {
    assert.equal(body.tool_choice, undefined); assert.equal(turn, 1); assert.equal(validations, 0);
    assert.deepEqual(lastUser(body).modelBudget, { limit: 5, used: 0, remaining: 5 });
    return { kind: "text", text: JSON.stringify(good) };
  });
  const output = await role(f.designer, "reviewer", { systemPrompt: REVIEW_PROMPT,
    payload: { draft, requirements, design: candidate, candidateHash }, parameters: reviewSubmissionSchema(),
    validate: (value: unknown) => { validations++; return validateReview(value, { candidateHash }); },
    onDiagnostics: (value) => { diagnostic = value; } });
  assert.deepEqual(output, good); assert.equal(validations, 1); assert.equal(f.sessions.length, 1); assert.equal(f.requests.length, 1);
  assert.equal(diagnostic!.modelCalls, 1); assert.equal(diagnostic!.submissionAttempts, 1); assert.equal(diagnostic!.submissionContinuations, 0);
  assert.equal(diagnostic!.structuredSubmissions, 1); assert.equal(diagnostic!.stagedDrafts, 0); assert.equal(diagnostic!.draftSubmissions, 0);
});

test("真实Pi评审正文含checks额外字段时收到精确schema提示，第二轮主动工具提交才执行正式语义校验", { timeout: 15000 }, async (t) => {
  const draft = validDraft(), requirements = requirementItems(draft), candidate = validDesign(requirements), candidateHash = designHash(candidate);
  const good = passingReview(candidateHash), bad = structuredClone(good), parameters = reviewSubmissionSchema();
  for (const check of bad.checks) Object.assign(check,{PRIVATE_EXTRA_FIELD:"PRIVATE_VALUE"});
  let validations = 0, diagnostic:TestDiagnostic|undefined;
  const f = await actualPi(t, (body, turn: unknown) => {
    const names = body.tools!.map((tool) => tool.function.name);
    for (const name of ["read_fixture", "request_requirements", "submit_architecture_review"]) assert.ok(names.includes(name));
    assert.equal(body.tool_choice, undefined);
    assert.equal(objectFields(objectFields(objectFields(objectFields(objectFields(objectFields(objectFields(body.tools!.find((tool) => tool.function.name === "submit_architecture_review")!.function).parameters).properties).checks).items).properties).passed).type, "boolean");
    if (turn === 1) return { kind: "text", text: JSON.stringify(bad) };
    assert.equal(turn, 2); assert.equal(validations, 0);
    const reminder = lastUser(body);
    assert.equal(reminder.type, "submission_required"); assert.equal(reminder.unsubmittedDraft, undefined);
    assert.equal(reminder.unsubmittedDraftDiagnostic.reason, "schema_rejected");
    const issue = reminder.unsubmittedDraftDiagnostic.issues![0];
    assert.equal(issue!.path, "submission.checks[0]"); assert.equal(issue!.reason, "unknown_field");
    assert.deepEqual(issue!.allowedFields, ["id", "passed", "evidence"]); assert.deepEqual(issue!.requiredFields, ["id", "passed", "evidence"]);
    assert.doesNotMatch(JSON.stringify(reminder), /PRIVATE_/u);
    assert.deepEqual(reminder.modelBudget, { limit: 5, used: 1, remaining: 4 });
    return { kind: "tool", name: "submit_architecture_review", args: good };
  });
  const output = await role(f.designer, "reviewer", { payload: { draft, requirements, design: candidate, candidateHash }, parameters,
    allowHandoff: true, tools: [{ name: "read_fixture", label: "读取固定事实", description: "只读本地测试事实", parameters: {
      type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: [{ type: "text", text: '{"available":true}' }] }) }],
    validate: (value: unknown) => { validations++; return validateReview(value, { candidateHash }); },
    onDiagnostics: (value) => { diagnostic = value; } });
  assert.deepEqual(output, good); assert.equal(validations, 1); assert.equal(f.requests.length, 2);
  assert.equal(diagnostic!.modelCalls, 2); assert.equal(diagnostic!.submissionAttempts, 1); assert.equal(diagnostic!.submissionContinuations, 1);
  assert.equal(diagnostic!.stagedDrafts, 0); assert.equal(diagnostic!.draftSubmissions, 0);
  assert.equal(diagnostic!.unsubmittedDraftDiagnostics![0]!.issues![0]!.allowedFields![1], "passed");
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_/u);
});

for (const roleName of Object.keys(roleNames)) for (const wrapped of [false, true]) test(`真实Pi ${roleName}${wrapped ? "显式提交包装" : "完整参数JSON"}单次执行同一正式校验`, { timeout: 15000 }, async (t) => {
  let validated = 0, diagnostic:TestDiagnostic|undefined;
  const f = await actualPi(t, (body, turn) => {
    assert.ok(body.tools!.some((tool: { function: { name: string; }; }) => tool.function.name === "submit_architecture_draft"));
    assert.equal(body.tool_choice, undefined);
    assert.equal(turn, 1); assert.equal(validated, 0);
    assert.deepEqual(lastUser(body).modelBudget, { limit: 5, used: 0, remaining: 5 });
    const args = { answer: "完整结构化提交" };
    return { kind: "text", text: JSON.stringify(wrapped ? { submission: { name: roleNames[roleName], arguments: args } } : args) };
  });
  const output = await role(f.designer, roleName, { validate: (value) => { validated++; return value; }, onDiagnostics: (value) => { diagnostic = value; } });
  assert.deepEqual(output, { answer: "完整结构化提交" }); assert.equal(validated, 1); assert.equal(f.sessions.length, 1); assert.equal(f.requests.length, 1);
  assert.equal(diagnostic!.modelCalls, 1); assert.equal(diagnostic!.submissionAttempts, 1); assert.equal(diagnostic!.submissionContinuations, 0);
  assert.equal(diagnostic!.structuredSubmissions, 1); assert.equal(diagnostic!.stagedDrafts, 0); assert.equal(diagnostic!.draftSubmissions, 0);
  assert.doesNotMatch(JSON.stringify(diagnostic), /完整结构化提交|draftHash/u);
});

test("真实Pi结构化设计后仍新建独立评审会话，精确评审当前候选且未复用旧通过", { timeout: 15000 }, async (t) => {
  let candidate: unknown, reviewerHash;
  const f = await actualPi(t, (body, turn: unknown) => {
    const payload = lastUser(body);
    if (body.tools!.some((tool: { function: { name: string; }; }) => tool.function.name === "submit_architecture")) {
      assert.equal(turn, 1); candidate = validDesign(payload.requirements); return { kind: "text", text: JSON.stringify(candidate) };
    }
    assert.equal(turn, 2); assert.equal(payload.candidateHash, designHash(candidate)); reviewerHash = payload.candidateHash;
    assert.equal(body.messages.filter((item: { role: string; }) => item.role === "user").length, 1);
    return { kind: "text", text: JSON.stringify(passingReview(payload.candidateHash, payload.design)) };
  });
  const record = await f.designer.design({ id: "staged_chain", name: "固定平台草稿链测试", draft: validDraft(), fingerprint: "fixed-requirements" });
  assert.equal(record.status, "passed"); assert.equal(record.candidateHash, reviewerHash); assert.equal(record.review!.verdict, "pass");
  assert.equal(record.delivery, "blocked"); assert.equal(f.sessions.length, 2); assert.notEqual(f.sessions[0], f.sessions[1]);
  assert.equal(f.requests.length, 2); assert.equal(record.attempts.length, 1);
});

test("真实Pi结构化提交仍拒绝业务语义错误，下一user反馈带原CAS且修订JSON重跑同一校验", { timeout: 15000 }, async (t) => {
  const draft = validDraft(), requirements = requirementItems(draft), candidate = validDesign(requirements); candidate.steps[0]!.componentId = "missing";
  let stagedHash: null|undefined, diagnostic:TestDiagnostic|undefined;
  const f = await actualPi(t, (body, turn: unknown) => {
    if (turn === 1) return { kind: "text", text: JSON.stringify(candidate) };
    assert.equal(turn, 2); const reminder = lastUser(body), feedback = reminder.structuredSubmissionFeedback;
    assert.match(feedback, /componentId/u); assert.deepEqual(reminder.modelBudget, { limit: 5, used: 1, remaining: 4 });
    assert.equal(reminder.unsubmittedDraft, undefined);
    stagedHash = null;
    const hash = reminder.rejectedSubmission.submissionHash; assert.match(hash, /^[a-f0-9]{64}$/u); assert.notEqual(hash, stagedHash);
    return { kind: "text", text: JSON.stringify({ submission: { name: "revise_architecture_submission", arguments: {
      submissionHash: hash, updates: [{ path: "/steps/0/componentId", value: "summarize" }] } } }) };
  });
  const output = await role(f.designer, "designer", { payload: { draft, requirements }, parameters: designSubmissionSchema(draft, { requirements }),
    validate: (value: unknown) => validateDesign(value, { draft, requirements }), onDiagnostics: (value) => { diagnostic = value; } });
  assert.equal(recordArray(objectFields(output).steps)[0]!.componentId, "summarize"); assert.equal(candidate.steps[0]!.componentId, "missing");
  assert.equal(diagnostic!.submissionAttempts, 2); assert.equal(diagnostic!.localRevisions, 1); assert.equal(diagnostic!.modelCalls, 2);
  assert.equal(diagnostic!.structuredSubmissions, 2); assert.equal(f.requests.length, 2);
});

test("真实Pi结构化拒稿后的旧修订hash不能复用，仍须按本轮版本正式提交", { timeout: 15000 }, async (t) => {
  let oldHash:string|undefined;
  const f = await actualPi(t, (body, turn: unknown) => {
    if (turn === 1) return { kind: "text", text: '{"answer":"原草稿"}' };
    if (turn === 2) {
      assert.equal(lastUser(body).unsubmittedDraft, undefined);
      oldHash = lastUser(body).rejectedSubmission.submissionHash;
      return { kind: "tool", name: "revise_architecture_submission", args: { submissionHash: oldHash, updates: [{ path: "/answer", value: "仍不合法" }] } };
    }
    if (turn === 3) return { kind: "tool", name: "revise_architecture_submission", args: { submissionHash: oldHash, updates: [{ path: "/answer", value: "正式新结果" }] } };
    assert.equal(turn, 4); assert.match(lastTool(body), /已变化|无效/u);
    return { kind: "tool", name: "submit_architecture", args: { answer: "正式新结果" } };
  });
  let validations = 0;
  assert.deepEqual(await role(f.designer, "designer", { validate: (value:unknown) => {
    validations++; if (objectFields(value).answer !== "正式新结果") throw new InputError("固定业务语义拒绝"); return value;
  } }), { answer: "正式新结果" });
  assert.equal(validations, 3); assert.equal(f.requests.length, 4);
});

for (const text of ['说明{"answer":"正文"}', '```json\n{"answer":"正文"}\n```', '{"answer":false}', '{"answer":']) {
  test(`真实Pi不把噪声/不完整/结构错误正文修成正式稿（${text.slice(0, 12)}）`, { timeout: 15000 }, async (t) => {
    const f = await actualPi(t, (body, turn: number) => {
      if (turn === 1) return { kind: "text", text };
      assert.equal(lastUser(body).unsubmittedDraft, undefined);
      const diagnostic = lastUser(body).unsubmittedDraftDiagnostic;
      assert.equal(diagnostic.reason, text === '{"answer":false}' ? "schema_rejected" : "invalid_json");
      assert.equal(diagnostic.textBytes, Buffer.byteLength(text));
      assert.doesNotMatch(JSON.stringify(diagnostic), /正文|Unexpected/u);
      return { kind: "tool", name: "submit_architecture", args: { answer: "完整正式提交" } };
    });
    assert.deepEqual(await role(f.designer), { answer: "完整正式提交" });
  });
}

test("真实Pi重复语义错误的完整JSON不能通过，不增加第二次提醒或重置原预算", { timeout: 15000 }, async (t) => {
  const f = await actualPi(t, () => ({ kind: "text", text: '{"answer":"一直未主动提交"}' }));
  let validations = 0;
  await assert.rejects(role(f.designer, "designer", { validate: () => { validations++; throw new InputError("固定业务语义未通过"); } }),
    (error) => failureFields(error).diagnostic!.reason === "submission_incomplete" && failureFields(error).diagnostic!.modelCalls === 2
      && failureFields(error).diagnostic!.submissionAttempts === 2 && failureFields(error).diagnostic!.structuredSubmissions === 2
      && failureFields(error).diagnostic!.submissionContinuations === 1 && failureFields(error).diagnostic!.stagedDrafts === 0 && failureFields(error).diagnostic!.draftSubmissions === 0);
  assert.equal(validations, 2);
  assert.equal(f.requests.length, 2);
});

test("真实Pi首次坏正文给安全解析原因，末轮完整结构化JSON正式校验且诊断不泄露正文", { timeout: 15000 }, async (t) => {
  const first = 'PRIVATE_BAD_RESPONSE {"answer":', final = '{"answer":"PRIVATE_FINAL_RESPONSE"}'; let persisted:TestDiagnostic|undefined;
  const f = await actualPi(t, (body, turn: unknown) => {
    if (turn === 1) return { kind: "text", text: first };
    assert.equal(turn, 2); const reminder = lastUser(body);
    assert.equal(reminder.type, "submission_required"); assert.equal(reminder.unsubmittedDraft, undefined);
    assert.equal(reminder.unsubmittedDraftDiagnostic.reason, "invalid_json");
    assert.deepEqual(reminder.modelBudget, { limit: 5, used: 1, remaining: 4 });
    assert.doesNotMatch(JSON.stringify(reminder), /PRIVATE_|Unexpected/u);
    return { kind: "text", text: final };
  });
  assert.deepEqual(await role(f.designer, "reviewer", { onDiagnostics: (value) => { persisted = value; } }), JSON.parse(final));
  assert.equal(persisted!.modelCalls, 2); assert.equal(persisted!.submissionContinuations, 1); assert.equal(persisted!.submissionAttempts, 1);
  assert.equal(persisted!.structuredSubmissions, 1); assert.equal(persisted!.stagedDrafts, 0); assert.equal(persisted!.draftSubmissions, 0);
  assert.deepEqual(persisted!.unsubmittedDraftDiagnostics!.map((item) => item.reason), ["invalid_json"]);
  assert.equal(persisted!.unsubmittedDraftDiagnostics![0]!.textBytes, Buffer.byteLength(first));
  assert.doesNotMatch(JSON.stringify(persisted), /PRIVATE_|draftHash|Unexpected/u);
  assert.ok(JSON.stringify(persisted!.unsubmittedDraftDiagnostics).length <= 1025);
  assert.equal(persisted!.status, "submitted"); assert.equal(persisted!.unsubmittedDraftDiagnostics!.length, 1);
  assert.equal(f.requests.length, 2); assert.equal(f.sessions.length, 1);
});

for (const fault of ["length", "error", "cancelled"]) test(`真实Pi完整JSON遇${fault}不生成草稿恢复入口`, { timeout: 15000 }, async (t) => {
  const controller = new AbortController();
  const f = await actualPi(t, () => {
    if (fault === "cancelled") controller.abort(new Error("fixture cancelled"));
    return fault === "error" ? { kind: "error" } : { kind: "text", text: '{"answer":"不是有效恢复时机"}', finishReason: fault === "length" ? "length" : "stop" };
  });
  await assert.rejects(role(f.designer, "designer", { signal: controller.signal }), (error) => failureFields(error).diagnostic!.reason === (fault === "length" ? "output_limit"
    : fault === "error" ? "api_unavailable" : "cancelled") && failureFields(error).diagnostic!.stagedDrafts === 0 && failureFields(error).diagnostic!.submissionContinuations === 0
    && failureFields(error).diagnostic!.unsubmittedDraftDiagnostics === undefined);
  assert.equal(f.requests.length, 1);
});

test("真实Pi取消发生在结构化包装执行前仍不能进入正式校验", { timeout: 15000 }, async (t) => {
  const controller = new AbortController(); let validated = 0;
  const f = await actualPi(t, (body, turn: unknown) => {
    if (turn === 1) return { kind: "text", text: '{"answer":false}' };
    assert.equal(turn, 2); assert.equal(lastUser(body).unsubmittedDraft, undefined); controller.abort(new Error("fixture cancelled"));
    return { kind: "text", text: JSON.stringify({ submission: { name: "submit_architecture", arguments: { answer: "待提交" } } }) };
  });
  await assert.rejects(role(f.designer, "designer", { signal: controller.signal, validate: () => { validated++; return {}; } }),
    (error) => failureFields(error).diagnostic!.reason === "cancelled" && failureFields(error).diagnostic!.draftSubmissions === 0);
  assert.equal(validated, 0); assert.equal(f.requests.length, 2);
});

test("当前prompt没有新增assistant时不得误用历史JSON末条", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-stale-assistant-")); let prompts = 0;
  const old = assistant('{"answer":"历史正文"}');
  const designer = new ArchitectureDesigner({ config: {}, cwd: root, dataDir: join(root, "data"), sessionFactory: async () => ({
    messages: [old], prompt: async () => { prompts++; }, subscribe: () => () => {}, abort: async () => {}, dispose() {},
  }) });
  await designer.ready; t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(role(designer), (error) => failureFields(error).diagnostic!.reason === "submission_incomplete" && failureFields(error).diagnostic!.stagedDrafts === 0);
  assert.equal(prompts, 1);
});
