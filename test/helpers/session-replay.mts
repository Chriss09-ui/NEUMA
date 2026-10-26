import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fixtureText, type FixtureChatRequest } from "./http-model.mjs";

export interface ReplaySource {
  version: 1;
  kind: "synthetic" | "deidentified-pattern" | "sanitized-transcript";
  complete: boolean;
  changes: string;
  protocol: "neuma-execution-v1";
}
export interface ReplayStep<T> {
  role: string;
  stage: string;
  tools: string[];
  context: string[];
  answer: T;
}

/** A finite script: a rejected match never consumes an answer or prints private input. */
export class SessionReplay<T> {
  private position = 0;
  private failure: Error | undefined;
  readonly source: ReplaySource;
  constructor(source: ReplaySource, private readonly steps: readonly ReplayStep<T>[]) {
    assert.equal(source.version, 1);
    assert.ok(["synthetic", "deidentified-pattern", "sanitized-transcript"].includes(source.kind));
    assert.equal(typeof source.complete, "boolean");
    assert.equal(source.protocol, "neuma-execution-v1");
    assert.ok(source.changes.trim());
    for (const step of steps) {
      assert.ok(step.role && step.stage && Array.isArray(step.tools) && Array.isArray(step.context));
      assert.equal(new Set(step.tools).size, step.tools.length);
    }
    this.source = structuredClone(source);
  }
  next(role: string, stage: string, request: FixtureChatRequest): T {
    if (this.failure) throw this.failure;
    const step = this.steps[this.position];
    const reject = (reason: string): never => {
      this.failure = new Error(`回放第 ${this.position + 1} 步 ${step?.role ?? "结束"}/${step?.stage ?? "结束"}：${reason}`);
      throw this.failure;
    };
    if (!step) return reject("出现额外请求");
    if (step.role !== role || step.stage !== stage) reject("角色或阶段不匹配");
    const tools = new Set(request.tools?.map(tool => tool.function.name) ?? []);
    if (step.tools.some(tool => !tools.has(tool))) reject("获准工具不匹配");
    const text = request.messages.map(message => fixtureText(message.content)).join("\n");
    if (step.context.some(fragment => !text.includes(fragment))) reject("请求上下文不匹配");
    this.position++;
    return step.answer;
  }
  assertConsumed(): void {
    if (this.failure) throw this.failure;
    assert.equal(this.position, this.steps.length, `回放仍有未消费步骤（已消费 ${this.position}/${this.steps.length}）`);
  }
  get consumed() { return this.position; }
}

/** Only synthetic request contracts are exported. No raw headers, messages, URLs or tool values. */
export function recordReplayContract(input: { role: string; stage: string; request: FixtureChatRequest }) {
  const names = input.request.tools?.map(tool => tool.function.name) ?? [];
  if (![input.role, input.stage, ...names].every(name => /^[a-z][a-z0-9_-]{0,79}$/u.test(name)))
    throw new Error("回放元数据仅允许受控角色、阶段及工具标识");
  return { version: 1 as const, protocol: "neuma-execution-v1" as const, role: input.role, stage: input.stage,
    tools: names, messageRoles: input.request.messages.map(message => {
      if (!["system", "user", "assistant", "tool"].includes(message.role)) throw new Error("回放消息角色无效");
      return message.role;
    }), contractHash: createHash("sha256").update(JSON.stringify([input.role, input.stage, names])).digest("hex") };
}
