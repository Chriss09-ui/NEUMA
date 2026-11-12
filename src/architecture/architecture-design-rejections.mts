import type { SessionMessage, SessionStorage } from "../runtime/execution-port.mjs";
import { InputError } from "../requirements/core.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
import { designHash } from "./architecture-contract.mjs";
import { isModelSubmissionFormatIssue, MODEL_FORMAT_REJECTION_LIMIT } from "../runtime/model-submission-arguments.mjs";

export const DESIGN_SUBMISSION_REJECTION_LIMIT = 5;
export type DesignRejectionKind = "format" | "content";
interface SubmissionEvent { id: string; kind: DesignRejectionKind | "accepted" }
export interface DesignSubmissionCounts { content: number; format: number }
interface LegacyPolicy { version: 1; limit: 5; receipts: Record<string, string[]> }
interface SeparatePolicy { version: 2; limit: 5; formatLimit: 3; events: Record<string, SubmissionEvent[]> }
export type DesignSubmissionPolicy = LegacyPolicy | SeparatePolicy;
export const emptyDesignSubmissionPolicy = (): SeparatePolicy => ({ version: 2, limit: 5, formatLimit: 3, events: {} });
const hashId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const taskKey = (value: string) => /^[A-Za-z][A-Za-z0-9_-]{0,99}$/u.test(value);
function invalid(): never { throw new InputError("设计任务退回记录无法核验，不能清空或重新领取次数"); }

export function readDesignSubmissionPolicy(value: unknown): DesignSubmissionPolicy {
  const policy = objectFields(value);
  if (policy.limit !== DESIGN_SUBMISSION_REJECTION_LIMIT) invalid();
  const collection = policy.version === 1 ? policy.receipts : policy.events;
  if (!collection || typeof collection !== "object" || Array.isArray(collection) || Object.keys(collection).length > 12) invalid();
  if (policy.version === 1) {
    if (Object.keys(policy).sort().join() !== "limit,receipts,version"
      || Object.entries(objectFields(collection)).some(([key, ids]) => !taskKey(key) || !Array.isArray(ids)
        || ids.length > 64 || ids.some(id => !hashId(id)) || new Set(ids).size !== ids.length)) invalid();
  } else if (policy.version === 2) {
    if (policy.formatLimit !== MODEL_FORMAT_REJECTION_LIMIT || Object.keys(policy).sort().join() !== "events,formatLimit,limit,version"
      || Object.entries(objectFields(collection)).some(([key, events]) => !taskKey(key) || !Array.isArray(events) || events.length > 256
        || events.some(input => { const event = objectFields(input); return Object.keys(event).sort().join() !== "id,kind"
          || !hashId(event.id) || !["format", "content", "accepted"].includes(String(event.kind)); })
        || new Set(events.map(event => objectFields(event).id)).size !== events.length)) invalid();
  } else invalid();
  return structuredClone(value) as DesignSubmissionPolicy;
}

export function designSubmissionRejections(policy: DesignSubmissionPolicy | undefined, key: string) {
  return policy?.version === 1 ? policy.receipts[key]?.length ?? 0 : policy?.events[key]?.filter(event => event.kind === "content").length ?? 0;
}

export function designFormatRejections(policy: DesignSubmissionPolicy | undefined, key: string) {
  if (policy?.version !== 2) return 0;
  const events = policy.events[key] ?? [];
  let count = 0;
  for (let index = events.length - 1; index >= 0 && events[index]!.kind === "format"; index--) count++;
  return count;
}

export const designSubmissionCounts = (policy: DesignSubmissionPolicy | undefined, key: string): DesignSubmissionCounts =>
  ({ content: designSubmissionRejections(policy, key), format: designFormatRejections(policy, key) });

export function designRejectionKind(issues: readonly { reason: string }[]): DesignRejectionKind {
  return issues.length && issues.every(isModelSubmissionFormatIssue) ? "format" : "content";
}

function append(policy: SeparatePolicy, key: string, event: SubmissionEvent) {
  const events = policy.events[key] ??= [], prior = events.find(row => row.id === event.id);
  if (prior && prior.kind !== event.kind) invalid();
  if (!prior) events.push(event);
}

