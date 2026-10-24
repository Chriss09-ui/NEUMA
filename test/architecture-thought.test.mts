import test from "node:test";
import assert from "node:assert/strict";
import type { ThoughtSegment } from "../public/ui-types.js";
import { architectureThoughtProgress } from "../src/architecture/architecture.mjs";
import { createAgentMakingView, rememberArchitectureThought } from "../public/agent-build-view.js";

const thought = (type: string, delta?: string) => ({ type: "message_update", assistantMessageEvent: { type, delta } });

test("架构思考只转发设计、评估和顾问的思考增量", () => {
  assert.deepEqual(architectureThoughtProgress(thought("thinking_delta", "先看托管页面"), "designer"),
    { type: "architecture_thought", role: "designer", delta: "先看托管页面" });
  assert.deepEqual(architectureThoughtProgress(thought("thinking_start"), "reviewer"),
    { type: "architecture_thought", role: "reviewer", break: true });
  assert.equal(architectureThoughtProgress(thought("thinking_delta", "内部"), "development"), null);
  assert.equal(architectureThoughtProgress(thought("text_delta", "提交方案"), "designer"), null);
  assert.equal(architectureThoughtProgress(thought("thinking_delta", ""), "specialist"), null);
});

test("同一角色的思考连在一起，换角色或新一轮才另起一段", () => {
  let segments = rememberArchitectureThought([], { role: "designer", delta: "页面" });
  segments = rememberArchitectureThought(segments, { role: "designer", delta: "可以自写图形" });
  segments = rememberArchitectureThought(segments, { role: "designer", break: true });
  segments = rememberArchitectureThought(segments, { role: "designer", delta: "再核对滑块" });
  segments = rememberArchitectureThought(segments, { role: "reviewer", delta: "验收留到打开页面" });
  assert.deepEqual(segments.map(({ role, text }) => ({ role, text })), [
    { role: "designer", text: "页面可以自写图形" },
    { role: "designer", text: "再核对滑块" },
    { role: "reviewer", text: "验收留到打开页面" },
  ]);
});

test("制作页默认收起架构思考，展开后能看到各角色原文", () => {
  class Node {
declare className: string;
declare textContent: string;
declare children: Node[];
declare tagName: string;
declare dataset: Record<string, string | undefined>;
declare hidden: boolean;
declare open: boolean;
declare scrollTop: number;
declare scrollHeight: number;
declare clientHeight: number;
    constructor(tag: string) { this.tagName = tag; this.className = ""; this.textContent = ""; this.children = []; this.dataset = {};
      this.hidden = false; this.open = false; this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; }
    setAttribute() {}
    addEventListener() {}
    append(...nodes: Node[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: Node[]) { this.children = [...nodes]; }
    classList = { toggle() {}, add() {} };
  }
  const documentRef = { createElement: (tag: string) => new Node(tag) };
  const agent = { id: "making-one", name: "微积分可视化学习助手", draft: { goal: { value: "看公式" } } };
  const state = { status: "building", operation: { phase: "designing" }, architectureThoughts: [] as ThoughtSegment[] };
  const view = createAgentMakingView(agent, state, {}, documentRef);
  assert.equal(view.thoughts.open, false);
  assert.equal(view.thoughts.hidden, false);
  assert.equal(view.thoughts.className, "agent-making-thoughts");
  state.architectureThoughts = rememberArchitectureThought(state.architectureThoughts, { role: "designer", delta: "用托管页面做滑块" });
  view.syncThoughts();
  const block = view.thoughtBody.children[0];
  assert.equal(block!.children[0]!.textContent, "架构设计");
  assert.equal(block!.children[1]!.textContent, "用托管页面做滑块");
  view.thoughts.open = true;
  const again = createAgentMakingView(agent, state, { thoughtsOpen: view.thoughts.open }, documentRef);
  assert.equal(again.thoughts.open, true);
  assert.equal(again.thoughtBody.children[0]!.children[1]!.textContent, "用托管页面做滑块");
});
