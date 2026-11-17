/** JSON Schema maxLength counts Unicode code points, not UTF-16 offsets or bytes. */
export function textLength(value: string): number {
  if (typeof value !== "string") throw new TypeError("字符计数需要文本");
  let count = 0;
  for (const character of value) count++;
  return count;
}

export function textWithinLimit(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || !Number.isSafeInteger(maximum) || maximum < 0) return false;
  let count = 0;
  for (const character of value) if (++count > maximum) return false;
  return true;
}

const schemaPatterns = new Map<string, RegExp>();
export const SCHEMA_PATTERN_MAX_CHARS = 256;

/** Match a schema pattern without compiling an unbounded expression on every value. */
export function schemaPatternMatches(pattern: string, value: string): boolean {
  if (pattern.length > SCHEMA_PATTERN_MAX_CHARS) return false;
  let compiled = schemaPatterns.get(pattern);
  if (!compiled) {
    compiled = new RegExp(pattern);
    if (schemaPatterns.size < 32) schemaPatterns.set(pattern, compiled);
  }
  return compiled.test(value);
}

export function truncateText(value: string, maximum: number): string {
  if (typeof value !== "string" || !Number.isSafeInteger(maximum) || maximum < 0) throw new TypeError("文本截取参数无效");
  let count = 0, offset = 0;
  for (const character of value) { if (count++ === maximum) break; offset += character.length; }
  return value.slice(0, offset);
}
