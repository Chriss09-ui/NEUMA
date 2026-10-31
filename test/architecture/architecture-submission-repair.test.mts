interface ModelPayload extends Record<string,unknown> {requirements:RequirementItem[];design:ReturnType<typeof validDesign>;candidateHash:string;editableSubmission:{submissionHash:string;baseCandidateHash:string;source:string;trust:string};priorFindings:NonNullable<Parameters<typeof passingReview>[2]>;previousDesign:ReturnType<typeof validDesign>;remaining:{revisions:number}}
import {fixtureTools,callFixture,recordArray} from "../helpers/m7-test-boundaries.mjs";
import {fixturePort,fixtureText,fixtureJsonObject,type FixtureChatRequest} from "../helpers/http-model.mjs";
import type {ArchitectureDesign} from "../../src/contracts/architecture.mjs";
import type {RequirementDraft} from "../../src/contracts/requirements.mjs";
import type {ArchitectureRoleOptions,ArchitectureRoleDiagnostic} from "../../src/architecture/architecture-controller-port.mjs";
interface TestDraft {name:string;checks:{id:string;target:string}[];meta:Record<string,unknown>;opaque:unknown}
function draftFields(value:unknown):TestDraft {assert.ok(value&&typeof value==="object"&&typeof Reflect.get(value,"name")==="string"&&Array.isArray(Reflect.get(value,"checks")));return value as TestDraft;}
import { fixtureChatRequest } from "../helpers/http-model.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import type { PiSessionOptions } from "../../src/runtime/pi-port.mjs";
import { failureFields } from "../helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArchitectureSubmissionRepair } from "../../src/architecture/architecture-submission-repair.mjs";
import { runRepairAgent } from "../../src/runtime/repair-agent.mjs";
import { createRepairCheckpoint, runRepairSchedule } from "../../src/runtime/repair-scheduler.mjs";
import { architectureToolValidation } from "../../src/architecture/architecture-tool-diagnostics.mjs";
import { ArchitectureDesigner } from "../../src/architecture/architecture.mjs";
import { designSubmissionSchema, requirementItems, validateDesign, reviewSubmissionSchema, validateReview, designHash } from "../../src/architecture/architecture-contract.mjs";
import { architectureReviewEvidenceContext } from "../../src/architecture/architecture-review-evidence.mjs";
import { createPiSession } from "../../src/runtime/pi-runtime.mjs";
import { createArchitectureStageSchemas, validateArchitectureModule } from "../../src/architecture/architecture-design-stages.mjs";
import type { ArchitectureBlueprint, ArchitectureModule } from "../../src/contracts/architecture-stages.mjs";
import { createPlatformContractTool } from "../../src/architecture/architecture-platform-claims.mjs";
import { runtimeCapabilityContract } from "../../src/runtime/runtime-capability-contract.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../../src/verification/acceptance-contract.mjs";
import { validDraft, validDesign, passingReview } from "../helpers/architecture.mjs";
import type { RequirementItem } from "../../src/contracts/architecture.mjs";
import type { ArchitectureBase } from "../../src/contracts/architecture.mjs";
import type { RegisteredTool } from "../../src/runtime/pi-port.mjs";
import type { ArchitectureReview } from "../../src/contracts/architecture.mjs";

const schema = { type: "object", additionalProperties: false, required: ["name", "checks", "meta", "opaque"], properties: {
  name: { type: "string" }, optional: { type: "string" },
  checks: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "target"], properties: {
    id: { type: "string" }, target: { type: "string" },
  } } }, meta: { type: "object", properties: { "a/b": { type: "boolean" }, "a~b": { type: "integer" } }, additionalProperties: false }, opaque: {},
} };
const value = ():TestDraft => ({ name: "完整草稿", checks: [{ id: "one", target: "wrong" }, { id: "two", target: "wrong" }],
  meta: { "a/b": false, "a~b": 1 }, opaque: { arbitrary: "whole-field replacement only" } });
const setup = () => { const repair = createArchitectureSubmissionRepair({ schema }); return { repair, ...repair.capture(value()) }; };

test("捕获只保存完整严格结构合格的当前会话草稿，引用不回显正文且失败不覆盖旧稿", () => {
  const repair = createArchitectureSubmissionRepair({ schema }); assert.equal(repair.reference(), null);
  assert.throws(() => repair.apply({ submissionHash: "a".repeat(64), updates: [] }), /尚无可修订/u);
  const original = value(), before = structuredClone(original), reference = repair.capture(original);
  assert.match(reference!.submissionHash, /^[a-f0-9]{64}$/u); assert.deepEqual(Object.keys(reference!), ["submissionHash"]);
  assert.deepEqual(original, before); original.name = "外部后来修改";
  const bad = value(); bad.meta["a/b"] = "false";
  assert.throws(() => repair.capture(bad), (error) => failureFields(error).validationIssue!.reason === "invalid_type");
  assert.equal(bad.meta["a/b"], "false"); assert.deepEqual(repair.reference(), reference);
  assert.equal(draftFields(repair.apply({ ...reference, updates: [{ path: "/checks/0/target", value: "one" }] }))!.name, "完整草稿");
});

test("多处局部替换只返回完整新克隆，显式再次捕获后才推进CAS，跨会话旧引用失效", () => {
  const { repair, submissionHash } = setup();
  const updates = [{ path: "/checks/0/target", value: "one" }, { path: "/checks/1/target", value: "two" },
    { path: "/meta/a~1b", value: true }, { path: "/meta/a~0b", value: 2 }];
  const before = structuredClone(updates), candidate = draftFields(repair.apply({ submissionHash, updates }));
  assert.deepEqual(updates, before); assert.equal(candidate!.checks[0]!.target, "one"); assert.equal(candidate!.checks[1]!.target, "two");
  assert.equal(candidate!.meta["a/b"], true); assert.equal(candidate!.meta["a~b"], 2); assert.equal(repair.reference()!.submissionHash, submissionHash);
  candidate!.name = "returned clone only";
  assert.equal(draftFields(repair.apply({ submissionHash, updates: [{ path: "/name", value: "new" }] }))!.checks[0]!.target, "wrong");
  const next = repair.capture(candidate); assert.notEqual(next!.submissionHash, submissionHash);
  assert.deepEqual(repair.capture(candidate), next);
  assert.throws(() => repair.apply({ submissionHash, updates }), /草稿版本已变化/u);
  const another = createArchitectureSubmissionRepair({ schema }); another.capture(candidate);
  assert.throws(() => another.apply({ submissionHash: next!.submissionHash, updates }), /草稿版本已变化/u);
});

