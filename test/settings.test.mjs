import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
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

test("同一配置文件并发保存合并不同字段，同字段按调用顺序生效", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "neuma-settings-concurrent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envPath = join(dir, "fixture-config.txt");
  await writeFile(envPath, "# 保留注释\nNEUMA_LLM_MODEL=old-model\nTYPESAFE_MODEL=old-judge\nPORT=3000\n");
  const results = await Promise.allSettled([
    writeEnvFile(envPath, { NEUMA_LLM_MODEL: "first-model" }),
    writeEnvFile(join(dir, ".", "fixture-config.txt"), { TYPESAFE_MODEL: "new-judge" }),
    writeEnvFile(envPath, { NEUMA_LLM_MODEL: "last-model" }),
  ]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled", "fulfilled"]);
  const content = await readFile(envPath, "utf8");
  assert.equal(parseEnv(content).NEUMA_LLM_MODEL, "last-model");
  assert.equal(parseEnv(content).TYPESAFE_MODEL, "new-judge");
  assert.equal(parseEnv(content).PORT, "3000");
  assert.match(content, /^# 保留注释$/m);
  assert.deepEqual(await readdir(dir), ["fixture-config.txt"]);
});

test("更新重复配置项后重新解析仍使用新值，清除不会留下旧值", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "neuma-settings-duplicates-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envPath = join(dir, "fixture-config.txt");
  await writeFile(envPath, "# 保留注释\nNEUMA_LLM_MODEL=first-model\nexport NEUMA_LLM_MODEL = stale-model\nTYPESAFE_MODEL=first-judge\n  TYPESAFE_MODEL=stale-judge\nPORT=3000\n");
  await writeEnvFile(envPath, { NEUMA_LLM_MODEL: "updated-model", TYPESAFE_MODEL: "" });
  const content = await readFile(envPath, "utf8");
  assert.equal(parseEnv(content).NEUMA_LLM_MODEL, "updated-model");
  assert.equal(parseEnv(content).TYPESAFE_MODEL, "");
  assert.equal(content.match(/^NEUMA_LLM_MODEL=/gm)?.length, 1);
  assert.equal(content.match(/^TYPESAFE_MODEL=/gm)?.length, 1);
  assert.match(content, /^# 保留注释$/m);
  assert.match(content, /^PORT=3000$/m);
});

test("三种引号的非目标多行值完整保留，正文中的配置名不算顶层重复项", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "neuma-settings-multiline-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envPath = join(dir, "fixture-config.txt");
  for (const quote of ["\"", "'", "`"]) {
    const preserved = `# 注释中的 ${quote} 不开启引用\nlowercase_notes.with-dash=${quote}first\nNEUMA_LLM_MODEL=inside-value\nTYPESAFE_MODEL=inside-judge\nlast${quote} # 注释中的 ${quote} 不继续引用\n`;
    const original = `${preserved}NEUMA_LLM_MODEL=old-model\nTYPESAFE_MODEL=old-judge\nPORT=3000\n`;
    const before = parseEnv(original);
    assert.equal(before.NEUMA_LLM_MODEL, "old-model");
    assert.equal(before["lowercase_notes.with-dash"], "first\nNEUMA_LLM_MODEL=inside-value\nTYPESAFE_MODEL=inside-judge\nlast");
    await writeFile(envPath, original);
    await writeEnvFile(envPath, { NEUMA_LLM_MODEL: "new-model", TYPESAFE_MODEL: "" });
    const content = await readFile(envPath, "utf8"), after = parseEnv(content);
    assert.ok(content.startsWith(preserved));
    assert.equal(after["lowercase_notes.with-dash"], before["lowercase_notes.with-dash"]);
    assert.equal(after.NEUMA_LLM_MODEL, "new-model");
    assert.equal(after.TYPESAFE_MODEL, "");
    assert.equal(after.PORT, "3000");
  }
});

test("替换目标多行值移除整个旧正文，顶层重复赋值合并且保留注释", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "neuma-settings-target-multiline-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envPath = join(dir, "fixture-config.txt");
  for (const quote of ["\"", "'", "`"]) {
    const original = `# 保留头部注释\nexport NEUMA_LLM_MODEL=${quote}first\nEMBEDDED_ONLY=must-disappear\nNEUMA_LLM_MODEL=inside-value\nlast${quote} # 保留目标注释\nNEUMA_LLM_MODEL=duplicate-model # 保留重复项注释\nTYPESAFE_MODEL=actual-judge\n`;
    assert.equal(parseEnv(original).NEUMA_LLM_MODEL, "duplicate-model");
    assert.equal(parseEnv(original).EMBEDDED_ONLY, undefined);
    await writeFile(envPath, original);
    await writeEnvFile(envPath, { NEUMA_LLM_MODEL: "new-model" });
    const content = await readFile(envPath, "utf8"), parsed = parseEnv(content);
    assert.equal(parsed.NEUMA_LLM_MODEL, "new-model");
    assert.equal(parsed.TYPESAFE_MODEL, "actual-judge");
    assert.equal(parsed.EMBEDDED_ONLY, undefined);
    assert.doesNotMatch(content, /inside-value|must-disappear|duplicate-model/);
    assert.equal(content.match(/^NEUMA_LLM_MODEL=/gm)?.length, 1);
    for (const note of ["保留头部注释", "保留目标注释", "保留重复项注释"]) assert.ok(content.includes(note));
  }
});

