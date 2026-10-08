import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { InputError } from "./core.mjs";

const FIELDS = {
  chatUrl: "NEUMA_LLM_CHAT_URL",
  model: "NEUMA_LLM_MODEL",
  apiKey: "NEUMA_LLM_API_KEY",
  jevApiKey: "TYPESAFE_API_KEY",
  jevModel: "TYPESAFE_MODEL",
};
const SECRET_FIELDS = new Set(["apiKey", "jevApiKey"]);
const CLEARABLE = new Set(["apiKey", "jevApiKey"]);
const fileWrites = new Map();

function secretHint(value) {
  if (!value) return { set: false, hint: "" };
  return { set: true, hint: value.length >= 12 ? value.slice(-4) : "" };
}

export function settingsView(config) {
  return {
    chatUrl: config.chatUrl || "",
    model: config.model || "",
    jevModel: config.jevModel || "",
    apiKey: secretHint(config.apiKey),
    jevApiKey: secretHint(config.jevApiKey),
    llmConfigured: Boolean(config.llmConfigured),
    jevConfigured: Boolean(config.jevConfigured),
  };
}

export function configEnv(config) {
  return {
    NEUMA_LLM_CHAT_URL: config.chatUrl || "",
    NEUMA_LLM_MODEL: config.model || "",
    NEUMA_LLM_API_KEY: config.apiKey || "",
    NEUMA_LLM_TIMEOUT_MS: config.llmTimeoutMs ? String(config.llmTimeoutMs) : "",
    TYPESAFE_API_KEY: config.jevApiKey || "",
    TYPESAFE_MODEL: config.jevModel || "",
  };
}

function checkChatUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search
      || !url.pathname.endsWith("/chat/completions")) throw new Error();
  } catch {
    throw new InputError("接口地址需要是以 /chat/completions 结尾的 http(s) 地址");
  }
}

// Values are written unquoted into .env, so anything that changes dotenv parsing is rejected.
export function settingsUpdates(body) {
  const updates = {};
  for (const [field, name] of Object.entries(FIELDS)) {
    if (body[field] === undefined || body[field] === null) continue;
    if (typeof body[field] !== "string") throw new InputError("配置项必须是文字");
    const value = body[field].trim();
    if (SECRET_FIELDS.has(field) && !value) continue;
    if (value.length > 500 || /[\s"'`#\\]/.test(value)) throw new InputError("配置项包含不支持的字符或过长");
    if (field === "chatUrl") checkChatUrl(value);
    if ((field === "model" || field === "jevModel") && value && !/^[\w.:/@-]{1,200}$/.test(value)) {
      throw new InputError("模型名只能包含字母、数字和 . : / @ - _");
    }
    if (field === "model" && !value) throw new InputError("请填写模型名");
    updates[name] = value;
  }
  if (body.clear !== undefined) {
    if (!Array.isArray(body.clear) || body.clear.some((item) => !CLEARABLE.has(item))) {
      throw new InputError("无法识别要清除的配置项");
    }
    for (const field of body.clear) updates[FIELDS[field]] = "";
  }
  if (!Object.keys(updates).length) throw new InputError("没有需要保存的修改");
  return updates;
}

function* envEntries(content) {
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    let end = newline < 0 ? content.length : newline + 1;
    const line = content.slice(start, end), name = Object.keys(parseEnv(line))[0];
    let comment = "";
    if (name !== undefined) {
      let valueStart = start + line.indexOf("=") + 1;
      while ([" ", "\t", "\r"].includes(content[valueStart])) valueStart++;
      let commentStart = valueStart;
      if (["\"", "'", "`"].includes(content[valueStart])) {
        const closing = content.indexOf(content[valueStart], valueStart + 1);
        // Native dotenv treats an unclosed quote as a single-line literal value.
        if (closing >= 0) {
          const followingNewline = content.indexOf("\n", closing + 1);
          end = followingNewline < 0 ? content.length : followingNewline + 1;
          commentStart = closing + 1;
        }
      }
      const marker = content.indexOf("#", commentStart);
      if (marker >= 0 && marker < end) {
        let suffix = marker;
        while (suffix > commentStart && [" ", "\t"].includes(content[suffix - 1])) suffix--;
        comment = content.slice(suffix, end);
      }
    }
    const raw = content.slice(start, end), ending = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
    yield { name, raw, comment, suffix: comment || ending };
    start = end;
  }
}

async function replaceEnvFile(path, updates) {
  let content = "";
  try { content = await readFile(path, "utf8"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const pending = new Map(Object.entries(updates));
  const next = [];
  for (const { name, raw, comment, suffix } of envEntries(content)) {
    if (name === undefined || !Object.hasOwn(updates, name)) next.push(raw);
    else if (pending.has(name)) {
      next.push(`${name}=${pending.get(name)}${suffix}`);
      pending.delete(name);
    } else if (comment) next.push(comment);
  }
  let updated = next.join("");
  for (const [name, value] of pending) {
    if (updated && !updated.endsWith("\n")) updated += "\n";
    updated += `${name}=${value}\n`;
  }
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, updated, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export async function writeEnvFile(path, updates) {
  const file = resolve(path), values = { ...updates };
  const result = (fileWrites.get(file) ?? Promise.resolve()).then(() => replaceEnvFile(file, values));
  const queued = result.catch(() => {});
  fileWrites.set(file, queued);
  try { await result; }
  finally { if (fileWrites.get(file) === queued) fileWrites.delete(file); }
}
