import assert from "node:assert/strict";
import type { PiSessionOptions } from "../../src/runtime/pi-port.mjs";
import { fixtureTool } from "./model-context.mjs";
export function handoffChecker(classification = "user_choice") {
  return async (options: PiSessionOptions) => ({ modelCallAccounting: true, setAutoCompactionEnabled() {}, dispose() {}, async abort() {},
    async prompt(text: string) {
      await options.onModelCall?.({}); const payload: { contextHash: string; proposal: { id: string; references: unknown }[] } = JSON.parse(text);
      await fixtureTool(options, "submit_handoff_necessity").execute("necessity", { contextHash: payload.contextHash, decisions: payload.proposal.map((item) => ({
        issueId: item.id, classification, reason: "固定测试的独立必要性决定", references: item.references,
      })) });
    },
  });
}

export function requirementReference(payload: { requirements: { id: string; text: string }[] }, id: string) {
  const index = payload.requirements.findIndex((item) => item.id === id);
  return { source: "requirements", path: `/${index}/text`, quote: payload.requirements[index]!.text };
}
