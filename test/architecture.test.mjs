import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../architecture.mjs";
import { designHash } from "../architecture-contract.mjs";
import { InputError, ProviderError } from "../core.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";

const definition = (id = "weekly") => ({ id, name: "周报助手", draft: validDraft(), fingerprint: "requirements-v1" });
const submissionNames = { designer: "submit_architecture", reviewer: "submit_architecture_review", specialist: "submit_module_design" };

function factory(records, onPrompt) {
  return async (options) => {
    const tools = Object.fromEntries(options.customTools.map((tool) => [tool.name, tool]));
    const role = Object.keys(submissionNames).find((key) => tools[submissionNames[key]]);
    assert.ok(role, "模型会话应有明确的角色提交工具");
    const record = { options, tools, role, disposed: false, aborted: false };
    const submit = (value) => tools[submissionNames[role]].execute("fixture-submit", value);
    let listener;
    const session = {
      messages: [],
      subscribe(fn) { listener = fn; return () => { listener = null; }; },
      async prompt(message) {
        record.payload = JSON.parse(message);
        if (onPrompt) return onPrompt({ record, session, submit, emit: (event) => listener?.(event) });
        if (role === "designer") return submit(validDesign(record.payload.requirements));
        if (role === "reviewer") return submit(passingReview(record.payload.candidateHash));
        throw new Error("测试未请求局部专员");
      },
      async abort() { record.aborted = true; record.release?.(); },
      dispose() { record.disposed = true; },
    };
    record.session = session; records.push(record); return session;
  };
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "neuma-architecture-"));
  const sessions = [];
  const researchCalls = [];
  const config = { config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"),
    sessionFactory: factory(sessions, options.onPrompt),
    research: { async search(...args) { researchCalls.push(args); return { sources: [], gaps: [] }; } },
    ...options };
  delete config.onPrompt;
  const designer = new ArchitectureDesigner(config);
  t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  return { designer, config, sessions, researchCalls, root };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("默认只创建两个隔离角色，不搜索或委派；评估通过仍需真实执行定义交付", async (t) => {
  const { designer, sessions, researchCalls, config } = await fixture(t);
  const result = await designer.design(definition());
  assert.equal(result.status, "passed"); assert.equal(result.buildable, true); assert.equal(result.delivery, "blocked");
  assert.equal(result.candidateHash, designHash(result.design));
  assert.deepEqual(sessions.map((item) => item.role), ["designer", "reviewer"]);
  assert.notEqual(sessions[0].session, sessions[1].session);
  assert.deepEqual(Object.keys(sessions[0].tools), ["search_technical_sources", "delegate_module", "submit_architecture"]);
  assert.deepEqual(Object.keys(sessions[1].tools), ["submit_architecture_review"]);
  assert.deepEqual(researchCalls, []); assert.deepEqual(result.modules, []);
  assert.ok(sessions.every((item) => item.disposed));
  const ready = await designer.markReady(result);
  assert.equal(ready.delivery, "ready");
  const restarted = new ArchitectureDesigner(config);
  assert.deepEqual(await restarted.get("weekly"), await designer.get("weekly"));
});

test("独立评估拒绝时只允许一次带问题的局部修订，耗尽不能自动放行", async (t) => {
  let designs = 0;
  const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    if (record.role === "designer") {
      const candidate = validDesign(record.payload.requirements);
      candidate.instructions += ` 修订编号 ${designs++}`;
      return submit(candidate);
    }
    const review = passingReview(record.payload.candidateHash);
    review.verdict = "revise";
    review.checks.find((item) => item.id === "verification").passed = false;
    review.issues = [{ id: "acceptance_precision", blocking: true, description: "验收条件还不够明确", remedy: "只补充验收中的具体预期" }];
    review.summary = "需补充验收后重新检查";
    return submit(review);
  } });
  const result = await designer.design(definition());
  assert.equal(result.status, "needs_changes"); assert.equal(result.delivery, "blocked");
  assert.notEqual(result.buildable, true);
  assert.equal(result.attempts.length, 2); assert.equal(sessions.length, 4);
  assert.equal(sessions[0].payload.previousDesign, null);
  assert.deepEqual(sessions[2].payload.previousDesign, result.attempts[0].design);
  assert.ok(sessions[2].payload.issues.some((item) => item.id === "acceptance_precision"));
  assert.equal(sessions[2].payload.remaining.revisions, 0);
  assert.notEqual(result.attempts[0].candidateHash, result.attempts[1].candidateHash);
  assert.ok(result.attempts.every((item) => item.review.candidateHash === item.candidateHash));
  await assert.rejects(designer.markReady(result), InputError);
});

