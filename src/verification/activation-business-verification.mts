import type { BinaryLike } from "node:crypto";
import type { DevelopmentPlan } from "../contracts/development.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
import type { AcceptanceStatus } from "../contracts/verification.mjs";
import type { DevelopmentSnapshot } from "../development/development-workspace.mjs";
import type { DevelopmentExecutor } from "../development/development-executor.mjs";
import type { ServiceResult } from "../services/service-port.mjs";
import { objectFields, errorField } from "../runtime/type-boundary.mjs";
interface HostInput { capability: string; args: unknown; signal?: AbortSignal | undefined }
export type ActivationBusinessHostFactory = (options: { storage: AgentStorage; store: ApplicationTaskStore; agentId: string; workspaceRoot: string;
  scopeId: string; taskId: string; stateVersion: number; signal?: AbortSignal | undefined }) => Promise<(input: HostInput) => Promise<unknown>> | ((input: HostInput) => Promise<unknown>);
export interface ActivationCaseResult { caseId: string; caseHash: string; source: string; actionId: string | null; status: string;
  calls: { capability: string; argsHash: string; mocked: boolean }[]; artifacts: { path: string; size: unknown; sha256: unknown; downloadedSha256: string }[];
  acceptanceId?: string; developmentAcceptanceId?: string; reason?: string; admission?: unknown; actionExecuted?: boolean; scopeId?: string;
  workflow?: unknown; actual?: unknown; assertionsHash?: string; assertionCount?: number; failedAssertionPaths?: string[] }
export interface ActivationBusinessReport { schemaVersion: number; mode: string; scope: string; acceptanceId: string; bindingHash: string; codeHash: string | null;
  planHash: string; results: ActivationCaseResult[]; status: AcceptanceStatus; executionScope?: string; reason?: string }
import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AgentStorage } from "../agents/agent-storage.mjs";
import { ApplicationTaskStore } from "../applications/task-store.mjs";
import { saveTaskArtifact, readTaskArtifactSnapshot } from "../applications/task-artifacts.mjs";
import { validateApplicationManifest, validateActionInput, validateActionOutput } from "../applications/application-contract.mjs";
import { resolveCaseValues, inputContractRejection, inputContractMeasurement } from "../development/development-fixtures.mjs";
import { activationCaseEntries } from "../development/development-contract.mjs";
import { inspectDevelopmentCode } from "../development/development-workspace.mjs";
import { matchesDevelopmentAssertion } from "../development/managed-verification.mjs";
import { ManagedServiceManager } from "../services/managed-service-manager.mjs";
import { WorkflowController } from "../services/workflow-controller.mjs";
import { MAX_RUNTIME_FILE_BYTES } from "../runtime/file-limits.mjs";
import { InputError } from "../requirements/core.mjs";
import { ACCEPTANCE_ADAPTERS, acceptanceEvidenceHash } from "./acceptance-contract.mjs";

const scope = ACCEPTANCE_ADAPTERS["host-business"].scope;
const supported = new Set(["files.list", "files.read", "files.write", "state.get", "state.set"]);
const sha256 = (bytes: BinaryLike) => createHash("sha256").update(bytes).digest("hex");
function fail(reason: string): never { throw Object.assign(new InputError("激活前业务验证未完成"), { reason }); }
const reasonOf = (error: unknown, fallback: string) => /^[a-z][a-z0-9_]{0,79}$/.test(String(errorField(error, "reason") ?? "")) ? String(errorField(error, "reason")) : fallback;

async function readRaw(storage: Pick<AgentStorage, "path">, agentId: string, workspaceRoot: string, file: unknown) {
  if (typeof file !== "string" || !file || file.includes("\0") || file.includes("\\") || isAbsolute(file)) fail("activation_artifact_path_invalid");
  const name = relative(workspaceRoot, resolve(workspaceRoot, file));
  if (!name || isAbsolute(name) || name === ".." || name.startsWith("../")) fail("activation_artifact_path_invalid");
  const handle = await open(await storage.path(agentId, "workspace/" + name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_RUNTIME_FILE_BYTES) fail("activation_artifact_integrity_failed");
    return await handle.readFile();
  } finally { await handle.close(); }
}

