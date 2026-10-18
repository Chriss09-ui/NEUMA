import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchitectureDesigner } from "../src/architecture/architecture.mjs";
import { requirementItems, validateDesign, validateReview, designHash } from "../src/architecture/architecture-contract.mjs";
import { claimRequirementHandoff, newConsultation, validatePreflight } from "../src/requirements/consultation.mjs";
import { substantiveRequirementHash } from "../src/requirements/task-spec.mjs";
import { processTurn } from "../src/requirements/core.mjs";
import { validDraft, validDesign, passingReview } from "./helpers/architecture.mjs";
import { sufficientPreflight } from "./helpers/consultation.mjs";

function sourceDraft() {
  return { ...validDraft("逐项核对材料并输出完整清单"), taskSpec: { version: 1, items: [{ id: "full_coverage", dimension: "processing",
    content: "逐项覆盖全部输入，不能只给代表性样本", applicability: "applies", critical: true,
    source: { kind: "user", evidence: [{ messageId: "source", quote: "逐项覆盖全部输入" }] } }] } };
}
function design(requirements) {
  return validDesign(requirements, { schemaVersion: 3, interaction: { defaultEntry: "conversation", page: false, operations: false,
    inputs: "本轮明确的小型材料", results: "完整清单", persistentData: "不需要保存业务历史" }, connections: [],
  execution: { language: "none", hosting: "builtin", reason: "本测试的固定输入使用已有工具" },
  selectionBasis: { capacity: "测试使用固定小型材料", process: "逐项处理并核对全量覆盖", quality: "结果与每项输入逐一对应",
    requirementIds: requirements.map((item) => item.id), assumptions: [] } });
}
function review(hash) {
  const value = passingReview(hash);
  value.checks.push(...["requirement_sufficiency", "acceptance_quality"].map((id) => ({ id, passed: true, evidence: "已核对来源与可区分的交付标准" })));
  return value;
}
async function fixture(t, action) {
  const root = await mkdtemp(join(tmpdir(), "neuma-architecture-consultation-")), calls = [];
  const designer = new ArchitectureDesigner({ config: { llmConfigured: true }, cwd: root, dataDir: root,
    sessionFactory: async ({ customTools }) => {
      const tools = Object.fromEntries(customTools.map((tool) => [tool.name, tool]));
      const role = tools.submit_architecture ? "designer" : "reviewer";
      return { subscribe: () => () => {}, messages: [], dispose() {}, async abort() {},
        async prompt(text) { const payload = JSON.parse(text); calls.push({ role, payload });
          await action({ role, payload, tools, submit: (value) => tools[role === "designer" ? "submit_architecture" : "submit_architecture_review"].execute("submit", value) }); } };
    } });
  t.after(async () => { await designer.persistence; await rm(root, { recursive: true, force: true }); });
  const draft = sourceDraft(), definition = { id: "agent", name: "核对助手", draft, fingerprint: "frozen_requirements" };
  return { designer, calls, definition };
}

test("新任务规格必须进入v3选型、覆盖和验收，旧schema和遗漏不能通过", () => {
  const draft = sourceDraft(), requirements = requirementItems(draft), candidate = design(requirements);
  const specId = requirements.find((item) => item.text.includes("任务要求 full_coverage")).id;
  assert.match(specId, /^spec_/); assert.doesNotThrow(() => validateDesign(candidate, { draft, requirements }));
  assert.throws(() => validateDesign(validDesign(requirements), { draft, requirements }), /v3/);
  const missingCoverage = structuredClone(candidate); missingCoverage.coverage = missingCoverage.coverage.filter((item) => item.requirementId !== specId);
  assert.throws(() => validateDesign(missingCoverage, { draft, requirements }), /未被设计覆盖/);
  const missingAcceptance = structuredClone(candidate);
  for (const item of missingAcceptance.acceptance) item.requirementIds = item.requirementIds.filter((id) => id !== specId);
  assert.throws(() => validateDesign(missingAcceptance, { draft, requirements }), /验收/);
});

