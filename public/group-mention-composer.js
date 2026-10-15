import { renderAgentAvatar, resolveAgentAvatar } from "./agent-avatar.js";

const mentionBoundary = (value) => !value || /[\s,，。.!！?？:：;；、()（）\[\]【】{}<>“”"'@]/u.test(value);
function mentionInCode(value) {
  let fence = null, inline = 0;
  for (const line of value.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker && (!fence || marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim())) {
      fence = fence ? null : marker[1]; inline = 0; continue;
    }
    if (fence) continue;
    for (const match of line.matchAll(/\\.|`+/g)) {
      if (match[0][0] !== "`") continue;
      if (!inline) inline = match[0].length;
      else if (match[0].length === inline) inline = 0;
    }
  }
  return Boolean(fence || inline);
}

export function groupMentionQuery(value, start, end = start) {
  if (!Number.isInteger(start) || start !== end) return null;
  const before = value.slice(0, start), at = before.lastIndexOf("@");
  if (at < 0 || !mentionBoundary(value[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > 80 || /[\n\r@,，。.!！?？:：;；、()（）\[\]【】{}<>“”"'`]/u.test(query)) return null;
  const preceding = value.slice(0, at), line = preceding.slice(preceding.lastIndexOf("\n") + 1);
  if (/^\s*>/.test(line) || /(?:https?:\/\/|\]\()[^\s]*$/.test(line) || mentionInCode(preceding)) return null;
  return { start: at, end: start, query };
}

export function shiftGroupMentions(before, after, mentions, edit) {
  if (before === after) return mentions.map((mention) => ({ ...mention }));
  const delta = after.length - before.length;
  let explicit = null;
  if (edit && Number.isInteger(edit.start) && Number.isInteger(edit.end)) {
    let { start, end } = edit;
    if (start === end && delta < 0) {
      if (edit.inputType === "deleteContentBackward") start += delta;
      else if (edit.inputType === "deleteContentForward") end -= delta;
    }
    const inserted = after.length - before.length + end - start;
    if (start >= 0 && inserted >= 0 && after.slice(0, start) === before.slice(0, start)
      && after.slice(start + inserted) === before.slice(end)) explicit = { start, end };
  }
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < before.length && suffix < after.length
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const edge = Math.min(before.length, after.length);
  const ranges = explicit ? [explicit] : [
    { start: prefix, end: before.length - Math.min(suffix, edge - prefix) },
    { start: Math.min(prefix, edge - suffix), end: before.length - suffix },
  ];
  const shift = (mention, range) => mention.end <= range.start ? { ...mention } : mention.start >= range.end
    ? { ...mention, start: mention.start + delta, end: mention.end + delta } : null;
  return mentions.flatMap((mention) => {
    const next = shift(mention, ranges[0]);
    // Without a browser edit range, repeated text may have several equally valid alignments.
    // Keep an identity only when every alignment preserves the same occurrence.
    if (ranges.some((range) => { const item = shift(mention, range); return !item || item.start !== next?.start || item.end !== next?.end; })) return [];
    return next && after.slice(next.start, next.end) === next.text
      && mentionBoundary(after[next.start - 1]) && mentionBoundary(after[next.end]) ? [next] : [];
  });
}

export function createGroupMentionComposer({ input, popup, selected,
  document: documentRef = globalThis.document, window: windowRef = globalThis.window,
  renderAvatar = renderAgentAvatar }) {
  let members = [], groupId = null, previous = input.value || "", mentions = [];
  let query = null, candidates = [], buttons = [], activeId = null, composing = false, dismissed = "", pendingEdit = null;
  let listStamp = "", chipStamp = "";
  const make = (tag, className = "", text = "") => {
    const item = documentRef.createElement(tag); item.className = className; item.textContent = text; return item;
  };
  const memberFor = (mention) => members.find((member) => member.id === mention.memberId);
  const problem = (mention) => {
    const member = memberFor(mention);
    return !member ? "已移出群组" : `@${member.name}` !== mention.text ? "名称已变更" : !member.ready ? "尚未就绪" : "";
  };
  const identity = (target, member) => {
    target.dataset.agentId = member.id;
    const avatar = resolveAgentAvatar(member);
    if (avatar.type === "star") target.dataset.avatarColor = avatar.color;
    const icon = make("span", "group-compose-mention-avatar"); icon.setAttribute("aria-hidden", "true");
    renderAvatar(icon, member, { document: documentRef, motion: false }); target.append(icon);
  };
  const isOpen = () => popup.classList.contains("is-open");
  const queryKey = (value) => value ? `${value.start}:${value.end}:${value.query}` : "";
  function close({ dismiss = true } = {}) {
    if (dismiss) dismissed = queryKey(query);
    popup.classList.remove("is-open"); popup.inert = true; popup.setAttribute("aria-hidden", "true");
    input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant");
  }
  function renderSelected() {
    for (const chip of selected.children) chip.disabled = input.disabled;
    const stamp = JSON.stringify(mentions.map((mention) => [mention.memberId, mention.text, problem(mention), memberFor(mention)?.profile]));
    if (stamp === chipStamp) return;
    chipStamp = stamp; selected.replaceChildren(); selected.hidden = !mentions.length;
    const shown = new Set();
    for (const mention of mentions) {
      if (shown.has(mention.memberId)) continue;
      shown.add(mention.memberId);
      const member = memberFor(mention) || mention.member, issue = problem(mention);
      const chip = make("button", "group-compose-mention-chip group-agent-identity");
      chip.type = "button"; chip.dataset.memberId = mention.memberId; chip.disabled = input.disabled;
      chip.setAttribute("aria-label", `移除对 ${mention.text.slice(1)} 的提及${issue ? `，${issue}` : ""}`);
      chip.title = issue || mention.text; chip.classList.toggle("is-unavailable", Boolean(issue));
      identity(chip, member);
      chip.append(make("span", "group-compose-mention-name", mention.text), make("span", "group-compose-mention-remove", "×"));
      if (issue) chip.append(make("span", "group-compose-mention-issue", issue));
      chip.addEventListener("click", () => remove(mention.memberId)); selected.append(chip);
    }
  }
  function reconcile(edit) {
    mentions = shiftGroupMentions(previous, input.value, mentions, edit); previous = input.value; renderSelected();
  }
  function setActive(id, scroll = false) {
    activeId = candidates.some((member) => member.id === id && member.ready) ? id : null;
    buttons.forEach((button, index) => {
      const active = candidates[index]?.id === activeId;
      button.classList.toggle("is-active", active); button.setAttribute("aria-selected", String(active));
      if (!active || !isOpen()) return;
      input.setAttribute("aria-activedescendant", button.id);
      if (scroll) {
        if (button.offsetTop < popup.scrollTop) popup.scrollTop = button.offsetTop;
        else if (button.offsetTop + button.offsetHeight > popup.scrollTop + popup.clientHeight)
          popup.scrollTop = button.offsetTop + button.offsetHeight - popup.clientHeight;
      }
    });
    if (!activeId) input.removeAttribute("aria-activedescendant");
  }
  function sync() {
    reconcile();
    if (composing || input.disabled || documentRef.activeElement !== input) { close(); return; }
    query = groupMentionQuery(input.value, input.selectionStart, input.selectionEnd);
    if (!query || mentions.some((mention) => mention.start === query.start) || queryKey(query) === dismissed) { close({ dismiss: false }); return; }
    const search = query.query.toLocaleLowerCase();
    candidates = members.filter((member) => member.name.toLocaleLowerCase().includes(search));
    if (!candidates.length && /\s/.test(query.query)) { close(); return; }
    const stamp = JSON.stringify(candidates.map((member) => [member.id, member.name, member.ready, member.description, member.task, member.profile]));
    if (stamp !== listStamp) {
      listStamp = stamp; const scrollTop = popup.scrollTop; popup.replaceChildren();
      buttons = candidates.map((member, index) => {
        const option = make("button", "group-mention-option group-agent-identity");
        option.id = `${popup.id}-option-${index}`; option.type = "button"; option.tabIndex = -1;
        option.disabled = !member.ready; option.dataset.memberId = member.id;
        option.setAttribute("role", "option"); option.setAttribute("aria-disabled", String(!member.ready)); identity(option, member);
        const text = make("span", "group-mention-option-copy");
        text.append(make("span", "group-mention-option-name", member.name));
        const duplicate = members.filter((item) => item.name === member.name).length > 1;
        const description = !member.ready ? "尚未就绪" : member.description || member.task || "群成员";
        text.append(make("span", "group-mention-option-description", `${description}${duplicate ? ` · ${member.id.slice(-8)}` : ""}`));
        option.append(text); option.addEventListener("click", () => choose(member.id));
        option.addEventListener("mouseover", () => setActive(member.id)); popup.append(option); return option;
      });
      if (!candidates.length) popup.append(make("p", "group-mention-empty", "没有匹配的群成员"));
      popup.scrollTop = scrollTop;
    }
    popup.inert = false; popup.setAttribute("aria-hidden", "false"); popup.classList.add("is-open");
    input.setAttribute("aria-expanded", "true");
    setActive(candidates.some((member) => member.id === activeId && member.ready) ? activeId : candidates.find((member) => member.ready)?.id);
  }
  function notifyInput() {
    const EventClass = documentRef.defaultView?.Event || windowRef?.Event || globalThis.Event;
    input.dispatchEvent(new EventClass("input", { bubbles: true }));
  }
  function choose(id) {
    if (!isOpen() || composing || input.disabled) return;
    const member = members.find((item) => item.id === id && item.ready), current = groupMentionQuery(input.value, input.selectionStart, input.selectionEnd);
    if (!member || !current || queryKey(current) !== queryKey(query)) return;
    const token = `@${member.name}`, value = input.value;
    const existing = members.filter((item) => value.startsWith(`@${item.name}`, current.start)
      && mentionBoundary(value[current.start + item.name.length + 1])).sort((a, b) => b.name.length - a.name.length)[0];
    const end = existing ? Math.max(current.end, current.start + existing.name.length + 1) : current.end;
    const suffix = value.slice(end), space = !/^\s/.test(suffix) ? " " : "";
    const next = value.slice(0, current.start) + token + space + suffix;
    if (input.maxLength > 0 && next.length > input.maxLength) return;
    mentions = shiftGroupMentions(value, next, mentions, { start: current.start, end });
    mentions.push({ memberId: id, start: current.start, end: current.start + token.length, text: token,
      member: { id, name: member.name, profile: member.profile } });
    mentions.sort((left, right) => left.start - right.start);
    input.value = previous = next; close(); renderSelected(); input.focus({ preventScroll: true });
    input.setSelectionRange(current.start + token.length + space.length, current.start + token.length + space.length); notifyInput();
  }
  function remove(id) {
    if (input.disabled) return;
    reconcile(); const old = input.value, caret = input.selectionStart ?? old.length;
    const removed = mentions.filter((mention) => mention.memberId === id).sort((a, b) => b.start - a.start);
    let value = old, nextCaret = caret;
    for (const mention of removed) {
      value = value.slice(0, mention.start) + value.slice(mention.end);
      if (caret > mention.start) nextCaret -= Math.min(caret, mention.end) - mention.start;
      mentions = mentions.filter((item) => item !== mention).map((item) => item.start >= mention.end
        ? { ...item, start: item.start - (mention.end - mention.start), end: item.end - (mention.end - mention.start) } : item);
    }
    input.value = previous = value; close(); renderSelected(); input.focus({ preventScroll: true });
    input.setSelectionRange(nextCaret, nextCaret); notifyInput();
  }
  input.setAttribute("role", "combobox"); input.setAttribute("aria-autocomplete", "list"); input.setAttribute("aria-multiline", "true");
  input.setAttribute("aria-controls", popup.id); input.setAttribute("aria-haspopup", "listbox");
  input.addEventListener("beforeinput", (event) => { pendingEdit = { start: input.selectionStart, end: input.selectionEnd, inputType: event.inputType }; });
  input.addEventListener("input", () => { reconcile(pendingEdit); pendingEdit = null; dismissed = ""; sync(); });
  input.addEventListener("click", () => { dismissed = ""; sync(); });
  input.addEventListener("keyup", (event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { dismissed = ""; sync(); } });
  input.addEventListener("compositionstart", () => { composing = true; close(); });
  input.addEventListener("compositionend", () => { composing = false; dismissed = ""; sync(); });
  input.addEventListener("keydown", (event) => {
    if (composing || event.isComposing || event.keyCode === 229 || !isOpen()) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault(); const ready = candidates.filter((member) => member.ready);
      const index = ready.findIndex((member) => member.id === activeId), delta = event.key === "ArrowDown" ? 1 : -1;
      setActive(ready[(index + delta + ready.length) % ready.length]?.id, true); return;
    }
    if (["Enter", "Tab"].includes(event.key) && !event.shiftKey && activeId) { event.preventDefault(); event.stopPropagation(); choose(activeId); }
    else if (event.key === "Tab") close();
  });
  popup.addEventListener("pointerdown", (event) => event.preventDefault());
  documentRef.addEventListener("pointerdown", (event) => { if (event.target !== input && !popup.contains(event.target)) close(); });
  documentRef.addEventListener("focusin", (event) => { if (event.target !== input && !popup.contains(event.target)) close(); });
  windowRef?.addEventListener("resize", () => close());
  close(); selected.hidden = true;
  return {
    close, sync,
    setMembers(next, id) {
      if (id !== groupId) { groupId = id; close(); members = []; listStamp = ""; }
      members = next.filter((member) => typeof member?.id === "string" && typeof member.name === "string");
      sync();
    },
    snapshot() { reconcile(); return { value: input.value, mentions: mentions.map((mention) => ({ ...mention })) }; },
    restore(saved = {}) {
      close(); pendingEdit = null; input.value = previous = saved.value || "";
      mentions = (saved.mentions || []).filter((mention) => Number.isInteger(mention.start) && Number.isInteger(mention.end)
        && input.value.slice(mention.start, mention.end) === mention.text).map((mention) => ({ ...mention }));
      renderSelected();
    },
    requestMentions() {
      reconcile(); const invalid = mentions.find((mention) => problem(mention));
      if (invalid) throw new Error(`${invalid.text} ${problem(invalid)}，请移除后重新选择成员。`);
      const offset = input.value.length - input.value.trimStart().length;
      return mentions.map(({ memberId, start, end, text }) => ({ memberId, start: start - offset, end: end - offset, text }));
    },
  };
}