test("整数组和自由对象可替换，但不在声明内的自由对象子路径、缺失字段和越界不能猜补", () => {
  const { repair, submissionHash } = setup();
  const candidate = draftFields(repair.apply({ submissionHash, updates: [{ path: "/checks", value: [{ id: "three", target: "three" }] },
    { path: "/opaque", value: { replaced: [null, true, 7, "new"] } }] }));
  assert.deepEqual(candidate!.checks, [{ id: "three", target: "three" }]);
  assert.deepEqual(candidate!.opaque, { replaced: [null, true, 7, "new"] });
  for (const path of ["", "/optional", "/new", "/checks/2/target", "/checks/-1/target", "/checks/01/target", "/checks/-", "/opaque/arbitrary",
    "/__proto__/x", "/meta/constructor", "/meta/a~2b", "/PRIVATE_BAD_PATH"]) {
    assert.throws(() => repair.apply({ submissionHash, updates: [{ path, value: "PRIVATE_BAD_VALUE" }] }), (error) =>
      failureFields(error).validationIssue!.reason === "invalid_reference" && !/PRIVATE_BAD_PATH|PRIVATE_BAD_VALUE/u.test(failureFields(error).message!));
  }
});

test("同层重复、父子重叠、额外操作字段和超过24条均拒绝，不改变当前稿", () => {
  const { repair, submissionHash } = setup();
  for (const updates of [[], [{ path: "/checks", value: [] }, { path: "/checks/0/target", value: "x" }],
    [{ path: "/checks/0/target", value: "x" }, { path: "/checks", value: [] }],
    [{ path: "/name", value: "x" }, { path: "/name", value: "y" }],
    [{ path: "/name", value: "x", delete: true }], Array.from({ length: 25 }, () => ({ path: "/name", value: "x" }))])
    assert.throws(() => repair.apply({ submissionHash, updates }));
  assert.equal(repair.reference()!.submissionHash, submissionHash);
  assert.equal(draftFields(repair.apply({ submissionHash, updates: [{ path: "/name", value: "only this field" }] }))!.checks.length, 2);
});

test("schema联合声明字段可定位；替换后的错误类型仍留给原完整schema拒绝且不成为新草稿", () => {
  const union = { type: "object", properties: { value: { anyOf: [
    { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
    { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
  ] } }, required: ["value"] };
  const repair = createArchitectureSubmissionRepair({ schema: union }), reference = repair.capture({ value: { a: "before" } });
  assert.deepEqual(repair.apply({ ...reference, updates: [{ path: "/value/a", value: "after" }] }), { value: { a: "after" } });
  const bad = repair.apply({ ...reference, updates: [{ path: "/value/a", value: false }] });
  assert.equal(architectureToolValidation(bad, union).valid, false);
  assert.throws(() => repair.capture(bad)); assert.deepEqual(repair.reference(), reference);
});

test("非JSON、原型、访问器、隐藏和符号字段、代理与循环拒绝且不执行getter", () => {
  const free = createArchitectureSubmissionRepair({ schema: { type: "object", properties: { data: {} }, required: ["data"] } });
  let touched = 0;
  const getter = Object.defineProperty({}, "data", { get() { touched++; return 1; }, enumerable: true });
  const hidden = Object.defineProperty({ data: 1 }, "hidden", { value: 1 });
  const cyclic:{data?:unknown}={};cyclic.data=cyclic;
  const sparse:unknown[]=[]; sparse.length = 2;
  const extra:[number]&{extra?:boolean}=[1];extra.extra=true;
  const falseIndex = new Array(1); falseIndex["4294967295"] = true;
  const proxy = new Proxy({}, { getPrototypeOf() { touched++; throw new Error("PRIVATE_PROXY_MESSAGE"); } });
  for (const invalid of [getter, hidden, { data: 1, [Symbol("private")]: 2 }, cyclic, { data: sparse }, { data: extra }, { data: falseIndex },
    Object.assign(Object.create({ inherited: 1 }), { data: 1 }), { data: NaN }, { data: Infinity }, { data: undefined },
    { data: 1n }, { data() {} }, { data: proxy }, JSON.parse('{"data":{"__proto__":{}}}')])
    assert.throws(() => free.capture(invalid), (error) => !failureFields(error).message!.includes("PRIVATE_PROXY_MESSAGE"));
  assert.equal(touched, 0); assert.equal(free.reference(), null);
  const reference = free.capture({ data: 1 });
  assert.throws(() => free.apply({ ...reference, updates: [{ path: "/data", value: getter }] }));
  assert.equal(touched, 0);
});

test("完整稿和更新共用256KiB JSON字节、32层及100000节点边界", () => {
  const make = () => createArchitectureSubmissionRepair({ schema: { type: "object", properties: { data: {} }, required: ["data"] } });
  const repair = make(), overhead = Buffer.byteLength(JSON.stringify({ data: "" }));
  const reference = repair.capture({ data: "a".repeat(256 * 1024 - overhead) });
  assert.throws(() => repair.capture({ data: "a".repeat(256 * 1024 - overhead + 1) }), (error) => failureFields(error).validationIssue!.reason === "size_limit");
  assert.deepEqual(repair.reference(), reference);
  assert.throws(() => repair.apply({ ...reference, updates: [{ path: "/data", value: "中".repeat(100_000) }] }), /字节额度/u);
  const nested = (depth: number) => { let value:unknown=0; for (let index = 0; index < depth; index++) value = { child: value }; return { data: value }; };
  make().capture(nested(31)); assert.throws(() => make().capture(nested(32)), /32层/u);
  make().capture({ data: Array(99_998).fill(0) });
  assert.throws(() => make().capture({ data: Array(99_999).fill(0) }), /100000节点/u);
});

test("公开工具仅接收现版本CAS与局部替换，取消不创建或改变状态", () => {
  const { repair, submissionHash } = setup(), validate = new Ajv({ strict: false }).compile(repair.parameters);
  assert.equal(validate({ submissionHash, updates: [{ path: "/opaque", value: { arbitrary: [false, null] } }] }), true);
  for (const params of [{ submissionHash, updates: [] }, { submissionHash, updates: [{ path: "/name", value: "x", delete: true }] },
    { submissionHash, updates: [{ path: "/name" }] }, { submissionHash, updates: [{ path: "/name", value: "x" }], extra: true }]) assert.equal(validate(params), false);
  const controller = new AbortController(); controller.abort(new Error("fixture cancelled"));
  assert.throws(() => repair.capture(value(), { signal: controller.signal }), /fixture cancelled/u);
  assert.throws(() => repair.apply({ submissionHash, updates: [{ path: "/name", value: "x" }] }, { signal: controller.signal }), /fixture cancelled/u);
  assert.equal(repair.reference()!.submissionHash, submissionHash);
});

async function actualPi(t:test.TestContext,respond:(body:FixtureChatRequest,turn:number)=>{name:string;args:unknown}|null|Promise<{name:string;args:unknown}|null>) {
  const root = await mkdtemp(join(tmpdir(), "neuma-submission-repair-sdk-")), requests:FixtureChatRequest[] = [], tools: (RegisteredTool[]|undefined)[] = [];
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = fixtureChatRequest(Buffer.concat(chunks).toString("utf8")); requests.push(body);
      const call = await respond(body, requests.length);
      if (!call) { response.end(); return; }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ id: "repair-fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0,
        delta: { role: "assistant", tool_calls: [{ index: 0, id: `repair_${requests.length}`, type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: "tool_calls" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: failureFields(error).message } })); }
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true, model: "fixture-model", apiKey: "fixture-only",
    chatUrl: `http://127.0.0.1:${fixturePort(model)}/v1/chat/completions` }, cwd: root, dataDir: join(root, "data"),
    sessionFactory: async (options: PiSessionOptions) => {
      tools.push(options.customTools);
      const session = await createPiSession(options); session.setAutoCompactionEnabled(false); session.setAutoRetryEnabled(false); return session;
    } });
  t.after(async () => { await designer.ready; await designer.persistence; model.closeAllConnections(); await new Promise<void>((resolve,reject)=>model.close(error=>error?reject(error):resolve())); await rm(root, { recursive: true, force: true }); });
  await designer.ready;
  return { designer, requests, tools };
}

