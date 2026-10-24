import type { UnknownRecord } from "../contracts/json.mjs";
import type { DevelopmentCandidateDesign } from "./development-controller-types.mjs";
import type { DevelopmentTask, DevelopmentCase } from "../contracts/development.mjs";
import type { NeumaTool } from "../runtime/pi-port.mjs";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { objectFields, isRecord, isInteger, isArray } from "../runtime/type-boundary.mjs";
export interface DevelopmentContextPayload extends UnknownRecord { task?: (Partial<DevelopmentTask> & { feedback?: unknown }) | null; handoffs?: { taskId: string }[];
  requirements?: { id: string }[] | undefined; cases?: DevelopmentCase[] | undefined; design?: { [K in keyof DevelopmentCandidateDesign]?: DevelopmentCandidateDesign[K] | undefined }; verificationAssignments?: { acceptanceId: string }[] | undefined }
interface ContextSection { section: string; path: string; totalChars: number; delivery?: string }
interface ContextReceipt { section: string; contentHash: string; messageHash: string }
export interface ContextDelivery { version: number; bindingHash: string; sections: ContextReceipt[] }
interface ContextReference { bindingHash: string; file: string | null; turns: number; contextDelivery?: ContextDelivery | undefined }
interface ProjectedContext extends UnknownRecord { contextSections?: ContextSection[]; contextReuse?: { version: number; bindingHash?: string | undefined; sections: string[]; instruction: string } }
type ContextMessages = ContextEvent["messages"];
export interface PreparedDevelopmentContext { message: string; kind: string | undefined; delivery: ContextDelivery | undefined }
import { InputError } from "../requirements/core.mjs";
import { createHash } from "node:crypto";
import { modelContextValue } from "../runtime/model-context.mjs";
import { deferredObligations, platformOverview } from "../architecture/architecture-model-context.mjs";

const forbiddenSections = new Set(["__proto__", "prototype", "constructor"]);
const sectionPattern = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;
const notice = "部分字段是不完整摘要，或仅提供分页索引。contextSections.delivery=full 表示该字段已完整提供，无须重新读取；summary 表示不完整摘要，paged 表示正文尚未提供。只对当前工作实际需要的 summary/paged 字段调用 read_development_context，按 section 和 nextOffset 读取；不能把摘要当作完整验收依据。";

function validSection(value: unknown) {
  if (typeof value !== "string" || !sectionPattern.test(value) || forbiddenSections.has(value)) {
    throw new InputError("只能读取当前上下文的顶层字段，不能读取路径或原型属性");
  }
  return value;
}

function encoded(value: unknown) {
  try { return JSON.stringify(value); }
  catch { throw new InputError("研发上下文必须能序列化为 JSON"); }
}

function checkedPayload(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new InputError("研发上下文必须为对象");
  return objectFields(value);
}

const lowSurrogate = (value: number) => value >= 0xdc00 && value <= 0xdfff;
const highSurrogate = (value: number) => value >= 0xd800 && value <= 0xdbff;
const dividesCharacter = (value: string, offset: number) => offset > 0 && offset < value.length
  && highSurrogate(value.charCodeAt(offset - 1)) && lowSurrogate(value.charCodeAt(offset));

function shortText(value: unknown, limit: number) {
  if (typeof value !== "string") return undefined;
  if (value.length <= limit) return value;
  const suffix = "…[已截断]";
  let end = Math.max(0, limit - suffix.length);
  if (dividesCharacter(value, end)) end--;
  return value.slice(0, end) + suffix;
}

function brief(value: unknown, fields: string[], limit: number): UnknownRecord {
  const result: UnknownRecord = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const field of fields) {
    const item = objectFields(value)[field];
    if (typeof item === "string") result[field] = shortText(item, limit);
    else if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) result[field] = item;
  }
  return result;
}

