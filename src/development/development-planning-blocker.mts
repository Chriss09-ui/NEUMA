import { objectFields } from "../runtime/type-boundary.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import type { DevelopmentArchitecture } from "../contracts/development.mjs";
interface BlockerInput { subjectHash: string; summary: string; issues: { id: string; kind: "architecture" | "environment"; description: string; remedy: string;
  references: { source: "design" | "runtimeCapabilities" | "acceptanceAdapterGuide"; path: string; quote: string }[] }[] }
export interface PlanningBlockerRecord { id: string; agentId: string; architecture: DevelopmentArchitecture; architectureRef?: { version: number; candidateHash: string };
  status?: string; phase?: string; feedback?: { report?: unknown } | null }
export interface PlanningBlockerReport { schemaVersion: number; type: string; role: string; trust: string; status: string; source: ReturnType<typeof binding>; subjectHash: string;
  summary: string; issues: (BlockerInput["issues"][number] & { blocking: boolean })[]; reportHash?: string }
import { Ajv } from "ajv";
import { InputError } from "../requirements/core.mjs";
import { hashValue } from "./development-contract.mjs";

const object = <P extends Record<string, ToolSchema>>(properties: P) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const text = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const identifier = { ...text(80), pattern: "^[A-Za-z][A-Za-z0-9_-]*$" };
export const PLANNING_BLOCKER_MAX_BYTES = 64 * 1024;
export const PLANNING_BLOCKER_SCHEMA = object({
  subjectHash: { type: "string", pattern: "^[a-f0-9]{64}$" }, summary: text(2000),
  issues: { type: "array", minItems: 1, maxItems: 8, items: object({
    id: identifier, kind: { type: "string", enum: ["architecture", "environment"] }, description: text(2000), remedy: text(2000),
    references: { type: "array", minItems: 1, maxItems: 8, items: object({
      source: { type: "string", enum: ["design", "runtimeCapabilities", "acceptanceAdapterGuide"] },
      path: { type: "string", maxLength: 1000 }, quote: text(1000),
    }) },
  }) },
});
const valid = new Ajv({ allErrors: false, strict: true }).compile<BlockerInput>(PLANNING_BLOCKER_SCHEMA);
const outcomes = new WeakSet();
const failure = (reason: string) => Object.assign(new InputError("规划阻断尚未接受：" + reason), {
  developmentIssue: { path: "planningBlocker", reason: "invalid_planning_blocker" },
});

function binding(record: PlanningBlockerRecord, guide: unknown) {
  const architecture = record.architecture;
  return { agentId: record.agentId, runId: record.id, architectureRef: structuredClone(record.architectureRef ?? null),
    architectureHash: hashValue(architecture), sourceFingerprint: architecture.sourceFingerprint ?? null,
    requirementHash: hashValue(architecture.requirements ?? null), designHash: hashValue(architecture.design),
    platformHash: architecture.platformHash ?? null, runtimeCapabilityHash: hashValue(architecture.runtimeCapabilities ?? null),
    confirmedContextHash: hashValue(architecture.confirmedRequirementContext ?? null),
    deferredContextHash: hashValue(architecture.deferredVerifications ?? null), adapterGuideHash: hashValue(guide) };
}

function selected(value: unknown, pointer: string) {
  if (pointer === "") return value;
  if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer)) throw failure("引用路径无效");
  let current = value;
  for (const key of pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (["__proto__", "prototype", "constructor"].includes(key) || !current || typeof current !== "object") throw failure("引用路径不存在");
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw failure("引用路径不存在");
    current = descriptor.value;
  }
  return current;
}