const feedbackText = (body:FixtureChatRequest) => {
  const content = body.messages.findLast((item) => item.role === "tool")!.content;
  return typeof content === "string" ? content : content!.filter((item) => item.type === "text").map((item) => item.text).join("\n");
};
const requestPayload = (body:FixtureChatRequest):ModelPayload => {
  const content = body.messages.findLast((item) => item.role === "user")!.content;
  return JSON.parse(typeof content === "string" ? content : content!.filter((item) => item.type === "text").map((item) => item.text).join("\n"));
};
const editableOptions = (draft:RequirementDraft, requirements: RequirementItem[], design: ArchitectureBase) => ({ editableDesign: design,
  payload: { draft, requirements, candidateSchema: designSubmissionSchema(draft, { requirements }), previousDesign: design } });
const rejectedHash = (text: string) => {
  const match = text.match(/"rejectedSubmission":\{"submissionHash":"([a-f0-9]{64})"\}/u);
  assert.ok(match, "宿主必须只回传已拒绝稿的CAS编号"); return match[1];
};
function designerRole(designer:ArchitectureDesigner,draft:RequirementDraft,requirements:RequirementItem[],options:Partial<Omit<ArchitectureRoleOptions<ArchitectureDesign>,"allowHandoff">> & {allowHandoff?:false}={}) {
  return designer.role({ role: "designer", systemPrompt: "固定平台SDK协议测试，只按本地响应调用提交工具。", onProgress() {},
    payload: { requirements, draft, candidateSchema: designSubmissionSchema(draft, { requirements }) },
    submitName: "submit_architecture", parameters: designSubmissionSchema(draft, { requirements }),
    validate: (candidate: unknown) => validateDesign(candidate, { draft, requirements }), ...options });
}

function stageRepairFixture() {
  const draft = validDraft(), requirements = requirementItems(draft), candidate = validDesign(requirements);
  const { components, steps, capabilities, failureHandling, decisions, coverage, acceptance, unknowns, ...global } = candidate;
  const blueprint: ArchitectureBlueprint = { global, modules: [{ id: "input_contract", purpose: "核对本模块输入", requirementIds: requirements.map(item => item.id), dependsOn: [], inputs: "已确认输入", outputs: "已确认结果" }] };
  const previous: ArchitectureModule = { moduleId: "input_contract", blueprintHash: designHash(blueprint), instructions: candidate.instructions,
    components, steps, capabilities, failureHandling, decisions, coverage, acceptance, unknowns };
  previous.capabilities[0]!.id = "invented_conversation";
  blueprint.global.instructions += " 复核后的当前蓝图。";
  const candidateSchema = designSubmissionSchema(draft, { requirements }), context = { candidateSchema, requirements, blueprint,
    assignment: blueprint.modules[0]!, runtimeCapabilities: runtimeCapabilityContract(), acceptanceAdapterGuide: ACCEPTANCE_ADAPTER_GUIDE };
  const parameters = createArchitectureStageSchemas(context).module;
  return { previous, context, parameters };
}

