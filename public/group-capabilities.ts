import type { MemberView } from "./ui-api-types.js";
import { objectFields } from "./ui-types.js";
import { renderAgentAvatar } from "./agent-avatar.js";
import { node } from "./group-view.js";

const availabilityLabels: Record<string, string> = { callable: "可调用", conditional: "需要条件", unavailable: "暂不可用", forbidden: "禁止执行", unknown: "尚不明确" };
const verificationLabels: Record<string, string> = { unverified: "尚未验证", delivery_checked: "交付检查通过", connection_checked: "连接检查通过", last_call_failed: "最近调用失败" };
const capabilityText = (value: unknown): string => Array.isArray(value) ? value.map(capabilityText).filter(Boolean).join("；")
  : value && typeof value === "object" ? Object.values(value).map(capabilityText).filter(Boolean).join("；") : value == null ? "" : String(value);

function disclosure(summary: HTMLElement, details: HTMLDetailsElement, content: HTMLElement) {
  summary.setAttribute("aria-controls", content.id);
  const sync = () => summary.setAttribute("aria-expanded", String(details.open));
  details.addEventListener("toggle", sync); sync();
}
function field(label: string) {
  const row = node("p", "group-capability"), value = node("span");
  row.append(node("strong", "", `${label}　`), value);
  return { row, value };
}
function updateField(item: ReturnType<typeof field>, value: unknown) {
  item.value.textContent = capabilityText(value); item.row.hidden = !item.value.textContent;
}
function verificationText(verification: { status: string; checkedAt?: string | undefined; description?: string | undefined } | undefined) {
  const status = verificationLabels[verification?.status!] || verificationLabels.unverified;
  const date = typeof verification?.checkedAt === "string" ? new Date(verification.checkedAt) : null;
  const checkedAt = date && Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "";
  return [status, checkedAt, capabilityText(verification?.description)].filter(Boolean).join(" · ");
}
function capabilityRow() {
  const row = node("article", "group-capability-item"), heading = node("div", "group-capability-heading");
  const label = node("strong"), availability = node("span", "group-capability-status");
  const description = node("p", "group-capability-description"), reason = field("执行条件"), requirements = field("需要"), verification = field("检查记录");
  heading.append(label, availability); row.append(heading, description, reason.row, requirements.row, verification.row);
  return { row, label, availability, description, reason, requirements, verification };
}

