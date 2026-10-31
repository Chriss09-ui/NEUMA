import type { initWorkspaceResize } from "../../public/panel-resize.js";
import type { createSidebarHistory } from "../../public/sidebar-history.js";
import type { renderAgentAvatar } from "../../public/agent-avatar.js";
import type { renderGroupAvatar } from "../../public/group-avatar.js";
interface LayoutElements { "app-shell": HTMLElement; "main-history": HTMLElement; "main-history-body": HTMLElement; "main-history-list": HTMLElement; "sidebar-main-link": HTMLAnchorElement; "sidebar-agent-list": HTMLElement; "sidebar-agent-rail": HTMLElement; "sidebar-agents-empty": HTMLElement; "sidebar-agents-title": HTMLElement; "sidebar-details": HTMLElement; "sidebar-group-list": HTMLElement; "sidebar-group-rail": HTMLElement; "sidebar-groups-title": HTMLElement; "sidebar-scroll": HTMLElement }
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function inspectSidebarLayout({ markup, stylesheet, avatarAssets }: { markup: string; stylesheet: string; avatarAssets: Record<string, string> }, createHistory: typeof createSidebarHistory<{ id: string; title: string }>, renderAgent: typeof renderAgentAvatar<HTMLElement>, renderGroup: typeof renderGroupAvatar<HTMLElement>) {
  const style = document.createElement("style");
  style.textContent = stylesheet + "\n#test-result { display: none; }\n.page-main-agent, .page-group { min-height: 0; }\n*, *::before, *::after { animation: none !important; transition: none !important; }";
  document.head.append(style); document.body.insertAdjacentHTML("beforeend", markup);
  const byId = <K extends keyof LayoutElements>(id: K) => document.getElementById(id) as LayoutElements[K];
  const agentList = byId("sidebar-agent-list"), groupList = byId("sidebar-group-list");
  const agentRail = byId("sidebar-agent-rail"), groupRail = byId("sidebar-group-rail");
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = "") => {
    const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
  };
  const avatarDocument = { createElement(tag: string) {
    const element = document.createElement(tag);
    if (tag === "img") Object.defineProperty(element, "src", { set(value) {
      element.setAttribute("src", value === "/assets/avatars/core.png" ? avatarAssets.core : value);
    } });
    return element;
  } };
  const localMasks = (element: HTMLElement) => {
    for (const avatar of element.querySelectorAll<HTMLElement>(".star-avatar"))
      avatar.querySelector<HTMLElement>(".star-avatar-shell")!.style.setProperty("--avatar-mask", `url("${avatarAssets[avatar.dataset.shape!]}")`);
    return element;
  };
  const agents = Array.from({ length: 10 }, (_, index) => ({ id: `layout-agent-${index}`, name: `测试智能体 ${index + 1}`,
    profile: { icon: `star:${index % 6}:1` } }));
  const groups = Array.from({ length: 10 }, (_, index) => ({ id: `layout-group-${index}`, name: `测试群组 ${index + 1}`,
    memberIds: agents.slice(index % 3, index % 3 + 3).map((agent) => agent.id) }));
  const histories: Record<"agents" | "groups", ReturnType<typeof createSidebarHistory<{ id: string; title: string }>>[]> = { agents: [], groups: [] };
  const populate = (items: { id: string; name: string; profile: { icon: string; }; }[]|{ id: string; name: string; memberIds: string[]; }[], list: HTMLElement|null, rail: HTMLElement|null, kind: "agents" | "groups") => {
    for (const item of items) {
      const avatar = (compact: boolean) => {
        const mark = make("span", kind === "agents" ? (compact ? "collapsed-agent-avatar agent-avatar" : "agent-avatar")
          : (compact ? "collapsed-group-avatar" : "sidebar-group-avatar"));
        if (kind === "agents") renderAgent(mark, item, { document: avatarDocument, motion: false });
        else renderGroup(mark, item as (typeof groups)[number], agents, { document: avatarDocument });
        return localMasks(mark);
      };
      const href = `#${kind === "agents" ? "agent" : "group"}/${item.id}`;
      const view = createHistory({ document, id: `${item.id}-history`, title: item.name, href, icon: avatar(false),
        className: kind === "agents" ? "sidebar-agent" : "sidebar-group-link" });
      view.link.dataset.fixtureId = item.id; list!.append(view.root); histories[kind].push(view);
      const compact = make("a", `collapsed-agent-link${kind === "groups" ? " collapsed-group-link" : ""}`);
      compact.href = href; compact.title = item.name; compact.dataset.fixtureId = item.id;
      compact.append(avatar(true)); rail!.append(compact);
    }
  };
  populate(agents, agentList, agentRail, "agents"); populate(groups, groupList, groupRail, "groups");
  byId("sidebar-agents-empty")!.hidden = true;
  const rect = (element: Element) => {
    const bounds = element!.getBoundingClientRect();
    return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, height: bounds.height, width: bounds.width };
  };
  const listFacts = (element: HTMLElement) => {
    const css = getComputedStyle(element);
    return { ...rect(element), clientHeight: element!.clientHeight, scrollHeight: element!.scrollHeight, scrollTop: element!.scrollTop,
      overflowY: css.overflowY, overscrollBehaviorY: css.overscrollBehaviorY, maxHeight: css.maxHeight,
      rows: [...element!.children].map((child) => ({ ...rect(child.querySelector<HTMLElement>(".sidebar-history-heading")! ?? child),
        avatar: rect(child.querySelector<HTMLElement>(".agent-avatar, .sidebar-group-avatar, .collapsed-group-avatar")!) })) };
  };
  const mainLink = document.getElementById("sidebar-main-link")!;
  const entryLayout = () => ({ heading: rect(mainLink.parentElement!), link: rect(mainLink), action: rect(mainLink.nextElementSibling!) });
  const restingEntry = entryLayout();
  const focusFacts = () => {
    const css = getComputedStyle(mainLink), bounds = rect(mainLink);
    const width = Number.parseFloat(css.outlineWidth), spread = width + Number.parseFloat(css.outlineOffset);
    const clips = [];
    for (let parent = mainLink.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), box = rect(parent);
      clips.push({ x: /^(auto|scroll|hidden|clip)$/.test(style.overflowX), y: /^(auto|scroll|hidden|clip)$/.test(style.overflowY),
        left: box.left + parent.clientLeft, top: box.top + parent.clientTop,
        right: box.left + parent.clientLeft + parent.clientWidth, bottom: box.top + parent.clientTop + parent.clientHeight });
    }
    return { visible: mainLink.matches(":focus-visible"), width, style: css.outlineStyle,
      left: bounds.left - spread, right: bounds.right + spread, top: bounds.top - spread, bottom: bounds.bottom + spread, clips };
  };
  const snapshot = (compact = false) => ({
    viewport: { width: innerWidth, height: innerHeight },
    documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    outerScrollTop: byId("sidebar-scroll")!.scrollTop,
    agentHeading: rect(byId("sidebar-agents-title")), groupHeading: rect(byId("sidebar-groups-title")),
    settings: rect(document.querySelector<HTMLElement>(".sidebar-settings")!),
    agents: listFacts(compact ? agentRail : agentList), groups: listFacts(compact ? groupRail : groupList),
    focused: (document.activeElement as HTMLElement | null)?.dataset.fixtureId ?? null,
    mainFocus: focusFacts(),
    mainEntry: { resting: restingEntry, current: entryLayout() },
  });
  const reset = (...lists: (HTMLElement|null)[]) => { for (const list of lists) list!.scrollTop = 0; };
  mainLink.focus();
  const initial = snapshot();
  mainLink.blur();
  agentList!.scrollTop = agentList!.scrollHeight; const agentScrolled = snapshot();
  groupList!.scrollTop = groupList!.scrollHeight; const groupScrolled = snapshot();
  reset(agentList, groupList);
  histories.agents.at(-1)!.link.focus(); const agentFocused = snapshot();
  reset(agentList, groupList);
  histories.groups.at(-1)!.link.focus(); const groupFocused = snapshot();
  for (const [kind, views] of Object.entries(histories)) {
    const view = views[0];
    view!.update({ records: Array.from({ length: 9 }, (_, index) => ({ id: `${kind}-history-${index}`, title: `历史对话 ${index + 1}` })),
      renderRow(record: { title: string|undefined; }) { const row = make("button", "sidebar-history-item", record.title); row.type = "button"; return row; } });
    view!.setExpanded(true); view!.more.click();
  }
  reset(agentList, groupList); const expanded = snapshot();
  agentList!.scrollTop = agentList!.scrollHeight; groupList!.scrollTop = groupList!.scrollHeight;
  const expandedScrolled = snapshot();
  for (const views of Object.values(histories)) views[0]!.setExpanded(false);
  byId("app-shell")!.classList.add("sidebar-collapsed"); byId("sidebar-details")!.inert = true;
  agentRail!.inert = false; groupRail!.inert = false;
  const collapsed = snapshot(true);
  agentRail!.scrollTop = agentRail!.scrollHeight; const collapsedAgentScrolled = snapshot(true);
  groupRail!.scrollTop = groupRail!.scrollHeight; const collapsedGroupScrolled = snapshot(true);
  reset(agentRail, groupRail); (agentRail!.lastElementChild as HTMLElement).focus(); const collapsedAgentFocused = snapshot(true);
  reset(agentRail, groupRail); (groupRail!.lastElementChild as HTMLElement).focus(); const collapsedGroupFocused = snapshot(true);
  (document.activeElement as HTMLElement | null)?.blur(); byId("app-shell")!.classList.remove("sidebar-collapsed");
  byId("sidebar-details")!.inert = false; agentRail!.inert = true; groupRail!.inert = true;
  byId("main-history")!.classList.remove("history-collapsed");
  byId("main-history-body")!.inert = false; byId("main-history-body")!.setAttribute("aria-hidden", "false");
  byId("sidebar-main-link")!.setAttribute("aria-expanded", "true");
  byId("main-history-list")!.replaceChildren(...Array.from({ length: 25 }, (_, index) => {
    const row = make("button", "sidebar-history-item", `主助理历史对话 ${index + 1}`); row.type = "button"; return row;
  }));
  reset(agentList, groupList, byId("sidebar-scroll")); const crowded = snapshot();
  return { initial, agentScrolled, groupScrolled, agentFocused, groupFocused, expanded, expandedScrolled,
    collapsed, collapsedAgentScrolled, collapsedGroupScrolled, collapsedAgentFocused, collapsedGroupFocused, crowded };
}

