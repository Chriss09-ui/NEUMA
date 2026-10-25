import {callFixture,fixtureToolAt} from "../helpers/m7-test-boundaries.mjs";
import {objectFields} from "../../src/runtime/type-boundary.mjs";
interface WireFidelityValue {contextHash:string;verdict:string;checks:{requirementId:string;admissionPreserved:boolean;deliveryPreserved:boolean;newUnconfirmedRestriction:boolean}[];restrictions:{candidatePath?:string;claimRef?:{source:string;requirementId:string;offset?:unknown;length?:unknown};requirementId?:string;source?:string;path?:string;quote?:unknown;reason?:string}[]}
const wireResult:(...args:Parameters<typeof fidelityResult>)=>WireFidelityValue=fidelityResult;
import { failureFields } from "../helpers/failure-fields.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { findPackageJSON } from "node:module";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { diagnoseRequirementFidelitySubmission, verifyRequirementFidelity } from "../../src/architecture/requirement-fidelity.mjs";
import { fidelityResult } from "../helpers/fidelity.mjs";
import type { PiSessionOptions } from "../../src/runtime/pi-port.mjs";

function context() {
  return { fidelityContextVersion: "full-v2", requirements: [{ id: "input", text: "输入允许原业务范围内的全部字符。" }],
    draft: { accepted: "输入允许原业务范围内的全部字符。" }, confirmedRequirementContext: null,
    candidate: { instructions: "只接收ASCII字符，其他原合法内容拒绝。" }, runtimeCapabilities: { version: 1 },
    deferredVerifications: { issues: [{ stage: "development", stageDecision: { status: "deferred", reason: "固定测试：系统承担后续真实验收。" } }] } };
}
const payload = (current: unknown) => ({ ...objectFields(current), contextHash: diagnoseRequirementFidelitySubmission(current, {}).contextHash });
const formal = ({ modelCalls: _calls, fidelityDiagnostic: _diagnostic, contextVersion: _version, ...value }:Awaited<ReturnType<typeof verifyRequirementFidelity>>) => value;
const invoke = (current: { fidelityContextVersion: string; requirements: { id: string; text: string; }[]; draft: { accepted: string; }; confirmedRequirementContext: null; candidate: { instructions: string; }; runtimeCapabilities: { version: number; }; deferredVerifications: { issues: { stage: string; stageDecision: { status: string; reason: string; }; }[]; }; }, inspect:(payload:unknown,options:PiSessionOptions)=>unknown|Promise<unknown>) => verifyRequirementFidelity({ context: current, config: {}, cwd: "/tmp", dataDir: "/tmp",
  sessionFactory: async (options) => ({ modelCallAccounting: true, dispose() {}, async prompt(text) {
    await options.onModelCall!(); await inspect(JSON.parse(text), options);
  } }) });

