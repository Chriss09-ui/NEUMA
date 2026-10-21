/** JSON Schema maxLength counts Unicode code points, not UTF-16 offsets or bytes. */
export function textLength(value) {
  if (typeof value !== "string") throw new TypeError("字符计数需要文本");
  let count = 0;
  for (const character of value) count++;
  return count;
}

export function textWithinLimit(value, maximum) {
  if (typeof value !== "string" || !Number.isSafeInteger(maximum) || maximum < 0) return false;
  let count = 0;
  for (const character of value) if (++count > maximum) return false;
  return true;
}

export function truncateText(value, maximum) {
  if (typeof value !== "string" || !Number.isSafeInteger(maximum) || maximum < 0) throw new TypeError("文本截取参数无效");
  let count = 0, offset = 0;
  for (const character of value) { if (count++ === maximum) break; offset += character.length; }
  return value.slice(0, offset);
}
