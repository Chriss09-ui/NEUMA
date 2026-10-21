import test from "node:test";
import assert from "node:assert/strict";
import { REVIEW_PROMPT, renderArchitectureReviewPrompt } from "../src/architecture/architecture-prompts.mjs";

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
  assert.throws(() => renderArchitectureReviewPrompt({ batchMode: "true" }), TypeError);
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
  assert.match(batch, /最多两次范围复核计入原12轮实际总预算/);
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
