import type { SessionMessage, SessionStorage } from "../runtime/execution-port.mjs";
import { InputError } from "../requirements/core.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import { designHash } from "./architecture-contract.mjs";

export const DESIGN_SUBMISSION_REJECTION_LIMIT = 5;
export interface DesignSubmissionPolicy { version: 1; limit: 5; receipts: Record<string, string[]> }

export function readDesignSubmissionPolicy(value: unknown): DesignSubmissionPolicy {
  const policy = objectFields(value), receipts = objectFields(policy.receipts);
  if (policy.version !== 1 || policy.limit !== DESIGN_SUBMISSION_REJECTION_LIMIT
    || Object.keys(policy).sort().join() !== "limit,receipts,version" || !policy.receipts
    || Array.isArray(policy.receipts) || Object.keys(receipts).length > 12
    || Object.entries(receipts).some(([key, ids]) => !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/u.test(key)
      || !Array.isArray(ids) || ids.length > 64 || ids.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/u.test(id))
      || new Set(ids).size !== ids.length)) throw new InputError("设计任务退回计数无效，不能清空后重试");
  return structuredClone(value) as DesignSubmissionPolicy;
}

export function designSubmissionRejections(policy: DesignSubmissionPolicy | undefined, key: string) {
  return policy?.receipts[key]?.length ?? 0;
}

export function recordDesignSubmissionRejection(policy: DesignSubmissionPolicy, key: string, receipt: unknown) {
  const ids = policy.receipts[key] ??= [], id = designHash(receipt);
  if (!ids.includes(id)) ids.push(id);
  return ids.length;
}

const submissions = new Set(["submit_architecture_blueprint", "submit_architecture_module", "submit_architecture_integration",
  "submit_blueprint_analysis", "submit_architecture_draft", "revise_architecture_submission"]);

export function historicalDesignRejections(messages: readonly SessionMessage[], file: string) {
  const ids = new Set<string>();
  for (const message of messages) if (message.role === "toolResult" && message.isError && typeof message.toolName === "string" && submissions.has(message.toolName))
    ids.add(designHash({ file, toolCallId: message.toolCallId }));
  return [...ids];
}

export function assertDesignSubmissionHistory(current: unknown, prior: readonly unknown[]) {
  const policy = current === undefined ? undefined : readDesignSubmissionPolicy(current);
  for (const value of prior) {
    if (value === undefined) continue;
    const saved = readDesignSubmissionPolicy(value);
    if (!policy || Object.entries(saved.receipts).some(([key, ids]) => ids.some(id => !policy.receipts[key]?.includes(id))))
      throw new InputError("设计任务原退回记录缺失，不能重新领取五轮重试");
  }
}

export async function recoverDesignSubmissionPolicy(current: unknown, history: readonly unknown[], directory: string,
  read: (storage: SessionStorage) => Promise<{ entries: { message: SessionMessage }[] }>): Promise<DesignSubmissionPolicy> {
  const checkpoint = objectFields(current), sessions = new Map<string, { key: string; calls: number; storage: SessionStorage }>();
  const entries = (value: unknown) => {
    const cp = objectFields(value);
    return [{ stage: "blueprint", entry: objectFields(cp.blueprint) },
      ...(Array.isArray(cp.modules) ? cp.modules : []).map(entry => ({ stage: "module", entry: objectFields(entry) })),
      { stage: "integration", entry: objectFields(cp.integration) },
      ...(Array.isArray(cp.consultations) ? cp.consultations : []).map(entry => ({ stage: "consultation", entry: objectFields(entry) }))];
  };
  for (const value of [...history, current]) {
    const cp = objectFields(value);
    if (cp.pipelineId !== checkpoint.pipelineId) continue;
    for (const { stage, entry } of entries(cp)) {
      const file = objectFields(entry.sessionRef).file;
      if (typeof file !== "string" || typeof entry.key !== "string" || typeof entry.modelCalls !== "number"
        || typeof entry.sessionStartCalls !== "number") continue;
      const storage = { directory, file, binding: { version: 1, role: "architecture-design-stage", stage, key: entry.key,
        pipelineId: cp.pipelineId, parentBindingHash: cp.bindingHash,
        blueprintHash: ["blueprint", "consultation"].includes(stage) ? null : objectFields(cp.blueprint).resultHash,
        schemaHash: cp.schemaHash, generation: entry.generation } };
      const previous = sessions.get(file), calls = entry.modelCalls - entry.sessionStartCalls;
      if (previous && (previous.key !== entry.key || designHash(previous.storage) !== designHash(storage)))
        throw new InputError("设计原会话归属不一致，不能重算退回次数");
      if (!previous || calls > previous.calls) sessions.set(file, { key: entry.key, calls, storage });
    }
  }
  for (const { entry } of entries(checkpoint)) {
    const covered = [...sessions.values()].filter(row => row.key === entry.key).reduce((sum, row) => sum + row.calls, 0);
    if (covered !== entry.modelCalls) throw new InputError("设计原会话不完整，不能把未知退回次数当作零");
  }
  const policy: DesignSubmissionPolicy = { version: 1, limit: DESIGN_SUBMISSION_REJECTION_LIMIT, receipts: {} };
  for (const [file, row] of sessions) {
    const native = await read(row.storage);
    const ids = policy.receipts[row.key] ??= [];
    for (const id of historicalDesignRejections(native.entries.map(entry => entry.message), file)) if (!ids.includes(id)) ids.push(id);
  }
  return readDesignSubmissionPolicy(policy);
}