test("动态修复实际请求内联本组原文，批读使用同源游标且末轮只声明提交", { timeout: 15000 }, async t => {
  const base = { instructions: "保留原始记录" }, binding = { task: "prepared-repair" };
  let checkpoint = createRepairCheckpoint(binding, base, [{ id: "boundary", owner: "instructions", paths: ["/instructions"],
    description: "补充缺失边界", remedy: "保留原文并明确缺失项" }], 3);
  const f = await actualPi(t, (body, turn) => {
    const payload = requestPayload(body), assignment = objectFields(payload.repairAssignment);
    assert.equal(objectFields(objectFields(payload.preparedContext).baseFields)["/instructions"], base.instructions);
    if (turn < 3) return { name: "read_repair_context", args: { requests: [{ section: "base", pointer: "/instructions" }] } };
    assert.deepEqual(body.tools!.map(tool => tool.function.name), ["submit_repair_patch"]);
    assert.match(feedbackText(body), /nextRequest/u);
    return { name: "submit_repair_patch", args: { baseHash: assignment.baseHash, issueIds: ["boundary"], summary: "保留事实与缺失提示",
      updates: [{ path: "/instructions", value: base.instructions + "，缺失项明确标注。" }] } };
  });
  const result = await runRepairSchedule({ checkpoint, binding, base, save: async value => { checkpoint = value; }, run: worker => runRepairAgent({
    worker, binding, context: { requirements: [{ id: "req", text: "原始记录不丢失" }] }, config: f.designer.config,
    cwd: f.designer.cwd, dataDir: f.designer.dataDir, sessionDirectory: join(f.designer.cwd, "repair-sessions"),
    sessionFactory: f.designer.sessionFactory, maxOutputTokens: 4096,
  }) });
  assert.deepEqual(result, { instructions: "保留原始记录，缺失项明确标注。" });
  assert.equal(checkpoint.calls, 3); assert.equal(f.requests.length, 3);
});

for (const remaining of [1, 2]) test(`真实修复剩${remaining}轮时预置事实与可编辑基底，末轮请求不再声明读取工具`, { timeout: 15000 }, async t => {
  const { previous, context, parameters } = stageRepairFixture(), before = structuredClone(previous);
  let charges = 0;
  const f = await actualPi(t, (body, turn) => {
    const payload = requestPayload(body), preparation = objectFields(payload.repairPreparation);
    assert.equal(preparation.ready, true);
    assert.deepEqual(objectFields(preparation.material).runtimeCapabilities, context.runtimeCapabilities);
    assert.deepEqual(objectFields(preparation.material).acceptanceAdapterGuide, context.acceptanceAdapterGuide);
    assert.deepEqual(objectFields(payload.validationRepair).previousResult, before);
    assert.equal(payload.editableSubmission.source, "historical-stage-repair");
    const names = body.tools!.map(tool => tool.function.name);
    if (remaining === 2 && turn === 1) {
      assert.ok(names.includes("read_model_context"));
      return { name: "read_model_context", args: { requests: [{ section: "runtimeCapabilities", pointer: "/valueSchemas" }] } };
    }
    assert.deepEqual(names.sort(), ["revise_architecture_submission", "submit_architecture_module"]);
    return { name: "revise_architecture_submission", args: { submissionHash: payload.editableSubmission.submissionHash,
      updates: [{ path: "/capabilities/0/id", value: "conversation" }] } };
  });
  const result = await f.designer.role({ role: "specialist", systemPrompt: "固定修复规程", submitName: "submit_architecture_module", parameters,
    initialModelCalls: 5 - remaining, modelCallLimit: 5, onStageModelCall: async () => { charges++; },
    payload: { ...context, pipelineStage: "module", blueprintHash: designHash(context.blueprint),
      validationRepair: { previousResult: previous, issues: [{ path: "module.capabilities[0].id", reason: "invalid_reference" }] } },
    tools: [createPlatformContractTool(context)], validate: value => validateArchitectureModule(value, context) });
  assert.deepEqual(result, { ...before, blueprintHash: designHash(context.blueprint), capabilities: [{ ...before.capabilities[0]!, id: "conversation" }, ...before.capabilities.slice(1)] });
  assert.deepEqual(previous, before); assert.equal(f.requests.length, remaining); assert.equal(charges, remaining);
});

test("最后一轮所需事实过大时在请求前阻断，不隐瞒分页缺口或消耗额度", async t => {
  const { previous, context, parameters } = stageRepairFixture();
  const f = await actualPi(t, () => { assert.fail("资料缺口不得消耗最后一次模型调用"); });
  let charges = 0;
  await assert.rejects(f.designer.role({ role: "specialist", systemPrompt: "固定修复规程", submitName: "submit_architecture_module", parameters,
    initialModelCalls: 4, modelCallLimit: 5, onStageModelCall: async () => { charges++; },
    payload: { ...context, acceptanceAdapterGuide: { ...ACCEPTANCE_ADAPTER_GUIDE, large: "x".repeat(70_000) }, pipelineStage: "module", validationRepair: { previousResult: previous } },
    validate: value => validateArchitectureModule(value, context) }), (error: unknown) => objectFields(objectFields(error).diagnostic).reason === "repair_materials_incomplete");
  assert.equal(charges, 0); assert.equal(f.requests.length, 0);
});

test("真实Pi宿主合法基底首轮只发局部正式提交，原文逐字保留且不冒充旧稿已通过", { timeout: 15000 }, async (t) => {
  const draft = validDraft(), requirements = requirementItems(draft), original = validDesign(requirements);
  original.instructions = "保留这段完整工作指令。".repeat(1000);
  const before = structuredClone(original), expected = { ...before, rationale: "本轮只修改必要的选型说明" };
  let reference:Record<string,unknown>|undefined,diagnostic:ArchitectureRoleDiagnostic|undefined;
  const f = await actualPi(t, (body, turn: unknown) => {
    assert.equal(turn, 1);
    const payload = requestPayload(body); reference = payload.editableSubmission;
    assert.deepEqual(payload.previousDesign, before);
    assert.equal(reference!.baseCandidateHash, designHash(before)); assert.equal(reference!.source, "previousDesign");
    assert.equal(reference!.trust, "untrusted-reference"); assert.equal(payload.rejectedSubmission, undefined);
    assert.equal(payload.submitted, undefined); assert.equal(payload.accepted, undefined);
    const args = { submissionHash: reference!.submissionHash, updates: [{ path: "/rationale", value: expected.rationale }] };
    assert.ok(Buffer.byteLength(JSON.stringify(args)) < 512);
    return { name: "revise_architecture_submission", args };
  });
  const result = await designerRole(f.designer, draft, requirements, { ...editableOptions(draft, requirements, original),
    onDiagnostics: (value) => { diagnostic = value; } });
  assert.deepEqual(result, expected); assert.deepEqual(original, before);
  assert.equal(f.requests.length, 1); assert.equal(diagnostic!.submissionAttempts, 1); assert.equal(diagnostic!.localRevisions, 1);
  assert.equal(diagnostic!.modelCalls, 1); assert.equal(diagnostic!.rejectedSubmission, undefined);
  assert.equal(objectFields(diagnostic!.editableSubmission).baseCandidateHash, designHash(before));
  const revise = f.tools[0]!.find((tool) => tool.name === "revise_architecture_submission");
  await assert.rejects(fixtureTools([revise!])[revise!.name]!.execute("late", { submissionHash: reference!.submissionHash,
    updates: [{ path: "/rationale", value: "迟到改动" }] }), /已经提交/u);
});