export function recordDesignSubmissionRejection(policy: DesignSubmissionPolicy, key: string, receipt: unknown, kind: DesignRejectionKind = "content") {
  if (policy.version !== 2) invalid();
  append(policy, key, { id: designHash(receipt), kind });
  return designSubmissionCounts(policy, key);
}

export function recordDesignSubmissionAccepted(policy: DesignSubmissionPolicy, key: string, receipt: unknown) {
  if (policy.version !== 2) invalid();
  append(policy, key, { id: designHash({ kind: "accepted", receipt }), kind: "accepted" });
}

export function assertDesignSubmissionHistory(current: unknown, prior: readonly unknown[]) {
  const policy = current === undefined ? undefined : readDesignSubmissionPolicy(current);
  for (const value of prior) {
    if (value === undefined) continue;
    const saved = readDesignSubmissionPolicy(value);
    const missing = saved.version === 1 ? Object.entries(saved.receipts).some(([key, ids]) => ids.some(id => policy?.version === 1
      ? !policy.receipts[key]?.includes(id) : !policy?.events[key]?.some(event => event.kind !== "accepted" && event.id === id)))
      : policy?.version !== 2 || Object.entries(saved.events).some(([key, events]) => events.some((event, index) =>
        designHash(event) !== designHash(policy.events[key]?.[index] ?? null)));
    if (!policy || missing)
      throw new InputError("设计任务原退回记录缺失，不能重新领取五轮重试");
  }
}

