import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { CAPABILITIES, checkDesign, designHash, requirementItems } from "../src/architecture/architecture-contract.mjs";
import { renderPlatformRules } from "../src/architecture/platform-contract.mjs";
import { InputError } from "../src/requirements/core.mjs";
import { WebCapabilities } from "../src/runtime/web-capabilities.mjs";
import { passingReview, validDesign, validDraft } from "./helpers/architecture.mjs";
import { mathDemoDesign, mathDemoDraft } from "./helpers/math-demo-fixture.mjs";

const submissionNames = { designer: "submit_architecture", reviewer: "submit_architecture_review", specialist: "submit_module_design" };
const definition = (id = "platform", draft = validDraft()) => ({ id, name: draft.name.value, draft, fingerprint: "platform-requirements-v1" });

async function fixture(t, onPrompt, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-architecture-platform-"));
  const sessions = [];
  const config = { config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"),
    research: { async search() { throw new Error("测试未授权外部检索"); } },
    sessionFactory: async (options) => {
      const tools = Object.fromEntries(options.customTools.map((tool) => [tool.name, tool]));
      const role = Object.keys(submissionNames).find((name) => tools[submissionNames[name]]);
      assert.ok(role, "模型角色须有唯一结构化提交工具");
      const record = { options, tools, role };
      const session = { messages: [], subscribe() { return () => {}; },
        async prompt(message) {
          record.payload = JSON.parse(message);
          record.originalPayload = structuredClone(record.payload);
          return onPrompt({ record, submit: (value) => tools[submissionNames[role]].execute("fixture-submit", value) });
        }, async abort() {}, dispose() { record.disposed = true; } };
      sessions.push(record);
      return session;
    }, ...overrides };
  const designer = new ArchitectureDesigner(config);
  t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  return { designer, config, sessions, root };
}

function revisionReview(payload, issues) {
  const review = passingReview(payload.candidateHash);
  review.verdict = "revise";
  review.checks.find((item) => item.id === "feasibility").passed = false;
  review.issues = issues;
  review.summary = "修正最终执行依赖及对应交付验收后重新检查";
  return review;
}

test("三个架构角色共享固定平台规则，局部模型修改其输入不会污染本轮快照", async (t) => {
  let firstSnapshot;
  const { designer, sessions } = await fixture(t, async ({ record, submit }) => {
    if (record.role === "designer") {
      firstSnapshot = structuredClone(record.payload.platformSnapshot);
      record.payload.platformSnapshot.modelInventedAbility = "任意浏览器自动运行";
      await record.tools.delegate_module.execute("module", { modules: [{ question: "文件交付是否需要页面研发",
        boundary: "只核对下载文件与 NEUMA 托管页面的边界", benefit: "避免错误选择研发路径" }] });
      return submit(validDesign(record.payload.requirements));
    }
    assert.deepEqual(record.payload.platformSnapshot, firstSnapshot);
    if (record.role === "specialist") return submit({ proposal: "仅下载文本文件时保持 light",
      interfaces: "文本输入与文件产物", tradeoffs: "文件校验不等于浏览器运行验证",
      evidenceIds: ["neuma-runtime-v1"], unknowns: [] });
    assert.equal(record.tools.web_search, undefined);
    assert.equal(record.tools.web_fetch, undefined);
    return submit(passingReview(record.payload.candidateHash));
  });
  const result = await designer.design(definition());
  assert.equal(result.status, "passed");
  assert.deepEqual(sessions.map((record) => record.role), ["designer", "specialist", "reviewer"]);
  assert.equal(result.platformContractVersion, 1);
  assert.equal(result.platformHash, designHash(result.platformSnapshot));
  assert.deepEqual(result.platformSnapshot, firstSnapshot);
  const sharedRules = renderPlatformRules(result.platformSnapshot);
  assert.ok(sharedRules.length > 0);
  for (const record of sessions) {
    assert.deepEqual(record.originalPayload.platformSnapshot, result.platformSnapshot);
    assert.equal(record.originalPayload.platformContractVersion, result.platformContractVersion);
    assert.equal(record.originalPayload.platformHash, result.platformHash);
    assert.ok(record.options.systemPrompt.includes(sharedRules), `${record.role} 必须收到同一份完整平台规则`);
    assert.ok(record.disposed);
  }
  assert.deepEqual(result.reviewContext, { candidateHash: result.candidateHash, platformHash: result.platformHash });
  assert.deepEqual(result.attempts[0].reviewContext, result.reviewContext);
  assert.equal(result.attempts[0].platformHash, result.platformHash);
  assert.deepEqual(sessions.at(-1).payload.reviewContext, result.reviewContext);
});

