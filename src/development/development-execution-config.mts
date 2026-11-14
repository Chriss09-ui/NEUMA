import type { DevelopmentArchitecture } from "../contracts/development.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";

export interface DevelopmentExecutionConfig {
  schemaVersion?: 2 | 3;
  runtime: "node-json" | "node-action" | "managed-service";
  protocolVersion?: 2 | 3;
  language: "javascript" | "python" | "none";
  hosting: "builtin" | "managed" | "docker";
}

/** This is a projection of the approved architecture, never another model decision. */
export function developmentExecutionConfig(architecture: DevelopmentArchitecture): DevelopmentExecutionConfig {
  const version = architecture.design?.schemaVersion;
  if (version === undefined || version === 1) return { runtime: "node-json", language: "javascript", hosting: "builtin" };
  if (version === 2) return { schemaVersion: 2, runtime: "node-action", protocolVersion: 2, language: "javascript", hosting: "builtin" };
  const execution = architecture.design?.execution;
  if (version !== 3 || !execution || !["javascript", "python", "none"].includes(execution.language)
    || !["builtin", "managed", "docker"].includes(execution.hosting)
    || execution.hosting === "builtin" && execution.language === "python"
    || execution.hosting !== "builtin" && execution.language === "none")
    throw new TypeError("已批准架构的运行配置无效，不能替模型重新选择运行方式。");
  const managed = execution.hosting !== "builtin";
  return { schemaVersion: 3, runtime: managed ? "managed-service" : "node-action", protocolVersion: managed ? 3 : 2,
    language: execution.language as DevelopmentExecutionConfig["language"], hosting: execution.hosting as DevelopmentExecutionConfig["hosting"] };
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Only incoming, unaccepted plans are assembled. Stored plans still undergo strict validation. */
export function applyDevelopmentExecution(input: unknown, schema: ToolSchema, config: DevelopmentExecutionConfig): unknown {
  if (!isObject(input)) return input;
  if (schema.properties?.plan?.properties?.runtime) {
    return { ...input, plan: applyDevelopmentExecution(input.plan, schema.properties.plan, config) };
  }
  if (!schema.properties?.runtime) return input;
  const plan = structuredClone(input);
  plan.runtime = config.runtime;
  if (config.schemaVersion !== undefined) plan.schemaVersion = config.schemaVersion;
  if (config.protocolVersion !== undefined && (plan.application === undefined || isObject(plan.application))) {
    const application: Record<string, unknown> = { ...objectFields(plan.application), runtime: config.runtime, protocolVersion: config.protocolVersion };
    if (config.runtime === "managed-service" && (application.service === undefined || isObject(application.service)))
      application.service = { ...objectFields(application.service), language: config.language, host: config.hosting };
    plan.application = application;
  }
  return plan;
}

function supplied(schema: ToolSchema, values: Record<string, string | number>) {
  const result = structuredClone(schema);
  result.properties = { ...result.properties };
  for (const [key, value] of Object.entries(values)) result.properties[key] = {
    ...result.properties[key], type: typeof value === "number" ? "integer" : "string", enum: [value],
    description: "程序依据已批准架构自动填写，无需模型提交；兼容旧稿填写。",
  };
  if (result.required) result.required = result.required.filter(key => !Object.hasOwn(values, key));
  return result;
}

export function developmentServiceInputSchema(schema: ToolSchema, config: DevelopmentExecutionConfig): ToolSchema {
  return supplied(schema, { language: config.language, host: config.hosting });
}

/** Keep the saved group contract unchanged; specialize only its delivery to the model. */
export function developmentExecutionInputSchema(schema: ToolSchema, config: DevelopmentExecutionConfig): ToolSchema {
  if (schema.properties?.plan?.properties?.runtime) return { ...schema, properties: { ...schema.properties,
    plan: developmentExecutionInputSchema(schema.properties.plan, config) } };
  if (!schema.properties?.runtime) return schema;
  const result = supplied(schema, { runtime: config.runtime, ...(config.schemaVersion !== undefined ? { schemaVersion: config.schemaVersion } : {}) });
  if (config.protocolVersion !== undefined && result.properties?.application) {
    const application = supplied(result.properties.application, { runtime: config.runtime, protocolVersion: config.protocolVersion });
    if (config.runtime === "managed-service" && application.properties?.service)
      application.properties.service = developmentServiceInputSchema(application.properties.service, config);
    result.properties.application = application;
  }
  return result;
}

export function developmentExecutionGuide(config: DevelopmentExecutionConfig) {
  const entry = config.runtime === "node-json" ? "入口读取 process.argv[2]，stdout 返回一个 JSON。"
    : config.runtime === "node-action" ? "JavaScript 入口导出 export const actions = { async actionId(input, ctx) { ... } }。"
      : config.language === "python" ? "Python 入口定义 def run(request, ctx) 或 async def run(request, ctx)，ctx 方法为同步调用。"
        : "JavaScript 入口导出 async function run({ actionId, input }, ctx)，ctx 方法使用 await。";
  return `本轮运行配置由程序从已批准架构确定：${JSON.stringify(config)}。无需填写或重新选择计划 schemaVersion/runtime、application.runtime/protocolVersion，以及受管 service.language/host；程序在接收时填入，旧稿同名字段以此配置为准。${entry}${config.runtime === "managed-service" ? "仍须按 serviceManifestSchema 提供 service 的其余实现配置。" : ""}入口路径、动作和依赖按本项目设计；旧稿的实现说明也须与固定运行方式一致，接收后仍执行完整校验。`;
}
