import type { AvatarActivityTarget, AvatarDocument, AvatarElement } from "./avatar-dom.js";
export type { AvatarActivityTarget, AvatarDocument, AvatarElement } from "./avatar-dom.js";
import type { DisplayAgent } from "./ui-types.js";
export { installAvatarMotion } from "./agent-avatar-motion.js";

export const avatarShapes = Object.freeze([
  { id: "cut", label: "圆角方", face: Object.freeze({ x: 124, y: 130, scale: .98 }) },
  { id: "shield", label: "圆盾", face: Object.freeze({ x: 128, y: 118, scale: .94 }) },
  { id: "trapezoid", label: "梯形", face: Object.freeze({ x: 128, y: 135, scale: .98 }) },
  { id: "disc", label: "圆盘", face: Object.freeze({ x: 128, y: 127, scale: .98 }) },
  { id: "diamond", label: "菱形", face: Object.freeze({ x: 128, y: 128, scale: .92 }) },
  { id: "pentagon", label: "五边形", face: Object.freeze({ x: 128, y: 132, scale: .96 }) },
].map((item) => Object.freeze(item)));

export function avatarFaceLayout(shape: string) {
  const face = avatarShapes.find((item) => item.id === shape)?.face;
  if (!face) throw new TypeError("头像造型无效");
  // The visible circle and arc occupy (94, 91)–(184, 177), not the whole 256px image.
  return { left: (face.x - 139 * face.scale) / 256 * 100,
    top: (face.y - 134 * face.scale) / 256 * 100, size: face.scale * 100 };
}

export const avatarColors = Object.freeze([
  { id: "mint", label: "青绿", hex: "#00b894" }, { id: "blue", label: "亮蓝", hex: "#0066ff" },
  { id: "orange", label: "亮橙", hex: "#ff7a00" }, { id: "purple", label: "鲜紫", hex: "#7c3aed" },
  { id: "coral", label: "珊瑚", hex: "#f5224b" }, { id: "yellow", label: "金黄", hex: "#ffbf00" },
  { id: "lime", label: "草绿", hex: "#76c900" }, { id: "rose", label: "玫瑰", hex: "#eb167e" },
].map((item) => Object.freeze(item)));

export function avatarIcon({ shape, color }: { shape?: string | undefined; color?: string | undefined } = {}) {
  const shapeIndex = avatarShapes.findIndex((item) => item.id === shape);
  const colorIndex = avatarColors.findIndex((item) => item.id === color);
  if (shapeIndex < 0 || colorIndex < 0) throw new TypeError("头像造型或配色无效");
  return `star:${shapeIndex}:${colorIndex}`;
}

export function parseAvatarIcon(icon: unknown) {
  if (typeof icon !== "string") return null;
  const match = /^star:([0-5]):([0-7])$/.exec(icon.trim());
  return match ? { shape: avatarShapes[Number(match[1])]!.id, color: avatarColors[Number(match[2])]!.id } : null;
}

function defaultAvatar(id: unknown) {
  let hash = 2166136261;
  for (const character of String(id ?? "neuma")) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619) >>> 0;
  return { shape: avatarShapes[hash % avatarShapes.length]!.id,
    color: avatarColors[Math.floor(hash / avatarShapes.length) % avatarColors.length]!.id };
}

export function resolveAgentAvatar(agent: DisplayAgent | null | undefined): { type: "text"; text: string; icon?: never } | { type: "star"; shape: string; color: string; icon: string; text?: never } {
  const icon = typeof agent?.profile?.icon === "string" ? agent.profile.icon.trim() : "";
  const selected = parseAvatarIcon(icon);
  if (icon && !selected && !icon.startsWith("star:")) return { type: "text", text: icon };
  const avatar = selected || defaultAvatar(agent?.id);
  return { type: "star", ...avatar, icon: avatarIcon(avatar) };
}

export function setAgentAvatarActivity(target: AvatarActivityTarget | null | undefined, activity = "idle") {
  if (!target) return;
  const value = ["thinking", "working", "queued"].includes(activity) ? activity : "idle";
  target.dataset.avatarActivity = value;
  const root = target.children[0] as { dataset: Record<string, string | undefined> } | undefined;
  if (root?.dataset.starAvatar === "true") root.dataset.activity = root.dataset.avatarMotion === "true" ? value : "idle";
}

export function renderAgentAvatar<E extends AvatarElement<E>>(target: E | null | undefined, agent: DisplayAgent | null | undefined, { document: documentRef = (target?.ownerDocument ?? globalThis.document) as AvatarDocument<E>, motion = true, activity = "idle" }: { document?: AvatarDocument<E> | undefined; motion?: boolean | undefined; activity?: string | undefined } = {}) {
  if (!target) return;
  setAgentAvatarActivity(target, agent ? activity : "idle");
  const avatar = agent ? resolveAgentAvatar(agent) : null;
  const key = avatar ? `${avatar.type}:${avatar.icon ?? avatar.text}:${motion}` : "empty";
  if (target.dataset.avatarKey === key && (avatar?.type !== "star" || target.children.length)) return;
  target.replaceChildren(); target.textContent = "";
  target.dataset.avatarKey = key;
  target.dataset.avatarKind = avatar?.type || "empty";
  target.dataset.avatarIcon = avatar?.icon ?? avatar?.text ?? "";
  target.classList.toggle("has-star-avatar", avatar?.type === "star");
  if (!avatar) return;
  if (avatar.type === "text") { target.textContent = avatar.text; return; }
  const make = (tag: string, className: string) => {
    const element = documentRef.createElement(tag); element.className = className; return element;
  };
  const root = make("span", "star-avatar"), world = make("span", "star-avatar-world");
  const movement = make("span", "star-avatar-core-activity");
  const shell = make("span", "star-avatar-shell"), core = make("img", "star-avatar-core");
  root.dataset.starAvatar = "true"; root.dataset.avatarMotion = String(motion);
  root.dataset.activity = motion ? target.dataset.avatarActivity ?? "idle" : "idle";
  root.dataset.shape = avatar.shape; root.dataset.color = avatar.color;
  root.setAttribute("aria-hidden", "true");
  const color = avatarColors.find((item) => item.id === avatar.color);
  shell.setAttribute("style", `--avatar-mask: url("/assets/avatars/${avatar.shape}-mask.png"); --avatar-shell: ${color!.hex};`);
  const layout = avatarFaceLayout(avatar.shape);
  // Rotate around the visible symbol after its shape-specific placement, not the PNG canvas centre.
  movement.setAttribute("style", `transform-origin: ${layout.left + 139 * layout.size / 256}% ${layout.top + 134 * layout.size / 256}%;`);
  core.setAttribute("style", `--avatar-core-left: ${layout.left}%; --avatar-core-top: ${layout.top}%; --avatar-core-size: ${layout.size}%;`);
  core.src = "/assets/avatars/core.png"; core.alt = ""; core.draggable = false;
  movement.append(core); world.append(shell, movement); root.append(world); target.append(root);
}