export function createGroupCapabilities(target: HTMLElement) {
  const cards = new Map<string, ReturnType<typeof createCard>>();
  let renderedGroup: string | null = null, serial = 0;
  const empty = node("p", "muted-note", "还没有加入成员，请编辑群组。");

  function createCard() {
    const card = node("details", "group-member-card"), summary = node("summary");
    const avatar = node("span", "collaboration-message-avatar group-member-avatar"), name = node("strong"), status = node("span", "member-ready");
    avatar.setAttribute("aria-hidden", "true"); summary.append(avatar, name, status);
    const body = node("div", "group-member-profile"), description = node("p", "muted-note small");
    body.id = `group-member-profile-${++serial}`;
    const fields = new Map<"task" | "input" | "output" | "boundaries", ReturnType<typeof field>>(([ ["task", "职责"], ["input", "需要输入"], ["output", "交付"], ["boundaries", "职责范围与约束"]] as const)
      .map(([key, label]) => [key, field(label)]));
    const hardBoundaries = field("硬边界");
    const abilities = node("details", "group-member-abilities"), abilitiesSummary = node("summary"), abilitiesLabel = node("span"), abilitiesCount = node("span", "count");
    abilitiesSummary.append(abilitiesLabel, abilitiesCount);
    const abilitiesBody = node("div", "group-member-ability-list"), capabilities = new Map<string, ReturnType<typeof capabilityRow>>();
    abilitiesBody.id = `group-member-abilities-${serial}`;
    const scope = node("p", "muted-note small", "以下能力适用于当前群任务。可调用表示当前允许执行，检查记录说明已检查的范围。");
    const unavailable = node("p", "muted-note small");
    abilitiesBody.append(scope, unavailable); abilities.append(abilitiesSummary, abilitiesBody);
    body.append(description, ...[...fields.values()].map((item) => item.row), hardBoundaries.row, abilities);
    const link = node("a", "text-link small", "打开私聊");
    card.append(summary, body, link); disclosure(summary, card, body); disclosure(abilitiesSummary, abilities, abilitiesBody);
    return { card, summary, avatar, name, status, body, description, fields, hardBoundaries, abilities, abilitiesSummary, abilitiesLabel, abilitiesCount, abilitiesBody, scope, unavailable, capabilities, link };
  }
  function updateCapabilities(view: ReturnType<typeof createCard>, member: MemberView) {
    const provided = Array.isArray(member.capabilities), entries = provided ? member.capabilities!.filter((item) => item && typeof item.id === "string") : [];
    view.abilitiesLabel.textContent = "具体能力与检查记录"; view.abilitiesCount.textContent = String(entries.length); view.abilitiesCount.hidden = !provided;
    view.scope.hidden = !entries.length;
    view.unavailable.textContent = provided ? "尚未列出具体能力，请结合职责与执行条件判断。" : "此成员尚未提供具体能力与检查记录，现有职责资料仍可查看。";
    view.unavailable.hidden = Boolean(entries.length);
    const ids = new Set(entries.map((item) => item.id)), ordered = [];
    for (const [id, item] of view.capabilities) if (!ids.has(id)) { item.row.remove(); view.capabilities.delete(id); }
    for (const entry of entries) {
      let item = view.capabilities.get(entry.id);
      if (!item) { item = capabilityRow(); view.capabilities.set(entry.id, item); }
      item.label.textContent = capabilityText(entry.label) || "能力说明";
      const availability = Object.hasOwn(availabilityLabels, entry.availability) ? entry.availability : "unknown";
      item.availability.textContent = availabilityLabels[availability]!; item.availability.dataset.availability = availability;
      item.description.textContent = capabilityText(entry.description); item.description.hidden = !item.description.textContent;
      updateField(item.reason, entry.reason); updateField(item.requirements, entry.requirements); updateField(item.verification, verificationText(entry.verification));
      ordered.push(item.row);
    }
    const children = [...view.abilitiesBody.children].filter((child) => child !== view.scope && child !== view.unavailable);
    if (children.length !== ordered.length || ordered.some((row, index) => children[index] !== row)) view.abilitiesBody.append(...ordered);
    view.abilitiesSummary.setAttribute("aria-expanded", String(view.abilities.open));
  }
  function reset() {
    cards.clear(); renderedGroup = null; target.replaceChildren();
  }
  function render(members: MemberView[] = [], groupId: string) {
    if (groupId !== renderedGroup) { reset(); renderedGroup = groupId; }
    const ids = new Set(members.map((member) => member.id)), ordered = [];
    for (const [id, view] of cards) if (!ids.has(id)) { view.card.remove(); cards.delete(id); }
    if (!members.length) { if (target.firstChild !== empty) target.replaceChildren(empty); return; }
    empty.remove();
    for (const member of members) {
      let view = cards.get(member.id);
      if (!view) { view = createCard(); cards.set(member.id, view); }
      view.card.dataset.memberId = member.id; renderAgentAvatar(view.avatar, member);
      view.name.textContent = member.name; view.status.textContent = member.ready ? "已交付" : "未就绪";
      view.status.classList.toggle("unavailable", !member.ready);
      view.summary.setAttribute("aria-expanded", String(view.card.open));
      view.description.textContent = member.description || "暂无简介";
      for (const [key, item] of view.fields) updateField(item, member[key]);
      updateField(view.hardBoundaries, Array.isArray(member.hardBoundaries) ? member.hardBoundaries
        .map((item) => [capabilityText(objectFields(item).label), capabilityText(objectFields(item).reason)].filter(Boolean).join("：")) : "");
      updateCapabilities(view, member); view.link.href = `#agent/${encodeURIComponent(member.id)}`; ordered.push(view.card);
    }
    const children = [...target.children];
    if (children.length !== ordered.length || ordered.some((card, index) => children[index] !== card)) {
      target.append(...ordered);
    }
  }
  return { render, reset };
}
