import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevelopmentController, developmentSummary } from "../src/development/development.mjs";
import { DevelopmentArtifacts } from "../src/development/development-artifacts.mjs";
import { designHash } from "../src/architecture/architecture-contract.mjs";
import { developmentArchitecture, developmentPlan } from "./helpers/development.mjs";
import { passingReview } from "./helpers/architecture.mjs";

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "neuma-draft-continuation-"));
  t.after(async () => {
    async function unseal(path) {
      await chmod(path, 0o700);
      for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) await unseal(join(path, entry.name));
    }
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("正常run耗尽后同批次不补预算，新批次仅续接未通过草稿并重新诊断", async (t) => {
  const root = await directory(t), architecture = developmentArchitecture({ contractVersion: 2 });
  architecture.design.schemaVersion = 2;
  architecture.candidateHash = designHash(architecture.design); architecture.review = passingReview(architecture.candidateHash);
  const { cases: _cases, ...ordinary } = developmentPlan(architecture);
  const draftIndex = { ...ordinary, schemaVersion: 2, runtime: "node-action", application: { protocolVersion: 2, runtime: "node-action", entrypoint: ordinary.entrypoint,
    page: null, stateVersion: 1, evidenceIds: [], actions: [{ id: "echo", title: "回显", inputSchema: { type: "string" },
      outputSchema: { type: "object" }, connectionIds: [] }] }, caseFiles: ["missing.json"] };
  const payloads = [], bindings = [];
  const controller = new DevelopmentController({ dataDir: join(root, "data"), cwd: root, config: {}, limits: { reviewerTurns: 1 },
    executor: { probe: async () => ({ available: true }) }, sessionFactory: async (options) => {
      assert.equal(options.reasoningMode, "auto");
      bindings.push(options.sessionStorage.binding);
      const tools = Object.fromEntries(options.customTools.map((entry) => [entry.name, entry]));
      return { modelCallAccounting: true, messages: [], subscribe: () => () => {}, dispose() {}, async abort() {},
        async prompt(text) {
          await options.onModelCall();
          const payload = JSON.parse(text);
          if (payloads.length && options.sessionStorage.binding.architectureRef.version === 1) {
            if (!payload.historicalPlanningDraft) {
              const page = await tools.read_development_context.execute("history", { section: "historicalPlanningDraft", limit: 8000 });
              payload.historicalPlanningDraft = JSON.parse(JSON.parse(page.content[0].text).text);
            }
            const files = JSON.parse((await tools.list_plan_files.execute("draft", {})).content[0].text).files;
            assert.ok(files.some((entry) => entry.path === "index.json"));
            const sourceFile = payload.historicalPlanningDraft.source.files.find((entry) => entry.path === "index.json");
            assert.ok(sourceFile); assert.match(sourceFile.fileHash, /^[a-f0-9]{64}$/u);
            assert.equal(sourceFile.hashScope, "file");
            const historical = JSON.parse((await tools.read_plan_file.execute("original", { path: "index.json", source: "previous" })).content[0].text);
            assert.equal(historical.fileHash, sourceFile.fileHash); assert.equal(historical.trust, "unverified");
            await tools.write.execute("temporary-change", { path: "index.json", content: JSON.stringify({ ...draftIndex, summary: "临时修改的未验收骨架", caseFiles: [] }) });
            const current = JSON.parse((await tools.read_plan_file.execute("current", { path: "index.json" })).content[0].text);
            const validateRestore = options.rawInputValidators.restore_plan_file;
            assert.equal((await validateRestore({ args: { path: "index.json", expectedSourceHash: sourceFile.fileHash, expectedHash: null } })).valid, true);
            assert.equal((await validateRestore({ args: { path: "index.json", expectedSourceHash: sourceFile.fileHash, expectedHash: 0 } })).valid, false,
              "原始CAS控制字段不能由SDK将0隐式转成null");
            const restored = await tools.restore_plan_file.execute("restore-bound-source", { path: "index.json", expectedSourceHash: sourceFile.fileHash, expectedHash: current.fileHash });
            assert.equal(JSON.parse(restored.content[0].text).trust, "unverified");
            const checked = JSON.parse(restored.content.at(-1).text);
            assert.equal(checked.fileState.fileHash, sourceFile.fileHash);
            assert.notEqual(checked.planDraftCheck.status, "valid", "原未验收草稿恢复后仍不能宣称通过");
          } else {
            const result = await tools.write.execute("unaccepted", { path: "index.json", content: JSON.stringify(draftIndex) });
            const meta = JSON.parse(result.content.at(-1).text);
            assert.equal(meta.fileState.path, "index.json"); assert.equal(meta.fileState.hashScope, "file");
            assert.match(meta.fileState.fileHash, /^[a-f0-9]{64}$/u);
            const file = JSON.parse((await tools.read_plan_file.execute("current-file", { path: "index.json" })).content[0].text);
            assert.equal(meta.fileState.fileHash, file.fileHash); assert.notEqual(meta.fileState.fileHash, meta.planDraftCheck.bundleHash);
          }
          payloads.push(payload);
          await options.onModelCall();
        } };
    } });
  const first = await controller.run(architecture);
  assert.equal(first.status, "failed"); assert.equal(first.diagnostic.reason, "turn_limit"); assert.equal(first.planning.turns, 1);
  assert.deepEqual(developmentSummary(first).continuation, { mode: "fresh", sourceRunId: first.id, reason: "planning_budget_exhausted", historyPreserved: true });
  for (const delta of [{ status: "interrupted" }, { status: "cancelled" }, { plan: { summary: "accepted" } }, { tasks: [{ id: "executed", status: "verified" }] }])
    assert.equal(developmentSummary({ ...first, ...delta }).continuation, undefined);
  assert.equal(first.plan, null); assert.equal(first.planningDraft.snapshot.kind, "untrusted-planning-draft");
  const original = await readFile(join(await controller.artifacts.directory(first.agentId, first.id), "index.json"));
  const resumed = await controller.run(architecture, { resume: true });
  assert.equal(resumed.id, first.id); assert.equal(resumed.planning.turns, 1); assert.equal(payloads.length, 1);
  const fresh = await controller.run(architecture);
  assert.notEqual(fresh.id, first.id); assert.equal(fresh.plan, null); assert.equal(fresh.planHash, null); assert.deepEqual(fresh.tasks, []);
  assert.equal(payloads.length, 2); assert.equal(payloads[1].historicalPlanningDraft.trust, "unverified");
  assert.equal(payloads[1].historicalPlanningDraft.source.runId, first.id);
  assert.ok(payloads[1].historicalPlanningDraft.currentCheck.diagnostics.total > 0);
  assert.equal(payloads[1].modelBudget.limit, 1); assert.equal(payloads[1].modelBudget.used, 0);
  assert.notEqual(bindings.at(-1).runId, bindings[0].runId);
  assert.deepEqual(await readFile(join(await controller.artifacts.directory(fresh.agentId, fresh.id), "index.json")), original);
  assert.equal((await controller.store.getRun(first.id)).planning.turns, 1);
  const legacy = await controller.store.getRun(fresh.id); delete legacy.planningDraft;
  const measured = await controller.artifacts.diagnose(legacy.agentId, legacy.id, "index.json");
  legacy.planDraftChecks = [{ hash: measured.hash }];
  await controller.store.save(legacy);
  const compatible = await controller.run(architecture);
  assert.equal(compatible.planningDraftSource.snapshot.runId, fresh.id);
  assert.equal(compatible.planning.turns, 1); assert.equal(compatible.plan, null);
  const changed = structuredClone(architecture); changed.version++;
  const different = await controller.run(changed);
  assert.equal(different.planningDraftSource, undefined);
  assert.equal(payloads.at(-1).historicalPlanningDraft, undefined);
});

test("未通过且缺索引的草稿可逐字续接，不能当正式计划或覆盖已有材料", async (t) => {
  const artifacts = new DevelopmentArtifacts({ dataDir: await directory(t) });
  const root = await artifacts.directory("agent", "old");
  await writeFile(join(root, "orphan.json"), '{"unfinished":true}', { mode: 0o600 });
  const snapshot = await artifacts.captureDraft("agent", "old", "missing.json");
  await assert.rejects(artifacts.validateSnapshot(snapshot));
  const results = await Promise.allSettled([artifacts.restoreDraft(snapshot, "agent", "new"), artifacts.restoreDraft(snapshot, "agent", "new")]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(await readFile(join(await artifacts.directory("agent", "new"), "orphan.json"), "utf8"), '{"unfinished":true}');
  await assert.rejects(artifacts.restoreDraft(snapshot, "other", "new"), /标识/u);
  await assert.rejects(artifacts.restoreDraft(snapshot, "agent", "old"), /新的空批次/u);
  await assert.rejects(artifacts.captureDraft("agent", "old", "missing.json", { expectedHash: "0".repeat(64) }), /摘要不一致/u);
  await chmod(snapshot.path, 0o700); await chmod(join(snapshot.path, "orphan.json"), 0o600);
  await writeFile(join(snapshot.path, "orphan.json"), '{"changed":true}');
  await assert.rejects(artifacts.restoreDraft(snapshot, "agent", "changed"), /已改变/u);
});

test("草稿封存拒绝符号链接，不从链接读取内容", async (t) => {
  const root = await directory(t), artifacts = new DevelopmentArtifacts({ dataDir: join(root, "data") });
  const source = join(root, "private.json"); await writeFile(source, '{"secret":"private"}');
  const planning = await artifacts.directory("agent", "old"); await symlink(source, join(planning, "index.json"));
  await assert.rejects(artifacts.captureDraft("agent", "old", "index.json"));
});

test("正式候选被独立评审退回后，新批次保留精确版本评语但不继承接受或通过状态", async (t) => {
  const root = await directory(t), architecture = developmentArchitecture({ contractVersion: 2 });
  architecture.design.schemaVersion = 2;
  architecture.candidateHash = designHash(architecture.design); architecture.review = passingReview(architecture.candidateHash);
  const plan = developmentPlan(architecture);
  Object.assign(plan, { schemaVersion: 2, runtime: "node-action", application: { protocolVersion: 2, runtime: "node-action", entrypoint: plan.entrypoint,
    page: null, stateVersion: 1, evidenceIds: [], actions: [{ id: "echo", title: "回显", inputSchema: { type: "string" },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: [], additionalProperties: false }, connectionIds: [] }] } });
  plan.cases = plan.cases.map((entry) => ({ ...entry, kind: "action", actionId: "echo", mocks: [], input: JSON.stringify(entry.input) }));
  let initialRun, continued;
  const controller = new DevelopmentController({ dataDir: join(root, "data"), cwd: root, config: {}, limits: { reviewerTurns: 1 },
    executor: { probe: async () => ({ available: true }) }, sessionFactory: async (options) => {
      const tools = Object.fromEntries(options.customTools.map((entry) => [entry.name, entry]));
      initialRun ??= options.sessionStorage.binding.runId;
      return { modelCallAccounting: true, messages: [], subscribe: () => () => {}, dispose() {}, async abort() {}, async prompt(text) {
        await options.onModelCall(); const payload = JSON.parse(text);
        if (tools.submit_development_review) {
          assert.deepEqual(payload.admissionFacts, []);
          await tools.submit_development_review.execute("review", { subjectHash: payload.subjectHash, verdict: "revise", summary: "用例需要进一步覆盖",
            issues: [{ id: "coverage", kind: "plan", blocking: true, description: "当前断言覆盖不足", remedy: "补齐真实业务覆盖" }] });
        } else if (options.sessionStorage.binding.runId === initialRun) {
          const { cases, ...index } = plan;
          await tools.write.execute("cases", { path: "cases.json", content: JSON.stringify(cases) });
          await tools.write.execute("index", { path: "index.json", content: JSON.stringify({ ...index, caseFiles: ["cases.json"] }) });
          await tools.submit_development_plan.execute("formal", { indexPath: "index.json" });
        } else {
          continued = payload.historicalPlanningDraft;
          if (!continued) {
            const page = await tools.read_development_context.execute("history", { section: "historicalPlanningDraft", limit: 8000 });
            continued = JSON.parse(JSON.parse(page.content[0].text).text);
          }
          await options.onModelCall();
        }
      } };
    } });
  const first = await controller.run(architecture);
  assert.equal(first.status, "failed"); assert.equal(first.diagnostic.reason, "turn_limit"); assert.equal(first.planAttempts.length, 1);
  assert.equal(first.planAttempts[0].review.verdict, "revise"); assert.equal(first.plan, null); assert.ok(first.planningDraft);
  const next = await controller.run(architecture);
  assert.equal(next.plan, null); assert.deepEqual(next.tasks, []); assert.deepEqual(next.reviews, []); assert.equal(next.package, null);
  assert.equal(continued.trust, "unverified"); assert.equal(continued.source.runId, first.id);
  assert.equal(continued.historicalReview.reviewedPlanHash, first.planAttempts[0].planHash);
  assert.equal(continued.historicalReview.review.verdict, "revise");
  assert.equal(continued.currentCheck.status, "valid"); assert.equal((await controller.store.getRun(first.id)).planning.turns, 1);
  await controller.run(architecture);
  assert.equal(continued.historicalReview.sourceRunId, first.id);
  assert.equal(continued.historicalReview.reviewedPlanHash, first.planAttempts[0].planHash);
  const pending = await controller.store.get(architecture.agentId);
  pending.pendingPlan = { plan, planHash: first.planAttempts[0].planHash };
  await controller.store.save(pending);
  const unreviewed = await controller.run(architecture);
  assert.equal(unreviewed.plan, null); assert.equal(unreviewed.pendingPlan, undefined);
  assert.equal(unreviewed.planningDraftSource.snapshot.runId, pending.id);
  assert.deepEqual(unreviewed.reviews, []); assert.equal(unreviewed.package, null);
});
