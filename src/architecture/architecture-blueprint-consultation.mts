import type { UnknownRecord } from "../contracts/json.mjs";
import type { RequirementItem } from "../contracts/architecture.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import { InputError } from "../requirements/core.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import { modelContextValue } from "../runtime/model-context.mjs";
import { architectureToolValidation } from "./architecture-tool-diagnostics.mjs";

export const BLUEPRINT_CONSULTATION_LIMIT = 3;
export const BLUEPRINT_CONSULTATION_CALL_LIMIT = 3;
export interface BlueprintConsultationAssignment {
  topic: "platform" | "interfaces" | "verification";
  question: string;
  requirementIds: string[];
}
export interface BlueprintConsultationResult {
  conclusion: string; recommendations: string[]; unknowns: string[];
  references: { section: string; pointer: string }[];
}
const text = (maxLength: number): ToolSchema => ({ type: "string", minLength: 1, maxLength });
const identifier = { ...text(100), pattern: "^[A-Za-z][A-Za-z0-9_-]*$" };
export const BLUEPRINT_CONSULTATION_ASSIGNMENT_SCHEMA: ToolSchema = {
  type: "object", additionalProperties: false, required: ["topic", "question", "requirementIds"], properties: {
    topic: { type: "string", enum: ["platform", "interfaces", "verification"] }, question: text(1000),
    requirementIds: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: identifier },
  },
};
export const BLUEPRINT_CONSULTATION_RESULT_SCHEMA: ToolSchema = {
  type: "object", additionalProperties: false, required: ["conclusion", "recommendations", "unknowns", "references"], properties: {
    conclusion: text(3000),
    recommendations: { type: "array", maxItems: 6, items: text(1000) },
    unknowns: { type: "array", maxItems: 6, items: text(1000) },
    references: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["section", "pointer"], properties: {
      section: text(80), pointer: { type: "string", maxLength: 500 },
    } } },
  },
};

export function validateBlueprintConsultationAssignment(value: unknown, requirements?: RequirementItem[]) {
  if (!architectureToolValidation(value, BLUEPRINT_CONSULTATION_ASSIGNMENT_SCHEMA).valid)
    throw new InputError("蓝图专项分析需要明确主题、一个局部问题及责任需求编号。");
  const assignment = value as BlueprintConsultationAssignment;
  if (!assignment.question.trim() || requirements && assignment.requirementIds.some(id => !requirements.some(item => item.id === id)))
    throw new InputError("蓝图专项分析必须引用本轮实际需求，不能扩大问题范围。");
  return structuredClone(assignment);
}

export function blueprintConsultationContext(context: { requirements: RequirementItem[]; platformSnapshot?: unknown; runtimeCapabilities?: unknown; acceptanceAdapterGuide?: unknown }, assignment: BlueprintConsultationAssignment) {
  return {
    assignment,
    requirements: context.requirements.filter(item => assignment.requirementIds.includes(item.id)),
    ...(context.platformSnapshot ? { platformSnapshot: context.platformSnapshot } : {}),
    ...(context.runtimeCapabilities ? { runtimeCapabilities: context.runtimeCapabilities } : {}),
    ...(assignment.topic === "verification" && context.acceptanceAdapterGuide ? { acceptanceAdapterGuide: context.acceptanceAdapterGuide } : {}),
  };
}

export function validateBlueprintConsultationResult(value: unknown, context: UnknownRecord): BlueprintConsultationResult {
  const feedback = architectureToolValidation(value, BLUEPRINT_CONSULTATION_RESULT_SCHEMA);
  if (!feedback.valid) throw Object.assign(new InputError("蓝图专项分析提交结构无效"), {
    validationIssue: feedback.issues[0], validationIssues: feedback.issues,
  });
  const result = value as BlueprintConsultationResult;
  for (const reference of result.references) {
    if (!Object.hasOwn(context, reference.section) || reference.section === "assignment")
      throw new InputError("专项分析引用必须来自本次分派的实际需求或平台事实。");
    modelContextValue(context, reference.section, reference.pointer);
  }
  if (!objectFields(context).requirements) throw new InputError("专项分析缺少责任需求。");
  return structuredClone(result);
}
