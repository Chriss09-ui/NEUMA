import { DevelopmentController } from "../../src/development/development.mjs";
import { createExecutionSession } from "../../src/runtime/execution-runtime.mjs";
import { developmentArchitecture } from "./development.mjs";

const [root, endpoint, boundary, mode] = process.argv.slice(2);
if (!root || !endpoint || !["budget", "result"].includes(boundary ?? "") || !["crash", "resume"].includes(mode ?? "")) throw new Error("Invalid recovery fixture");
const architecture = developmentArchitecture();
async function gate() {
  process.send?.({ type: "ready", boundary });
  await new Promise<void>(resolve => process.once("message", message => { if (message === "continue") resolve(); }));
}
const controller = new DevelopmentController({ cwd: root, dataDir: root, config: { llmConfigured: true, model: "synthetic", modelAuthType: "none", chatUrl: endpoint },
  limits: { reviewerTurns: 1 }, getArchitecture: async () => architecture,
  executor: { probe: async () => ({ available: true, kind: "fixture", reason: "仅验证规划及恢复，不执行生成代码" }),
    verify: async () => { throw new Error("Unexpected verification"); }, run: async () => { throw new Error("Unexpected execution"); } },
  sessionFactory: async options => {
    const planner = options.customTools?.some(tool => tool.name === "submit_development_plan");
    return createExecutionSession({ ...options,
      onModelCall: async event => { await options.onModelCall?.(event); if (mode === "crash" && planner && boundary === "budget") await gate(); },
      customTools: options.customTools!.map(tool => tool.name === "submit_development_plan" ? { ...tool, execute: async (...args) => {
        const result = await tool.execute(...args); if (mode === "crash" && boundary === "result") await gate(); return result;
      } } : tool),
    });
  } });
const result = await controller.run(architecture, { resume: mode === "resume" });
process.send?.({ type: "result", status: result.status, plannerTurns: Object.values(result.sessions ?? {}).find(session => session.role === "planner")?.turns,
  proposalSaved: Boolean(result.pendingPlan), approvedPlan: Boolean(result.plan), pending: Object.values(result.sessions ?? {}).some(session => session.role === "planner" && session.pendingResult) });
await controller.close(); process.disconnect?.();
