import type { AcceptanceItem, AcceptanceAdapterId, AcceptanceVerification, AcceptanceStage, AcceptanceStatus, AcceptanceLedger, AcceptanceLedgerItem, AcceptanceBinding, AcceptanceEvidence } from "../contracts/verification.mjs";
import type { DevelopmentArchitecture, DevelopmentPlan, DevelopmentApplication, DevelopmentCase, DevelopmentReport, SavedDevelopmentReview } from "../contracts/development.mjs";
import type { RequirementDraft } from "../contracts/requirements.mjs";
import { objectFields, isInteger } from "../runtime/type-boundary.mjs";
interface AdapterInfo { stage: AcceptanceStage; owner: AcceptanceVerification["owner"]; scope: string; pendingScope?: string }
export interface ActivationResult { status: AcceptanceStatus; bindingHash: string; reason?: string; scope: string; evidenceId: string; evidenceHash: string; mode: string }
export type AcceptanceAdapter = (input: { acceptance: AcceptanceItem; binding: AcceptanceBinding; bindingHash: string; signal?: AbortSignal | undefined }) => Promise<ActivationResult>;
interface ActivationOptions { architecture?: DevelopmentArchitecture | undefined; stage?: string; adapters?: Partial<Record<AcceptanceAdapterId, AcceptanceAdapter>>; acceptanceIds?: string[]; signal?: AbortSignal | undefined }
import { createHash } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { taskSpecRequirementItems } from "../requirements/task-spec.mjs";
import { APPLICATION_TASK_INPUT_BYTES } from "../runtime/runtime-capability-contract.mjs";
import { planReviewSubject } from "./plan-review-subject.mjs";
import { INPUT_REJECTION_TARGETS, INPUT_REJECTION_RESULT_CONTRACT, INPUT_REJECTION_ADMISSION_CONTRACT,
  INPUT_REJECTION_EXPECTED_EVIDENCE } from "./input-rejection-contract.mjs";
import { TEST_FIXTURE_SCHEMA, FIXTURE_LIMITS } from "../development/development-fixtures.mjs";

export const ACCEPTANCE_ADAPTERS: Readonly<Record<AcceptanceAdapterId, Readonly<AdapterInfo>>> = Object.freeze({
  action: Object.freeze({ stage: "development", owner: "generated-code", scope: "generated-action-execution" }),
  "input-contract": Object.freeze({ stage: "development", owner: "platform", scope: "action-input-admission" }),
  "page-resources": Object.freeze({ stage: "development", owner: "generated-code", scope: "page-resource-static-check" }),
  "host-files": Object.freeze({ stage: "activation", owner: "platform", scope: "artifact-file-roundtrip" }),
  "host-runtime": Object.freeze({ stage: "activation", owner: "platform", scope: "isolated-runtime-health" }),
  "host-business": Object.freeze({ stage: "activation", owner: "platform", scope: "isolated-business-case-execution" }),
  "host-gateway": Object.freeze({ stage: "activation", owner: "platform", scope: "authorized-gateway-contract", pendingScope: "gateway-configuration-state" }),
  "delivery-review": Object.freeze({ stage: "development", owner: "platform", scope: "independent-plan-and-code-review" }),
  conversation: Object.freeze({ stage: "runtime", owner: "conversation", scope: "actual-conversation" }),
});

function freezeAdapterGuide<const T extends Record<AcceptanceAdapterId, object>>(details: T) {
  return Object.freeze(Object.fromEntries(Object.entries(details).map(([id, value]) => [id, Object.freeze({
    ...ACCEPTANCE_ADAPTERS[id as AcceptanceAdapterId], ...value,
    splitRule: "一条验收跨越多个验证范围时拆成多条验收，可共同引用原要求；保留原验证阶段和完整业务义务，不能用宿主探针替代业务证明。",
  })]))) as { readonly [K in keyof T]: Readonly<AdapterInfo & T[K] & { splitRule: string }> };
}

