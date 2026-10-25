import { callFixture, recordArray } from "../helpers/m7-test-boundaries.mjs";
import type { ToolInputIssue } from "../../src/contracts/tools.mjs";
import type { FixtureModelRequest } from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { listeningAddress } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { architectureToolValidation, diagnoseArchitectureReferences } from "../../src/architecture/architecture-tool-diagnostics.mjs";
import { ArchitectureDesigner } from "../../src/architecture/architecture.mjs";
import { DESIGN_V3_SCHEMA, reviewSubmissionSchema, requirementItems, validateDesign } from "../../src/architecture/architecture-contract.mjs";
import { passingReview, validDraft, validDesign } from "../helpers/architecture.mjs";
import type { UnknownRecord } from "../../src/contracts/json.mjs";

const acceptanceSchema = { type: "object", additionalProperties: false, required: ["acceptance"], properties: { acceptance: DESIGN_V3_SCHEMA.properties.acceptance } };
const acceptance = (index: number) => ({ id: `case_${index}`, kind: "success", requirementIds: ["task"], input: "当前输入", expected: "实际完成",
  verification: { stage: "runtime", owner: "conversation", adapterId: "conversation" } });

test("同源allOf错误定位具体验收阶段与负责方，提供固定适配器映射而不回传值", () => {
  const value = { acceptance: Array.from({ length: 14 }, (_, index) => acceptance(index)) };
  value.acceptance![13]!.verification.adapterId = "host-files"; value.acceptance![13]!.expected = "PRIVATE_CANDIDATE_BODY";
  const result = architectureToolValidation(value, acceptanceSchema, { root: "design" });
  assert.equal(result.valid, false);
  for (const [field, expected] of [["stage", "activation"], ["owner", "platform"]]) {
    const issue: ToolInputIssue | undefined = result.issues.find((entry) => entry.path === `design.acceptance[13].verification.${field}`);
    assert.equal(issue!.reason!, "invalid_value"); assert.deepEqual(issue!.allowedValues, [expected]); assert.equal(issue!.receivedType, "string");
  }
  assert.deepEqual(result.verificationOptions!.find((entry) => entry.adapterId === "host-files"), { adapterId: "host-files", stage: "activation", owner: "platform" });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CANDIDATE_BODY/);
});

test("结构反馈覆盖必填、类型、枚举与动态字段，逐项路径不接受任意参数名", () => {
  const schema = { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["title", "passed"], properties: { title: { type: "string" }, passed: { type: "boolean" } },
  } } } };
  const result = architectureToolValidation({ items: [{ title: 7, PRIVATE_DYNAMIC_NAME: "PRIVATE_DYNAMIC_VALUE" }] }, schema, { root: "module" });
  assert.ok(result.issues.some((entry) => entry.path === "module.items[0].passed" && entry.reason === "required_field"));
  assert.ok(result.issues.some((entry) => entry.path === "module.items[0].title" && entry.reason === "invalid_type" && entry.expectedType === "string"));
  assert.ok(result.issues.some((entry) => entry.path === "module.items[0]" && entry.reason === "unknown_field"));
  const unknown = result.issues.find((entry) => entry.reason === "unknown_field");
  assert.deepEqual(unknown!.allowedFields!, ["title", "passed"]); assert.deepEqual(unknown!.requiredFields!, ["title", "passed"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  assert.deepEqual(architectureToolValidation({ items: [{ title: "明确", passed: true }] }, schema), { valid: true, issues: [] });
});

test("未知字段提示仅派生当前对象schema的有界声明字段，不回显未知名称、值或原型字段", () => {
  const fields = Object.fromEntries([...Array.from({ length: 40 }, (_, index) => [`declared_${index}`, { type: "string" }]),
    ...["bad/name", "带空格 字段", "constructor", "__proto__"].map((field) => [field, { type: "string" }])]);
  const itemSchema = { type: "object", additionalProperties: false, properties: fields, required: Object.keys(fields) };
  const schema = { type: "object", additionalProperties: false, properties: { checks: { type: "array", items: itemSchema } }, required: ["checks"] };
  const item = Object.fromEntries(Object.keys(fields).map((field) => [field, "PRIVATE_DECLARED_VALUE"]));
  item.PRIVATE_UNKNOWN_NAME = "PRIVATE_UNKNOWN_VALUE";
  const before = structuredClone(item), result = architectureToolValidation({ checks: [item] }, schema, { root: "review" });
  const unknown = result.issues.find((entry) => entry.reason === "unknown_field");
  assert.equal(unknown!.path!, "review.checks[0]");
  for (const key of ["allowedFields", "requiredFields"]) {
    assert.equal(objectFields(objectFields(unknown)[key]).length, 32); assert.equal(objectFields(unknown)[`${key}Truncated`], true);
    assert.deepEqual(objectFields(unknown)[key], Array.from({ length: 32 }, (_, index) => `declared_${index}`));
  }
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|bad\/name|带空格|constructor|__proto__/u);
  assert.deepEqual(item, before);
});