test("数学文件演示修订只调整真实依赖，同轮评测绑定相同平台与不同候选", async (t) => {
  let generated = 0;
  const { designer, sessions } = await fixture(t, async ({ record, submit }) => {
    if (record.role === "designer") return submit(mathDemoDesign(record.payload.requirements, {
      includeExcludedCapabilities: generated++ === 0,
    }));
    const blocking = record.payload.deterministicIssues.filter((issue) => issue.blocking);
    if (blocking.length) {
      assert.deepEqual(blocking.map((issue) => issue.id), [
        "capability_dynamic_geometry_rendering", "capability_external_visualization_embed",
      ]);
      for (const issue of blocking) {
        assert.equal(issue.source, "program");
        assert.ok(issue.candidateFields.includes("capabilities"));
        assert.match(issue.remedy, /capabilities|执行依赖|最终.*依赖/);
        assert.doesNotMatch(issue.remedy, /删除 deterministicIssues|修改 blocking/);
      }
      return submit(revisionReview(record.payload, [{ id: "actual_dependencies", blocking: true,
        description: "capabilities 把未来动态引擎和明确排除的嵌入误写为执行依赖",
        remedy: "修正 capabilities，将未采用方案移至 decisions；补步骤、覆盖和验收以核对替代路径" }]));
    }
    const candidate = record.payload.design;
    assert.ok(candidate.capabilities.every((capability) => capability.status === "available"));
    assert.ok(candidate.decisions.some((decision) => decision.id === "geometry_engine"));
    assert.match(candidate.steps.find((step) => step.id === "S4").completion, /所有资源内联.*禁止运行时构造任何 URL 加载/);
    assert.match(candidate.steps.find((step) => step.id === "S3").completion, /规范化公式原文.*逐字核对/);
    assert.match(candidate.steps.find((step) => step.id === "S6").completion, /串行执行.*n 与公式.*归属/);
    assert.match(candidate.unknowns[2].question, /设计假设，待需求方确认/);
    assert.doesNotMatch(JSON.stringify(candidate.unknowns), /已接受假设/);
    return submit(passingReview(record.payload.candidateHash));
  });
  const result = await designer.design(definition("math-demo", mathDemoDraft()));
  assert.equal(result.requirements.length, 12);
  assert.equal(result.status, "passed");
  assert.equal(result.buildable, true);
  assert.equal(result.delivery, "blocked", "架构通过仍不等于执行定义已经交付");
  assert.equal(result.attempts.length, 2);
  assert.notEqual(result.attempts[0].candidateHash, result.attempts[1].candidateHash);
  assert.ok(result.attempts[0].issues.some((issue) => issue.source === "model"));
  for (const attempt of result.attempts) {
    assert.equal(attempt.platformHash, result.platformHash);
    assert.deepEqual(attempt.reviewContext, { candidateHash: attempt.candidateHash, platformHash: result.platformHash });
  }
  for (const record of sessions) assert.equal(record.payload.platformHash, result.platformHash);
  assert.ok(sessions[2].payload.issues.some((issue) => issue.candidateFields?.includes("capabilities")));
  assert.deepEqual((await designer.get("math-demo")).attempts, result.attempts);
});

test("文件交付可直接落入 light，托管页面或操作必须进入研发交付", () => {
  const requirements = requirementItems(mathDemoDraft());
  const files = mathDemoDesign(requirements);
  const context = { requirements, capabilities: CAPABILITIES, evidence: [{ id: "neuma-runtime-v1" }] };
  assert.equal(checkDesign(files, context).runnable, true);
  const hosted = structuredClone(files);
  hosted.interaction = { ...hosted.interaction, defaultEntry: "application", page: true };
  assert.equal(checkDesign(hosted, context).runnable, false);
  const operation = structuredClone(files);
  operation.interaction.operations = true;
  assert.equal(checkDesign(operation, context).runnable, false);
});

