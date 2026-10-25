import test from "node:test";
import assert from "node:assert/strict";
import { routingTool, routedMemberIds } from "../../src/collaboration/group-routing.mjs";

test("全员由平台展开，包括三人中的本人；其他成员排除上一轮整批公开发言者", () => {
  const participants = ["a", "b", "c"].map((id) => ({ id }));
  const history = [{ id: "earlier", sender: { type: "user" } }, { sender: { type: "agent", id: "c" } },
    { id: "previous", sender: { type: "user" } }, { sender: { type: "agent", id: "a" } },
    { sender: { type: "agent", id: "b" } }, { id: "source", sender: { type: "user" } },
    { sender: { type: "agent", id: "c" } }];
  assert.deepEqual(routedMemberIds({ mode: "all" }, participants, history, "source"), ["a", "b", "c"]);
  assert.deepEqual(routedMemberIds({ mode: "others" }, participants, history, "source"), ["c"]);
  assert.deepEqual(routedMemberIds({ mode: "named", memberIds: ["c"] }, participants, history, "source"), ["c"]);
  assert.throws(() => routedMemberIds({ mode: "named", memberIds: ["outside"] }, participants, history, "source"), /不存在或尚未就绪/);
  assert.deepEqual(routedMemberIds({ mode: "others" }, participants, [
    { id: "first", taskId: "first-task", sender: { type: "user" } },
    { id: "fast-followup", taskId: "second-task", sender: { type: "user" } },
    { taskId: "first-task", sender: { type: "agent", id: "a" } }
  ], "fast-followup"), ["b", "c"]);
});

test("中立路由工具只接受有效对象选择，取消不提交；全员不能由模型手填子集", async () => {
  let captured;
  const tool = routingTool((value) => { captured = value; });
  for (const value of [{ mode: "invented" }, { mode: "all", memberIds: ["a", "b"] }, { mode: "named" },
    { mode: "named", memberIds: ["../a"] }, { mode: "clarify", question: "" }, { mode: "default", question: "伪造问题" }]) {
    await assert.rejects(tool.execute("bad", value)); assert.equal(captured, undefined);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(tool.execute("cancelled", { mode: "all" }, controller.signal)); assert.equal(captured, undefined);
  assert.equal((await tool.execute("all", { mode: "all" })).terminate, true); assert.deepEqual(captured, { mode: "all" });
  await tool.execute("named", { mode: "named", memberIds: ["a", "a", "b"] });
  assert.deepEqual(captured, { mode: "named", memberIds: ["a", "b"] });
});