test("真实Pi可编辑基底拒绝坏hash、越界与错误类型，原基底和编号保持不变", { timeout: 15000 }, async (t) => {
  const draft = validDraft(), requirements = requirementItems(draft), original = validDesign(requirements), before = structuredClone(original);
  let reference:Record<string,unknown>|undefined,diagnostic:ArchitectureRoleDiagnostic|undefined;
  const f = await actualPi(t, (body, turn: unknown) => {
    reference ??= requestPayload(body).editableSubmission;
    if (turn === 1) return { name: "revise_architecture_submission", args: { submissionHash: "0".repeat(64), updates: [{ path: "/rationale", value: "错误编号" }] } };
    if (turn === 2) {
      assert.match(feedbackText(body), /草稿版本已变化/u);
      return { name: "revise_architecture_submission", args: { submissionHash: reference!.submissionHash,
        updates: [{ path: "/components/9/purpose", value: "越界" }] } };
    }
    if (turn === 3) {
      assert.match(feedbackText(body), /规范索引/u);
      return { name: "revise_architecture_submission", args: { submissionHash: reference!.submissionHash,
        updates: [{ path: "/steps/0/componentId", value: false }] } };
    }
    assert.equal(turn, 4);
    const feedback = feedbackText(body); assert.match(feedback, /完整提交未通过原工具结构校验/u);
    assert.doesNotMatch(feedback, /rejectedSubmission/u);
    assert.match(feedback, new RegExp(reference!.submissionHash as string));
    return { name: "revise_architecture_submission", args: { submissionHash: reference!.submissionHash,
      updates: [{ path: "/rationale", value: "唯一合法修改" }] } };
  });
  const result = await designerRole(f.designer, draft, requirements, { ...editableOptions(draft, requirements, original),
    onDiagnostics: (value) => { diagnostic = value; } });
  assert.deepEqual(result, { ...before, rationale: "唯一合法修改" }); assert.deepEqual(original, before);
  assert.equal(diagnostic!.modelCalls, 4); assert.equal(diagnostic!.localRevisions, 2); assert.equal(diagnostic!.rejectedSubmission, undefined);
});

test("非法宿主基底在请求前拒绝，payload.previousDesign不会自行授予局部修订能力", { timeout: 15000 }, async (t) => {
  const draft = validDraft(), requirements = requirementItems(draft), original = validDesign(requirements);
  const f = await actualPi(t, (body, turn: unknown) => {
    assert.equal(requestPayload(body).editableSubmission, undefined);
    if (turn === 1) return { name: "revise_architecture_submission", args: { submissionHash: "0".repeat(64),
      updates: [{ path: "/rationale", value: "未获宿主基底" }] } };
    assert.equal(turn, 2); assert.match(feedbackText(body), /尚无可修订/u);
    return { name: "submit_architecture", args: original };
  });
  const badReference = structuredClone(original); badReference.steps[0]!.componentId = "missing";
  const badSchema = { ...original, undeclared: true };
  await assert.rejects(designerRole(f.designer, draft, requirements, editableOptions(draft, requirements, badReference)), /不存在/u);
  await assert.rejects(designerRole(f.designer, draft, requirements, editableOptions(draft, requirements, badSchema)), /不受支持/u);
  const mismatched = editableOptions(draft, requirements, original);
  mismatched.payload.previousDesign = { ...original!, rationale: "不属于宿主基底的另一份原文" };
  await assert.rejects(designerRole(f.designer, draft, requirements, mismatched), /完整原文一致/u);
  await assert.rejects(f.designer.role({ role: "reviewer", submitName: "submit_architecture_review", parameters: reviewSubmissionSchema(),
    systemPrompt: "本地测试", payload: {}, validate: (value) => value, editableDesign: original }), /只有本轮设计者/u);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(designerRole(f.designer, draft, requirements, { ...editableOptions(draft, requirements, original), signal: controller.signal }),
    (error) => failureFields(error).diagnostic!.reason === "cancelled" && failureFields(error).diagnostic!.modelCalls === 0);
  assert.equal(f.requests.length, 0); assert.equal(f.tools.length, 0);
  assert.deepEqual(await designerRole(f.designer, draft, requirements, { payload: {
    draft, requirements, previousDesign: original } }), original);
  assert.equal(f.requests.length, 2);
});

test("合法完整候选超过既有局部修订额度时沿原完整提交，不扩大repair额度或阻断旧流程", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-editable-large-base-")), draft = validDraft(), requirements = requirementItems(draft);
  const original = validDesign(requirements, { failureHandling: Array.from({ length: 70 }, () => ({
    scenario: "原有合法场景".repeat(250), response: "原有合法处理".repeat(250),
  })) });
  assert.ok(Buffer.byteLength(JSON.stringify(original)) > 256 * 1024);
  let prompts = 0;
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"),
    sessionFactory: async (options: PiSessionOptions) => ({ messages: [], subscribe: () => () => {}, abort(){},dispose() {}, async prompt(text) {
      prompts++; const payload:ModelPayload = JSON.parse(text);
      assert.equal(payload.editableSubmission, undefined); assert.deepEqual(payload.previousDesign, original);
      return fixtureTools(options.customTools!).submit_architecture!.execute("full",original);
    } }) });
  await designer.ready;
  t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(await designerRole(designer, draft, requirements, editableOptions(draft, requirements, original)), original);
  assert.equal(prompts, 1);
});

