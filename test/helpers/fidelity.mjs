import assert from "node:assert/strict";
import { designHash } from "../../src/architecture/architecture-contract.mjs";

export function fidelityResult(payload, classification = "preserved", { requirementId = payload.requirements[0].id, candidatePath = "/instructions", canonical = false } = {}) {
  assert.ok(["preserved", "narrowed", "unproven"].includes(classification));
  const index = payload.requirements.findIndex((item) => item.id === requirementId);
  assert.ok(index >= 0); assert.ok(payload.candidate && Object.hasOwn(payload.candidate, "instructions"));
  return { contextHash: payload.contextHash, verdict: classification,
    checks: payload.requirements.map((item) => ({ requirementId: item.id, admissionPreserved: classification !== "narrowed" || item.id !== requirementId,
      deliveryPreserved: true, newUnconfirmedRestriction: classification === "narrowed" && item.id === requirementId })),
    restrictions: classification === "narrowed" ? [payload.fidelityContextVersion === "full-v2" && !canonical
      ? { candidatePath, claimRef: { source: "requirements", requirementId }, reason: "固定测试独立判断当前候选新增了来源未确认的输入限制" }
      : { candidatePath, requirementId, source: "requirements", path: `/${index}/text`,
        quote: payload.requirements[index].text.slice(0, 1000), reason: "固定测试独立判断当前候选新增了来源未确认的输入限制" }] : [],
  };
}

// This is an explicit model fixture: production still validates its bound checks and exact references.
export function fidelityChecker(classification = "preserved", { inspect, ...resultOptions } = {}) {
  return async (options) => ({ modelCallAccounting: true, setAutoCompactionEnabled() {}, dispose() {}, async abort() {},
    async prompt(text) {
      await options.onModelCall();
      assert.deepEqual(options.customTools.map((tool) => tool.name), ["submit_requirement_fidelity"], "独立复核不能继承文件、网络或主角色工具");
      const payload = JSON.parse(text), { contextHash, ...context } = payload;
      assert.equal(contextHash, designHash(context), "模型决定必须绑定完整当前只读上下文");
      assert.ok(payload.requirements.length); assert.equal(new Set(payload.requirements.map((item) => item.id)).size, payload.requirements.length);
      await inspect?.(payload, options);
      await options.customTools[0].execute("fidelity", fidelityResult(payload, classification, resultOptions));
    },
  });
}