function summarizeReport(input: unknown, limit: number, count: number) {
  const report = objectFields(input);
  if (!report || typeof report !== "object" || Array.isArray(report)) return undefined;
  const result = brief(report, ["id", "codeHash", "status", "mode", "taskId", "evidenceMode", "connectionVerified"], 160);
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

function summarizeReview(input: unknown, limit: number, count: number) {
  const review = objectFields(input);
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

function summarizePlan(input: unknown, limit: number) {
  const plan = objectFields(input);
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return undefined;
  return { ...brief(plan, ["runtime", "entrypoint"], 500), ...brief(plan, ["summary"], limit),
    ...(Array.isArray(plan.tasks) ? { taskCount: plan.tasks.length } : {}),
    ...(Array.isArray(plan.cases) ? { caseCount: plan.cases.length } : {}) };
}

function summaries(payload: DevelopmentContextPayload, limit: number, count: number) {
  const result: UnknownRecord = {};
  if (payload.task && typeof payload.task === "object") result.task = {
    ...brief(payload.task, ["id", "status", "attempts", "repairs", "turns", "integration"], 160),
    ...brief(payload.task, ["title", "description", "goal", "summary", "nextAction"], limit),
  };
  if (typeof payload.summary === "string") result.summary = shortText(payload.summary, limit);
  if (payload.report) result.report = summarizeReport(payload.report, limit, count);
  if (payload.feedback && typeof payload.feedback === "object") {
    result.feedback = { ...brief(payload.feedback, ["codeHash"], 160), ...brief(payload.feedback, ["reason"], limit) };
    if (objectFields(payload.feedback).report) objectFields(result.feedback).report = summarizeReport(objectFields(payload.feedback).report, limit, count);
    if (objectFields(payload.feedback).review) objectFields(result.feedback).review = summarizeReview(objectFields(payload.feedback).review, limit, count);
    if (objectFields(payload.feedback).rejectedPlan) objectFields(result.feedback).rejectedPlan = summarizePlan(objectFields(payload.feedback).rejectedPlan, limit);
  }
  if (payload.issues && !Array.isArray(payload.issues) && typeof payload.issues === "object") {
    result.issues = {};
    if (objectFields(payload.issues).review) objectFields(result.issues).review = summarizeReview(objectFields(payload.issues).review, limit, count);
    if (objectFields(payload.issues).rejectedPlan) objectFields(result.issues).rejectedPlan = summarizePlan(objectFields(payload.issues).rejectedPlan, limit);
  }
  if (payload.plan) result.plan = summarizePlan(payload.plan, limit);
  if (payload.previousPlan) result.previousPlan = summarizePlan(payload.previousPlan, limit);
  if (payload.caseFacts) result.caseFacts = { ...brief(payload.caseFacts,
    ["schemaVersion", "planSchemaVersion", "planHash", "runtime", "scope", "planSource", "trust", "generatedCodeExecuted", "hostCallsExecuted",
      "totalCases", "measuredInputs", "unmeasuredInputs", "measuredValueBytes", "measuredTextWorkBytes", "measurementBudgetExhausted"], 160),
    notice: shortText(objectFields(payload.caseFacts).notice, limit) };
  if (payload.developmentRevision) result.developmentRevision = { ...brief(payload.developmentRevision,
    ["schemaVersion", "trust", "status", "planHash", "reason"], 160),
    source: brief(objectFields(payload.developmentRevision).source, ["agentId", "runId", "runVersion", "runRevision", "recordHash"], 160),
    ...(objectFields(payload.developmentRevision).caseFactsReference ? { caseFactsReference: brief(objectFields(payload.developmentRevision).caseFactsReference,
      ["section", "planHash", "trust"], 160) } : {}),
    ...(objectFields(payload.developmentRevision).historicalPlanningReference ? { historicalPlanningReference: {
      ...brief(objectFields(payload.developmentRevision).historicalPlanningReference, ["schemaVersion", "trust", "current", "status", "reason", "planHash"], 160),
      source: brief(objectFields(objectFields(payload.developmentRevision).historicalPlanningReference).source, ["agentId", "runId", "recordHash"], 160),
      cases: objectFields(objectFields(objectFields(objectFields(payload.developmentRevision).historicalPlanningReference).plan).cases).length ?? 0,
      activationCases: objectFields(objectFields(objectFields(objectFields(payload.developmentRevision).historicalPlanningReference).plan).activationCases).length ?? 0,
      detailSection: "developmentRevision", detailPath: "historicalPlanningReference" } } : {}) };
  if (payload.design) result.design = { ...brief(payload.design, ["profile"], 160), ...brief(payload.design, ["rationale"], limit) };
  if (payload.remaining) result.remaining = brief(payload.remaining, ["corrections", "planRevisions", "integrationRepairs"], 160);
  return result;
}

/** Keep durable evidence separate from the initial prompt; all excerpts are explicitly incomplete. */
export function compactDevelopmentContext(payload: DevelopmentContextPayload, maxChars = 16_000): ProjectedContext {
  checkedPayload(payload);
  if (!Number.isSafeInteger(maxChars) || maxChars < 256) throw new InputError("上下文长度上限必须为至少 256 的安全整数");
  const source = encoded(payload);
  if (source.length <= maxChars) {
    try { return structuredClone(payload); }
    catch { throw new InputError("研发上下文无法建立独立副本"); }
  }
  const contextSections: ContextSection[] = [];
  const sectionSources = new Map<string, string>();
  for (const section of Object.keys(payload)) {
    validSection(section);
    const value = encoded(payload[section]);
    if (value !== undefined) {
      contextSections.push({ section, path: `/${section}`, totalChars: value.length });
      sectionSources.set(section, value);
    }
  }
  const describeDelivery = (value: UnknownRecord): ProjectedContext => ({ ...value, contextSections: contextSections.map((item) => ({ ...item,
    delivery: !Object.hasOwn(value, item.section) ? "paged"
      : encoded(value[item.section]) === sectionSources.get(item.section) ? "full" : "summary",
  })) });
  const bindings: UnknownRecord = {};
  for (const field of ["architectureRef", "subjectHash", "mode", "modelBudget", "planningBlockerContract"]) {
    if (Object.hasOwn(payload, field) && payload[field] !== undefined) bindings[field] = structuredClone(payload[field]);
  }
  const base = describeDelivery({ contextTruncated: true, contextNotice: notice, ...bindings });
  if (encoded(base).length > maxChars) throw new InputError("上下文上限不足以保留架构绑定和字段索引，请扩大上限或减少顶层字段");
  for (const [limit, count] of [[4000, 6], [1600, 4], [800, 3], [400, 2], [160, 1], [64, 1], [24, 1]] as const) {
    let result = describeDelivery({ ...base, ...summaries(payload, limit, count) });
    if (encoded(result).length <= maxChars) {
      // Put actual task material ahead of repeated schema guides; full evidence remains pageable.
      for (const field of ["task", "feedback", "report", "plan", "previousPlan", "historicalPlanningDraft", "requirements", "deferredObligations", "platformOverview", "design", "runtimeCapabilities", "verificationAssignments", "deferredVerifications", "runtime", "entrypoint", "application", "checkpoint", "admissionFacts", "caseFacts", "planningWorkspace", "acceptanceAdapterGuide", "developmentRevision", "planningFiles", "valueSchemaGuide", "jsonValueSchemaGuide", "planSchema", "serviceManifestSchema", "testFixtureSchema", "testFixtureLimits"]) {
        if (!Object.hasOwn(payload, field)) continue;
        const candidate = describeDelivery({ ...result, [field]: payload[field] });
        if (encoded(candidate).length <= maxChars) result = { ...candidate, [field]: structuredClone(payload[field]) };
      }
      return result;
    }
  }
  throw new InputError("上下文上限不足以保留任务目标和失败摘要，请扩大上限");
}

export function developmentNodeContext(payload: DevelopmentContextPayload, kind: string) {
  const fields = ["architectureRef", "subjectHash", "mode", "modelBudget", "planningBlockerContract", "task", "feedback", "submissionFeedback", "issues", "remaining",
    "requirements", "design", "verificationAssignments", "entrypoint", "runtime", "application", "checkpoint", "planningWorkspace"];
  if (kind === "planner") fields.push("previousPlan", "historicalPlanningDraft", "caseFacts", "completedTasks", "planningFiles");
  if (kind === "developer") fields.push("cases", "activationCases", "activationChecks");
  if (kind === "reviewer") fields.push("plan", "planHash", "report", "codeHash", "caseFacts", "admissionFacts");
  const result: DevelopmentContextPayload = Object.fromEntries(fields.filter(key => payload[key] !== undefined).map(key => [key, payload[key]]));
  if (result.task && payload.feedback && encoded(objectFields(result.task).feedback) === encoded(payload.feedback)) {
    const { feedback: _duplicate, ...task } = objectFields(result.task);
    result.task = task;
  }
  result.platformOverview = platformOverview(payload);
  if (payload.deferredVerifications) result.deferredObligations = deferredObligations(payload.deferredVerifications);
  if (kind === "developer" && payload.handoffs) {
    const dependencies = new Set([payload.task?.id, ...payload.task?.dependsOn ?? []]);
    result.handoffs = payload.handoffs.filter(item => dependencies.has(item.taskId));
  }
  if (kind === "developer" && payload.task?.requirementIds?.length && payload.task?.acceptanceIds?.length) {
    const requirements = new Set(payload.task.requirementIds), acceptance = new Set(payload.task.acceptanceIds);
    result.requirements = payload.requirements?.filter(item => requirements.has(item.id));
    result.cases = payload.cases?.filter(item => item.taskId === payload.task!.id || acceptance.has(item.acceptanceId));
    const design = payload.design;
    if (design) {
      const coverage = design.coverage?.filter(item => requirements.has(item.requirementId));
      const components = new Set(coverage?.flatMap(item => item.componentIds) ?? []);
      const steps = new Set(design.steps?.filter(item => components.has(item.componentId)).map(item => item.id));
      let added = true;
      while (added) {
        added = false;
        for (const step of design.steps ?? []) if (steps.has(step.id)) for (const id of step.dependsOn ?? []) if (!steps.has(id)) { steps.add(id); added = true; }
      }
      for (const step of design.steps ?? []) if (steps.has(step.id)) components.add(step.componentId);
      result.design = { ...Object.fromEntries(["profile", "execution", "interaction", "connections", "capabilities", "state", "failureHandling", "unknowns"]
        .filter(key => objectFields(design)[key] !== undefined).map(key => [key, objectFields(design)[key]])), coverage,
        components: design.components?.filter(item => components.has(item.id)), steps: design.steps?.filter(item => steps.has(item.id)),
        acceptance: design.acceptance?.filter(item => acceptance.has(item.id)) };
    }
    result.verificationAssignments = payload.verificationAssignments?.filter(item => acceptance.has(item.acceptanceId));
  }
  return result;
}

function initialDevelopmentContext(payload: DevelopmentContextPayload, maxChars: number, kind?: string): ProjectedContext {
  if (!kind) return compactDevelopmentContext(payload, maxChars);
  const projected = developmentNodeContext(payload, kind);
  const contextNotice = notice + " summary也可能是当前任务的完整子集；其他任务与全量回归原文仍可读取。";
  const sections = Object.keys(payload).filter(section => encoded(payload[section]) !== undefined).map(section => ({ section, path: `/${section}`,
    totalChars: encoded(payload[section]).length, delivery: "summary" }));
  const overhead = encoded({ contextTruncated: true, contextNotice, contextSections: sections }).length + 2;
  const initial = compactDevelopmentContext(projected, maxChars - overhead);
  return { ...initial, contextTruncated: true, contextNotice, contextSections: sections.map(item => ({ ...item,
    delivery: !Object.hasOwn(initial, item.section) ? "paged"
      : encoded(initial[item.section]) === encoded(payload[item.section]) ? "full" : "summary" })) };
}

const contextDigest = (value: string) => createHash("sha256").update(value).digest("hex");
const deliveryMetadata = new Set(["contextTruncated", "contextNotice", "contextSections", "contextReuse", "architectureRef", "subjectHash", "mode", "modelBudget", "planningBlockerContract", "task", "remaining"]);

function deliveredUserMessages(messages: ContextMessages | undefined) {
  const completed = new Map<string, string>();
  let current: string | undefined, text: string | undefined;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message.role === "user") {
      const content = message.content;
      text = typeof content === "string" ? content : Array.isArray(content) && content.length === 1
        && content[0]?.type === "text" ? content[0].text : undefined;
      current = typeof text === "string" ? contextDigest(text) : undefined;
    } else if (current && message.role === "assistant" && ["stop", "toolUse"].includes(message.stopReason)) completed.set(current, text!);
  }
  return completed;
}

