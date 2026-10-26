import { WorkflowController } from "../../src/services/workflow-controller.mjs";

const [rootDir, endpoint, boundary] = process.argv.slice(2);
if (!rootDir || !endpoint || !["prepared", "dispatched", "effect", "result"].includes(boundary ?? "")) throw new Error("Invalid recovery fixture arguments");
async function gate() {
  process.send?.({ type: "ready", boundary });
  await new Promise<void>(resolve => process.once("message", message => { if (message === "continue") resolve(); }));
}
const workflow = new WorkflowController({ rootDir, onChange: async record => {
  const attempt = record.steps[0]?.items[0]?.executions?.at(-1);
  if (attempt?.phase === boundary || boundary === "result" && attempt?.phase === "completed") await gate();
}, runAction: async () => {
  await fetch(endpoint, { method: "POST", body: "synthetic-action" });
  if (boundary === "effect") await gate();
  return { status: "passed", output: { delivered: true } };
} });
await workflow.start({ id: "workflow_crash", agentId: "synthetic-agent", deliveryVersion: "synthetic-delivery", input: {},
  definition: { schemaVersion: 1, entryActionId: "whole", steps: [{ id: "send", actionId: "send", dependsOn: [], idempotent: false }], outputs: ["send"] } });
await workflow.close();
process.disconnect?.();
