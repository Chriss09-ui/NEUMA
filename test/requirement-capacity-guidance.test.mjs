import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import { CAPACITY_PROOF_EXAMPLE as example, CAPACITY_PROOF_GUIDANCE, REQUIREMENT_STAGE_GUIDANCE } from "../src/requirements/requirement-capacity-guidance.mjs";
import { calculateRequirementDerivation, calculationRequestSchema } from "../src/requirements/requirement-calculations.mjs";
import { makeProviders } from "../src/requirements/providers.mjs";
import { createPlatformSnapshot } from "../src/architecture/platform-contract.mjs";
import { validDraft } from "./helpers/architecture.mjs";
import { sufficientPreflight } from "./helpers/consultation.mjs";

const asciiJson = (input) => JSON.stringify(input).replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
const csv = (labels) => "label,votes\r\n" + labels.map(({ label, votes }) => `"${label.replaceAll('"', '""')}",${votes}\r\n`).join("");
const output = (labels) => ({ totalVotes: labels.reduce((total, row) => total + row.votes, 0), labels });
const context = () => ({ draft: validDraft("汇总选项票数"), platform: createPlatformSnapshot(), requirementIds: ["task", "deliverable"],
  issues: [{ id: example.request.issueId, owner: "system", requirementIds: ["task", "deliverable"] }] });
const compute = () => calculateRequirementDerivation(example.request, context());
const bounds = () => Object.fromEntries(compute().expressions.map(({ id, value }) => [id, Number(value)]));

test("教学请求通过现有结构与受限计算，需求量公式不引用容量限额", () => {
  const before = structuredClone(example), ctx = context();
  assert.equal(new Ajv().compile(calculationRequestSchema(ctx))(example.request), true);
  const result = calculateRequirementDerivation(example.request, ctx);
  assert.equal(result.status, "calculated");
  assert.deepEqual(result.expressions.map(({ value }) => value), ["6993", "668", "223", "300", "1152", "4138", "1468", "167"]);
  const values = new Map([...example.request.premises, ...result.expressions].map((item) => [item.id, item]));
  const references = (formula) => formula.ref ? [formula.ref] : (formula.args ?? []).flatMap(references);
  for (const { formula } of example.request.expressions)
    assert.ok(references(formula).every((id) => !Object.hasOwn(example.limits, id)), "需求上界不能把容量限额当输入");
  for (const comparison of example.comparisons) {
    const demand = values.get(comparison.demand), limit = example.limits[comparison.limit];
    assert.equal(limit.unit, comparison.unit);
    if (demand.unit !== comparison.unit) {
      assert.equal(comparison.demand, "json_file_bound"); assert.equal(comparison.unit, "bytes");
      assert.match(comparison.reason, /ASCII/);
    }
    assert.ok(BigInt(demand.value) <= BigInt(limit.value));
  }
  assert.deepEqual(example, before);
  const wrongIssue = context(); wrongIssue.issues[0].id = "current_capacity";
  assert.throws(() => calculateRequirementDerivation(example.request, wrongIssue), { reason: "calculation_reference_invalid" }, "教学编号不能跳过当前问题绑定");
});

test("独立序列化最大合法样本核对固定字符、数字位数及JSON/CSV保守上界", () => {
  const bound = bounds();
  assert.equal('{"label":'.length + ',"votes":'.length + '}'.length, 19);
  assert.equal('{"totalVotes":'.length + ',"labels":['.length + ']}'.length, 27);
  assert.equal("label,votes\r\n".length, 13);
  assert.equal(",".length + String(999).length + "\r\n".length, 6);
  assert.equal(String(7 * 999).length, 4);
  const candidates = ['"'.repeat(11), "\u0800".repeat(11), "a".repeat(11), "\n\r\t\\\"界😀abc",
    "😀".repeat(5) + "界", "\u0001".repeat(11)];
  for (const label of candidates) {
    assert.ok(label.length <= 11);
    for (const count of [0, 1, 7]) for (const votes of [0, 9, 99, 999]) {
      const labels = Array.from({ length: count }, () => ({ label, votes })), jsonText = asciiJson(output(labels)), csvText = csv(labels);
      assert.deepEqual(JSON.parse(jsonText), output(labels)); assert.doesNotMatch(jsonText, /[^\x00-\x7f]/);
      assert.ok(jsonText.length <= bound.json_file_bound); assert.ok(Buffer.byteLength(jsonText) <= bound.json_file_bound);
      assert.ok(csvText.length <= bound.csv_file_chars); assert.ok(Buffer.byteLength(csvText) <= bound.csv_file_bytes);
    }
  }
  const maxRows = (label) => Array.from({ length: 7 }, () => ({ label, votes: 999 }));
  assert.equal(csv(maxRows('"'.repeat(11))).length, bound.csv_file_chars);
  assert.equal(Buffer.byteLength(csv(maxRows("\u0800".repeat(11)))), bound.csv_file_bytes);
  const largestJson = asciiJson(output(maxRows("\u0800".repeat(11))));
  assert.equal(largestJson.length, 667);
  assert.ok(bound.json_file_bound > 667, "多算一个逗号的上界超过667，并不证明667字节的文件通道不够");
});

