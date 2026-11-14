import type { ToolSchema } from "../contracts/tools.mjs";

const segment = /^(?:[A-Za-z_$][A-Za-z0-9_$-]*|0|[1-9][0-9]*)$/u;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const safe = (part: string) => segment.test(part) && !forbidden.has(part);

export const ASSERTION_PATH_GUIDE = "assertions.path使用点分隔属性路径，如error、result.items.0；空字符串表示整个输出。/error、/result/items/0这类各段含义明确的JSON Pointer由程序转换。含点的单个键、转义、空段、通配符或不安全属性不猜测；转换后同一用例不能出现重复路径。输入数据和预期值不随路径转换改变。";

export function normalizeAssertionPath(path: string): string {
  if (!path.startsWith("/") || path.length > 500) return path;
  const parts = path.slice(1).split("/");
  return parts.every(safe) ? parts.join(".") : path;
}

export function isSafeAssertionPath(path: unknown): path is string {
  return typeof path === "string" && path.length <= 500 && (path === "" || path.split(".").every(safe));
}

/** Presentation only: keep saved assignment schemas and bindings unchanged. */
export function withAssertionPathGuide(schema: ToolSchema): ToolSchema {
  const copy = structuredClone(schema);
  const visit = (rule: ToolSchema | boolean | undefined, depth: number) => {
    if (!rule || typeof rule === "boolean" || depth > 32) return;
    const path = rule.properties?.assertions?.items?.properties?.path;
    if (path?.type === "string") path.description = ASSERTION_PATH_GUIDE;
    for (const child of Object.values(rule.properties ?? {})) visit(child, depth + 1);
    visit(rule.items, depth + 1);
    for (const child of [...rule.anyOf ?? [], ...rule.oneOf ?? [], ...rule.allOf ?? []]) visit(child, depth + 1);
  };
  visit(copy, 0);
  return copy;
}