export async function sidebarLayoutScript() {
  const [html, stylesheet, historySource, avatarSource, groupSource, ...images] = await Promise.all([
    ...["index.html", "style.css", "sidebar-history.js", "agent-avatar.js", "group-avatar.js"].map((file) =>
      readFile(new URL(`../../public/${file}`, import.meta.url), "utf8")),
    ...["core", "cut-mask", "shield-mask", "trapezoid-mask", "disc-mask", "diamond-mask", "pentagon-mask"].map((file) =>
      readFile(new URL(`../../public/assets/avatars/${file}.png`, import.meta.url))),
  ]);
  const markup = String(html!).match(/<body>([\s\S]*)<\/body>/)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  const avatarAssets = Object.fromEntries(["core", "cut", "shield", "trapezoid", "disc", "diamond", "pentagon"]
    .map((name, index) => [name, `data:image/png;base64,${images[index]!.toString("base64")}`]));
  const data = JSON.stringify({ markup, stylesheet, avatarAssets }).replaceAll("<", "\\u003c");
  const source = [historySource, String(avatarSource!).replace(/^export \{[^\n]*\} from [^\n]*\n/gm, ""),
    String(groupSource!).replace(/^import [^\n]*\n/gm, "")].join("\n").replace(/^export /gm, "");
  return `${source}\nreturn (${inspectSidebarLayout.toString()})(${data}, createSidebarHistory, renderAgentAvatar, renderGroupAvatar);`;
}

