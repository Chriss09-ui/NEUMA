import test from "node:test";
import { agentLayoutScript, assertAgentLayout } from "./helpers/agent-layout.mjs";
import { browserResult, testBrowser } from "./helpers/browser.mjs";

test("桌面透明胶囊与紧凑单行输入区保留消息空间，历史归入导航后设置与拖宽保持独立滚动", { timeout: 20_000 }, async (t) => {
  const browser = await testBrowser(t);
  if (!browser) return;
  assertAgentLayout(await browserResult(t, browser, await agentLayoutScript(), { windowSize: { width: 1280, height: 720 } }));
});
