import type { ArchitectureGlobal } from "../contracts/architecture-stages.mjs";
import type { Capability, RequirementItem } from "../contracts/architecture.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import { validateConnectionDefinition } from "../connections/connection-contract.mjs";

export interface StageSemanticIssue { path: string; reason: string; message: string; allowedReferences?: string[] }

/** These checks need only global choices, so they can run before any module is designed. */
export function architectureGlobalIssues(value: Pick<ArchitectureGlobal, "profile" | "schemaVersion" | "interaction" | "execution" | "selectionBasis"> & { connections?: readonly unknown[] }, context: { draft?: unknown; requirements?: RequirementItem[] } = {}, root = "design", confirmed = false): StageSemanticIssue[] {
  const issues: StageSemanticIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path: `${root}.${path}`, reason: "invalid_contract", message });
  const interaction = value.interaction;
  const connectionIds = new Set<unknown>();
  if (value.schemaVersion === 3) for (const [index, connection] of (value.connections ?? []).entries()) {
    const id = objectFields(connection).id;
    if (connectionIds.has(id)) add(`connections[${index}].id`, "连接编号必须唯一，不能将同一编号交给多个连接定义");
    connectionIds.add(id);
    try { validateConnectionDefinition(connection); }
    catch { add(`connections[${index}]`, "连接操作必须符合所选协议：HTTP需method/path，MCP需tool或resourceUri，操作编号不可重复，副作用操作不能标为安全测试"); }
  }
  if ((value.schemaVersion === 2 || value.schemaVersion === 3) && interaction) {
    if (interaction.defaultEntry === "application" && !interaction.page) add("interaction.page", "应用入口必须交付页面");
    if (interaction.assistant?.enabled && (!interaction.page || !interaction.assistant.purpose.trim()))
      add("interaction.assistant", "页面助手必须有托管页面及具体用途；普通对话入口不启用页面助手");
  }
  if (value.schemaVersion === 3 && value.execution) {
    if (value.execution.language === "none" && value.execution.hosting !== "builtin") add("execution.language", "独立服务必须选择实际运行语言");
    if (value.execution.language === "python" && value.execution.hosting === "builtin") add("execution.hosting", "Python 必须通过受管或 Docker 运行器交付");
    if (value.profile === "workflow" && value.execution.hosting === "builtin") add("execution.hosting", "新流程必须使用支持持久检查点的受管运行方式；单次专属代码动作应按实际需要选择类型");
  }
  if (confirmed) {
    const source = objectFields(objectFields(context.draft).interaction), assistant = objectFields(source.assistant);
    if (interaction && context.draft !== undefined) {
      if (typeof source.defaultEntry === "string" && source.defaultEntry !== interaction.defaultEntry)
        add("interaction.defaultEntry", "必须保留已确认的默认入口");
      if (typeof source.page === "boolean" && source.page !== interaction.page) add("interaction.page", "不能擅自增加或删除已确认的页面交付");
      if (Array.isArray(source.operations) && source.operations.length && !interaction.operations)
        add("interaction.operations", "必须保留已确认的专属后台操作");
      if (source.assistant !== undefined ? assistant.enabled !== interaction.assistant?.enabled || assistant.purpose !== interaction.assistant?.purpose
        : interaction.assistant?.enabled) add("interaction.assistant", "必须保留已确认的页面助手选择与用途；需求未启用时不得自行添加");
    }
    if (value.schemaVersion === 3 && value.execution) {
      const developed = value.profile === "workflow" || value.profile === "custom" || interaction?.page || interaction?.operations
        || value.execution.hosting === "managed" || value.execution.hosting === "docker";
      if (Boolean(developed) !== (value.execution.language !== "none")) add("execution.language", "代码运行语言必须与实际交付的页面、操作或流程一致");
      const known = new Set(context.requirements?.map(item => item.id));
      if (context.requirements && value.selectionBasis?.requirementIds.some(id => !known.has(id)))
        add("selectionBasis.requirementIds", "全局选型依据只能引用本轮正式需求编号");
    }
  }
  return issues;
}

export function architectureCapabilityIssues(declared: readonly { id: string; status: string }[], catalog: readonly Capability[], root = "design"): StageSemanticIssue[] {
  const allowedReferences = catalog.filter(item => item.status === "available").map(item => item.id);
  const known = new Set(allowedReferences);
  return declared.flatMap((item, index) => item.status === "available" && !known.has(item.id)
    ? [{ path: `${root}.capabilities[${index}].id`, reason: "invalid_reference", message: "未被工具目录证实可用：available 能力必须使用当前目录的正式编号，不能自行命名或用平台交付机制代替工具编号", allowedReferences }] : []);
}