export const ACCEPTANCE_ADAPTER_GUIDE = Object.freeze({
  version: 2,
  composition: Object.freeze({
    unit: "acceptance.expected",
    sameAdapterMultipleCases: true,
    caseSetRule: "同一验收项可以映射同一适配器内的多个冻结用例；逐项执行并核对全部已选用例，组合证明本条expected，不要求每个用例独自证明全部场景。",
    requirementCoverageRule: "按每条验收的完整expected判断适配器范围；多条验收可共同覆盖同一requirement，不要求每条验收单独重证该requirement的所有承诺。整体需求、原验证阶段和业务动作覆盖门槛仍须完整。",
    splitRule: "仅当本条expected跨越当前适配器无法证明的范围时拆分；多个业务场景可由host-business的多个真实冻结用例组合验证，不因场景数量自动要求换适配器或拆成不同阶段。",
    hostProbeAdapterIds: Object.freeze(["host-files", "host-runtime"]),
    hostBusinessAdapterId: "host-business",
    hostBusinessRule: "host-business真实执行所选业务动作并核对业务断言，区别于host-files文件往返探针和host-runtime健康探针；仍不能证明未选择的场景。",
  }),
  admission: Object.freeze({
    "input-contract": Object.freeze({
      caseKind: "input-rejection", rejectionOnly: true, positiveTaskAdmission: false,
      rule: "仅验证正式输入校验器拒绝非法输入，不创建正向任务，不执行生成动作，不能证明有效输入的承载或业务结果。inputTarget缺省为action-value；显式task-envelope以固定合法verification信封，调用正式任务仓库同源校验核对128KiB整份JSON UTF-8字节限制，不保存任务、不执行业务；不证明任意未来元数据或HTTP/MCP传输。",
    }),
    "host-business": Object.freeze({
      positiveCaseKind: "action", inputValidator: "validateActionInput", taskEntry: "ApplicationTaskStore.create",
      positiveTaskAdmission: true, scope: "internal-application-task", taskEnvelopeBytes: APPLICATION_TASK_INPUT_BYTES,
      actionOutcomeKinds: Object.freeze(["success", "declared-business-rejection"]),
      outcomeRule: "正向准入仅表示输入通过正式schema校验并创建任务，不代表业务成功。已经准入但按业务约定返回拒绝结果的action，也由冻结用例真实执行并逐项核对拒绝结果断言；未处理异常、运行失败或断言不符仍是失败，不能冒充业务正确报错。",
      measure: "整份内部任务创建信封的JSON.stringify UTF-8字节，包含输入、操作、交付版本与来源等；不是纯业务文本额度。",
      rule: "正向冻结用例经正式输入校验后，在独立范围通过真实任务仓库创建任务，再实际执行生成动作并核对断言；可证明本次所选有效输入已通过当前内部任务入口。入口拒绝用例不走正向任务创建。",
      excludedProof: Object.freeze(["HTTP/MCP完整传输信封和网关请求字节边界", "未执行输入及未来全部输入", "真实外部业务账号与第三方服务"]),
    }),
  }),
  adapters: freezeAdapterGuide({
    action: {
      executionFacts: Object.freeze({ generatedCode: "action", dependencyReturns: "strict-frozen-values-or-error-results",
        strictMockConsumption: true, realFiles: "not-proven", realState: "not-proven", taskAdmission: "not-created", evidence: "isolated-action-with-mocked-dependencies",
        dynamicPlaceholders: false, fixtureConstruction: Object.freeze({ schema: TEST_FIXTURE_SCHEMA, operationsGuidePath: "schema.description",
          limits: FIXTURE_LIMITS, expansion: "before-action-execution", mockArgumentMatching: "deep-strict-equal-expanded-values",
          businessOracle: false }) }),
      executionRule: "在隔离运行器真实执行生成动作，按capability与args深相等逐个严格消费冻结mock.value；可返回saved:false或错误JSON等约定失败回执，测试生成代码处理该回执的分支。未配置或未消费调用、异常退出、非法输出和断言不符仍失败。执行按冻结用例选定actionId，报告与计划和代码摘要绑定；它证明本次执行的动作身份，不证明完整操作目录唯一性、全部静态配置映射或未执行动作。仅写明调用的动作身份不构成额外静态交付断言。模拟回执不证明真实宿主故障、真实文件状态或外部服务，不适用host-business禁止返回模拟回执的限制。",
      proves: "真实运行已冻结输入的生成动作，并逐项核对该动作结果和业务断言。",
      doesNotProve: "不证明工作对话是否触发动作、未执行的输入规模或真实业务账号；不能仅凭动作声明证明路由条件和使用提示。",
    },
    "input-contract": {
      executionFacts: Object.freeze({ generatedCode: "none", dependencyReturns: "not-invoked", strictMockConsumption: false,
        realFiles: "not-proven", realState: "not-proven", taskAdmission: "input-rejection-only", evidence: "actual-input-validator",
        inputTargets: INPUT_REJECTION_TARGETS, resultContract: INPUT_REJECTION_RESULT_CONTRACT,
        admissionContract: INPUT_REJECTION_ADMISSION_CONTRACT, expectedEvidence: INPUT_REJECTION_EXPECTED_EVIDENCE }),
      executionRule: "通过正式validateActionInput和inputContractRejection核对schema拒绝，要求空mocks，不运行生成代码、不创建正向任务或调用业务文件状态。inputTarget缺省action-value验证动作值契约；显式task-envelope以固定合法verification信封验证正式任务仓库同源的128KiB完整JSON UTF-8字节限制，不能用动作值大小冒充任务封装大小，也不证明任意未来元数据或HTTP/MCP传输。报告区分target及实际bytes/limit。只证明入口拒绝，不证明schema已接受后的业务语义、错误定位或恢复。",
      proves: "使用正式入口校验器证明不合输入契约的请求在执行生成动作前被拒绝。",
      doesNotProve: "不证明生成代码内部的业务错误、错误定位、业务恢复或有效输入结果。",
    },
    "page-resources": {
      executionFacts: Object.freeze({ generatedCode: "page-node-check", dependencyReturns: "not-invoked", strictMockConsumption: false,
        realFiles: "code-resources-only", realState: "not-proven", taskAdmission: "not-created", evidence: "isolated-page-resource-check" }),
      executionRule: "真实运行独立Node检查程序，限已交付页面资源及页面共享纯逻辑，可读代码资源并使用隔离临时目录；禁止公开动作、actionId和mocks，不提供业务ctx或用户状态。没有实际浏览器DOM、交互或视觉证据，无页面时不使用此适配器。",
      proves: "在隔离检查中核对已交付页面资源及共享纯逻辑的静态结构和断言。",
      doesNotProve: "不证明实际浏览器中的页面布局、交互、视觉效果或对话行为。",
    },
    "host-files": {
      executionFacts: Object.freeze({ generatedCode: "none", dependencyReturns: "actual-file-probe", strictMockConsumption: false,
        realFiles: "file-probe", realState: "not-proven", taskAdmission: "not-created", evidence: "actual-file-roundtrip-probe" }),
      executionRule: "由平台固定探针真实写读测试文件、保存不可变快照并下载核对SHA；不运行生成动作或业务状态，不调用任务仓库创建正向任务。只证明该文件通道，不证明业务文件内容、业务容量或生成代码的文件失败处理分支。",
      proves: "用平台固定探针真实写入、读取和下载私有产物，并核对字节完整性。",
      doesNotProve: "不证明业务产物内容、最大业务输入规模、业务格式、容量计算或配置改变后的重算；这些需另有动作和断言。",
    },
    "host-runtime": {
      executionFacts: Object.freeze({ generatedCode: "runtime-probe", dependencyReturns: "not-invoked-by-probe", strictMockConsumption: false,
        realFiles: "not-proven", realState: "not-proven", taskAdmission: "not-created", evidence: "actual-isolation-or-health-probe" }),
      executionRule: "托管运行方式真实准备、启动并加载交付模块，核对隔离进程健康；node-action核对隔离执行环境，不调用业务operation或业务文件状态。旧node-json启动检查可运行首个文本用例，但不能据此声称新版业务矩阵、容量或内部任务入口已验证。",
      proves: "在当前环境真实准备并启动隔离运行进程，检查服务健康及运行绑定。",
      doesNotProve: "不证明业务功能矩阵、输入顺序、空输入、重复数据、业务隔离和容量边界；服务健康不能替代业务动作测试。",
    },
    "host-business": {
      executionFacts: Object.freeze({ generatedCode: "selected-action-cases", dependencyReturns: "actual-local-host", strictMockConsumption: true,
        realFiles: "selected-calls", realState: "selected-calls", taskAdmission: "selected-action-inputs", evidence: "actual-isolated-business-cases",
        caseSources: Object.freeze(["development", "activation"]), executionScopes: Object.freeze(["isolated", "shared"]),
        sharedWorkerReuse: Object.freeze({ "managed-service": true, "node-action": false }) }),
      executionRule: "所选action在独立范围真实创建任务并执行生成代码，任务记录绑定所选actionId与本次隔离验收版本，报告另绑定计划与代码摘要；这只证明所选动作身份，不证明完整操作目录唯一性、全部静态配置映射或未执行动作。仅写明调用的动作身份不构成额外静态交付断言。文件和状态使用实际宿主；冻结mock只核对capability与args并严格消费，绝不返回mock.value。可选择已有研发cases或绑定本条host-business的专用activationCases，专用用例不计研发通过；报告区分来源，保留用例和计划摘要。缺省executionScope=isolated为逐例独立范围；显式shared按caseIds顺序复用本组作用域、任务仓库、文件和状态。managed-service同时复用受管worker，可观察常驻内存的跨调用污染，组结束统一停止；node-action与正式内置运行方式一致，每次仍用新的隔离进程，不证明常驻内存连续性。成功或合法约定业务拒绝均按冻结断言核对，未处理异常仍失败。所选input-rejection按显式inputTarget核对动作值或完整任务信封拒绝，不创建任务或执行代码；未支持外部能力保留未验证。",
      proves: "激活前在当前代码版本的独立临时范围真实重跑已冻结并显式选择的业务动作或入口拒绝用例，逐项核对断言；文件、状态和产物快照使用真实宿主实现。",
      doesNotProve: "不证明未选择的业务场景、实际用户私有数据、未来对话或外部业务服务。测试替身只用于核对调用参数，不能返回模拟回执；不支持的外部能力保留未验证并阻断。",
    },
    "delivery-review": {
      executionFacts: Object.freeze({ generatedCode: "reviewed-only", dependencyReturns: "not-invoked", strictMockConsumption: false,
        realFiles: "not-proven", realState: "not-proven", taskAdmission: "not-created", evidence: "independent-static-review" }),
      executionRule: "本适配器不再次执行代码，复用两次已有独立计划与整体验收评审，绑定完整计划、最终代码、真实通过的整体验收报告及subjectHash。它证明静态交付约束的评审证据，不替代业务运行、容量或文件内容测试。",
      proves: "复用绑定当前完整计划和最终代码及真实整体验收报告的两次独立评审，核对语言选择、静态交付结构和未增加公开操作等可由计划与代码判断的约束。",
      doesNotProve: "不证明业务动作、容量、文件内容、实际运行或真实对话。任务、操作、处理和交付业务要求仍必须有真实动作验收，不能用静态评审替代。",
    },
    "host-gateway": {
      executionFacts: Object.freeze({ generatedCode: "none", dependencyReturns: "actual-protocol-catalog", strictMockConsumption: false,
        realFiles: "not-proven", realState: "not-proven", taskAdmission: "not-created", evidence: "actual-authorized-http-mcp-catalog" }),
      executionRule: "实际使用当前Bearer授权读取HTTP动作目录和官方MCP工具目录，核对当前交付版本、动作工具集合与授权；不执行业务提交、结果读取或取消，不测试业务文件状态或完整传输上限。未配置记录待配置，实际核验失败不能伪装待配置。",
      proves: "核对当前交付版本的网关配置、授权范围及实际 HTTP 和 MCP 协议目录。",
      doesNotProve: "不证明业务动作输出、生成文件内容或尚未调用的任务；待配置只记录状态，不能记为验证通过。",
    },
    conversation: {
      executionFacts: Object.freeze({ generatedCode: "observed-only", dependencyReturns: "observed-only", strictMockConsumption: false,
        realFiles: "observed-only", realState: "observed-only", taskAdmission: "observed-only", evidence: "actual-conversation-and-tool-observation" }),
      executionRule: "独立验收者只核对本轮已发生的message、reply和实际toolEvidence，不再次执行业务动作、创建任务或读写文件。工作轮可能实际调用动作，以本轮证据为准；须实际触发且有逐字依据，未触发或技术故障保留未验证，不外推未来对话。",
      proves: "核对绑定当前交付版本的本次真实工作对话、回复和工具调用证据。",
      doesNotProve: "不证明未来全部对话或未触发的情形；没有本次实际证据时保留运行期待验，不能提前宣称通过。",
    },
  }),
});

