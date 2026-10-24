import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function inspectSidebarLayout({ markup, stylesheet, avatarAssets }, createHistory, renderAgent, renderGroup) {
  const style = document.createElement("style");
  style.textContent = stylesheet + "\n.page-main-agent, .page-group { min-height: 0; }\n#test-result { display: none; }\n*, *::before, *::after { animation: none !important; transition: none !important; }";
  document.head.append(style); document.body.insertAdjacentHTML("beforeend", markup);
  const byId = (id) => document.getElementById(id);
  const agentList = byId("sidebar-agent-list"), groupList = byId("sidebar-group-list");
  const agentRail = byId("sidebar-agent-rail"), groupRail = byId("sidebar-group-rail");
  const make = (tag, className, text = "") => {
    const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
  };
  const avatarDocument = { createElement(tag) {
    const element = document.createElement(tag);
    if (tag === "img") Object.defineProperty(element, "src", { set(value) {
      element.setAttribute("src", value === "/assets/avatars/core.png" ? avatarAssets.core : value);
    } });
    return element;
  } };
  const localMasks = (element) => {
    for (const avatar of element.querySelectorAll(".star-avatar"))
      avatar.querySelector(".star-avatar-shell").style.setProperty("--avatar-mask", `url("${avatarAssets[avatar.dataset.shape]}")`);
    return element;
  };
  const agents = Array.from({ length: 6 }, (_, index) => ({ id: `layout-agent-${index}`, name: `测试智能体 ${index + 1}`,
    profile: { icon: `star:${index}:1` } }));
  const groups = Array.from({ length: 6 }, (_, index) => ({ id: `layout-group-${index}`, name: `测试群组 ${index + 1}`,
    memberIds: agents.slice(index % 3, index % 3 + 3).map((agent) => agent.id) }));
  const histories = { agents: [], groups: [] };
  const populate = (items, list, rail, kind) => {
    for (const item of items) {
      const avatar = (compact) => {
        const mark = make("span", kind === "agents" ? (compact ? "collapsed-agent-avatar agent-avatar" : "agent-avatar")
          : (compact ? "collapsed-group-avatar" : "sidebar-group-avatar"));
        if (kind === "agents") renderAgent(mark, item, { document: avatarDocument, motion: false });
        else renderGroup(mark, item, agents, { document: avatarDocument });
        return localMasks(mark);
      };
      const href = `#${kind === "agents" ? "agent" : "group"}/${item.id}`;
      const view = createHistory({ document, id: `${item.id}-history`, title: item.name, href, icon: avatar(false),
        className: kind === "agents" ? "sidebar-agent" : "sidebar-group-link" });
      view.link.dataset.fixtureId = item.id; list.append(view.root); histories[kind].push(view);
      const compact = make("a", `collapsed-agent-link${kind === "groups" ? " collapsed-group-link" : ""}`);
      compact.href = href; compact.title = item.name; compact.dataset.fixtureId = item.id;
      compact.append(avatar(true)); rail.append(compact);
    }
  };
  populate(agents, agentList, agentRail, "agents"); populate(groups, groupList, groupRail, "groups");
  byId("sidebar-agents-empty").hidden = true;
  const rect = (element) => {
    const bounds = element.getBoundingClientRect();
    return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, height: bounds.height, width: bounds.width };
  };
  const listFacts = (element) => {
    const css = getComputedStyle(element);
    return { ...rect(element), clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop,
      overflowY: css.overflowY, overscrollBehaviorY: css.overscrollBehaviorY, maxHeight: css.maxHeight,
      rows: [...element.children].map((child) => ({ ...rect(child.querySelector(".sidebar-history-heading") ?? child),
        avatar: rect(child.querySelector(".agent-avatar, .sidebar-group-avatar, .collapsed-group-avatar")) })) };
  };
  const snapshot = (compact = false) => ({
    viewport: { width: innerWidth, height: innerHeight },
    documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    outerScrollTop: byId("sidebar-scroll").scrollTop,
    agentHeading: rect(byId("sidebar-agents-title")), groupHeading: rect(byId("sidebar-groups-title")),
    settings: rect(document.querySelector(".sidebar-settings")),
    agents: listFacts(compact ? agentRail : agentList), groups: listFacts(compact ? groupRail : groupList),
    focused: document.activeElement?.dataset.fixtureId ?? null,
  });
  const reset = (...lists) => { for (const list of lists) list.scrollTop = 0; };
  const initial = snapshot();
  agentList.scrollTop = agentList.scrollHeight; const agentScrolled = snapshot();
  groupList.scrollTop = groupList.scrollHeight; const groupScrolled = snapshot();
  reset(agentList, groupList);
  histories.agents.at(-1).link.focus(); const agentFocused = snapshot();
  reset(agentList, groupList);
  histories.groups.at(-1).link.focus(); const groupFocused = snapshot();
  for (const [kind, views] of Object.entries(histories)) {
    const view = views[0];
    view.update({ records: Array.from({ length: 9 }, (_, index) => ({ id: `${kind}-history-${index}`, title: `历史对话 ${index + 1}` })),
      renderRow(record) { const row = make("button", "sidebar-history-item", record.title); row.type = "button"; return row; } });
    view.setExpanded(true); view.more.click();
  }
  reset(agentList, groupList); const expanded = snapshot();
  agentList.scrollTop = agentList.scrollHeight; groupList.scrollTop = groupList.scrollHeight;
  const expandedScrolled = snapshot();
  for (const views of Object.values(histories)) views[0].setExpanded(false);
  byId("app-shell").classList.add("sidebar-collapsed"); byId("sidebar-details").inert = true;
  agentRail.inert = false; groupRail.inert = false;
  const collapsed = snapshot(true);
  agentRail.scrollTop = agentRail.scrollHeight; const collapsedAgentScrolled = snapshot(true);
  groupRail.scrollTop = groupRail.scrollHeight; const collapsedGroupScrolled = snapshot(true);
  reset(agentRail, groupRail); agentRail.lastElementChild.focus(); const collapsedAgentFocused = snapshot(true);
  reset(agentRail, groupRail); groupRail.lastElementChild.focus(); const collapsedGroupFocused = snapshot(true);
  document.activeElement?.blur(); byId("app-shell").classList.remove("sidebar-collapsed");
  byId("sidebar-details").inert = false; agentRail.inert = true; groupRail.inert = true;
  byId("main-history").classList.remove("history-collapsed");
  byId("main-history-body").inert = false; byId("main-history-body").setAttribute("aria-hidden", "false");
  byId("main-history-toggle").setAttribute("aria-expanded", "true");
  byId("main-history-list").replaceChildren(...Array.from({ length: 25 }, (_, index) => {
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
  const markup = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  const avatarAssets = Object.fromEntries(["core", "cut", "shield", "trapezoid", "disc", "diamond", "pentagon"]
    .map((name, index) => [name, `data:image/png;base64,${images[index].toString("base64")}`]));
  const data = JSON.stringify({ markup, stylesheet, avatarAssets }).replaceAll("<", "\\u003c");
  const source = [historySource, avatarSource.replace(/^export \{[^\n]*\} from [^\n]*\n/gm, ""),
    groupSource.replace(/^import [^\n]*\n/gm, "")].join("\n").replace(/^export /gm, "");
  return `${source}\nreturn (${inspectSidebarLayout.toString()})(${data}, createSidebarHistory, renderAgentAvatar, renderGroupAvatar);`;
}

export function assertSidebarLayout(facts) {
  const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} vs ${expected}`);
  const fullyVisible = (row, list) => row.top >= list.top - 1 && row.bottom <= list.bottom + 1;
  const stable = (before, after, label, headings = true) => {
    close(after.settings.top, before.settings.top, `${label} 设置入口应固定`);
    close(after.outerScrollTop, before.outerScrollTop, `${label} 外层不应跟随滚动`);
    if (headings) for (const key of ["agentHeading", "groupHeading"])
      close(after[key].top, before[key].top, `${label} 分区标题应固定`);
  };
  for (const [name, sample] of Object.entries(facts)) {
    assert.ok(sample.documentHeight <= sample.viewport.height + 1, `${name} 页面不应被侧栏撑高`);
    assert.ok(sample.documentWidth <= sample.viewport.width + 1, `${name} 页面不应横向溢出`);
    assert.ok(sample.settings.top >= 0 && sample.settings.bottom <= sample.viewport.height + 1, `${name} 设置入口应在视口内`);
    for (const key of ["agents", "groups"]) {
      const list = sample[key];
      assert.equal(list.rows.length, 6, `${name} ${key} 应保留全部六个入口`);
      assert.equal(list.overflowY, "auto", `${name} ${key} 应单独滚动`);
      assert.equal(list.overscrollBehaviorY, "contain", `${name} ${key} 应阻止滚动传递`);
      close(Number.parseFloat(list.maxHeight), 188, `${name} ${key} 最多容纳四项`);
      assert.ok(list.clientHeight > 0 && list.clientHeight <= 188, `${name} ${key} 应有受限的可用高度`);
      assert.ok(list.scrollHeight > list.clientHeight, `${name} ${key} 更多条目应产生滚动内容`);
      const avatarSize = name.startsWith("collapsed") ? 28 : 36;
      for (const row of list.rows) {
        close(row.height, 44, `${name} ${key} 行高`);
        close(row.avatar.width, avatarSize, `${name} ${key} 头像宽度`);
        close(row.avatar.height, avatarSize, `${name} ${key} 头像高度`);
      }
    }
  }
  for (const name of ["initial", "collapsed"]) for (const key of ["agents", "groups"]) {
    const sample = facts[name], list = sample[key], count = list.rows.filter((row) => fullyVisible(row, list)).length;
    assert.ok(count > 0 && count <= 4, `${name} ${key} 首屏最多显示四项`);
    if (sample.viewport.height >= 900) assert.equal(count, 4, `${name} ${key} 高桌面应完整显示四项`);
    assert.ok(list.rows[4].top >= list.bottom - 1, `${name} ${key} 第五项应被裁切`);
    close(list.rows[1].top - list.rows[0].bottom, 4, `${name} ${key} 条目间距`);
  }
  for (const [start, agentName, groupName, headings] of [["initial", "agentScrolled", "groupScrolled", true],
    ["collapsed", "collapsedAgentScrolled", "collapsedGroupScrolled", false]]) {
    const initial = facts[start], agent = facts[agentName], group = facts[groupName];
    assert.ok(agent.agents.scrollTop > 0 && fullyVisible(agent.agents.rows.at(-1), agent.agents), `${agentName} 应能滚到最后一个 Agent`);
    close(agent.groups.scrollTop, initial.groups.scrollTop, `${agentName} 不应移动群组列表`);
    assert.ok(group.groups.scrollTop > 0 && fullyVisible(group.groups.rows.at(-1), group.groups), `${groupName} 应能滚到最后一个群组`);
    close(group.agents.scrollTop, agent.agents.scrollTop, `${groupName} 不应移动 Agent 列表`);
    stable(initial, agent, agentName, headings); stable(initial, group, groupName, headings);
  }
  for (const [name, key, id] of [["agentFocused", "agents", "layout-agent-5"], ["groupFocused", "groups", "layout-group-5"],
    ["collapsedAgentFocused", "agents", "layout-agent-5"], ["collapsedGroupFocused", "groups", "layout-group-5"]]) {
    const sample = facts[name];
    assert.equal(sample.focused, id, `${name} 最后入口应可获得键盘焦点`);
    assert.ok(fullyVisible(sample[key].rows.at(-1), sample[key]), `${name} 焦点应自动滚入列表可见范围`);
  }
  for (const key of ["agents", "groups"]) {
    assert.ok(facts.expanded[key].scrollHeight > facts.initial[key].scrollHeight, `${key} 展开历史后不能压缩条目`);
    assert.ok(fullyVisible(facts.expandedScrolled[key].rows.at(-1), facts.expandedScrolled[key]), `${key} 展开历史后仍应能滚到最后入口`);
  }
  for (const heading of [facts.initial.agentHeading, facts.initial.groupHeading])
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
