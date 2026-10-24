import type { ArchitectureDesign } from "../contracts/architecture.mjs";
import type { RequirementDraft } from "../contracts/requirements.mjs";
import type { ApplicationManifest } from "../contracts/application.mjs";
import { objectFields, isArray, isInteger } from "../runtime/type-boundary.mjs";
interface CapabilityAgent { id?: string; revision?: number; fingerprint?: string; execution?: { kind?: string } | null; updatedAt?: string }
interface ConnectionFact { id: string; kind: string; version: number; configured: boolean; status: string; testedAt: string | null; allowFallback: boolean }
interface Evidence { status: string; checkedAt: string | null; description: string }
interface CapabilityFact { id: string; label: string; description: string; scope: string; availability: string; requiresNetwork: boolean; reason: string; requirements: string[]; verification: Evidence }
interface CapabilityArchitecture { version: number; candidateHash: string | null; status?: unknown; delivery?: unknown; runtimeCapabilities?: unknown; design: Pick<ArchitectureDesign, "connections" | "capabilities"> | null }
interface CapabilityOptions { agent?: CapabilityAgent | null | undefined; agentId?: string; architecture?: CapabilityArchitecture | null; draft?: RequirementDraft | null; ready?: boolean; approved?: boolean; toolIds?: string[]; connectionView?: unknown; defaultModelConfigured?: boolean; defaultModelVersion?: unknown; application?: { manifest: ApplicationManifest; deliveryVersion: string; checkedAt?: string } | null; deliveryFailed?: boolean; workflowChecked?: boolean }
import { createHash } from "node:crypto";
import { LEGACY_CAPABILITIES, PUBLIC_CAPABILITIES } from "../architecture/architecture-contract.mjs";
import { PUBLIC_WEB_CAPABILITIES, networkAllowed } from "../runtime/web-capabilities.mjs";
import { safeDiagnosticText } from "../projects/project-diagnostics.mjs";
import { isHostDeliveryCapability } from "../runtime/runtime-capability-contract.mjs";

const clean = (value: unknown, limit = 1000) => safeDiagnosticText(value).slice(0, limit);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(objectFields(value)[key])])) : value;
const checkedAt = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const verification = (status = "unverified", date: unknown = null, description = "尚未验证本次输入的实际调用和业务效果") =>
  ({ status, checkedAt: checkedAt(date), description });
const labels: Record<string, string> = { conversation: "对话与生成", list_workspace_files: "列出任务文件", read_workspace_file: "读取任务文本",
  write_workspace_file: "保存任务产物", list_group_materials: "查看群共享材料", read_group_material: "读取群共享文档",
  read_group_material_image: "查看群共享图片", web_search: "搜索公开资料", web_fetch: "读取公开网页" };
const materialIds: Record<string, string> = { list_materials: "list_group_materials", read_material: "read_group_material", read_material_image: "read_group_material_image" };

// Project only configuration identity and health. Connection URLs, model names and diagnostics never enter public cards.
export function publicConnectionFacts(input: unknown): { version: number; connections: ConnectionFact[] } {
  const value = objectFields(input);
  return { version: isInteger(value?.version) ? value.version : 0,
    connections: (isArray(value?.connections) ? value.connections.map(objectFields) : []).filter((item) => typeof item?.id === "string"
      && /^[\w-]{1,80}$/.test(item.id) && typeof item.kind === "string" && ["model", "search", "business"].includes(item.kind)).map((item) => ({
      id: String(item.id), kind: String(item.kind), version: isInteger(item.version) ? item.version : 0,
      configured: item.configured === true, status: typeof item.status === "string" && ["configured", "verified", "failed"].includes(item.status) ? item.status : "configured",
      testedAt: checkedAt(item.testedAt), allowFallback: item.kind === "search" && item.allowFallback === true,
    })).sort((a, b) => a.id.localeCompare(b.id)) };
}