function runner(services: unknown, rootDir: string) {
  if (!(services instanceof ManagedServiceManager)) return null;
  return new ManagedServiceManager({ rootDir, nodePath: services.nodePath, platform: services.platform, arch: services.arch,
    sandboxPath: services.sandboxPath, dockerPath: services.docker.dockerPath, runtimeStore: services.runtimeStore, fetchImpl: services.fetchImpl });
}

export type ActivationBusinessPlan = Pick<DevelopmentPlan,"schemaVersion"|"runtime"|"entrypoint"|"application"|"cases"|"activationCases"|"activationChecks">;
export async function verifyActivationBusiness({ executor, services, agentId, snapshot, plan, acceptanceId, bindingHash,
  createHost, signal, temporaryDir = tmpdir() }: { executor: Pick<DevelopmentExecutor, "runAction">; services?: unknown; agentId: string; snapshot:Pick<DevelopmentSnapshot,"path"|"hash"|"files">; plan: ActivationBusinessPlan; acceptanceId: string; bindingHash: string; createHost?: ActivationBusinessHostFactory | undefined; signal?: AbortSignal | undefined; temporaryDir?: string }) {
  const report: ActivationBusinessReport = { schemaVersion: 1, mode: "actual", scope, acceptanceId, bindingHash, codeHash: snapshot?.hash ?? null,
    planHash: acceptanceEvidenceHash(plan), results: [], status: "not_run" };
  let directory: string | undefined, serviceRunner: ManagedServiceManager | null | undefined;
  const activeCalls = new Set<Promise<unknown>>();
  const finish = () => ({ status: report.status, mode: "actual", scope, bindingHash,
    evidenceId: "business_" + randomUUID(), evidenceHash: acceptanceEvidenceHash(report), report });
  try {
    if (!/^[a-f0-9]{64}$/.test(bindingHash ?? "")) fail("activation_binding_invalid");
    const assignment = plan.activationChecks?.filter((item) => item.acceptanceId === acceptanceId);
    if (assignment?.length !== 1 || !Array.isArray(assignment[0]!.caseIds) || !assignment[0]!.caseIds.length || assignment[0]!.caseIds.length > 200
      || new Set(assignment[0]!.caseIds).size !== assignment[0]!.caseIds.length) fail("activation_cases_missing");
    const executionScope = assignment[0]!.executionScope ?? "isolated";
    if (!["isolated", "shared"].includes(executionScope)) fail("activation_scope_invalid");
    report.executionScope = executionScope;
    const entries = activationCaseEntries(plan);
    if (!Array.isArray(plan.cases) || plan.activationCases !== undefined && !Array.isArray(plan.activationCases)
      || entries.length > 200 || entries.some(({ test }) => !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(test?.id ?? ""))
      || new Set(entries.map(({ test }) => test.id)).size !== entries.length) fail("activation_case_reference_invalid");
    const cases = assignment[0]!.caseIds.map((id) => {
      const matches = entries.filter(({ test }) => test.id === id), entry = matches[0]!;
      if (matches.length !== 1) fail("activation_case_reference_invalid");
      if (entry.source === "activation" && (entry.test.acceptanceId !== acceptanceId
        || plan.activationChecks!.some((row) => row.acceptanceId !== acceptanceId && row.caseIds?.includes(id))))
        fail("activation_case_acceptance_mismatch");
      return entry;
    });
    validateApplicationManifest(plan.application, { snapshot, allowUnverified: true });
    if (!snapshot || (await inspectDevelopmentCode(snapshot.path)).hash !== snapshot.hash) fail("activation_snapshot_changed");
    directory = await mkdtemp(join(temporaryDir, "neuma-activation-business-"));
    const managed = plan.runtime === "managed-service", deliveryVersion = "verification_" + randomUUID();
    if (managed) {
      serviceRunner = runner(services, join(directory, "services"));
      if (!serviceRunner) { report.reason = "activation_runtime_unavailable"; return finish(); }
      const available = await serviceRunner.probe({ language: plan.application!.service!.language, host: plan.application!.service!.host, signal });
      if (!available.available) { report.reason = "activation_runtime_unavailable"; return finish(); }
      await serviceRunner.prepare({ agentId, deliveryVersion, manifest: plan.application!.service!, codeDir: snapshot.path, signal });
    } else if (plan.runtime !== "node-action" || typeof executor?.runAction !== "function") {
      report.reason = "activation_runtime_unavailable"; return finish();
    }
    const fixtureBudget = { bytes: 0 };
    let sharedCase: { scopeId: string; storage: AgentStorage; store: ApplicationTaskStore; root: string } | undefined;
    for (const { test: item, source } of cases) {
      signal?.throwIfAborted();
      const result: ActivationCaseResult = { caseId: item.id, caseHash: acceptanceEvidenceHash(item), source,
        ...(source === "activation" ? { acceptanceId: item.acceptanceId } : { developmentAcceptanceId: item.acceptanceId }),
        actionId: item.actionId ?? null, status: "not_run", calls: [], artifacts: [] };
      report.results.push(result);
      const action = plan.application!.actions.find((entry) => entry.id === item.actionId);
      if (!action || ![undefined, "action", "input-rejection"].includes(item.kind)) {
        result.reason = "activation_case_unsupported"; continue;
      }
      const workflowDefinition = managed && plan.application!.service!.workflow?.entryActionId === item.actionId
        ? plan.application!.service!.workflow : null;
      if (item.workflowInputs !== undefined) {
        if (!Array.isArray(item.workflowInputs) || item.workflowInputs.length > 100
          || new Set(item.workflowInputs.map((reply) => reply?.stepId)).size !== item.workflowInputs.length) fail("activation_workflow_inputs_invalid");
        for (const reply of item.workflowInputs) {
          if (!reply || typeof reply.stepId !== "string" || typeof reply.inputJson !== "string"
            || Object.keys(reply).some((key) => !["stepId", "inputJson"].includes(key))) fail("activation_workflow_inputs_invalid");
          JSON.parse(reply!.inputJson);
        }
        if (item.workflowInputs.length && (!workflowDefinition || item.kind === "input-rejection")) fail("activation_workflow_inputs_invalid");
      }
      const resolved = resolveCaseValues(item, { maxInputBytes: managed ? 1024 * 1024 : 128 * 1024, fixtureBudget, signal });
      if (resolved.mocks.some((mock) => !supported.has(mock.capability))) { result.reason = "activation_capability_unsupported"; continue; }
      let actual;
      if (item.kind === "input-rejection") {
        if (resolved.mocks.length) fail("activation_case_invalid");
        result.admission = inputContractMeasurement(action, resolved.input, { target: item.inputTarget });
        actual = inputContractRejection(action, resolved.input, { target: item.inputTarget });
        result.actionExecuted = false; result.status = actual.rejected ? "passed" : "failed";
        if (!actual.rejected) result.reason = "activation_input_was_accepted";
      } else {
        const input = validateActionInput(action, resolved.input), scopeId = sharedCase?.scopeId ?? "verification:" + randomUUID();
        result.scopeId = scopeId;
        // Sharing is explicit: legacy mappings retain a fresh worker and data root per case.
        const caseStorage = sharedCase?.storage ?? new AgentStorage({ dataDir: join(directory, "cases", item.id) });
        const caseStore = sharedCase?.store ?? new ApplicationTaskStore({ storage: caseStorage }); await caseStore.ready;
        const caseRoot = sharedCase?.root ?? await caseStorage.directory(agentId, "workspace", { create: true });
        if (executionScope === "shared") sharedCase ??= { scopeId, storage: caseStorage, store: caseStore, root: caseRoot };
        const task = (await caseStore.create(agentId, { actionId: item.actionId!, input, mutationId: randomUUID(), deliveryVersion,
          source: { kind: "application", scope: scopeId }, allowNetwork: false })).task;
        const stateOptions = { kind: "business", scope: scopeId, stateVersion: plan.application!.stateVersion };
        const host = typeof createHost === "function" ? await createHost({ storage: caseStorage, store: caseStore, agentId,
          workspaceRoot: caseRoot, scopeId, taskId: task.id, stateVersion: plan.application!.stateVersion, signal }) : null;
        const remaining = [...resolved.mocks]; let unsupported = false, unexpected = false, integrityFailed = false;
        const invokeCapability = async (capability: string, args: unknown, context: { signal?: AbortSignal | undefined } = {}) => {
          const fields = objectFields(args);
          signal?.throwIfAborted(); context.signal?.throwIfAborted();
          if (!supported.has(capability)) { unsupported = true; fail("activation_capability_unsupported"); }
          const index = remaining.findIndex((mock) => mock.capability === capability && isDeepStrictEqual(mock.args, args));
          if (index < 0) { unexpected = true; fail("activation_capability_unexpected"); }
          remaining.splice(index, 1);
          result.calls.push({ capability, argsHash: acceptanceEvidenceHash(args), mocked: false });
          let value;
          if (capability === "state.get") value = await caseStore.getState(agentId, stateOptions);
          else if (capability === "state.set") value = await caseStore.setState(agentId, { state: fields.state, expectedVersion: fields.expectedVersion }, stateOptions);
          else {
            if (typeof host !== "function") { unsupported = true; fail("activation_host_unavailable"); }
            value = await host({ capability, args, signal: context.signal ?? signal });
            try {
              if (capability === "files.write" && objectFields(value).saved === true) {
                const bytes = await readRaw(caseStorage, agentId, caseRoot, fields.file);
                if (typeof fields.content !== "string" || !bytes.equals(Buffer.from(fields.content, "utf8"))
                  || objectFields(objectFields(value).integrity).sha256 !== sha256(bytes) || objectFields(objectFields(value).integrity).bytes !== bytes.length) fail("activation_artifact_integrity_failed");
                const artifact = await saveTaskArtifact({ storage: caseStorage, id: agentId, taskId: task.id, path: String(fields.file), data: bytes, signal });
                await caseStore.appendArtifact(agentId, task.id, artifact);
                const pages = []; let offset = 0;
                for (;;) {
                  const page = await readTaskArtifactSnapshot({ storage: caseStorage, id: agentId, taskId: task.id, artifact, offset, signal });
                  pages.push(Buffer.from(page.data, "base64")); if (page.nextOffset === null) break; offset = page.nextOffset;
                }
                if (!Buffer.concat(pages).equals(bytes)) fail("activation_artifact_integrity_failed");
                result.artifacts.push({ path: artifact.path, size: artifact.size, sha256: artifact.sha256, downloadedSha256: sha256(Buffer.concat(pages)) });
              } else if (capability === "files.read" && !objectFields(value).error) {
                const bytes = await readRaw(caseStorage, agentId, caseRoot, fields.file);
                if (objectFields(objectFields(value).integrity).sha256 !== sha256(bytes) || objectFields(objectFields(value).integrity).bytes !== bytes.length) fail("activation_artifact_integrity_failed");
              }
            } catch (error) { integrityFailed = true; throw error; }
          }
          return value;
        };
        const capabilityHandler = (...args: Parameters<typeof invokeCapability>) => {
          const pending = invokeCapability(...args); activeCalls.add(pending);
          void pending.finally(() => activeCalls.delete(pending)).catch(() => {});
          return pending;
        };
        let workflow: WorkflowController | undefined;
        try {
          await caseStore.update(agentId, task.id, { status: "running" });
          let run: ServiceResult;
          if (workflowDefinition) {
            workflow = new WorkflowController({ rootDir: join(directory, "workflows", item.id),
              runAction: (request) => serviceRunner!.run({ ...request, signal: request.signal, persist: false, capabilityHandler }) });
            const replies = structuredClone(item.workflowInputs ?? []);
            let record = await workflow.start({ agentId, deliveryVersion, scopeId, definition: workflowDefinition, input, signal });
            while (record.status === "waiting_input" && replies.length) {
              const reply = replies.shift();
              if (reply!.stepId !== record.waiting!.stepId) fail("activation_workflow_input_order_mismatch");
              record = await workflow.resume({ id: record.id, input: JSON.parse(reply!.inputJson), signal });
            }
            result.workflow = { definitionHash: record.definitionHash, status: record.status,
              completedSteps: record.steps.filter((step) => step.status === "completed").map((step) => step.id),
              batchItems: record.steps.reduce((sum, step) => sum + step.items.length, 0) };
            if (record.status === "completed" && !replies.length) {
              const entries = await Promise.all(workflowDefinition.outputs.map(async (id) => [id, await workflow!.readResult(record, record.resultRefs[id])]));
              run = { status: "passed", output: entries.length === 1 ? entries[0]![1] : Object.fromEntries(entries) };
            } else run = { status: ["interrupted", "needs_review"].includes(record.status) ? "error" : "failed", output: null,
              reason: replies.length ? "unused_workflow_input_fixtures" : record.status === "waiting_input" ? "workflow_input_fixture_missing" : record.reason ?? `workflow_${record.status}` };
          } else run = managed ? await serviceRunner!.run({ agentId, deliveryVersion, scopeId, actionId: action.id, input,
            signal, persist: false, capabilityHandler }) : await executor.runAction({ codeDir: snapshot.path, entrypoint: plan.entrypoint,
            actionId: action.id, input, signal, onCapability: ({ capability, args, signal: callSignal }) => capabilityHandler(capability, args, { signal: callSignal }) });
          signal?.throwIfAborted(); actual = run.output;
          result.status = unsupported ? "not_run" : integrityFailed ? "error" : unexpected || remaining.length ? "failed" : run.status;
          result.reason = unsupported ? "activation_capability_unsupported" : integrityFailed ? "activation_artifact_integrity_failed"
            : unexpected ? "activation_capability_unexpected" : remaining.length ? "activation_capability_unused" : run.reason ?? "";
          result.actionExecuted = run.status === "passed";
          if (run.status === "passed") {
            try { validateActionOutput(action, actual); }
            catch (error) {
              if (!(error instanceof InputError) || error.reason !== "output_contract_failed" || objectFields(error.validationIssue).reason === "invalid_schema") throw error;
              if (!["error", "not_run"].includes(result.status)) {
                result.status = "failed"; result.reason = "action_output_schema_mismatch";
              }
            }
          }
          await caseStore.update(agentId, task.id, { status: result.status === "passed" ? "completed" : "failed", result: actual ?? null });
        } finally {
          await workflow?.close({ permanent: true });
          if (managed && executionScope !== "shared") await serviceRunner!.stop({ agentId, deliveryVersion, scopeId, reason: "verification_complete" });
          await caseStore.settle();
        }
      }
      result.actual = actual ?? null; result.assertionsHash = acceptanceEvidenceHash(resolved.assertions);
      result.assertionCount = resolved.assertions.length;
      result.failedAssertionPaths = resolved.assertions.filter((assertion) => !matchesDevelopmentAssertion(actual, assertion)).map((assertion) => assertion.path);
      if (result.status === "passed" && result.failedAssertionPaths.length) { result.status = "failed"; result.reason = "activation_assertion_mismatch"; }
    }
    if ((await inspectDevelopmentCode(snapshot.path)).hash !== snapshot.hash) fail("activation_snapshot_changed");
    report.status = report.results.some((item) => item.status === "error") ? "error" : report.results.some((item) => item.status === "failed") ? "failed"
      : report.results.some((item) => item.status !== "passed") ? "not_run" : "passed";
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    report.status = "error"; report.reason = reasonOf(error, "activation_business_verification_failed");
  } finally {
    await serviceRunner?.close({ permanent: true });
    await Promise.allSettled([...activeCalls]);
    if (directory) await rm(directory, { recursive: true, force: true });
  }
  return finish();
}
