import { objectFields } from "../../src/runtime/type-boundary.mjs";
import type { PiSessionOptions } from "../../src/runtime/pi-port.mjs";
import type { SessionMessage } from "../../src/runtime/pi-port.mjs";
import { fixtureTools } from "../helpers/m7-test-boundaries.mjs";
import { fixtureDeferred } from "../helpers/m7-test-boundaries.mjs";
import type { TestFailure } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../../src/architecture/architecture.mjs";
import { designHash } from "../../src/architecture/architecture-contract.mjs";
import { validDraft } from "../helpers/architecture.mjs";

const deferred = fixtureDeferred;
const assignments = [
  { question: "核对当前算式的单位", boundary: "仅依据已给平台事实", benefit: "避免单位混淆" },
  { question: "核对当前失败处理", boundary: "仅检查现有约束", benefit: "避免遗漏失败响应" },
];
const result = { proposal: "保留原单位并逐项核对。", interfaces: "沿用当前输入输出契约。", tradeoffs: "不新增依赖。", evidenceIds: [], unknowns: [] };

async function fixture(t: test.TestContext, { hold = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-module-recovery-")), controller = new AbortController(), entered = deferred(), release = deferred();
  const definition = { id: "module_recovery", name: "模块断点", fingerprint: "same-requirement", draft: validDraft() }, calls: ({ "role": (string); "question"?: (unknown); })[] = [];
  const factory = async (options: PiSessionOptions) => {
    const tools = fixtureTools(options.customTools);
    return { messages: [] as SessionMessage[], modelCallAccounting: true, subscribe: () => () => {}, dispose() {}, async abort() {}, async prompt(text: string) {
      await options.onModelCall!({}); const payload = JSON.parse(String(text));
      if (tools.delegate_module) {
        calls.push({ role: "designer" });
        return tools.delegate_module.execute("delegate", { modules: structuredClone(assignments) });
      }
      assert.ok(tools.submit_module_design); calls.push({ role: "specialist", question: payload.assignment.question });
      if (payload.assignment.question === assignments[0]!.question) {
        if (hold) { entered.resolve!(); await release.promise; }
        return tools.submit_module_design.execute("valid-module", structuredClone(result));
      }
      throw new Error("synthetic module connection failure");
    } };
  };
  const create = () => new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"), sessionFactory: factory });
  const designer = create(); await designer.ready;
  t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  return { designer, definition, controller, entered, release, calls, create,
    run: () => designer.design(definition, { signal: controller.signal }) };
}

test("并行模块一成功一失败仍保存真实成功项，原构建继续失败且重载不丢成果", async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(), (error: TestFailure) => error.diagnostic!.reason === "module_failed"
    && objectFields(error.diagnostic!.delegation).savedModuleCount === 1 && objectFields(objectFields(objectFields(error.diagnostic!.delegation).failures)[0]).validResult === false
    && objectFields(error.diagnostic!.delegation).retryAllowed === false);
  const record = await f.designer.get(f.definition.id);
  assert.equal(record!.status!, "failed"); assert.equal(record!.design!, null); assert.equal(record!.review!, null);
  assert.deepEqual(record!.modules!, [{ assignment: assignments[0], result }]);
  assert.deepEqual(record!.attempts!, []); assert.equal(f.calls.filter(call => call.role === "specialist").length, 2);
  const reloaded = f.create(); await reloaded.ready;
  assert.deepEqual((await reloaded.get(f.definition.id))!.modules!, record!.modules!);
});

test("显式取消后迟到的模块不能成为成功成果", async t => {
  const f = await fixture(t, { hold: true }), pending = f.run();
  const rejection = assert.rejects(pending);
  await f.entered.promise; f.controller.abort(); f.release!.resolve!(); await rejection;
  const record = await f.designer.get(f.definition.id);
  assert.equal(record!.status!, "cancelled"); assert.deepEqual(record!.modules!, []); assert.equal(record!.review!, null);
});

test("等待模块期间已有更新版本，旧结果不能写入或覆盖新版本", async t => {
  const f = await fixture(t, { hold: true }), pending = f.run();
  const rejection = assert.rejects(pending);
  await f.entered.promise;
  const current = await f.designer.get(f.definition.id), newer = { ...current!, version: current!.version! + 1, summary: "更新构建正在进行" };
  await f.designer.save(newer); const before = designHash(await f.designer.get(f.definition.id));
  f.release!.resolve!(); await rejection;
  const latest = await f.designer.get(f.definition.id), old = await f.designer.getVersion(f.definition.id, current!.version!);
  assert.equal(latest!.version!, newer.version); assert.equal(designHash(latest), before);
  assert.deepEqual(latest!.modules!, []); assert.deepEqual(old!.modules!, []); assert.equal(old!.status!, "failed");
});
