import { fixtureToolAt, callFixture, recordArray, fixtureText } from "./helpers/m7-test-boundaries.mjs";
import type { ArchitectureDesign, PlatformClaim } from "../src/contracts/architecture.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import type { PiSessionOptions } from "../src/runtime/pi-port.mjs";
import type { SessionMessage } from "../src/runtime/pi-port.mjs";
import { fixtureTools } from "./helpers/m7-test-boundaries.mjs";
import { toolText } from "./helpers/m7-test-boundaries.mjs";
import type { TestFailure } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv } from "ajv";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { validateDesign, designHash, requirementItems, designSubmissionSchema } from "../src/architecture/architecture-contract.mjs";
import { createPlatformContractTool, validateArchitecturePlatformClaims } from "../src/architecture/architecture-platform-claims.mjs";
import { architectureReviewEvidenceContext } from "../src/architecture/architecture-review-evidence.mjs";
import { runtimeCapabilityContract } from "../src/runtime/runtime-capability-contract.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../src/verification/acceptance-contract.mjs";
import { resolveTestJson } from "../src/development/development-fixtures.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";
import { fidelityResult } from "./helpers/fidelity.mjs";
import { architectureStageSubmission, createArchitectureStageSessionFactory } from "./helpers/architecture-stages.mjs";
import type { AcceptanceStage,AcceptanceVerification } from "../src/contracts/verification.mjs";
import type { ArchitectureBase } from "../src/contracts/architecture.mjs";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const facts = () => ({ runtimeCapabilities: runtimeCapabilityContract(), acceptanceAdapterGuide: ACCEPTANCE_ADAPTER_GUIDE });
const claim = (overrides: Partial<PlatformClaim> = {}): PlatformClaim => ({ id: "dependency", source: "acceptanceAdapterGuide", path: "/adapters/action/executionFacts/dynamicPlaceholders",
  expected: false, decisionIds: ["runtime"], acceptanceIds: [], ...overrides });
function fixture() {
  const draft = validDraft();
  draft.taskSpec = { version: 1, items: [{ id: "full", dimension: "processing", content: "完整核对全部记录", applicability: "applies", critical: true,
    source: { kind: "user", evidence: [{ messageId: "source", quote: "完整核对全部记录" }] } }] };
  const requirements = requirementItems(draft), context = { requirements, draft, ...facts() };
  const design: Extract<ArchitectureDesign, { schemaVersion: 3 }> = validDesign(requirements, { schemaVersion: 3, connections: [], interaction: { defaultEntry: "conversation", page: false,
    operations: false, inputs: "全部记录", results: "完整文本", persistentData: "无" }, execution: { language: "none", hosting: "builtin", reason: "复用现有文本能力" },
    selectionBasis: { capacity: "核对完整输入", process: "完整处理", quality: "不编造", requirementIds: requirements.map(row => row.id), assumptions: [] } });
  return { design, context, draft, requirements };
}

test("v3可选显式声明与原schema及语义同源，旧方案不补字段且旧版本不接受新声明", () => {
  const f = fixture(), before = designHash(f.design), validate = new Ajv({ strict: false }).compile(designSubmissionSchema(f.draft));
  assert.equal(validate(f.design), true); assert.doesNotThrow(() => validateDesign(f.design, f.context));
  assert.equal(designHash(f.design), before); assert.equal(Object.hasOwn(f.design, "platformClaims"), false);
  f.design.platformClaims = [claim()]; assert.equal(validate(f.design), true);
  assert.doesNotThrow(() => validateDesign(f.design, f.context));
  const legacy = validDesign(f.requirements, { platformClaims: [claim()] });
  assert.equal(validate(legacy), false); assert.throws(() => validateDesign(legacy, f.context));
  const v2 = { ...f.design, schemaVersion: 2 }; assert.equal(validate(v2), false); assert.throws(() => validateDesign(v2, f.context));
});

test("能力false被宣称true、错误上限和单位使用相同路径值规则阻断，不按业务关键词", () => {
  const f = fixture();
  const bad = [claim({ expected: true }), claim({ source: "runtimeCapabilities", path: "/admission/actionValueBytes", expected: 1 }),
    claim({ source: "runtimeCapabilities", path: "/admission/measure", expected: "UTF-16 characters" })];
  for (const item of bad) {
    f.design.platformClaims = [item];
    assert.throws(() => validateDesign(f.design, f.context), (error: TestFailure) => error.validationIssue!.reason === "platform_fact_mismatch"
      && error.validationIssue!.path === "design.platformClaims[0].expected");
  }
  const changedIndustry = { ...f.design, instructions: "整理仓库货品，不包含报销或访谈关键词", platformClaims: [claim({ expected: true })] };
  assert.throws(() => validateDesign(changedIndustry, f.context), (error: TestFailure) => error.validationIssue!.reason === "platform_fact_mismatch");
  const unrelatedCapability = { runtimeCapabilities: { capability: { canPublish: false } }, acceptanceAdapterGuide: {} };
  assert.throws(() => validateArchitecturePlatformClaims({ ...f.design, platformClaims: [claim({ source: "runtimeCapabilities", path: "/capability/canPublish", expected: true })] }, unrelatedCapability),
    (error: TestFailure) => error.validationIssue!.reason === "platform_fact_mismatch");
});

