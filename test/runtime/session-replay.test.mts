import test from "node:test";
import assert from "node:assert/strict";
import { SessionReplay, recordReplayContract, type ReplaySource } from "../helpers/session-replay.mjs";
import type { FixtureChatRequest } from "../helpers/http-model.mjs";

const source: ReplaySource = { version: 1, kind: "synthetic", complete: true, changes: "完全合成的协议反例", protocol: "neuma-execution-v1" };
const request = { messages: [{ role: "user", content: "bound-context" }], tools: [{ function: { name: "submit" } }] };
const steps = [{ role: "reviewer", stage: "review", tools: ["submit"], context: ["bound-context"], answer: "answer" }];
test("有限回放拒绝串角色、错上下文、多调和少调，失败不输出请求正文", () => {
  for (const [role, stage, input] of [
    ["developer", "review", request], ["reviewer", "other", request],
    ["reviewer", "review", { ...request, tools: [] }],
    ["reviewer", "review", { ...request, messages: [{ role: "user", content: "private-text" }] }],
  ] as [string, string, FixtureChatRequest][]) {
    const replay = new SessionReplay(source, steps);
    assert.throws(() => replay.next(role, stage, input), error => error instanceof Error && !error.message.includes("private-text"));
    assert.equal(replay.consumed, 0);
    assert.throws(() => replay.assertConsumed());
  }
  const replay = new SessionReplay(source, steps);
  assert.throws(() => replay.assertConsumed(), /未消费/);
  assert.equal(replay.next("reviewer", "review", request), "answer"); replay.assertConsumed();
  assert.throws(() => replay.next("reviewer", "review", request), /额外请求/);
});
test("回放记录白名单排除未知嵌套字段与正文", () => {
  const recorded = recordReplayContract({ role: "reviewer", stage: "review", request: { ...request,
    authorization: "private-credential", messages: [{ role: "user", content: "private-material" }],
    tools: [Object.assign({ function: { name: "submit" } }, { credentials: { value: "private-token" } })] } });
  assert.doesNotMatch(JSON.stringify(recorded), /private-|authorization|credentials/);
  assert.deepEqual(recorded.tools, ["submit"]);
});
