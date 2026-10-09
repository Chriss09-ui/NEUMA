import { InputError } from "../requirements/core.mjs";

const forbiddenSections = new Set(["__proto__", "prototype", "constructor"]);
const sectionPattern = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;
const notice = "这里只提供不完整摘要。完整计划、用例和失败证据请调用 read_development_context，按 contextSections 的 section 分页读取；不能把摘要当作完整验收依据。";

function validSection(value) {
  if (typeof value !== "string" || !sectionPattern.test(value) || forbiddenSections.has(value)) {
    throw new InputError("只能读取当前上下文的顶层字段，不能读取路径或原型属性");
  }
  return value;
}

function encoded(value) {
  try { return JSON.stringify(value); }
  catch { throw new InputError("研发上下文必须能序列化为 JSON"); }
}

function checkedPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new InputError("研发上下文必须为对象");
  return value;
}

const lowSurrogate = (value) => value >= 0xdc00 && value <= 0xdfff;
const highSurrogate = (value) => value >= 0xd800 && value <= 0xdbff;
const dividesCharacter = (value, offset) => offset > 0 && offset < value.length
  && highSurrogate(value.charCodeAt(offset - 1)) && lowSurrogate(value.charCodeAt(offset));

function shortText(value, limit) {
  if (typeof value !== "string") return undefined;
  if (value.length <= limit) return value;
  const suffix = "…[已截断]";
  let end = Math.max(0, limit - suffix.length);
  if (dividesCharacter(value, end)) end--;
  return value.slice(0, end) + suffix;
}

function brief(value, fields, limit) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const field of fields) {
    const item = value[field];
    if (typeof item === "string") result[field] = shortText(item, limit);
    else if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) result[field] = item;
  }
  return result;
}

function summarizeReport(report, limit, count) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return undefined;
  const result = brief(report, ["id", "codeHash", "status", "mode", "taskId"], 160);
  if (typeof report.summary === "string") result.summary = shortText(report.summary, limit);
  if (Array.isArray(report.results)) {
    const failed = report.results.filter((item) => item && item.status !== "passed");
    result.totalResults = report.results.length;
    result.nonPassingResults = failed.length;
    result.failureSummaries = failed.slice(0, count).map((item) => ({
      ...brief(item, ["caseId", "taskId", "acceptanceId", "status", "exitCode"], 160),
      ...brief(item, ["reason", "input", "stderr", "stdout"], limit),
    }));
    if (failed.length > count) result.omittedFailureCount = failed.length - count;
  }
  return result;
}

function summarizeReview(review, limit, count) {
  if (!review || typeof review !== "object" || Array.isArray(review)) return undefined;
  const result = brief(review, ["verdict"], 160);
  if (typeof review.summary === "string") result.summary = shortText(review.summary, limit);
  if (Array.isArray(review.issues)) {
    const issues = [...review.issues].sort((left, right) => Number(Boolean(right?.blocking)) - Number(Boolean(left?.blocking)));
    result.issueSummaries = issues.slice(0, count).map((item) => ({
      ...brief(item, ["id", "kind", "blocking"], 160), ...brief(item, ["description", "remedy"], limit),
    }));
    result.totalIssues = issues.length;
  }
  return result;
}

function summarizePlan(plan, limit) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return undefined;
  return { ...brief(plan, ["runtime", "entrypoint"], 500), ...brief(plan, ["summary"], limit),
    ...(Array.isArray(plan.tasks) ? { taskCount: plan.tasks.length } : {}),
    ...(Array.isArray(plan.cases) ? { caseCount: plan.cases.length } : {}) };
}

function summaries(payload, limit, count) {
  const result = {};
  if (payload.task && typeof payload.task === "object") result.task = {
    ...brief(payload.task, ["id", "status", "attempts", "repairs", "turns", "integration"], 160),
    ...brief(payload.task, ["title", "description", "goal", "summary", "nextAction"], limit),
  };
  if (typeof payload.summary === "string") result.summary = shortText(payload.summary, limit);
  if (payload.report) result.report = summarizeReport(payload.report, limit, count);
  if (payload.feedback && typeof payload.feedback === "object") {
    result.feedback = { ...brief(payload.feedback, ["codeHash"], 160), ...brief(payload.feedback, ["reason"], limit) };
    if (payload.feedback.report) result.feedback.report = summarizeReport(payload.feedback.report, limit, count);
    if (payload.feedback.review) result.feedback.review = summarizeReview(payload.feedback.review, limit, count);
    if (payload.feedback.rejectedPlan) result.feedback.rejectedPlan = summarizePlan(payload.feedback.rejectedPlan, limit);
  }
  if (payload.issues && !Array.isArray(payload.issues) && typeof payload.issues === "object") {
    result.issues = {};
    if (payload.issues.review) result.issues.review = summarizeReview(payload.issues.review, limit, count);
    if (payload.issues.rejectedPlan) result.issues.rejectedPlan = summarizePlan(payload.issues.rejectedPlan, limit);
  }
  if (payload.plan) result.plan = summarizePlan(payload.plan, limit);
  if (payload.previousPlan) result.previousPlan = summarizePlan(payload.previousPlan, limit);
  if (payload.design) result.design = { ...brief(payload.design, ["profile"], 160), ...brief(payload.design, ["rationale"], limit) };
  if (payload.remaining) result.remaining = brief(payload.remaining, ["corrections", "planRevisions", "integrationRepairs"], 160);
  return result;
}

