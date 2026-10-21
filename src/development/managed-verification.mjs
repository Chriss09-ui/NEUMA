import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { inspectDevelopmentCode } from "./development-workspace.mjs";
import { validateApplicationManifest, validateActionInput, validateActionOutput } from "../applications/application-contract.mjs";
import { hashServiceManifest } from "../services/service-contract.mjs";
import { WorkflowController } from "../services/workflow-controller.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTestJson, resolveCaseValues, inputContractRejection, inputContractMeasurement } from "./development-fixtures.mjs";

const matches = (actual, assertion) => {
  if (assertion.path !== "") for (const part of assertion.path.split(".")) {
    if (["__proto__", "prototype", "constructor"].includes(part) || actual === null
      || typeof actual !== "object" || !Object.hasOwn(actual, part)) return false;
    actual = actual[part];
  }
  return isDeepStrictEqual(actual, assertion.value);
};
export { matches as matchesDevelopmentAssertion };

export async function verifyManagedApplication({ services, executor, agentId, snapshot, application, cases,
  validateResources = true, stateful = false, signal }) {
  const report = { status: "not_run", codeHash: snapshot?.hash ?? null, results: [], stateful,
    evidenceMode: "mock_capabilities", connectionVerified: false, browserVerified: false,
    pageResourcesChecked: validateResources, servicePrepared: false, summary: "没有实际执行服务验收" };
  const scopes = new Set();
  let deliveryVersion, workflowDirectory;
  const controllers = [];
  try {
    validateApplicationManifest(application, { ...(validateResources ? { snapshot } : {}), allowUnverified: true });
    if (!snapshot || (await inspectDevelopmentCode(snapshot.path)).hash !== snapshot.hash) throw new Error("snapshot_changed");
    if (!Array.isArray(cases) || !cases.length || cases.length > 200
      || new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error("invalid_cases");
    const resolvedCases = new Map(), fixtureBudget = { bytes: 0 };
    for (const item of cases) {
      if (item.kind !== undefined && !["action", "node-check", "input-rejection"].includes(item.kind)) throw new Error("invalid_case_kind");
      if (!Array.isArray(item.assertions) || !item.assertions.length || item.assertions.length > 100) throw new Error("invalid_assertions");
      for (const assertion of item.assertions) {
        if (typeof assertion.path !== "string" || assertion.path.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part)))
          throw new Error("invalid_assertion_path");
        if (item.kind === "node-check" && typeof assertion.expectedJson !== "string") throw new Error("invalid_node_check");
      }
      resolvedCases.set(item.id, item.kind === "node-check"
        ? { assertions: item.assertions.map(({ path, expectedJson }) => ({ path, value: resolveTestJson(expectedJson, { signal }).value })) }
        : resolveCaseValues(item, { maxInputBytes: 1024 * 1024, signal, fixtureBudget }));
      if (item.workflowInputs !== undefined) {
        if (!Array.isArray(item.workflowInputs) || item.workflowInputs.length > 100 || new Set(item.workflowInputs.map((reply) => reply.stepId)).size !== item.workflowInputs.length) throw new Error("invalid_workflow_inputs");
        for (const reply of item.workflowInputs) {
          if (!reply || typeof reply.stepId !== "string" || typeof reply.inputJson !== "string" || Object.keys(reply).some((key) => !["stepId", "inputJson"].includes(key))) throw new Error("invalid_workflow_inputs");
          JSON.parse(reply.inputJson);
        }
      }
    }
    deliveryVersion = "verification_" + snapshot.hash + "_" + hashServiceManifest(application.service).slice(0, 24);
    if (cases.some((item) => !["input-rejection", "node-check"].includes(item.kind))) {
      const availability = await services.probe({ language: application.service.language, host: application.service.host, signal });
      if (!availability.available) return { ...report, summary: availability.reason,
        results: cases.map((item) => ({ caseId: item.id, status: "not_run", reason: availability.reason })) };
      await services.prepare({ agentId, deliveryVersion, manifest: application.service, codeDir: snapshot.path, signal });
      report.servicePrepared = true;
    }
    const sharedScope = "verification:" + randomUUID();
    for (const item of cases) {
      signal?.throwIfAborted();
      let run, workflowEvidence, rejectionEvidence, mockCalls = [];
      const resolved = resolvedCases.get(item.id);
      if (item.kind === "node-check") {
        if (!application.page || typeof item.input !== "string" || Object.hasOwn(item, "actionId") || Object.hasOwn(item, "mocks")
          || !snapshot.files.some((file) => file.path === item.entrypoint)
          || application.page.resources.some((resource) => resource.path === item.entrypoint)
          || item.entrypoint === application.entrypoint) throw new Error("invalid_node_check");
        run = await executor.run({ codeDir: snapshot.path, entrypoint: item.entrypoint, input: item.input, signal });
      } else {
        const action = application.service.operations.find((entry) => entry.id === item.actionId);
        if (!action || Object.hasOwn(item, "entrypoint") || !Array.isArray(item.mocks)) throw new Error("invalid_action_case");
        if (item.kind === "input-rejection") {
          if (item.mocks.length || item.workflowInputs?.length) throw new Error("invalid_input_rejection_case");
          const output = inputContractRejection(action, resolved.input, { target: item.inputTarget });
          run = { status: output.rejected ? "passed" : "failed", output, reason: output.rejected ? "" : "input_was_accepted" };
          rejectionEvidence = { kind: "input-rejection", stage: "input-validation", actionExecuted: false, evidenceMode: "input_contract",
            admission: inputContractMeasurement(action, resolved.input, { target: item.inputTarget }) };
        } else {
        const input = validateActionInput(action, resolved.input);
        const remaining = structuredClone(resolved.mocks);
        let unexpected = false;
        const scopeId = stateful ? sharedScope : "verification:" + randomUUID();
        scopes.add(scopeId);
        const capabilityHandler = async (capability, args) => {
            const index = remaining.findIndex((mock) => mock.capability === capability && isDeepStrictEqual(mock.args, args));
            if (index < 0) { unexpected = true; throw new Error("unconfigured_test_capability"); }
            const [mock] = remaining.splice(index, 1);
            mockCalls.push({ capability, mocked: true });
            return structuredClone(mock.value);
          };
        if (application.service.workflow?.entryActionId === item.actionId) {
          workflowDirectory ??= await mkdtemp(join(tmpdir(), "neuma-workflow-verification-"));
          const workflow = new WorkflowController({ rootDir: workflowDirectory,
            runAction: (request) => services.run({ ...request, signal, capabilityHandler, persist: false }) });
          controllers.push(workflow);
          const replies = structuredClone(item.workflowInputs ?? []);
          let record = await workflow.start({ agentId, deliveryVersion, scopeId, definition: application.service.workflow, input, signal });
          while (record.status === "waiting_input" && replies.length) {
            const reply = replies.shift();
            if (!reply || reply.stepId !== record.waiting.stepId) throw new Error("workflow_input_order_mismatch");
            record = await workflow.resume({ id: record.id, input: JSON.parse(reply.inputJson), signal });
          }
          workflowEvidence = { definitionHash: record.definitionHash, status: record.status, completedSteps: record.steps.filter((step) => step.status === "completed").map((step) => step.id), batchItems: record.steps.reduce((sum, step) => sum + step.items.length, 0) };
          if (record.status === "completed" && !replies.length) {
            const entries = await Promise.all(application.service.workflow.outputs.map(async (id) => [id, await workflow.readResult(record, record.resultRefs[id])]));
            run = { status: "passed", output: entries.length === 1 ? entries[0][1] : Object.fromEntries(entries) };
          } else run = { status: ["interrupted", "needs_review"].includes(record.status) ? "error" : "failed", output: null,
            reason: replies.length ? "unused_workflow_input_fixtures" : record.status === "waiting_input" ? "workflow_input_fixture_missing" : record.reason ?? `workflow_${record.status}` };
        } else {
          if (item.workflowInputs?.length) throw new Error("unexpected_workflow_input_fixtures");
          run = await services.run({ agentId, deliveryVersion, scopeId, actionId: item.actionId, input, signal, persist: false, capabilityHandler });
        }
        if (run.status === "passed") {
          try { validateActionOutput(action, run.output); }
          catch { run = { ...run, status: "failed", reason: "action_output_schema_mismatch" }; }
          if (remaining.length || unexpected) run = { ...run, status: "failed", reason: unexpected ? "unconfigured_test_capability" : "unused_capability_mocks" };
        }
        }
      }
      const result = { caseId: item.id, taskId: item.taskId, acceptanceId: item.acceptanceId,
        actionId: item.actionId, status: run.status, reason: run.reason ?? "", mockCalls, ...(workflowEvidence ? { workflow: workflowEvidence } : {}),
        ...(item.kind === "node-check" ? { kind: "node-check", entrypoint: item.entrypoint, evidenceMode: "node_check", browserVerified: false } : {}),
        ...rejectionEvidence, ...(!rejectionEvidence && item.kind !== "node-check" && run.status === "passed" ? { actionExecuted: true } : {}),
        ...(resolved.fixtures ? { fixtures: resolved.fixtures } : {}),
        actual: run.output, expected: resolved.assertions };
      if (run.status === "passed" && resolved.assertions.some((assertion) => !matches(run.output, assertion))) {
        result.status = "failed"; result.reason = "assertion_mismatch";
      }
      report.results.push(result);
    }
    signal?.throwIfAborted();
    if ((await inspectDevelopmentCode(snapshot.path)).hash !== snapshot.hash) throw new Error("snapshot_changed");
    signal?.throwIfAborted();
    report.status = report.results.some((item) => item.status === "error") ? "error"
      : report.results.some((item) => item.status === "failed") ? "failed"
        : report.results.some((item) => item.status !== "passed") ? "not_run" : "passed";
    report.summary = report.results.filter((item) => item.status === "passed").length + "/" + cases.length + " 条服务验收通过";
    report.runtime = { language: application.service.language, host: application.service.host, manifestHash: hashServiceManifest(application.service) };
    return report;
  } catch (error) {
    return { ...report, status: "error", summary: signal?.aborted ? "服务验收已取消" : "服务验收未完成；运行环境、契约或执行结果需要检查",
      reason: /^[a-z_]{1,80}$/.test(error.reason ?? "") ? error.reason : "service_verification_failed" };
  } finally {
    for (const controller of controllers) await controller.close({ permanent: true });
    if (deliveryVersion) for (const scopeId of scopes) await services.stop({ agentId, deliveryVersion, scopeId });
    if (workflowDirectory) await rm(workflowDirectory, { recursive: true, force: true });
  }
}