test("必需能力缺失时模型 pass 和声称降级不改变程序门槛", async (t) => {
  const { designer, sessions } = await fixture(t, async ({ record, submit }) => {
    if (record.role === "designer") return submit(validDesign(record.payload.requirements, {
      capabilities: [{ id: "conversation", status: "available", reason: "文本生成" },
        { id: "dynamic_geometry_rendering", status: "needs_development", reason: "真实引擎未开发，但设计者声称降级后不阻断" }],
    }));
    return submit(passingReview(record.payload.candidateHash));
  });
  const result = await designer.design(definition());
  assert.equal(result.status, "needs_changes");
  assert.equal(result.delivery, "blocked");
  assert.notEqual(result.buildable, true);
  assert.ok(result.issues.some((issue) => issue.id === "capability_dynamic_geometry_rendering"
    && issue.blocking && issue.source === "program"));
  assert.equal(sessions.length, 4, "只允许一次修订，模型 pass 不覆盖程序阻断");
  await assert.rejects(designer.markReady(result), InputError);
});

test("已确认托管页面时，模型 pass 不能放行省略交付字段的旧版候选", async (t) => {
  const draft = validDraft();
  draft.interaction = { defaultEntry: "application", page: true, operations: ["整理周报"],
    inputs: "工作记录表单", results: "应用页面中的中文周报", persistentData: "无" };
  const { designer, sessions } = await fixture(t, async ({ record, submit }) => {
    if (record.role === "designer") return submit(validDesign(record.payload.requirements));
    const issue = record.payload.deterministicIssues.find((entry) => entry.id === "confirmed_interaction");
    assert.equal(issue.blocking, true);
    assert.equal(issue.source, "program");
    assert.ok(issue.candidateFields.includes("schemaVersion"));
    assert.ok(issue.candidateFields.includes("interaction"));
    return submit(passingReview(record.payload.candidateHash));
  });
  const result = await designer.design(definition("confirmed-page", draft));
  assert.equal(result.status, "needs_changes");
  assert.equal(result.delivery, "blocked");
  assert.notEqual(result.buildable, true);
  assert.equal(result.attempts.length, 2);
  assert.equal(sessions.length, 4);
  assert.ok(result.issues.some((issue) => issue.id === "confirmed_interaction"
    && issue.blocking && issue.source === "program"));
  await assert.rejects(designer.markReady(result), InputError);
});

test("后台触发尚无适配，custom 研发路径和模型 pass 也不能冒充支持", async (t) => {
  const draft = validDraft();
  draft.usage = { mode: "scheduled", detail: "每天上午九点自动运行", source: "user" };
  const { designer } = await fixture(t, async ({ record, submit }) => record.role === "designer"
    ? submit(validDesign(record.payload.requirements, { profile: "custom" }))
    : submit(passingReview(record.payload.candidateHash)));
  const result = await designer.design(definition("scheduled-custom", draft));
  assert.equal(result.status, "needs_changes");
  assert.equal(result.delivery, "blocked");
  assert.ok(result.issues.some((issue) => issue.id === "unsupported_trigger"
    && issue.blocking && issue.source === "program"));
  assert.equal(result.attempts.length, 2);
});

test("排除能力不能伪造降级覆盖用户明确要求的真实动态引擎", async (t) => {
  const draft = mathDemoDraft();
  draft.constraints[1].text = "必须调用真实动态几何引擎，固定模板不能作为替代";
  const { designer } = await fixture(t, async ({ record, submit }) => {
    if (record.role === "designer") return submit(mathDemoDesign(record.payload.requirements));
    assert.ok(record.payload.requirements.some((item) => item.text.includes("固定模板不能作为替代")));
    const review = revisionReview(record.payload, [{ id: "missing_required_engine", blocking: true,
      description: "constraint_2 明确要求真实引擎，decisions.geometry_engine 的固定模板替代不满足需求",
      remedy: "保持需求边界，声明真实引擎 needs_development；不能借移除能力伪造降级覆盖" }]);
    review.verdict = "infeasible";
    return submit(review);
  });
  const result = await designer.design(definition("required-engine", draft));
  assert.equal(result.status, "infeasible");
  assert.equal(result.delivery, "blocked");
  assert.ok(result.issues.some((issue) => issue.id === "missing_required_engine" && issue.blocking));
  assert.equal(result.attempts.length, 1);
});

