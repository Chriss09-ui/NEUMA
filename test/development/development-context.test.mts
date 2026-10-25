import { fixtureJsonObject, fixtureString } from "../helpers/http-model.mjs";
import { recordArray, callFixture } from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import { failureFields } from "../helpers/failure-fields.mjs";
import { toolText } from "../helpers/m7-test-boundaries.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { InputError } from "../../src/requirements/core.mjs";
import { compactDevelopmentContext, createContextReadTool } from "../../src/development/development-context.mjs";
import { developmentCaseFacts } from "../../src/development/development-case-facts.mjs";
import { developmentContextMessage } from "../../src/development/development-context.mjs";
import type { NeumaTool } from "../../src/runtime/pi-port.mjs";

test("开发首包只给当前任务及依赖接口，完整回归和指南仍可按路径读取", async () => {
  const basePayload = { architectureRef: { version: 1 }, task: { id: "t2", requirementIds: ["r2"], acceptanceIds: ["a2"] },
    requirements: [{ id: "r1", text: "其他要求" }, { id: "r2", text: "当前完整要求" }],
    design: { execution: { language: "javascript" }, coverage: [{ requirementId: "r1", componentIds: ["c1"] }, { requirementId: "r2", componentIds: ["c2"] }],
      components: [{ id: "c1" }, { id: "c2" }, { id: "c3" }], steps: [{ id: "s1", componentId: "c1", dependsOn: [] },
        { id: "s2", componentId: "c2", dependsOn: ["s1"] }, { id: "s3", componentId: "c3", dependsOn: [] }],
      acceptance: [{ id: "a1" }, { id: "a2", expected: "不得少一条" }] },
    cases: [{ id: "other", taskId: "t1", acceptanceId: "a1" }, { id: "current", taskId: "t2", acceptanceId: "a2" }],
    roleGuide: "完整规程".repeat(10000), planSchema: { properties: { cases: { description: "用例结构" } } } };
  const feedback = { reason: "修复本次失败", report: { status: "failed" } };
  const payload = Object.assign(basePayload, { feedback, submissionFeedback: { issues: [{ path: "changedFiles", reason: "work_file_unauthorized" }] } });
  Object.assign(payload.task, { feedback });
  const original = structuredClone(payload), packet = JSON.parse(developmentContextMessage(payload, 24000, { kind: "developer" }).message);
  assert.deepEqual(packet.requirements, [payload.requirements[1]]);
  assert.deepEqual(recordArray(packet.design.steps).map(item => item.id), ["s1", "s2"], "依赖接口不能丢失");
  assert.deepEqual(packet.cases, [payload.cases[1]]);
  assert.equal(packet.contextSections.find((item: { section: string; }) => item.section === "cases").delivery, "summary");
  assert.equal(packet.roleGuide, undefined);
  assert.deepEqual(packet.feedback, payload.feedback); assert.equal(packet.task.feedback, undefined);
  assert.deepEqual(packet.submissionFeedback, payload.submissionFeedback);
  const tool = createContextReadTool(() => payload);
  assert.deepEqual(JSON.parse((await call(tool, { section: "cases" })).text), payload.cases);
  assert.equal(JSON.parse((await call(tool, { section: "planSchema", pointer: "/properties/cases/description" })).text), "用例结构");
  assert.deepEqual(payload, original);
  assert.ok(JSON.stringify(packet).length <= 24000);
});

type ContextPage = { text: string; offset: number; totalChars: number } & ({ truncated: true; nextOffset: number } | { truncated: false; nextOffset: null });
const call = async (tool: NeumaTool, params: unknown, signal?: AbortSignal): Promise<ContextPage> => {
  const page = fixtureJsonObject(toolText(await tool.execute("context-read", params, signal)));
  assert.equal(typeof page.text, "string"); assert.equal(typeof page.truncated, "boolean");
  assert.equal(typeof page.offset, "number"); assert.equal(typeof page.totalChars, "number");
  assert.ok(page.truncated ? typeof page.nextOffset === "number" : page.nextOffset === null);
  return page as ContextPage;
};

