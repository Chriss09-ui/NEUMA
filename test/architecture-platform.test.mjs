import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { CAPABILITIES, checkDesign, designHash, requirementItems } from "../src/architecture/architecture-contract.mjs";
import { PLATFORM_CONTRACT_VERSION, createPlatformSnapshot, renderPlatformRules, platformCapabilityCatalog,
  platformCapabilitySnapshotCompatible } from "../src/architecture/platform-contract.mjs";
import { InputError } from "../src/requirements/core.mjs";
import { WebCapabilities } from "../src/runtime/web-capabilities.mjs";
import { passingReview, validDesign, validDraft } from "./helpers/architecture.mjs";
import { mathDemoDesign, mathDemoDraft } from "./helpers/math-demo-fixture.mjs";
import { paperOverviewDesign, paperOverviewDraft } from "./helpers/paper-overview-fixture.mjs";
import { readModelContextSection } from "./helpers/model-context.mjs";

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
      assert.deepEqual(record.payload.capabilities,
        platformCapabilityCatalog(firstSnapshot, { runtimeCapabilities: record.payload.runtimeCapabilities }));
      record.payload.platformSnapshot.modelInventedAbility = "任意浏览器自动运行";
      record.payload.capabilities.find((item) => item.id === "web_fetch").status = "unverified";
      await record.tools.delegate_module.execute("module", { modules: [{ question: "文件交付是否需要页面研发",
        boundary: "只核对下载文件与 NEUMA 托管页面的边界", benefit: "避免错误选择研发路径" }] });
      return submit(validDesign(record.payload.requirements));
    }
    assert.deepEqual(record.payload.platformSnapshot, firstSnapshot);
    if (record.role === "specialist") return submit({ proposal: "仅下载文本文件时保持 light",
      interfaces: "文本输入与文件产物", tradeoffs: "文件校验不等于浏览器运行验证",
      evidenceIds: [`neuma-runtime-v${record.payload.platformContractVersion}`], unknowns: [] });
    assert.equal(record.tools.web_search, undefined);
    assert.equal(record.tools.web_fetch, undefined);
    return submit(passingReview(record.payload.candidateHash));
  });
  const result = await designer.design(definition());
  assert.equal(result.status, "passed");
  assert.deepEqual(sessions.map((record) => record.role), ["designer", "specialist", "reviewer"]);
  assert.equal(result.platformContractVersion, PLATFORM_CONTRACT_VERSION);
  assert.equal(result.platformHash, designHash(result.platformSnapshot));
  assert.deepEqual(result.platformSnapshot, firstSnapshot);
  const sharedRules = renderPlatformRules(result.platformSnapshot, { runtimeCapabilities: result.runtimeCapabilities });
  assert.ok(sharedRules.length > 0);
  for (const record of sessions) {
    assert.deepEqual(record.originalPayload.platformSnapshot, result.platformSnapshot);
    assert.deepEqual(record.originalPayload.capabilities,
      platformCapabilityCatalog(result.platformSnapshot, { runtimeCapabilities: record.originalPayload.runtimeCapabilities }));
    assert.equal(record.originalPayload.platformContractVersion, result.platformContractVersion);
    assert.equal(record.originalPayload.platformHash, result.platformHash);
    assert.ok((await readModelContextSection(record.options, "roleGuide")).includes(sharedRules), `${record.role} 必须能读取同一份完整平台规则`);
    assert.ok(!record.options.systemPrompt.includes(sharedRules), "主提示不再重复展开平台说明");
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

test("论文链接与 PDF 的 light 方案无需预读目标网址即可通过，站点未知不冒充工具缺失或业务已验证", async (t) => {
  let requests = 0;
  let searches = 0;
  const web = new WebCapabilities({ fetchImpl: async () => { requests++; throw new Error("设计期不应执行业务论文读取"); } });
  const { designer, sessions, config } = await fixture(t, async ({ record, submit }) => {
    assert.deepEqual(record.payload.capabilities,
      platformCapabilityCatalog(record.payload.platformSnapshot, { runtimeCapabilities: record.payload.runtimeCapabilities }));
    assert.equal(record.payload.capabilities.find((item) => item.id === "web_fetch").status, "available");
    if (record.role === "designer") {
      for (let index = 0; index < 3; index++) await record.tools.search_technical_sources.execute(`policy_${index}`,
        { query: "现有读取路径边界", topics: ["sdk"] });
      return submit(paperOverviewDesign(record.payload.requirements));
    }
    assert.equal(record.payload.design.schemaVersion, 2);
    assert.equal(record.payload.design.profile, "light");
    assert.ok(record.payload.design.steps.some((step) => step.id === "S2a"));
    assert.ok(record.payload.design.steps.some((step) => step.id === "S2b"));
    assert.equal(record.payload.deterministicIssues.some((issue) => issue.id === "capability_web_fetch"), false);
    assert.ok(record.payload.deterministicIssues.some((issue) => issue.id === "unknown_1" && !issue.blocking));
    assert.match(record.payload.design.acceptance.find((item) => item.id === "ACC_2").expected, /ACC_1.*无虚构章节.*实际读取范围/);
    assert.match(record.payload.design.acceptance.find((item) => item.id === "ACC_3").expected, /明确索取.*无章节要点.*不生成或写入/);
    return submit(passingReview(record.payload.candidateHash));
  }, { web, research: { async search() { searches++; return { sources: [], gaps: [] }; } } });
  const result = await designer.design(definition("paper-overview", paperOverviewDraft()));
  assert.equal(result.requirements.length, 11);
  assert.equal(result.status, "passed");
  assert.equal(result.buildable, true);
  assert.equal(result.delivery, "blocked", "架构通过仍不等于已经生成执行定义");
  assert.equal(result.attempts.length, 1);
  assert.equal(searches, 3, "架构检索预算用完也不改变底座工具实现与许可");
  assert.equal(requests, 0, "目标网站结果留待运行期实际调用验证");
  assert.deepEqual(result.capabilitySnapshot, CAPABILITIES);
  assert.equal(platformCapabilitySnapshotCompatible(result), true);
  assert.equal((await designer.markReady(result)).delivery, "ready");
  const restarted = new ArchitectureDesigner(config);
  assert.equal((await restarted.get("paper-overview")).candidateHash, result.candidateHash);
  assert.equal(sessions.length, 2, "保存或重启不创建额外评测会话");
});

test("论文候选误把已实现公共正文工具标为 unverified 时仍阻断，修订能力状态后按同一快照通过", async (t) => {
  let count = 0;
  const { designer, sessions } = await fixture(t, async ({ record, submit }) => {
    if (record.role === "designer") return submit(paperOverviewDesign(record.payload.requirements,
      { webStatus: count++ === 0 ? "unverified" : "available" }));
    const issue = record.payload.deterministicIssues.find((item) => item.id === "capability_web_fetch");
    if (issue) {
      assert.equal(issue.source, "program");
      assert.equal(issue.blocking, true);
      assert.ok(issue.candidateFields.includes("capabilities"));
      assert.ok(issue.candidateFields.includes("unknowns"), "能力分类纠错须允许在未知项保留原验证义务");
      assert.match(issue.remedy, /available/);
      assert.match(issue.remedy, /unknowns/);
      return submit(revisionReview(record.payload, [{ id: "availability_object", blocking: true,
        description: "具体网址未实测不等于公共正文工具未实现；需修正 capabilities 的验证对象",
        remedy: "按冻结事实把 web_fetch 设为 available，保留具体站点结果为运行期验证，不修改程序检查" }]));
    }
    return submit(passingReview(record.payload.candidateHash));
  });
  const result = await designer.design(definition("paper-revision", paperOverviewDraft()));
  assert.equal(result.status, "passed");
  assert.equal(result.buildable, true);
  assert.equal(result.attempts.length, 2);
  assert.ok(result.attempts[0].issues.some((issue) => issue.id === "capability_web_fetch" && issue.blocking));
  assert.equal(result.design.capabilities.find((item) => item.id === "web_fetch").status, "available");
  for (const attempt of result.attempts) assert.equal(attempt.platformHash, result.platformHash);
  for (const session of sessions) assert.deepEqual(session.originalPayload.capabilities,
    platformCapabilityCatalog(result.platformSnapshot, { runtimeCapabilities: session.originalPayload.runtimeCapabilities }));
  assert.equal(result.design.unknowns[0].blocking, false);
});

test("模型 pass 不能放行论文路径中保留的未核实工具状态", async (t) => {
  const { designer } = await fixture(t, async ({ record, submit }) => record.role === "designer"
    ? submit(paperOverviewDesign(record.payload.requirements, { webStatus: "unverified" }))
    : submit(passingReview(record.payload.candidateHash)));
  const result = await designer.design(definition("paper-unverified", paperOverviewDraft()));
  assert.equal(result.status, "needs_changes");
  assert.equal(result.delivery, "blocked");
  assert.notEqual(result.buildable, true);
  assert.ok(result.issues.some((issue) => issue.id === "capability_web_fetch" && issue.blocking && issue.source === "program"));
  await assert.rejects(designer.markReady(result), InputError);
});

test("禁止联网的快照不接受公共正文 available，目录外工具也不能伪装可用", async (t) => {
  for (const id of ["web_fetch", "invented_paper_reader"]) {
    const draft = paperOverviewDraft();
    if (id === "web_fetch") draft.constraints.push({ text: "禁止联网", source: "user" });
    const { designer } = await fixture(t, async ({ record, submit }) => {
      const candidate = paperOverviewDesign(record.payload.requirements);
      candidate.capabilities.find((item) => item.id === "web_fetch").id = id;
      return submit(candidate);
    });
    await assert.rejects(designer.design(definition(`paper-forbidden-${id}`, draft)), /未被工具目录证实可用/);
    const saved = await designer.get(`paper-forbidden-${id}`);
    assert.equal(saved.status, "failed");
    assert.equal(saved.delivery, "blocked");
    assert.notEqual(saved.buildable, true);
  }
});

test("论文工具分类修正不能用仅 PDF 路径虚假覆盖已确认的链接输入", async (t) => {
  const { designer } = await fixture(t, async ({ record, submit }) => {
    if (record.role === "designer") return submit(paperOverviewDesign(record.payload.requirements, { pdfOnly: true }));
    assert.ok(record.payload.requirements.some((item) => item.id === "capability_1" && item.text.includes("HTTP(S)")));
    assert.equal(record.payload.design.capabilities.some((item) => item.id === "web_fetch"), false);
    assert.equal(record.payload.design.steps.some((item) => item.id === "S2a"), false);
    const review = revisionReview(record.payload, [{ id: "link_input_not_covered", blocking: true,
      description: "capability_1 要求公开链接，当前仅 PDF 路径与覆盖声称不一致",
      remedy: "恢复公共正文读取路径及同一章节验收口径，不能把建议上传 PDF 当作已完成链接输入" }]);
    review.checks.find((item) => item.id === "requirements").passed = false;
    return submit(review);
  });
  const result = await designer.design(definition("paper-fake-fallback", paperOverviewDraft()));
  assert.equal(result.status, "needs_changes");
  assert.equal(result.delivery, "blocked");
  assert.equal(result.attempts.length, 2);
  assert.ok(result.issues.some((issue) => issue.id === "link_input_not_covered" && issue.blocking && issue.source === "model"));
  await assert.rejects(designer.markReady(result), InputError);
});

test("文件交付可直接落入 light，托管页面或操作必须进入研发交付", () => {
  const requirements = requirementItems(mathDemoDraft());
  const files = mathDemoDesign(requirements);
  const context = { requirements, capabilities: CAPABILITIES, evidence: [{ id: `neuma-runtime-v${PLATFORM_CONTRACT_VERSION}` }] };
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

test("禁止联网不能被研发路径和待连接状态绕过，模型 pass 仍不能放行", async (t) => {
  for (const [profile, toolId, status, page] of [
    ["workflow", "web_fetch", "needs_connection", false],
    ["custom", "web_search", "needs_development", false],
    ["light", "web_fetch", "needs_connection", true],
  ]) {
    const draft = validDraft();
    draft.constraints = [{ text: "禁止联网，仅使用本地资料", source: "user" }];
    const { designer } = await fixture(t, async ({ record, submit }) => {
      if (record.role === "designer") return submit(validDesign(record.payload.requirements, { profile,
        schemaVersion: 2, connections: [], interaction: { defaultEntry: page ? "application" : "conversation",
          page, operations: false, inputs: "本地资料", results: "整理结果", persistentData: "无" },
        capabilities: [{ id: "conversation", status: "available", reason: "对话能力" },
          { id: toolId, status, reason: "设计者试图通过连接或研发恢复联网" }],
      }));
      const blockers = record.payload.deterministicIssues.filter((entry) => entry.blocking);
      assert.equal(blockers.filter((entry) => entry.id === `capability_${toolId}`).length, 1);
      assert.match(blockers[0].description, /平台政策禁止/);
      assert.match(blockers[0].remedy, /请求需求方确认变更/);
      return submit(passingReview(record.payload.candidateHash));
    });
    const result = await designer.design(definition(`offline-${profile}`, draft));
    assert.equal(result.status, "needs_changes");
    assert.equal(result.delivery, "blocked");
    assert.notEqual(result.buildable, true);
    assert.equal(result.attempts.length, 2);
  }
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

test("冻结平台政策禁止联网时不暴露联网工具或检索预算，也不请求外部资料", async (t) => {
  let requests = 0;
  const draft = validDraft();
  draft.constraints = [{ text: "禁止联网", source: "user" }];
  const web = new WebCapabilities({ fetchImpl: async () => { requests++; throw new Error("不得请求网络"); } });
  const { designer, sessions } = await fixture(t, async ({ record, submit }) => {
    if (record.role === "designer") {
      if (record.payload.requirement.draft.constraints.some((item) => item.text === "禁止联网")) {
        for (const name of ["web_search", "web_fetch", "search_technical_sources"]) assert.equal(record.tools[name], undefined);
        assert.ok(record.tools.delegate_module); assert.equal(record.payload.remaining.searches, 0);
        assert.match(await readModelContextSection(record.options, "roleGuide"), /检索预算为 0/);
        const wire = record.options.transformContext([{ role: "user", content: JSON.stringify(record.originalPayload) }]);
        assert.equal(JSON.parse(wire[0].content).platformOverview.network.allowNetwork, false);
      } else {
        for (const name of ["web_search", "web_fetch", "search_technical_sources"]) assert.ok(record.tools[name]);
        assert.equal(record.payload.remaining.searches, 3);
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
      for (const name of ["web_search", "web_fetch", "search_technical_sources"]) assert.equal(record.tools[name], undefined);
      assert.equal(record.payload.remaining.searches, 0);
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

test("持久化的 v1 平台记录保留原候选与历史结果，主动重设计才使用 v4 平台契约", async (t) => {
  const { designer, config, sessions } = await fixture(t, async ({ record, submit }) => record.role === "designer"
    ? submit(validDesign(record.payload.requirements)) : submit(passingReview(record.payload.candidateHash)));
  const result = await designer.design(definition());
  const legacy = structuredClone(result);
  legacy.platformSnapshot = JSON.parse(await readFile(new URL("./helpers/platform-v1-fixture.json", import.meta.url), "utf8"));
  legacy.platformContractVersion = 1;
  legacy.platformHash = designHash(legacy.platformSnapshot);
  legacy.reviewContext.platformHash = legacy.platformHash;
  legacy.evidence = [{ id: "neuma-runtime-v1", title: "历史平台事实", kind: "local", excerpt: "旧版公共工具与业务目录分离" }];
  for (const attempt of legacy.attempts) {
    attempt.platformHash = legacy.platformHash;
    attempt.reviewContext.platformHash = legacy.platformHash;
  }
  const path = join(config.dataDir, "agents/platform/architecture.json");
  await writeFile(path, JSON.stringify({ version: 1, records: [legacy] }));
  const before = await readFile(path, "utf8");
  const restarted = new ArchitectureDesigner(config);
  const loaded = await restarted.get("platform");
  assert.deepEqual(loaded, legacy);
  assert.equal(loaded.platformContractVersion, 1);
  assert.equal(loaded.candidateHash, result.candidateHash);
  assert.equal(platformCapabilitySnapshotCompatible(loaded), true);
  assert.equal(sessions.length, 2);
  assert.equal(await readFile(path, "utf8"), before);
  const next = await restarted.design(definition());
  assert.equal(next.version, legacy.version + 1);
  assert.equal(next.platformContractVersion, 4);
  assert.notEqual(next.platformHash, legacy.platformHash);
  assert.equal(sessions.length, 4);
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(stored.records.find((item) => item.version === legacy.version), legacy);
});