export async function recoverDesignSubmissionPolicy(current: unknown, history: readonly unknown[], directory: string,
  read: (storage: SessionStorage) => Promise<{ entries: { message: SessionMessage }[] }>): Promise<DesignSubmissionPolicy> {
  const checkpoint = objectFields(current), sessions = new Map<string, { key: string; calls: number; start: number; storage: SessionStorage }>();
  const checkpoints = [...history, current].map(objectFields).filter(cp => cp.pipelineId === checkpoint.pipelineId);
  const known = new Map<string, Map<string, number>>();
  const entries = (value: unknown) => {
    const cp = objectFields(value);
    return [{ stage: "blueprint", entry: objectFields(cp.blueprint) },
      ...(Array.isArray(cp.modules) ? cp.modules : []).map(entry => ({ stage: "module", entry: objectFields(entry) })),
      { stage: "integration", entry: objectFields(cp.integration) },
      ...(Array.isArray(cp.consultations) ? cp.consultations : []).map(entry => ({ stage: "consultation", entry: objectFields(entry) }))];
  };
  for (const cp of checkpoints) {
    if (cp.submissionPolicy) {
      const policy = readDesignSubmissionPolicy(cp.submissionPolicy);
      if (policy.version !== 1) invalid();
      for (const [key, ids] of Object.entries(policy.receipts)) for (const id of ids) {
        const found = known.get(key) ?? new Map<string, number>(); known.set(key, found);
        const entry = entries(cp).find(row => row.entry.key === key)?.entry;
        const calls = typeof cp.revisionHash === "string" && id === designHash({ kind: "review_return", revisionHash: cp.revisionHash })
          ? entry?.sessionStartCalls : entry?.modelCalls;
        if (typeof calls !== "number") invalid();
        found.set(id, Math.min(found.get(id) ?? Infinity, calls));
      }
    }
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
      if (!previous || calls > previous.calls) sessions.set(file, { key: entry.key, calls, start: entry.sessionStartCalls, storage });
    }
  }
  for (const { entry } of entries(checkpoint)) {
    const covered = [...sessions.values()].filter(row => row.key === entry.key).reduce((sum, row) => sum + row.calls, 0);
    if (covered !== entry.modelCalls) throw new InputError("设计原会话不完整，不能把未知退回次数当作零");
  }
  const policy = emptyDesignSubmissionPolicy(), matched = new Set<string>();
  const reviewReturns = new Set(checkpoints.filter(cp => typeof cp.revisionHash === "string")
    .map(cp => designHash({ kind: "review_return", revisionHash: cp.revisionHash })));
  const markers = [...known].flatMap(([key, ids]) => [...ids].filter(([id]) => reviewReturns.has(id))
    .map(([id, calls]) => ({ key, id, calls }))).sort((a, b) => a.calls - b.calls);
  const addMarkers = (key: string, calls: number) => {
    for (const marker of markers) if (marker.key === key && marker.calls <= calls && !matched.has(`${key}:${marker.id}`)) {
      append(policy, key, { id: marker.id, kind: "content" }); matched.add(`${key}:${marker.id}`);
    }
  };
  for (const [file, row] of [...sessions].sort(([, a], [, b]) => a.start - b.start)) {
    addMarkers(row.key, row.start);
    const native = await read(row.storage), messages = native.entries.map(entry => entry.message), ids = known.get(row.key);
    const matchId = (callId: string) => {
      const candidates = [designHash({ file, toolCallId: callId })];
      if (ids) for (let calls = row.start + 1; calls <= row.start + row.calls; calls++)
        candidates.push(designHash({ file, toolCallId: callId, modelCalls: calls }));
      const matches = candidates.filter(id => ids?.has(id));
      if (matches.length > 1) invalid();
      return matches[0] ?? (checkpoint.submissionPolicy ? null : candidates[0]!);
    };
    for (const message of messages) {
      if (message.role === "toolResult" && typeof message.toolName === "string" && submissions.has(message.toolName)
        && typeof message.toolCallId === "string") {
        const id = matchId(message.toolCallId);
        if (message.isError) {
          if (id) { append(policy, row.key, { id, kind: historicalKind(messageText(message)) }); matched.add(`${row.key}:${id}`); }
        } else append(policy, row.key, { id: designHash({ kind: "accepted", file, toolCallId: message.toolCallId }), kind: "accepted" });
      }
      if (message.role === "user" && ids) {
        let feedback: Record<string, unknown>;
        try { feedback = objectFields(JSON.parse(messageText(message))); } catch { continue; }
        const used = objectFields(feedback.modelBudget).used;
        if (typeof feedback.structuredSubmissionFeedback !== "string" || !Number.isSafeInteger(used)) continue;
        // The old controller persisted this synthetic ID in its ledger, but native JSON replies have no tool-result entry.
        for (let index = 1; index <= 64; index++) {
          const id = matchId(`structured_submission_${used}_${index}`);
          if (id && ids.has(id)) {
            append(policy, row.key, { id, kind: historicalKind(feedback.structuredSubmissionFeedback) }); matched.add(`${row.key}:${id}`);
          }
        }
      }
    }
  }
  for (const { entry } of entries(checkpoint)) if (typeof entry.key === "string") addMarkers(entry.key, Infinity);
  for (const [key, ids] of known) for (const id of ids.keys()) if (!matched.has(`${key}:${id}`)) {
    // A stopped final JSON response may have no following user packet. Its saved host diagnostic remains required.
    throw new InputError("设计原退回回执缺少可核验的原会话诊断，不能猜测分类或补零");
  }
  return readDesignSubmissionPolicy(policy);
}

const submissions = new Set(["submit_architecture_blueprint", "submit_architecture_module", "submit_architecture_integration",
  "submit_blueprint_analysis", "submit_architecture_draft", "revise_architecture_submission"]);
function messageText(message: SessionMessage) {
  return typeof message.content === "string" ? message.content : message.content?.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
}

/** Read complete host diagnostic objects; never search error prose or values for a reason substring. */
function historicalKind(text: string): DesignRejectionKind {
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const c = text[index];
    if (start < 0) { if (c === "{") { start = index; depth = 1; } continue; }
    if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        const value = objectFields(JSON.parse(text.slice(start, index + 1)));
        if (Array.isArray(value.issues) && value.issues.length && value.issues.every(issue => typeof objectFields(issue).path === "string" && typeof objectFields(issue).reason === "string"))
          return designRejectionKind(value.issues.map(issue => ({ reason: String(objectFields(issue).reason) })));
      } catch { /* Non-JSON prose is not a format diagnosis. */ }
      start = -1;
    }
  }
  return "content";
}