function largePayload() {
  return { architectureRef: { version: 3, candidateHash: "a".repeat(64) }, subjectHash: "b".repeat(64), mode: "task",
    task: { id: "extract", title: "提取记录", description: "保留事实并明确缺失输入", summary: "已实现主体逻辑", turns: 2 },
    plan: { summary: "逐项实现再验收", runtime: "node-json", entrypoint: "main.mjs", tasks: [], cases: [] },
    report: { id: "report_1", codeHash: "c".repeat(64), status: "failed", summary: "输出与预期不一致", results: [
      { caseId: "case_success", status: "passed", stdout: "完成".repeat(50_000) },
      { caseId: "case_missing", status: "failed", input: "", reason: "assertion_mismatch", exitCode: 0,
        stdout: "超长错误输出😀".repeat(20_000), stderr: "诊断信息".repeat(20_000), actual: { result: "wrong" }, expected: { result: "missing_input" } },
    ] }, cases: [{ id: "case_success", input: "长输入".repeat(20_000), assertions: [{ path: "", expectedJson: '{"ok":true}' }] }],
    remaining: { corrections: 5, planRevisions: 1, integrationRepairs: 2 } };
}

test("小上下文保持原始形状和原始失败证据，但不共享可变对象", () => {
  const payload = { architectureRef: { version: 1 }, task: { id: "a" }, report: { status: "failed", results: [{ actual: { value: 3 }, stdout: "完整证据" }] } };
  const compact = compactDevelopmentContext(payload);
  assert.deepEqual(compact, payload); assert.notEqual(compact, payload);
  assert.equal(Object.hasOwn(compact, "contextTruncated"), false);
  compact.report.results[0]!.actual.value = 4;
  assert.equal(payload.report.results[0]!.actual.value, 3);
});

test("超长证据严格限制提示词长度，保留版本绑定、任务目标与失败摘要", () => {
  const payload = largePayload();
  for (const maxChars of [16_000, 8000, 4000, 2000]) {
    const compact = compactDevelopmentContext(payload, maxChars);
    assert.ok(JSON.stringify(compact).length <= maxChars, String(maxChars));
    assert.equal(compact.contextTruncated, true); assert.match(fixtureString(compact.contextNotice), /不完整摘要/);
    assert.match(fixtureString(compact.contextNotice), /read_development_context/);
    assert.deepEqual(compact.architectureRef, payload.architectureRef); assert.equal(compact.subjectHash, payload.subjectHash);
    assert.equal(objectFields(compact.task).id, "extract"); assert.equal(objectFields(compact.task).description, "保留事实并明确缺失输入");
    assert.equal(objectFields(compact.report).id, "report_1"); assert.equal(objectFields(compact.report).codeHash, payload.report.codeHash);
    assert.equal(objectFields(compact.report).nonPassingResults, 1); assert.equal(recordArray(objectFields(compact.report).failureSummaries)[0]!.caseId, "case_missing");
    assert.equal(Object.hasOwn(objectFields(compact.report), "results"), false, "不能把摘要伪装为完整原始结果");
    assert.deepEqual(compact.contextSections!.map((item) => item.section), Object.keys(payload));
    for (const section of compact.contextSections!) {
      assert.equal(section.path, `/${section.section}`);
      assert.equal(section.totalChars, JSON.stringify(objectFields(payload)[section.section]).length);
      if (section.delivery === "full") assert.deepEqual(compact[section.section], objectFields(payload)[section.section]);
      else if (section.delivery === "paged") assert.equal(Object.hasOwn(compact, section.section), false);
      else { assert.equal(section.delivery, "summary"); assert.notDeepEqual(compact[section.section], objectFields(payload)[section.section]); }
    }
  }
});

test("已完整内联的任务资料明确标记，未投递规则和不完整摘要分别列出", () => {
  const requirements = [{ id: "input", content: "用户已经确认的通用输入要求".repeat(350) }];
  const payload = { architectureRef: { version: 3, candidateHash: "a".repeat(64) }, requirements,
    design: { profile: "custom", rationale: "需要逐步处理与复核", decisions: "正式架构和完整验收范围".repeat(2200) },
    planSchema: { description: "未重复注入的结构说明".repeat(2000) }, planningFiles: { index: "index.json", caseFiles: "普通用例或用例数组" },
    remaining: { corrections: 6, planRevisions: 1, integrationRepairs: 2 } };
  const compact = compactDevelopmentContext(payload, 16000);
  assert.deepEqual(compact.requirements, requirements);
  assert.equal(compact.contextSections!.find((item) => item.section === "requirements")!.delivery, "full");
  assert.equal(compact.contextSections!.find((item) => item.section === "design")!.delivery, "summary");
  assert.equal(compact.contextSections!.find((item) => item.section === "planSchema")!.delivery, "paged");
  assert.match(fixtureString(compact.contextNotice), /full.*无须重新读取/);
  assert.match(fixtureString(compact.contextNotice), /实际需要/);
  assert.ok(JSON.stringify(compact).length <= 16000);
  compact.requirements[0]!.content = "changed";
  assert.notEqual(payload.requirements[0]!.content, "changed");
});

