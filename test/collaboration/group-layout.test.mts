import test from "node:test";
import { groupLayoutScript, assertGroupLayout } from "../helpers/group-layout.mjs";
import { browserResult, testBrowser } from "../helpers/browser.mjs";

test("桌面群组保留聊天空间，Agent头像与行内提及在长内容下对齐且独立滚动", { timeout: 40_000 }, async (t) => {
  const browser = await testBrowser(t);
  if (!browser) return;
  for (const windowSize of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }]) {
    assertGroupLayout(await browserResult(t, browser, await groupLayoutScript(), { windowSize }));
  }
});
