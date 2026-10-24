import type { initWorkspaceResize } from "../../public/panel-resize.js";
import type { createSidebarHistory } from "../../public/sidebar-history.js";
import type { renderAgentAvatar } from "../../public/agent-avatar.js";
import type { renderGroupAvatar } from "../../public/group-avatar.js";
interface LayoutElements { "group-chat-form": HTMLFormElement; "group-message": HTMLTextAreaElement; "group-messages": HTMLElement; "group-page-shell": HTMLElement; "group-panel": HTMLElement; "group-primary": HTMLElement; "group-mention-popup": HTMLElement; "group-send": HTMLButtonElement; "group-share-open": HTMLButtonElement; "group-title": HTMLElement; "group-upload": HTMLButtonElement; "page-group": HTMLElement }
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function inspectGroupLayout({ markup, stylesheet, avatarAssets }: { markup: string; stylesheet: string; avatarAssets: Record<string, string> }, initResize: typeof initWorkspaceResize<HTMLElement>, renderAvatar: typeof renderAgentAvatar<HTMLElement>) {
  const style = document.createElement("style");
  style.textContent = stylesheet + "\n#test-result { display: none; }\n*, *::before, *::after { animation: none !important; transition: none !important; }";
  document.head.append(style); document.body.insertAdjacentHTML("beforeend", markup);
  const byId = <K extends keyof LayoutElements>(id: K) => document.getElementById(id) as LayoutElements[K];
  for (const page of document.querySelectorAll<HTMLElement>(".page")) page.hidden = page.id !== "page-group";
  const page = byId("page-group"), shell = byId("group-page-shell"), primary = byId("group-primary");
  const panel = byId("group-panel"), header = primary!.querySelector<HTMLElement>("header")!, conversation = primary!.querySelector<HTMLElement>(".conversation")!;
  const capsule = header!.querySelector<HTMLElement>('[aria-controls="group-panel"]')!, title = byId("group-title");
  const messages = byId("group-messages"), composer = byId("group-chat-form"), input = byId("group-message");
  const settingsContent = panel!.querySelector<HTMLElement>(".agent-detail-section:not([hidden])")! ?? panel!.querySelector<HTMLElement>("section:not([hidden])")!;
  const plus = composer!.querySelector<HTMLElement>(".agent-composer-add")!, send = byId("group-send");
  title!.textContent = "研究协作小组"; capsule!.title = title!.textContent; send!.disabled = false;
  const storage = new Map<string, string>();
  const controls = initResize({ windowRef: { performance: window.performance, ResizeObserver, MutationObserver,
    addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } } })!;
  const setSettings = (open: boolean|undefined) => {
    shell!.classList.toggle("settings-open", open); panel!.hidden = !open;
    capsule!.setAttribute("aria-expanded", String(open)); controls.sidebar.refresh();
  };
  const make = (className: string, text: string|null) => { const node = document.createElement("div"); node.className = className; node.textContent = text; return node; };
  const blue = { id: "layout-blue", name: "材料阅读助手", profile: { icon: "star:0:1" }, color: "blue" };
  const mint = { id: "layout-mint", name: "跨资料研究校验与结果整理助手".repeat(7), profile: { icon: "star:3:0" }, color: "mint" };
  const identity = (node: HTMLSpanElement, agent: { id: string|undefined; color: string|undefined; }) => { node.dataset.agentId = agent.id; node.dataset.avatarColor = agent.color; return node; };
  const avatar = (agent: typeof blue, className: string) => {
    const node = document.createElement("span"); node.className = className;
    renderAvatar(node, agent, { motion: false, document: { createElement: (tag: string) => {
      const element = document.createElement(tag);
      if (tag === "img") Object.defineProperty(element, "src", { set: (value) => element.setAttribute("src",
        value === "/assets/avatars/core.png" ? avatarAssets.core : value) });
      return element;
    } } });
    const root = node.querySelector<HTMLElement>(".star-avatar")!;
    node.querySelector<HTMLElement>(".star-avatar-shell")!.style.setProperty("--avatar-mask", `url("${avatarAssets[root!.dataset.shape!]}")`);
    return node;
  };
  const agentMessage = (sender: typeof blue, recipient: typeof blue, long: boolean) => {
    const row = document.createElement("article"); row.className = "message assistant group-agent-message";
    const name = document.createElement("span"); name.className = "group-message-sender group-agent-identity"; name.textContent = sender.name;
    const body = make("bubble rich-text", ""), opening = document.createElement("p");
    const mention = document.createElement("span"); mention.className = "group-message-mention group-agent-identity";
    identity(mention, recipient); mention.setAttribute("aria-label", `@${recipient.name}`); mention.title = `@${recipient.name}`;
    const recipientName = document.createElement("span"); recipientName.className = "group-mention-name"; recipientName.textContent = recipient.name;
    mention.append(avatar(recipient, "group-mention-avatar"), recipientName);
    opening.append(mention, document.createTextNode(" 请协助核对材料并整理结果。")); body.append(opening);
    for (let index = 0; index < (long ? 80 : 1); index++) {
      const paragraph = document.createElement("p");
      paragraph.textContent = long ? `第 ${index + 1} 段：检查群消息在自己的区域中滚动，并验证长正文与相互提及不会横向撑开页面。`
        : "已收到协作内容，正在整理讨论重点。";
      body.append(paragraph);
    }
    row.append(avatar(sender, "group-message-avatar"), identity(name, sender), body); return row;
  };
  const fillMessages = (long: boolean) => {
    const date = document.createElement("time"); date.className = "conversation-date";
    date.dateTime = "2026-10-13T03:57:00.000Z"; date.textContent = "2026/10/13 11:57";
    const user = make("message user", ""); user.append(make("bubble", "请整理这次小组讨论的重点。"));
    const system = make("message assistant", ""); system.append(make("bubble", "小组已开始协作。"));
    messages!.replaceChildren(date, user, system, agentMessage(blue, mint, long), agentMessage(mint, blue, false)); messages!.scrollTop = 0;
  };
  const rect = (element: Element) => {
    const value = element!.getBoundingClientRect();
    return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
  };
  const visible = (element: HTMLElement) => {
    const css = getComputedStyle(element), bounds = element!.getBoundingClientRect();
    return !element!.hidden && css.display !== "none" && css.visibility !== "hidden" && css.opacity !== "0" && bounds.width > 0 && bounds.height > 0;
  };
  const textRects = (element: Node|null) => {
    const range = document.createRange(); range.selectNodeContents(element!);
    return [...range.getClientRects()].filter((value) => value.width > 0).map((value) => ({ left: value.left, right: value.right,
      top: value.top, bottom: value.bottom, width: value.width, height: value.height }));
  };
  const swatch = document.createElement("span"); swatch.hidden = true; swatch.style.background = "var(--surface-2)";
  document.body.append(swatch); const bodyBackground = getComputedStyle(swatch).backgroundColor; swatch.remove();
  const agentMessages = () => [...messages!.querySelectorAll<HTMLElement>(".group-agent-message")].map((row) => {
    const name = row.querySelector<HTMLElement>(".group-message-sender")!, portrait = row.querySelector<HTMLElement>(".group-message-avatar")!, body = row.querySelector<HTMLElement>(".bubble")!;
    const mention = body!.querySelector<HTMLElement>(".group-message-mention")!, mentionAvatar = mention!.querySelector<HTMLElement>(".group-mention-avatar")!;
    const mentionName = mention!.querySelector<HTMLElement>(".group-mention-name")!, paragraph = body!.firstElementChild, css = getComputedStyle(body);
    return { ...rect(row), display: getComputedStyle(row).display, clientWidth: row.clientWidth, scrollWidth: row.scrollWidth,
      sender: { ...rect(name), text: name!.textContent, visible: visible(name), color: getComputedStyle(name).color, textRects: textRects(name) },
      avatar: { ...rect(portrait), visible: visible(portrait) },
      body: { ...rect(body), visible: visible(body), background: css.backgroundColor, expectedBackground: bodyBackground,
        paddingLeft: Number.parseFloat(css.paddingLeft), paddingTop: Number.parseFloat(css.paddingTop),
        borderRadius: Number.parseFloat(css.borderTopLeftRadius), clientWidth: body!.clientWidth, scrollWidth: body!.scrollWidth },
      mention: { ...rect(mention), display: getComputedStyle(mention).display, visible: visible(mention), color: getComputedStyle(mention).color,
        name: mentionName!.textContent, nameVisible: visible(mentionName), textRects: textRects(mentionName),
        avatar: { ...rect(mentionAvatar), visible: visible(mentionAvatar) }, inlinePrefix: paragraph!.tagName === "P"
          && paragraph!.firstChild === mention && mention!.nextSibling?.nodeType === Node.TEXT_NODE && Boolean(mention!.nextSibling.textContent!.trim()) } };
  });
  const topBandText = () => {
    const headerBounds = header!.getBoundingClientRect(), capsuleBounds = capsule!.getBoundingClientRect();
    const top = messages!.getBoundingClientRect().top;
    return [...messages!.querySelectorAll<HTMLElement>(".bubble")].flatMap((bubble) => {
      const range = document.createRange(); range.selectNodeContents(bubble); return [...range.getClientRects()];
    }).filter((bounds) => bounds.bottom > top && bounds.top < headerBounds.bottom
      && (bounds.left < capsuleBounds.left || bounds.right > capsuleBounds.right)).length;
  };
  const snapshot = () => ({
    viewport: { width: innerWidth, height: innerHeight }, page: rect(page), primary: rect(primary), conversation: rect(conversation),
    documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    header: { ...rect(header), position: getComputedStyle(header).position }, capsule: rect(capsule),
    title: { clientWidth: title!.clientWidth, scrollWidth: title!.scrollWidth,
      textOverflow: getComputedStyle(title).textOverflow, whiteSpace: getComputedStyle(title).whiteSpace },
    composer: rect(composer), compose: { plus: rect(plus), input: rect(input), send: rect(send), rows: input!.rows,
      uploadVisible: visible(byId("group-upload")), shareVisible: visible(byId("group-share-open")),
      mentionInputVisible: visible(input), mentionPopupRole: byId("group-mention-popup").getAttribute("role") },
    messages: { ...rect(messages), clientHeight: messages!.clientHeight, scrollHeight: messages!.scrollHeight, scrollTop: messages!.scrollTop,
      clientWidth: messages!.clientWidth, scrollWidth: messages!.scrollWidth },
    date: { ...rect(messages!.querySelector<HTMLElement>(".conversation-date")!), text: messages!.querySelector<HTMLElement>(".conversation-date")!.textContent },
    firstBubble: rect(messages!.querySelector<HTMLElement>(".message .bubble")!),
    topBandText: topBandText(),
    agentMessages: agentMessages(),
    settings: { ...rect(panel), hidden: panel!.hidden, content: { ...rect(settingsContent), clientHeight: settingsContent!.clientHeight,
      scrollHeight: settingsContent!.scrollHeight, scrollTop: settingsContent!.scrollTop } },
  });
  fillMessages(true); const closed = snapshot(); messages!.scrollTop = messages!.scrollHeight;
  const scrolled = snapshot(); fillMessages(false); const short = snapshot();
  setSettings(true); fillMessages(true); const open = snapshot();
  title!.textContent = "一个用于验证群组胶囊保持紧凑而不挤占对话空间的超长名称".repeat(3);
  capsule!.title = title!.textContent; const longTitle = snapshot(); title!.textContent = "研究协作小组"; capsule!.title = title!.textContent;
  const paragraphs = Array.from({ length: 80 }, (_, index) => make("muted-note", `群组设置 ${index + 1}：检查侧栏内容独立滚动。`));
  settingsContent!.append(...paragraphs); const settingsLong = snapshot(); settingsContent!.scrollTop = settingsContent!.scrollHeight;
  const settingsScrolled = snapshot(); for (const paragraph of paragraphs) paragraph.remove(); settingsContent!.scrollTop = 0;
  input!.style.height = "180px"; const expandedComposer = snapshot(); input!.style.removeProperty("height");
  setSettings(false); const reopenedSpace = snapshot();
  for (const control of Object.values(controls)) control?.dispose();
  return { closed, scrolled, short, open, longTitle, settingsLong, settingsScrolled, expandedComposer, reopenedSpace };
}

