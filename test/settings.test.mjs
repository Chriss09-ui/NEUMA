import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestHandler } from "../server.mjs";
import { getProviderConfig } from "../providers.mjs";
import { settingsUpdates, writeEnvFile } from "../settings.mjs";

async function invoke(handler, method, url, body) {
  const input = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(input, { method, url, headers: body === undefined ? {} : { "content-type": "application/json" } });
  const result = { status: null, text: "" };
  await handler(input, { writeHead(status) { result.status = status; }, end(content) { result.text = content?.toString() ?? ""; } });
  return { status: result.status, body: JSON.parse(result.text) };
}

test("配置接口只返回脱敏信息，保存后写入 .env 并立即生效", async () => {
  const dir = await mkdtemp(join(tmpdir(), "neuma-settings-"));
  const envPath = join(dir, ".env");
  await writeFile(envPath, "# 注释保留\nNEUMA_LLM_MODEL=old-model\nPORT=3000\n");
  const config = getProviderConfig({ NEUMA_LLM_CHAT_URL: "https://api.example.com/v1/chat/completions", NEUMA_LLM_MODEL: "old-model" });
  let disposed = 0;
  const handler = createRequestHandler({ config, envPath, projects: { list: async () => [] },
    projectAgent: { dispose: async () => { disposed++; } } });

  const before = await invoke(handler, "GET", "/api/settings");
  assert.equal(before.body.llmConfigured, false);
  assert.deepEqual(before.body.apiKey, { set: false, hint: "" });

  const saved = await invoke(handler, "POST", "/api/settings",
    { model: "new-model", apiKey: "sk-test-secret-abcd", jevApiKey: "" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.llmConfigured, true);
  assert.deepEqual(saved.body.apiKey, { set: true, hint: "abcd" });
  assert.equal(JSON.stringify(saved.body).includes("sk-test-secret"), false);
  assert.equal(config.apiKey, "sk-test-secret-abcd");
  assert.equal(config.model, "new-model");
  assert.equal(disposed, 1);

  const file = await readFile(envPath, "utf8");
  assert.match(file, /^# 注释保留$/m);
  assert.match(file, /^NEUMA_LLM_MODEL=new-model$/m);
  assert.match(file, /^NEUMA_LLM_API_KEY=sk-test-secret-abcd$/m);
  assert.match(file, /^PORT=3000$/m);
  assert.equal(file.includes("TYPESAFE_API_KEY"), false);

  const cleared = await invoke(handler, "POST", "/api/settings", { clear: ["apiKey"] });
  assert.equal(cleared.body.llmConfigured, false);
});

test("配置校验拒绝会破坏 .env 的字符和无效地址", () => {
  assert.throws(() => settingsUpdates({ apiKey: "abc\nPORT=1" }));
  assert.throws(() => settingsUpdates({ apiKey: "a#b" }));
  assert.throws(() => settingsUpdates({ chatUrl: "https://api.example.com/v1" }));
  assert.throws(() => settingsUpdates({ model: "" }));
  assert.throws(() => settingsUpdates({ clear: ["chatUrl"] }));
  assert.throws(() => settingsUpdates({}));
  assert.deepEqual(settingsUpdates({ apiKey: "  ", model: "m-1" }), { NEUMA_LLM_MODEL: "m-1" });
});

test("写入 .env 时文件不存在则新建", async () => {
  const dir = await mkdtemp(join(tmpdir(), "neuma-settings-"));
  const envPath = join(dir, ".env");
  await writeEnvFile(envPath, { NEUMA_LLM_MODEL: "m" });
  assert.equal(await readFile(envPath, "utf8"), "NEUMA_LLM_MODEL=m\n");
});