test("infeasible 和 insufficient 不会重试到通过", async (t) => {
  for (const verdict of ["infeasible", "insufficient"]) {
    const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
      if (record.role === "designer") return submit(validDesign(record.payload.requirements));
      const review = passingReview(record.payload.candidateHash);
      review.verdict = verdict;
      review.checks.find((item) => item.id === "feasibility").passed = false;
      review.summary = "能力证据不足，不能确认方案可行";
      return submit(review);
    } });
    const result = await designer.design(definition(verdict));
    assert.equal(result.status, verdict === "infeasible" ? "infeasible" : "needs_evidence");
    assert.equal(result.delivery, "blocked"); assert.equal(sessions.length, 2);
  }
});

test("评估必须绑定本次候选 hash，空证据不能成为通过依据", async (t) => {
  for (const invalid of ["hash", "evidence"]) {
    const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
      if (record.role === "designer") return submit(validDesign(record.payload.requirements));
      const review = passingReview(record.payload.candidateHash);
      if (invalid === "hash") review.candidateHash = "0".repeat(64);
      else review.checks[0].evidence = "  ";
      return submit(review);
    } });
    await assert.rejects(designer.design(definition()), InputError);
    const saved = await designer.get("weekly");
    assert.equal(saved.status, "failed"); assert.equal(saved.delivery, "blocked");
    assert.notEqual(saved.buildable, true); assert.equal(sessions.length, 2);
  }
});

test("技术搜索按需调用，真实来源进入设计、评估与持久化证据", async (t) => {
  const source = { id: "sdk_official", title: "SDK 官方说明", url: "https://pi.dev/docs/latest/sdk",
    versionScope: "滚动文档，版本兼容待核对", excerpt: "隔离会话可使用独立的工具目录。" };
  const queries = [];
  const { designer, sessions } = await fixture(t, {
    research: { async search(query) { queries.push(query); return { sources: [source], gaps: ["版本兼容需单独核对"] }; } },
    onPrompt: async ({ record, submit }) => {
      if (record.role === "designer") {
        const result = await record.tools.search_technical_sources.execute("search", { query: "Pi SDK 独立工具目录", topics: ["sdk"] });
        assert.deepEqual(JSON.parse(result.content[0].text).sources, [source]);
        const candidate = validDesign(record.payload.requirements);
        candidate.decisions[0].evidenceIds = [source.id];
        return submit(candidate);
      }
      return submit(passingReview(record.payload.candidateHash));
    },
  });
  const result = await designer.design(definition());
  assert.equal(queries.length, 1);
  assert.deepEqual(result.evidence.find((item) => item.id === source.id), source);
  assert.deepEqual(sessions[1].payload.evidence.find((item) => item.id === source.id), source);
  assert.deepEqual(result.researchGaps, ["版本兼容需单独核对"]);
  assert.deepEqual((await designer.get("weekly")).evidence, result.evidence);
});

test("搜索为空时不能引用伪造证据；搜索预算最多三次", async (t) => {
  const { designer, researchCalls } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    for (let i = 0; i < 3; i++) await record.tools.search_technical_sources.execute(`search_${i}`, { query: "SDK" });
    await assert.rejects(record.tools.search_technical_sources.execute("search_4", { query: "SDK" }), /预算/);
    const candidate = validDesign(record.payload.requirements);
    candidate.decisions[0].evidenceIds = ["invented_source"];
    return submit(candidate);
  } });
  await assert.rejects(designer.design(definition()), /不存在的 ID/);
  assert.equal(researchCalls.length, 3);
  assert.equal((await designer.get("weekly")).status, "failed");
});

