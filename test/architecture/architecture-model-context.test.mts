import { objectFields } from "../../src/runtime/type-boundary.mjs";
import type { EvidenceMessage } from "../../src/contracts/requirements.mjs";
import { fixtureString } from "../helpers/http-model.mjs";
import { callFixture, recordArray, toolText } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { architectureModelContext, architectureNodePrompt, verificationModelContext, projectArchitectureMessages } from "../../src/architecture/architecture-model-context.mjs";
import { createModelContextReader } from "../../src/runtime/model-context.mjs";
import { requirementMessageContext } from "../../src/requirements/providers.mjs";
import { createArchitectureMaterialFiles } from "../../src/architecture/architecture-material-files.mjs";
import { mkdtemp, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("评审只投递位置，真实资料文件分页可读；旧报告原文保留，错路径与文件变更拒绝", async t => {
  const directory = await mkdtemp(join(tmpdir(), "neuma-review-materials-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const candidate = { components: [{ purpose: "说明😀".repeat(5000) }] };
  const source = { candidate, design: candidate, requirements: [{ id: "r", text: "全部处理" }],
    distributedReview: { issues: [{ description: "核对组件", references: [{ source: "candidate", path: "/components", quote: "旧原文" }] }] } };
  const before = structuredClone(source), files = createArchitectureMaterialFiles(directory), catalog = await files.publish(source);
  const parallel = await Promise.all(Array.from({ length: 3 }, () => createArchitectureMaterialFiles(join(directory, "parallel")).publish({ candidate, requirements: source.requirements })));
  assert.ok(parallel.every(entries => entries.find(entry => entry.file === "candidate.json")!.path === parallel[0]!.find(entry => entry.file === "candidate.json")!.path));
  const packet = architectureModelContext(source, { role: "reviewer", materialFiles: catalog });
  assert.equal(packet.design, undefined); assert.equal(packet.requirements, undefined);
  assert.doesNotMatch(JSON.stringify(packet), /旧原文|说明😀/);
  assert.deepEqual(recordArray(objectFields(packet.distributedReview).issues)[0]!.references, [{ file: "candidate.json", path: "/components" }]);
  let request: Record<string, unknown> = { file: "candidate.json", path: "/components" }, complete = "", pages = 0;
  do {
    const output = JSON.parse(toolText(await files.tool.execute("read", { requests: [request] })));
    const row = output.results[0]; assert.equal(row.error, undefined);
    complete += row.text; pages++; request = row.nextRequest;
  } while (request);
  assert.ok(pages > 1); assert.deepEqual(JSON.parse(complete), candidate.components);
  assert.deepEqual(source, before);
  const reportFile = catalog.find(item => item.file === "distributedReview.json")!;
  assert.match(await readFile(reportFile.path, "utf8"), /旧原文/);
  await assert.rejects(files.tool.execute("outside", { requests: [{ file: "/tmp/not-in-this-task.json" }] }), /不在当前节点目录/);
  const missing = JSON.parse(toolText(await files.tool.execute("missing", { requests: [{ file: "candidate.json", path: "/missing" }] })));
  assert.equal(missing.results[0].error.reason, "path_missing");
  const entry = catalog.find(item => item.file === "candidate.json")!;
  await chmod(entry.path, 0o600); await writeFile(entry.path, '{"changed":true}');
  await assert.rejects(files.tool.execute("changed", { requests: [{ file: "candidate.json" }] }), /已变化/);
});

test("蓝图主要能力与后续义务直接给齐，完整方案结构不会冒充本阶段提交结构", () => {
  const source = { pipelineStage: "blueprint", requirements: [{ id: "r", text: "交互演示" }],
    capabilities: [{ id: "write_workspace_file", status: "available", scope: "保存UTF-8文本" }],
    candidateSchema: { properties: { profile: { type: "string" }, execution: { type: "object" } } },
    stageSchema: { properties: { global: { type: "object" }, modules: { type: "array" } } },
    stageContract: { submitName: "submit_architecture_blueprint", fields: ["global", "modules"], source: "tool_parameters" },
    deferredVerifications: { issues: [{ id: "v", stage: "development", resolution: { reason: "交付前核对数值基准，浏览器交互另行验收。", audit: "不重复提供的审计原文" } }] } };
  const packet = objectFields(architectureModelContext(source, { role: "designer" }));
  assert.deepEqual(packet.capabilities, source.capabilities);
  assert.equal(objectFields(packet.platformOverview).capabilities, undefined);
  assert.equal(recordArray(packet.contextIndex).some(row => row.section === "capabilities"), false);
  assert.deepEqual(recordArray(packet.deferredObligations)[0]!.resolution, { reason: source.deferredVerifications.issues[0]!.resolution.reason });
  assert.equal(recordArray(packet.contextIndex).some(row => row.section === "candidateSchema"), false);
  const index = recordArray(packet.contextIndex).find(row => row.section === "stageSchema");
  assert.deepEqual(index!.propertyKeys, ["global", "modules"]);
  assert.deepEqual(packet.stageContract, source.stageContract);
  assert.match(fixtureString(index!.scope), /本阶段/);
  assert.equal(objectFields(verificationModelContext(source)).deferredObligations, undefined);
});

test("模块只收到职责与主要事实，完整指南、结构和历史可以精确按需读取", async () => {
  const source = { pipelineStage: "module", blueprintProtocol: "module-boundaries-v2",
    dependencyInterfaces: [{ moduleId: "upstream", components: [{ id: "parser", outputs: "公式结构" }], steps: [{ id: "parse", output: "解析结果" }] }],
    requirements: [{ id: "r", text: "返回全部结果" }], assignment: { id: "m", requirementIds: ["r"] },
    blueprint: { global: { interaction: { page: false } } }, candidateSchema: { description: "schema".repeat(3000) },
    evidence: [{ id: "e", excerpt: "历史核实全文".repeat(1000) }], roleGuide: "详细规程".repeat(1000),
    capabilities: [{ id: "write", status: "available" }], deferredVerifications: { issues: [{ id: "v", stage: "runtime", question: "实际浏览器交互待验", verification: "旧测量".repeat(1000) }] } };
  const original = structuredClone(source), packet = objectFields(architectureModelContext(source, { role: "specialist" }));
  assert.deepEqual(packet.requirements, source.requirements);
  assert.deepEqual(packet.blueprint, source.blueprint);
  assert.equal(packet.blueprintProtocol, source.blueprintProtocol);
  assert.deepEqual(packet.dependencyInterfaces, source.dependencyInterfaces);
  assert.equal(recordArray(packet.deferredObligations)[0]!.question, "实际浏览器交互待验");
  assert.equal(packet.candidateSchema, undefined); assert.equal(packet.evidence, undefined); assert.equal(packet.roleGuide, undefined);
  assert.ok(JSON.stringify(packet).length < JSON.stringify(source).length / 3);
  const tool = createModelContextReader(() => source);
  const result = JSON.parse(toolText((await tool.execute("read", { requests: [{ section: "deferredVerifications", pointer: "/issues/0/verification", limit: 8000 }] }))));
  assert.equal(JSON.parse(result.results[0].text), source.deferredVerifications.issues[0]!.verification);
  assert.deepEqual(source, original);
});

test("恢复只投递目录和进度，原稿仍保留；续轮不重抄已接受行或重复来源", () => {
  const source = { design: { acceptance: [{ id: "a", expected: "全部结果" }] }, requirements: [{ id: "r", text: "全部结果" }], draft: { original: "需求" },
    requirement: { original: "需求" }, contextManifest: { candidate: { delivery: "full", characters: 30, sha256: "a".repeat(64) } },
    reviewParts: { progressHash: "p", rejectedPartsHash: "q", saved: { checks: [{ id: "r", passed: true }] }, rejectedDraft: { checks: [{ id: "r", passed: false }] } },
    latestRejectedInput: { toolName: "submit", input: { checks: [{ id: "r", passed: false, reason: "待修" }] } } };
  const packet = objectFields(architectureModelContext(source, { role: "reviewer" }));
  assert.equal(packet.design, undefined); assert.equal(packet.latestRejectedInput, undefined);
  assert.ok(recordArray(packet.contextIndex).some(row => row.section === "latestRejectedInput"));
  assert.equal(objectFields(packet.reviewParts).saved, undefined); assert.equal(objectFields(packet.reviewParts).rejectedDraft, undefined);
  assert.equal(objectFields(packet.reviewParts).rejectedPartsHash, "q");
  assert.equal(packet.draft, undefined); assert.equal(packet.requirement, undefined);
  assert.equal(packet.contextManifest, undefined); assert.equal(objectFields(objectFields(packet.sourceManifest).candidate).delivery, undefined);
  const next = objectFields(architectureModelContext({ type: "review_batch", reviewParts: source.reviewParts, modelBudget: { remaining: 2 } }, { role: "reviewer", continuation: true }));
  assert.equal(objectFields(next.reviewParts).saved, undefined); assert.equal(objectFields(next.reviewParts).progressHash, "p");
  assert.deepEqual(next.modelBudget, { remaining: 2 });
});

test("范围复核通过目录读取候选及已确认来源，目录不冒充已投递全文", () => {
  const source = { contextHash: "hash", requirements: [{ id: "r", text: "保留所有合法输入" }], candidate: { acceptance: [{ expected: "边界也须正确" }] },
    confirmedRequirementContext: { sourceQuotes: [{ quote: "原话" }] }, runtimeCapabilities: { limits: { input: 12 } } };
  const packet = objectFields(verificationModelContext(source));
  assert.equal(packet.candidate, undefined); assert.equal(packet.requirements, undefined);
  assert.equal(packet.confirmedRequirementContext, undefined);
  assert.ok(recordArray(packet.contextIndex).some(row => row.section === "candidate"));
  assert.equal(packet.contextHash, "hash"); assert.equal(packet.runtimeCapabilities, undefined);
  assert.equal(recordArray(packet.contextIndex).find(row => row.section === "runtimeCapabilities")!.delivery, "paged");
  assert.match(architectureNodePrompt({ role: "reviewer", submitName: "submit_architecture_review" }), /被拒内容当作接受结果/);
});

test("需求消息去重只去掉已存在的副本，保留同文不同ID的证据和未收录补充", () => {
  const evidenceMessages: EvidenceMessage[] = [{ id: "u1", role: "user", content: "全部保留" }, { id: "a1", role: "assistant", content: "范围？" },
    { id: "u2", role: "user", content: "全部保留" }];
  const context = objectFields(requirementMessageContext({ message: "全部保留", lastQuestion: "范围？", userMessages: ["全部保留", "额外事实"], evidenceMessages }));
  assert.equal(context.latestUserMessageId, "u2"); assert.equal(context.lastQuestionMessageId, "a1");
  assert.equal(context.latestUserMessage, undefined); assert.deepEqual(context.userMessages, ["额外事实"]);
  assert.equal(evidenceMessages.length, 3);
  assert.equal(requirementMessageContext({ message: "新消息", lastQuestion: "范围？", userMessages: [], evidenceMessages }).latestUserMessage, "新消息");
});

test("旧绑定会话在请求前精简，原消息与工具调用顺序保持且投影可重复", () => {
  const messages = [{ role: "user", content: JSON.stringify({ modelBudget: { limit: 5 }, requirements: [{ id: "r", text: "完整要求" }], candidateSchema: { large: "x".repeat(10000) } }) },
    { role: "assistant", content: [{ type: "toolCall", name: "save", id: "c", arguments: {} }] },
    { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "原始错误" }] },
    { role: "user", content: [{ type: "text", text: JSON.stringify({ type: "review_batch", modelBudget: { limit: 5 }, reviewParts: { progressHash: "p", saved: { checks: "old".repeat(5000) } } }) }] }];
  const before = structuredClone(messages), options = { role: "reviewer", roleGuide: "规则" }, projected = callFixture(projectArchitectureMessages, undefined, [messages, options]);
  assert.deepEqual(messages, before);
  assert.equal(JSON.parse(fixtureString(objectFields(projected[0]).content)).candidateSchema, undefined);
  assert.equal(JSON.parse(toolText(projected[3]!)).reviewParts.saved, undefined);
  assert.equal(projected[1], messages[1]); assert.equal(projected[2], messages[2]);
  assert.deepEqual(projectArchitectureMessages(projected, options), projected);
});
