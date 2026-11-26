import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequestHandler } from "../../src/server.mjs";
import { browserPageResult, testBrowser } from "../helpers/browser.mjs";
import { listeningAddress } from "../helpers/m7-test-boundaries.mjs";

function measureReplies(createReplyView: typeof import("../../public/chat-ui.js").createReplyView) {
  const reply = createReplyView("NEUMA");
  document.body.append(reply.row);
  const bubble = reply.row.querySelector<HTMLElement>(".bubble")!;
  bubble.style.width = "8em";
  return ["刚开始", "这一行恰好有八字", "这一行恰好有八字再换行", "第一段\n\n> - **嵌套列表**",
    "~~~js\nconst n = 1", "| 名称 | 数量 |\n| --- | --- |\n| 苹果 |"].map(content => {
    reply.update({ content, status: "writing" });
    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
    let last: Text | undefined;
    while (walker.nextNode()) if (walker.currentNode.textContent?.trim()) last = walker.currentNode as Text;
    const range = document.createRange();
    range.setStart(last!, last!.length - 1);
    range.setEnd(last!, last!.length);
    const glyph = range.getBoundingClientRect();
    const cursor = bubble.querySelector(".streaming-cursor");
    const bar = cursor?.getBoundingClientRect();
    const height = bubble.offsetHeight;
    reply.update({ content, status: "complete" });
    return { content, extraHeight: height - bubble.offsetHeight,
      beside: Boolean(bar && bar.width > 0 && bar.left >= glyph.right - 1 && bar.left <= glyph.right + 10
        && bar.top < glyph.bottom && bar.bottom > glyph.top),
      hidden: !cursor?.getClientRects().length };
  });
}

test("逐段输出时光标紧跟末字，写满一行也不额外换行，回复结束时消失", async (t) => {
  const browser = await testBrowser(t);
  if (!browser) return;
  const head = (await readFile(new URL("../../public/index.html", import.meta.url), "utf8")).split("<body>")[0];
  const page = `${head}<body><pre id="test-result"></pre><script type="module">
    import { createReplyView } from "/chat-ui.js";
    const write = value => document.querySelector("#test-result").textContent =
      btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
    try {
      write({ ok: true, result: (${measureReplies})(createReplyView) });
    } catch (error) { write({ ok: false, error: String(error) }); }
  </script></body></html>`;
  const dataDir = await mkdtemp(join(tmpdir(), "neuma-cursor-"));
  const handle = createRequestHandler({ config: {}, providers: {}, projects: {}, projectAgent: {}, prototypeAgents: {}, skillManager: {}, dataDir });
  const server = createServer((req, res) => {
    if (req.url === "/cursor-test") res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    else void handle(req, res);
  });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await handle.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });
  await handle.ready;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const results = await browserPageResult(t, browser, `http://127.0.0.1:${listeningAddress(server).port}/cursor-test`);
  for (const { content, extraHeight, beside, hidden } of results) {
    assert.equal(extraHeight, 0, `光标不应在回复末尾另占一行：${content}`);
    assert.ok(beside, `光标应在末字右侧且同一行：${content}`);
    assert.ok(hidden, `完成后仍有光标：${content}`);
  }
});