test("仅按需委派最多两个局部模块，专员没有搜索或递归委派工具", async (t) => {
  const assignments = [{ question: "如何最小化状态", boundary: "只分析本次任务状态", benefit: "防止不必要持久化" },
    { question: "如何验证缺失输入", boundary: "只分析输入失败场景", benefit: "确保失败可解释" }];
  const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    if (record.role === "specialist") {
      assert.deepEqual(Object.keys(record.tools), ["submit_module_design"]);
      return submit({ proposal: "只保留任务状态", interfaces: "文本输入和摘要输出", tradeoffs: "不保留跨任务状态",
        evidenceIds: ["neuma-runtime-v1"], unknowns: [] });
    }
    if (record.role === "designer") {
      const response = await record.tools.delegate_module.execute("delegate", { modules: assignments });
      assert.equal(JSON.parse(response.content[0].text).modules.length, 2);
      await assert.rejects(record.tools.delegate_module.execute("third", { modules: [assignments[0]] }), /最多委派两个/);
      return submit(validDesign(record.payload.requirements));
    }
    return submit(passingReview(record.payload.candidateHash));
  } });
  const result = await designer.design(definition());
  assert.equal(result.status, "passed"); assert.equal(result.modules.length, 2);
  assert.equal(sessions.filter((item) => item.role === "specialist").length, 2);
  assert.ok(sessions.every((item) => item.disposed));
});

test("专员伪造来源会中止本轮，不继续交付", async (t) => {
  const { designer, sessions } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    if (record.role === "specialist") return submit({ proposal: "局部方案", interfaces: "局部接口", tradeoffs: "局部取舍",
      evidenceIds: ["made_up_source"], unknowns: [] });
    return record.tools.delegate_module.execute("delegate", { modules: [{ question: "接口是否支持", boundary: "只检查接口", benefit: "确认可行性" }] });
  } });
  await assert.rejects(designer.design(definition()), /未核实的证据/);
  assert.equal((await designer.get("weekly")).status, "failed");
  assert.ok(sessions.every((item) => item.disposed));
});

test("模型阶段取消会终止会话、保存 cancelled，不返回交付结果", async (t) => {
  const entered = deferred();
  const controller = new AbortController();
  const { designer, sessions, config } = await fixture(t, { onPrompt: async ({ record }) => {
    const waiting = deferred(); record.release = waiting.resolve;
    entered.resolve(); await waiting.promise;
  } });
  const promise = designer.design(definition(), { signal: controller.signal });
  await entered.promise; controller.abort();
  await assert.rejects(promise, (error) => error instanceof ProviderError && error.diagnostic.reason === "cancelled");
  const result = await designer.get("weekly");
  assert.equal(result.status, "cancelled"); assert.equal(result.delivery, "blocked");
  assert.ok(sessions[0].aborted); assert.ok(sessions[0].disposed);
  const stored = JSON.parse(await readFile(join(config.dataDir, "architectures.json"), "utf8"));
  assert.equal(stored.records[0].status, "cancelled");
});

test("最终保存期间取消仍不能返回 passed 或可交付结果", async (t) => {
  const controller = new AbortController();
  const { designer } = await fixture(t);
  const save = designer.save.bind(designer);
  designer.save = async (record) => {
    if (record.status === "passed") controller.abort();
    return save(record);
  };
  await assert.rejects(designer.design(definition(), { signal: controller.signal }),
    (error) => error instanceof ProviderError && error.diagnostic.reason === "cancelled");
  assert.equal((await designer.get("weekly")).status, "cancelled");
  assert.equal((await designer.get("weekly")).delivery, "blocked");
});

