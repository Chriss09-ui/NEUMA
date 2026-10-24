import type { Providers } from "../src/requirements/requirement-provider-port.mjs";
import { recordArray } from "./helpers/m7-test-boundaries.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { processTurn, emptyDraft, CONFIRMATION_QUESTION } from "../src/requirements/core.mjs";
import { makeProviders } from "../src/requirements/providers.mjs";
import { createPlatformSnapshot } from "../src/architecture/platform-contract.mjs";
import { contentHash, emptyTaskSpec, substantiveRequirementHash } from "../src/requirements/task-spec.mjs";
import { validDraft } from "./helpers/architecture.mjs";
import { sufficientPreflight } from "./helpers/consultation.mjs";
import type { RequirementDraft } from "../src/contracts/requirements.mjs";

const policyPlatform = makeProviders({}).getPlatform;
const taskDraft = (offline = false): RequirementDraft => ({ ...validDraft("逐项核对清单并保存结果"), taskSpec: emptyTaskSpec(),
  constraints: offline ? [{ text: "不联网", source: "user" }] : [] });
const options = (requestId: string) => ({ enforceConsultation: true, requestId });
const generate = (draft: RequirementDraft) => async () => ({ draft, proposedGap: "none", question: "" });

async function ready(draft: RequirementDraft, requestId: string) {
  return processTurn({ message: "按清单要求制作", draft: emptyDraft() }, {
    generateDraft: generate(draft), preflight: sufficientPreflight, getPlatform: policyPlatform,
  }, options(requestId));
}

test("短继续生成离线草稿后绑定新权限，有效确认不再调用模型或预评估", async () => {
  const generated = taskDraft(true); generated.constraints![0]!.text = "  不联网  ";
  let platformReads = 0, generations = 0, evaluations = 0;
  const providers: Providers = {
    generateDraft: async () => { generations++; return { draft: generated, proposedGap: "none", question: "" }; },
    getPlatform: async (input) => {
      platformReads++;
      await Promise.resolve();
      assert.equal(recordArray(objectFields(input.draft).constraints)[0]!.text, "不联网");
      return policyPlatform!(input);
    },
    preflight: async ({ draft, platform }) => {
      evaluations++;
      assert.equal(draft.constraints[0]!.text, "不联网");
      assert.equal(objectFields(objectFields(platform).network).allowNetwork, false);
      return sufficientPreflight();
    },
  };
  const result = await processTurn({ message: "按上一轮完整需求继续", draft: emptyDraft() }, providers, options("continue"));
  assert.equal(result.status, "ready");
  assert.equal(result.confirmed, false);
  assert.equal(result.consultation!.assessments[0]!.platformHash, contentHash(createPlatformSnapshot({ allowNetwork: false })));
  assert.equal(platformReads, 1);
  const before = structuredClone(result.consultation);
  const confirmed = await processTurn({ message: "确认", draft: result.draft, consultation: result.consultation,
    lastQuestion: result.confirmationQuestion }, {
    ...providers,
    generateDraft: async () => { assert.fail("有效快捷确认不应重新生成需求"); },
    preflight: async () => { assert.fail("有效快捷确认不应再次预评估"); },
  }, options("confirm"));
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.confirmation!.platformHash, result.consultation!.assessments[0]!.platformHash);
  assert.equal(generations, 1);
  assert.equal(evaluations, 1);
  assert.deepEqual(result.consultation, before);
  assert.deepEqual(confirmed.consultation!.assessments, before!.assessments!);
});

test("用户实质增加联网范围后用更新需求评估，不复用离线评估或改写历史指纹", async () => {
  const initial = await ready(taskDraft(true), "offline_ready"), historical = structuredClone(initial.consultation);
  let evaluated;
  const changed = await processTurn({ message: "改为允许联网核对公开资料", draft: initial.draft,
    consultation: initial.consultation, lastQuestion: CONFIRMATION_QUESTION }, {
    generateDraft: generate(taskDraft()), getPlatform: policyPlatform,
    preflight: async (input) => { evaluated = input; return sufficientPreflight(); },
  }, options("allow_network"));
  assert.equal(evaluated!.platform!.network.allowNetwork, true);
  assert.equal(changed.confirmed, false);
  assert.equal(changed.status, "ready");
  assert.notEqual(substantiveRequirementHash(changed.draft), substantiveRequirementHash(initial.draft));
  assert.equal(changed.consultation!.assessments.length, 2);
  assert.equal(changed.consultation!.assessments[1]!.platformHash, contentHash(createPlatformSnapshot({ allowNetwork: true })));
  assert.deepEqual(changed.consultation!.assessments[0], historical!.assessments![0]);
  assert.deepEqual(initial.consultation, historical);
});

test("本轮明确禁止联网即使候选未写入限制，也不能复用允许联网的平台评估", async () => {
  const initial = await ready(taskDraft(), "network_ready");
  let evaluated;
  const changed = await processTurn({ message: "本轮不要联网，仍按这份清单处理", draft: initial.draft,
    consultation: initial.consultation, lastQuestion: CONFIRMATION_QUESTION }, {
    generateDraft: generate(initial.draft), getPlatform: policyPlatform,
    preflight: async (input) => { evaluated = input; return sufficientPreflight(); },
  }, options("forbid_network"));
  assert.equal(evaluated!.platform!.network.allowNetwork, false);
  assert.equal(changed.confirmed, false);
  assert.equal(substantiveRequirementHash(changed.draft), substantiveRequirementHash(initial.draft));
  assert.equal(changed.consultation!.assessments.length, 2);
  assert.notEqual(changed.consultation!.assessments[0]!.platformHash, changed.consultation!.assessments[1]!.platformHash);
  assert.equal(changed.consultation!.assessments[1]!.platformHash, contentHash(createPlatformSnapshot({ allowNetwork: false })));
});

test("本轮允许消息不能覆盖当前候选仍保留的禁止联网范围", async () => {
  const generated = taskDraft(true);
  const result = await processTurn({ message: "这次可以联网核对", draft: generated }, {
    generateDraft: generate(generated),
    getPlatform: async (input) => policyPlatform!(input),
    preflight: async ({ platform }) => {
      assert.equal(objectFields(objectFields(platform).network).allowNetwork, false);
      return sufficientPreflight();
    },
  }, options("offline_generation"));
  assert.equal(result.consultation!.assessments[0]!.platformHash, contentHash(createPlatformSnapshot({ allowNetwork: false })));
});

test("显式冻结平台继续用于生成与评估，不额外读取动态平台", async () => {
  const frozen = createPlatformSnapshot({ allowNetwork: false }), before = structuredClone(frozen);
  const result = await processTurn({ message: "可以联网核对", draft: emptyDraft() }, {
    generateDraft: async (input) => {
      assert.equal(input.platform, frozen);
      return { draft: taskDraft(), proposedGap: "none", question: "" };
    },
    getPlatform: async () => { assert.fail("显式平台不得被动态读取替换"); },
    preflight: async ({ platform }) => { assert.deepEqual(platform, frozen); return sufficientPreflight(); },
  }, { ...options("frozen"), platform: frozen });
  assert.equal(result.consultation!.assessments[0]!.platformHash, contentHash(frozen));
  assert.deepEqual(frozen, before);
});
