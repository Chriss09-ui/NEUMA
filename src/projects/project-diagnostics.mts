import { objectFields, isArray, isInteger, errorField } from "../runtime/type-boundary.mjs";
export interface ProjectDiagnostic { stage: string; reason: string; retries: number; recordId?: string; recorded?: boolean }
interface FailureRecord { id: string; createdAt: string; name: string; path: string; message: string; diagnostic: ProjectDiagnostic }
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { InputError } from "../requirements/core.mjs";

const FALLBACK = "项目检查未完成，请稍后重试";
const MAX_RECORDS = 50;

export function safeDiagnosticText(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[已隐藏私钥]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[已隐藏]@")
    .replace(/Bearer\s+[^\s,;"'<>]+/gi, "Bearer [已隐藏]")
    .replace(/((?:[\w-]*(?:api[_-]?key|access[_-]?(?:token|pass)|token|password|passwd|secret|authorization)[\w-]*)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^,;&}\r\n]+)/gi, "$1[已隐藏]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[已隐藏]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 1000);
}

function diagnosticCode(value: unknown, fallback: string) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : fallback;
}

export function createProjectAddError({ stage = "inspection", reason = "inspection_failed", message, retries = 0 }: { stage?: unknown; reason?: unknown; message?: unknown; retries?: unknown } = {}) {
  const detail = (safeDiagnosticText(message) || FALLBACK)
    .replace(/^添加失败[：:，,]?\s*/, "").replace(/项目未加入列表[。.!！\s]*$/, "").replace(/[。.!！\s]+$/, "") || FALLBACK;
  const error = new InputError(`添加失败：${detail}。项目未加入列表。`);
  const diagnostic: ProjectDiagnostic = { stage: diagnosticCode(stage, "inspection"), reason: diagnosticCode(reason, "inspection_failed"),
    retries: isInteger(retries) && retries >= 0 ? Math.min(retries, 5) : 0 };
  return Object.assign(error, { code: "PROJECT_ADD_FAILED", diagnostic, reason: diagnostic.reason });
}

function safeFailure(error: unknown) {
  if (!(error instanceof InputError)) return createProjectAddError();
  return createProjectAddError({ ...(errorField(error, "code") === "PROJECT_ADD_FAILED" ? objectFields(errorField(error, "diagnostic")) : { stage: "input", reason: "invalid_request" }),
    message: error.message });
}

function validRecord(input: unknown): input is FailureRecord {
  const record = objectFields(input), diagnostic = objectFields(record.diagnostic);
  return record && typeof record.id === "string" && typeof record.createdAt === "string"
    && Number.isFinite(Date.parse(record.createdAt)) && typeof record.name === "string" && typeof record.path === "string"
    && typeof record.message === "string" && typeof diagnostic.stage === "string"
    && typeof diagnostic.reason === "string" && Number.isSafeInteger(diagnostic.retries);
}

export class ProjectFailureStore {
  dataDir: string; file: string; pending: Promise<unknown>;
  constructor({ dataDir }: { dataDir: string }) {
    this.dataDir = dataDir;
    this.file = join(dataDir, "project-add-failures.json");
    this.pending = Promise.resolve();
  }

  async read() {
    let source;
    try { source = await readFile(this.file, "utf8"); }
    catch (error) {
      if (errorField(error, "code") === "ENOENT") return [];
      throw new InputError("无法读取项目添加失败记录，请检查本机文件权限");
    }
    let data: Record<string, unknown> = {};
    try { data = objectFields(JSON.parse(source)); } catch { /* Report damaged history without overwriting it. */ }
    if (data?.version !== 1 || !isArray(data.failures) || !data.failures.every(validRecord)) {
      throw new InputError("项目添加失败记录已损坏，已保留原文件，请修复后重试");
    }
    return data.failures.map((record) => {
      const error = createProjectAddError({ ...record.diagnostic, message: record.message });
      return { id: safeDiagnosticText(record.id), createdAt: record.createdAt,
        name: safeDiagnosticText(record.name).slice(0, 160), path: safeDiagnosticText(record.path),
        message: error.message, diagnostic: error.diagnostic };
    });
  }

  async record({ name, path, error }: { name: unknown; path: unknown; error: unknown }) {
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

  async list({ limit = 10 }: { limit?: unknown } = {}) {
    await this.pending;
    const count = isInteger(limit) && limit > 0 ? Math.min(limit, MAX_RECORDS) : 10;
    return (await this.read()).slice(0, count);
  }
}