/** This accepts a planner's bounded technical opinion, never an independent review or a plan. */
export function createDevelopmentPlanningBlocker(record: PlanningBlockerRecord, { acceptanceAdapterGuide = null }: { acceptanceAdapterGuide?: unknown } = {}) {
  const source = binding(record, acceptanceAdapterGuide), subjectHash = hashValue(source);
  const materials = structuredClone({ design: record.architecture.design,
    runtimeCapabilities: record.architecture.runtimeCapabilities ?? null, acceptanceAdapterGuide });
  const context = { subjectHash, tool: "submit_development_blocker", trust: "untrusted-reference",
    scope: "仅报告阻止当前规划的架构或环境问题，不修改需求、设计、验收或权限，不代表独立评审或测试通过。",
    references: Object.entries(materials).filter(([, value]) => value !== null).map(([name]) => ({ source: name, section: name })) };
  return { context, parameters: { ...PLANNING_BLOCKER_SCHEMA, properties: { ...PLANNING_BLOCKER_SCHEMA.properties,
    subjectHash: { ...PLANNING_BLOCKER_SCHEMA.properties.subjectHash, enum: [subjectHash] } } },
    submit(value: unknown, current = record) {
      if (!valid(value) || Buffer.byteLength(JSON.stringify(value)) > PLANNING_BLOCKER_MAX_BYTES) throw failure("请使用本轮公开结构与限额");
      if (value.subjectHash !== subjectHash || hashValue(binding(current, acceptanceAdapterGuide)) !== subjectHash
        || current.architectureRef?.candidateHash !== source.designHash
        || current.architecture.candidateHash != null && current.architecture.candidateHash !== source.designHash
        || !Number.isSafeInteger(current.architectureRef?.version) || current.architectureRef.version < 1
        || current.architecture.version != null && current.architecture.version !== current.architectureRef.version)
        throw failure("方案、需求或平台版本已变化，请使用本轮材料");
      if (!value.summary.trim() || value.issues.some((issue) => !issue.description.trim() || !issue.remedy.trim())) throw failure("请说明具体阻断及下一步核实方式");
      if (new Set(value.issues.map((issue) => issue.id)).size !== value.issues.length) throw failure("问题编号不能重复");
      for (const issue of value.issues) for (const reference of issue.references) {
        if (materials[reference.source] === null) throw failure("本轮没有该引用来源");
        const entry = selected(materials[reference.source], reference.path);
        const original = typeof entry === "string" ? entry : JSON.stringify(entry);
        if (!reference.quote.trim() || typeof original !== "string" || !original.includes(reference.quote)) throw failure("引用必须与该路径当前原文逐字匹配");
      }
      const report: PlanningBlockerReport = { schemaVersion: 1, type: "planning-blocker", role: "planner", trust: "untrusted-reference", status: "blocked",
        source, subjectHash, summary: value.summary, issues: value.issues.map((issue) => ({ ...structuredClone(issue), blocking: true })) };
      if (Buffer.byteLength(JSON.stringify(report)) > PLANNING_BLOCKER_MAX_BYTES) throw failure("阻断报告超过保存限额");
      report.reportHash = hashValue(report);
      if (Buffer.byteLength(JSON.stringify(report)) > PLANNING_BLOCKER_MAX_BYTES) throw failure("阻断报告超过保存限额");
      return report;
    },
  };
}

export function planningBlockerOutcome(report: PlanningBlockerReport) {
  const result = { report }; outcomes.add(result); return result;
}

export function isPlanningBlockerOutcome(value: unknown): value is { report: PlanningBlockerReport } { return Boolean(value && typeof value === "object" && outcomes.has(value)); }

export function samePlanningBlocker(record: PlanningBlockerRecord | null | undefined, architecture: DevelopmentArchitecture, acceptanceAdapterGuide: unknown) {
  const report = objectFields(record?.feedback?.report);
  if (record?.status !== "blocked" || record.phase !== "planning"
    || report?.schemaVersion !== 1 || report.type !== "planning-blocker" || report.role !== "planner"
    || report.trust !== "untrusted-reference" || report.status !== "blocked"
    || !Array.isArray(report.issues) || !report.issues.some((issue: unknown) => objectFields(issue).kind === "architecture")) return false;
  try {
    const current = { ...record, architecture, architectureRef: { version: architecture.version!, candidateHash: architecture.candidateHash! } };
    const { reportHash, ...body } = report;
    if (hashValue(body) !== reportHash) return false;
    const value = { subjectHash: report.subjectHash, summary: report.summary,
      issues: (report.issues as unknown[]).map((entry) => { const { blocking, ...issue } = objectFields(entry); return issue; }) };
    const checked = createDevelopmentPlanningBlocker(current, { acceptanceAdapterGuide }).submit(value, current);
    return hashValue(checked) === hashValue(report);
  } catch { return false; }
}