test("同一合法历史基底的新角色使用不同nonce，旧会话编号不能替代本轮编号", { timeout: 15000 }, async (t) => {
  const draft = validDraft(), requirements = requirementItems(draft), original = validDesign(requirements);
  let previous:Record<string,unknown>, current: { submissionHash: unknown; baseCandidateHash: unknown; };
  const f = await actualPi(t, (body, turn: unknown) => {
    const reference = requestPayload(body).editableSubmission;
    if (turn === 1) {
      previous = reference;
      return { name: "revise_architecture_submission", args: { submissionHash: reference.submissionHash,
        updates: [{ path: "/rationale", value: "第一次角色修订" }] } };
    }
    if (turn === 2) {
      current = reference; assert.notEqual(current.submissionHash, previous.submissionHash);
      assert.equal(current.baseCandidateHash, previous.baseCandidateHash);
      return { name: "revise_architecture_submission", args: { submissionHash: previous.submissionHash,
        updates: [{ path: "/rationale", value: "跨角色编号" }] } };
    }
    assert.equal(turn, 3); assert.match(feedbackText(body), /草稿版本已变化/u);
    return { name: "revise_architecture_submission", args: { submissionHash: current.submissionHash,
      updates: [{ path: "/rationale", value: "第二次角色修订" }] } };
  });
  assert.equal((await designerRole(f.designer, draft, requirements, editableOptions(draft, requirements, original))).rationale, "第一次角色修订");
  assert.equal((await designerRole(f.designer, draft, requirements, editableOptions(draft, requirements, original))).rationale, "第二次角色修订");
  assert.equal(f.requests.length, 3);
});

test("宿主基底取消或耗尽原5轮后不能继续，不自动接受基底或重置原预算", { timeout: 15000 }, async (t) => {
  const draft = validDraft(), requirements = requirementItems(draft), original = validDesign(requirements), before = structuredClone(original);
  const controller = new AbortController(); let reference:Record<string,unknown>|undefined;
  const cancelled = await actualPi(t, (body) => {
    reference = requestPayload(body).editableSubmission; controller.abort(new Error("fixture cancelled")); return null;
  });
  await assert.rejects(designerRole(cancelled.designer, draft, requirements, { ...editableOptions(draft, requirements, original),
    signal: controller.signal }), (error) => failureFields(error).diagnostic!.reason === "cancelled" && failureFields(error).diagnostic!.submissionAttempts === 0
      && failureFields(error).diagnostic!.rejectedSubmission === undefined && objectFields(failureFields(error).diagnostic!.editableSubmission).submissionHash === reference!.submissionHash);
  const revise = cancelled.tools[0]!.find((tool) => tool.name === "revise_architecture_submission");
  await assert.rejects(fixtureTools([revise!])[revise!.name]!.execute("late", { submissionHash: reference!.submissionHash,
    updates: [{ path: "/rationale", value: "取消后改动" }] }), /fixture cancelled/u);
  const exhausted = await actualPi(t, (body, turn: number) => ({ name: "revise_architecture_submission", args: {
    submissionHash: turn === 1 ? requestPayload(body).editableSubmission.submissionHash : rejectedHash(feedbackText(body)),
    updates: [{ path: "/steps/0/componentId", value: `missing_${turn}` }],
  } }));
  await assert.rejects(designerRole(exhausted.designer, draft, requirements, editableOptions(draft, requirements, original)),
    (error) => failureFields(error).diagnostic!.reason === "turn_limit" && failureFields(error).diagnostic!.modelCalls === 5 && failureFields(error).diagnostic!.localRevisions === 5
      && failureFields(error).diagnostic!.editableSubmission === undefined && Boolean(failureFields(error).diagnostic!.rejectedSubmission));
  assert.equal(exhausted.requests.length, 5); assert.deepEqual(original, before);
});

test("真实Pi正常架构修订循环可只传局部字段，仍独立评审确切新候选并保留原两轮上限", { timeout: 15000 }, async (t) => {
  let original:ReturnType<typeof validDesign>|undefined,firstHash:unknown,patchedHash:string|undefined;
  const f = await actualPi(t, (body, turn: unknown) => {
    const payload = requestPayload(body);
    if (turn === 1) {
      assert.equal(payload.previousDesign, null); assert.equal(payload.editableSubmission, undefined);
      original = validDesign(payload.requirements); objectFields(original).instructions = "完整处理工作记录，不编造任何进展。".repeat(500);
      firstHash = designHash(original); return { name: "submit_architecture", args: original };
    }
    if (turn === 2) {
      assert.equal(payload.candidateHash, firstHash); assert.equal(payload.editableSubmission, undefined);
      const review = passingReview(payload.candidateHash, payload.design); review.verdict = "revise";
      review.checks.find((item) => item.id === "verification")!.passed = false;
      review.issues = [{ id: "clarify", blocking: true, description: "补齐本轮选型依据", remedy: "仅补齐选型说明" }];
      return { name: "submit_architecture_review", args: review };
    }
    if (turn === 3) {
      assert.deepEqual(payload.previousDesign, original); assert.equal(payload.editableSubmission.baseCandidateHash, firstHash);
      assert.equal(payload.rejectedSubmission, undefined); assert.equal(payload.remaining.revisions, 0);
      const args = { submissionHash: payload.editableSubmission.submissionHash, updates: [{ path: "/rationale", value: "本轮补齐选型说明" }] };
      assert.ok(Buffer.byteLength(JSON.stringify(args)) < 512); return { name: "revise_architecture_submission", args };
    }
    assert.equal(turn, 4); assert.equal(payload.editableSubmission, undefined);
    patchedHash = designHash({ ...original!, rationale: "本轮补齐选型说明" });
    assert.equal(payload.candidateHash, patchedHash); assert.notEqual(payload.candidateHash, firstHash);
    assert.equal(payload.design.instructions, objectFields(original).instructions);
    return { name: "submit_architecture_review", args: passingReview(payload.candidateHash, payload.design, payload.priorFindings) };
  });
  const record = await f.designer.design({ id: "editable_loop", name: "宿主局部架构修订测试", draft: validDraft(), fingerprint: "fixed-requirements" });
  assert.equal(record.status, "passed"); assert.equal(record.candidateHash, patchedHash); assert.equal(record.attempts.length, 2);
  assert.equal(record.attempts[0]!.candidateHash, firstHash); assert.equal(objectFields(record.attempts[0]!.review).verdict, "revise");
  assert.equal(record.attempts[1]!.candidateHash, patchedHash); assert.equal(objectFields(record.attempts[1]!.review).verdict, "pass");
  assert.deepEqual(record.design, { ...original!, rationale: "本轮补齐选型说明" });
  assert.equal(f.requests.length, 4); assert.equal(f.tools.length, 4);
});

