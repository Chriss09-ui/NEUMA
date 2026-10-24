import type { DevelopmentPlan, DevelopmentTask, DevelopmentReview, DevelopmentWork } from "../../src/contracts/development.mjs";
import type { RequirementItem } from "../../src/contracts/architecture.mjs";
import { ARCHITECTURE_VERSION, designHash, requirementItems } from "../../src/architecture/architecture-contract.mjs";
import { validDraft, validDesign, passingReview } from "./architecture.mjs";

export function developmentArchitecture(): ReturnType<typeof developmentArchitectureValue>;
export function developmentArchitecture<T extends object>(overrides: T): Omit<ReturnType<typeof developmentArchitectureValue>, keyof T> & T;
export function developmentArchitecture(overrides: object = {}) { return developmentArchitectureValue(overrides); }
function developmentArchitectureValue(overrides: object = {}) {
  const draft = validDraft(), requirements = requirementItems(draft);
  const design = validDesign(requirements, { profile: "workflow",
    rationale: "需要实现带验证步骤的执行流程", state: { mode: "persistent", reason: "保存流程进度" },
    capabilities: [{ id: "workflow_execution", status: "needs_development", reason: "实现流程协调" }] });
  const candidateHash = designHash(design);
  return { agentId: "weekly", name: "周报助手", version: 1, contractVersion: ARCHITECTURE_VERSION,
    status: "passed" as const, delivery: "needs_development" as const, buildable: false, requirements, design,
    candidateHash, review: passingReview(candidateHash), issues: [], draft, ...overrides };
}

export function developmentPlan(architecture: { requirements: RequirementItem[]; design: { acceptance: { id: string; kind?: string; input: string }[] } } = developmentArchitecture()): DevelopmentPlan {
  const acceptance = architecture.design.acceptance;
  return { summary: "实现核心处理和边界检查", runtime: "node-json", entrypoint: "main.mjs",
    tasks: [
      { id: "core", title: "核心处理", description: "实现主要处理及输入检查", requirementIds: architecture.requirements.map((item) => item.id),
        acceptanceIds: acceptance.slice(0, 2).map((item) => item.id), dependsOn: [], files: ["main.mjs"] },
      { id: "guard", title: "边界检查", description: "实现范围约束和工具失败处理", requirementIds: ["externalAction", "deliverable"],
        acceptanceIds: acceptance.slice(2).map((item) => item.id), dependsOn: ["core"], files: ["guard.mjs"] },
    ], cases: acceptance.map((item, index) => ({ id: `case_${item.id}`, taskId: index < 2 ? "core" : "guard",
      acceptanceId: item.id, input: item.kind === "missing_input" ? "" : item.input,
      assertions: [{ path: "", expectedJson: JSON.stringify({ scenario: item.id, verified: true }) }] })) };
}

export function developmentReview(subjectHash: string, overrides: Partial<DevelopmentReview> = {}): DevelopmentReview {
  return { subjectHash, verdict: "pass", summary: "模拟评审通过", issues: [], ...overrides };
}

export function developmentIssue(kind: DevelopmentReview["issues"][number]["kind"] = "code", id = "missing_behavior") {
  return { id, blocking: true, kind, description: "需补齐当前场景的处理", remedy: "按失败用例修复并重新验证" };
}

export function developmentWork(task: Pick<DevelopmentTask, "title" | "files">, overrides: Partial<DevelopmentWork> = {}) {
  return { summary: `已实现 ${task.title}`, changedFiles: [...task.files], knownIssues: [], nextAction: "提交独立验收", continue: false, ...overrides };
}
