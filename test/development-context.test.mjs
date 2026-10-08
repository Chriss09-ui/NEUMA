import assert from "node:assert/strict";
import test from "node:test";
import { InputError } from "../core.mjs";
import { compactDevelopmentContext, createContextReadTool } from "../development-context.mjs";

const call = async (tool, params, signal) => JSON.parse((await tool.execute("context-read", params, signal)).content[0].text);

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
  compact.report.results[0].actual.value = 4;
  assert.equal(payload.report.results[0].actual.value, 3);
});

test("超长证据严格限制提示词长度，保留版本绑定、任务目标与失败摘要", () => {
  const payload = largePayload();
  for (const maxChars of [16_000, 8000, 4000, 2000]) {
    const compact = compactDevelopmentContext(payload, maxChars);
    assert.ok(JSON.stringify(compact).length <= maxChars, maxChars);
    assert.equal(compact.contextTruncated, true); assert.match(compact.contextNotice, /不完整摘要/);
    assert.match(compact.contextNotice, /read_development_context/);
    assert.deepEqual(compact.architectureRef, payload.architectureRef); assert.equal(compact.subjectHash, payload.subjectHash);
    assert.equal(compact.task.id, "extract"); assert.equal(compact.task.description, "保留事实并明确缺失输入");
    assert.equal(compact.report.id, "report_1"); assert.equal(compact.report.codeHash, payload.report.codeHash);
    assert.equal(compact.report.nonPassingResults, 1); assert.equal(compact.report.failureSummaries[0].caseId, "case_missing");
    assert.equal(Object.hasOwn(compact.report, "results"), false, "不能把摘要伪装为完整原始结果");
    assert.deepEqual(compact.contextSections.map((item) => item.section), Object.keys(payload));
    for (const section of compact.contextSections) {
      assert.equal(section.path, `/${section.section}`);
      assert.equal(section.totalChars, JSON.stringify(payload[section.section]).length);
    }
  }
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
  assert.equal(compact.feedback.report.id, original.report.id);
  assert.equal(compact.feedback.review.verdict, "revise");
  assert.equal(compact.feedback.review.issueSummaries[0].id, "blocker");
  const tool = createContextReadTool(() => payload);
  const page = await call(tool, { section: "feedback", offset: 0, limit: 8000 });
  assert.equal(page.text, JSON.stringify(payload.feedback).slice(0, page.nextOffset));
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
  let payload = { task: { id: "a" }, feedback: { status: "failed" } };
  const tool = createContextReadTool(() => payload);
  assert.equal((await call(tool, { section: "task" })).text, '{"id":"a"}');
  payload = { task: { id: "b" } };
  assert.equal((await call(tool, { section: "task" })).text, '{"id":"b"}');
  await assert.rejects(call(tool, { section: "feedback" }), /不存在/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(call(tool, { section: "task" }, controller.signal), { name: "AbortError" });
});

test("硬上限无法容纳必要绑定和索引时明确失败，不截断身份或输出超限对象", () => {
  const payload = largePayload();
  assert.throws(() => compactDevelopmentContext(payload, 256), InputError);
  for (const maxChars of [0, -1, 255, 800.5, "16000", Infinity]) assert.throws(() => compactDevelopmentContext(payload, maxChars), InputError);
  const circular = {}; circular.task = circular;
  assert.throws(() => compactDevelopmentContext(circular), InputError);
  assert.throws(() => compactDevelopmentContext(null), InputError);
  assert.throws(() => createContextReadTool(null), InputError);
});

test("摘要截断也不损坏多字节字符，原始材料不被修改", () => {
  const payload = largePayload(); payload.task.description = "😀中文𠮷".repeat(2000);
  const before = structuredClone(payload), compact = compactDevelopmentContext(payload, 4000);
  assert.ok(compact.task.description.isWellFormed()); assert.match(compact.task.description, /已截断/);
  assert.ok(JSON.stringify(compact).length <= 4000); assert.deepEqual(payload, before);
});
