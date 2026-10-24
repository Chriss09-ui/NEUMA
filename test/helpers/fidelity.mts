import assert from "node:assert/strict";
import { designHash } from "../../src/architecture/architecture-contract.mjs";
import type { PiSessionOptions } from "../../src/runtime/pi-port.mjs";
import { fixtureTool, completeVerificationContext } from "./model-context.mjs";

interface FidelityPayload { contextHash: string; requirements: { id: string; text: string }[]; candidate: object; fidelityContextVersion?: string }
interface ResultOptions { requirementId?: string; candidatePath?: string; canonical?: boolean }
function fidelityPayload(value: unknown): FidelityPayload {
  assert.ok(value && typeof value === "object" && "contextHash" in value && typeof value.contextHash === "string");
  assert.ok("requirements" in value && Array.isArray(value.requirements));
  assert.ok(value.requirements.every(item => item && typeof item === "object" && typeof item.id === "string" && typeof item.text === "string"));
  assert.ok("candidate" in value && value.candidate && typeof value.candidate === "object");
  assert.ok(!("fidelityContextVersion" in value) || typeof value.fidelityContextVersion === "string");
  return value as FidelityPayload;
}
export function fidelityResult(input: unknown, classification = "preserved", options: ResultOptions = {}) {
  const payload = fidelityPayload(input);
  const { requirementId = payload.requirements[0]!.id, candidatePath = "/instructions", canonical = false } = options;
  assert.ok(["preserved", "narrowed", "unproven"].includes(classification));
  const index = payload.requirements.findIndex((item) => item.id === requirementId);
  assert.ok(index >= 0); assert.ok(payload.candidate && Object.hasOwn(payload.candidate, "instructions"));
  return { contextHash: payload.contextHash, verdict: classification,
    checks: payload.requirements.map((item) => ({ requirementId: item.id, admissionPreserved: classification !== "narrowed" || item.id !== requirementId,
      deliveryPreserved: true, newUnconfirmedRestriction: classification === "narrowed" && item.id === requirementId })),
    restrictions: classification === "narrowed" ? [payload.fidelityContextVersion === "full-v2" && !canonical
      ? { candidatePath, claimRef: { source: "requirements", requirementId }, reason: "固定测试独立判断当前候选新增了来源未确认的输入限制" }
      : { candidatePath, requirementId, source: "requirements", path: `/${index}/text`,
        quote: payload.requirements[index]!.text.slice(0, 1000), reason: "固定测试独立判断当前候选新增了来源未确认的输入限制" }] : [],
  };
}

// This is an explicit model fixture: production still validates its bound checks and exact references.
export function fidelityChecker(classification = "preserved", { inspect, ...resultOptions }: ResultOptions & { inspect?: (payload: FidelityPayload & Record<string, unknown>, options: PiSessionOptions) => unknown | Promise<unknown> } = {}) {
  return async (options: PiSessionOptions) => ({ modelCallAccounting: true, setAutoCompactionEnabled() {}, dispose() {}, async abort() {},
    async prompt(text: string) {
      await options.onModelCall?.({});
      assert.deepEqual(options.customTools!.map((tool) => tool.name), ["submit_requirement_fidelity", "read_model_context"], "独立复核只有提交及本节点冻结材料读取，不继承文件、网络或主角色工具");
      const complete = await completeVerificationContext(JSON.parse(text), options), payload = Object.assign(complete, fidelityPayload(complete)), { contextHash, ...context } = payload;
      assert.equal(contextHash, designHash(context), "模型决定必须绑定完整当前只读上下文");
      assert.ok(payload.requirements.length); assert.equal(new Set(payload.requirements.map((item) => item.id)).size, payload.requirements.length);
      await inspect?.(payload, options);
      await fixtureTool(options, "submit_requirement_fidelity").execute("fidelity", fidelityResult(payload, classification, resultOptions));
    },
  });
}
