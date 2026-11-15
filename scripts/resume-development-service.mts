import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startLocalApplication } from "../src/installation/installation-runtime.mjs";
import { createRequestHandler } from "../src/server.mjs";
import { PrototypeAgents } from "../src/agents/agent-prototype.mjs";
import { createExecutionSession } from "../src/runtime/execution-runtime.mjs";
import { objectFields } from "../src/runtime/type-boundary.mjs";
import { readDevelopmentRunRecord } from "../src/development/development-record.mjs";
import { InputError } from "../src/requirements/core.mjs";
import { developmentEventDiagnostic, observeDevelopmentSessions } from "./development-observer.mjs";

/** Runs the accepted development in its own process. Losing the observer must not exit this process. */
export async function serveResumeDevelopment(args: string[]) {
  const [dataArgument, agentId, developmentId, outputArgument, mutationId] = args;
  if (args.length !== 5 || !dataArgument || !outputArgument || !mutationId
    || ![agentId, developmentId, mutationId].every(id => /^[\w-]{1,100}$/.test(id ?? "")))
    throw new Error("任务进程参数无效。");
  const dataDir = resolve(dataArgument), output = resolve(outputArgument), cwd = process.cwd();
  const recordFile = join(dataDir, "agents", agentId!, "development/records", `${developmentId}.json`);
  const original = readDevelopmentRunRecord(JSON.parse(readFileSync(recordFile, "utf8")));
  assert.equal(original.agentId, agentId);
  assert.notEqual(original.status, "completed", "已完成的任务不能作为续测停点");
  const abort = new AbortController();
  let releaseStop = () => {};
  const untilStop = new Promise<void>(resolveStop => { releaseStop = resolveStop; });
  const requestStop = () => { abort.abort(); releaseStop(); };
  process.on("SIGTERM", requestStop);
  process.on("message", (message) => { if (objectFields(message).type === "shutdown") requestStop(); });
  const secrets: string[] = [];
  const eventsFile = join(output, "events.jsonl");
  let connected = true, requests = 0, firstProblem: Record<string, unknown> | undefined, agents: PrototypeAgents | undefined;
  let app: Awaited<ReturnType<typeof startLocalApplication>> | undefined;
  const send = (message: unknown) => {
    if (!connected || !process.send) return false;
    try { process.send(message); return true; }
    catch { connected = false; return false; }
  };
  process.on("disconnect", () => { connected = false; });
  const publish = (message: { type: string; event?: unknown }) => {
    if (send(message) || message.type !== "event") return;
    appendFileSync(eventsFile, JSON.stringify(message.event) + "\n", { mode: 0o600 });
  };
  const log = (type: string, details: Record<string, unknown> = {}) => {
    if (type === "model_request") requests++;
    publish({ type: "event", event: developmentEventDiagnostic({ at: new Date().toISOString(), type, ...details, requests }, secrets) });
  };
  const fail = (kind: string, details: Record<string, unknown>) => {
    try { log("problem", { kind, ...details }); } catch { /* 记录失败不改变执行结果。 */ }
    if (firstProblem) return;
    firstProblem = { at: new Date().toISOString(), kind, ...details, requests };
    const saved = developmentEventDiagnostic(firstProblem, secrets);
    try {
      writeFileSync(join(output, "first-problem.json"), JSON.stringify(saved, null, 2) + "\n", { mode: 0o600 });
      send({ type: "problem", problem: saved });
      log("first_problem", objectFields(saved));
    } catch { /* 问题已留在内存，后续模型请求会被拒绝。 */ }
  };
  const checkContent = (details: Record<string, unknown> = {}) => {
    if (firstProblem) return;
    const active = agents?.development.active.get(agentId!)?.record;
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
    log });
  try {
    app = await startLocalApplication({ dataDir, port: 0, envPath: join(cwd, ".env"), signal: abort.signal, createHandler(options) {
      for (const key of [options.config?.apiKey, options.config?.jevApiKey]) if (typeof key === "string" && key) secrets.push(key);
      agents = new PrototypeAgents({ config: options.config ?? {}, cwd, dataDir, sessionFactory, enforceRequirementConfirmation: true });
      return createRequestHandler({ ...options, prototypeAgents: agents });
    } });
    if (abort.signal.aborted) throw new Error("任务进程在提供服务前被停止");
    const owner = agents;
    if (!owner) throw new Error("任务进程没有完成启动");
    assert.equal((await owner.getDevelopment(agentId!))?.id, developmentId, "当前研发编号与指定停点不同");
    const architecture = objectFields(await owner.getArchitecture(agentId!));
    assert.equal(architecture.status, "passed", "架构必须已通过，不能隐式重建");
    assert.equal(architecture.version, original.architectureRef.version);
    assert.equal(architecture.candidateHash, original.architectureRef.candidateHash);
    const service = { url: app.url, mutationId, agentId, developmentId, pid: process.pid };
    writeFileSync(join(output, "service.json"), JSON.stringify(service, null, 2) + "\n", { mode: 0o600 });
    send({ type: "service_ready", ...service, secrets: [...secrets] });
    await untilStop;
  } finally {
    await app?.dispose().catch(() => { process.exitCode = 1; });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  serveResumeDevelopment(process.argv.slice(2)).catch(error => {
    const reported = developmentEventDiagnostic(error);
    const output = process.argv[5];
    const finish = () => {
      if (output && existsSync(output)) {
        try { writeFileSync(join(resolve(output), "service-error.json"), JSON.stringify(reported, null, 2) + "\n", { mode: 0o600 }); }
        catch { /* 观察进程仍可从启动失败消息得知原因。 */ }
      }
      process.exit(process.exitCode && process.exitCode !== 0 ? process.exitCode : 1);
    };
    if (!process.send) finish();
    else process.send({ type: "fatal", error: reported }, finish);
  });
