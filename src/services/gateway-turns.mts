import { createHash, randomUUID } from "node:crypto";
import type { PrototypeAgents } from "../agents/agent-prototype.mjs";
import type { ApplicationTask, TaskSource } from "../contracts/application.mjs";
import type { GatewayGrant } from "./service-gateway.mjs";
import { taskFinished } from "../applications/task-store.mjs";
import { registerTaskArtifact } from "../applications/task-artifacts.mjs";
import { readWorkspaceBytes } from "../agents/agent-workspace.mjs";
import { MaterialStore } from "../materials/material-store.mjs";
import { materialFormat, materialName, validateMaterialSignature } from "../materials/material-formats.mjs";
import { REQUIREMENT_MESSAGE_MAX_CHARACTERS } from "../requirements/requirement-limits.mjs";
import { textWithinLimit } from "../runtime/text-length.mjs";
import { isRecord, objectFields } from "../runtime/type-boundary.mjs";

type Host = Pick<PrototypeAgents, "agents" | "getActiveArchitecture" | "approvedDefinition" | "builds" | "removing" |
  "dataTransitions" | "storage" | "applications" | "prompt">;
type Check = () => Promise<void>;
interface FileInput { name: string; bytes: Buffer }
interface RunningTurn { agentId: string; controller: AbortController; stopped?: "cancelled" | "interrupted"; done: Promise<void>;
  progress: { phase: string; message: string } }

export class GatewayTurnError extends Error {
  constructor(readonly reason: string, message: string, readonly statusCode = 400) { super(message); }
}

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const turnAction = "agent.turn";
const versionOf = (agent: { revision: number; architectureRef?: { version: number; candidateHash: string } }) =>
  agent.architectureRef ? `agent:${agent.revision}:${agent.architectureRef.version}:${agent.architectureRef.candidateHash}` : undefined;
const scopeOf = (grantId: string, conversationId: string) => `gateway:${grantId}:${conversationId}`;
export function ownsTurn(task: { agentId: string; actionId: string; deliveryVersion: string; source: TaskSource }, grant: GatewayGrant) {
  const source = task.source;
  return !!grant.conversationVersion && task.agentId === grant.agentId && task.deliveryVersion === grant.deliveryVersion
    && task.actionId === turnAction && source.kind === "gateway_turn" && source.gatewayGrant === grant.grantId
    && typeof source.conversationId === "string" && source.scope === scopeOf(grant.grantId, source.conversationId);
}

function readFiles(value: unknown): FileInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) throw new GatewayTurnError("invalid_files", "一次最多可附带 10 个文件");
  return value.map((file: unknown) => {
    if (!isRecord(file) || Object.keys(file).some(key => key !== "name" && key !== "data") || typeof file.data !== "string" || !file.data.length)
      throw new GatewayTurnError("invalid_files", "每个文件需要文件名和 base64 编码的内容");
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.toString("base64") !== file.data) throw new GatewayTurnError("invalid_files", "文件内容需要完整的 base64 编码");
    try {
      const name = materialName(file.name);
      validateMaterialSignature(materialFormat(name), bytes.subarray(0, 16));
      return { name, bytes };
    } catch { throw new GatewayTurnError("invalid_files", "文件名称、格式或内容与支持的材料类型不符"); }
  });
}

export class GatewayTurns {
  private readonly running = new Map<string, RunningTurn>();
  constructor(private readonly host: Host) {}

  progress(taskId: string) { return this.running.get(taskId)?.progress; }

  async runtime(id: string) {
    const architecture = await this.host.getActiveArchitecture(id), agent = this.host.agents.get(id);
    if (!agent || architecture?.delivery !== "ready" || !this.host.approvedDefinition(agent, architecture)
      || this.host.builds.has(id) || this.host.removing.has(id) || this.host.dataTransitions.has(id)) return null;
    const version = versionOf(agent);
    return version ? { agent, version } : null;
  }

  matchesVersion(id: string, version: string) {
    const agent = this.host.agents.get(id);
    return !!agent && versionOf(agent) === version && !this.host.dataTransitions.has(id);
  }