test("较大模型的首轮上下文完整承载普通任务及规则，不要求重新分页读取", () => {
  const payload = { architectureRef: { version: 3, candidateHash: "a".repeat(64) },
    requirements: [{ id: "task", content: "已确认任务".repeat(1400) }],
    design: { work: "完整任务过程和验收说明".repeat(1600) },
    deferredVerifications: [{ id: "check", requirement: "后续必须验证的事项".repeat(1500) }],
    platformSnapshot: { constraints: "平台实际能力及约束".repeat(700) },
    planSchema: { schema: "严格规划结构".repeat(1500) },
    serviceManifestSchema: { schema: "服务执行结构".repeat(800) } };
  assert.ok(JSON.stringify(payload).length > 16000);
  assert.ok(JSON.stringify(payload).length < 128000);
  const initial = compactDevelopmentContext(payload, 128000);
  assert.deepEqual(initial, payload);
  assert.equal(Object.hasOwn(initial, "contextTruncated"), false);
  assert.equal(Object.hasOwn(initial, "contextSections"), false);
});

test("重复结构说明过长时优先完整保留当前失败反馈及实际能力，避免再次交接小报告", () => {
  const report = { id: "runtime_report", mode: "runtime", status: "failed", codeHash: "a".repeat(64), results: [
    { caseId: "runtime_start", input: "  hello  ", status: "failed", stdout: '{"normalized":"HELLO"}', stderr: "startup defect",
      output: { normalized: "HELLO" }, reason: "startup_failed" },
  ] };
  const payload = { task: { id: "repair", title: "修复启动错误" }, feedback: { report, review: { verdict: "revise", summary: "按实际证据修复", issues: [] } },
    runtimeCapabilities: { methods: [{ id: "files.write", returns: { saved: true } }] }, verificationAssignments: [{ acceptanceId: "runtime", stage: "activation" }],
    planSchema: { description: "重复的结构说明".repeat(20_000) } };
  const compact = compactDevelopmentContext(payload, 4096);
  assert.deepEqual(compact.feedback, payload.feedback);
  assert.deepEqual(compact.feedback.report.results[0], report.results[0]);
  assert.deepEqual(compact.runtimeCapabilities, payload.runtimeCapabilities);
  assert.deepEqual(compact.verificationAssignments, payload.verificationAssignments);
  assert.equal(compact.contextSections!.find((item) => item.section === "feedback")!.delivery, "full");
  assert.equal(compact.contextSections!.find((item) => item.section === "planSchema")!.delivery, "paged");
  assert.ok(JSON.stringify(compact).length <= 4096);
});

