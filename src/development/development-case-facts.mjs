import { createHash } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { hashValue } from "./development-contract.mjs";
import { FIXTURE_LIMITS, resolveCaseInput, resolveTestJson, inputContractMeasurement } from "./development-fixtures.mjs";

export const CASE_FACT_LIMITS = Object.freeze({ cases: 200, arrayFields: 16, fileWrites: 16, fieldNameChars: 160,
  fileReferenceChars: 500, measuredValueBytes: FIXTURE_LIMITS.planBytes });
const notice = "这里只测量当前计划声明的实际展开输入与files.write替身参数，不执行生成代码或宿主能力，不读取替身返回值，不证明业务正确、真实文件已保存或已覆盖最大合法输入。原JSON文本、解析后规范JSON、内嵌业务文本与任务信封分别标注；旧utf8Bytes仍指输入值规范JSON，不含任务/API信封，text编码按原文本测量。信封仅在明确任务信封拒绝用例中使用同源验证信封测量，不外推API/MCP或业务成功。明细截断时须核对原计划的对应分组和索引；完整本报告通过本轮实际提供的只读分页入口读取。";
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const type = (value) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
const pointer = (key) => "/" + key.replaceAll("~", "~0").replaceAll("/", "~1");

function failure(error, signal, budget) {
  signal?.throwIfAborted();
  if (!(error instanceof InputError)) throw error;
  if (error.reason === "fixture_text_work_limit") budget.textWorkExhausted = true;
  return { status: "unmeasured", reason: error.reason === "measurement_budget_exhausted"
    || /^fixture_[a-z_]{1,64}$/.test(error.reason ?? "") ? error.reason : "invalid_input" };
}

function checkBudget(budget) {
  if (budget.textWorkExhausted) throw Object.assign(new InputError("计划夹具文本工作额度已用完"), { reason: "fixture_text_work_limit" });
  if (budget.exhausted) throw Object.assign(new InputError("计划只读测量额度已用完"), { reason: "measurement_budget_exhausted" });
}

function measureText(text, budget) {
  checkBudget(budget);
  const bytes = Buffer.byteLength(text);
  if (bytes > CASE_FACT_LIMITS.measuredValueBytes - budget.bytes) {
    budget.exhausted = true; checkBudget(budget);
  }
  budget.bytes += bytes;
  return bytes;
}

function arrayLengths(value) {
  if (Array.isArray(value)) return { total: 1, retained: 1, truncated: false, entries: [{ pointer: "", length: value.length }] };
  let total = 0;
  const entries = [];
  if (value && typeof value === "object") for (const key of Object.keys(value)) if (Array.isArray(value[key])) {
    total++;
    if (entries.length < CASE_FACT_LIMITS.arrayFields && key.length <= CASE_FACT_LIMITS.fieldNameChars)
      entries.push({ pointer: pointer(key), length: value[key].length });
  }
  return { total, retained: entries.length, truncated: total > entries.length, entries };
}

function textFacts(text, budget) {
  return { utf8Bytes: measureText(text, budget), utf16Units: text.length, sha256: sha256(text) };
}

function embeddedTextFacts(value, budget) {
  const entries = []; let total = 0;
  if (value && typeof value === "object" && !Array.isArray(value)) for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") continue;
    total++;
    if (entries.length >= CASE_FACT_LIMITS.arrayFields || key.length > CASE_FACT_LIMITS.fieldNameChars) continue;
    const entry = { pointer: pointer(key), rawText: textFacts(item, budget) };
    let parsed;
    try { parsed = JSON.parse(item); } catch { /* Ordinary text has no parsed JSON representation. */ }
    if (parsed !== undefined) {
      const pending = [[parsed, 0]]; let nodes = 0, bounded = true;
      while (pending.length) {
        const [current, depth] = pending.pop();
        if (++nodes > FIXTURE_LIMITS.expandedNodes || depth > 32) { bounded = false; break; }
        if (current && typeof current === "object") for (const child of Object.values(current)) pending.push([child, depth + 1]);
      }
      entry.parsedJson = bounded ? { ...textFacts(JSON.stringify(parsed), budget), type: type(parsed), arrayLengths: arrayLengths(parsed) }
        : { status: "unmeasured", reason: "embedded_json_complexity" };
    }
    entries.push(entry);
  }
  return { total, retained: entries.length, truncated: total > entries.length, entries };
}

