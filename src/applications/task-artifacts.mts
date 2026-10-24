import type { AgentStorage } from "../agents/agent-storage.mjs";
import type { TaskArtifact } from "../contracts/application.mjs";
interface ArtifactInput { storage: Pick<AgentStorage, "path">; id: string; taskId: string }
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { agentId } from "../agents/agent-storage.mjs";
import { MAX_RUNTIME_FILE_BYTES } from "../runtime/file-limits.mjs";

export const TASK_ARTIFACT_PAGE_BYTES = 64 * 1024;
const snapshotId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const unavailable = () => Object.assign(new InputError("该历史产物没有可核实的独立快照，请重新执行任务生成产物"), { reason: "artifact_snapshot_unavailable" });
const invalid = () => Object.assign(new InputError("任务产物快照已变化或无法安全读取"), { reason: "artifact_snapshot_invalid" });
const snapshotPath = (taskId: string, id: string) => `application/artifacts/${agentId(taskId)}/${id}.bin`;

export async function saveTaskArtifact({ storage, id, taskId, path, data, signal }: ArtifactInput & { path: unknown; data: unknown; signal?: AbortSignal | undefined }) {
  agentId(id); agentId(taskId); signal?.throwIfAborted();
  if (typeof path !== "string" || !path || path.length > 1000 || /[\x00-\x1f\x7f]/.test(path)
    || !Buffer.isBuffer(data) || data.length > MAX_RUNTIME_FILE_BYTES) throw new InputError("任务产物内容或路径无效");
  const bytes = Buffer.from(data);
  const artifact = { path, name: path.split("/").filter(Boolean).at(-1), snapshotId: randomUUID(), size: bytes.length, sha256: sha256(bytes) };
  const target = await storage.path(id, snapshotPath(taskId, artifact.snapshotId), true);
  let handle, saved = false, created = false;
  try {
    handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    await handle.writeFile(bytes); await handle.chmod(0o400); await handle.close(); handle = null;
    signal?.throwIfAborted(); saved = true;
    return artifact;
  } finally {
    await handle?.close();
    if (created && !saved) await rm(target, { force: true });
  }
}

export async function removeTaskArtifact({ storage, id, taskId, artifact }: Omit<ArtifactInput, "storage"> & { storage: Pick<AgentStorage, "removeFile">; artifact: TaskArtifact | null | undefined }) {
  if (!snapshotId(artifact?.snapshotId)) return;
  await storage.removeFile(id, snapshotPath(taskId, artifact.snapshotId));
}

export async function readTaskArtifactSnapshot({ storage, id, taskId, artifact, offset = 0, limit = TASK_ARTIFACT_PAGE_BYTES, signal }: ArtifactInput & { artifact: TaskArtifact; offset?: number | undefined; limit?: number | undefined; signal?: AbortSignal | undefined }) {
  agentId(id); agentId(taskId); signal?.throwIfAborted();
  if (!snapshotId(artifact?.snapshotId)) throw unavailable();
  if (typeof artifact.path !== "string" || !artifact.path || typeof artifact.name !== "string" || !artifact.name
    || typeof artifact.size !== "number" || !Number.isSafeInteger(artifact.size) || artifact.size < 0 || artifact.size > MAX_RUNTIME_FILE_BYTES
    || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw invalid();
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > artifact.size || !Number.isSafeInteger(limit)
    || limit < 1 || limit > TASK_ARTIFACT_PAGE_BYTES) throw new InputError("产物读取位置或分页大小无效");
  let handle;
  try {
    handle = await open(await storage.path(id, snapshotPath(taskId, artifact.snapshotId)), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size !== artifact.size) throw invalid();
    const bytes = await handle.readFile(); signal?.throwIfAborted();
    if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256) throw invalid();
    const end = Math.min(offset + limit, bytes.length);
    return { name: artifact.name, path: artifact.path, size: artifact.size, sha256: artifact.sha256,
      offset, nextOffset: end < bytes.length ? end : null, encoding: "base64", data: bytes.subarray(offset, end).toString("base64") };
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof InputError) throw error;
    throw invalid();
  } finally { await handle?.close(); }
}