  async submit(grant: GatewayGrant, input: Record<string, unknown>, check: Check) {
    const { agentId, grantId, deliveryVersion } = grant;
    const runtime = await this.runtime(agentId);
    if (!runtime || runtime.version !== grant.conversationVersion) throw new GatewayTurnError("delivery_changed", "智能体版本已变化，请更新接口", 409);
    const message = input.message;
    if (!textWithinLimit(message, REQUIREMENT_MESSAGE_MAX_CHARACTERS) || !message.trim())
      throw new GatewayTurnError("invalid_message", "请提供 1 到 12000 字的任务说明");
    if (typeof input.mutationId !== "string" || !/^[\w-]{8,100}$/.test(input.mutationId)) throw new GatewayTurnError("invalid_request", "请提供稳定的任务请求编号");
    const mutationId = hash(`${grantId}:turn:${input.mutationId}`);
    const conversationId = input.conversationId ?? mutationId.slice(0, 32);
    if (typeof conversationId !== "string" || !/^[a-f0-9]{32}$/.test(conversationId) || input.conversationId === null)
      throw new GatewayTurnError("invalid_conversation", "请使用本接口返回的会话编号");
    const scope = scopeOf(grantId, conversationId), files = readFiles(input.files);
    const history: Record<string, unknown>[] = [];
    await check();
    const { task, created } = await this.host.applications.store.create(agentId, {
      actionId: turnAction, mutationId, deliveryVersion, revision: runtime.agent.revision,
      source: { kind: "gateway_turn", scope, gatewayGrant: grantId, conversationId },
      input: { message, files: files.map(({ name, bytes }) => ({ name, sha256: hash(bytes) })) },
    }, tasks => {
      const turns = tasks.filter(turn => ownsTurn(turn, grant) && turn.source.scope === scope);
      if (input.conversationId !== undefined && !turns.length) throw new GatewayTurnError("conversation_not_shared", "当前接口没有这个会话", 404);
      if (turns.some(turn => !taskFinished(turn))) throw new GatewayTurnError("conversation_busy", "请等待当前轮次完成或停止后再继续", 409);
      for (const turn of turns.filter(turn => turn.status === "completed").slice(-20)) {
        const result = objectFields(turn.result);
        history.push({ role: "user", content: objectFields(turn.input).message, revision: turn.revision, attachments: result.attachments },
          { role: "assistant", content: result.reply, revision: turn.revision });
      }
    });
    if (created) {
      const item: RunningTurn = { agentId, controller: new AbortController(), done: Promise.resolve(), progress: { phase: "preparing", message: "正在准备任务" } };
      this.running.set(task.id, item);
      item.done = this.run(task, conversationId, message, files, history, item, check).finally(() => this.running.delete(task.id));
      void item.done.catch(() => {});
    }
    return { taskId: task.id, conversationId, deliveryVersion, status: task.status };
  }

  private async run(task: Pick<ApplicationTask, "id" | "agentId" | "source">, conversationId: string, message: string, files: FileInput[],
    history: Record<string, unknown>[], item: RunningTurn, checkGrant: Check) {
    const { agentId, source } = task, { signal } = item.controller;
    const check = async () => { signal.throwIfAborted(); await checkGrant(); signal.throwIfAborted(); };
    const base = `private/gateway-conversations/${source.gatewayGrant}/${conversationId}`;
    const storage = this.host.storage, store = this.host.applications.store;
    // Give both the material parser and the working Agent the same conversation-local inputs.
    const materials = new MaterialStore({ storage: {
      path: (id, file, create) => storage.path(id, `${base}/${file}`, create),
      directory: (id, dir, options) => storage.directory(id, dir ? `${base}/${dir}` : base, options),
      readJson: (id, file, options) => storage.readJson(id, `${base}/${file}`, options),
      writeJson: (id, file, value, options) => storage.writeJson(id, `${base}/${file}`, value, options),
      removeDirectory: (id, dir) => storage.removeDirectory(id, `${base}/${dir}`),
    } });
    try {
      await check();
      await store.update(agentId, task.id, { status: "running" });
      const root = await storage.directory(agentId, `${base}/workspace`, { create: true });
      const attachments = [];
      for (const { name, bytes } of files) {
        await check();
        const { attachment } = await materials.upload(agentId, { name, source: bytes, signal });
        attachments.push({ id: attachment.id });
      }
      const publish = async (file: unknown, written?: Buffer) => {
        await check();
        if (typeof file !== "string") throw new Error("产物需要当前会话内的相对文件名");
        const data = written ?? await readWorkspaceBytes(root, file, { signal });
        return registerTaskArtifact({ storage, store, id: agentId, taskId: task.id, path: file, data, signal, check });
      };
      const { reply } = await this.host.prompt({ agentId, sessionId: randomUUID(), message, attachments, history }, event => {
        if (event.type === "status" && typeof event.phase === "string")
          item.progress = { phase: event.phase, message: typeof event.label === "string" ? event.label : "智能体正在处理" };
      },
        { signal, gateway: { conversationId, scope: source.scope, root, materials, check, publish } });
      await check();
      await store.update(agentId, task.id, { status: "completed", result: { reply, attachments } });
    } catch (error) {
      const stopped = item.stopped ?? (signal.aborted ? "interrupted" : undefined);
      const diagnostic = objectFields(objectFields(error).diagnostic);
      const reason = stopped === "cancelled" ? "任务已停止" : stopped ? "任务已中断，已有操作请先核实"
        : diagnostic.reason === "not_configured" ? "请在 NEUMA 设置中连接模型" : "智能体未完成本轮任务，请检查模型、材料及运行状态";
      await store.update(agentId, task.id, { status: stopped ?? "failed", error: reason });
    } finally { await materials.close(); }
  }

  async cancel(id: string, taskId: string) {
    const item = this.running.get(taskId);
    if (item && item.agentId === id) {
      item.stopped = "cancelled";
      item.controller.abort();
    }
    return this.host.applications.store.update(id, taskId, { status: "cancelled", error: "任务已停止，已有操作保留" });
  }

  async interrupt(id?: string) {
    const work = [...this.running.values()].filter(item => id === undefined || item.agentId === id);
    for (const item of work) { item.stopped ??= "interrupted"; item.controller.abort(); }
    const results = await Promise.allSettled(work.map(item => item.done));
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}