export function assertSidebarLayout(facts: ReturnType<typeof inspectSidebarLayout>) {
  const focus = facts.initial.mainFocus;
  assert.ok(focus.visible && focus.width > 0 && !["none", "hidden"].includes(focus.style), "NEUMA 入口应保留可见的键盘焦点提示");
  for (const clip of focus.clips) {
    if (clip.x) assert.ok(focus.left >= clip.left - .5 && focus.right <= clip.right + .5, "NEUMA 焦点框左右边不应被父容器裁切");
    if (clip.y) assert.ok(focus.top >= clip.top - .5 && focus.bottom <= clip.bottom + .5, "NEUMA 焦点框上下边不应被父容器裁切");
  }
  const close = (actual: number, expected: number, label: string) => assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} vs ${expected}`);
  const { resting, current } = facts.initial.mainEntry;
  close(current.link.width, resting.link.width, "新对话按钮出现时不应挤压入口标题");
  close((current.action.top + current.action.bottom) / 2, (current.heading.top + current.heading.bottom) / 2, "新对话按钮应与入口行垂直居中");
  assert.ok(current.heading.right - current.action.right >= 3.5, "新对话按钮与入口右边缘应保留间距");
  const fullyVisible = (row: { top: number; bottom: number; }, list: { top: number; bottom: number; }) => row.top >= list.top - 1 && row.bottom <= list.bottom + 1;
  const stable = (before: ReturnType<typeof inspectSidebarLayout>["initial"], after: ReturnType<typeof inspectSidebarLayout>["initial"], label: string, headings = true) => {
    close(after.settings.top, before.settings.top, `${label} 设置入口应固定`);
    close(after.outerScrollTop, before.outerScrollTop, `${label} 外层不应跟随滚动`);
    if (headings) for (const key of ["agentHeading", "groupHeading"] as const)
      close(after[key]!.top, before[key]!.top, `${label} 分区标题应固定`);
  };
  for (const [name, sample] of Object.entries(facts)) {
    assert.ok(sample.documentHeight <= sample.viewport.height + 1, `${name} 页面不应被侧栏撑高`);
    assert.ok(sample.documentWidth <= sample.viewport.width + 1, `${name} 页面不应横向溢出`);
    assert.ok(sample.settings.top >= 0 && sample.settings.bottom <= sample.viewport.height + 1, `${name} 设置入口应在视口内`);
    for (const key of ["agents", "groups"] as const) {
      const list = sample[key];
      assert.equal(list.rows.length, 10, `${name} ${key} 应保留全部入口`);
      assert.equal(list.overflowY, "auto", `${name} ${key} 应单独滚动`);
      assert.equal(list.overscrollBehaviorY, "contain", `${name} ${key} 应阻止滚动传递`);
      const maximum = key === "agents" ? 332 : 188;
      close(Number.parseFloat(list.maxHeight), maximum, `${name} ${key} 列表高度上限`);
      assert.ok(list.clientHeight > 0 && list.clientHeight <= maximum, `${name} ${key} 应有受限的可用高度`);
      assert.ok(list.scrollHeight > list.clientHeight, `${name} ${key} 更多条目应产生滚动内容`);
      const avatarSize = name.startsWith("collapsed") ? 28 : 36;
      for (const row of list.rows) {
        close(row.height, 44, `${name} ${key} 行高`);
        close(row.avatar.width, avatarSize, `${name} ${key} 头像宽度`);
        close(row.avatar.height, avatarSize, `${name} ${key} 头像高度`);
      }
    }
  }
  for (const name of ["initial", "collapsed"] as const) for (const key of ["agents", "groups"] as const) {
    const sample = facts[name], list = sample[key], count = list.rows.filter((row: { top: number; bottom: number; }) => fullyVisible(row, list)).length;
    assert.ok(count > 0, `${name} ${key} 首屏应显示入口`);
    if (sample.viewport.height >= 900 && key === "agents") assert.ok(count >= 5, `${name} 高桌面应显示更多智能体`);
    close(list.rows[1]!.top - list.rows[0]!.bottom, name === "collapsed" ? 4 : 2, `${name} ${key} 条目间距`);
  }
  for (const [start, agentName, groupName, headings] of [["initial", "agentScrolled", "groupScrolled", true],
    ["collapsed", "collapsedAgentScrolled", "collapsedGroupScrolled", false]] as const) {
    const initial = facts[start], agent = facts[agentName], group = facts[groupName];
    assert.ok(agent.agents.scrollTop > 0 && fullyVisible(agent.agents.rows.at(-1)!, agent.agents), `${agentName} 应能滚到最后一个 Agent`);
    close(agent.groups.scrollTop, initial.groups.scrollTop, `${agentName} 不应移动群组列表`);
    assert.ok(group.groups.scrollTop > 0 && fullyVisible(group.groups.rows.at(-1)!, group.groups), `${groupName} 应能滚到最后一个群组`);
    close(group.agents.scrollTop, agent.agents.scrollTop, `${groupName} 不应移动 Agent 列表`);
    stable(initial, agent, agentName, headings); stable(initial, group, groupName, headings);
  }
  for (const [name, key, id] of [["agentFocused", "agents", "layout-agent-9"], ["groupFocused", "groups", "layout-group-9"],
    ["collapsedAgentFocused", "agents", "layout-agent-9"], ["collapsedGroupFocused", "groups", "layout-group-9"]] as const) {
    const sample = facts[name];
    assert.equal(sample.focused, id, `${name} 最后入口应可获得键盘焦点`);
    assert.ok(fullyVisible(sample[key].rows.at(-1)!, sample[key]), `${name} 焦点应自动滚入列表可见范围`);
  }
  for (const key of ["agents", "groups"] as const) {
    assert.ok(facts.expanded[key].scrollHeight > facts.initial[key].scrollHeight, `${key} 展开历史后不能压缩条目`);
    assert.ok(fullyVisible(facts.expandedScrolled[key].rows.at(-1)!, facts.expandedScrolled[key]), `${key} 展开历史后仍应能滚到最后入口`);
  }
  for (const heading of [facts.initial.agentHeading, facts.initial.groupHeading] as const)
    assert.ok(heading.top >= 0 && heading.bottom < facts.initial.settings.top, "短桌面分区标题应保持可见且位于设置入口上方");
  stable(facts.initial, facts.expandedScrolled, "展开历史后滚动");
  stable(facts.initial, facts.crowded, "主助理长历史展开", false);
  assert.ok(facts.crowded.agents.clientHeight >= 44 && facts.crowded.groups.clientHeight >= 44,
    "主助理长历史展开后两列表仍应至少保留一行滚动高度");
  assert.ok(facts.crowded.agentHeading.bottom < facts.crowded.agents.top
    && facts.crowded.agents.bottom < facts.crowded.groupHeading.top
    && facts.crowded.groupHeading.bottom < facts.crowded.groups.top,
  "主助理长历史展开后 Agent 标题、列表与群组标题、列表不应重叠");
}
