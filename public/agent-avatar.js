export { installAvatarMotion } from "./agent-avatar-motion.js";

export const avatarShapes = Object.freeze([
  { id: "cut", label: "圆角方", face: Object.freeze({ x: 124, y: 130, scale: .98 }) },
  { id: "shield", label: "圆盾", face: Object.freeze({ x: 128, y: 118, scale: .94 }) },
  { id: "trapezoid", label: "梯形", face: Object.freeze({ x: 128, y: 135, scale: .98 }) },
  { id: "disc", label: "圆盘", face: Object.freeze({ x: 128, y: 127, scale: .98 }) },
  { id: "diamond", label: "菱形", face: Object.freeze({ x: 128, y: 128, scale: .92 }) },
  { id: "pentagon", label: "五边形", face: Object.freeze({ x: 128, y: 132, scale: .96 }) },
].map(Object.freeze));

export function avatarFaceLayout(shape) {
  const face = avatarShapes.find((item) => item.id === shape)?.face;
  if (!face) throw new TypeError("头像造型无效");
  // The visible circle and arc occupy (94, 91)–(184, 177), not the whole 256px image.
  return { left: (face.x - 139 * face.scale) / 256 * 100,
    top: (face.y - 134 * face.scale) / 256 * 100, size: face.scale * 100 };
}

export const avatarColors = Object.freeze([
  { id: "mint", label: "青绿", hex: "#24b89a" }, { id: "blue", label: "天蓝", hex: "#4299ef" },
  { id: "orange", label: "杏橙", hex: "#f7a552" }, { id: "purple", label: "浅紫", hex: "#a789eb" },
  { id: "coral", label: "珊瑚", hex: "#ec6f78" }, { id: "yellow", label: "金黄", hex: "#efbe45" },
  { id: "lime", label: "草绿", hex: "#a6c65e" }, { id: "rose", label: "玫瑰", hex: "#df7caa" },
].map(Object.freeze));

export function avatarIcon({ shape, color } = {}) {
  const shapeIndex = avatarShapes.findIndex((item) => item.id === shape);
  const colorIndex = avatarColors.findIndex((item) => item.id === color);
  if (shapeIndex < 0 || colorIndex < 0) throw new TypeError("头像造型或配色无效");
  return `star:${shapeIndex}:${colorIndex}`;
}

export function parseAvatarIcon(icon) {
  if (typeof icon !== "string") return null;
  const match = /^star:([0-5]):([0-7])$/.exec(icon.trim());
  return match ? { shape: avatarShapes[Number(match[1])].id, color: avatarColors[Number(match[2])].id } : null;
}

function defaultAvatar(id) {
  let hash = 2166136261;
  for (const character of String(id ?? "neuma")) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
  return { shape: avatarShapes[hash % avatarShapes.length].id,
    color: avatarColors[Math.floor(hash / avatarShapes.length) % avatarColors.length].id };
}

export function resolveAgentAvatar(agent) {
  const icon = typeof agent?.profile?.icon === "string" ? agent.profile.icon.trim() : "";
  const selected = parseAvatarIcon(icon);
  if (icon && !selected && !icon.startsWith("star:")) return { type: "text", text: icon };
  const avatar = selected || defaultAvatar(agent?.id);
  return { type: "star", ...avatar, icon: avatarIcon(avatar) };
}

export function renderAgentAvatar(target, agent, { document: documentRef = target?.ownerDocument ?? globalThis.document, motion = true } = {}) {
  if (!target) return;
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
  const make = (tag, className) => {
    const element = documentRef.createElement(tag); element.className = className; return element;
  };
  const root = make("span", "star-avatar"), world = make("span", "star-avatar-world");
  const shell = make("span", "star-avatar-shell"), core = make("img", "star-avatar-core");
  root.dataset.starAvatar = "true"; root.dataset.avatarMotion = String(motion);
  root.dataset.shape = avatar.shape; root.dataset.color = avatar.color;
  root.setAttribute("aria-hidden", "true");
  const color = avatarColors.find((item) => item.id === avatar.color);
  shell.setAttribute("style", `--avatar-mask: url("/assets/avatars/${avatar.shape}-mask.png"); --avatar-shell: ${color.hex};`);
  const layout = avatarFaceLayout(avatar.shape);
  core.setAttribute("style", `--avatar-core-left: ${layout.left}%; --avatar-core-top: ${layout.top}%; --avatar-core-size: ${layout.size}%;`);
  core.src = "/assets/avatars/core.png"; core.alt = ""; core.draggable = false;
  world.append(shell, core); root.append(world); target.append(root);
}