test("v3独立评审必须含需求充分性与验收质量，不能沿用旧六项通过", () => {
  const hash = designHash(design(requirementItems(sourceDraft())));
  assert.throws(() => validateReview(passingReview(hash), { candidateHash: hash, schemaVersion: 3 }), /requirement_sufficiency/);
  assert.equal(validateReview(review(hash), { candidateHash: hash, schemaVersion: 3 }).checks.length, 8);
  const failed = review(hash); failed.checks.find((item) => item.id === "acceptance_quality").passed = false;
  assert.throws(() => validateReview(failed, { candidateHash: hash, schemaVersion: 3 }), /不能判定 pass/);
});

for (const returningRole of ["designer", "reviewer"]) test(`${returningRole}可正式返需，交接持久绑定需求和架构版本，补充后重新确认`, async (t) => {
  const f = await fixture(t, async ({ role, payload, tools, submit }) => {
    if (role === returningRole) return tools.request_requirements.execute("return", { issues: [{ id: "scale", question: "通常每批有多少份材料？",
      impact: "决定处理批次和失败恢复方式", requirementIds: ["inputSource"] }] });
    return submit(role === "designer" ? design(payload.requirements) : review(payload.candidateHash));
  });
  const result = await f.designer.design(f.definition);
  assert.equal(result.status, "needs_input"); assert.equal(result.delivery, "blocked");
  assert.equal(result.handoff.requirementHash, substantiveRequirementHash(f.definition.draft));
  assert.equal(result.handoff.architectureVersion, result.version);
  assert.deepEqual((await f.designer.get("agent")).handoff, result.handoff);
  assert.deepEqual(f.calls.map((item) => item.role), returningRole === "designer" ? ["designer"] : ["designer", "reviewer"]);
  const consultation = newConsultation(); consultation.evidenceMessages.push({ id: "source", role: "user", content: "逐项覆盖全部输入" });
  const claimed = claimRequirementHandoff({ agentId: "agent", draft: f.definition.draft, version: 1, confirmed: true,
    status: "needs_build", consultation }, result.handoff);
  assert.equal(claimed.confirmed, false); assert.equal(claimed.question, "通常每批有多少份材料？");
  const changed = structuredClone(claimed.draft); changed.inputSource.value += "；每批五十份";
  let seenHandoff;
  const answer = await processTurn({ message: "每批五十份", draft: claimed.draft, consultation: claimed.consultation, lastQuestion: claimed.lastQuestion },
    { generateDraft: async () => ({ draft: changed, proposedGap: "none", question: "" }), preflight: async (input) => { seenHandoff = input.handoff; return sufficientPreflight(); } },
    { enforceConsultation: true, requestId: "answer", platform: {} });
  assert.equal(seenHandoff.id, result.handoff.id); assert.equal(answer.status, "ready"); assert.equal(answer.confirmed, false);
  assert.equal(answer.consultation.handoff.resolved, true);
  const confirmed = await processTurn({ message: "确认", draft: answer.draft, consultation: answer.consultation,
    lastQuestion: answer.confirmationQuestion }, {}, { enforceConsultation: true, requestId: "confirm", platform: {} });
  assert.equal(confirmed.confirmed, true);
});

test("正式返需不能引用不存在的要求，也不能写成方案通过", async (t) => {
  const f = await fixture(t, async ({ tools }) => tools.request_requirements.execute("bad", { issues: [
    { id: "invented", question: "凭空提出的问题", impact: "无需求依据", requirementIds: ["missing_requirement"] },
  ] }));
  await assert.rejects(f.designer.design(f.definition), /返需|架构/);
  assert.notEqual((await f.designer.get("agent")).status, "passed");
});

test("完整v3设计经八项独立评审通过；正式任务规格引用也可在预评估中继续核对", async (t) => {
  const f = await fixture(t, async ({ role, payload, submit }) => submit(role === "designer" ? design(payload.requirements) : review(payload.candidateHash)));
  const result = await f.designer.design(f.definition);
  assert.equal(result.status, "passed"); assert.equal(result.review.checks.length, 8); assert.equal(result.delivery, "blocked");
  const preflight = await sufficientPreflight(), specId = result.requirements.find((item) => item.id.startsWith("spec_")).id;
  preflight.dimensionChecks.find((item) => item.dimension === "processing").requirementIds = [specId];
  assert.doesNotThrow(() => validatePreflight(preflight, f.definition.draft));
});