export const ACCEPTANCE_VERIFICATION_SCHEMA = {
  type: "object", additionalProperties: false, required: ["stage", "owner", "adapterId"],
  properties: {
    stage: { type: "string", enum: ["development", "activation", "runtime"] },
    owner: { type: "string", enum: ["generated-code", "platform", "conversation"] },
    adapterId: { type: "string", enum: Object.keys(ACCEPTANCE_ADAPTERS) },
  },
  allOf: Object.entries(ACCEPTANCE_ADAPTERS).map(([adapterId, adapter]) => ({
    if: { properties: { adapterId: { const: adapterId } }, required: ["adapterId"] },
    then: { properties: { stage: { const: adapter.stage }, owner: { const: adapter.owner } } },
  })),
  description: "按实际责任选择验收：action验证代码执行，input-contract验证入口拒绝，page-resources只验证页面资源；delivery-review复用当前计划及最终代码的独立评审，不替代业务动作。host-files、host-runtime、host-gateway在激活前实际验证；host-business使用真实文件/状态重跑明确映射的冻结业务用例。conversation保留为运行期待验，不能算作已验收。标签不代表通过，缺少真实证据会阻止交付。",
};

const legacyVerification: Readonly<AcceptanceVerification> = Object.freeze({ stage: "development", owner: "generated-code", adapterId: "action" });
function fail(message: string, validationIssue?: { path: string; reason: string; [key: string]: unknown }): never { throw Object.assign(new InputError(`验收验证契约无效：${message}`), validationIssue ? { validationIssue } : {}); }
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value);
const agentReference = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,80}$/.test(value);
const evidenceReference = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function validateAcceptanceVerification(acceptance:unknown, { required = false } = {}): AcceptanceVerification {
  const input = objectFields(acceptance).verification;
  const value = objectFields(input);
  if (input === undefined) {
    if (required) fail("每项新验收必须明确阶段、负责方及验证适配器");
    return { ...legacyVerification };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Object.keys(value).length !== 3 || !["stage", "owner", "adapterId"].every((key) => Object.hasOwn(value, key))) fail("验证分工结构无效");
  const adapterId = value.adapterId;
  const adapter = typeof adapterId === "string" && Object.hasOwn(ACCEPTANCE_ADAPTERS, adapterId) && ACCEPTANCE_ADAPTERS[adapterId as AcceptanceAdapterId];
  if (!adapter || value.stage !== adapter.stage || value.owner !== adapter.owner) fail("验证阶段、负责方与实际适配器不匹配");
  return { stage: adapter.stage, owner: adapter.owner, adapterId: adapterId as AcceptanceAdapterId };
}

