import { createHash } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { objectFields } from "./type-boundary.mjs";

export interface FormatIssue { path: string; reason: string; remedy: string }
interface FormatFailure { turn: number; callHash: string; issues: FormatIssue[] }
interface FormatEpisode {
  id: string; toolName: string; failures: FormatFailure[];
  feedback?: { turn: number; failureHash: string };
  corrections: { turn: number; outcome: "rejected" | "accepted"; feedbackHash: string }[];
  closed?: { turn: number; reason: "corrected" | "submission_accepted" };
}
export interface FormatRecovery {
  version: 1; episodes: FormatEpisode[]; hash: string;
  legacy?: { count: number; fingerprint: string; [key: string]: unknown };
}
export const FORMAT_CORRECTION_LIMIT = 3;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const seal = (state: FormatRecovery) => { const { hash: _hash, ...body } = state; state.hash = hash(body); return state; };
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const rejected = (episode: FormatEpisode) => episode.corrections.filter(row => row.outcome === "rejected").length;
const pending = (state: FormatRecovery) => state.episodes.filter(episode => !episode.closed);

export function readFormatRecovery(value: unknown): FormatRecovery {
  const state = objectFields(value), { hash: expected, ...body } = state;
  const invalid = () => { throw new InputError("格式纠正记录无效，不能重新领取纠正机会。"); };
  if (state.version !== 1 || expected !== hash(body) || !Array.isArray(state.episodes)) invalid();
  const episodes = state.episodes as FormatEpisode[];
  if (state.legacy !== undefined && (!integer(objectFields(state.legacy).count) || !digest(objectFields(state.legacy).fingerprint))) invalid();
  const calls = new Set<string>(), tools = new Set<string>();
  for (const episode of episodes) {
    if (!episode || !digest(episode.id) || !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/u.test(episode.toolName)
      || !Array.isArray(episode.failures) || !episode.failures.length || !Array.isArray(episode.corrections) || episode.corrections.length > 3) invalid();
    for (const row of episode.failures) {
      if (!row || !integer(row.turn) || !digest(row.callHash) || calls.has(row.callHash) || !Array.isArray(row.issues) || !row.issues.length
        || row.issues.length > 12 || row.issues.some(issue => !issue || typeof issue.path !== "string" || issue.path.length > 500
          || typeof issue.reason !== "string" || issue.reason.length > 100 || typeof issue.remedy !== "string" || issue.remedy.length > 1600)) invalid();
      calls.add(row.callHash);
    }
    if (episode.id !== episode.failures[0]!.callHash || episode.failures.some((row, index) => index > 0 && row.turn < episode.failures[index - 1]!.turn)) invalid();
    for (const [index, row] of episode.corrections.entries()) if (!integer(row.turn) || !digest(row.feedbackHash)
      || !["rejected", "accepted"].includes(row.outcome) || row.turn <= episode.failures[0]!.turn
      || index > 0 && row.turn <= episode.corrections[index - 1]!.turn) invalid();
    if (episode.feedback && (!integer(episode.feedback.turn) || !digest(episode.feedback.failureHash))) invalid();
    if (episode.closed && (!integer(episode.closed.turn) || !["corrected", "submission_accepted"].includes(episode.closed.reason))) invalid();
    if (!episode.closed) { if (tools.has(episode.toolName)) invalid(); tools.add(episode.toolName); }
  }
  return value as FormatRecovery;
}

export function createFormatRecovery(legacy?: FormatRecovery["legacy"]): FormatRecovery {
  return seal({ version: 1, episodes: [], ...(legacy ? { legacy: structuredClone(legacy) } : {}), hash: "" });
}

export function formatRecoveryExhausted(state: FormatRecovery | undefined) {
  return state && pending(state).find(episode => rejected(episode) >= FORMAT_CORRECTION_LIMIT);
}

export const formatFailureCount = (state: FormatRecovery) => state.episodes.reduce((sum, episode) => sum + episode.failures.length, 0);

/** Only declared, bounded diagnostic fields are retained; raw tool arguments stay in native history. */
export function noteFormatRejection(state: FormatRecovery, toolName: string, turn: number, callHash: string, issues: FormatIssue[]) {
  if (state.episodes.some(episode => episode.failures.some(row => row.callHash === callHash))) return false;
  let episode = pending(state).find(row => row.toolName === toolName);
  if (!episode) { episode = { id: callHash, toolName, failures: [], corrections: [] }; state.episodes.push(episode); }
  const previous = episode.failures.at(-1), feedback = episode.feedback;
  if (previous && feedback?.turn === turn && previous.turn < turn && !episode.corrections.some(row => row.turn === turn)) {
    if (episode.corrections.length >= FORMAT_CORRECTION_LIMIT) throw new InputError("格式纠正机会已用完，不能追加尝试。");
    episode.corrections.push({ turn, outcome: "rejected", feedbackHash: feedback.failureHash });
  }
  episode.failures.push({ turn, callHash, issues: issues.slice(0, 12).map(issue => ({ path: issue.path.slice(0, 500),
    reason: issue.reason.slice(0, 100), remedy: issue.remedy.slice(0, 1600) })) });
  seal(state); return true;
}

export function resolveFormatRecovery(state: FormatRecovery, toolName: string, turn: number, submission = false) {
  let changed = false;
  for (const episode of pending(state)) if (submission || episode.toolName === toolName) {
    if (episode.toolName === toolName && episode.feedback?.turn === turn && episode.failures.at(-1)!.turn < turn
      && !episode.corrections.some(row => row.turn === turn) && episode.corrections.length < FORMAT_CORRECTION_LIMIT)
      episode.corrections.push({ turn, outcome: "accepted", feedbackHash: episode.feedback.failureHash });
    episode.closed = { turn, reason: episode.toolName === toolName ? "corrected" : "submission_accepted" }; changed = true;
  }
  if (changed) seal(state);
  return changed;
}

export function formatCorrectionFeedback(state: FormatRecovery) {
  const outstanding = pending(state).map(episode => ({ toolName: episode.toolName, correctionsUsed: rejected(episode),
    correctionsRemaining: Math.max(0, FORMAT_CORRECTION_LIMIT - rejected(episode)),
    issues: episode.failures.filter(row => row.turn === episode.failures.at(-1)!.turn).flatMap(row => row.issues).slice(0, 12) }));
  if (!outstanding.length) return undefined;
  return { feedbackId: hash(outstanding), correctionLimit: FORMAT_CORRECTION_LIMIT, outstanding,
    instruction: "下面是程序明确指出的输出或工具参数错误。先按具体字段和修复说明纠正，再重试对应工具或正式提交。首次报错不扣纠正机会；收到反馈后的实际重试才计一轮，同一回复多处错误只计一轮。正常读取和连接重试不扣机会，已修好的问题关闭，新的独立问题另行反馈。" };
}

/** Admission records feedback present in the outgoing context; only a later actual retry spends an opportunity. */
export function deliverFormatFeedback(state: FormatRecovery, turn: number, feedbackId: string | undefined) {
  if (!feedbackId || formatCorrectionFeedback(state)?.feedbackId !== feedbackId) return false;
  for (const episode of pending(state)) episode.feedback = { turn, failureHash: hash(episode.failures) };
  seal(state); return true;
}