test("full-v2的ID短行通过实际SDK校验，只恢复明确选择的原文为canonical证据", async () => {
  const manifestPath = findPackageJSON("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const manifest = JSON.parse(await readFile(manifestPath!, "utf8"));
  const validationPath = manifest.exports["./utils/*"].import.replace("*", "validation");
  const { validateToolArguments } = await import(new URL(validationPath, pathToFileURL(manifestPath!)).href);
  const current = context(), before = structuredClone(current);
  const result = await invoke(current, async (message: unknown, options: PiSessionOptions) => {
    const tool = fixtureToolAt(options.customTools!,0), value = wireResult(message, "narrowed"), untouched = structuredClone(value);
    assert.equal(options.reasoningMode, "off"); assert.equal(options.maxOutputTokens, 8192);
    assert.deepEqual(options.customTools!.map(({ name }) => name), ["submit_requirement_fidelity", "read_model_context"]);
    assert.match(options.systemPrompt!, /原本合法输入被候选排除、用户被要求新增资料或确认义务、原承诺输出或覆盖程度被减少/u);
    assert.match(options.systemPrompt!, /实现选择、无损协议包装、系统自选验收见证、系统承担的技术证明义务，本身不构成用户新限制/u);
    assert.match(options.systemPrompt!, /合法延期至development的验证，不因尚未执行就自动判unproven或narrowed/u);
    assert.match(options.systemPrompt!, /不继承主设计者或主评审者的pass/u);
    assert.doesNotMatch(options.systemPrompt!, /已知不成立的验收约束判narrowed/u);
    assert.deepEqual(await callFixture(options.rawInputValidators![tool!.name]!,undefined,[{ args: value, toolCallId: "wire" }]), { valid: true });
    const actual = validateToolArguments(tool, { name: tool!.name, arguments: value });
    await tool!.execute("wire", actual); assert.deepEqual(value, untouched);
  });
  assert.equal(result.contextVersion, "full-v2"); assert.equal(result.fidelityDiagnostic.contextVersion, "full-v2");
  assert.equal(result.restrictions![0]!.source, "requirements"); assert.equal(result.restrictions![0]!.path, "/0/text");
  assert.equal(result.restrictions![0]!.quote, current.requirements[0]!.text); assert.ok(!Object.hasOwn(result.restrictions![0]!, "claimRef"));
  assert.equal(diagnoseRequirementFidelitySubmission(current, formal(result), { canonical: true }).valid, true);
  assert.equal(diagnoseRequirementFidelitySubmission(current, formal(result)).valid, false, "canonical证据不能冒充新版wire提交");
  assert.deepEqual(current, before);
});

test("长原需求必须显式选范围，未指定时不截断，数值字符串在SDK前拒绝", async () => {
  const current = context(); current.requirements[0]!.text = "甲".repeat(1100) + "原业务全部内容必须完整交付。";
  const result = await invoke(current, async (message: unknown, options: PiSessionOptions) => {
    const tool = fixtureToolAt(options.customTools!,0), value = wireResult(message, "narrowed");
    await assert.rejects(tool!.execute("whole", value), (error) => failureFields(error).validationIssues!.some((issue) => issue.reason === "reference_excerpt_required"));
    value.restrictions[0]!.claimRef = { ...value.restrictions[0]!.claimRef!, offset: 1100, length: 8 };
    const wrong = structuredClone(value); wrong.restrictions[0]!.claimRef!.offset = "1100";
    assert.equal((await callFixture(options.rawInputValidators![tool!.name]!,undefined,[{ args: wrong, toolCallId: "wrong-type" }])).valid, false);
    await tool!.execute("excerpt", value);
  });
  assert.equal(result.restrictions![0]!.quote, current.requirements[0]!.text.slice(1100, 1108));
  assert.equal(result.restrictions![0]!.path, "/0/text"); assert.equal(result.modelCalls, 1);
});

test("短行摘录的错误只解释已选分支，不要求补入另一种引用格式", () => {
  const current = context(), value = wireResult(payload(current), "narrowed");
  value.restrictions[0]!.claimRef = { source: "requirements", requirementId: "input", offset: "PRIVATE_OFFSET", length: 3 };
  const before = structuredClone(value), feedback = diagnoseRequirementFidelitySubmission(current, value);
  assert.equal(feedback.valid, false); assert.equal(feedback.stage, "schema");
  assert.equal(feedback.total, 1); assert.equal(feedback.truncated, false);
  assert.deepEqual(feedback.issues.map((issue) => ({ path:issue.path, reason:issue.reason, expectedType:issue.expectedType, receivedType:objectFields(issue).receivedType })),
    [{ path: "fidelity.restrictions[0].claimRef.offset", reason: "invalid_type", expectedType: "integer", receivedType: "string" }]);
  assert.doesNotMatch(JSON.stringify(feedback), /PRIVATE_|required_field|unknown_field/u);
  assert.deepEqual(value, before);
  value.restrictions[0]!.claimRef!.offset = 0;
  assert.equal(diagnoseRequirementFidelitySubmission(current, value).valid, true);
});

test("摘录缺范围字段与越界数字分别给具体字段和实际额度，不退回整段引用分支", () => {
  const current = context(), value = wireResult(payload(current), "narrowed");
  value.restrictions[0]!.claimRef = { source: "requirements", requirementId: "input", length: 3 };
  let feedback = diagnoseRequirementFidelitySubmission(current, value);
  assert.equal(feedback.total, 1);
  assert.equal(feedback.issues[0]!.path, "fidelity.restrictions[0].claimRef.offset");
  assert.equal(feedback.issues[0]!.reason, "required_field");
  value.restrictions[0]!.claimRef!.offset = 0; value.restrictions[0]!.claimRef!.length = 1001;
  feedback = diagnoseRequirementFidelitySubmission(current, value);
  assert.equal(feedback.total, 1);
  assert.equal(feedback.issues[0]!.path, "fidelity.restrictions[0].claimRef.length");
  assert.equal(feedback.issues[0]!.reason, "size_limit");
  assert.equal(objectFields(objectFields(feedback.issues[0]).constraints).maximum, 1000);
  assert.doesNotMatch(JSON.stringify(feedback), /unknown_field|invalid_contract/u);
});

test("详细引用的字段类型错误不混入短行必填提示，允许来源由实际分支提供", () => {
  const current = context(), value = wireResult(payload(current), "narrowed");
  value.restrictions[0] = { candidatePath: "/instructions", requirementId: "input", source: "draft",
    path: "/accepted", quote: false, reason: "核对原输入要求。" };
  const feedback = diagnoseRequirementFidelitySubmission(current, value);
  assert.equal(feedback.total, 1);
  assert.equal(feedback.issues[0]!.path, "fidelity.restrictions[0].quote");
  assert.equal(feedback.issues[0]!.reason, "invalid_type");
  assert.equal(feedback.issues[0]!.expectedType, "string");
  assert.equal(objectFields(feedback.issues[0]).receivedType, "boolean");
  assert.doesNotMatch(JSON.stringify(feedback), /claimRef|required_field|unknown_field/u);
  value.restrictions[0]!.quote = current.draft.accepted;
  assert.equal(diagnoseRequirementFidelitySubmission(current, value).valid, true);
  value.restrictions[0]!.source = "PRIVATE_SOURCE";
  const wrongSource = diagnoseRequirementFidelitySubmission(current, value);
  assert.equal(wrongSource.total, 1);
  assert.deepEqual(objectFields(wrongSource).allowedSources, ["draft", "confirmedRequirementContext"]);
  assert.deepEqual(wrongSource.issues[0]!.allowedValues, ["draft", "confirmedRequirementContext"]);
  assert.doesNotMatch(JSON.stringify(wrongSource), /PRIVATE_/u);
});

test("同次提交混合短行与详细引用时逐项选择格式，彼此不覆盖诊断", () => {
  const current = context(), value = wireResult(payload(current), "narrowed");
  value.restrictions[0]!.claimRef = { source: "requirements", requirementId: "input", offset: "PRIVATE_OFFSET", length: 3 };
  const detailed = { candidatePath: "/instructions", requirementId: "input", source: "draft",
    path: "/accepted", quote: false, reason: "核对原输入要求。" };
  value.restrictions.push(detailed, structuredClone(detailed));
  const feedback = diagnoseRequirementFidelitySubmission(current, value);
  assert.equal(feedback.total, 3);
  assert.deepEqual(feedback.issues.map(({ path, reason, expectedType }) => ({ path, reason, expectedType })), [
    { path: "fidelity.restrictions[0].claimRef.offset", reason: "invalid_type", expectedType: "integer" },
    { path: "fidelity.restrictions[1].quote", reason: "invalid_type", expectedType: "string" },
    { path: "fidelity.restrictions[2].quote", reason: "invalid_type", expectedType: "string" },
  ]);
  assert.doesNotMatch(JSON.stringify(feedback), /PRIVATE_|required_field|unknown_field|invalid_contract/u);
  value.restrictions[0]!.claimRef!.offset = 0;
  value.restrictions[1]!.quote = current.draft.accepted; value.restrictions[2]!.quote = current.draft.accepted;
  assert.equal(diagnoseRequirementFidelitySubmission(current, value).valid, true);
});

test("摘录越界、缺半范围、切开代理对或混入旧字段不能被自动修复", () => {
  const current = context(); current.requirements[0]!.text = "a😀b";
  for (const [offset, length] of [[1, 1], [2, 1], [3, 2]]) {
    const value = wireResult(payload(current), "narrowed"); Object.assign(value.restrictions[0]!.claimRef!, { offset, length });
    const before = structuredClone(value), feedback = diagnoseRequirementFidelitySubmission(current, value);
    assert.equal(feedback.valid, false); assert.ok(feedback.issues.some((issue) => issue.reason === "reference_range_invalid"));
    assert.deepEqual(value, before);
  }
  for (const change of [
    (item: { claimRef: { offset: number; }; }) => { item.claimRef.offset = 1; },
    (item: { claimRef: { source: string; }; }) => { item.claimRef.source = "candidate"; },
    (item: { claimRef: { requirementId: string; }; }) => { item.claimRef.requirementId = "PRIVATE_UNKNOWN_ID"; },
    (item: { quote: string; }) => { item.quote = "PRIVATE_QUOTE"; },
  ]) {
    const value = wireResult(payload(current), "narrowed"); callFixture(change,undefined,[value.restrictions[0]]);
    const feedback = diagnoseRequirementFidelitySubmission(current, value);
    assert.equal(feedback.valid, false); assert.equal(feedback.stage, "schema"); assert.doesNotMatch(JSON.stringify(feedback), /PRIVATE_/u);
  }
  const valid = wireResult(payload(current), "narrowed"); Object.assign(valid.restrictions[0]!.claimRef!, { offset: 1, length: 2 });
  assert.equal(diagnoseRequirementFidelitySubmission(current, valid).valid, true);
});

test("旧详细schema和原引文校验仍原样有效，新版不把坏详细行或错flags洗成有效结论", () => {
  const current = context(), legacy = structuredClone(current); delete objectFields(legacy).fidelityContextVersion;
  const old = wireResult(payload(legacy), "narrowed"); assert.equal(diagnoseRequirementFidelitySubmission(legacy, old).valid, true);
  const copied = wireResult(payload(current), "narrowed", { canonical: true });
  assert.equal(diagnoseRequirementFidelitySubmission(current, copied).valid, false);
  assert.equal(diagnoseRequirementFidelitySubmission(current, copied, { canonical: true }).valid, true);
  copied.restrictions[0]!.quote = "PRIVATE_REWRITTEN_QUOTE";
  assert.ok(diagnoseRequirementFidelitySubmission(current, copied, { canonical: true }).issues.some((issue) => issue.reason === "reference_quote_mismatch"));
  const wire = wireResult(payload(current), "narrowed"); wire.checks[0]!.admissionPreserved = true; wire.checks[0]!.newUnconfirmedRestriction = false;
  const feedback = diagnoseRequirementFidelitySubmission(current, wire);
  assert.equal(feedback.valid, false); assert.ok(feedback.issues.some((issue) => issue.reason === "restriction_flag_mismatch"));
  wire.restrictions[0]!.candidatePath = "instructions.2";
  assert.ok(diagnoseRequirementFidelitySubmission(current, wire).issues.some((issue) => issue.reason === "candidate_path_missing"));
});

test("版本未知或state/diagnostic版本不匹配在建立会话前拒绝，不重置次数", async () => {
  const current = context(), contract = diagnoseRequirementFidelitySubmission(current, {});
  const progress = { contextVersion: "full-v2", contextHash: contract.contextHash, schemaHash: contract.schemaHash, calls: 1,
    sessionFile: "fixture.jsonl", sessionBindingHash: "a".repeat(64), diagnostic: { contextVersion: "full-v2", schemaVersion: 1,
      contextHash: contract.contextHash, modelCalls: 1, submissionAttempts: 1, schemaRejections: 0, semanticRejections: 1 } };
  let sessions = 0;
  for (const state of [{ ...progress, contextVersion: "unknown" }, (({ contextVersion: _version, ...rest }) => rest)(progress),
    { ...progress, diagnostic: { ...progress.diagnostic, contextVersion: "unknown" } }]) {
    await assert.rejects(callFixture(verifyRequirementFidelity,undefined,[{ context: current, config: {}, cwd: "/tmp", dataDir: "/tmp",
      sessionStorage: { directory: "/tmp", binding: {} }, progress: state, sessionFactory: async () => { sessions++; } }]),
    (error) => failureFields(error).reason === "scope_evaluation_incomplete");
  }
  assert.throws(() => diagnoseRequirementFidelitySubmission({ ...current, fidelityContextVersion: "unknown" }, {}),
    (error) => failureFields(error).reason === "scope_evaluation_incomplete");
  assert.equal(sessions, 0); assert.equal(progress.calls, 1);
});
