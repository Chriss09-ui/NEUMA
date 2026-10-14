import test from "node:test";
import assert from "node:assert/strict";
import { renderRichText, safeRichTextLink } from "../public/rich-text.js";
import { messageRow, renderMessages } from "../public/group-view.js";
import { descendants, formulas, richTextDocument, tagged } from "./helpers/rich-text-dom.mjs";

const message = (t, source) => { const node = richTextDocument(t).createElement("div"); renderRichText(node, source); return node; };

test("数学助手原回复展示加粗、列表与公式，而不是 Markdown 标记", (t) => {
  const node = message(t, "您好！我是**微积分可视化学习助手**。\n\n您可以这样开始：\n\n- **直接给出公式**，例如 `f(x)=x^2` 在 `[a,b]` 上的定积分、`f(x)=x^2` 在 `x=1` 处的导数；\n- **只说知识点**（极限 / 导数 / 定积分）；\n- **想换公式或换知识点**，随时告诉我。");
  assert.deepEqual(tagged(node, "strong").map((element) => element.textContent), ["微积分可视化学习助手", "直接给出公式", "只说知识点", "想换公式或换知识点"]);
  assert.equal(tagged(node, "ul").length, 1); assert.equal(tagged(node, "li").length, 3);
  assert.deepEqual(formulas(node), ["f(x)=x^2", "[a,b]", "f(x)=x^2", "x=1"]);
  assert.doesNotMatch(node.textContent, /\*\*|`/);
});

test("行内与独立公式支持四种分隔符并保留可访问的 MathML", (t) => {
  const node = message(t, "行内 $x^2$ 与 \\( \\frac{1}{2} \\)。\n\n$$\\int_0^1 x^2\\,dx$$\n\n\\[\\sqrt{x}\\]");
  assert.deepEqual(formulas(node), ["x^2", " \\frac{1}{2} ", "\\int_0^1 x^2\\,dx", "\\sqrt{x}"]);
  assert.equal(tagged(node, "math").length, 4);
  assert.equal(descendants(node).filter((element) => element.className.split(" ").includes("katex-display")).length, 2);
});

test("流式未闭合标记与错误公式保留原文，完成后解析且同源更新不重建", (t) => {
  const node = message(t, "未完成 **加粗 与 \\(x^2");
  assert.equal(node.textContent, "未完成 **加粗 与 \\(x^2");
  renderRichText(node, "完成 **加粗** 与 \\(x^2\\)");
  assert.equal(tagged(node, "strong")[0].textContent, "加粗"); assert.deepEqual(formulas(node), ["x^2"]);
  const replacements = node.replacements, first = node.children[0];
  renderRichText(node, "完成 **加粗** 与 \\(x^2\\)");
  assert.equal(node.replacements, replacements); assert.equal(node.children[0], first);
  renderRichText(node, "$\\frac{$"); assert.equal(node.textContent, "$\\frac{$");
  renderRichText(node, ""); assert.equal(node.children.length, 0);
});

test("代码块和普通代码保留原文，数学兼容转换只适用于狭窄表达式", (t) => {
  const node = message(t, "`npm install`、`x=1`、`[a,b]`、`a^2`、`src/app.js`、`x => x * 2`。\n\n```js\nconst x = '$x^2$';\n**literal**\n```\n\n函数 `f(x)=x^2` 与 `f(x)=alert(1)`、`f(x)=process.exit`。");
  assert.deepEqual(formulas(node), ["f(x)=x^2"]);
  assert.deepEqual(tagged(node, "code").map((element) => element.textContent), ["npm install", "x=1", "[a,b]", "a^2", "src/app.js", "x => x * 2", "const x = '$x^2$';\n**literal**", "f(x)=alert(1)", "f(x)=process.exit"]);
  const mathNode = message(t, "导数：`x=1`、`[a,b]` 与 `x^2`；运行 `npm install`。");
  assert.deepEqual(formulas(mathNode), ["x=1", "[a,b]", "x^2"]);
  assert.equal(tagged(mathNode, "code")[0].textContent, "npm install");
});

test("原始 HTML、图片和脚本作为文本呈现，不创建执行或外联节点", (t) => {
  const raw = '<script>alert(1)</script>\n<img src="https://evil.example/pixel" onerror="alert(1)">';
  const node = message(t, `${raw}\n\n![图表](https://evil.example/image.svg)\n\n<span onclick="alert(2)">普通内容</span>`);
  assert.match(node.textContent, /<script>alert\(1\)<\/script>/); assert.match(node.textContent, /图表/);
  for (const tag of ["script", "img", "iframe", "object", "link", "style", "input"]) assert.equal(tagged(node, tag).length, 0);
  assert.equal(descendants(node).some((element) => [...element.attributes.keys()].some((key) => /^on/i.test(key))), false);
});

test("链接仅接受网络、邮件和真实 NEUMA 路由，拒绝脚本和相对文件", (t) => {
  const node = message(t, "[官方](https://example.com/a?x=1&amp;y=2) [邮件](mailto:user@example.com) [助手](#agent/one) [项目](#projects/list) [脚本](javascript:alert(1)) [数据](data:text/html,evil) [协议](//evil.example) [文件](./notes.md) [假路由](#anything)");
  assert.deepEqual(tagged(node, "a").map((element) => element.getAttribute("href")), ["https://example.com/a?x=1&y=2", "mailto:user@example.com", "#agent/one", "#projects/list"]);
  assert.equal(tagged(node, "a")[0].getAttribute("rel"), "noopener noreferrer");
  assert.match(node.textContent, /脚本.*数据.*协议.*文件.*假路由/);
  for (const value of ["java\nscript:alert(1)", "https://example.com\\@evil.example", "https://example.com\u0000", "file:///tmp/a", "#group/one/two", "#agent/one?evil=1"]) assert.equal(safeRichTextLink(value), null);
});

test("公式禁止可信 HTML/外链扩展，宏定义不会污染后续公式", (t) => {
  const node = message(t, "$\\href{javascript:alert(1)}{click}$ $\\includegraphics{https://evil.example/image.png}$ $\\htmlClass{evil}{x}$\n\n$\\gdef\\foo{x}\\foo$ $\\foo$");
  for (const tag of ["a", "img", "script"]) assert.equal(tagged(node, tag).length, 0);
  assert.equal(descendants(node).some((element) => element.className.split(" ").includes("evil")), false);
  assert.match(node.textContent, /\$\\foo\$/);
});

test("标题、引用、嵌套列表、表格与任务清单使用可读的语义节点", (t) => {
  const node = message(t, "# 总结\n\n> *说明* 与 ~~旧结论~~\n\n3. 步骤\n   - 子步骤\n\n- [x] 完成\n- [ ] 待办\n\n| 公式 | 结果 |\n|:---|---:|\n| $x^2$ | 4 |\n\n---\n\n第一行\n第二行 &amp; &#x3c;安全&#62;");
  assert.equal(tagged(node, "h1").length, 0); assert.equal(tagged(node, "h2")[0].textContent, "总结");
  assert.equal(tagged(node, "blockquote").length, 1); assert.equal(tagged(node, "em")[0].textContent, "说明");
  assert.equal(tagged(node, "del")[0].textContent, "旧结论"); assert.equal(tagged(node, "ol")[0].getAttribute("start"), "3");
  assert.equal(tagged(node, "table").length, 1); assert.equal(tagged(node, "th")[0].getAttribute("scope"), "col");
  assert.equal(tagged(node, "td")[1].style.textAlign, "right"); assert.deepEqual(formulas(node), ["x^2"]);
  assert.match(node.textContent, /☑ 完成☐ 待办/); assert.match(node.textContent, /& <安全>/);
  assert.equal(tagged(node, "hr").length, 1); assert.equal(tagged(node, "br").length, 1);
});

test("群聊定向提及内联于首段，保留真实富文本且刷新不重复或改写原消息", (t) => {
  const document = richTextDocument(t), target = document.createElement("div");
  const writer = { id: "writer", name: "写作助手", profile: { icon: "star:1:1" } };
  const reviewer = { id: "reviewer", name: "检查助手", profile: { icon: "star:2:3" } };
  const messages = [
    { id: "first", sender: { type: "agent", id: writer.id, name: writer.name }, recipientId: reviewer.id,
      content: "请检查**计算结果**：$x^2$，依据[说明](https://example.com/guide)。\n\n- **条件** $x>0$\n- 保留第二项", status: "complete" },
    { id: "second", sender: { type: "agent", id: reviewer.id, name: reviewer.name }, recipientId: writer.id,
      content: "**已检查**，公式 $x^2$ 保持一致。", status: "complete" },
  ];
  const original = structuredClone(messages);
  for (let refresh = 0; refresh < 2; refresh++) {
    renderMessages(target, messages, "", [writer, reviewer]);
    const rows = tagged(target, "article"); assert.equal(rows.length, 2);
    for (const [index, row] of rows.entries()) {
      const body = descendants(row).find((element) => element.classList.contains("bubble"));
      const mentions = descendants(body).filter((element) => element.classList.contains("group-message-mention"));
      assert.equal(mentions.length, 1);
      assert.equal(body.firstElementChild.tagName, "P");
      assert.equal(body.firstElementChild.children[0], mentions[0]);
      assert.equal(mentions[0].getAttribute("aria-label"), `@${index ? writer.name : reviewer.name}`);
      assert.equal(descendants(mentions[0]).filter((element) => element.classList.contains("group-mention-avatar")).length, 1);
      assert.equal(tagged(body, "math").length, index ? 1 : 2);
      assert.deepEqual(formulas(body), index ? ["x^2"] : ["x^2", "x>0"]);
      assert.deepEqual(tagged(body, "strong").map((element) => element.textContent), index ? ["已检查"] : ["计算结果", "条件"]);
      if (!index) {
        assert.equal(tagged(body, "ul").length, 1); assert.equal(tagged(body, "li").length, 2);
        assert.equal(tagged(body, "a")[0].getAttribute("href"), "https://example.com/guide");
        assert.equal(tagged(body, "a")[0].textContent, "说明");
      }
    }
    assert.deepEqual(messages, original);
  }
});

test("群聊首块为列表或标题时另起提及段，保持原块语义与富文本结构", (t) => {
  richTextDocument(t);
  const senderAgent = { id: "writer", name: "写作助手" }, recipientAgent = { id: "reviewer", name: "检查助手" };
  for (const [content, block, text] of [
    ["- **第一项** $x^2$\n- [依据](https://example.com/guide)", "UL", "第一项"],
    ["# **检查结论**\n\n说明 $x^2$。", "H2", "检查结论"],
  ]) {
    const source = { id: block, sender: { type: "agent", id: senderAgent.id }, recipientId: recipientAgent.id, content };
    const row = messageRow(source, { bubble: true, senderAgent, recipientAgent });
    const body = descendants(row).find((element) => element.classList.contains("bubble"));
    assert.equal(body.children[0].tagName, "P");
    assert.equal(body.children[1].tagName, block);
    assert.equal(descendants(body.children[0]).filter((element) => element.classList.contains("group-message-mention")).length, 1);
    assert.equal(tagged(body.children[1], "strong")[0].textContent, text);
    assert.deepEqual(formulas(body), ["x^2"]);
    if (block === "UL") {
      assert.equal(tagged(body.children[1], "li").length, 2);
      assert.equal(tagged(body.children[1], "a")[0].getAttribute("href"), "https://example.com/guide");
    }
    assert.equal(source.content, content);
  }
});