/** A receipt refers to exact host messages still present in Pi's active context, never its lossy summary. */
export function developmentContextMessage(payload: DevelopmentContextPayload, maxChars: number, { reference, messages, kind }: { reference?: ContextReference | undefined; messages?: ContextMessages | undefined; kind?: string } = {}): PreparedDevelopmentContext {
  const initial = initialDevelopmentContext(payload, maxChars, kind), sections = initial.contextSections
    ?? Object.keys(payload).filter((section) => encoded(payload[section]) !== undefined)
      .map((section) => ({ section, path: `/${section}`, totalChars: encoded(payload[section]).length, delivery: "full" }));
  const bindingHash = reference?.bindingHash;
  const prior = reference?.contextDelivery;
  const completed = deliveredUserMessages(messages), receipts = new Map<string, ContextReceipt>();
  if (typeof bindingHash === "string" && typeof reference?.file === "string" && Number.isSafeInteger(reference.turns) && reference.turns > 0
    && prior?.version === 1 && prior.bindingHash === bindingHash && Array.isArray(prior.sections)) {
    for (const item of prior.sections) if (item && typeof item.section === "string" && /^[a-f0-9]{64}$/.test(item.contentHash ?? "")
      && /^[a-f0-9]{64}$/.test(item.messageHash ?? "") && completed.has(item.messageHash)) {
      try {
        const delivered = objectFields(JSON.parse(completed.get(item.messageHash)!));
        if (delivered && Object.hasOwn(delivered, item.section) && contextDigest(encoded(delivered[item.section])) === item.contentHash
          && (!delivered.contextSections || isArray(delivered.contextSections) && delivered.contextSections.some((rawEntry) => { const entry = objectFields(rawEntry); return entry.section === item.section && entry.delivery === "full"; }))) receipts.set(item.section, item);
      } catch { /* A receipt must prove exact original contents, not merely refer to an existing message. */ }
    }
  }
  let prepared = initial;
  const reused = [];
  for (const item of sections) {
    if (item.delivery !== "full" || deliveryMetadata.has(item.section)) continue;
    const receipt = receipts.get(item.section);
    if (receipt?.contentHash === contextDigest(encoded(payload[item.section]))) reused.push(item.section);
  }
  if (reused.length) {
    const reuseSet = new Set(reused), candidate = { ...initial };
    for (const section of reused) delete candidate[section];
    candidate.contextSections = sections.map((item) => reuseSet.has(item.section) ? { ...item, delivery: "session" } : { ...item });
    candidate.contextReuse = { version: 1, bindingHash, sections: reused,
      instruction: "delivery=session的字段已由宿主核实完整原消息仍在当前Pi会话，并已收到成功回复；继续使用这些原文，不必重复读取。新值和新反馈以本轮为准；完整当前事实始终可用read_development_context按section精确读取。压缩摘要不能替代原文证明。" };
    if (encoded(candidate).length < encoded(initial).length && encoded(candidate).length <= maxChars) prepared = candidate;
  }
  const message = encoded(prepared), messageHash = contextDigest(message), full = new Map(sections.map((item) => [item.section, item.delivery]));
  const activeReused = new Set(prepared.contextReuse?.sections ?? []);
  const delivered = Object.keys(payload).filter((section) => !deliveryMetadata.has(section) && full.get(section) === "full")
    .map((section) => activeReused.has(section) ? receipts.get(section)!
      : { section, contentHash: contextDigest(encoded(payload[section])), messageHash });
  return { message, kind, delivery: typeof bindingHash === "string" ? { version: 1, bindingHash, sections: delivered } : undefined };
}