export function developmentAcceptanceItems(architecture: DevelopmentArchitecture | null | undefined) {
  return (architecture?.design?.acceptance ?? []).filter((item) => {
    const verification = validateAcceptanceVerification(item);
    return verification.stage === "development" && verification.adapterId !== "delivery-review";
  });
}

export function activationBusinessAcceptanceItems(architecture: DevelopmentArchitecture | null | undefined) {
  return (architecture?.design?.acceptance ?? []).filter((item) => validateAcceptanceVerification(item).adapterId === "host-business");
}

export function requiredDevelopmentRequirementIds(architecture: DevelopmentArchitecture | null | undefined) {
  const acceptance = architecture?.design?.acceptance ?? [];
  return (architecture?.requirements ?? []).filter((requirement) => {
    const mapped = acceptance.filter((item) => item.requirementIds?.includes(requirement.id));
    return !mapped.length || mapped.some((item) => {
      const verification = validateAcceptanceVerification(item);
      return verification.stage === "development" && verification.adapterId !== "delivery-review";
    });
  }).map((item) => item.id);
}

export function acceptanceCaseMatches(acceptance: AcceptanceItem | undefined, test: { kind?: unknown }) {
  const verification = validateAcceptanceVerification(acceptance);
  if (verification.stage !== "development" || verification.adapterId === "delivery-review") return false;
  if (acceptance?.verification === undefined) return true;
  return verification.adapterId === "action" ? !["input-rejection", "node-check"].includes(typeof test.kind === "string" ? test.kind : "")
    : verification.adapterId === "input-contract" ? test.kind === "input-rejection" : test.kind === "node-check";
}

export function requiredActionAcceptanceRequirementIds({ requirements = [], draft }: Pick<DevelopmentArchitecture, "requirements" | "draft">) {
  const required = new Set(["task", "deliverable"]);
  for (const [index] of (draft?.interaction?.operations ?? []).entries()) required.add(`operation_${index + 1}`);
  for (const item of taskSpecRequirementItems(draft).filter((item) => ["processing", "delivery"].includes(item.dimension)))
    required.add(`spec_${acceptanceEvidenceHash(item.id).slice(0, 24)}`);
  return requirements.filter(item => required.has(item.id)).map(item => item.id);
}

