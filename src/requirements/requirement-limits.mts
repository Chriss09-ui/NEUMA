export const TASK_SPEC_LIMITS = Object.freeze({ items: 120, evidence: 12, content: 2000, quote: 4000 });
export const REQUIREMENT_NAME_MAX_CHARACTERS = 120;
export const REQUIREMENT_MESSAGE_MAX_CHARACTERS = 12_000;
export const REQUIREMENT_HISTORY_MAX_MESSAGES = 12;
export const REQUIREMENT_HISTORY_MAX_CHARACTERS = 12_000;
export const REQUIREMENT_DRAFT_MAX_BYTES = 2 * 1024 * 1024;
export const REQUIREMENT_RECORD_MAX_BYTES = 8 * 1024 * 1024;
// The conversation retains several bound copies of the current confirmed draft,
// alongside prior turns. Its aggregate quota is separate from a single requirement.
export const REQUIREMENT_CONVERSATION_MAX_BYTES = 4 * REQUIREMENT_RECORD_MAX_BYTES;
export const REQUIREMENT_REQUEST_MAX_BYTES = REQUIREMENT_RECORD_MAX_BYTES + 64 * 1024;

export const REQUIREMENT_LIMITS = Object.freeze({
  // Every normalized source of formal requirements, including optional legacy fields.
  draftItems: 7 + 20 + 1 + 1 + 20 + 1 + 20 + 40 + TASK_SPEC_LIMITS.items,
  deferredItems: 24,
  formalItems: 7 + 20 + 1 + 1 + 20 + 1 + 20 + 40 + TASK_SPEC_LIMITS.items + 24,
  // Three 1200-character interaction fields and a 500-character purpose can each
  // expand to six ASCII characters per code point in JSON, plus keys and labels.
  formalTextCharacters: 6 * (3 * 1200 + 500) + 512,
  normalizedDraftBytes: REQUIREMENT_DRAFT_MAX_BYTES,
});

export function assertRequirementDraftSize<T>(draft: T): T {
  const text = JSON.stringify(draft);
  const bytes = typeof text === "string" ? Buffer.byteLength(text, "utf8") : 0;
  if (!bytes || bytes > REQUIREMENT_DRAFT_MAX_BYTES) throw Object.assign(new RangeError("整份需求的 JSON UTF-8 总量不能超过 2 MiB；请减少重复依据，原需求未被截断或保存。"), {
    reason: "requirement_draft_too_large", bytes, limitBytes: REQUIREMENT_DRAFT_MAX_BYTES,
  });
  return draft;
}

export const REQUIREMENT_SIZE_GUIDE = "整份需求除各字段限制外，紧凑JSON编码的UTF-8总量最多2MiB；任务要求最多120条，依据与失效记录计入同一总量。超量整体拒绝，不裁剪条目、原文或证据。";