test("重启时在途设计恢复为失败，保留已通过版本的历史", async (t) => {
  const { designer, config } = await fixture(t);
  const passed = await designer.design(definition());
  const interrupted = { ...passed, version: passed.version + 1, status: "evaluating", delivery: "blocked" };
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(join(config.dataDir, "architectures.json"), JSON.stringify({ version: 1, records: [passed, interrupted] }));
  const restarted = new ArchitectureDesigner(config);
  const result = await restarted.get("weekly");
  assert.equal(result.status, "failed"); assert.equal(result.delivery, "blocked");
  assert.match(result.summary, /中断/);
  assert.equal(restarted.records.get(`weekly:${passed.version}`).status, "passed");
});

test("workflow/custom 即使架构通过也不能伪装为当前执行器可运行", async (t) => {
  for (const profile of ["workflow", "custom"]) {
    const { designer } = await fixture(t, { onPrompt: async ({ record, submit }) => {
      if (record.role === "designer") return submit({ ...validDesign(record.payload.requirements), profile });
      return submit(passingReview(record.payload.candidateHash));
    } });
    const result = await designer.design(definition(profile));
    assert.equal(result.status, "passed"); assert.equal(result.buildable, false);
    assert.equal(result.delivery, "needs_development");
    await assert.rejects(designer.markReady(result), InputError);
  }
});

test("后台触发和外部动作的需求事实不能被轻量候选或模型 pass 覆盖", async (t) => {
  for (const mode of ["scheduled", "event", "external_action"]) {
    const input = definition(mode);
    if (mode === "external_action") input.draft.externalAction = { mode: "requested", operation: "发送周报",
      target: "指定邮箱", scope: "仅发送本次确认的周报", trigger: "用户明确确认后", source: "user" };
    else input.draft.usage = { mode, detail: mode === "scheduled" ? "每周五九点" : "收到工作记录时", source: "user" };
    const { designer, sessions } = await fixture(t);
    const result = await designer.design(input);
    assert.equal(result.status, "needs_changes"); assert.equal(result.delivery, "blocked");
    assert.notEqual(result.buildable, true);
    assert.ok(result.issues.some((item) => item.id === "unsupported_execution" && item.blocking));
    assert.ok(sessions.filter((item) => item.role === "reviewer").every((item) =>
      item.payload.deterministicIssues.some((entry) => entry.id === "unsupported_execution")));
    assert.equal(sessions.length, 4, "只允许一次局部修订，重复 pass 不能绕过事实门槛");
  }
});

test("设计中的阻断未知项即使被独立评估忽略也不能交付", async (t) => {
  const { designer } = await fixture(t, { onPrompt: async ({ record, submit }) => {
    if (record.role === "designer") return submit(validDesign(record.payload.requirements, {
      unknowns: [{ question: "关键输入尚未验证可解析", blocking: true, resolution: "补充代表性输入并验证解析" }],
    }));
    return submit(passingReview(record.payload.candidateHash));
  } });
  const result = await designer.design(definition());
  assert.equal(result.status, "needs_changes"); assert.equal(result.delivery, "blocked");
  assert.notEqual(result.buildable, true);
  assert.ok(result.issues.some((item) => item.id === "unknown_1" && item.blocking));
});

test("模型与 provider 错误不泄露原始敏感载荷", async (t) => {
  for (const error of [new Error("Bearer private-key-fixture"),
    new ProviderError("upstream raw Bearer private-key-fixture", { stage: "provider", reason: "raw", raw: "private-key-fixture" })]) {
    const progress = [];
    const { designer } = await fixture(t, { sessionFactory: async () => { throw error; } });
    await assert.rejects(designer.design(definition(), { onProgress: (event) => progress.push(event) }),
      (caught) => caught instanceof ProviderError && !/private-key|Bearer/.test(caught.message + JSON.stringify(caught.diagnostic)));
    assert.doesNotMatch(JSON.stringify(await designer.get("weekly")), /private-key|Bearer/);
    assert.doesNotMatch(JSON.stringify(progress), /private-key|Bearer/);
  }
});