test("只读批查返回宿主实际值和来源摘要，匹配false不新增权限且不修改材料", async () => {
  const context = facts(), before = structuredClone(context), tool = createPlatformContractTool(context);
  const query = { requests: [claim(), claim({ expected: true }), claim({ source: "runtimeCapabilities", path: "/admission/actionValueBytes", expected: context.runtimeCapabilities.admission.actionValueBytes })]
    .map(({ source, path, expected }) => ({ source, path, expected })) };
  const output = JSON.parse(String(toolText((await tool.execute("query", query)))));
  assert.equal(output.grantsCapability, false); assert.deepEqual(recordArray(output.results).map((row) => row.matches), [true, false, true]);
  assert.equal(output.results[0].actual, false); assert.equal(output.results[0].sourceHash, digest(context.acceptanceAdapterGuide));
  assert.equal(output.results[2].actual, context.runtimeCapabilities.admission.actionValueBytes);
  assert.deepEqual(context, before);
  await assert.rejects(tool.execute("query", { requests: [{ ...query.requests[0]!, sourceHash: "a".repeat(64) }] }));
  await assert.rejects(tool.execute("query", { requests: [query.requests[0]] }, AbortSignal.abort()), { name: "AbortError" });
});

test("不存在的路径、原型路径、关联外部编号和陈旧摘要保守拒绝，诊断不回显坏值", async () => {
  const f = fixture(), sentinel = "PRIVATE_UNTRUSTED_SENTINEL";
  for (const path of [`/${sentinel}`, "/__proto__/secret", "/adapters/action/executionFacts/missing"]) {
    f.design.platformClaims = [claim({ path })];
    assert.throws(() => validateDesign(f.design, f.context), (error: TestFailure) => error.validationIssue!.reason === "platform_path_missing"
      && !JSON.stringify(error.diagnostic ?? error.validationIssues).includes(sentinel) && !error.message.includes(sentinel));
  }
  for (const overrides of [{ decisionIds: [], acceptanceIds: [] }, { decisionIds: [sentinel] }, { acceptanceIds: [sentinel] }]) {
    f.design.platformClaims = [claim(overrides)]; assert.throws(() => validateDesign(f.design, f.context), (error: TestFailure) => error.validationIssue!.reason === "invalid_reference");
  }
  const stale = facts(); stale.runtimeCapabilities.admission.actionValueBytes++;
  f.design.platformClaims = [claim({ source: "runtimeCapabilities", path: "/admission/actionValueBytes", expected: stale.runtimeCapabilities.admission.actionValueBytes })];
  assert.throws(() => validateDesign(f.design, { ...f.context, ...stale }), (error: TestFailure) => error.validationIssue!.reason === "platform_source_stale");
  const context = architectureReviewEvidenceContext({ design: f.design, requirements: f.requirements, runtimeCapabilities: f.context.runtimeCapabilities });
  context.contextManifest!.acceptanceAdapterGuide!.sha256 = "0".repeat(64);
  const result = JSON.parse(String(toolText((await createPlatformContractTool(context).execute("stale", { requests: [{ source: "acceptanceAdapterGuide", path: claim().path, expected: false }] })))));
  assert.equal(result.results[0].reason, "platform_source_stale"); assert.equal(result.results[0].matches, false);
});

test("字面computed文本不是能力宣称，不误拒普通业务文字；已声明值仍严格检查", () => {
  const f = fixture(); f.design.instructions += " 输出用户输入的<computed-result-json>原文，不做动态替换。";
  assert.doesNotThrow(() => validateDesign(f.design, f.context));
  assert.equal(resolveTestJson(JSON.stringify("<computed-result-json>")).value, "<computed-result-json>");
  f.design.platformClaims = [claim({ expected: false })]; assert.doesNotThrow(() => validateDesign(f.design, f.context));
  f.design.platformClaims[0]!.expected = true;
  assert.throws(() => validateDesign(f.design, f.context), (error: TestFailure) => error.validationIssue!.reason === "platform_fact_mismatch");
});

