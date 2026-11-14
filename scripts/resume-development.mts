import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startLocalApplication } from "../src/installation/installation-runtime.mjs";
import { createRequestHandler } from "../src/server.mjs";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { createExecutionSession } from "../src/runtime/execution-runtime.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import { readDevelopmentRunRecord } from "../src/development/development-record.mjs";
import { InputError } from "../src/requirements/core.mjs";
import { continueDevelopmentOperation } from "./development-operation.mjs";
import { developmentDiagnostic, observeDevelopmentSessions } from "./development-observer.mjs";

/** Explicit maintenance entry: one continuation, one saved operation ID, original domain state. */
export async function resumeDevelopment(args: string[]) {
  const [dataArgument, agentId, developmentId, outputArgument] = args;
  if (args.length !== 4 || !dataArgument || !outputArgument || !agentId || !developmentId
    || ![agentId, developmentId].every(id => /^[\w-]{1,100}$/.test(id)))
    throw new Error("用法：node dist/ts-build/package/scripts/resume-development.mjs <dataDir> <agentId> <developmentId> <新日志目录>");
  const dataDir = resolve(dataArgument), output = resolve(outputArgument), cwd = process.cwd();
  const agentDir = join(dataDir, "agents", agentId), recordFile = join(agentDir, "development/records", `${developmentId}.json`);
  const original = readDevelopmentRunRecord(JSON.parse(readFileSync(recordFile, "utf8")));
  assert.equal(original.agentId, agentId);
  assert.notEqual(original.status, "completed", "已完成的任务不能作为续测停点");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const mutationId = `resume_${randomUUID().replaceAll("-", "")}`, secrets: string[] = [];
  const json = (value: unknown) => JSON.stringify(developmentDiagnostic(value, secrets), null, 2) + "\n";
  const save = (name: string, value: unknown) => writeFileSync(join(output, name), json(value), { mode: 0o600 });
  // Refuse to overwrite an earlier attempt or silently issue it a different operation ID.
  writeFileSync(join(output, "source.json"), json({ at: new Date().toISOString(), dataDir, agentId, developmentId, mutationId,
    architectureRef: original.architectureRef, recordFile }), { flag: "wx", mode: 0o600 });
  cpSync(agentDir, join(output, "baseline-agent"), { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  const log = (type: string, details: Record<string, unknown> = {}) => {
    const event = { at: new Date().toISOString(), type, ...details };
    appendFileSync(join(output, "events.jsonl"), JSON.stringify(developmentDiagnostic(event, secrets)) + "\n", { mode: 0o600 });
    if (["service_ready", "progress", "model_request", "first_problem", "observation_error", "finished"].includes(type))
      process.stdout.write(json(event));
  };
  let firstProblem: Record<string, unknown> | undefined, agents: PrototypeAgents | undefined, requests = 0;
  const fail = (kind: string, details: Record<string, unknown>) => {
    log("problem", { kind, ...details });
    if (firstProblem) return;
    firstProblem = { at: new Date().toISOString(), kind, ...details, requests };
    save("first-problem.json", firstProblem); log("first_problem", firstProblem);
  };
  const checkContent = (details: Record<string, unknown> = {}) => {
    if (firstProblem) return;
    const active = agents?.development.active.get(agentId)?.record;
    if (!active) return;
    assert.equal(active.id, developmentId, "续测不能切换研发批次");
    for (const [owner, row] of Object.entries(active.retryPolicy?.content ?? {})) {
      const before = original.retryPolicy?.content[owner]?.count ?? 0;
      if (row.count > before) fail("new_content_rejection", { ...details, owner, before, after: row.count,
        issues: active.retryPolicy?.unresolved[owner] });
    }
  };
  const sessionFactory = observeDevelopmentSessions({ factory: createExecutionSession, fail, checkContent,
    beforeRequest() { if (firstProblem) throw new InputError("续测已记录新问题，停止发起后续模型请求；原提交错误见本次日志。"); },
    log(type, details) { if (type === "model_request") requests++; log(type, { ...details, requests }); },
  });
  const app = await startLocalApplication({ dataDir, port: 0, envPath: join(cwd, ".env"), createHandler(options) {
    for (const key of [options.config?.apiKey, options.config?.jevApiKey]) if (typeof key === "string" && key) secrets.push(key);
    agents = new PrototypeAgents({ config: options.config ?? {}, cwd, dataDir, sessionFactory, enforceRequirementConfirmation: true });
    return createRequestHandler({ ...options, prototypeAgents: agents });
  } });
  const owner = agents!;
  let settled = false, submitted = false;
  try {
    assert.equal((await owner.getDevelopment(agentId))?.id, developmentId, "当前研发编号与指定停点不同");
    const architecture = objectFields(await owner.getArchitecture(agentId));
    assert.equal(architecture.status, "passed", "架构必须已通过，不能隐式重建");
    assert.equal(architecture.version, original.architectureRef.version);
    assert.equal(architecture.candidateHash, original.architectureRef.candidateHash);
    save("service.json", { url: app.url, mutationId, agentId, developmentId });
    log("service_ready", { url: app.url, mutationId, developmentId });
    submitted = true;
    const final = await continueDevelopmentOperation({ baseUrl: app.url, agentId, mutationId,
      onRequestError(event) { log("observation_error", event); },
      async onView(view) {
        if (view.snapshot) save("operation.json", view);
        if (view.snapshot) log("progress", { phase: view.snapshot.phase, label: view.snapshot.label, running: view.snapshot.running,
          development: view.snapshot.result.development });
        checkContent();
        if (firstProblem && view.snapshot?.running) {
          // A concrete task failure has been saved. Transport errors never enter this path.
          log("explicit_stop", { reason: firstProblem.kind, operation: view.operation });
          await owner.cancelOperation(agentId, mutationId, view.operation.generation);
        }
      },
    });
    settled = true;
    const development = await owner.readDevelopmentRun(developmentId);
    save("development-after.json", development);
    if (!firstProblem && (final.error || final.interrupted || development?.status !== "completed"))
      fail("development_stopped", { error: final.error, interrupted: final.interrupted, status: development?.status,
        phase: development?.phase, diagnostic: development?.diagnostic, summary: development?.summary });
    save("result.json", { status: firstProblem ? "stopped_on_new_problem" : "completed", dataDir, agentId, developmentId,
      mutationId, requests, firstProblem, final });
    log("finished", { status: firstProblem ? "stopped_on_new_problem" : "completed", developmentId, requests });
  } catch (error) {
    // An observation/protocol failure is not authorization to stop an accepted job.
    log("observer_failed", { error, url: app.url, mutationId, taskMayBeRunning: submitted && !settled });
    if (submitted && !settled) {
      save("observer-failure.json", { error, url: app.url, agentId, mutationId,
        instruction: "后台服务保留。查询原 operation，不能重开任务或关闭服务。" });
    }
    throw error;
  } finally {
    if (settled || !submitted) await app.dispose();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  resumeDevelopment(process.argv.slice(2)).catch(() => {
    process.stderr.write("续测未正常结束；请核对四个参数及本次 events.jsonl / observer-failure.json。\n"); process.exitCode = 1;
  });