export function restoreDevelopmentContext(messages: ContextMessages, payload: DevelopmentContextPayload, maxChars: number, prepared?: PreparedDevelopmentContext | undefined): ContextMessages {
  const reused = prepared && objectFields(objectFields(JSON.parse(prepared.message)).contextReuse).sections;
  if (reused === undefined || reused === null) return messages;
  if (!isArray(reused) || reused.some(section => typeof section !== "string")) throw new InputError("研发上下文复用记录格式无效");
  if (!reused.length) return messages;
  const completed = deliveredUserMessages(messages), receipts = new Map(prepared!.delivery!.sections.map((item) => [item.section, item]));
  if (reused.every((section) => typeof section === "string" && completed.has(receipts.get(section)?.messageHash ?? ""))) return messages;
  const full = encoded(initialDevelopmentContext(payload, maxChars, prepared!.kind));
  const target = messages.findLastIndex((message) => message.role === "user" && (typeof message.content === "string"
    ? message.content : message.content?.length === 1 && message.content[0]?.type === "text" ? message.content[0].text : undefined) === prepared!.message);
  // Request-local projection runs after native compaction and before each model request.
  // It preserves tool-call/result ordering and does not manufacture persisted history.
  return target < 0 ? [...messages, { role: "user", content: [{ type: "text", text: full }], timestamp: Date.now() }]
    : messages.map((message, index) => index === target ? { ...message, content: [{ type: "text", text: full }] } : message);
}

