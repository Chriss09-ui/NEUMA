import { callFixture } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DESIGN_PROMPT, REVIEW_PROMPT, REVIEW_REVISION_PROMPT, SPECIALIST_PROMPT,
  renderArchitectureReviewPrompt } from "../src/architecture/architecture-prompts.mjs";
import { HANDOFF_POLICY } from "../src/architecture/architecture-handoff-verification.mjs";
import { ACCEPTANCE_ADAPTER_GUIDE } from "../src/verification/acceptance-contract.mjs";

test("设计、顾问、修订和两种评审区分执行依赖与验收义务，保留真实缺口和验证边界", () => {
  for (const prompt of [DESIGN_PROMPT, SPECIALIST_PROMPT, REVIEW_REVISION_PROMPT, REVIEW_PROMPT,
    renderArchitectureReviewPrompt({ batchMode: true })]) {
    assert.match(prompt, /capabilities只记录当前执行路径实际要调用的工具、连接或专属代码能力/);
    assert.match(prompt, /受平台支持的实现路径、需研发的专属代码用needs_development/);
    assert.match(prompt, /单纯待验收的效果保留在unknowns及适用的acceptance或后续验证义务中/);
    assert.match(prompt, /保留原需求引用、验证阶段、具体证据和失败处置/);
    assert.match(prompt, /不能伪改为available、删除验收或修改程序blocking标记/);
    assert.match(prompt, /真实缺失的必需引擎、浏览器自动执行工具、接口或权限仍须阻断/);
    assert.match(prompt, /评审者只指出当前实际字段及保留义务的修正建议，不修改候选/);
  }
});

test("设计、完整评审与分批评审保留页面共享逻辑真实执行及其适用边界", () => {
  const adapter = ACCEPTANCE_ADAPTER_GUIDE.adapters["page-resources"];
  assert.equal(adapter!.executionFacts!.generatedCode, "page-node-check");
  assert.match(adapter!.executionRule!, /真实运行独立Node检查程序/);
  assert.match(adapter!.executionRule!, /页面共享纯逻辑/);
  for (const prompt of [DESIGN_PROMPT, REVIEW_PROMPT, renderArchitectureReviewPrompt({ batchMode: true })]) {
    assert.match(prompt, /page-resources的node-check在隔离Node中真实执行独立检查程序/);
    assert.match(prompt, /对冻结输入执行数值、边界和分支断言/);
    assert.match(prompt, /不能因断言涉及计算或动态分支就一律要求改为action/);
    assert.match(prompt, /必须有实际托管页面，下载HTML文件不等于托管页面，无页面不得使用/);
    assert.match(prompt, /不提供业务ctx、用户文件或状态，不调用公开动作，不填actionId或mocks/);
    assert.match(prompt, /不证明浏览器DOM、布局、交互或视觉效果/);
    assert.doesNotMatch(prompt, /page-resources的静态检查|共享逻辑静态检查/);
  }
});

test("返需只针对需求本身不清楚，技术问题不返回用户", () => {
  for (const prompt of [HANDOFF_POLICY, DESIGN_PROMPT, REVIEW_PROMPT, renderArchitectureReviewPrompt({ batchMode: true })]) {
    assert.match(prompt, /需求本身仍不清楚|需求原文仍未写明/);
    assert.match(prompt, /技术问题|技术核实/);
  }
  assert.match(DESIGN_PROMPT, /禁止返回给用户/);
  assert.match(HANDOFF_POLICY, /技术问题禁止返回用户/);
  assert.doesNotMatch(DESIGN_PROMPT, /保留阻断或正式返需/);
});

test("完整评审路径原文兼容，分批模式不再同时要求先修整份旧稿", () => {
  assert.equal(renderArchitectureReviewPrompt(), REVIEW_PROMPT);
  assert.equal(renderArchitectureReviewPrompt({ batchMode: false }), REVIEW_PROMPT);
  const batch = renderArchitectureReviewPrompt({ batchMode: true });
  assert.notEqual(batch, REVIEW_PROMPT);
  assert.match(batch, /最新宿主reviewParts\.batch决定本次任务/);
  assert.match(batch, /完整材料供本批依赖查证，不要求先遍历其他编号/);
  assert.match(batch, /reviewParts\.saved和reviewDraft是未通过的参考/);
  assert.doesNotMatch(batch, /存在reviewDraft时，先继续这份尚未接受的完整评审/);
  assert.doesNotMatch(batch, /必须在decisions\.choice、steps和unknowns消除/);
  assert.throws(() => callFixture(renderArchitectureReviewPrompt, undefined, [{ batchMode: "true" }]), TypeError);
  const retried = renderArchitectureReviewPrompt({ batchMode: true, modelCallLimit: 7 });
  assert.match(retried, /保留原5次用量，最多追加2次/u);
  assert.match(retried, /范围复核计入本次7轮/u);
  assert.doesNotMatch(retried, /原5轮/u);
  const testRetry = renderArchitectureReviewPrompt({ batchMode: true, modelCallLimit: 9 });
  assert.match(testRetry, /修复后的测试续评，保留原7次用量，最多追加2次/u);
  assert.match(testRetry, /范围复核计入本次9轮/u);
  const continuation = renderArchitectureReviewPrompt({ batchMode: true, modelCallLimit: 14, additionalCalls: 5 });
  assert.match(continuation, /保留原9次用量，最多追加5次/u);
  assert.match(continuation, /范围复核计入本次14轮/u);
  assert.throws(() => renderArchitectureReviewPrompt({ modelCallLimit: 8 }), TypeError);
});