test("短输入结构规则优先于大型规划结构，需求不被替换且完整结构仍可分页", async () => {
  const payload = { requirements: "实际任务".repeat(600), planSchema: { description: "x".repeat(6500) },
    valueSchemaGuide: "value".repeat(120), jsonValueSchemaGuide: "json".repeat(150) };
  const compact = compactDevelopmentContext(payload, 10000);
  assert.equal(compact.requirements, payload.requirements);
  assert.equal(compact.valueSchemaGuide, payload.valueSchemaGuide);
  assert.equal(compact.jsonValueSchemaGuide, payload.jsonValueSchemaGuide);
  assert.equal(compact.contextSections!.find((entry) => entry.section === "planSchema")!.delivery, "paged");
  const reader = createContextReadTool(() => payload), pages = []; let offset = 0;
  for (;;) {
    const result = await reader.execute("structure-page", { section: "planSchema", offset, limit: 4000 });
    const page = JSON.parse(toolText(result)); pages.push(page.text);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.deepEqual(JSON.parse(pages.join("")), payload.planSchema);
});

test("当前评审事实及验收指南优先完整提供，大型通用结构仍按原文分页", async () => {
  const payload = { architectureRef: { version: 3, candidateHash: "a".repeat(64) }, mode: "plan", subjectHash: "b".repeat(64),
    requirements: [{ id: "input", text: "当前已确认输入要求".repeat(100) }],
    plan: { summary: "当前冻结计划", tasks: [{ id: "main", files: ["main.mjs"] }], cases: [
      { id: "boundary", input: "实际输入".repeat(100), assertions: [{ path: "status", expectedJson: '"rejected"' }] },
    ] },
    admissionFacts: [{ caseId: "boundary", target: "action-value", bytes: 131073, limit: 131072, rejected: true, actionExecuted: false }],
    planningWorkspace: { empty: true, codeHash: "c".repeat(64) },
    acceptanceAdapterGuide: { scope: "按实际验收责任及证明范围检查".repeat(180) },
    serviceManifestSchema: { description: "大型通用服务结构".repeat(700) } };
  const original = structuredClone(payload), maxChars = 10000, compact = compactDevelopmentContext(payload, maxChars);
  assert.ok(JSON.stringify(payload).length > maxChars);
  assert.ok(JSON.stringify(compact).length <= maxChars);
  for (const section of ["requirements", "plan", "admissionFacts", "planningWorkspace", "acceptanceAdapterGuide"]) {
    assert.deepEqual(compact[section], objectFields(payload)[section], section);
    assert.equal(compact.contextSections!.find((entry) => entry.section === section)!.delivery, "full", section);
  }
  assert.equal(Object.hasOwn(compact, "serviceManifestSchema"), false);
  assert.equal(compact.contextSections!.find((entry) => entry.section === "serviceManifestSchema")!.delivery, "paged");
  const tight = compactDevelopmentContext(payload, 4096);
  for (const section of ["requirements", "plan", "admissionFacts", "planningWorkspace"]) assert.deepEqual(tight[section], objectFields(payload)[section], section);
  assert.equal(tight.contextSections!.find((entry) => entry.section === "acceptanceAdapterGuide")!.delivery, "paged");
  assert.ok(JSON.stringify(tight).length <= 4096);
  const reader = createContextReadTool(() => payload), pages = []; let offset = 0;
  for (;;) {
    const page = await call(reader, { section: "serviceManifestSchema", offset, limit: 1800 });
    assert.equal(page.offset, offset); assert.equal(page.totalChars, JSON.stringify(payload.serviceManifestSchema).length);
    pages.push(page.text);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.equal(pages.join(""), JSON.stringify(payload.serviceManifestSchema));
  assert.deepEqual(payload, original);
  objectFields(objectFields(compact.admissionFacts)[0]).bytes = 0;
  assert.equal(payload.admissionFacts[0]!.bytes, original.admissionFacts[0]!.bytes);
});

test("计划实测事实在大型结构前完整提供，超长事实仅标身份摘要且仍可精确分页", async () => {
  const plan = { schemaVersion: 2, runtime: "node-action", cases: [{ id: "sample", acceptanceId: "input", actionId: "run",
    input: '{"items":[1,2,3]}', mocks: [], assertions: [{ path: "", expectedJson: "true" }] }] };
  const caseFacts = developmentCaseFacts(plan), payload = { requirements: [{ id: "input", text: "当前确认要求" }], plan, caseFacts,
    serviceManifestSchema: { description: "无关大结构".repeat(10000) } };
  const initial = compactDevelopmentContext(payload, 6000);
  assert.deepEqual(initial.plan, plan); assert.deepEqual(initial.caseFacts, caseFacts);
  assert.equal(initial.contextSections!.find((entry) => entry.section === "caseFacts")!.delivery, "full");
  assert.equal(initial.contextSections!.find((entry) => entry.section === "serviceManifestSchema")!.delivery, "paged");
  const largePlan = { ...plan, cases: Array.from({ length: 100 }, (_, index) => ({ ...plan.cases[0], id: `sample_${index}` })) };
  const full = { ...payload, plan: largePlan, caseFacts: developmentCaseFacts(largePlan), developmentRevision: {
    schemaVersion: 1, trust: "untrusted-reference", status: "available", source: { agentId: "agent", runId: "old", runVersion: 2, runRevision: 3 },
    planHash: caseFacts.planHash, plan,
  } };
  const compact = compactDevelopmentContext(full, 4096);
  assert.equal(objectFields(compact.caseFacts).planHash, full.caseFacts.planHash); assert.equal(objectFields(compact.caseFacts).schemaVersion, 1);
  assert.equal(objectFields(compact.caseFacts).planSchemaVersion, 2); assert.equal(objectFields(compact.caseFacts).totalCases, 100);
  assert.equal(compact.contextSections!.find((entry) => entry.section === "caseFacts")!.delivery, "summary");
  assert.equal(Object.hasOwn(objectFields(compact.caseFacts), "cases"), false);
  assert.equal(objectFields(compact.developmentRevision).trust, "untrusted-reference");
  assert.equal(objectFields(compact.developmentRevision).planHash, caseFacts.planHash);
  assert.ok(JSON.stringify(compact).length <= 4096);
  const reader = createContextReadTool(() => full), pages = []; let offset = 0;
  for (;;) {
    const page = await call(reader, { section: "caseFacts", offset, limit: 8000 });
    assert.equal(page.offset, offset); assert.equal(page.totalChars, JSON.stringify(full.caseFacts).length);
    pages.push(page.text);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.equal(pages.join(""), JSON.stringify(full.caseFacts));
  assert.deepEqual(JSON.parse(pages.join("")).cases.at(-1), full.caseFacts.cases.at(-1));
  const measurement = full.caseFacts.cases[0]!.input; assert.ok(measurement.status === "measured" && "arrayLengths" in measurement);
  assert.deepEqual(measurement.arrayLengths.entries, [{ pointer: "/items", length: 3 }]);
});

test("反馈内嵌测试失败和计划评审保留可定位摘要，全文仍可读取", async () => {
  const original = largePayload();
  const payload = { architectureRef: original.architectureRef, task: original.task, feedback: {
    report: original.report, review: { verdict: "revise", summary: "需按证据修复", issues: [
      { id: "warning", blocking: false, description: "说明", remedy: "整理" },
      { id: "blocker", blocking: true, kind: "code", description: "处理错误", remedy: "补齐缺少输入处理" },
    ] }, rejectedPlan: original.plan,
  } };
  const compact = compactDevelopmentContext(payload, 4000);
  assert.equal(objectFields(objectFields(compact.feedback).report).id, original.report.id);
  assert.equal(objectFields(objectFields(compact.feedback).review).verdict, "revise");
  assert.equal(recordArray(objectFields(objectFields(compact.feedback).review).issueSummaries)[0]!.id, "blocker");
  const tool = createContextReadTool(() => payload);
  const page = await call(tool, { section: "feedback", offset: 0, limit: 8000 });
  assert.equal(page.text, JSON.stringify(payload.feedback).slice(0, page.nextOffset!));
  assert.equal(page.totalChars, JSON.stringify(payload.feedback).length);
});

test("分页读取能够无损拼回中文和 emoji，不切断 UTF-16 代理对", async () => {
  const payload = { report: { text: "甲😀乙🧑🏽‍💻丙𠮷丁".repeat(5) } };
  const tool = createContextReadTool(() => payload), chunks = [];
  let offset = 0;
  for (;;) {
    const page = await call(tool, { section: "report", offset, limit: 5 });
    assert.ok(page.text.length <= 5); assert.ok(page.text.isWellFormed());
    assert.equal(page.offset, offset); chunks.push(page.text);
    if (!page.truncated) { assert.equal(page.nextOffset, null); break; }
    assert.ok(page.nextOffset > offset); offset = page.nextOffset;
  }
  assert.equal(chunks.join(""), JSON.stringify(payload.report));
  assert.deepEqual(JSON.parse(chunks.join("")), payload.report);
  const end = await call(tool, { section: "report", offset: JSON.stringify(payload.report).length });
  assert.equal(end.text, ""); assert.equal(end.nextOffset, null);
});

test("页边界或大小非法时明确拒绝，不越界也不返回无法继续的空页", async () => {
  const tool = createContextReadTool(() => ({ value: "😀" }));
  for (const params of [
    { section: "value", offset: -1 }, { section: "value", offset: 0.5 }, { section: "value", offset: 99 },
    { section: "value", offset: 2 }, { section: "value", offset: 1, limit: 1 },
    { section: "value", limit: 0 }, { section: "value", limit: -1 }, { section: "value", limit: 8001 },
    { section: "value", limit: 3.5 }, { section: "value", limit: "4000" },
    { section: "value", offset: Number.MAX_SAFE_INTEGER + 1 }, { section: "value", path: "/private/data" },
  ]) await assert.rejects(call(tool, params), InputError);
  const page = await call(tool, { section: "value", offset: 1, limit: 2 });
  assert.equal(page.text, "😀"); assert.equal(page.nextOffset, 3);
});

test("只允许当前输入的自有顶层字段，拒绝原型字段、文件路径和嵌套路径", async () => {
  const payload = JSON.parse('{"report":{"status":"failed"},"__proto__":{"secret":"never"},"constructor":"never"}');
  const tool = createContextReadTool(() => payload);
  for (const section of ["__proto__", "constructor", "prototype", "toString", "report.status", "../report", "/tmp/file", "report/status", "", "absent"]) {
    await assert.rejects(call(tool, { section }), InputError, section);
  }
  assert.equal((await call(tool, { section: "report" })).text, '{"status":"failed"}');
  assert.equal(tool.name, "read_development_context"); assert.equal(tool.parameters.additionalProperties, false);
});

test("每次调用获取当前轮资料，不缓存上一轮 payload 或已移除字段", async () => {
  let payload: { task: { id: string }; feedback?: { status: string } } = { task: { id: "a" }, feedback: { status: "failed" } };
  const tool = createContextReadTool(() => payload);
  assert.equal((await call(tool, { section: "task" })).text, '{"id":"a"}');
  payload = { task: { id: "b" } };
  assert.equal((await call(tool, { section: "task" })).text, '{"id":"b"}');
  await assert.rejects(call(tool, { section: "feedback" }), /不存在/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(call(tool, { section: "task" }, controller.signal), { name: "AbortError" });
});

test("不存在的资料字段列出当前真实可读section，不暴露值或原型字段", async () => {
  const payload = JSON.parse('{"requirements":"PRIVATE_CONTENT","application":{},"__proto__":{"secret":"PRIVATE_CONTENT"},"constructor":"PRIVATE_CONTENT"}');
  const tool = createContextReadTool(() => payload);
  await assert.rejects(call(tool, { section: "plan" }), (error) => {
    assert.match(failureFields(error).message!, /section：\["requirements","application"\]/u);
    assert.doesNotMatch(failureFields(error).message!, /PRIVATE_CONTENT|__proto__|constructor/u);
    return true;
  });
});

test("评审对象能完整放入首包时优先给完整计划，不为无关大指南仅保留计划摘要", () => {
  const payload = { architectureRef: { version: 1, candidateHash: "a".repeat(64) }, mode: "plan", subjectHash: "b".repeat(64),
    requirements: [{ id: "task", text: "实际要求" }], plan: { summary: "评审当前完整计划", tasks: [{ id: "main", files: ["main.mjs"] }],
      cases: [{ id: "case", input: "明确输入", assertions: [{ path: "result", expectedJson: "1" }] }] },
    planSchema: { description: "重复结构说明".repeat(10000) } };
  const compact = compactDevelopmentContext(payload, 4096);
  assert.deepEqual(compact.plan, payload.plan); assert.ok(JSON.stringify(compact).length <= 4096);
  assert.equal(compact.contextSections!.find((entry) => entry.section === "plan")!.delivery, "full");
  assert.equal(compact.contextSections!.find((entry) => entry.section === "planSchema")!.delivery, "paged");
});

test("硬上限无法容纳必要绑定和索引时明确失败，不截断身份或输出超限对象", () => {
  const payload = largePayload();
  assert.throws(() => compactDevelopmentContext(payload, 256), InputError);
  for (const maxChars of [0, -1, 255, 800.5, "16000", Infinity]) assert.throws(() => callFixture(compactDevelopmentContext, undefined, [payload, maxChars]), InputError);
  const circular: { task?: unknown } = {}; circular.task = circular;
  assert.throws(() => compactDevelopmentContext(circular), InputError);
  assert.throws(() => compactDevelopmentContext(null), InputError);
  assert.throws(() => callFixture(createContextReadTool, undefined, [null]), InputError);
});

test("摘要截断也不损坏多字节字符，原始材料不被修改", () => {
  const payload = largePayload(); payload.task.description = "😀中文𠮷".repeat(2000);
  const before = structuredClone(payload), compact = compactDevelopmentContext(payload, 4000);
  assert.ok(fixtureString(objectFields(compact.task).description).isWellFormed()); assert.match(fixtureString(objectFields(compact.task).description), /已截断/);
  assert.ok(JSON.stringify(compact).length <= 4000); assert.deepEqual(payload, before);
});
