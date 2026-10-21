import test from "node:test";
import assert from "node:assert/strict";
import { MAIN_PROMPT } from "../src/main/main-prompts.mjs";
import { SYSTEM_PROMPT, INSPECTION_PROMPT } from "../src/runtime/pi-runtime.mjs";
import { DESIGN_PROMPT, REVIEW_PROMPT, SPECIALIST_PROMPT, renderArchitectureReviewPrompt } from "../src/architecture/architecture-prompts.mjs";
import { PLAN_PROMPT, CODE_PROMPT, REVIEW_PROMPT as DEVELOPMENT_REVIEW_PROMPT } from "../src/development/development-prompts.mjs";
import { GROUP_ROUTING_SYSTEM } from "../src/collaboration/group-routing.mjs";
import { REQUIREMENT_ROUTING_PROMPT } from "../src/main/requirement-routing.mjs";
import { CONVERSATION_VERIFICATION_PROMPT } from "../src/verification/conversation-verification.mjs";
import { ACTION_MODEL_PROMPT, GROUP_MEMBER_BOUNDARY, GROUP_ROUTING_BOUNDARY, RUNTIME_BOUNDARY } from "../src/agents/agent-prototype.mjs";

const EXPLANATION = /你是 NEUMA。NEUMA（纽玛）是用户正在使用的本地工作台。对用户只用这个名字，不要把它解释成乐谱、缩写或其他产品。/;

test("直接和用户对话的模型先说明 NEUMA 是本地工作台", () => {
  for (const prompt of [MAIN_PROMPT, SYSTEM_PROMPT]) {
    assert.match(prompt, EXPLANATION);
  }
});

test("不直接和用户对话的模型只写角色，提示词里不出现未解释的 NEUMA", () => {
  const prompts = [INSPECTION_PROMPT, DESIGN_PROMPT, REVIEW_PROMPT, SPECIALIST_PROMPT,
    renderArchitectureReviewPrompt({ batchMode: true }), PLAN_PROMPT, CODE_PROMPT, DEVELOPMENT_REVIEW_PROMPT,
    GROUP_ROUTING_SYSTEM, REQUIREMENT_ROUTING_PROMPT, CONVERSATION_VERIFICATION_PROMPT,
    RUNTIME_BOUNDARY, GROUP_ROUTING_BOUNDARY, GROUP_MEMBER_BOUNDARY, ACTION_MODEL_PROMPT];
  for (const prompt of prompts) {
    assert.doesNotMatch(prompt, /NEUMA/);
    assert.match(prompt, /你是|你负责|你参加/);
  }
});