/** Keep durable evidence separate from the initial prompt; all excerpts are explicitly incomplete. */
export function compactDevelopmentContext(payload, maxChars = 16_000) {
  checkedPayload(payload);
  if (!Number.isSafeInteger(maxChars) || maxChars < 256) throw new InputError("上下文长度上限必须为至少 256 的安全整数");
  const source = encoded(payload);
  if (source.length <= maxChars) {
    try { return structuredClone(payload); }
    catch { throw new InputError("研发上下文无法建立独立副本"); }
  }
  const contextSections = [];
  for (const section of Object.keys(payload)) {
    validSection(section);
    const value = encoded(payload[section]);
    if (value !== undefined) contextSections.push({ section, path: `/${section}`, totalChars: value.length });
  }
  const bindings = {};
  for (const field of ["architectureRef", "subjectHash", "mode"]) {
    if (Object.hasOwn(payload, field) && payload[field] !== undefined) bindings[field] = structuredClone(payload[field]);
  }
  const base = { contextTruncated: true, contextNotice: notice, ...bindings, contextSections };
  if (encoded(base).length > maxChars) throw new InputError("上下文上限不足以保留架构绑定和字段索引，请扩大上限或减少顶层字段");
  for (const [limit, count] of [[4000, 6], [1600, 4], [800, 3], [400, 2], [160, 1], [64, 1], [24, 1]]) {
    const result = { ...base, ...summaries(payload, limit, count) };
    if (encoded(result).length <= maxChars) return result;
  }
  throw new InputError("上下文上限不足以保留任务目标和失败摘要，请扩大上限");
}

export function createContextReadTool(getPayload) {
  if (typeof getPayload !== "function") throw new InputError("上下文读取工具需要当前任务上下文入口");
  return {
    name: "read_development_context", label: "分页读取当前研发资料",
    description: "只读当前轮输入的一个顶层字段。section 使用 contextSections 的字段名；offset/nextOffset 为 UTF-16 字符索引，读取完整原始计划、用例或证据，不访问文件。",
    parameters: { type: "object", properties: {
      section: { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z_][A-Za-z0-9_]*$", description: "原始输入顶层字段名，例如 report、feedback、plan、cases" },
      offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 8000 },
    }, required: ["section"], additionalProperties: false },
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted();
      if (!params || typeof params !== "object" || Array.isArray(params)
        || Object.keys(params).some((key) => !["section", "offset", "limit"].includes(key))) throw new InputError("上下文分页参数无效");
      const { section, offset = 0, limit = 4000 } = params;
      validSection(section);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 8000) {
        throw new InputError("上下文分页位置或长度无效；每页最多 8000 字符");
      }
      const payload = checkedPayload(await getPayload());
      signal?.throwIfAborted();
      if (!Object.hasOwn(payload, section)) throw new InputError("当前轮上下文不存在这个顶层字段");
      const source = encoded(payload[section]);
      if (source === undefined) throw new InputError("当前字段没有可读取的 JSON 内容");
      if (offset > source.length || dividesCharacter(source, offset)) throw new InputError("续读位置无效，请使用上一页返回的 nextOffset");
      let end = Math.min(source.length, offset + limit);
      if (dividesCharacter(source, end)) end--;
      if (end === offset && offset < source.length) throw new InputError("当前字符需要两个字符索引位置，请将分页长度至少设为 2");
      const truncated = end < source.length;
      const page = { section, offset, text: source.slice(offset, end), truncated, nextOffset: truncated ? end : null, totalChars: source.length };
      return { content: [{ type: "text", text: JSON.stringify(page) }], details: {} };
    },
  };
}
