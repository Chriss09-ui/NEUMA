import type { AvatarDocument, AvatarElement } from "./avatar-dom.js";
import type { DisplayAgent } from "./ui-types.js";
import { renderAgentAvatar, resolveAgentAvatar } from "./agent-avatar.js";

export function renderGroupAvatar<E extends AvatarElement<E>>(target: E | null | undefined, group: { memberIds?: readonly unknown[] | undefined } | null | undefined, members: readonly DisplayAgent[] = [], { document: documentRef = (target?.ownerDocument ?? globalThis.document) as AvatarDocument<E> }: { document?: AvatarDocument<E> | undefined } = {}) {
  if (!target) return;
  const memberIds = [], seen = new Set();
  for (const id of Array.isArray(group?.memberIds) ? group.memberIds : []) {
    if (typeof id !== "string" || !id.trim() || seen.has(id)) continue;
    seen.add(id); memberIds.push(id);
    if (memberIds.length === 4) break;
  }
  const avatars = memberIds.map((id) => {
    const member = Array.isArray(members) ? members.find((item) => item?.id === id) : null;
    const selected = resolveAgentAvatar(member ?? { id });
    const avatar = selected.type === "star" ? selected : resolveAgentAvatar({ id });
    return { id, profile: { icon: avatar.icon } };
  });
  const key = JSON.stringify(avatars.map((member) => [member.id, member.profile.icon]));
  target.classList.add("group-avatar");
  target.dataset.memberCount = String(avatars.length);
  target.setAttribute("aria-hidden", "true");
  if (target.dataset.groupAvatarKey === key && target.children.length === avatars.length) return;
  target.replaceChildren(); target.textContent = "";
  target.dataset.groupAvatarKey = key;
  for (const member of avatars) {
    const element = documentRef.createElement("span");
    element.className = "group-avatar-member";
    element.dataset.memberId = member.id;
    renderAgentAvatar(element, member, { document: documentRef, motion: false });
    target.append(element);
  }
}