function inputFacts(test, plan, budget, signal) {
  try {
    checkBudget(budget);
    const runtime = plan.runtime;
    const literal = runtime === "node-json" || test.kind === "node-check";
    if (literal && typeof test.input !== "string") throw new InputError("文本用例输入类型无效");
    const value = literal ? test.input : resolveCaseInput(test, { maxInputBytes: runtime === "managed-service" ? 1024 * 1024 : 128 * 1024,
      signal, textWorkBudget: budget.textWorkBudget }).value;
    const text = literal ? value : JSON.stringify(value);
    const measured = textFacts(text, budget);
    const action = (plan.application?.service?.operations ?? plan.application?.actions ?? []).find((entry) => entry.id === test.actionId);
    return { status: "measured", encoding: literal ? "text" : "json-value", type: type(value),
      utf8Bytes: measured.utf8Bytes, sha256: measured.sha256, arrayLengths: arrayLengths(value),
      sourceText: { encoding: typeof test.input === "string" ? literal ? "raw-text" : "json-source-text" : "fixture-recipe",
        ...textFacts(typeof test.input === "string" ? test.input : JSON.stringify(test.input), budget) },
      canonicalJson: literal ? { status: "not_applicable", reason: "text_protocol" } : { status: "measured", ...measured },
      embeddedTexts: embeddedTextFacts(value, budget),
      taskEnvelope: test.kind === "input-rejection" && test.inputTarget === "task-envelope" && action
        ? { status: "measured", source: "input-contract-verification-envelope", ...inputContractMeasurement(action, value, { target: "task-envelope" }), actionExecuted: false }
        : { status: "not_measured", reason: "input_value_is_not_task_envelope" } };
  } catch (error) { return failure(error, signal, budget); }
}

function fileWriteFacts(test, budget, signal) {
  const mocks = Array.isArray(test.mocks) ? test.mocks : [], entries = [];
  let total = 0;
  for (const [mockIndex, mock] of mocks.entries()) {
    signal?.throwIfAborted();
    if (mock?.capability !== "files.write") continue;
    total++;
    if (entries.length >= CASE_FACT_LIMITS.fileWrites) continue;
    try {
      checkBudget(budget);
      const args = resolveTestJson(mock.argsJson, { signal, textWorkBudget: budget.textWorkBudget }).value;
      measureText(JSON.stringify(args), budget);
      const file = typeof args?.file === "string" && args.file.length <= CASE_FACT_LIMITS.fileReferenceChars ? { file: args.file } : {};
      const content = typeof args?.content === "string" ? { status: "measured", utf8Bytes: Buffer.byteLength(args.content),
        utf16Units: args.content.length, sha256: sha256(args.content) } : { status: "unmeasured", reason: "content_not_string" };
      entries.push({ mockIndex, capability: "files.write", ...file, content });
    } catch (error) { entries.push({ mockIndex, capability: "files.write", content: failure(error, signal, budget) }); }
  }
  return { source: "mock-arguments", hostCallExecuted: false, mockReturnsVerified: false,
    total, retained: entries.length, truncated: total > entries.length, entries };
}

/** Deterministic measurements of a specific plan, separate from its acceptance or review verdict. */
export function developmentCaseFacts(plan, { planHash, signal } = {}) {
  signal?.throwIfAborted();
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.cases)
    || plan.activationCases !== undefined && !Array.isArray(plan.activationCases)
    || !["node-json", "node-action", "managed-service"].includes(plan.runtime)
    || ![undefined, 1, 2, 3].includes(plan.schemaVersion)) throw new InputError("计划实测事实缺少有效协议或用例分组");
  const count = plan.cases.length + (plan.activationCases?.length ?? 0);
  if (count > CASE_FACT_LIMITS.cases) throw new InputError("计划实测事实超过200例额度");
  const actualHash = hashValue(plan);
  if (planHash !== undefined && planHash !== actualHash) throw new InputError("计划实测事实与当前计划摘要不一致");
  const cases = [], budget = { bytes: 0, exhausted: false, textWorkExhausted: false, textWorkBudget: {} };
  for (const source of ["cases", "activationCases"]) for (const [caseIndex, test] of (plan[source] ?? []).entries()) {
    signal?.throwIfAborted();
    const identifier = (value) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value);
    if (!test || typeof test !== "object" || Array.isArray(test) || !identifier(test.id) || !identifier(test.acceptanceId)
      || test.actionId !== undefined && !identifier(test.actionId)
      || test.kind !== undefined && !["action", "node-check", "input-rejection"].includes(test.kind)
      || test.inputTarget !== undefined && !["action-value", "task-envelope"].includes(test.inputTarget)
      || test.mocks !== undefined && (!Array.isArray(test.mocks) || test.mocks.length > 100)) throw new InputError("计划实测事实用例无效");
    cases.push({ source, caseIndex, caseId: test.id, caseHash: hashValue(test),
      kind: test.kind ?? (plan.runtime === "node-json" ? "node-json" : "action"),
      ...(test.actionId === undefined ? {} : { actionId: test.actionId }), acceptanceId: test.acceptanceId,
      ...(test.inputTarget === undefined ? {} : { inputTarget: test.inputTarget }),
      input: inputFacts(test, plan, budget, signal), fileWrites: fileWriteFacts(test, budget, signal) });
  }
  return { schemaVersion: 1, planSchemaVersion: plan.schemaVersion ?? 1, planHash: actualHash, runtime: plan.runtime,
    scope: "declared-case-input-and-mock-arguments", generatedCodeExecuted: false, hostCallsExecuted: false, notice,
    totalCases: count, measuredInputs: cases.filter((test) => test.input.status === "measured").length,
    unmeasuredInputs: cases.filter((test) => test.input.status !== "measured").length,
    measuredValueBytes: budget.bytes, measuredTextWorkBytes: budget.textWorkBudget.textBytes ?? 0,
    measurementBudgetExhausted: budget.exhausted || budget.textWorkExhausted, limits: { ...CASE_FACT_LIMITS }, cases };
}