test("评审checks的未知字段反馈取自条目schema，只列id、passed、evidence及其真实必填关系", () => {
  const schema = reviewSubmissionSchema(), candidate = passingReview("a".repeat(64));
  Reflect.set(candidate.checks[0]!, "PRIVATE_EXTRA_FIELD", { PRIVATE_VALUE: "do not echo" });
  const result = architectureToolValidation(candidate, schema, { root: "review" });
  const issue: ToolInputIssue | undefined = result.issues.find((entry) => entry.path === "review.checks[0]" && entry.reason === "unknown_field");
  assert.deepEqual(issue!.allowedFields!, ["id", "passed", "evidence"]);
  assert.deepEqual(issue!.requiredFields!, ["id", "passed", "evidence"]);
  assert.equal(schema.properties.checks.items.properties.passed.type, "boolean");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|do not echo/u);
});

function referenceFixture() {
  const draft = validDraft(), requirements = [...requirementItems(draft), ...Array.from({ length: 21 }, (_, index) => ({ id: `confirmed_${index}`, text: `已确认要求${index}` }))];
  const good = validDesign(requirements, { schemaVersion: 3, connections: [],
    interaction: { defaultEntry: "conversation", page: false, operations: true, inputs: "全部记录", results: "完整结果", persistentData: "无" },
    execution: { language: "javascript", hosting: "managed", reason: "真实执行已确认的功能" },
    selectionBasis: { capacity: "覆盖已确认范围", process: "逐项执行", quality: "完整核对", requirementIds: requirements.map((item) => item.id), assumptions: [] } });
  const bad = structuredClone(good);
  bad.instructions = "PRIVATE_CANDIDATE_BODY"; bad.coverage![0]!.componentIds = ["PRIVATE_COMPONENT_ID"];
  bad.steps![0]!.dependsOn = ["PRIVATE_STEP_ID"]; bad.decisions![0]!.evidenceIds = ["PRIVATE_EVIDENCE_ID"];
  for (const item of bad.acceptance) item.requirementIds = item.requirementIds.filter((id) => !id.startsWith("confirmed_"));
  return { draft, requirements, good, bad };
}

test("候选多组引用错误及21项验收缺项一次完整反馈，不暴露未知动态编号", () => {
  const { requirements, good, bad } = referenceFixture(), before = JSON.stringify(bad);
  const result = diagnoseArchitectureReferences(bad, { requirements, schema: DESIGN_V3_SCHEMA });
  for (const path of ["design.coverage[0].componentIds[0]", "design.steps[0].dependsOn[0]", "design.decisions[0].evidenceIds[0]"])
    assert.ok(result.issues.some((entry) => entry.path === path && entry.reason === "invalid_reference"), path);
  assert.deepEqual(result.issues!.find((entry) => entry.path === "design.coverage[0].componentIds[0]")!.allowedReferences, good.components.map((entry) => entry.id));
  assert.deepEqual(result.issues!.find((entry) => entry.path === "design.steps[0].dependsOn[0]")!.allowedReferences, good.steps.map((entry) => entry.id));
  assert.deepEqual(result.issues!.find((entry) => entry.path === "design.decisions[0].evidenceIds[0]")!.allowedReferences, [], "没有证据时明确空集合");
  assert.deepEqual(result.issues!.find((entry) => entry.path === "design.acceptance")!.missingReferences, Array.from({ length: 21 }, (_, index) => `confirmed_${index}`));
  assert.equal(result.total, 4); assert.equal(result.retained, 4); assert.equal(result.truncated, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/); assert.equal(JSON.stringify(bad), before);
  assert.equal(diagnoseArchitectureReferences(good, { requirements, schema: DESIGN_V3_SCHEMA }).total, 0);
});

