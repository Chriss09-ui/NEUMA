import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server.mjs";
import { fixturePort } from "./http-model.mjs";

// Manual desktop acceptance uses only synthetic data and a local model fixture.
const root = await mkdtemp(join(tmpdir(), "neuma-reliability-preview-"));
let requests = 0;
const model = createServer(async (request, response) => {
  for await (const _ of request) {} requests++;
  response.writeHead(200, { "content-type": "text/event-stream" });
  let index = 0;
  const tokens = ["这是一条合成的恢复测试。", ...Array.from({ length: 30 }, (_, i) => `已处理第 ${i + 1} 项。`), "任务已经完成，刷新后仍能看到完整结果。"];
  const timer = setInterval(() => {
    response.write(`data: ${JSON.stringify({ id: "synthetic", choices: [{ index: 0, delta: { role: "assistant", content: tokens[index++] ?? "" }, finish_reason: index >= tokens.length ? "stop" : null }] })}\n\n`);
    if (index >= tokens.length) { clearInterval(timer); response.end("data: [DONE]\n\n"); }
  }, 700);
  response.once("close", () => clearInterval(timer));
});
model.listen(0, "127.0.0.1"); await once(model, "listening");
const app = createApp({ cwd: root, dataDir: root, envPath: join(root, "fixture-settings"),
  config: { llmConfigured: true, model: "synthetic", modelAuthType: "none", chatUrl: `http://127.0.0.1:${fixturePort(model)}/v1/chat/completions` }, providers: {} });
app.listen(0, "127.0.0.1"); await once(app, "listening");
process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${fixturePort(app)}`, syntheticData: root }) + "\n");
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await app.dispose(); app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve()));
  model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
  await rm(root, { recursive: true, force: true }); process.stdout.write(JSON.stringify({ modelRequests: requests, cleaned: true }) + "\n");
}
process.once("SIGTERM", () => void close()); process.once("SIGINT", () => void close());
