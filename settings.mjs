import { readFile, rename, writeFile } from "node:fs/promises";
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

export async function writeEnvFile(path, updates) {
  let content = "";
  try { content = await readFile(path, "utf8"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const pending = new Map(Object.entries(updates));
  const lines = content ? content.replace(/\n$/, "").split("\n") : [];
  const next = lines.map((line) => {
    const name = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/)?.[1];
    if (!name || !pending.has(name)) return line;
    const value = pending.get(name);
    pending.delete(name);
    return `${name}=${value}`;
  });
  for (const [name, value] of pending) next.push(`${name}=${value}`);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${next.join("\n")}\n`, { mode: 0o600 });
  await rename(temp, path);
}
