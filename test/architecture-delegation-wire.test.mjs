import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";

const text = content => typeof content === "string" ? content : content.filter(item => item.type === "text").map(item => item.text).join("\n");

test("真实委派链的请求正文：新设计及顾问auto，技术修订及顾问均off且正式提交", { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "neuma-delegation-wire-")), requests = [], sessions = [];
  let designs = 0, reviews = 0;
  const model = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      const names = body.tools.map(tool => tool.function.name), payload = JSON.parse(text(body.messages.findLast(item => item.role === "user").content));
      const role = names.includes("submit_module_design") ? "specialist" : names.includes("submit_architecture_review") ? "reviewer" : "designer";
      requests.push({ body, role }); let name, args;
      if (role === "specialist") {
        name = "submit_module_design"; args = { proposal: "按固定输入输出保留原承诺。", interfaces: "沿用原字段。", tradeoffs: "不引入新依赖。", evidenceIds: [], unknowns: [] };
      } else if (role === "reviewer") {
        name = "submit_architecture_review"; args = passingReview(payload.candidateHash, payload.design, payload.priorFindings);
        if (++reviews === 1) {
          args.verdict = "revise"; args.checks.find(item => item.id === "verification").passed = false;
          args.issues = [{ id: "missing_record_detail", blocking: true, description: "缺少逐项标注缺失记录的说明。", remedy: "补充缺失记录逐项标注。" }];
        }
      } else {
        const delegated = body.messages.some(item => item.role === "tool" && String(text(item.content)).includes('"storedModules"'));
        if (!delegated) {
          name = "delegate_module"; args = { modules: [{ question: "核对缺失记录处理", boundary: "仅当前原需求", benefit: "复用已确认规则" }] };
        } else {
          name = "submit_architecture"; args = validDesign(payload.requirements);
          if (++designs === 2) args.instructions += " 逐项列出缺失的工作记录。";
        }
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "delegation-wire", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0,
        id: `wire_${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  await new Promise(done => model.listen(0, "127.0.0.1", done));
  const target = { chatUrl: `http://127.0.0.1:${model.address().port}/v1/chat/completions`, model: "generic-reasoning-fixture" };
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true, apiKey: "fixture-only", ...target,
    modelProfile: { schemaVersion: 1, target, api: "openai-completions", contextWindow: 262144, maxOutputTokens: 32768,
      reasoning: true, input: ["text"], compat: { maxTokensField: "max_completion_tokens", thinkingFormat: "zai", supportsReasoningEffort: true } } },
    cwd: root, dataDir: join(root, "data"), sessionFactory: async options => {
      const session = await createPiSession(options); sessions.push(session);
      session.setAutoRetryEnabled(false); session.setAutoCompactionEnabled(false); return session;
    } });
  await designer.ready;
  t.after(async () => { await designer.persistence; model.closeAllConnections(); await new Promise(done => model.close(done)); await rm(root, { recursive: true, force: true }); });
  const result = await designer.design({ id: "delegation_wire", name: "委派配置核验", fingerprint: "same-requirement", draft: validDraft() });
  assert.equal(result.status, "passed"); assert.equal(result.attempts.length, 2); assert.equal(result.modules.length, 2);
  assert.equal(requests.length, 8); assert.equal(sessions.length, 6);
  assert.deepEqual(requests.filter(item => item.role === "specialist").map(({ body }) => body.thinking.type), ["enabled", "disabled"]);
  assert.deepEqual(requests.filter(item => item.role === "designer").map(({ body }) => body.thinking.type), ["enabled", "enabled", "disabled", "disabled"]);
  assert.ok(requests.filter(item => item.role === "specialist").every(({ body }) => body.max_completion_tokens === 32768));
  assert.ok(requests.filter(item => item.role === "designer").every(({ body }) => body.max_completion_tokens === 32768));
  assert.ok(requests.filter(item => item.role === "reviewer").every(({ body }) => body.max_completion_tokens === 16384));
  assert.notEqual(result.attempts[0].candidateHash, result.attempts[1].candidateHash);
});