test("冻结平台政策遵守禁止联网，模型工具调用也不请求外部资料", async (t) => {
  let requests = 0;
  const draft = validDraft();
  draft.constraints = [{ text: "禁止联网", source: "user" }];
  const web = new WebCapabilities({ fetchImpl: async () => { requests++; throw new Error("不得请求网络"); } });
  const { designer, sessions } = await fixture(t, async ({ record, submit }) => {
    if (record.role === "designer") {
      if (record.payload.requirement.draft.constraints.some((item) => item.text === "禁止联网")) {
        await assert.rejects(record.tools.web_search.execute("search", { query: "formula" }), /不联网/);
        await assert.rejects(record.tools.web_fetch.execute("fetch", { url: "https://example.com" }), /不联网/);
        await assert.rejects(record.tools.search_technical_sources.execute("research", { query: "formula", topics: ["sdk"] }), /不联网/);
      }
      return submit(validDesign(record.payload.requirements));
    }
    return submit(passingReview(record.payload.candidateHash));
  }, { web, research: { async search() { requests++; throw new Error("不得请求网络"); } } });
  const result = await designer.design(definition("offline", draft));
  assert.equal(result.status, "passed");
  assert.equal(requests, 0);
  assert.ok(sessions.every((record) => record.originalPayload.platformHash === result.platformHash));
  const online = await designer.design(definition("online"));
  assert.notEqual(online.platformHash, result.platformHash, "不同需求的联网政策必须体现在快照中");
});

test("外部调用方修改原始需求不能改变本轮需求、评测输入或联网政策", async (t) => {
  let requests = 0;
  const draft = validDraft();
  draft.constraints = [{ text: "禁止联网", source: "user" }];
  const input = definition("input-boundary", draft);
  const original = structuredClone(input);
  const web = new WebCapabilities({ fetchImpl: async () => { requests++; throw new Error("不得请求网络"); } });
  const { designer, sessions } = await fixture(t, async ({ record, submit }) => {
    if (record.role === "designer") {
      input.draft.goal.value = "改为调用外部站点";
      input.draft.constraints = [];
      input.fingerprint = "mutated-requirements";
      await assert.rejects(record.tools.web_search.execute("search", { query: "formula" }), /不联网/);
      await assert.rejects(record.tools.search_technical_sources.execute("research", { query: "formula", topics: ["sdk"] }), /不联网/);
      return submit(validDesign(record.payload.requirements));
    }
    assert.deepEqual(record.payload.requirement, original.draft);
    assert.deepEqual(record.payload.requirements, requirementItems(original.draft));
    assert.equal(record.payload.platformSnapshot.network.allowNetwork, false);
    return submit(passingReview(record.payload.candidateHash));
  }, { web, research: { async search() { requests++; throw new Error("不得请求网络"); } } });
  const result = await designer.design(input);
  assert.equal(result.status, "passed");
  assert.deepEqual(result.draft, original.draft);
  assert.equal(result.sourceFingerprint, original.fingerprint);
  assert.equal(requests, 0);
  assert.ok(sessions.every((record) => record.payload.platformHash === result.platformHash));
});

test("篡改已保存的平台快照会拒绝加载，不能以保留旧摘要混入新能力", async (t) => {
  const { designer, config } = await fixture(t, async ({ record, submit }) => record.role === "designer"
    ? submit(validDesign(record.payload.requirements)) : submit(passingReview(record.payload.candidateHash)));
  const result = await designer.design(definition());
  const path = join(config.dataDir, "agents/platform/architecture.json");
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(stored.records[0].platformHash, result.platformHash);
  stored.records[0].platformSnapshot.modelInventedAbility = "浏览器自动运行已验证";
  await writeFile(path, JSON.stringify(stored));
  const restarted = new ArchitectureDesigner(config);
  await assert.rejects(restarted.get("platform"), InputError);
});

test("旧记录没有平台元数据仍按历史状态读取，不自动重评或改写能力摘要", async (t) => {
  const { designer, config, sessions } = await fixture(t, async ({ record, submit }) => record.role === "designer"
    ? submit(validDesign(record.payload.requirements)) : submit(passingReview(record.payload.candidateHash)));
  const result = await designer.design(definition());
  const legacy = structuredClone(result);
  delete legacy.platformContractVersion;
  delete legacy.platformSnapshot;
  delete legacy.platformHash;
  delete legacy.reviewContext;
  for (const attempt of legacy.attempts) {
    delete attempt.platformHash;
    delete attempt.reviewContext;
  }
  const path = join(config.dataDir, "agents/platform/architecture.json");
  await writeFile(path, JSON.stringify({ version: 1, records: [legacy] }));
  const before = await readFile(path, "utf8");
  const restarted = new ArchitectureDesigner(config);
  const loaded = await restarted.get("platform");
  assert.deepEqual(loaded, legacy);
  assert.equal(loaded.candidateHash, designHash(loaded.design));
  assert.deepEqual(loaded.capabilitySnapshot, CAPABILITIES);
  assert.equal(sessions.length, 2, "读取历史记录不创建模型会话");
  assert.equal(await readFile(path, "utf8"), before, "读取不重写历史记录");
});