test("只允许有界标量/小列表，不调用源访问器或读取未允许来源", async () => {
  const context = { runtimeCapabilities: { enabled: [true, false, "bytes", 12] }, acceptanceAdapterGuide: {} };
  const tool = createPlatformContractTool(context), response = JSON.parse(String(toolText((await tool.execute("list", { requests: [{ source: "runtimeCapabilities", path: "/enabled", expected: [true, false, "bytes", 12] }] })))));
  assert.equal(response.results[0].matches, true);
  let invoked = false; const bad = { acceptanceAdapterGuide: {} };
  Object.defineProperty(bad, "runtimeCapabilities", { enumerable: true, get() { invoked = true; throw new Error("private source"); } });
  const unavailable = JSON.parse(String(toolText((await createPlatformContractTool(bad).execute("safe", { requests: [{ source: "runtimeCapabilities", path: "/enabled", expected: true }] })))));
  assert.equal(unavailable.results[0].reason, "platform_source_unavailable"); assert.equal(invoked, false);
  await assert.rejects(tool.execute("bad", { requests: [{ source: "secrets", path: "/apiKey", expected: true }] }));
  await assert.rejects(tool.execute("bad", { requests: [{ source: "runtimeCapabilities", path: "/enabled", expected: Array(17).fill(true) }] }));
});

test("控制器在模块保存前拒绝错误声明，原模块会话核对并纠正后才整合及独立评审", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "neuma-platform-claims-")), order: ((string) | ("designer" | "reviewer"))[] = [], { draft } = fixture();
  let queryCount = 0, sourceHash: unknown, candidate: ReturnType<typeof fixture>["design"];
  const stages = createArchitectureStageSessionFactory((payload) => {
    candidate = fixture().design;
    candidate.coverage = payload.requirements.map((row) => ({ requirementId: fixtureText(objectFields(row).id), componentIds: ["summarize"], verification: fixtureText(objectFields(row).text) }));
    candidate.platformClaims = [claim({ expected: false })];
    return candidate;
  }, { onPrompt: async ({ stage, payload, options, tools }) => {
    order.push(stage);
    if (stage !== "module") return;
    assert.ok(tools.check_platform_contract); assert.ok(options.rawInputValidators!.check_platform_contract);
    const bad = structuredClone(candidate); bad.platformClaims![0]!.expected = true;
    const submission = architectureStageSubmission({ tools, payload, candidate: bad });
    await assert.rejects(submission!.tool!.execute("false-capability", submission!.args!), (error: TestFailure) => error.validationIssue!.reason === "platform_fact_mismatch");
    assert.deepEqual(order, ["blueprint", "module"]);
    const row = JSON.parse(String(toolText((await tools.check_platform_contract.execute("actual", { requests: [{ source: claim().source,
      path: claim().path, expected: true }] }))))).results[0];
    queryCount++; sourceHash = row.sourceHash; assert.equal(row.actual, false); assert.equal(row.matches, false);
  } });
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: join(root, "data"), sessionFactory: async (options) => {
    const stage = await stages(options); if (stage) return stage;
    const tools = fixtureTools(options.customTools!), role = tools.submit_architecture ? "designer" : "reviewer";
    return { messages: [] as SessionMessage[], modelCallAccounting: true, subscribe: () => () => {}, async abort() {}, dispose() {}, async prompt(text) {
      await callFixture(options.onModelCall!, options, []);
      const payload = JSON.parse(String(text)); order.push(role);
      assert.ok(tools.check_platform_contract); assert.ok(options.rawInputValidators!.check_platform_contract);
      assert.equal(role, "reviewer");
      return tools.submit_architecture_review!.execute("review", passingReview(payload.candidateHash, payload.design, payload.priorFindings));
    } };
  }, fidelitySessionFactory: async (options) => ({ messages: [] as SessionMessage[], modelCallAccounting: true, subscribe: () => () => {},
    setAutoCompactionEnabled() {}, async abort() {}, dispose() {}, async prompt(text) {
      await callFixture(options.onModelCall!, options, []); return fixtureToolAt(options.customTools).execute("fidelity", fidelityResult(JSON.parse(String(text))));
    } }) });
  t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  const record = await designer.design({ id: "claims", name: "显式事实依赖", fingerprint: "same-source", draft });
  assert.equal(record.status, "passed"); assert.deepEqual(order, ["blueprint", "module", "integration", "reviewer"]); assert.equal(queryCount, 1);
  assert.equal(objectFields(objectFields(record.designProgressCheckpoint!.modules)[0]).modelCalls, 1, "错误声明在原模块会话修正，不能启动替代节点或额外领取轮次");
  assert.equal(objectFields(objectFields(objectFields(objectFields(objectFields(record.designProgressCheckpoint!.modules)[0]).result).platformClaims)[0]).expected, false, "错误声明不得先保存为已完成模块");
  assert.equal(sourceHash, digest(ACCEPTANCE_ADAPTER_GUIDE)); assert.equal(record.design!.platformClaims![0]!.expected, false);
});