test("六处同源组件引用一次返回本轮真实安全编号和定位路径，不要求重传候选试错", () => {
  const requirements = [...requirementItems(validDraft()), ...Array.from({ length: 43 }, (_, index) => ({ id: `requirement_${index}`, text: "已确认要求" }))];
  const componentIds = Array.from({ length: 5 }, (_, index) => `component_${index}`);
  const candidate = validDesign(requirements, {
    components: componentIds.map((id) => ({ id, purpose: "实际组件", necessity: "覆盖当前要求", inputs: "输入", outputs: "输出" })),
    steps: componentIds.map((componentId, index) => ({ id: `step_${index}`, componentId, dependsOn: [], input: "输入", output: "输出", completion: "完成" })),
    coverage: requirements.map((item) => ({ requirementId: item.id, componentIds: [componentIds[0]], verification: "核对要求" })),
  });
  const positions = [1, 6, 18, 23, 25, 42];
  for (const index of positions) candidate.coverage![index]!.componentIds = [`PRIVATE_BAD_${index}`];
  const before = structuredClone(candidate), result = diagnoseArchitectureReferences(candidate, { requirements });
  assert.equal(result.total, 6); assert.equal(result.retained, 6); assert.equal(result.truncated, false);
  for (const [index, issue] of result.issues.entries()) {
    assert.equal(issue.path, `design.coverage[${positions[index]}].componentIds[0]`);
    assert.deepEqual(issue.allowedReferences, componentIds);
    assert.deepEqual(issue.allowedReferencePaths, ["design.components[].id"]);
  }
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/); assert.deepEqual(candidate, before);
});

test("引用修正只列本轮对应类别已核对的安全编号，不混用需求、能力或证据", () => {
  const { good } = referenceFixture(), value = structuredClone(good);
  value.coverage![0]!.requirementId = "PRIVATE_REQUIREMENT";
  value.capabilities![0]!.id = "PRIVATE_CAPABILITY";
  value.decisions![0]!.evidenceIds = ["PRIVATE_EVIDENCE"];
  value.coverage = [value.coverage[0]!]; value.acceptance.forEach((item) => { item.requirementIds = ["requirement_safe"]; });
  const result = diagnoseArchitectureReferences(value, {
    requirements: [{ id: "requirement_safe" }, { id: "PRIVATE_UNSAFE_REQUIREMENT with spaces" }],
    capabilities: [{ id: "capability_safe", status: "available" }, { id: "PRIVATE_UNAVAILABLE", status: "unverified" }, { id: "PRIVATE_UNSAFE_CAPABILITY with spaces", status: "available" }],
    evidence: [{ id: "evidence_safe" }, { id: "PRIVATE_UNSAFE_EVIDENCE with spaces" }],
  });
  for (const [path, allowed, target] of [
    ["design.coverage[0].requirementId", ["requirement_safe"], "requirements[].id"],
    ["design.capabilities[0].id", ["capability_safe"], "capabilities[].id"],
    ["design.decisions[0].evidenceIds[0]", ["evidence_safe"], "evidence[].id"],
  ]) {
    const issue = result.issues.find((entry) => entry.path === path);
    assert.deepEqual(issue!.allowedReferences!, allowed); assert.deepEqual(issue!.allowedReferencePaths!, [target]);
  }
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});

test("引用聚合保留总数与截断，并将重复、依赖环、未用组件和缺场景各自定位", () => {
  const { requirements, good } = referenceFixture();
  const many = structuredClone(good); many.coverage![0]!.componentIds = Array.from({ length: 80 }, (_, index) => `PRIVATE_UNKNOWN_${index}`);
  const bounded = diagnoseArchitectureReferences(many, { requirements, limit: 5 });
  assert.equal(bounded.total, 80); assert.equal(bounded.retained, 5); assert.equal(bounded.truncated, true); assert.doesNotMatch(JSON.stringify(bounded), /PRIVATE_/);
  const compound = structuredClone(good);
  compound.components.push({ ...compound.components[0]!, id: "unused" }, structuredClone(compound.components[0])!);
  compound.steps![0]!.dependsOn = [compound.steps![0]!.id]; compound.acceptance = [compound.acceptance[0]!];
  const result = diagnoseArchitectureReferences(compound, { requirements });
  for (const reason of ["duplicate_reference", "dependency_cycle", "component_unused", "missing_acceptance_kind"])
    assert.ok(result.issues.some((entry) => entry.reason === reason), reason);
  assert.throws(() => diagnoseArchitectureReferences(good, { requirements, limit: 0 }));
});