export function requiredAcceptanceStages({ requirements = [], deferredVerifications }: Pick<DevelopmentArchitecture, "requirements" | "deferredVerifications">) {
  const allowedReferences = requirements.map(item => item.id).filter(identifier);
  return (deferredVerifications?.issues ?? []).map(issue => {
    if (!identifier(issue.requirementId) || !allowedReferences.includes(issue.requirementId)
      || !["development", "activation", "runtime"].includes(issue.stage ?? ""))
      fail("后续验证义务必须保留有效正式要求及原阶段", { path: "design.acceptance", reason: "invalid_reference", allowedReferences });
    return { requirementId: issue.requirementId, stage: issue.stage! };
  });
}

export function validateAcceptanceCoverage(architecture: DevelopmentArchitecture, { application }: { application?: DevelopmentApplication | undefined } = {}) {
  const acceptance = architecture?.design?.acceptance ?? [], requirements = architecture?.requirements ?? [];
  acceptance.forEach((item) => validateAcceptanceVerification(item));
  const hasExplicitVerification = acceptance.some((item) => item.verification !== undefined);
  if (!hasExplicitVerification) return;
  const allowedReferences = requirements.map((item) => item.id).filter(identifier);
  const deferredMissing = [];
  for (const issue of requiredAcceptanceStages(architecture)) {
    if (!acceptance.some((item) => item.requirementIds?.includes(issue.requirementId) && validateAcceptanceVerification(item).stage === issue.stage))
      deferredMissing.push(issue.requirementId);
  }
  const actionAcceptance = acceptance.filter((item) => {
    const verification = validateAcceptanceVerification(item);
    return verification.stage === "development" && verification.adapterId === "action";
  });
  const hasOperations = application ? application.actions?.length > 0 : architecture.design?.interaction?.operations === true;
  const missing = requiredActionAcceptanceRequirementIds(architecture).filter(id => hasOperations
    && !actionAcceptance.some(entry => entry.requirementIds?.includes(id)));
  if (deferredMissing.length || hasOperations && (!actionAcceptance.length || missing.length)) fail(
    deferredMissing.length ? "后续验证义务缺少原阶段验收，不能只改签至其他阶段或适配器"
      : "实际操作及其任务、交付要求必须有研发动作验收，不能全部转成宿主或运行期待验",
    { path: "design.acceptance", reason: "missing_coverage", allowedReferences,
      missingReferences: [...new Set([...deferredMissing, ...missing])] });
}

