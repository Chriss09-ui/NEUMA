import { InputError } from "../requirements/core.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
export interface JsonStoragePort {
  readonly ready?: Promise<void>;
  readJson(id: string, file: string, options?: { maxBytes?: number }): Promise<unknown>;
  writeJson(id: string, file: string, value: unknown, options?: { signal?: AbortSignal | undefined }): Promise<void>;
}
export interface AgentStoragePort extends JsonStoragePort {
  readonly dataDir?: string;
  agentIds(): Promise<string[]>;
  directory(id: string, subpath?: string, options?: { create?: boolean }): Promise<string>;
  jsonFiles(id: string, subpath: string): Promise<string[]>;
  removeFile(id: string, file: string): Promise<void>;
  removeDirectory(id: string, subpath: string): Promise<void>;
}

/** Only establish an object envelope. Individual stores validate their own fields next. */
export async function readStoredObject(storage: JsonStoragePort, id: string, file: string, options?: { maxBytes?: number }): Promise<UnknownRecord | null> {
  const value: unknown = await storage.readJson(id, file, options);
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") throw new InputError("存储记录格式无效，请保留原文件");
  return value as UnknownRecord;
}
