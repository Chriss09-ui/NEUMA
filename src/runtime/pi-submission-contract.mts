import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import type { ToolSchema } from "../contracts/tools.mjs";
import { objectFields, isArray, isRecord } from "./type-boundary.mjs";
interface SubmissionTool { name: string; parameters: ToolSchema }

const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,119}$/;
const ajv = new Ajv({ strict: false, coerceTypes: false });
const validators = new WeakMap<ToolSchema, ValidateFunction<unknown>>();
function matchesArguments(value: unknown, schema: ToolSchema) {
  if (!validators.has(schema)) validators.set(schema, ajv.compile(schema));
  return validators.get(schema)!(value);
}

/** Explicit submit-only controllers describe their registered terminal tools without changing execution. */
export function renderPiSubmissionContract({ role, submitName, tools, alternativeTools = [], structuredResponse = false }: { role: string; submitName: string; tools: SubmissionTool[]; alternativeTools?: string[]; structuredResponse?: boolean }) {
  const names = isArray(tools) ? tools.map((tool) => tool?.name) : [];
  if (typeof role !== "string" || !identifier.test(role) || typeof submitName !== "string" || !identifier.test(submitName)
    || !isArray(alternativeTools) || names.filter((name) => name === submitName).length !== 1
    || new Set(alternativeTools).size !== alternativeTools.length
    || alternativeTools.some((name) => typeof name !== "string" || !identifier.test(name) || name === submitName
      || names.filter((registered) => registered === name).length !== 1))
    throw new TypeError("正式提交提示必须绑定当前角色及唯一注册的主工具和替代工具");
  const alternatives = alternativeTools.length ? `；满足各工具本轮公开前置条件时，也可实际调用${alternativeTools.join("、")}作为正式终止出口` : "";
  return `宿主提交契约：role=${role}，submitName=${submitName}；完成本阶段时${structuredResponse ? "可以实际发起" : "必须实际发起"}${submitName}的正式tool_call${alternatives}${structuredResponse ? "。" : "，完整JSON、代码块或仅含工具名与参数的正文均不算工具调用。"}\n此契约不要求立即提交，不跳过既有检查，也不改变预算；各提交或终止工具仍须满足本轮公开前置条件。`
    + (structuredResponse ? `\n结构化结果也是本阶段正式提交通道：正常结束时可仅返回一个JSON对象，格式为{\"submission\":{\"name\":\"${submitName}\",\"arguments\":{完整参数}}}；也可直接返回严格符合已声明提交参数的完整对象。该通道仅允许本轮明确列出的终止出口，由宿主执行同一结构校验、版本检查和独立验收。读取、写文件、搜索及外部操作必须实际调用工具，正文不能执行这些操作。禁止代码围栏、额外解释或批量命令。` : "");
}

/** Decode data from a complete controller response; never infer or execute general tool calls. */
export function readPiStructuredSubmission<T extends SubmissionTool>(raw: unknown, { tools, validate = matchesArguments }: { tools: T[]; validate?: (value: unknown, schema: ToolSchema) => boolean }) {
  const message = objectFields(raw);
  if (message?.role !== "assistant" || message.stopReason !== "stop" || !isArray(message.content)
    || message.content.some((part) => !new Set<unknown>(["text", "thinking"]).has(objectFields(part).type))) return null;
  const text = message.content.filter((part) => objectFields(part).type === "text");
  if (text.length !== 1 || typeof objectFields(text[0]).text !== "string" || Buffer.byteLength(objectFields(text[0]).text as string, "utf8") > 256 * 1024) return null;
  let value: unknown;
  try { value = JSON.parse(objectFields(text[0]).text as string); } catch { return null; }
  let nodes = 0;
  const inert = (entry: unknown, depth = 0): boolean => {
    if (++nodes > 100_000 || depth > 32) return false;
    return !entry || typeof entry !== "object" || Object.entries(entry).every(([key, child]) =>
      !["__proto__", "prototype", "constructor"].includes(key) && inert(child, depth + 1));
  };
  if (!isRecord(value) || !inert(value)) return null;
  let named: unknown;
  if (Object.keys(value).length === 1 && Object.hasOwn(value, "submission")) {
    named = value.submission;
  } else if (Object.keys(value).length === 2 && Object.hasOwn(value, "arguments")
    && (Object.hasOwn(value, "name") || Object.hasOwn(value, "tool"))) {
    named = { name: value.name ?? value.tool, arguments: value.arguments };
  }
  if (named) {
    if (!named || isArray(named) || Object.keys(objectFields(named)).length !== 2 || !Object.hasOwn(named, "name")
      || !Object.hasOwn(named, "arguments")) return null;
    const tool = tools.find((item) => item.name === objectFields(named).name);
    return tool && validate(objectFields(named).arguments, tool.parameters) ? { tool, args: objectFields(named).arguments } : null;
  }
  const matches = tools.filter((tool) => validate(value, tool.parameters));
  return matches.length === 1 ? { tool: matches[0]!, args: value } : null;
}