export function groupCapabilityFacts({ agent, agentId = agent?.id, architecture, draft, ready, approved, toolIds = [], connectionView,
  defaultModelConfigured = false, defaultModelVersion = null, application = null, deliveryFailed = false, workflowChecked = false }: CapabilityOptions = {}) {
  const connections = publicConnectionFacts(connectionView), configured = connections.connections.filter((item) => item.configured);
  const model = configured.find((item) => item.kind === "model"), search = configured.find((item) => item.kind === "search");
  const modelReady = Boolean(defaultModelConfigured || model), allowNetwork = networkAllowed(draft);
  const allowedTools = new Set(toolIds), capabilities: CapabilityFact[] = [], seen = new Set<string>();
  const modelRequirements = modelReady ? [] : ["需要配置平台模型或这个 Agent 的专属模型"];
  const add = (id: string, description: string, { label = labels[id] ?? id, availability = "callable", reason = "当前群执行路径提供此能力，实际结果按调用回执判断",
    requirements = [], requiresNetwork = false, verification: evidence = verification() }: { label?: string; availability?: string; reason?: string; requirements?: string[]; requiresNetwork?: boolean; verification?: Evidence } = {}) => {
    if (seen.has(id)) return;
    seen.add(id);
    if (availability !== "forbidden") {
      if (!ready || deliveryFailed) { availability = "unavailable"; reason = deliveryFailed
        ? "当前程序交付或快照未能核对，不能开始业务群工作" : "当前定义尚未交付或正在更新，不能开始群工作"; }
      else if (!modelReady && availability === "callable") { availability = "conditional"; reason = "执行群工作前需要可用的模型配置"; }
    }
    capabilities.push({ id, label: clean(label, 200), description: clean(description), scope: "group_task", availability, requiresNetwork,
      reason: clean(reason), requirements: [...new Set([...requirements, ...modelRequirements])].map((item) => clean(item)).filter(Boolean), verification: evidence });
  };
  const connectionEvidence = (item: ConnectionFact | undefined) => item?.status === "failed"
    ? verification("last_call_failed", item.testedAt, "最近一次连接调用或测试失败；配置仍存在，不能据此认定永久不可用")
    : item?.status === "verified" ? verification("connection_checked", item.testedAt, "连接级检查通过，不证明本次输入或具体业务动作已经成功") : verification();
  add("conversation", "依据当前群任务中明确提供的文本进行理解与生成；名称和职责描述不证明模型支持图片或某项业务效果", {
    verification: model ? connectionEvidence(model) : verification() });
  for (const item of LEGACY_CAPABILITIES.filter((item) => item.id !== "conversation" && allowedTools.has(item.id)))
    add(item.id, item.scope.replaceAll("当前 Agent 专属工作目录", "当前群任务中本 Agent 的专属工作目录"));
  for (const item of PUBLIC_CAPABILITIES) {
    const id = materialIds[item.id], image = item.id === "read_material_image";
    add(id!, item.scope.replaceAll("当前 Agent", "当前群").replace("材料在同一 Agent 的不同对话间共享", "只读取明确分享给当前群的材料"), image ? {
      availability: "conditional", reason: "可读取群共享页面图像，图片理解需要所接模型支持；模型名称不能作为支持证据",
      requirements: ["材料已明确分享给本群", "图片理解需实际支持图片输入的模型"],
    } : { requirements: ["材料已明确分享给本群"] });
  }
  for (const item of PUBLIC_WEB_CAPABILITIES) add(item.id, item.scope, {
    requiresNetwork: true,
    availability: allowNetwork ? "callable" : "forbidden", reason: allowNetwork
      ? "平台公共联网可调用；具体目标是否可读、正文是否完整与业务质量需逐次核实" : "已确认需求禁止联网，群任务不能绕过此限制",
    verification: allowNetwork && item.id === "web_search" && search ? connectionEvidence(search) : verification(),
  });
  if (agent?.execution?.kind === "node-json") add("run_developed_workflow", "执行当前已交付的隔离专用流程；群材料和文件限于当前群任务，不获得私人资料", {
    label: "执行专用流程", availability: workflowChecked ? "callable" : "unavailable",
    reason: workflowChecked ? "流程交付和快照已核对，实际业务结果仍需本次执行验证" : "专用流程交付未能核对，不能执行",
    verification: workflowChecked ? verification("delivery_checked", agent.updatedAt, "专用流程交付和代码快照已核对，不代表本次业务输入已经成功") : verification(),
  });
  if (["node-action", "managed-service"].includes(agent?.execution?.kind ?? "")) {
    const manifest = application?.manifest;
    if (!manifest || manifest.actions.length > 0) add("run_application_action", "应用动作入口；必须选择下列具体 action 能力，入口存在不代表所有动作都具备执行条件", {
      label: "执行应用动作", availability: manifest ? "conditional" : deliveryFailed ? "unavailable" : "unknown",
      reason: manifest ? "需要先选择已验收的具体动作并满足该动作全部连接条件" : "应用交付未能核对，不能推定具体动作可用",
      requirements: ["必须使用具体 action 能力及其输入契约，不能绕过动作连接要求"],
      verification: manifest ? verification("delivery_checked", application!.checkedAt, "应用交付和代码快照已核对，不等于具体动作业务成功") : verification(),
    });
    for (const action of manifest?.actions ?? []) {
      const dependencies = action.connectionIds.map((id) => configured.find((item) => item.id === id)), missing = action.connectionIds.filter((_id, index) => !dependencies[index]);
      const requiresNetwork = action.connectionIds.some((id) =>
        configured.some((item) => item.id === id && ["business", "search"].includes(item.kind))
        || architecture?.design?.connections?.some((item) => item.id === id && ["business", "search"].includes(String(objectFields(item).kind ?? item.purpose))));
      const networkForbidden = !allowNetwork && requiresNetwork;
      const failed = dependencies.find((item) => item?.status === "failed");
      add(`action:${action.id}`, "执行当前已验收应用中的这个具体动作；输入和输出按应用契约核实，结果按实际任务回执判断", {
        label: action.title, requiresNetwork, availability: networkForbidden ? "forbidden" : missing.length ? "conditional" : "callable",
        reason: networkForbidden ? "该动作依赖联网连接，已确认需求禁止联网" : missing.length ? "该动作缺少所需连接配置" : "动作交付已核对且连接条件齐备，可发起首次实际调用",
        requirements: action.connectionIds.map((id) => `需要连接 ${id}${missing.includes(id) ? "（尚未配置）" : "（已配置）"}`),
        verification: failed ? connectionEvidence(failed) : verification("delivery_checked", application!.checkedAt,
          "动作交付和快照已核对；连接级测试不代表该动作的真实业务请求已经成功"),
      });
    }
  }
  // A declared dependency absent from the real group tool set cannot become callable through a public description.
  for (const item of architecture?.design?.capabilities ?? []) {
    if (seen.has(item.id) || materialIds[item.id] || item.id === "conversation" || isHostDeliveryCapability(item.id, architecture!.runtimeCapabilities)) continue;
    add(item.id, clean(item.reason), { availability: "unavailable", reason: "当前群执行路径未装配该能力，设计声明不能替代实际工具" });
  }
  const hardBoundaries = [
    { id: "group_privacy", label: "私人资料隔离", reason: "群工作不读取成员私人记忆、私聊历史或未分享的私人材料与文件" },
    { id: "task_workspace", label: "任务目录隔离", reason: "文件操作仅限当前群任务中本 Agent 的目录，不能访问其他 Agent 或其他群任务目录" },
    { id: "actual_tools", label: "以真实工具和动作结果为准", reason: "只能执行本轮实际装配的已批准工具及已验收动作；排队、连接测试和交付验收不等于业务成功" },
    ...(!allowNetwork ? [{ id: "network_policy", label: "禁止联网", reason: "已确认需求禁止联网，公共联网和业务联网均不能绕过" }] : []),
    ...(draft?.constraints ?? []).map((item, index) => ({ id: `requirement_${index + 1}`, label: "已确认约束", reason: clean(item.text, 500) })).filter((item) => item.reason),
  ];
  const identity = { schemaVersion: 1, agentId: agentId ?? null, revision: agent?.revision ?? null, definitionHash: agent?.fingerprint ?? null, draft,
    architecture: { version: architecture?.version ?? null, candidateHash: architecture?.candidateHash ?? null,
      status: architecture?.status ?? null, delivery: architecture?.delivery ?? null, approved: approved === true },
    execution: agent?.execution ?? null, toolIds: [...allowedTools].sort(), defaultModelConfigured: model ? null : defaultModelConfigured === true,
    defaultModelVersion: model ? null : defaultModelVersion,
    connections: { version: connections.version, connections: connections.connections.map(({ id, kind, version, configured, allowFallback }) => ({ id, kind, version, configured, allowFallback })) },
    networkAllowed: allowNetwork, publicCapabilities: [...PUBLIC_CAPABILITIES, ...PUBLIC_WEB_CAPABILITIES],
    networkRequirements: capabilities.map(({ id, requiresNetwork }) => ({ id, requiresNetwork })),
    application: application ? { deliveryVersion: application.deliveryVersion, manifest: application.manifest } : null,
    deliveryFailed, workflowChecked };
  return { capabilitySchemaVersion: 1, capabilityVersion: `cap-v1:${createHash("sha256").update(JSON.stringify(canonical(identity))).digest("hex")}`,
    capabilities, hardBoundaries };
}
