import assert from "node:assert/strict";
import { join } from "node:path";
import { designHash } from "../../src/architecture/architecture-contract.mjs";

const moduleFields = ["components", "steps", "capabilities", "failureHandling", "decisions", "coverage", "acceptance", "unknowns", "platformClaims"];
const stageTools = ["submit_architecture_blueprint", "submit_architecture_module", "submit_architecture_integration"];

export function architectureStageSubmission({ tools, payload, candidate, moduleId = "core",
  blueprintInstructions = candidate?.instructions, moduleInstructions = candidate?.instructions }) {
  const available = Array.isArray(tools) ? Object.fromEntries(tools.map((tool) => [tool.name, tool])) : tools;
  const name = stageTools.find((toolName) => available?.[toolName]);
  if (!name) return null;
  assert.equal(candidate?.schemaVersion, 3, "阶段夹具必须使用同一完整 v3 候选");
  const expected = structuredClone(candidate);
  let args;
  if (name === "submit_architecture_blueprint") {
    assert.ok(Array.from(blueprintInstructions ?? "").length > 0 && Array.from(blueprintInstructions).length <= 2000,
      "长指令夹具须明确提供有界蓝图指令，完整原文在整合阶段保留");
    const global = Object.fromEntries(Object.entries(expected).filter(([key]) => !moduleFields.includes(key)));
    global.instructions = blueprintInstructions;
    args = { global, modules: [{ id: moduleId, purpose: expected.rationale,
      requirementIds: payload.requirements.map((item) => item.id), componentIds: expected.components.map((item) => item.id),
      stepIds: expected.steps.map((item) => item.id), dependsOn: [],
      inputs: expected.interaction.inputs, outputs: expected.interaction.results }] };
  } else if (name === "submit_architecture_module") {
    assert.equal(payload.blueprint.modules.length, 1, "多模块回归须显式提供各模块独立成果");
    assert.equal(payload.assignment.id, moduleId, "模块夹具必须绑定实际派发的稳定编号");
    assert.ok(Array.from(moduleInstructions ?? "").length > 0 && Array.from(moduleInstructions).length <= 3000,
      "长指令夹具须明确提供有界模块指令，完整原文在整合阶段保留");
    args = { moduleId, blueprintHash: payload.blueprintHash ?? designHash(payload.blueprint), instructions: moduleInstructions,
      ...Object.fromEntries(moduleFields.filter((key) => Object.hasOwn(expected, key)).map((key) => [key, expected[key]])) };
  } else {
    assert.ok(payload.baseCandidate, "整合夹具必须使用宿主实际组装的候选");
    const { instructions: actualInstructions, ...actualBody } = payload.baseCandidate;
    const { instructions: expectedInstructions, ...expectedBody } = expected;
    assert.deepEqual(actualBody, expectedBody, "宿主组装不能丢失或改写固定候选的模块内容");
    args = { baseHash: payload.baseHash ?? designHash(payload.baseCandidate), updates: actualInstructions === expectedInstructions
      ? [] : [{ path: "/instructions", value: expectedInstructions }] };
  }
  return { name, tool: available[name], args };
}

export async function submitArchitectureStage(input) {
  const submission = architectureStageSubmission(input);
  if (!submission) return null;
  return submission.tool.execute(input.callId ?? `fixture-${submission.name}`, submission.args);
}

export function createArchitectureStageSessionFactory(makeCandidate, { onPrompt } = {}) {
  const candidates = new Map(), contexts = new Map();
  return async (options) => {
    const storage = options.sessionStorage;
    if (storage?.binding.role !== "architecture-design-stage") return null;
    const { pipelineId, stage, key, generation } = storage.binding;
    const tools = Object.fromEntries(options.customTools.map((tool) => [tool.name, tool]));
    const sessionFile = join(storage.directory, storage.file ?? `${pipelineId}-${key}-${generation}.jsonl`);
    return { messages: [], modelCallAccounting: true, sessionFile,
      subscribe: () => () => {}, dispose() {}, async abort() {}, async prompt(text) {
        await options.onModelCall();
        const input = JSON.parse(text);
        const payload = input.type === "resume_architecture_stage" ? { ...contexts.get(sessionFile), ...input } : input;
        contexts.set(sessionFile, structuredClone(payload));
        await onPrompt?.({ stage, payload, options, tools });
        if (stage === "blueprint" && !candidates.has(pipelineId) || generation > 0)
          candidates.set(pipelineId, structuredClone(await makeCandidate(payload, { pipelineId, stage, generation })));
        const candidate = candidates.get(pipelineId);
        assert.ok(candidate, "阶段会话须复用同一 pipelineId 的固定蓝图候选");
        const submission = architectureStageSubmission({ tools, payload, candidate });
        assert.ok(submission, "阶段会话必须通过当前实际注册的阶段工具提交");
        return submission.tool.execute(`fixture-${stage}`, submission.args);
      } };
  };
}
