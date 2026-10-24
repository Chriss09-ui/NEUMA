import test from "node:test";
import { assertSidebarLayout, sidebarLayoutScript } from "./helpers/sidebar-layout.mjs";
import { browserResult, testBrowser } from "./helpers/browser.mjs";

test("侧栏 Agent 与群组独立滚动，短桌面、长主历史和键盘焦点仍可访问全部入口", { timeout: 40_000 }, async (t) => {
  const browser = await testBrowser(t);
  if (!browser) return;
  const script = await sidebarLayoutScript();
  for (const windowSize of [{ width: 1280, height: 900 }, { width: 1280, height: 720 }])
    assertSidebarLayout(await browserResult(t, browser, script, { windowSize }));
});