test("真实Pi完整多处错误被拒后只发微小修订，错误类型和旧CAS不改草稿，原校验通过才接收", { timeout: 15000 }, async (t) => {
  const draft = validDraft(), requirements = requirementItems(draft), original = validDesign(requirements);
  original.instructions = "完整背景说明。".repeat(1400); original.rationale = "完整选型依据。".repeat(400);
  original.steps[0]!.componentId = "missing_one"; original.coverage[0]!.componentIds = ["missing_two"];
  assert.ok(Buffer.byteLength(JSON.stringify(original)) > 37_000);
  const before = structuredClone(original); let hash: string|undefined;
  const f = await actualPi(t, (body, turn: unknown) => {
    assert.equal(body.tools!.at(-1)!.function.name, "submit_architecture");
    assert.ok(body.tools!.some((item) => item.function.name === "revise_architecture_submission"));
    if (turn === 1) return { name: "submit_architecture", args: original };
    const feedback = feedbackText(body);
    if (turn === 2) {
      hash = rejectedHash(feedback); assert.match(feedback, /componentIds|componentId/u);
      return { name: "revise_architecture_submission", args: { submissionHash: hash, updates: [{ path: "/steps/0/componentId", value: false }] } };
    }
    if (turn === 3) {
      assert.match(feedback, /完整提交未通过原工具结构校验/u); assert.equal(rejectedHash(feedback), hash);
      return { name: "revise_architecture_submission", args: { submissionHash: "0".repeat(64), updates: [{ path: "/steps/0/componentId", value: "summarize" }] } };
    }
    assert.equal(turn, 4); assert.match(feedback, /草稿版本已变化/u);
    const args = { submissionHash: hash, updates: [{ path: "/steps/0/componentId", value: "summarize" }, { path: "/coverage/0/componentIds", value: ["summarize"] }] };
    assert.ok(Buffer.byteLength(JSON.stringify(args)) < 512); return { name: "revise_architecture_submission", args };
  });
  let diagnostic;
  const result = await designerRole(f.designer, draft, requirements, { onDiagnostics: (value) => { diagnostic = value; } });
  assert.equal(result.steps[0]!.componentId, "summarize"); assert.deepEqual(result.coverage[0]!.componentIds, ["summarize"]);
  assert.equal(result.instructions, original.instructions); assert.equal(result.rationale, original.rationale);
  assert.deepEqual(original, before); assert.equal(diagnostic!.modelCalls, 4); assert.equal(diagnostic!.localRevisions, 2);
  assert.doesNotMatch(JSON.stringify(diagnostic), /完整背景说明|完整选型依据|missing_one|missing_two/u);
});

test("真实Pi结构拒绝不留下可修稿，未有语义拒稿不能用修订工具代替首次完整提交", { timeout: 15000 }, async (t) => {
  const draft = validDraft(), requirements = requirementItems(draft), good = validDesign(requirements), invalid = structuredClone(good);
  Reflect.deleteProperty(invalid,"instructions");
  const f = await actualPi(t, (body, turn: unknown) => {
    if (turn === 1) return { name: "submit_architecture", args: invalid };
    if (turn === 2) {
      assert.doesNotMatch(feedbackText(body), /rejectedSubmission/u);
      return { name: "revise_architecture_submission", args: { submissionHash: "0".repeat(64), updates: [{ path: "/rationale", value: "new" }] } };
    }
    assert.equal(turn, 3); assert.match(feedbackText(body), /尚无可修订/u);
    return { name: "submit_architecture", args: good };
  });
  let diagnostic;
  assert.deepEqual(await designerRole(f.designer, draft, requirements, { onDiagnostics: (value) => { diagnostic = value; } }), good);
  assert.equal(diagnostic!.modelCalls, 3); assert.equal(diagnostic!.localRevisions, 0); assert.equal(diagnostic!.rejectedSubmission, undefined);
});

test("真实Pi独立评审局部修订仍通过原完整review语义和逐字依据校验，不能将阻断包装成pass", { timeout: 15000 }, async (t) => {
  const draft = validDraft(), requirements = requirementItems(draft), candidate = validDesign(requirements, { schemaVersion: 3 });
  const candidateHash = designHash(candidate), context = architectureReviewEvidenceContext({ design: candidate, requirements,
    runtimeCapabilities: { hash: "fixed" } }), initial = passingReview(candidateHash, candidate);
  initial.issues = [{ id: "quality", blocking: true, description: "本地测试需要完善处理说明", remedy: "保留原范围完善说明", checkId: "verification", kind: "design",
    candidatePaths: ["/instructions"], references: [{ source: "candidate", path: "/instructions", quote: candidate.instructions }], factClaims: [] }];
  const f = await actualPi(t, (body, turn: unknown) => {
    if (turn === 1) return { name: "submit_architecture_review", args: initial };
    assert.equal(turn, 2); assert.match(feedbackText(body), /contradictory_review/u);
    return { name: "revise_architecture_submission", args: { submissionHash: rejectedHash(feedbackText(body)),
      updates: [{ path: "/verdict", value: "revise" }, { path: "/checks/5/passed", value: false }] } };
  });
  const result = await f.designer.role({ role: "reviewer", systemPrompt: "固定独立评审SDK协议测试", onProgress() {},
    payload: { requirements, design: candidate, candidateHash, candidateSchema: designSubmissionSchema(draft, { requirements }) },
    submitName: "submit_architecture_review", parameters: reviewSubmissionSchema({ evidenceRequired: true }), reviewEvidenceContext: context,
    validate: (value) => validateReview(value, { candidateHash, schemaVersion: 3, evidenceContext: context }) });
  assert.equal(result.verdict, "revise"); assert.equal(result.checks[5]!.passed, false); assert.equal(f.requests.length, 2);
  assert.deepEqual(result.issues[0]!.references, initial.issues[0]!.references); assert.equal(initial.verdict, "pass");
});