test("完整与分批评审要求逐条关闭依据，并支持用未通过草稿只修错误行", () => {
  for (const prompt of [REVIEW_PROMPT, renderArchitectureReviewPrompt({ batchMode: true })]) {
    assert.match(prompt, /声明处理五条就逐条提供五条对应依据/u);
    assert.match(prompt, /candidatePath指出缺少对应关系的具体候选条款/u);
    assert.match(prompt, /rejectedDraft是尚未通过的规范化分项草稿，与saved分开/u);
    assert.match(prompt, /仅重交需要修正的行/u);
    assert.match(prompt, /未重交的草稿行会一起重验/u);
    assert.match(prompt, /保存失败或额度耗尽不增加调用/u);
    assert.match(prompt, /引用优先只提交\{source,path\}/u);
    assert.match(prompt, /以findingRef代替findingId/u);
    assert.match(prompt, /blocking:true只能关联passed:false/u);
    assert.match(prompt, /空列表\[\]表示未额外指定操作，不等于候选布尔字段operations=false/u);
  }
});

test("保存阶段只处理已派发编号，关联检查延后而不代填", () => {
  const batch = renderArchitectureReviewPrompt({ batchMode: true });
  assert.match(batch, /stage=save时，仅保存本批真实行及必要issues/);
  assert.match(batch, /不提交verdict或summary/);
  assert.match(batch, /只有宿主确认真实保存后才处理下一批/);
  assert.match(batch, /仅当本批acceptanceScopeChecks含编号时/);
  assert.match(batch, /尚未派发的checks不提前代填/);
  assert.match(batch, /本批先保存sufficient:false及指向该条真实路径的blocking问题/);
  assert.match(batch, /缺失的检查行须等其派发批提交真实判断/);
  assert.match(batch, /本批save_architecture_review_parts与submit_architecture_review_parts的范围行只接收/);
  assert.match(batch, /不接收criterionQuote、adapterQuote等详细行/);
  assert.match(batch, /确需提交旧详细格式时使用原完整submit_architecture_review/);
  assert.match(batch, /仅当本批priorFindingDecisions含编号时/);
  assert.match(batch, /仅当本批checks含编号时/);
  assert.match(batch, /同编号替换，其他行保留，删除已有问题须removeIssueIds/);
  assert.match(batch, /已有检查与本批新依据矛盾时，明确一并修正已有行/);
  assert.doesNotMatch(batch, /新 schemaVersion:3 逐项核对/);
  assert.doesNotMatch(batch, /存在priorFindings时，逐项核对其中历史问题/);
});

test("最终阶段保留完整覆盖、负评通道及原独立复核和预算", () => {
  const batch = renderArchitectureReviewPrompt({ batchMode: true });
  for (const id of ["requirements", "feasibility", "minimality", "interfaces", "failure_handling", "verification", "requirement_sufficiency", "acceptance_quality"])
    assert.ok(batch.includes(id), `保留${id}的最终义务`);
  assert.match(batch, /仅在正式提交阶段执行全表一致性与结论/);
  assert.match(batch, /stage=submit-with-parts时[\s\S]*先按当前CAS保存，再组装完整评审/);
  assert.match(batch, /stage=submit时正式提交已有完整分项/);
  assert.match(batch, /stage=final-only时不再单独保存/);
  assert.match(batch, /少量剩余额度不自动排除完整负评/);
  assert.match(batch, /每条验收恰好一行acceptanceScopeChecks、每个历史问题恰好一条priorFindingDecisions/);
  assert.match(batch, /每个blocking问题必须关联passed:false的检查/);
  assert.match(batch, /sufficient:false须对应acceptance_quality:false/);
  assert.match(batch, /原完整结构、覆盖、语义、历史问题校验和独立需求范围复核/);
  assert.match(batch, /最多两次范围复核计入原5轮实际总预算/);
  assert.match(batch, /连续三次相同受控提交失败仍停止/);
  assert.match(batch, /取消、持久化失败、截断、网络故障或预算耗尽保留未完成状态/);
});

test("聚焦当前批仍保留真实依据、适配器范围和原需求边界", () => {
  const batch = renderArchitectureReviewPrompt({ batchMode: true });
  assert.match(batch, /不修改候选、不调用设计者、不委派、不执行外部动作/);
  assert.match(batch, /保留用户已确认的需求、输入集合、交付承诺和验证义务/);
  assert.match(batch, /显式quote必须逐字一致/);
  assert.match(batch, /factClaims须等于当前实际JSON值/);
  assert.match(batch, /false不能授予能力/);
  assert.match(batch, /限制、排除项、前置条件或明确由其他条款负责的事项/);
  assert.match(batch, /不能凭名词或platform负责/);
  assert.match(batch, /schema已准入后的约定业务拒绝可按真实断言验证/);
  assert.match(batch, /files\.write原子写完整文本/);
  assert.match(batch, /多个约束的交集核对最大合法集合/);
  assert.match(batch, /sameReviewObject为true时不能声称已修改/);
  assert.match(batch, /旧失败用例也不自动成为新业务要求/);
  assert.match(batch, /不能遗漏或代填未完成项/);
});
