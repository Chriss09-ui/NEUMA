import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { browserPageResult, testBrowser } from "../helpers/browser.mjs";
import { listeningAddress } from "../helpers/m7-test-boundaries.mjs";

test("浏览器中填写流程文本并继续任务", async t => {
  const browser = await testBrowser(t); if (!browser) return;
  const page = `<!doctype html><meta charset="utf-8"><div id="panel"></div><pre id="test-result"></pre>
  <script type="module">
    import { createServiceView } from "/agent-services.js";
    const report = payload => document.querySelector("#test-result").textContent = btoa(JSON.stringify(payload));
    try {
      let submitted;
      const api = {
        services: async () => ({ workflowTasks: [{ id: "task", version: 3, status: "waiting_input",
          waiting: { stepId: "title", inputSchema: { type: "string" } } }], workers: [], history: [], gateway: {}, environment: {} }),
        resumeTask: async (_agent, _task, value) => { submitted = value; }
      };
      const container = document.querySelector("#panel");
      const view = createServiceView({ api, document, container });
      await view.show("one");
      const input = container.querySelector("textarea");
      if (!input?.getClientRects().length) throw new Error("Missing visible text field");
      input.value = "weekly";
      input.form.requestSubmit();
      await Promise.resolve();
      view.hide(); report({ ok: true, result: submitted });
    } catch (e) { report({ ok: false, error: String(e) }); }
  </script>`;
  const server = createServer(async (req, res) => {
    if (req.url === "/") return void res.writeHead(200, { "content-type": "text/html" }).end(page);
    if (!/^\/[\w-]+\.js$/.test(req.url ?? "")) return void res.writeHead(404).end();
    try {
      const script = await readFile(new URL("../../public" + req.url, import.meta.url));
      res.writeHead(200, { "content-type": "text/javascript" }).end(script);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  assert.equal(await browserPageResult(t, browser, `http://127.0.0.1:${listeningAddress(server).port}/`), "weekly");
});
