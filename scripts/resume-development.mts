import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import { readDevelopmentRunRecord } from "../src/development/development-record.mjs";
import { cancelDevelopmentOperation, continueDevelopmentOperation } from "./development-operation.mjs";
import { developmentDiagnostic, developmentEventDiagnostic } from "./development-observer.mjs";

/** Explicit maintenance entry: one continuation, one saved operation ID, original domain state.
 * This process only watches over HTTP. The task process keeps running if observation stops. */
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
  writeFileSync(join(output, "source.json"), json({ at: new Date().toISOString(), dataDir, agentId, developmentId, mutationId,
    architectureRef: original.architectureRef, recordFile }), { flag: "wx", mode: 0o600 });
  cpSync(agentDir, join(output, "baseline-agent"), { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  let firstProblem: Record<string, unknown> | undefined, requests = 0, generation = "", running = false;
  let operation: unknown, canceling: Promise<void> | undefined, serviceUrl = "", childExited = false, settled = false, submitted = false;
  const log = (type: string, details: Record<string, unknown> = {}) => {
    const event = developmentEventDiagnostic({ at: new Date().toISOString(), type, ...details }, secrets);
    appendFileSync(join(output, "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
    if (["service_ready", "progress", "model_request", "first_problem", "observation_error", "finished"].includes(type))
      process.stdout.write(JSON.stringify(event, null, 2) + "\n");
  };
  const noteProblem = (problem: unknown) => {
    if (firstProblem) return;
    firstProblem = objectFields(problem);
    if (running && generation) requestCancel();
  };
  const noteEvent = (event: unknown) => {
    const value = objectFields(event);
    if (value.type === "model_request") requests = Number(value.requests) || requests;
    if (value.type === "first_problem") noteProblem(event);
    appendFileSync(join(output, "events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
    if (typeof value.type === "string" && ["model_request", "first_problem"].includes(value.type))
      process.stdout.write(JSON.stringify(event, null, 2) + "\n");
  };
  const requestCancel = () => {
    if (canceling || !serviceUrl || !generation) return;
    log("explicit_stop", { reason: firstProblem?.kind, operation });
    canceling = cancelDevelopmentOperation({ baseUrl: serviceUrl, agentId, mutationId, generation }).catch(error => {
      log("observation_error", { phase: "cancel", error });
    });
  };
  const child = fork(fileURLToPath(new URL("./resume-development-service.mjs", import.meta.url)),
    [dataDir, agentId, developmentId, output, mutationId],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], cwd, env: process.env });
  const observer = new AbortController();
  const ready = new Promise<string>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("任务进程没有在时限内开始提供服务")), 180_000);
    let pending = true;
    const finish = (error?: Error, url?: string) => {
      if (!pending) return;
      pending = false;
      clearTimeout(timer);
      if (error) rejectReady(error); else resolveReady(url!);
    };
    child.on("message", (message) => {
      const value = objectFields(message);
      if (value.type === "service_ready" && typeof value.url === "string") {
        serviceUrl = value.url;
        if (Array.isArray(value.secrets)) for (const key of value.secrets) if (typeof key === "string" && key) secrets.push(key);
        finish(undefined, value.url);
      } else if (value.type === "fatal") {
        save("startup-error.json", value.error);
        finish(new Error("任务进程启动失败"));
      } else if (value.type === "problem") noteProblem(value.problem);
      else if (value.type === "event") noteEvent(value.event);
    });
    child.once("exit", (code) => {
      childExited = true;
      if (!settled) observer.abort();
      if (!serviceUrl) finish(new Error(`任务进程在提供服务前退出（${code ?? "无退出码"}）`));
    });
    child.once("error", (error) => finish(error instanceof Error ? error : new Error("任务进程无法启动")));
  });
  try {
    const url = await ready;
    log("service_ready", { url, mutationId, developmentId, pid: child.pid });
    submitted = true;
    const final = await continueDevelopmentOperation({ baseUrl: url, agentId, mutationId, signal: observer.signal,
      onRequestError(event) { log("observation_error", event); },
      async onView(view) {
        generation = view.operation.generation;
        operation = view.operation;
        if (view.snapshot) {
          running = view.snapshot.running;
          save("operation.json", view);
          log("progress", { phase: view.snapshot.phase, label: view.snapshot.label, running: view.snapshot.running,
            development: view.snapshot.result.development });
        }
        if (firstProblem && view.snapshot?.running) { requestCancel(); await canceling; }
      } });
    settled = true;
    running = false;
    const development = readDevelopmentRunRecord(JSON.parse(readFileSync(recordFile, "utf8")));
    save("development-after.json", development);
    if (!firstProblem && (final.error || final.interrupted || development.status !== "completed")) {
      firstProblem = { at: new Date().toISOString(), kind: "development_stopped", error: final.error, interrupted: final.interrupted,
        status: development.status, phase: development.phase, diagnostic: development.diagnostic, summary: development.summary, requests };
      save("first-problem.json", firstProblem);
      log("first_problem", firstProblem);
    }
    save("result.json", { status: firstProblem ? "stopped_on_new_problem" : "completed", dataDir, agentId, developmentId,
      mutationId, requests, firstProblem, final });
    log("finished", { status: firstProblem ? "stopped_on_new_problem" : "completed", developmentId, requests });
    await stopTask(child);
  } catch (error) {
    const keep = submitted && !settled && !childExited;
    log("observer_failed", { error, url: serviceUrl, mutationId, taskMayBeRunning: keep });
    save("observer-failure.json", { error, url: serviceUrl, agentId, mutationId, pid: child.pid,
      instruction: keep ? "任务进程保留。查询原 operation，不能重开任务或关闭服务。"
        : "不要新建研发批次或清零计数；先核对原研发记录和原会话。" });
    if (keep) { child.disconnect(); child.unref(); }
    else if (!childExited) await stopTask(child);
    throw error;
  }
}

function stopTask(child: ChildProcess) {
  return new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(() => { child.unref(); resolve(); }, 60_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    try { child.send({ type: "shutdown" }); }
    catch { clearTimeout(timer); try { child.kill("SIGTERM"); } catch { /* 进程已退出。 */ } resolve(); }
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  resumeDevelopment(process.argv.slice(2)).catch(() => {
    process.stderr.write("续测未正常结束；请核对四个参数及本次 events.jsonl / observer-failure.json。\n"); process.exitCode = 1;
  });
