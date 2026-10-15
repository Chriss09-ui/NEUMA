import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputError } from "../src/requirements/core.mjs";
import { DevelopmentExecutor } from "../src/development/development-executor.mjs";
import { inspectDevelopmentCode } from "../src/development/development-workspace.mjs";
import { validateApplicationManifest, bindApplicationManifest, validateActionInput } from "../src/applications/application-contract.mjs";
import { validatePlan } from "../src/development/development-contract.mjs";
import { validateDesign, checkDesign, supportedArchitectureVersion, designHash } from "../src/architecture/architecture-contract.mjs";
import { developmentArchitecture, developmentPlan } from "./helpers/development.mjs";

const objectSchema = (properties = {}) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const manifest = () => ({ protocolVersion: 2, runtime: "node-action", entrypoint: "actions.mjs", page: null,
  actions: [{ id: "analyze", title: "分析链接", inputSchema: objectSchema({ url: { type: "string" } }),
    outputSchema: objectSchema({ text: { type: "string" } }), connectionIds: [] }], stateVersion: 1, evidenceIds: [] });
async function fixture(t, source, { page = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuma-action-test-")));
  const codeDir = join(root, "code"); await mkdir(codeDir);
  await writeFile(join(codeDir, "actions.mjs"), source);
  if (page) await writeFile(join(codeDir, "index.html"), '<!doctype html><title>Tool</title><button>Analyze</button>');
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await inspectDevelopmentCode(codeDir);
  return { root, codeDir, snapshot, entrypoint: "actions.mjs" };
}
async function native(t) {
  const executor = new DevelopmentExecutor();
  const probe = await executor.probe();
  if (!probe.available) {
    if (process.env.NEUMA_REQUIRE_ISOLATION === "1") assert.fail(probe.reason);
    t.skip(`当前宿主隔离不可用：${probe.reason}`); return null;
  }
  return executor;
}

test("v2 manifest binds resource bytes and evidence; action input rejects extra identities", async (t) => {
  const input = await fixture(t, "export const actions={}", { page: true });
  const plan = { ...manifest(), page: { entrypoint: "index.html", resources: [{ path: "index.html", sha256: "" }] } };
  const delivered = bindApplicationManifest(plan, input.snapshot, ["verification_1"]);
  assert.equal(delivered.page.resources[0].sha256, input.snapshot.files.find((item) => item.path === "index.html").hash);
  assert.deepEqual(validateApplicationManifest(delivered, { snapshot: input.snapshot }), delivered);
  assert.throws(() => validateApplicationManifest(plan), /摘要/);
  assert.throws(() => validateApplicationManifest({ ...delivered, page: { ...delivered.page, resources: [{ path: "../private.html", sha256: "a".repeat(64) }] } }), /路径/);
  assert.throws(() => validateApplicationManifest({ ...delivered, evidenceIds: [] }), /证据/);
  assert.throws(() => validateActionInput(plan.actions[0], { url: "https://example.com", agentId: "victim" }), /字段/);
});

test("page-only delivery retains an empty backend module without inventing public actions", async (t) => {
  const input = await fixture(t, "export const actions={};", { page: true });
  const source = { ...manifest(), actions: [], page: { entrypoint: "index.html", resources: [{ path: "index.html", sha256: "" }] } };
  const delivered = bindApplicationManifest(source, input.snapshot, ["page_checks"]);
  assert.deepEqual(validateApplicationManifest(delivered, { snapshot: input.snapshot }).actions, []);
  assert.throws(() => validateApplicationManifest({ ...delivered, page: null }, { snapshot: input.snapshot }), /动作清单/);
  assert.throws(() => bindApplicationManifest({ ...source, entrypoint: "missing.mjs" }, input.snapshot, ["page_checks"]), /入口不在/);
});

test("v2 architecture separates interaction from complexity and retains exact v1 validation", () => {
  const architecture = developmentArchitecture();
  const design = { ...architecture.design, schemaVersion: 2, profile: "light",
    state: { mode: "none", reason: "无业务状态" }, interaction: { defaultEntry: "application", page: true, operations: true,
      inputs: "网页链接", results: "正文", persistentData: "保存草稿" }, connections: [] };
  assert.deepEqual(validateDesign(design, { requirements: architecture.requirements }), design);
  assert.equal(checkDesign(design, { requirements: architecture.requirements }).runnable, false);
  assert.equal(checkDesign(design, { requirements: architecture.requirements }).issues.some((item) => item.blocking), false);
  assert.equal(supportedArchitectureVersion({ contractVersion: 2, design }), true);
  assert.equal(supportedArchitectureVersion({ contractVersion: 1, design }), false);
  const unversioned = { ...design }; delete unversioned.schemaVersion;
  assert.throws(() => validateDesign(unversioned, { requirements: architecture.requirements }), /不受支持/);
});

test("v2 plan freezes action identities, inputs and capability mocks across revisions", () => {
  const architecture = developmentArchitecture();
  const legacy = developmentPlan(architecture);
  const plan = { ...legacy, schemaVersion: 2, runtime: "node-action", entrypoint: "actions.mjs", application: manifest(),
    tasks: legacy.tasks.map((task) => ({ ...task, files: [...task.files, "actions.mjs"] })),
    cases: legacy.cases.map((item) => ({ ...item, actionId: "analyze", input: '{"url":"https://example.com"}', mocks: [], assertions: [{ path: "text", expectedJson: '"正文"' }] })) };
  assert.equal(validatePlan(plan, { architecture }).schemaVersion, 2);
  const changed = structuredClone(plan); changed.cases[0].mocks.push({ capability: "web.fetch", argsJson: "{}", resultJson: "{}" });
  assert.throws(() => validatePlan(changed, { architecture, previousPlan: plan }), /不能删除或替换/);
  assert.throws(() => validatePlan({ ...legacy, runtime: "node-action" }, { architecture }), /取值无效/);
});

test("native node-action exchanges two capability replies and progress while direct network remains denied", async (t) => {
  const executor = await native(t); if (!executor) return;
  const input = await fixture(t, `import net from 'node:net';
export const actions={async analyze(input,ctx){
 const denied=await new Promise(resolve=>{const server=net.createServer();server.once('error',e=>resolve(['EPERM','EACCES'].includes(e.code)));server.listen(0,'127.0.0.1',()=>server.close(()=>resolve(false)))});
 const web=await ctx.web.fetch({url:input.url});ctx.progress({message:'读取完毕',percent:50});
 const model=await ctx.model.call({prompt:web.text});return {text:model.text,denied};}};`);
  const seen = [], progress = [];
  const result = await executor.runAction({ ...input, actionId: "analyze", input: { url: "https://example.com" },
    onCapability: async ({ capability, args }) => { seen.push({ capability, args }); return { text: capability === "web.fetch" ? "正文" : "分析结果" }; },
    onProgress: async (value) => { progress.push(value); } });
  assert.equal(result.status, "passed", JSON.stringify(result)); assert.deepEqual(result.output, { text: "分析结果", denied: true });
  assert.deepEqual(seen.map((item) => item.capability), ["web.fetch", "model.call"]); assert.equal(progress[0].percent, 50);
});

test("native cancellation aborts outstanding host calls and cannot produce a late success", async (t) => {
  const executor = await native(t); if (!executor) return;
  const input = await fixture(t, "export const actions={async analyze(input,ctx){await ctx.web.fetch({url:input.url});return {text:'late'}}}");
  const controller = new AbortController(); let aborted = false, called;
  const entered = new Promise((resolve) => { called = resolve; });
  const running = executor.runAction({ ...input, actionId: "analyze", input: { url: "https://example.com" }, signal: controller.signal,
    onCapability: ({ signal }) => new Promise((resolve) => { called(); signal.addEventListener("abort", () => { aborted = true; resolve({ text: "late" }); }, { once: true }); }) });
  await entered; controller.abort(); const result = await running;
  assert.equal(result.status, "error"); assert.equal(result.reason, "cancelled"); assert.equal(aborted, true); assert.equal(result.output, undefined);
});

test("native channel refuses forged identity, oversized messages and unfinished calls", async (t) => {
  const executor = await native(t); if (!executor) return;
  for (const [source, reason] of [
    ['process.stdout.write(JSON.stringify({type:"call",id:"call_1",capability:"web.fetch",args:{},agentId:"victim"})+"\\n");await new Promise(()=>{});', "invalid_action_channel"],
    ['process.stdout.write("x".repeat(1100000));await new Promise(()=>{});', "output_limit"],
  ]) {
    const input = await fixture(t, `export const actions={async analyze(){${source}}}`);
    const result = await executor.runAction({ ...input, actionId: "analyze", input: {} });
    assert.equal(result.status, "error"); assert.equal(result.reason, reason);
  }
});

test("native verification records mocks honestly and rejects unused mock evidence", async (t) => {
  const executor = await native(t); if (!executor) return;
  const input = await fixture(t, "export const actions={async analyze(input,ctx){return ctx.web.fetch({url:input.url})}}");
  const cases = [{ id: "fetch", taskId: "task", acceptanceId: "success", actionId: "analyze", input: '{"url":"https://example.com"}',
    mocks: [{ capability: "web.fetch", argsJson: '{"url":"https://example.com"}', resultJson: '{"text":"模拟正文"}' }],
    assertions: [{ path: "text", expectedJson: '"模拟正文"' }] }];
  const report = await executor.verify({ ...input, runtime: "node-action", application: manifest(), cases });
  assert.equal(report.status, "passed", JSON.stringify(report)); assert.equal(report.evidenceMode, "mock_capabilities");
  assert.equal(report.connectionVerified, false); assert.equal(report.results[0].mockCalls.length, 1);
  cases[0].mocks.push({ capability: "model.call", argsJson: "{}", resultJson: "{}" });
  const rejected = await executor.verify({ ...input, runtime: "node-action", application: manifest(), cases });
  assert.equal(rejected.status, "failed"); assert.equal(rejected.results[0].reason, "unused_capability_mocks");
});


test("native capability errors retain safe service reasons and suppress raw provider details", async (t) => {
  const executor = await native(t); if (!executor) return;
  const input = await fixture(t, "export const actions={async analyze(input,ctx){try{await ctx.web.fetch({url:input.url})}catch(error){return {message:error.message,reason:error.reason}}}}");
  const safe = await executor.runAction({ ...input, actionId: "analyze", input: { url: "https://example.com" },
    onCapability: async () => { throw Object.assign(new InputError("免费搜索达到调用限额，请稍后重试"), { reason: "rate_limited" }); } });
  assert.equal(safe.status, "passed"); assert.equal(safe.output.reason, "rate_limited"); assert.match(safe.output.message, /调用限额/);
  const raw = await executor.runAction({ ...input, actionId: "analyze", input: { url: "https://example.com" },
    onCapability: async () => { throw new Error("fixture-private-provider-detail"); } });
  assert.equal(raw.status, "passed"); assert.equal(raw.output.reason, "capability_failed"); assert.doesNotMatch(JSON.stringify(raw), /fixture-private-provider-detail/);
});

test("native action timeout aborts its outstanding host capability within the same deadline", async (t) => {
  const executor = await native(t); if (!executor) return;
  const input = await fixture(t, "export const actions={async analyze(input,ctx){return ctx.web.fetch({url:input.url})}}");
  let aborted = false;
  const run = await executor.runAction({ ...input, actionId: "analyze", input: { url: "https://example.com" }, timeoutMs: 100,
    onCapability: ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve({}); }, { once: true })) });
  assert.equal(run.reason, "timeout"); assert.equal(aborted, true);
});


test("backend task verification permits future page files, while integration requires the complete resource set", async (t) => {
  const executor = await native(t); if (!executor) return;
  const input = await fixture(t, "export const actions={async analyze(){return {text:'backend ready'}}}");
  const application = { ...manifest(), page: { entrypoint: "index.html", resources: [{ path: "index.html", sha256: "" }] } };
  const cases = [{ id: "backend", actionId: "analyze", input: '{"url":"https://example.com"}', mocks: [], assertions: [{ path: "text", expectedJson: '\"backend ready\"' }] }];
  const partial = await executor.verify({ ...input, runtime: "node-action", application, cases, validateResources: false });
  assert.equal(partial.status, "passed", JSON.stringify(partial)); assert.equal(partial.pageResourcesChecked, false);
  const integration = await executor.verify({ ...input, runtime: "node-action", application, cases });
  assert.equal(integration.status, "failed"); assert.match(integration.summary, /清单/);
});
