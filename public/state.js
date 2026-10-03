const STORAGE_KEY = "neuma.requirements.session.optin.v1";
const LEGACY_STORAGE_KEY = "neuma.requirements.session.v1";
const REQUIREMENTS_KEY = "neuma.requirements.saved-list.v1";
const AGENT_PREVIEW_PREFIX = "neuma.agent.preview.v1.";

export function blankSession() {
  return { messages: [], draft: null, status: "idle", confirmed: false, lastQuestion: "", jev: null };
}

export function recentUserMessages(messages) {
  const result = [];
  let remaining = 12000;
  for (const item of messages.slice().reverse()) {
    if (item?.role !== "user" || typeof item.content !== "string" || ["pending", "failed", "stopped"].includes(item.delivery)) continue;
    const content = item.content.trim().slice(0, Math.min(4000, remaining));
    if (content) {
      result.unshift(content);
      remaining -= content.length;
    }
    if (result.length === 12 || remaining === 0) break;
  }
  return result;
}

export function clearLegacySession(storage) {
  if (!storage) return true;
  try {
    storage.removeItem(LEGACY_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function hasSavedSession(storage) {
  try {
    return storage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function readSession(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key) ?? "null");
    if (!value || typeof value !== "object" || !Array.isArray(value.messages)) {
      return blankSession();
    }
    const priorStatus = ["idle", "needs_input", "ready"].includes(value.status) ? value.status : "idle";
    const status = priorStatus === "ready" && (!value.draft?.scenario || !value.draft?.task)
      ? "needs_input" : priorStatus;
    return {
      messages: value.messages.filter((item) => item && ["user", "assistant"].includes(item.role)
        && typeof item.content === "string").slice(-80),
      draft: value.draft && typeof value.draft === "object" ? value.draft : null,
      status,
      confirmed: status === "ready" && value.confirmed === true,
      lastQuestion: typeof value.lastQuestion === "string" ? value.lastQuestion : "",
      jev: value.jev && typeof value.jev === "object" ? value.jev : null,
    };
  } catch {
    return blankSession();
  }
}

export function loadSession(storage) {
  return readSession(storage, STORAGE_KEY);
}

export function takeLegacySession(storage) {
  const session = readSession(storage, LEGACY_STORAGE_KEY);
  return { session, cleared: clearLegacySession(storage) };
}

export function initializeSession(storage) {
  const legacy = takeLegacySession(storage);
  return {
    session: blankSession(),
    legacySession: legacy.session,
    legacyCleared: legacy.cleared,
    hasSavedCopy: hasSavedSession(storage),
  };
}

export function startNewConversation(storage) {
  return { session: blankSession(), hasSavedCopy: hasSavedSession(storage) };
}

export function saveSession(storage, session) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(session));
    return true;
  } catch {
    return false;
  }
}

export function clearSession(storage) {
  if (!storage) return true;
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function loadSavedRequirements(storage) {
  try {
    const items = JSON.parse(storage.getItem(REQUIREMENTS_KEY) ?? "[]");
    if (!Array.isArray(items)) return [];
    return items.filter((item) => item && typeof item.id === "string"
      && typeof item.name === "string" && item.draft && typeof item.draft === "object")
      .map((item) => ({ id: item.id, name: item.name, draft: item.draft,
        updatedAt: item.updatedAt, persisted: true, dirty: false }));
  } catch {
    return [];
  }
}

export function upsertConfirmedRequirement(items, activeId, draft, newId) {
  const previous = items.find((item) => item.id === activeId);
  const id = previous?.id ?? newId;
  const name = typeof draft.name?.value === "string" && draft.name.value.trim()
    ? draft.name.value.trim() : "未命名 Agent";
  const item = { id, name, draft: structuredClone(draft), updatedAt: new Date().toISOString(),
    persisted: previous?.persisted ?? false, dirty: true };
  return { items: [item, ...items.filter((entry) => entry.id !== id)], activeId: id };
}

export function saveRequirement(storage, item) {
  if (!item || typeof item.id !== "string" || typeof item.name !== "string" || !item.draft) {
    return false;
  }
  try {
    const record = { id: item.id, name: item.name, draft: item.draft, updatedAt: item.updatedAt };
    const others = loadSavedRequirements(storage).filter((entry) => entry.id !== item.id)
      .map(({ id, name, draft, updatedAt }) => ({ id, name, draft, updatedAt }));
    storage.setItem(REQUIREMENTS_KEY, JSON.stringify([record, ...others]));
    return true;
  } catch {
    return false;
  }
}

export function deleteRequirement(storage, id) {
  try {
    const remaining = loadSavedRequirements(storage).filter((item) => item.id !== id)
      .map(({ id: itemId, name, draft, updatedAt }) => ({ id: itemId, name, draft, updatedAt }));
    if (remaining.length) storage.setItem(REQUIREMENTS_KEY, JSON.stringify(remaining));
    else storage.removeItem(REQUIREMENTS_KEY);
    return true;
  } catch {
    return false;
  }
}

function previewMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.filter((item) => item?.role === "user" && typeof item.content === "string"
    && item.content.trim() && item.content.length <= 4000)
    .slice(-80).map((item) => ({ role: "user", content: item.content }));
}

export function loadAgentPreview(storage, id) {
  try {
    return previewMessages(JSON.parse(storage.getItem(AGENT_PREVIEW_PREFIX + id) ?? "[]"));
  } catch {
    return [];
  }
}

export function appendAgentPreview(messages, content) {
  if (typeof content !== "string" || !content.trim() || content.length > 4000) {
    throw new Error("预览输入需为 1～4000 字");
  }
  return [...previewMessages(messages), { role: "user", content: content.trim() }].slice(-80);
}

export function saveAgentPreview(storage, id, messages) {
  try {
    storage.setItem(AGENT_PREVIEW_PREFIX + id, JSON.stringify(previewMessages(messages)));
    return true;
  } catch {
    return false;
  }
}

export function deleteAgentPreview(storage, id) {
  try {
    storage.removeItem(AGENT_PREVIEW_PREFIX + id);
    return true;
  } catch {
    return false;
  }
}
