import type { ServiceManifest } from "./service.mjs";
import type { RequirementDraft } from "./requirements.mjs";
import type { JsonValue } from "./json.mjs";
import type { ApplicationAction, ApplicationPage, ValueSchema } from "./application.mjs";
export type FixtureNode = { op: "value"; value: JsonValue }
  | { op: "object"; fields: Record<string, FixtureNode> }
  | { op: "array"; items: FixtureNode[] }
  | { op: "concat"; items: FixtureNode[] }
  | { op: "repeat"; count: number; value: FixtureNode }
  | { op: "text"; count: number; value: string }
  | { op: "index"; start: number; step: number; prefix?: string; suffix?: string }
  | { op: "json"; value: FixtureNode }
  | { op: "join"; value: FixtureNode; separator: string }
  | { op: "measure"; kind: "sha256" | "utf8-bytes" | "utf16-units"; value: FixtureNode };
export type TestJson = string | { fixture: FixtureNode };
export interface FixtureMetadata { recipeHash: string; sha256: string; bytes: number }
export interface ResolvedTestJson { value: JsonValue; text: string; fixture?: FixtureMetadata }
export interface FixtureBudget { bytes?: number; textBytes?: number }
export interface MaterialCheck { source: "input"; pointer: string; measure: "array-length" | "utf8-bytes" | "utf16-units" | "sha256"; encoding?: "text" | "json"; expected: number | string }
export interface TestAssertion { path: string; expectedJson: TestJson }
export interface TestMock { capability: string; argsJson: TestJson; resultJson: TestJson }
/** A missing kind in historical action cases is retained instead of being filled in. */
export interface DevelopmentCase { id: string; taskId?: string; acceptanceId: string; input: TestJson; assertions: TestAssertion[];
  kind?: "action" | "node-check" | "input-rejection"; entrypoint?: string; actionId?: string; inputTarget?: "action-value" | "task-envelope";
  mocks?: TestMock[]; workflowInputs?: { stepId: string; inputJson: string }[]; materialChecks?: MaterialCheck[] }
export interface DevelopmentTask { id: string; title: string; description: string; requirementIds: string[]; acceptanceIds: string[]; dependsOn: string[]; files: string[] }
export type DevelopmentService = Pick<ServiceManifest, "schemaVersion" | "language" | "host" | "entrypoint" | "operations">
  & Partial<Pick<ServiceManifest, "dependencies" | "resources" | "capabilities" | "dataVersion" | "docker" | "workflow" | "migration">>;
export interface DevelopmentApplication { protocolVersion: 2 | 3; runtime: "node-action" | "managed-service"; entrypoint: string; page: ApplicationPage | null;
  actions: ApplicationAction[]; stateVersion: number; evidenceIds: string[]; service?: DevelopmentService }
export interface PlanFields { summary: string; entrypoint: string; tasks: DevelopmentTask[]; cases: (DevelopmentCase & { taskId: string })[];
  activationChecks?: { acceptanceId: string; executionScope?: "isolated" | "shared"; caseIds: string[] }[]; activationCases?: DevelopmentCase[] }
export type DevelopmentPlan = PlanFields & ({ schemaVersion?: never; runtime: "node-json"; application?: never }
  | { schemaVersion: 2; runtime: "node-action"; application: DevelopmentApplication }
  | { schemaVersion: 3; runtime: "node-action" | "managed-service"; application: DevelopmentApplication });
export interface DevelopmentIssue { path: string; reason: string; referenceId?: string; [key: string]: unknown }
export interface DevelopmentReview { subjectVersion?: number; subjectHash: string; verdict: "pass" | "revise" | "blocked"; summary: string;
  issues: { id: string; blocking: boolean; kind: "code" | "plan" | "architecture" | "environment"; description: string; remedy: string }[] }
export interface DevelopmentWork { summary: string; changedFiles: string[]; knownIssues: string[]; nextAction: string; continue: boolean }
export interface DevelopmentArchitecture {
  draft?: {taskSpec?:RequirementDraft["taskSpec"];interaction?:Pick<NonNullable<RequirementDraft["interaction"]>,"operations">}; deferredVerifications?: { issues?: { requirementId: string; stage?: string }[] } | null | undefined;
  agentId?: string; version?: number; candidateHash?: string; sourceFingerprint?: string; platformHash?: string;
  requirements?: { id: string }[];
  design?: { schemaVersion?: number; execution?: { language: string; hosting: string }; interaction?: { page?:boolean; operations?:boolean };
    connections?: { id: string }[]; acceptance?: { id: string; requirementIds?: string[]; verification?: unknown }[] };
  runtimeCapabilities?: unknown; confirmedRequirementContext?: unknown;
}
export interface DevelopmentCaseResult { caseId: string; status: string; acceptanceId?: string; taskId?: string; actionId?: string; kind?: string;
  actionExecuted?: boolean; evidenceMode?: string; [key: string]: unknown }
export interface DevelopmentReport { id?: string; codeHash: string | null; status: string; results: DevelopmentCaseResult[];
  planHash?: string | null; architectureRef?: { version: number; candidateHash: string }; mode?: string }
export interface SavedDevelopmentReview extends DevelopmentReview { mode: string; planHash: string | null; codeHash: string | null; subjectVersion?: number }
