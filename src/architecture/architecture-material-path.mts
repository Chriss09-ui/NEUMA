import type { UnknownRecord } from "../contracts/json.mjs";
import { InputError } from "../requirements/core.mjs";
import { modelContextValue } from "../runtime/model-context.mjs";

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const encode = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1");
const ownValue = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
};

export const ARCHITECTURE_ID_READ_RULE = "读取数组条目时可用完整、大小写一致的唯一id（没有id时用requirementId）代替数字位置，如/components/FailureHandler/purpose。程序返回实际数字路径；正式引用和修改可使用返回的位置。重复编号或不存在的编号不猜测，按返回的位置列表选择。";

export function architectureMaterialId(value: unknown): string | undefined {
  const id = ownValue(value, "id") ?? ownValue(value, "requirementId");
  return typeof id === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(id) ? id : undefined;
}

type Location = { found: true; pointer: string; value: unknown } | {
  found: false; pointer: string; reason: "reference_path_missing" | "reference_id_ambiguous";
  parentPointer?: string; availablePaths?: string[]; totalMatches?: number;
};

/** Only exact, unique identifiers within the selected array can become numeric locations. */
export function locateArchitectureMaterial(value: unknown, pointer: unknown): Location {
  if (typeof pointer !== "string" || pointer.length > 500 || pointer !== "" && (!pointer.startsWith("/") || /~(?![01])/u.test(pointer)))
    return { found: false, pointer: typeof pointer === "string" ? pointer : "", reason: "reference_path_missing" };
  const segments = pointer === "" ? [] : pointer.slice(1).split("/").map(key => key.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current = value, canonical = "";
  for (const [position, segment] of segments.entries()) {
    const missing = (): Location => ({ found: false, pointer: canonical + "/" + segments.slice(position).map(encode).join("/"),
      parentPointer: canonical, reason: "reference_path_missing" });
    if (forbidden.has(segment) || !current || typeof current !== "object") return missing();
    let key = segment;
    if (Array.isArray(current) && !/^(0|[1-9]\d*)$/u.test(key)) {
      const matches: number[] = [];
      for (let index = 0; index < current.length; index++) if (architectureMaterialId(ownValue(current, String(index))) === key) matches.push(index);
      if (matches.length > 1) return { found: false, pointer, reason: "reference_id_ambiguous", parentPointer: canonical,
        availablePaths: matches.slice(0, 24).map(index => `${canonical}/${index}`), totalMatches: matches.length };
      if (!matches.length) return missing();
      key = String(matches[0]);
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return missing();
    current = descriptor.value; canonical += "/" + encode(key);
  }
  return { found: true, pointer: canonical, value: current };
}

/** Architecture-only adapter; generic context readers keep their original pointer contract. */
export function architectureMaterialPointer(source: UnknownRecord, section: unknown, pointer: unknown): string {
  const selected = locateArchitectureMaterial(modelContextValue(source, section), pointer);
  if (selected.found) return selected.pointer;
  if (selected.reason === "reference_id_ambiguous") throw Object.assign(new InputError("资料编号重复，不能自动选取；请使用返回的数字位置。"), {
    contextIssue: { reason: selected.reason, parentPointer: selected.parentPointer,
      availablePaths: selected.availablePaths, totalMatches: selected.totalMatches },
  });
  // Keep the existing bounded missing-path/type diagnostics, after any verified parent resolution.
  modelContextValue(source, section, typeof pointer === "string" ? selected.pointer : pointer);
  throw new InputError("资料位置不存在，请核对当前目录。");
}