test("真实Pi回执提交被语义拒绝后可局部修订原receiptId，仍核对当前原文且旧CAS失效", { timeout: 15000 }, async (t) => {
  const draft = validDraft(), requirements = requirementItems(draft), candidate = validDesign(requirements, { schemaVersion: 3 });
  const candidateHash = designHash(candidate), context = architectureReviewEvidenceContext({ design: candidate, requirements,
    runtimeCapabilities: { hash: "fixed" } });
  let candidateReceipt:{receiptId:string;reference:unknown},requirementReceipt:{receiptId:string;reference:unknown},initial:ReturnType<typeof passingReview>, firstHash: unknown, nextHash: unknown, diagnostics;
  const f = await actualPi(t, (body, turn: unknown) => {
    if (turn === 1) return { name: "read_architecture_evidence", args: { requests: [
      { source: "candidate", pointer: "/instructions" }, { source: "requirements", pointer: "/0/text" },
    ] } };
    const feedback = feedbackText(body);
    if (turn === 2) {
      const [page] = feedback.split("\n").filter((line) => line.startsWith('{"results":')).map((line) => JSON.parse(line));
      assert.ok(page, "真实Pi必须收到批量读取的回执");
      [candidateReceipt, requirementReceipt] = page.results;
      initial = passingReview(candidateHash, candidate); initial.verdict = "revise"; initial.checks[5]!.passed = false;
      initial.issues = [{ id: "quality", blocking: true, description: "本地测试需要完善处理说明", remedy: "保留原范围完善说明",
        checkId: "verification", kind: "design", candidatePaths: [{ receiptId: candidateReceipt.receiptId }],
        references: [{ receiptId: candidateReceipt.receiptId }, { source: "candidate", path: "/instructions", quote: "不存在的测试摘录" }], factClaims: [] }];
      return { name: "submit_architecture_review", args: initial };
    }
    if (turn === 3) {
      assert.match(feedback, /reference_quote_mismatch/u); firstHash = rejectedHash(feedback);
      return { name: "revise_architecture_submission", args: { submissionHash: firstHash,
        updates: [{ path: "/issues/0/references/0/receiptId", value: requirementReceipt.receiptId }] } };
    }
    if (turn === 4) {
      assert.match(feedback, /reference_quote_mismatch/u);
      assert.doesNotMatch(feedback, /路径不在当前完整稿/u);
      nextHash = rejectedHash(feedback); assert.notEqual(nextHash, firstHash);
      return { name: "revise_architecture_submission", args: { submissionHash: firstHash,
        updates: [{ path: "/issues/0/references/1/quote", value: candidate.instructions }] } };
    }
    assert.equal(turn, 5); assert.match(feedback, /草稿版本已变化/u);
    return { name: "revise_architecture_submission", args: { submissionHash: nextHash,
      updates: [{ path: "/issues/0/references/1/quote", value: candidate.instructions }] } };
  });
  const result = await f.designer.role({ role: "reviewer", systemPrompt: "固定独立评审SDK回执修订协议测试", onProgress() {},
    payload: { requirements, design: candidate, candidateHash, candidateSchema: designSubmissionSchema(draft, { requirements }) },
    submitName: "submit_architecture_review", parameters: reviewSubmissionSchema({ evidenceRequired: true }), reviewEvidenceContext: context,
    onDiagnostics: (value) => { diagnostics = value; },
    validate: (value) => validateReview(value, { candidateHash, schemaVersion: 3, evidenceContext: context }) });
  assert.equal(result.verdict, "revise"); assert.equal(result.checks[5]!.passed, false);
  assert.deepEqual(result.issues[0]!.candidatePaths, ["/instructions"]);
  assert.deepEqual(result.issues[0]!.references, [requirementReceipt!.reference, candidateReceipt!.reference]);
  assert.deepEqual(initial!.issues[0]!.references![0], { receiptId: candidateReceipt!.receiptId });
  assert.equal(objectFields(initial!.issues[0]!.references![1]).quote, "不存在的测试摘录");
  assert.equal(diagnostics!.modelCalls, 5); assert.equal(diagnostics!.localRevisions, 2);
  assert.doesNotMatch(JSON.stringify(diagnostics), /不存在的测试摘录|本地测试需要完善处理说明|ref_[a-f0-9]{64}/u);
});

test("真实Pi取消后同一修订工具不能继续，已捕获稿不成为接受结果", { timeout: 15000 }, async (t) => {
  const controller = new AbortController(), draft = validDraft(), requirements = requirementItems(draft), bad = validDesign(requirements);
  bad.steps[0]!.componentId = "missing"; let hash;
  const f = await actualPi(t, (body, turn: unknown) => {
    if (turn === 1) return { name: "submit_architecture", args: bad };
    assert.equal(turn, 2); hash = rejectedHash(feedbackText(body)); controller.abort(new Error("fixture cancelled")); return null;
  });
  await assert.rejects(designerRole(f.designer, draft, requirements, { signal: controller.signal }), (error) => failureFields(error).diagnostic!.reason === "cancelled");
  const revise = f.tools[0]!.find((tool) => tool.name === "revise_architecture_submission");
  await assert.rejects(fixtureTools([revise!])[revise!.name]!.execute("late", { submissionHash: hash, updates: [{ path: "/steps/0/componentId", value: "summarize" }] }), /fixture cancelled/u);
  assert.equal(f.requests.length, 2);
});

test("真实Pi连续局部修订仍共用原5轮模型预算，不以草稿或CAS重置次数", { timeout: 15000 }, async (t) => {
  const draft = validDraft(), requirements = requirementItems(draft), bad = validDesign(requirements);
  bad.steps[0]!.componentId = "missing";
  const f = await actualPi(t, (body, turn: number) => turn === 1 ? { name: "submit_architecture", args: bad }
    : { name: "revise_architecture_submission", args: { submissionHash: rejectedHash(feedbackText(body)),
      updates: [{ path: "/rationale", value: `修订${turn}仍未修复引用` }] } });
  await assert.rejects(designerRole(f.designer, draft, requirements), (error) => failureFields(error).diagnostic!.reason === "turn_limit"
    && failureFields(error).diagnostic!.modelCalls === 5 && failureFields(error).diagnostic!.localRevisions === 4);
  assert.equal(f.requests.length, 5);
});