export function createContextReadTool(getPayload: () => unknown | Promise<unknown>): NeumaTool {
  if (typeof getPayload !== "function") throw new InputError("上下文读取工具需要当前任务上下文入口");
  return {
    name: "read_development_context", label: "分页读取当前研发资料",
    description: "只读当前轮完整资料。section 使用 contextSections 字段名；可用pointer直接读取JSON子字段，offset/nextOffset为UTF-16字符索引，不访问文件。",
    parameters: { type: "object", properties: {
      section: { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z_][A-Za-z0-9_]*$", description: "原始输入顶层字段名，例如 report、feedback、plan、cases" },
      pointer: { type: "string", maxLength: 500, description: "可选JSON Pointer，例如 /properties/cases；缺省读取整个section" },
      offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 8000 },
    }, required: ["section"], additionalProperties: false },
    executionMode: "sequential",
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted();
      if (!params || typeof params !== "object" || Array.isArray(params)
        || Object.keys(params).some((key) => !["section", "pointer", "offset", "limit"].includes(key))) throw new InputError("上下文分页参数无效");
      const { section: rawSection, pointer = "", offset = 0, limit = 4000 } = objectFields(params);
      const section = validSection(rawSection);
      if (!isInteger(offset) || offset < 0 || !isInteger(limit) || limit < 1 || limit > 8000) {
        throw new InputError("上下文分页位置或长度无效；每页最多 8000 字符");
      }
      const payload = checkedPayload(await getPayload());
      signal?.throwIfAborted();
      if (!Object.hasOwn(payload, section)) {
        const sections = Object.keys(payload).filter((key) => sectionPattern.test(key) && !forbiddenSections.has(key));
        throw new InputError("当前轮上下文不存在这个顶层字段；可读取的section：" + JSON.stringify(sections));
      }
      const source = encoded(modelContextValue(payload, section, pointer));
      if (source === undefined) throw new InputError("当前字段没有可读取的 JSON 内容");
      if (offset > source.length || dividesCharacter(source, offset)) throw new InputError("续读位置无效，请使用上一页返回的 nextOffset");
      let end = Math.min(source.length, offset + limit);
      if (dividesCharacter(source, end)) end--;
      if (end === offset && offset < source.length) throw new InputError("当前字符需要两个字符索引位置，请将分页长度至少设为 2");
      const truncated = end < source.length;
      const page = { section, ...(pointer ? { pointer } : {}), offset, text: source.slice(offset, end), truncated, nextOffset: truncated ? end : null, totalChars: source.length };
      return { content: [{ type: "text", text: JSON.stringify(page) }], details: {} };
    },
  };
}