test("未关闭引用按原生解析保留单行字面值，注释里的引用不吞掉后续变量", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "neuma-settings-unclosed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envPath = join(dir, "fixture-config.txt");
  for (const quote of ["\"", "'", "`"]) {
    const preserved = `notes=${quote}unterminated\n`;
    const original = `${preserved}NEUMA_LLM_MODEL=old-model\nTYPESAFE_MODEL=old-judge\n`;
    const before = parseEnv(original);
    assert.equal(before.notes, `${quote}unterminated`);
    assert.equal(before.NEUMA_LLM_MODEL, "old-model");
    await writeFile(envPath, original);
    await writeEnvFile(envPath, { NEUMA_LLM_MODEL: "new-model" });
    const content = await readFile(envPath, "utf8");
    assert.ok(content.startsWith(preserved));
    assert.equal(parseEnv(content).notes, before.notes);
    assert.equal(parseEnv(content).NEUMA_LLM_MODEL, "new-model");
    assert.equal(parseEnv(content).TYPESAFE_MODEL, "old-judge");
  }
  const comments = '# NEUMA_LLM_MODEL="comment-only\nnotes="single-line" # "comment-only\n';
  await writeFile(envPath, `${comments}NEUMA_LLM_MODEL=old-model\n`);
  await writeEnvFile(envPath, { NEUMA_LLM_MODEL: "new-model" });
  const content = await readFile(envPath, "utf8");
  assert.ok(content.startsWith(comments));
  assert.equal(parseEnv(content).NEUMA_LLM_MODEL, "new-model");
});

test("非目标字段保留原来的换行和末尾文本，双引号中的反斜杠不改变结束位置", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "neuma-settings-format-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envPath = join(dir, "fixture-config.txt");
  const preserved = 'notes="first\\" ignored-text\r\n# 原有注释\r\n';
  const original = `${preserved}NEUMA_LLM_MODEL=old-model\r\nPORT=3000`;
  assert.equal(parseEnv(original).notes, "first\\");
  await writeFile(envPath, original);
  await writeEnvFile(envPath, { NEUMA_LLM_MODEL: "new-model" });
  const content = await readFile(envPath, "utf8");
  assert.equal(content, `${preserved}NEUMA_LLM_MODEL=new-model\r\nPORT=3000`);
  assert.equal(parseEnv(content).NEUMA_LLM_MODEL, "new-model");
});

test("配置写入失败后可以重试，失败不改变运行配置或关闭会话", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "neuma-settings-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envPath = join(dir, "missing", "fixture-config.txt");
  const config = getProviderConfig({ NEUMA_LLM_MODEL: "old-model" });
  let disposed = 0;
  const handler = createRequestHandler({ config, envPath, projects: {},
    projectAgent: { dispose: async () => { disposed++; } }, prototypeAgents: { close: async () => {} } });
  const failed = await invoke(handler, "POST", "/api/settings", { model: "new-model" });
  assert.equal(failed.status, 400);
  assert.equal(config.model, "old-model");
  assert.equal(disposed, 0);
  await mkdir(join(dir, "missing"));
  const saved = await invoke(handler, "POST", "/api/settings", { model: "new-model" });
  assert.equal(saved.status, 200);
  assert.equal(config.model, "new-model");
  assert.equal(disposed, 1);
  assert.equal(parseEnv(await readFile(envPath, "utf8")).NEUMA_LLM_MODEL, "new-model");
});

test("并发设置请求按顺序切换运行配置和会话，每次响应对应本次保存", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "neuma-settings-api-concurrent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envPath = join(dir, "fixture-config.txt");
  const config = getProviderConfig({ NEUMA_LLM_MODEL: "old-model", TYPESAFE_MODEL: "old-judge" });
  const switched = [];
  const handler = createRequestHandler({ config, envPath, projects: {},
    projectAgent: { dispose: async () => { switched.push(config.model); } }, prototypeAgents: { close: async () => {} } });
  const [first, second, third] = await Promise.all([
    invoke(handler, "POST", "/api/settings", { model: "first-model" }),
    invoke(handler, "POST", "/api/settings", { jevModel: "new-judge" }),
    invoke(handler, "POST", "/api/settings", { model: "last-model" }),
  ]);
  assert.deepEqual([first.status, second.status, third.status], [200, 200, 200]);
  assert.equal(first.body.model, "first-model");
  assert.equal(first.body.jevModel, "old-judge");
  assert.equal(second.body.model, "first-model");
  assert.equal(second.body.jevModel, "new-judge");
  assert.equal(third.body.model, "last-model");
  assert.deepEqual(switched, ["first-model", "first-model", "last-model"]);
  const persisted = parseEnv(await readFile(envPath, "utf8"));
  assert.equal(persisted.NEUMA_LLM_MODEL, config.model);
  assert.equal(persisted.TYPESAFE_MODEL, config.jevModel);
});