test("输入、文件写入和引用回复按各自真实数据流核对，含外层JSON转义", () => {
  const bound = bounds(), overheads = { gateway: 27, task: 45, worker: 39, jsonWrite: 86, csvWrite: 85, workerReply: 39 };
  for (const [name, frame] of Object.entries(example.frames)) {
    assert.equal(Buffer.byteLength(asciiJson(frame)) - "null".length, overheads[name]);
    assert.ok(overheads[name] <= 128);
  }
  assert.equal(Buffer.byteLength(asciiJson(example.result)), 39);
  assert.equal(Buffer.byteLength(asciiJson(example.hostReply)), 65);
  const insert = (frame, input) => asciiJson(frame).replace("null", asciiJson(input));
  for (const label of ['"'.repeat(11), "\u0800".repeat(11), "😀".repeat(5) + "\n"]) {
    const labels = Array.from({ length: 7 }, () => ({ label, votes: 999 })), input = { labels };
    assert.ok(Buffer.byteLength(asciiJson(input)) <= 1024);
    for (const name of ["gateway", "task", "worker"])
      assert.ok(Buffer.byteLength(insert(example.frames[name], input)) <= bound.framed_input_bytes);
    const jsonText = asciiJson(output(labels)), csvText = csv(labels);
    assert.ok(Buffer.byteLength(insert(example.frames.jsonWrite, jsonText)) <= bound.json_write_ipc_bytes);
    assert.ok(Buffer.byteLength(insert(example.frames.csvWrite, csvText)) <= bound.csv_write_ipc_bytes);
    assert.ok(Buffer.byteLength(insert(example.frames.workerReply, example.result)) <= bound.reply_ipc_bytes);
    assert.ok(Buffer.byteLength(asciiJson(example.hostReply)) <= bound.reply_ipc_bytes);
  }
});

test("预评估和独立复核共用完整示例及阶段正反例，不增加调用或自动解除问题", async () => {
  const draft = validDraft("汇总选项票数"), issue = { id: "business_choice", owner: "user", blocking: true,
    question: "结果需要采用什么排列方式？", impact: "决定输出顺序", requirementIds: ["deliverable"] };
  const assessment = { ...await sufficientPreflight(), verdict: "needs_input", issues: [issue] };
  const requests = [], responses = [assessment, { decisions: [{ issueId: issue.id, owner: "user", status: "open", reason: "尚无用户选择原话", evidence: [] }] }];
  const providers = makeProviders({ llmConfigured: true, chatUrl: "https://model.invalid/chat", model: "fixture", apiKey: "fixture" }, async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(responses[requests.length - 1]) } }] }), { status: 200 });
  });
  const result = await providers.preflight({ draft, platform: createPlatformSnapshot(), previousIssues: [issue] });
  assert.equal(requests.length, 2); assert.equal(result.verdict, "needs_input"); assert.equal(result.issues[0].blocking, true);
  for (const request of requests) {
    assert.ok(request.messages[0].content.includes(CAPACITY_PROOF_GUIDANCE));
    assert.ok(request.messages[0].content.includes(REQUIREMENT_STAGE_GUIDANCE));
    assert.match(request.messages[0].content, /交互可视化：用户要在工作台里看公式或概念的动态图形/);
    assert.match(request.messages[0].content, /没有其他真实缺口时 verdict=sufficient/);
    assert.match(request.messages[0].content, /平台事实只见任务包platform/);
    assert.deepEqual(JSON.parse(request.messages[1].content).platform, createPlatformSnapshot());
    assert.doesNotMatch(request.messages[0].content, /当前阶段是设计和评估|schemaVersion:3|先证明方案足以完成已确认|request_requirements/);
  }
  assert.equal(result.preflightDiagnostic.readOnlyCalls, 0);
});
