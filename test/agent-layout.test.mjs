import test from "node:test";
import { agentLayoutScript, assertAgentLayout } from "./helpers/agent-layout.mjs";
import { browserResult, testBrowser } from "./helpers/browser.mjs";

test("桌面长对话只滚动消息，顶部与输入框固定，折叠历史和制作态保持高度约束", { timeout: 20_000 }, async (t) => {
  const browser = await testBrowser(t);
  if (!browser) return;
  assertAgentLayout(await browserResult(t, browser, await agentLayoutScript(), { windowSize: { width: 1280, height: 720 } }));
});
