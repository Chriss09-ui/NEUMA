import type { initWorkspaceResize } from "../../public/panel-resize.js";
import type { createSidebarHistory } from "../../public/sidebar-history.js";
import type { renderAgentAvatar } from "../../public/agent-avatar.js";
import type { renderGroupAvatar } from "../../public/group-avatar.js";
interface LayoutElements { "agent-attachment-add": HTMLButtonElement; "agent-attachment-menu-toggle": HTMLButtonElement; "agent-attachment-pick": HTMLButtonElement; "agent-chat-form": HTMLFormElement; "agent-chat-retry": HTMLButtonElement; "agent-conversation": HTMLElement; "agent-details-profile": HTMLElement; "agent-error": HTMLElement; "agent-making-panel": HTMLElement; "agent-message": HTMLTextAreaElement; "agent-messages": HTMLElement; "agent-page-shell": HTMLElement; "agent-panel": HTMLElement; "agent-panel-toggle": HTMLButtonElement; "agent-primary": HTMLElement; "agent-save-actions": HTMLElement; "agent-send": HTMLButtonElement; "agent-title": HTMLElement; "agent-workspace": HTMLElement; "app-shell": HTMLElement; "page-agent": HTMLElement; "sidebar-agent-list": HTMLElement; "sidebar-resize": HTMLElement; "sidebar-toggle": HTMLButtonElement }
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function inspectAgentLayout({ markup, stylesheet }: { markup: string; stylesheet: string }, initResize: typeof initWorkspaceResize<HTMLElement>, initHistory: typeof createSidebarHistory<{ id: string; title: string }>) {
  const style = document.createElement("style");
  style.textContent = stylesheet + "\n#test-result { display: none; }\n*, *::before, *::after { animation: none !important; transition: none !important; }";
  document.head.append(style);
  document.body.insertAdjacentHTML("beforeend", markup);
  const byId = <K extends keyof LayoutElements>(id: K) => document.getElementById(id) as LayoutElements[K];
  for (const page of document.querySelectorAll<HTMLElement>(".page")) page.hidden = page.id !== "page-agent";
  byId("agent-title")!.textContent = "材料阅读测试";
  byId("agent-send")!.disabled = false;
  byId("agent-messages")!.style.setProperty("--user-bubble-background", "#ff7a00");
  byId("agent-messages")!.style.setProperty("--user-bubble-color", "#fff");
  const workspace = byId("agent-workspace"), messages = byId("agent-messages");
  const primary = byId("agent-primary"), shell = byId("agent-page-shell"), panel = byId("agent-panel");
  const profile = byId("agent-details-profile");
  const capsule = byId("agent-panel-toggle"), title = byId("agent-title");
  const header = document.querySelector<HTMLElement>(".agent-chat-header")!, conversation = byId("agent-conversation");
  const composer = byId("agent-chat-form"), textarea = byId("agent-message");
  const navigationList = byId("sidebar-agent-list"), making = byId("agent-making-panel");
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = "") => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const storage = new Map<string, string>();
  const historyView = initHistory({ document, id: "layout-agent-history", title: "材料阅读测试", href: "#agent/layout",
    icon: make("span", "sidebar-agent-avatar", "✦"),
    storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } });
  navigationList!.replaceChildren(historyView.root); historyView.setExpanded(true);
  const history = historyView.list;
  const controls = initResize({ windowRef: { performance: window.performance, ResizeObserver, MutationObserver,
    addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } } })!;
  const refresh = () => controls.sidebar.refresh();
  const setCollapsed = (closed: boolean|undefined) => { byId("app-shell")!.classList.toggle("sidebar-collapsed", closed); refresh(); };
  const setSettings = (open: boolean|undefined) => {
    shell!.classList.toggle("settings-open", open); panel!.hidden = !open;
    capsule!.setAttribute("aria-expanded", String(open)); refresh();
  };
  const resizeNavigation = (key: string) => byId("sidebar-resize")!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  historyView.update({ records: Array.from({ length: 40 }, (_, index) => ({ id: `conversation-${index}`, title: `历史对话 ${index + 1}` })),
    renderRow(record: { title: string; id: string; }) {
      const button = make("button", "sidebar-history-item", record.title); button.type = "button";
      button.dataset.conversationId = record.id; return button;
    } });
  const historyDefaultCount = history.children.length;
  historyView.more.click(); const historyExpandedCount = history.children.length;
  historyView.setExpanded(false); const historyCollapsedInert = historyView.body.inert;
  historyView.setExpanded(true);
  const fillMessages = (long: boolean) => {
    messages!.replaceChildren();
    const date = make("time", "conversation-date", "2026/10/13 11:57");
    date.dateTime = "2026-10-13T03:57:00.000Z"; messages!.append(date);
    const user = make("div", "message user");
    user.append(make("div", "bubble", "请阅读材料，给出摘要和重点。")); messages!.append(user);
    const reply = make("div", "message assistant");
    const content = long ? Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 段：这是用于检查滚动的长回复内容。`).join("\n\n")
      : "看得见，材料已读完。";
    reply.append(make("div", "bubble", content)); messages!.append(reply); messages!.scrollTop = 0;
  };
  const rect = (element: Element) => {
    const value = element!.getBoundingClientRect();
    return { top: value.top, bottom: value.bottom, left: value.left, right: value.right, height: value.height, width: value.width };
  };
  const visible = (element: HTMLElement) => {
    const css = getComputedStyle(element), bounds = element!.getBoundingClientRect();
    return !element!.hidden && css.display !== "none" && css.visibility !== "hidden" && css.opacity !== "0"
      && bounds.width > 0 && bounds.height > 0;
  };
  const overlay = () => {
    const headerBounds = header!.getBoundingClientRect(), capsuleBounds = capsule!.getBoundingClientRect();
    const conversationBounds = conversation!.getBoundingClientRect(), y = capsuleBounds.top + capsuleBounds.height / 2;
    const through = (x: number) => conversation!.contains(document.elementFromPoint(x, y));
    const layers = [header, ...header!.querySelectorAll<HTMLElement>("*")]
      .filter((element) => element !== capsule && !capsule!.contains(element)).flatMap((element) =>
      [null, "::before", "::after"].map((pseudo) => {
        const css = getComputedStyle(element, pseudo);
        return { backdropFilter: [css.backdropFilter, (css as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter].find((value) => /blur\(/.test(value ?? "")) ?? "none",
          backgroundColor: css.backgroundColor, backgroundImage: css.backgroundImage, opacity: css.opacity };
      })).filter((layer) => /blur\(/.test(layer.backdropFilter));
    const ranges = [...messages!.querySelectorAll<HTMLElement>(".bubble")].flatMap((bubble) => {
      const range = document.createRange(); range.selectNodeContents(bubble); return [...range.getClientRects()];
    });
    return { position: getComputedStyle(header).position, pointerEvents: getComputedStyle(header).pointerEvents,
      backgroundColor: getComputedStyle(header).backgroundColor, backgroundImage: getComputedStyle(header).backgroundImage,
      opacity: getComputedStyle(header).opacity, capsulePointerEvents: getComputedStyle(capsule).pointerEvents,
      capsuleHit: capsule!.contains(document.elementFromPoint(capsuleBounds.left + capsuleBounds.width / 2, y)),
      leftPassThrough: through(Math.max(conversationBounds.left + 1, capsuleBounds.left - 10)),
      rightPassThrough: through(Math.min(conversationBounds.right - 1, capsuleBounds.right + 10)), layers,
      topBandText: ranges.filter((bounds) => bounds.bottom > messages!.getBoundingClientRect().top
        && bounds.top < headerBounds.bottom && (bounds.left < capsuleBounds.left || bounds.right > capsuleBounds.right)).length };
  };
  const snapshot = () => ({
    viewport: { width: innerWidth, height: innerHeight },
    documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    page: rect(byId("page-agent")), header: rect(header), overlay: overlay(), workspace: rect(workspace),
    primary: rect(primary), conversation: rect(conversation), capsule: rect(capsule), composer: rect(composer),
    compose: { row: rect(composer!.querySelector<HTMLElement>(".agent-compose-row")!), plus: rect(byId("agent-attachment-menu-toggle")),
      input: rect(textarea), send: rect(byId("agent-send")), rows: textarea!.rows,
      uploadVisible: visible(byId("agent-attachment-add")), pickerVisible: visible(byId("agent-attachment-pick")) },
    title: { ...rect(title), clientWidth: title!.clientWidth, scrollWidth: title!.scrollWidth,
      textOverflow: getComputedStyle(title).textOverflow, whiteSpace: getComputedStyle(title).whiteSpace },
    navigation: rect(document.querySelector<HTMLElement>(".sidebar")!), historyInNavigation: history.closest(".sidebar") !== null,
    conversationColumns: getComputedStyle(workspace).gridTemplateColumns.split(" ").length,
    navigationToggleVisible: visible(byId("sidebar-toggle")),
    settings: { ...rect(panel), hidden: panel!.hidden,
      content: { ...rect(profile), clientHeight: profile!.clientHeight, scrollHeight: profile!.scrollHeight, scrollTop: profile!.scrollTop } },
    messages: { ...rect(messages), clientHeight: messages!.clientHeight, scrollHeight: messages!.scrollHeight, scrollTop: messages!.scrollTop },
    date: { ...rect(messages!.querySelector<HTMLElement>(".conversation-date")!), text: messages!.querySelector<HTMLElement>(".conversation-date")!.textContent },
    firstBubble: rect(messages!.querySelector<HTMLElement>(".message .bubble")!),
  });

  fillMessages(true);
  const long = snapshot(); messages!.scrollTop = messages!.scrollHeight;
  const scrolled = snapshot();
  fillMessages(false);
  const short = snapshot();
  resizeNavigation("Home"); const navigationNarrow = snapshot();
  resizeNavigation("End"); const navigationWide = snapshot();
  setCollapsed(true); fillMessages(true);
  const collapsed = snapshot();
  const resizeHandle = byId("sidebar-resize"), grip = resizeHandle!.getBoundingClientRect();
  resizeHandle!.dispatchEvent(new PointerEvent("pointerdown", { button: 0, isPrimary: true, pointerId: 7,
    clientX: grip.left + grip.width / 2, clientY: grip.top + 100, bubbles: true }));
  window.dispatchEvent(new PointerEvent("pointermove", { isPrimary: true, pointerId: 7,
    clientX: grip.left + grip.width / 2 + 16, clientY: grip.top + 100 }));
  const collapsedPreview = snapshot();
  window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 7 }));
  setSettings(true); const settingsCollapsed = snapshot();
  setCollapsed(false); const settingsOpen = snapshot();
  const settingsParagraphs = Array.from({ length: 80 }, (_, index) => make("p", "muted-note", `设置内容 ${index + 1}：检查侧栏内容独立滚动。`));
  profile!.append(...settingsParagraphs); const settingsLongContent = snapshot();
  profile!.scrollTop = profile!.scrollHeight; const settingsScrolled = snapshot();
  for (const paragraph of settingsParagraphs) paragraph.remove(); profile!.scrollTop = 0;
  title!.textContent = "这是一个用于验证头像名称胶囊不会占用大量空间的超长智能体名称".repeat(3);
  capsule!.title = title!.textContent; const settingsLongName = snapshot();
  title!.textContent = "材料阅读测试"; capsule!.title = title!.textContent;
  setSettings(false); const settingsClosed = snapshot();
  setCollapsed(true);
  textarea!.style.height = "180px";
  const expandedComposer = snapshot(); textarea!.style.removeProperty("height");
  byId("agent-error")!.hidden = false; byId("agent-error")!.textContent = "保存失败，请重试。";
  byId("agent-save-actions")!.hidden = false; byId("agent-chat-retry")!.hidden = false;
  const recovery = snapshot();
  byId("agent-error")!.hidden = true; byId("agent-save-actions")!.hidden = true;

  workspace!.classList.add("is-making"); making!.hidden = false;
  byId("agent-conversation")!.hidden = true;
  refresh();
  for (let index = 0; index < 80; index++) {
    const paragraph = make("p", "muted-note", `研发阶段说明 ${index + 1}`);
    paragraph.style.marginBottom = "18px"; making!.append(paragraph);
  }
  workspace!.scrollTop = workspace!.scrollHeight;
  const preparing = { viewport: { width: innerWidth, height: innerHeight },
    documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    page: rect(byId("page-agent")), header: rect(document.querySelector<HTMLElement>(".agent-chat-header")!),
    workspace: { ...rect(workspace), clientHeight: workspace!.clientHeight, scrollHeight: workspace!.scrollHeight, scrollTop: workspace!.scrollTop } };
  making!.hidden = true; byId("agent-conversation")!.hidden = false;
  workspace!.classList.remove("is-making"); workspace!.scrollTop = 0;
  fillMessages(true); messages!.scrollTop = messages!.scrollHeight;
  for (const control of Object.values(controls)) control?.dispose();
  return { historyDefaultCount, historyExpandedCount, historyCollapsedInert, long, scrolled, short, navigationNarrow, navigationWide, collapsed, collapsedPreview, settingsCollapsed,
    settingsOpen, settingsLongContent, settingsScrolled, settingsLongName, settingsClosed, expandedComposer, recovery, preparing };
}

export async function agentLayoutScript() {
  const [html, stylesheet, resizeSource, historySource] = await Promise.all(["index.html", "style.css", "panel-resize.js", "sidebar-history.js"].map((file) =>
    readFile(new URL(`../../public/${file}`, import.meta.url), "utf8")));
  const markup = html!.match(/<body>([\s\S]*)<\/body>/)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  const data = JSON.stringify({ markup, stylesheet }).replaceAll("<", "\\u003c");
  const resize = resizeSource!.replace(/^export /gm, "")
    .replace(/^if \(typeof document[^\n]*initWorkspaceResize\(\);$/m, "");
  return `${resize}\n${historySource!.replace(/^export /gm, "")}\nreturn (${inspectAgentLayout.toString()})(${data}, initWorkspaceResize, createSidebarHistory);`;
}

export function assertAgentLayout(facts: ReturnType<typeof inspectAgentLayout>) {
  assert.equal(facts.historyDefaultCount, 4, "展开 Agent 后默认只显示前四条对话");
  assert.equal(facts.historyExpandedCount, 40, "展开显示后可查看全部历史");
  assert.equal(facts.historyCollapsedInert, true, "收起的历史不应保留键盘操作入口");
  const close = (actual: number, expected: number, label: string) => assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} vs ${expected}`);
  const alpha = (color: string) => {
    if (color === "transparent") return 0;
    const slash = color.match(/\/\s*([\d.]+)(%)?\s*\)$/);
    if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1);
    const rgba = color.match(/^rgba\([^)]*,\s*([\d.]+)\s*\)$/);
    return rgba ? Number(rgba[1]) : 1;
  };
  const translucent = (layer: { opacity: string; backgroundColor: string; backgroundImage: string }) => {
    if (Number(layer.opacity) < 1) return true;
    if (alpha(layer.backgroundColor) >= 1) return false;
    const colors = layer.backgroundImage.match(/(?:rgba?|color)\([^)]*\)|transparent/g) ?? [];
    return layer.backgroundImage === "none" || (colors.length > 0 && colors.every((color: string) => alpha(color) < 1));
  };
  for (const name of ["long", "scrolled", "short", "navigationNarrow", "navigationWide", "collapsed", "collapsedPreview", "settingsCollapsed",
    "settingsOpen", "settingsLongContent", "settingsScrolled", "settingsLongName", "settingsClosed", "expandedComposer", "recovery"] as const) {
    const sample = facts[name];
    close(sample!.page.height, sample!.viewport.height, `${name} 页面高度`);
    assert.ok(sample!.documentHeight <= sample!.viewport.height + 1, `${name} 整页不应滚动`);
    assert.ok(sample!.documentWidth <= sample!.viewport.width + 1, `${name} 页面不应横向溢出`);
    assert.ok(sample!.composer.bottom <= sample!.viewport.height + 1, `${name} 输入框不能被挤出视口`);
    close(sample!.viewport.height - sample!.composer.bottom, 16, `${name} 输入区底部留白`);
    assert.equal(sample!.compose.rows, 1, `${name} 默认输入框应以单行为起点`);
    assert.ok(sample!.compose.plus.right <= sample!.compose.input.left + 1
      && sample!.compose.input.right <= sample!.compose.send.left + 1, `${name} 加号、输入区和发送按钮应横向排列`);
    assert.ok(Math.max(sample!.compose.plus.top, sample!.compose.input.top, sample!.compose.send.top)
      < Math.min(sample!.compose.plus.bottom, sample!.compose.input.bottom, sample!.compose.send.bottom),
    `${name} 输入控件应处于同一行`);
    assert.ok(sample!.compose.row.top >= sample!.composer.top && sample!.compose.row.bottom <= sample!.composer.bottom,
      `${name} 输入控件不能溢出胶囊输入区`);
    assert.ok(!sample!.compose.uploadVisible && !sample!.compose.pickerVisible, `${name} 附件入口应收进加号菜单`);
    if (name !== "expandedComposer") assert.ok(sample!.composer.height <= 64, `${name} 单行输入区应紧凑`);
    assert.ok(sample!.messages.clientHeight > 0, `${name} 消息区应有可用高度`);
    assert.ok(sample!.date.text.trim(), `${name} 对话日期应有文字`);
    if (sample!.messages.scrollTop <= 1) {
      assert.ok(sample!.capsule.bottom < sample!.date.top && sample!.date.top < sample!.date.bottom
        && sample!.date.bottom < sample!.firstBubble.top, `${name} 胶囊下方应先显示日期，再显示首条消息`);
    }
    assert.ok(sample!.header.height <= 48, `${name} 顶部整体占高应控制在48px内`);
    assert.equal(sample!.overlay.position, "absolute", `${name} 胶囊浮层不应占用工作区行高`);
    close(sample!.workspace.top, sample!.header.top, `${name} 工作区应从浮层下层顶部开始`);
    assert.ok(sample!.messages.top < sample!.header.bottom, `${name} 消息区应延伸到浮层下层`);
    assert.ok(translucent(sample!.overlay), `${name} 顶部浮层不能用不透明横条遮住聊天`);
    assert.ok(sample!.overlay.layers.length > 0, `${name} 胶囊周围应有轻雾模糊层`);
    assert.ok(sample!.overlay.layers.every(translucent), `${name} 轻雾层应允许消息透出`);
    assert.equal(sample!.overlay.pointerEvents, "none", `${name} 顶部浮层应允许操作下方消息`);
    assert.equal(sample!.overlay.capsulePointerEvents, "auto", `${name} 胶囊仍应可点击`);
    assert.ok(sample!.overlay.capsuleHit, `${name} 胶囊中心应可命中设置入口`);
    assert.ok(sample!.overlay.leftPassThrough && sample!.overlay.rightPassThrough,
      `${name} 胶囊两侧应能直接命中聊天区域`);
    close(sample!.capsule.height, 36, `${name} 顶部胶囊高度`);
    close((sample!.capsule.left + sample!.capsule.right) / 2,
      (sample!.conversation.left + sample!.conversation.right) / 2, `${name} 胶囊应以当前对话列居中`);
    assert.ok(sample!.historyInNavigation, `${name} 历史应归入主导航`);
    assert.equal(sample!.conversationColumns, 1, `${name} 私聊工作区应只有对话列`);
    assert.ok(sample!.navigationToggleVisible, `${name} 主导航开合按钮应可见`);
    close(sample!.header.top, facts.long.header.top, `${name} 标题位置`);
    close(sample!.composer.bottom, facts.long.composer.bottom, `${name} 输入框底部位置`);
  }
  assert.ok(facts.long.messages.scrollHeight > facts.long.messages.clientHeight, "长回复必须在消息区内滚动");
  assert.ok(facts.scrolled.messages.scrollTop > 0, "消息区必须能实际滚动");
  assert.ok(facts.scrolled.date.bottom < facts.scrolled.messages.top, "对话日期应随长消息滚出顶部");
  assert.ok(facts.scrolled.overlay.topBandText > 0, "长消息滚动后应能在胶囊两侧显示顶部文字");
  assert.ok(facts.collapsed.messages.width > facts.long.messages.width, "折叠主导航后对话应使用更多空间");
  assert.ok(facts.collapsedPreview.navigation.width > facts.collapsed.navigation.width, "折叠后的拉出预览应实时更新列宽");
  assert.ok(facts.navigationWide.navigation.width > facts.navigationNarrow.navigation.width, "主导航宽度应能实际调整");
  assert.ok(facts.navigationNarrow.conversation.width > facts.navigationWide.conversation.width, "调整主导航应更新对话列宽度");
  for (const name of ["settingsOpen", "settingsCollapsed", "settingsLongContent", "settingsScrolled", "settingsLongName"] as const) {
    assert.equal(facts[name]!.settings.hidden, false, `${name} 设置侧栏应展开`);
    close(facts[name]!.settings.width, 400, `${name} 设置侧栏宽度`);
    assert.ok(facts[name]!.primary.right <= facts[name]!.settings.left + 1, `${name} 设置应和工作区并排`);
  }
  assert.ok(facts.settingsClosed.settings.hidden, "设置关闭后应隐藏侧栏");
  assert.ok(facts.settingsLongContent.settings.content.scrollHeight > facts.settingsLongContent.settings.content.clientHeight,
    "长设置内容应在侧栏内容区内滚动");
  assert.ok(facts.settingsScrolled.settings.content.scrollTop > 0, "设置内容区必须能实际滚动");
  assert.ok(facts.settingsClosed.primary.width > facts.settingsOpen.primary.width, "关闭设置应恢复工作区宽度");
  assert.ok(facts.settingsLongName.title.scrollWidth > facts.settingsLongName.title.clientWidth, "超长名称应被约束在胶囊内");
  assert.equal(facts.settingsLongName.title.textOverflow, "ellipsis", "超长名称应显示省略号");
  assert.equal(facts.settingsLongName.title.whiteSpace, "nowrap", "超长名称应保持单行");
  assert.ok(facts.expandedComposer.composer.height > facts.collapsed.composer.height, "输入框变高时消息区应让出空间");
  assert.ok(facts.expandedComposer.messages.clientHeight < facts.collapsed.messages.clientHeight,
    "输入区增高后应压缩消息区而不撑高页面");
  assert.ok(facts.expandedComposer.messages.scrollHeight > facts.expandedComposer.messages.clientHeight,
    "输入区增高后长消息仍应单独滚动");
  close(facts.preparing.page.height, facts.preparing.viewport.height, "制作页高度");
  assert.ok(facts.preparing.documentHeight <= facts.preparing.viewport.height + 1, "制作内容不应撑开整页");
  assert.ok(facts.preparing.workspace.scrollHeight > facts.preparing.workspace.clientHeight, "制作内容应单独滚动");
  assert.ok(facts.preparing.workspace.scrollTop > 0, "制作内容必须能实际滚动");
  close(facts.preparing.header.top, facts.long.header.top, "制作状态标题位置");
}
