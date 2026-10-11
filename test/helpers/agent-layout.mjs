import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function inspectAgentLayout({ markup, stylesheet }) {
  const result = document.getElementById("test-result");
  if (result) result.hidden = true;
  const style = document.createElement("style");
  style.textContent = stylesheet + "\n*, *::before, *::after { animation: none !important; transition: none !important; }";
  document.head.append(style);
  document.body.insertAdjacentHTML("beforeend", markup);
  const byId = (id) => document.getElementById(id);
  for (const page of document.querySelectorAll(".page")) page.hidden = page.id !== "page-agent";
  byId("agent-title").textContent = "材料阅读测试";
  byId("agent-subtitle").textContent = "阅读上传文件或图片，给出简短摘要和来源。";
  byId("agent-send").disabled = false;
  byId("agent-conversation-actions").hidden = false;
  byId("agent-messages").style.setProperty("--user-bubble-background", "#ff7a00");
  byId("agent-messages").style.setProperty("--user-bubble-color", "#fff");
  const workspace = byId("agent-workspace"), messages = byId("agent-messages");
  const composer = byId("agent-chat-form"), textarea = byId("agent-message");
  const history = byId("agent-history-list"), making = byId("agent-making-panel");
  const make = (tag, className, text = "") => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  for (let index = 0; index < 40; index++) {
    const row = make("div", "agent-history-row"), button = make("button", "agent-history-select");
    button.append(make("span", "agent-history-title", `历史对话 ${index + 1}`)); row.append(button); history.append(row);
  }
  const fillMessages = (long) => {
    messages.replaceChildren();
    const user = make("div", "message user");
    user.append(make("div", "bubble", "请阅读材料，给出摘要和重点。")); messages.append(user);
    const reply = make("div", "message assistant");
    const content = long ? Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 段：这是用于检查滚动的长回复内容。`).join("\n\n")
      : "看得见，材料已读完。";
    reply.append(make("div", "bubble", content)); messages.append(reply);
  };
  const rect = (element) => {
    const value = element.getBoundingClientRect();
    return { top: value.top, bottom: value.bottom, height: value.height, width: value.width };
  };
  const snapshot = () => ({
    viewport: { width: innerWidth, height: innerHeight },
    documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    page: rect(byId("page-agent")), header: rect(document.querySelector(".agent-chat-header")),
    toolbar: rect(byId("agent-conversation-actions")), composer: rect(composer),
    messages: { ...rect(messages), clientHeight: messages.clientHeight, scrollHeight: messages.scrollHeight, scrollTop: messages.scrollTop },
  });

  fillMessages(true);
  const long = snapshot(); messages.scrollTop = messages.scrollHeight;
  const scrolled = snapshot();
  fillMessages(false);
  const short = snapshot();
  workspace.classList.add("history-collapsed"); fillMessages(true);
  const collapsed = snapshot();
  textarea.style.height = "180px";
  const expandedComposer = snapshot(); textarea.style.removeProperty("height");
  byId("agent-error").hidden = false; byId("agent-error").textContent = "保存失败，请重试。";
  byId("agent-save-actions").hidden = false; byId("agent-chat-retry").hidden = false;
  const recovery = snapshot();
  byId("agent-error").hidden = true; byId("agent-save-actions").hidden = true;

  workspace.classList.add("is-making"); making.hidden = false;
  byId("agent-conversation-actions").hidden = true;
  byId("agent-history-sidebar").hidden = true; byId("agent-conversation").hidden = true;
  for (let index = 0; index < 80; index++) {
    const paragraph = make("p", "muted-note", `研发阶段说明 ${index + 1}`);
    paragraph.style.marginBottom = "18px"; making.append(paragraph);
  }
  workspace.scrollTop = workspace.scrollHeight;
  const preparing = { viewport: { width: innerWidth, height: innerHeight },
    documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    page: rect(byId("page-agent")), header: rect(document.querySelector(".agent-chat-header")),
    workspace: { ...rect(workspace), clientHeight: workspace.clientHeight, scrollHeight: workspace.scrollHeight, scrollTop: workspace.scrollTop } };
  making.hidden = true; byId("agent-history-sidebar").hidden = false; byId("agent-conversation").hidden = false;
  byId("agent-conversation-actions").hidden = false;
  workspace.classList.remove("is-making"); workspace.scrollTop = 0;
  fillMessages(true); messages.scrollTop = messages.scrollHeight;
  return { long, scrolled, short, collapsed, expandedComposer, recovery, preparing };
}

export async function agentLayoutScript() {
  const [html, stylesheet] = await Promise.all(["index.html", "style.css"].map((file) =>
    readFile(new URL(`../../public/${file}`, import.meta.url), "utf8")));
  const markup = html.match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  const data = JSON.stringify({ markup, stylesheet }).replaceAll("<", "\\u003c");
  return `return (${inspectAgentLayout.toString()})(${data});`;
}

export function assertAgentLayout(facts) {
  const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1, `${label}: ${actual} vs ${expected}`);
  for (const name of ["long", "scrolled", "short", "collapsed", "expandedComposer", "recovery"]) {
    const sample = facts[name];
    close(sample.page.height, sample.viewport.height, `${name} 页面高度`);
    assert.ok(sample.documentHeight <= sample.viewport.height + 1, `${name} 整页不应滚动`);
    assert.ok(sample.composer.bottom <= sample.viewport.height + 1, `${name} 输入框不能被挤出视口`);
    assert.ok(sample.messages.clientHeight > 0, `${name} 消息区应有可用高度`);
    assert.ok(sample.toolbar.top >= sample.header.top && sample.toolbar.bottom <= sample.header.bottom, `${name} 对话操作应位于标题栏内`);
    close(sample.header.top, facts.long.header.top, `${name} 标题位置`);
    close(sample.toolbar.top, facts.long.toolbar.top, `${name} 工具栏位置`);
    close(sample.composer.bottom, facts.long.composer.bottom, `${name} 输入框底部位置`);
  }
  assert.ok(facts.long.messages.scrollHeight > facts.long.messages.clientHeight, "长回复必须在消息区内滚动");
  assert.ok(facts.scrolled.messages.scrollTop > 0, "消息区必须能实际滚动");
  assert.ok(facts.collapsed.messages.width > facts.long.messages.width, "折叠历史栏后对话应使用更多空间");
  assert.ok(facts.expandedComposer.composer.height > facts.collapsed.composer.height, "输入框变高时消息区应让出空间");
  close(facts.preparing.page.height, facts.preparing.viewport.height, "制作页高度");
  assert.ok(facts.preparing.documentHeight <= facts.preparing.viewport.height + 1, "制作内容不应撑开整页");
  assert.ok(facts.preparing.workspace.scrollHeight > facts.preparing.workspace.clientHeight, "制作内容应单独滚动");
  assert.ok(facts.preparing.workspace.scrollTop > 0, "制作内容必须能实际滚动");
  close(facts.preparing.header.top, facts.long.header.top, "制作状态标题位置");
}