export async function groupLayoutScript() {
  const [html, stylesheet, resizeSource, avatarSource] = await Promise.all(["index.html", "style.css", "panel-resize.js", "agent-avatar.js"].map((file) =>
    readFile(new URL(`../../public/${file}`, import.meta.url), "utf8")));
  const avatarAssets = Object.fromEntries(await Promise.all(["core", "cut", "disc"].map(async (name) => [name,
    `data:image/png;base64,${(await readFile(new URL(`../../public/assets/avatars/${name}${name === "core" ? "" : "-mask"}.png`, import.meta.url))).toString("base64")}`])));
  const markup = html!.match(/<body>([\s\S]*)<\/body>/)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  const data = JSON.stringify({ markup, stylesheet, avatarAssets }).replaceAll("<", "\\u003c");
  const resize = resizeSource!.replace(/^export /gm, "").replace(/^if \(typeof document[^\n]*initWorkspaceResize\(\);$/m, "");
  const appearance = avatarSource!.replace(/^export \{[^\n]*\} from [^\n]+;\n/m, "").replace(/^export /gm, "");
  return `${resize}\n${appearance}\nreturn (${inspectGroupLayout.toString()})(${data}, initWorkspaceResize, renderAgentAvatar);`;
}

export function assertGroupLayout(facts: ReturnType<typeof inspectGroupLayout>) {
  const close = (actual: number, expected: number, label: string) => assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} vs ${expected}`);
  for (const [name, sample] of Object.entries(facts)) {
    close(sample.page.height, sample.viewport.height, `${name} 群组页高度`);
    assert.ok(sample.documentHeight <= sample.viewport.height + 1, `${name} 页面不应整体滚动`);
    assert.ok(sample.documentWidth <= sample.viewport.width + 1, `${name} 页面不应横向溢出`);
    assert.ok(sample.messages.scrollWidth <= sample.messages.clientWidth + 1, `${name} 群消息区域不应横向溢出`);
    assert.equal(sample.header.position, "absolute", `${name} 群组胶囊应浮在聊天上方`);
    close(sample.capsule.height, 36, `${name} 群组胶囊高度`);
    close((sample.capsule.left + sample.capsule.right) / 2,
      (sample.conversation.left + sample.conversation.right) / 2, `${name} 群组胶囊应随聊天列居中`);
    close(sample.viewport.height - sample.composer.bottom, 16, `${name} 群组输入区底部留白`);
    assert.ok(sample.messages.clientHeight > 0, `${name} 群消息应有可用高度`);
    assert.ok(sample.date.text.trim(), `${name} 群对话日期应有文字`);
    if (sample.messages.scrollTop <= 1) {
      assert.ok(sample.capsule.bottom < sample.date.top && sample.date.top < sample.date.bottom
        && sample.date.bottom < sample.firstBubble.top, `${name} 群组胶囊下方应先显示日期，再显示首条消息`);
    }
    assert.equal(sample.compose.rows, 1, `${name} 群输入区应以单行为起点`);
    assert.ok(sample.compose.plus.right <= sample.compose.input.left + 1
      && sample.compose.input.right <= sample.compose.send.left + 1, `${name} 加号、输入区和发送应同排`);
    assert.ok(!sample.compose.uploadVisible && !sample.compose.shareVisible, `${name} 上传与分享应收进加号菜单`);
    assert.ok(sample.compose.mentionInputVisible, `${name} 群协作与定向成员的消息输入入口应可见`);
    assert.equal(sample.compose.mentionPopupRole, "listbox", `${name} 群成员提及弹层应保留选择列表角色`);
    if (name !== "expandedComposer") assert.ok(sample.composer.height <= 64, `${name} 默认群输入区应紧凑`);
    if (!sample.settings.hidden) {
      close(sample.settings.width, 400, `${name} 群组设置栏宽度`);
      assert.ok(sample.primary.right <= sample.settings.left + 1, `${name} 设置栏应和聊天并排`);
    }
    assert.equal(sample.agentMessages.length, 2, `${name} 应包含两种身份配色的群Agent消息`);
    for (const [index, message] of sample.agentMessages.entries()) {
      const label = `${name} Agent消息${index + 1}`;
      assert.equal(message.display, "grid", `${label} 应按头像和正文两列布局`);
      assert.ok(message.sender.visible && message.avatar.visible && message.body.visible, `${label} 姓名、头像和正文应可见`);
      assert.ok(message.sender.bottom < message.body.top, `${label} 姓名应位于正文上方`);
      close(message.sender.textRects[0]!.left, message.body.left + 14, `${label} 姓名与正文文字左侧对齐`);
      close(message.avatar.width, 28, `${label} 头像宽度`); close(message.avatar.height, 28, `${label} 头像高度`);
      close(message.avatar.right + 12, message.body.left, `${label} 头像应在正文左侧`);
      close(message.avatar.bottom, message.body.bottom, `${label} 头像应与正文底部对齐`);
      assert.equal(message.body.background, message.body.expectedBackground, `${label} 正文应使用浅灰底`);
      close(message.body.paddingLeft, 14, `${label} 正文横向内边距`); close(message.body.paddingTop, 10, `${label} 正文纵向内边距`);
      close(message.body.borderRadius, 20, `${label} 正文圆角`);
      assert.ok(message.scrollWidth <= message.clientWidth + 1 && message.body.scrollWidth <= message.body.clientWidth + 1,
        `${label} 长姓名和正文不应横向溢出`);
      assert.ok(message.mention.visible && message.mention.nameVisible && message.mention.avatar.visible,
        `${label} 提及头像和名称应可见`);
      assert.equal(message.mention.display, "inline", `${label} 提及应随正文行内排版`);
      assert.ok(message.mention.inlinePrefix, `${label} 提及应位于首段正文前缀而非独立行`);
      close(message.mention.avatar.width, 18, `${label} 提及头像宽度`); close(message.mention.avatar.height, 18, `${label} 提及头像高度`);
      assert.ok(message.mention.textRects.every((line: { left: number; right: number; }) => line.left >= message.body.left + 13 && line.right <= message.body.right - 13),
        `${label} 长提及名称应在正文内换行`);
    }
    assert.notEqual(sample.agentMessages[0]!.sender.color, sample.agentMessages[1]!.sender.color, `${name} 发送者配色应能区分`);
    assert.equal(sample.agentMessages[0]!.mention.color, sample.agentMessages[1]!.sender.color, `${name} 提及应使用接收者配色`);
    assert.equal(sample.agentMessages[1]!.mention.color, sample.agentMessages[0]!.sender.color, `${name} 提及应使用接收者配色`);
  }
  assert.ok(facts.closed.settings.hidden && facts.reopenedSpace.settings.hidden, "群设置默认关闭并能恢复聊天宽度");
  assert.ok(facts.closed.conversation.width > facts.open.conversation.width, "展开设置应收窄聊天列");
  close(facts.reopenedSpace.conversation.width, facts.closed.conversation.width, "关闭设置应恢复聊天宽度");
  assert.ok(facts.closed.messages.scrollHeight > facts.closed.messages.clientHeight && facts.scrolled.messages.scrollTop > 0,
    "长群消息应能实际独立滚动");
  assert.ok(facts.scrolled.date.bottom < facts.scrolled.messages.top, "群对话日期应随长消息滚出顶部");
  assert.ok(facts.scrolled.topBandText > 0, "群消息滚动后仍应能进入胶囊两侧的顶部区域");
  assert.ok(facts.longTitle.title.scrollWidth > facts.longTitle.title.clientWidth, "长群名应限制在胶囊中");
  assert.equal(facts.longTitle.title.textOverflow, "ellipsis"); assert.equal(facts.longTitle.title.whiteSpace, "nowrap");
  assert.ok(facts.settingsLong.settings.content.scrollHeight > facts.settingsLong.settings.content.clientHeight
    && facts.settingsScrolled.settings.content.scrollTop > 0, "群组设置内容应能实际独立滚动");
  assert.ok(facts.expandedComposer.composer.height > facts.open.composer.height
    && facts.expandedComposer.messages.clientHeight < facts.open.messages.clientHeight,
  "输入区增高应压缩消息区域而不撑高页面");
}
