/** Repairs only container punctuation/envelopes; JSON values are never rewritten. */
export const MODEL_JSON_MAX_BYTES = 256 * 1024;

function uniqueKeys(text: string) {
  const stack: (Set<string> | null)[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "{") stack.push(new Set());
    else if (char === "[") stack.push(null);
    else if (char === "}" || char === "]") stack.pop();
    else if (char === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') { if (text[index] === "\\") index++; index++; }
      let after = index + 1;
      while (/\s/u.test(text[after] ?? "") && after < text.length) after++;
      if (text[after] === ":") {
        const key = JSON.parse(text.slice(start, index + 1)) as string, keys = stack.at(-1);
        if (!keys || keys.has(key)) return false;
        keys.add(key);
      }
    }
    if (stack.length > 32) return false;
  }
  return true;
}

function repairedJson(text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > MODEL_JSON_MAX_BYTES) return undefined;
  try { const value: unknown = JSON.parse(text); return uniqueKeys(text) ? value : undefined; }
  catch { return undefined; }
}

export function recoverExtraJsonCloser(text: string, type: "object" | "array") {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(type === "object" ? "}" : "]")) return undefined;
  return repairedJson(trimmed.slice(0, -1));
}

export function recoverJsonEnvelope(text: string, field: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,79}$/u.test(field)) return undefined;
  return repairedJson(`{${JSON.stringify(field)}:${text}`);
}

// Some Node versions omit positions for unexpected tokens. Scan grammar without retaining values.
function syntaxOffset(text: string) {
  let index = 0;
  const frames: { kind: "root" | "object" | "array"; state: "value" | "valueOrEnd" | "key" | "keyOrEnd" | "colon" | "after" }[] = [{ kind: "root", state: "value" }];
  const invalid = (): never => { throw index; };
  const string = () => {
    if (text[index++] !== '"') { index--; invalid(); }
    while (index < text.length) {
      const char = text[index++]!;
      if (char === '"') return;
      if (char.charCodeAt(0) < 32) { index--; invalid(); }
      if (char !== "\\") continue;
      const escape = text[index++];
      if (escape === "u") {
        for (let count = 0; count < 4; count++, index++) if (!/^[0-9a-f]$/iu.test(text[index] ?? "")) invalid();
      } else if (!escape || !'"\\/bfnrt'.includes(escape)) { index = Math.min(index - 1, text.length); invalid(); }
    }
    invalid();
  };
  try {
    while (frames.length) {
      while (/^[\x20\t\r\n]$/u.test(text[index] ?? "")) index++;
      const frame = frames.at(-1)!, char = text[index], closing = frame.kind === "object" ? "}" : "]";
      if (frame.state === "after") {
        if (frame.kind === "root") { if (index !== text.length) invalid(); return index; }
        if (char === closing) { index++; frames.pop(); continue; }
        if (char !== ",") invalid();
        index++; frame.state = frame.kind === "object" ? "key" : "value"; continue;
      }
      if (frame.state === "keyOrEnd" || frame.state === "valueOrEnd") {
        if (char === closing) { index++; frames.pop(); continue; }
        frame.state = frame.kind === "object" ? "key" : "value";
      }
      if (frame.state === "key") { if (char !== '"') invalid(); string(); frame.state = "colon"; continue; }
      if (frame.state === "colon") { if (char !== ":") invalid(); index++; frame.state = "value"; continue; }
      frame.state = "after";
      if (char === "{" || char === "[") { index++; frames.push({ kind: char === "{" ? "object" : "array", state: char === "{" ? "keyOrEnd" : "valueOrEnd" }); continue; }
      if (char === '"') { string(); continue; }
      const literal = char === "t" ? "true" : char === "f" ? "false" : char === "n" ? "null" : undefined;
      if (literal) { for (const expected of literal) { if (text[index] !== expected) invalid(); index++; } continue; }
      const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(index));
      if (number) index += number[0].length;
      else invalid();
    }
  } catch (offset) { if (typeof offset === "number") return Math.min(offset, text.length); throw offset; }
  return index;
}

/** Only numeric positions and fixed descriptions leave the parser; never its raw error text. */
export function modelJsonSyntaxIssue(value: unknown) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MODEL_JSON_MAX_BYTES || !/^[\s]*[\[{]/u.test(value)) return undefined;
  try { JSON.parse(value); return undefined; }
  catch (error) {
    if (!(error instanceof SyntaxError)) return undefined;
    const match = /\bposition ([0-9]{1,7})\b/u.exec(error.message);
    const offset = match ? Number(match[1]) : syntaxOffset(value);
    if (offset === undefined || offset > value.length) return undefined;
    const prefix = value.slice(0, offset), line = prefix.split("\n").length, column = offset - prefix.lastIndexOf("\n");
    return { reason: "invalid_json", location: { offset, line, column },
      remedy: `该字段的JSON文本在第 ${line} 行、第 ${column} 列（字符偏移 ${offset}）无法解析。检查此处的引号、转义、闭合符、逗号或额外字段；保留业务内容，修正具体位置后重交。不能仅重复切换对象与字符串的包装。` };
  }
}