test("真实Pi收到程序首错时同时获得全部独立问题，下一次同会话提交才通过正式校验", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-architecture-references-")), { requirements, draft, good, bad } = referenceFixture();
  const requests: FixtureModelRequest[] = [], progress: ({  })[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(String(Buffer.concat(chunks))); requests.push(body);
    if (requests.length === 2) {
      const feedback = body.messages.findLast((message: { role: string; }) => message.role === "tool").content;
      for (const path of ["design.coverage[0].componentIds[0]", "design.steps[0].dependsOn[0]", "design.decisions[0].evidenceIds[0]"]) assert.ok(feedback.includes(path), path);
      assert.ok(Array.from({ length: 21 }, (_, index) => `confirmed_${index}`).every((id) => feedback.includes(id)));
      assert.match(feedback, /"total":4/); assert.doesNotMatch(feedback, /PRIVATE_|Received arguments/);
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "references-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0,
      delta: { role: "assistant", tool_calls: [{ index: 0, id: `submit_${requests.length}`, type: "function", function: { name: "submit_architecture", arguments: JSON.stringify(requests.length === 1 ? bad : good) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const designer = new ArchitectureDesigner({ config: { chatUrl: `http://127.0.0.1:${listeningAddress(server).port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" }, cwd: root, dataDir: join(root, "data") });
  await designer.ready;
  t.after(async () => { await designer.persistence; server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(root, { recursive: true, force: true }); });
  let validations = 0;
  const result = await designer.role({ role: "designer", submitName: "submit_architecture", parameters: DESIGN_V3_SCHEMA, systemPrompt: "本地固定程序诊断测试",
    payload: { requirements, evidence: [] }, validate: (value) => { validations++; return validateDesign(value, { requirements, draft }); }, onProgress: (entry) => progress.push(entry) });
  assert.equal(requests.length, 2); assert.equal(validations, 2); assert.deepEqual(result, good); assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_/);
});

test("真实Pi在原角色会话修复设计、评审、模块与附加工具参数，错误反馈不带原始载荷", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-architecture-fields-")), requests: FixtureModelRequest[] = [], progress: ({  })[] = [], counts = new Map();
  const privateValue = "PRIVATE_CANDIDATE_VALUE", checks: ({ "role": (string | { type: string; properties: { candidateHash: { type: string; pattern: string; }; verdict: { type: string; enum: string[]; }; checks: { type: string; items: { type: string; properties: { id: { type: string; enum: string[]; }; passed: { type: string; }; evidence: { type: string; minLength: number; maxLength: number; }; }; required: string[]; additionalProperties: boolean; }; minItems: number; maxItems: number; }; issues: { type: string; items: { type: string; properties: { id: { pattern: string; type: string; minLength: number; maxLength: number; }; blocking: { type: string; }; description: { type: string; minLength: number; maxLength: number; }; remedy: { type: string; minLength: number; maxLength: number; }; }; required: string[]; additionalProperties: boolean; }; minItems: number; maxItems: number; }; summary: { type: string; minLength: number; maxLength: number; }; }; required: string[]; additionalProperties: boolean; } | { type: string; additionalProperties: boolean; required: string[]; properties: { acceptance: { type: string; items: { type: string; properties: { id: { pattern: string; type: string; minLength: number; maxLength: number; }; kind: { type: string; enum: string[]; }; requirementIds: { uniqueItems: boolean; type: string; items: { pattern: string; type: string; minLength: number; maxLength: number; }; minItems: number; maxItems: number; }; input: { type: string; minLength: number; maxLength: number; }; expected: { type: string; minLength: number; maxLength: number; }; }; required: string[]; additionalProperties: boolean; }; minItems: number; maxItems: number; }; }; } | { type: string; additionalProperties: boolean; required: string[]; properties: { proposal: { type: string; minLength: number; }; }; } | undefined); "value": (unknown); })[] = [];
  const moduleSchema = { type: "object", additionalProperties: false, required: ["proposal"], properties: { proposal: { type: "string", minLength: 1 } } };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(String(Buffer.concat(chunks))), submit = body.tools.find((entry: { function: { name: string; }; }) => ["submit_architecture", "submit_architecture_review", "submit_module_design"].includes(entry.function.name));
    const name = submit.function.name, count = (counts.get(name) ?? 0) + 1; counts.set(name, count); requests.push(name);
    let value, toolName = name;
    if (name === "submit_architecture") {
      value = { acceptance: Array.from({ length: 14 }, (_, index) => acceptance(index)) };
      if (count === 1) { value.acceptance![13]!.verification.adapterId = "host-files"; value.acceptance![13]!.expected = privateValue; }
      else if (count === 2) {
        const feedback = body.messages.findLast((message: { role: string; }) => message.role === "tool").content;
        assert.match(feedback, /design\.acceptance\[13\]\.verification\.stage/); assert.match(feedback, /verificationOptions/);
        assert.match(feedback, /activation/); assert.match(feedback, /platform/); assert.doesNotMatch(feedback, new RegExp(privateValue));
        toolName = "inspect_schema"; value = { kind: "PRIVATE_INVALID_KIND" };
      } else if (count === 3) {
        const feedback = body.messages.findLast((message: { role: string; }) => message.role === "tool").content;
        assert.match(feedback, /inspect_schema\.kind/); assert.doesNotMatch(feedback, /PRIVATE_INVALID_KIND|Received arguments/);
        toolName = "request_requirements"; value = { issues: "PRIVATE_BAD_HANDOFF" };
      } else {
        const feedback = body.messages.findLast((message: { role: string; }) => message.role === "tool").content;
        assert.match(feedback, /handoff\.issues/); assert.match(feedback, /array/); assert.doesNotMatch(feedback, /PRIVATE_BAD_HANDOFF|Received arguments/);
      }
    } else if (name === "submit_architecture_review") {
      value = passingReview("a".repeat(64));
      if (count === 1) Reflect.set(value.checks[0]!, "passed", "true");
      else { const feedback = body.messages.findLast((message: { role: string; }) => message.role === "tool").content; assert.match(feedback, /review\.checks\[0\]\.passed/); assert.match(feedback, /boolean/); }
    } else {
      value = { proposal: count === 1 ? 7 : "明确的模块方案" };
      if (count === 2) { const feedback = body.messages.findLast((message: { role: string; }) => message.role === "tool").content; assert.match(feedback, /module\.proposal/); assert.match(feedback, /expectedType/); }
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "schema-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0,
      delta: { role: "assistant", tool_calls: [{ index: 0, id: `${name}_${count}`, type: "function", function: { name: toolName, arguments: JSON.stringify(value) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const designer = new ArchitectureDesigner({ config: { chatUrl: `http://127.0.0.1:${listeningAddress(server).port}/v1/chat/completions`, model: "fixture-model", apiKey: "fixture-only" },
    cwd: root, dataDir: join(root, "data") });
  await designer.ready;
  t.after(async () => { await designer.persistence; server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(root, { recursive: true, force: true }); });
  for (const [role, submitName, parameters] of [["designer", "submit_architecture", acceptanceSchema], ["reviewer", "submit_architecture_review", reviewSubmissionSchema()], ["specialist", "submit_module_design", moduleSchema]] as const) {
    await designer.role({ role, submitName, parameters, systemPrompt: "本地固定测试", payload: { test: true }, validate: (value) => { checks.push({ role, value }); return value; },
      onProgress: (event) => progress.push(event), allowHandoff: role === "designer", tools: role === "designer" ? [{ name: "inspect_schema", label: "检查结构", description: "本地测试工具",
        parameters: { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { type: "string", enum: ["allowed"] } } },
        execute: async () => { throw new Error("invalid helper arguments must not execute"); } }] : [] });
  }
  assert.deepEqual(requests, ["submit_architecture", "submit_architecture", "submit_architecture", "submit_architecture", "submit_architecture_review", "submit_architecture_review", "submit_module_design", "submit_module_design"]);
  assert.deepEqual(checks.map((entry) => entry.role), ["designer", "reviewer", "specialist"]);
  assert.equal(objectFields(objectFields(objectFields(checks[1]!.value).checks)[0]).passed, true); assert.equal(objectFields(checks[2]!.value).proposal, "明确的模块方案");
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_|Received arguments|Arguments:/);
});
