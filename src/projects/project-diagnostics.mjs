import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { InputError } from "../requirements/core.mjs";

const FALLBACK = "项目检查未完成，请稍后重试";
const MAX_RECORDS = 50;

export function safeDiagnosticText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[已隐藏私钥]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[已隐藏]@")
    .replace(/Bearer\s+[^\s,;"'<>]+/gi, "Bearer [已隐藏]")
    .replace(/((?:[\w-]*(?:api[_-]?key|access[_-]?(?:token|pass)|token|password|passwd|secret|authorization)[\w-]*)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^,;&}\r\n]+)/gi, "$1[已隐藏]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[已隐藏]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 1000);
}

function diagnosticCode(value, fallback) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : fallback;
}

export function createProjectAddError({ stage = "inspection", reason = "inspection_failed", message, retries = 0 } = {}) {
  const detail = (safeDiagnosticText(message) || FALLBACK)
    .replace(/^添加失败[：:，,]?\s*/, "").replace(/项目未加入列表[。.!！\s]*$/, "").replace(/[。.!！\s]+$/, "") || FALLBACK;
  const error = new InputError(`添加失败：${detail}。项目未加入列表。`);
  error.code = "PROJECT_ADD_FAILED";
  error.diagnostic = { stage: diagnosticCode(stage, "inspection"), reason: diagnosticCode(reason, "inspection_failed"),
    retries: Number.isSafeInteger(retries) && retries >= 0 ? Math.min(retries, 5) : 0 };
  error.reason = error.diagnostic.reason;
  return error;
}

function safeFailure(error) {
  if (!(error instanceof InputError)) return createProjectAddError();
  return createProjectAddError({ ...(error.code === "PROJECT_ADD_FAILED" ? error.diagnostic : { stage: "input", reason: "invalid_request" }),
    message: error.message });
}

function validRecord(record) {
  return record && typeof record.id === "string" && typeof record.createdAt === "string"
    && Number.isFinite(Date.parse(record.createdAt)) && typeof record.name === "string" && typeof record.path === "string"
    && typeof record.message === "string" && typeof record.diagnostic?.stage === "string"
    && typeof record.diagnostic.reason === "string" && Number.isSafeInteger(record.diagnostic.retries);
}

export class ProjectFailureStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.file = join(dataDir, "project-add-failures.json");
    this.pending = Promise.resolve();
  }

  async read() {
    let source;
    try { source = await readFile(this.file, "utf8"); }
    catch (error) {
      if (error.code === "ENOENT") return [];
      throw new InputError("无法读取项目添加失败记录，请检查本机文件权限");
    }
    let data;
    try { data = JSON.parse(source); } catch { /* Report damaged history without overwriting it. */ }
    if (data?.version !== 1 || !Array.isArray(data.failures) || !data.failures.every(validRecord)) {
      throw new InputError("项目添加失败记录已损坏，已保留原文件，请修复后重试");
    }
    return data.failures.map((record) => {
      const error = createProjectAddError({ ...record.diagnostic, message: record.message });
      return { id: safeDiagnosticText(record.id), createdAt: record.createdAt,
        name: safeDiagnosticText(record.name).slice(0, 160), path: safeDiagnosticText(record.path),
        message: error.message, diagnostic: error.diagnostic };
    });
  }

  async record({ name, path, error }) {
    const failure = safeFailure(error);
    const record = { id: randomUUID(), createdAt: new Date().toISOString(), name: safeDiagnosticText(name).slice(0, 160),
      path: safeDiagnosticText(path), message: failure.message, diagnostic: failure.diagnostic };
    const operation = this.pending.then(async () => {
      const records = await this.read();
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
        await writeFile(temp, JSON.stringify({ version: 1, failures: [record, ...records].slice(0, MAX_RECORDS) }, null, 2), { mode: 0o600, flag: "wx" });
        await rename(temp, this.file);
      } catch {
        throw new InputError("无法保存项目添加失败记录，请检查本机文件权限");
      } finally { await unlink(temp).catch(() => {}); }
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  async list({ limit = 10 } = {}) {
    await this.pending;
    const count = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_RECORDS) : 10;
    return (await this.read()).slice(0, count);
  }
}