export function acceptanceEvidenceHash(value: unknown) {
  const seen = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (!item || typeof item !== "object" || seen.has(item)
      || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail("证据摘要只允许 JSON");
    seen.add(item);
    const result = Array.isArray(item) ? `[${Array.from(item, encode).join(",")}]`
      : `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode(objectFields(item)[key])}`).join(",")}}`;
    seen.delete(item); return result;
  };
  return createHash("sha256").update(encode(value)).digest("hex");
}

export function createAcceptanceLedger({ architecture, plan, codeHash }: { architecture?: DevelopmentArchitecture | undefined; plan?: DevelopmentPlan | undefined; codeHash?: string | undefined }): AcceptanceLedger {
  if (!architecture || !Array.isArray(architecture.requirements) || !architecture.requirements.length
    || !Array.isArray(architecture.design?.acceptance) || !architecture.design.acceptance.length || !digest(codeHash)) fail("缺少完整架构、计划或代码版本");
  validateAcceptanceCoverage(architecture, { application: plan?.application });
  const binding = { agentId: architecture.agentId, architectureVersion: architecture.version,
    architectureHash: architecture.candidateHash, requirementsHash: acceptanceEvidenceHash(architecture.requirements),
    planHash: acceptanceEvidenceHash(plan), codeHash,
    ...(architecture.runtimeCapabilities === undefined ? {} : { runtimeCapabilitiesHash: acceptanceEvidenceHash(architecture.runtimeCapabilities) }) };
  if (!agentReference(binding.agentId) || !isInteger(binding.architectureVersion) || binding.architectureVersion < 1
    || !digest(binding.architectureHash)) fail("架构版本绑定无效");
  const requirementIds = new Set(architecture.requirements.map((item) => item.id));
  const covered = new Set(), ids = new Set();
  const items: AcceptanceLedgerItem[] = architecture.design.acceptance.map((item) => {
    if (!identifier(item.id) || ids.has(item.id) || !Array.isArray(item.requirementIds) || !item.requirementIds.length
      || new Set(item.requirementIds).size !== item.requirementIds.length || item.requirementIds.some((id) => !requirementIds.has(id))) fail("验收引用缺失、重复或越界");
    ids.add(item.id); item.requirementIds.forEach((id) => covered.add(id));
    return { acceptanceId: item.id, requirementIds: [...item.requirementIds], verification: validateAcceptanceVerification(item), legacy: item.verification === undefined,
      acceptanceHash: acceptanceEvidenceHash(item), status: "not_run", evidence: null };
  });
  if ([...requirementIds].some((id) => !covered.has(id))) fail("需求缺少完整验收覆盖");
  return { schemaVersion: 1, binding: binding as AcceptanceBinding, bindingHash: acceptanceEvidenceHash(binding), status: "not_run", items };
}

function assertLedger(ledger: AcceptanceLedger) {
  if (ledger?.schemaVersion !== 1 || !Array.isArray(ledger.items) || !ledger.items.length
    || !agentReference(ledger.binding?.agentId) || !Number.isSafeInteger(ledger.binding?.architectureVersion)
    || ledger.binding.architectureVersion < 1 || !["architectureHash", "requirementsHash", "planHash", "codeHash"].every((key) => digest(objectFields(ledger.binding)[key]))
    || ledger.binding.runtimeCapabilitiesHash !== undefined && !digest(ledger.binding.runtimeCapabilitiesHash)
    || ledger.bindingHash !== acceptanceEvidenceHash(ledger.binding)) fail("验证台账绑定损坏");
}

export function recordDevelopmentAcceptance(ledger: AcceptanceLedger, { report, cases, reportId = report?.id }: { report?: DevelopmentReport; cases?: DevelopmentCase[]; reportId?: string | undefined } = {}): AcceptanceLedger {
  assertLedger(ledger);
  if (report?.codeHash !== ledger.binding.codeHash || report.planHash !== undefined && report.planHash !== ledger.binding.planHash
    || report.architectureRef !== undefined && (report.architectureRef.version !== ledger.binding.architectureVersion || report.architectureRef.candidateHash !== ledger.binding.architectureHash)
    || !Array.isArray(report.results) || !Array.isArray(cases)
    || !evidenceReference(reportId)) fail("代码执行证据没有绑定当前快照或报告编号");
  const next = structuredClone(ledger);
  const reportHash = acceptanceEvidenceHash(JSON.parse(JSON.stringify(report)));
  for (const item of next.items.filter((entry) => entry.verification.stage === "development" && entry.verification.adapterId !== "delivery-review")) {
    const expected = cases.filter((test) => test.acceptanceId === item.acceptanceId);
    const results = expected.map((test) => report.results.filter((result) => result.caseId === test.id));
    const exact = expected.length > 0 && results.every((matches, index) => matches.length === 1
      && matches[0]!.acceptanceId === item.acceptanceId && matches[0]!.taskId === expected[index]!.taskId
      && (item.legacy || item.verification.adapterId === "input-contract"
        ? item.legacy || matches[0]!.actionExecuted === false && matches[0]!.evidenceMode === "input_contract"
        : item.verification.adapterId === "page-resources" ? matches[0]!.kind === "node-check" && matches[0]!.evidenceMode === "node_check"
          : matches[0]!.actionExecuted === true && matches[0]!.actionId === expected[index]!.actionId));
    item.status = report.status === "passed" && exact && results.every(([result]) => result!.status === "passed") ? "passed"
      : results.some((matches) => matches.some((result) => result.status === "failed")) ? "failed" : "not_run";
    item.evidence = { kind: "development-report", reportId, codeHash: report.codeHash,
      caseIds: expected.map((test) => test.id), bindingHash: next.bindingHash,
      scope: item.legacy ? "legacy-generated-tests" : ACCEPTANCE_ADAPTERS[item.verification.adapterId].scope, reportHash };
  }
  next.status = next.items.every((item) => item.status === "passed") ? "passed"
    : next.items.some((item) => item.status === "failed") ? "failed" : "not_run";
  return next;
}

export function recordIndependentAcceptance(ledger: AcceptanceLedger, { plan, planReview, integrationReview, report }: { plan?: DevelopmentPlan; planReview?: SavedDevelopmentReview | undefined; integrationReview?: SavedDevelopmentReview | undefined; report?: DevelopmentReport } = {}): AcceptanceLedger {
  assertLedger(ledger);
  const architectureRef = { version: ledger.binding.architectureVersion, candidateHash: ledger.binding.architectureHash };
  const validReview = (review: SavedDevelopmentReview | undefined, mode: string, codeHash: string | null) => review?.mode === mode && review.verdict === "pass"
    && Array.isArray(review.issues) && !review.issues.some((issue) => issue.blocking)
    && review.planHash === ledger.binding.planHash && review.codeHash === codeHash;
  const boundPlanReview = () => (planReview!.subjectVersion === undefined ? [1, 2] : [planReview!.subjectVersion])
    .some((version) => planReview!.subjectHash === acceptanceEvidenceHash(planReviewSubject(architectureRef, plan!, ledger.binding.planHash, version)));
  if (!plan || acceptanceEvidenceHash(plan) !== ledger.binding.planHash || !validReview(planReview, "plan", null)
    || !validReview(integrationReview, "integration", ledger.binding.codeHash)
    || report?.mode !== "integration" || report.status !== "passed" || report.codeHash !== ledger.binding.codeHash
    || report.planHash !== ledger.binding.planHash || acceptanceEvidenceHash(report.architectureRef) !== acceptanceEvidenceHash(architectureRef)
    || !boundPlanReview()
    || integrationReview!.subjectHash !== acceptanceEvidenceHash({ mode: "integration", architectureRef, plan, planHash: ledger.binding.planHash,
      task: null, report, codeHash: ledger.binding.codeHash })) fail("独立评审没有绑定当前计划、最终代码及实际整体验收报告");
  const next = structuredClone(ledger);
  for (const item of next.items.filter((entry) => entry.verification.adapterId === "delivery-review")) {
    item.status = "passed"; delete item.reason;
    item.evidence = { kind: "independent-review", mode: "actual", scope: ACCEPTANCE_ADAPTERS["delivery-review"].scope,
      bindingHash: next.bindingHash, codeHash: next.binding.codeHash, planHash: next.binding.planHash,
      planSubjectHash: planReview!.subjectHash, integrationSubjectHash: integrationReview!.subjectHash,
      planReviewHash: acceptanceEvidenceHash(planReview), integrationReviewHash: acceptanceEvidenceHash(integrationReview), reportHash: acceptanceEvidenceHash(report) };
  }
  next.status = summarizeAcceptanceLedger(next).status;
  return next;
}

async function verifyAcceptanceStage(ledger: AcceptanceLedger, { architecture, stage, adapters = {}, acceptanceIds, signal }: ActivationOptions = {}): Promise<AcceptanceLedger> {
  assertLedger(ledger);
  if (stage !== "activation") fail("宿主验证阶段无效");
  const next = structuredClone(ledger);
  if (acceptanceIds !== undefined && (!Array.isArray(acceptanceIds) || !acceptanceIds.length || new Set(acceptanceIds).size !== acceptanceIds.length
    || acceptanceIds.some((id) => !next.items.some((item) => item.acceptanceId === id && item.verification.stage === stage)))) fail("宿主验证条目引用无效");
  for (const item of next.items.filter((entry) => entry.verification.stage === stage && (!acceptanceIds || acceptanceIds.includes(entry.acceptanceId)))) {
    signal?.throwIfAborted();
    const acceptance = architecture?.design?.acceptance?.find((entry) => entry.id === item.acceptanceId);
    if (!acceptance || acceptanceEvidenceHash(acceptance) !== item.acceptanceHash) fail("验收内容与冻结版本不一致");
    const adapter = Object.hasOwn(adapters, item.verification.adapterId) ? adapters[item.verification.adapterId] : undefined;
    item.status = "not_run"; item.evidence = null;
    if (typeof adapter !== "function") { item.reason = "verification_adapter_unavailable"; continue; }
    try {
      const result = await adapter({ acceptance: structuredClone(acceptance), binding: structuredClone(next.binding),
        bindingHash: next.bindingHash, signal });
      signal?.throwIfAborted();
      const pendingGateway = item.verification.adapterId === "host-gateway" && result?.status === "not_run"
        && result.reason === "gateway_configuration_required" && result.scope === ACCEPTANCE_ADAPTERS["host-gateway"].pendingScope;
      if (!result || result.bindingHash !== next.bindingHash || !["passed", "failed", "not_run", "error"].includes(result.status)
        || !evidenceReference(result.evidenceId) || !digest(result.evidenceHash) || result.mode !== "actual"
        || !pendingGateway && result.scope !== ACCEPTANCE_ADAPTERS[item.verification.adapterId].scope) {
        item.status = "error"; item.reason = "verification_evidence_invalid"; continue;
      }
      item.status = result.status;
      item.evidence = { kind: "host-integration", adapterId: item.verification.adapterId, evidenceId: result.evidenceId,
        evidenceHash: result.evidenceHash, bindingHash: next.bindingHash, mode: "actual" };
      item.evidence.scope = result.scope;
      if (result.status !== "passed") item.reason = pendingGateway ? "gateway_configuration_required" : "verification_did_not_pass";
    } catch (error) {
      if (signal?.aborted) throw error;
      item.status = "error"; item.reason = "verification_execution_failed";
    }
  }
  next.status = next.items.every((item) => item.status === "passed") ? "passed"
    : next.items.some((item) => item.status === "error") ? "error"
      : next.items.some((item) => item.status === "failed") ? "failed" : "not_run";
  return next;
}

export function verifyActivationAcceptance(ledger: AcceptanceLedger, options: ActivationOptions = {}) {
  return verifyAcceptanceStage(ledger, { ...options, stage: "activation" });
}

export function recordRuntimeAcceptance(ledger: AcceptanceLedger, { bindingHash, deliveryBinding, taskId, evidenceId, mode, results }: { bindingHash?: string; deliveryBinding?: { deliveryVersion: string; [key: string]: unknown }; taskId?: string; evidenceId?: string; mode?: string; results?: { acceptanceId: string; status: AcceptanceStatus; evidenceHash: string }[] } = {}): AcceptanceLedger {
  assertLedger(ledger);
  if (bindingHash !== ledger.bindingHash || mode !== "actual" || !evidenceReference(taskId) || !evidenceReference(evidenceId)
    || !deliveryBinding || !["agentId", "architectureHash", "planHash", "codeHash"].every((key) => deliveryBinding[key] === objectFields(ledger.binding)[key])
    || typeof deliveryBinding.deliveryVersion !== "string" || !deliveryBinding.deliveryVersion.endsWith(`:${ledger.binding.codeHash}`)
    || !Array.isArray(results) || !results.length || new Set(results.map((item) => item?.acceptanceId)).size !== results.length) fail("运行期证据没有绑定当前实际任务及交付版本");
  const next = structuredClone(ledger);
  for (const result of results) {
    const item = next.items.find((entry) => entry.acceptanceId === result?.acceptanceId && entry.verification.stage === "runtime");
    if (!item || !["passed", "failed", "not_run", "error"].includes(result.status) || !digest(result.evidenceHash)) fail("运行期证据引用了无效验收或结果");
    item.status = result.status;
    item.evidence = { kind: "runtime-task", taskId, evidenceId, evidenceHash: result.evidenceHash, deliveryVersion: deliveryBinding.deliveryVersion,
      bindingHash, mode, scope: ACCEPTANCE_ADAPTERS[item.verification.adapterId].scope };
    delete item.reason;
  }
  next.status = summarizeAcceptanceLedger(next).status;
  return next;
}

function allowedPendingActivation(item: AcceptanceLedgerItem, allowPendingActivationAdapters: string[]) {
  return allowPendingActivationAdapters.includes("host-gateway") && item.verification.stage === "activation" && item.verification.adapterId === "host-gateway"
    && item.status === "not_run" && item.reason === "gateway_configuration_required" && item.evidence?.mode === "actual"
    && item.evidence.scope === ACCEPTANCE_ADAPTERS["host-gateway"].pendingScope;
}

function actualEvidenceMatches(item: AcceptanceLedgerItem, bindingHash: string, codeHash: string, planHash: string) {
  const evidence = item.evidence;
  if (!evidence || evidence.bindingHash !== bindingHash) return false;
  if (item.verification.adapterId === "delivery-review") return evidence.kind === "independent-review" && evidence.mode === "actual"
    && evidence.codeHash === codeHash && evidence.planHash === planHash && evidence.scope === ACCEPTANCE_ADAPTERS["delivery-review"].scope
    && ["planSubjectHash", "integrationSubjectHash", "planReviewHash", "integrationReviewHash", "reportHash"].every((key) => digest(objectFields(evidence)[key]));
  if (item.verification.stage === "development") return evidence.kind === "development-report" && evidenceReference(evidence.reportId)
    && digest(evidence.reportHash) && evidence.codeHash === codeHash && Array.isArray(evidence.caseIds) && evidence.caseIds.length > 0
    && evidence.caseIds.every(evidenceReference) && evidence.scope === (item.legacy ? "legacy-generated-tests" : ACCEPTANCE_ADAPTERS[item.verification.adapterId].scope);
  const adapter = ACCEPTANCE_ADAPTERS[item.verification.adapterId];
  if (evidence.mode !== "actual" || !evidenceReference(evidence.evidenceId) || !digest(evidence.evidenceHash)) return false;
  if (item.verification.stage === "runtime") return evidence.kind === "runtime-task" && evidenceReference(evidence.taskId)
    && typeof evidence.deliveryVersion === "string" && evidence.deliveryVersion.endsWith(`:${codeHash}`) && evidence.scope === adapter.scope;
  return evidence.kind === "host-integration" && (evidence.scope === adapter.scope
    || item.verification.adapterId === "host-gateway" && item.status === "not_run" && item.reason === "gateway_configuration_required" && evidence.scope === adapter.pendingScope);
}

function validatePendingAllowance(value: unknown) {
  if (!Array.isArray(value) || value.length > 1 || value.some((id) => id !== "host-gateway")) fail("仅已实测未配置的可选网关允许等待配置");
}

export function summarizeAcceptanceLedger(ledger: AcceptanceLedger, { allowPendingActivationAdapters = [] }: { allowPendingActivationAdapters?: string[] } = {}): { status: AcceptanceStatus; activationComplete: boolean; activationPermitted: boolean; pendingActivation: string[]; outstandingRuntime: string[] } {
  assertLedger(ledger);
  validatePendingAllowance(allowPendingActivationAdapters);
  const preActivation = ledger.items.filter((item) => item.verification.stage !== "runtime");
  return { status: ledger.items.every((item) => item.status === "passed") ? "passed"
    : ledger.items.some((item) => item.status === "error") ? "error" : ledger.items.some((item) => item.status === "failed") ? "failed" : "not_run",
  activationComplete: preActivation.every((item) => item.status === "passed" && actualEvidenceMatches(item, ledger.bindingHash, ledger.binding.codeHash, ledger.binding.planHash)),
  activationPermitted: preActivation.every((item) => (item.status === "passed" || allowedPendingActivation(item, allowPendingActivationAdapters)) && actualEvidenceMatches(item, ledger.bindingHash, ledger.binding.codeHash, ledger.binding.planHash)),
  pendingActivation: preActivation.filter((item) => item.status !== "passed").map((item) => item.acceptanceId),
  outstandingRuntime: ledger.items.filter((item) => item.verification.stage === "runtime" && item.status !== "passed").map((item) => item.acceptanceId) };
}

export function assertAcceptanceComplete(ledger: AcceptanceLedger, { architecture, plan, codeHash, stageScope = ["development", "activation", "runtime"], allowPendingActivationAdapters = [] }: { architecture?: DevelopmentArchitecture; plan?: DevelopmentPlan; codeHash?: string; stageScope?: string[]; allowPendingActivationAdapters?: string[] } = {}) {
  const current = createAcceptanceLedger({ architecture, plan, codeHash });
  assertLedger(ledger);
  if (!Array.isArray(stageScope) || !stageScope.length || new Set(stageScope).size !== stageScope.length
    || stageScope.some((stage) => !["development", "activation", "runtime"].includes(stage))) fail("验收门槛阶段无效");
  validatePendingAllowance(allowPendingActivationAdapters);
  if (current.bindingHash !== ledger.bindingHash || current.items.length !== ledger.items.length
    || current.items.some((item) => !ledger.items.some((saved) => saved.acceptanceId === item.acceptanceId && saved.acceptanceHash === item.acceptanceHash
      && saved.legacy === item.legacy && acceptanceEvidenceHash(saved.verification) === acceptanceEvidenceHash(item.verification)
      && acceptanceEvidenceHash(saved.requirementIds) === acceptanceEvidenceHash(item.requirementIds)))
    || ledger.items.filter((item) => stageScope.includes(item.verification.stage)).some((item) => item.status !== "passed" && !allowedPendingActivation(item, allowPendingActivationAdapters)
      || !actualEvidenceMatches(item, ledger.bindingHash, ledger.binding.codeHash, ledger.binding.planHash))) fail("所有阶段必须有当前版本的实际通过证据才能交付");
  return true;
}
