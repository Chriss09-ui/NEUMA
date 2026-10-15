import test from "node:test";
import assert from "node:assert/strict";
import { groupCapabilityFacts, publicConnectionFacts } from "../src/agents/agent-capabilities.mjs";

const date = "2026-10-14T00:00:00.000Z";
const fixture = (overrides = {}) => ({ agent: { id: "reader", revision: 3, updatedAt: date, fingerprint: "definition-one" },
  architecture: { version: 2, status: "passed", delivery: "ready", candidateHash: "architecture-one",
    design: { capabilities: [{ id: "read_workspace_file", status: "available", reason: "任务文本" }], connections: [] } },
  draft: { goal: { value: "阅读群共享材料" }, constraints: [{ text: "禁止编造来源" }] }, ready: true, approved: true,
  toolIds: ["read_workspace_file"], defaultModelConfigured: true, connectionView: { version: 0, connections: [] }, ...overrides });
const item = (facts, id) => facts.capabilities.find((entry) => entry.id === id);
const application = { manifest: { actions: [{ id: "local", title: "整理内容", connectionIds: [] },
  { id: "publish", title: "提交业务内容", connectionIds: ["business"] }] }, deliveryVersion: "delivery-one", checkedAt: date };

test("群能力只列真实文件工具和群材料范围，职责描述不能授予权限", () => {
  const facts = groupCapabilityFacts(fixture());
  assert.equal(facts.capabilitySchemaVersion, 1);
  assert.match(facts.capabilityVersion, /^cap-v1:[a-f0-9]{64}$/);
  assert.equal(item(facts, "read_workspace_file").availability, "callable");
  assert.equal(item(facts, "write_workspace_file"), undefined);
  assert.equal(item(facts, "read_material"), undefined);
  assert.equal(item(facts, "read_group_material").scope, "group_task");
  assert.equal(item(facts, "read_group_material_image").availability, "conditional");
  assert.match(item(facts, "read_group_material_image").requirements.join(" "), /实际支持图片/);
  assert.match(facts.hardBoundaries.find((entry) => entry.id === "group_privacy").reason, /私人记忆.*私聊.*未分享/);
  assert.match(facts.hardBoundaries.find((entry) => entry.id === "task_workspace").reason, /其他 Agent.*其他群任务/);
  assert.equal(facts.hardBoundaries.at(-1).reason, "禁止编造来源");
  const declared = fixture();
  declared.architecture.design.capabilities.push({ id: "external_service", status: "available", reason: "描述声称可用" });
  assert.equal(item(groupCapabilityFacts(declared), "external_service").availability, "unavailable");
});

test("模型缺配置呈条件未满足，不根据名称推定图片或业务能力", () => {
  const options = fixture({ defaultModelConfigured: false });
  const facts = groupCapabilityFacts(options);
  assert.equal(item(facts, "conversation").availability, "conditional");
  assert.match(item(facts, "conversation").requirements.join(" "), /模型/);
  const configured = groupCapabilityFacts({ ...options, connectionView: { version: 1, connections: [{ id: "model", kind: "model", version: 1,
    configured: true, status: "verified", testedAt: date, model: "vision-supermodel" }] } });
  assert.equal(item(configured, "conversation").availability, "callable");
  assert.equal(item(configured, "conversation").verification.status, "connection_checked");
  assert.equal(item(configured, "read_group_material_image").availability, "conditional");
  assert.doesNotMatch(JSON.stringify(configured), /vision-supermodel/);
  assert.notEqual(facts.capabilityVersion, configured.capabilityVersion);
});

test("应用入口不能绕过具体动作缺连接，交付验收与连接测试不冒充动作成功", () => {
  const options = fixture({ agent: { id: "app", revision: 1, execution: { kind: "node-action" } }, application });
  const facts = groupCapabilityFacts(options);
  assert.equal(item(facts, "run_application_action").availability, "conditional");
  assert.equal(item(facts, "action:local").availability, "callable");
  assert.equal(item(facts, "action:publish").availability, "conditional");
  assert.match(item(facts, "action:publish").requirements[0], /business.*尚未配置/);
  const configured = { ...options, connectionView: { version: 1, connections: [{ id: "business", kind: "business", version: 1,
    configured: true, status: "verified", testedAt: date }] } };
  const verified = groupCapabilityFacts(configured);
  assert.equal(item(verified, "action:publish").availability, "callable");
  assert.equal(item(verified, "action:publish").verification.status, "delivery_checked");
  assert.match(item(verified, "action:publish").verification.description, /不代表.*真实业务请求/);
  const failure = structuredClone(configured);
  failure.connectionView.connections[0].status = "failed";
  failure.connectionView.connections[0].testedAt = "2026-10-15T00:00:00.000Z";
  failure.connectionView.connections[0].reason = "PRIVATE_RAW_DIAGNOSTIC";
  const failed = groupCapabilityFacts(failure);
  assert.equal(item(failed, "action:publish").availability, "callable");
  assert.equal(item(failed, "action:publish").verification.status, "last_call_failed");
  assert.equal(failed.capabilityVersion, verified.capabilityVersion);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_RAW_DIAGNOSTIC/);
  const revoked = groupCapabilityFacts({ ...configured, connectionView: { version: 2, connections: [] } });
  assert.equal(item(revoked, "action:publish").availability, "conditional");
  assert.notEqual(revoked.capabilityVersion, verified.capabilityVersion);
});

test("已验收纯页面不公开不存在的应用动作入口，内部定义绑定保持兼容", () => {
  const options = fixture({ agent: { id: "page", revision: 1, execution: { kind: "node-action" }, toolIds: ["run_application_action"] },
    application: { ...application, manifest: { page: { entrypoint: "ui/index.html" }, actions: [] } } });
  const facts = groupCapabilityFacts(options);
  assert.equal(item(facts, "run_application_action"), undefined);
  assert.equal(facts.capabilities.some((entry) => entry.id.startsWith("action:")), false);
  assert.equal(item(facts, "conversation").availability, "callable");
  assert.deepEqual(options.agent.toolIds, ["run_application_action"]);
  assert.equal(item(groupCapabilityFacts({ ...options, application: null }), "run_application_action").availability, "unknown");
});

test("禁止联网覆盖公共工具和业务动作，尚未配置的业务动作也不能绕过政策", () => {
  const options = fixture({ agent: { id: "app", revision: 1, execution: { kind: "node-action" } }, application,
    draft: { goal: { value: "仅使用离线材料" }, constraints: [] },
    architecture: { version: 1, status: "passed", delivery: "ready", design: { capabilities: [], connections: [{ id: "business", purpose: "business" }] } } });
  const facts = groupCapabilityFacts(options);
  for (const id of ["web_search", "web_fetch", "action:publish"]) assert.equal(item(facts, id).availability, "forbidden");
  assert.equal(item(facts, "action:local").availability, "callable");
  assert.equal(facts.hardBoundaries.some((entry) => entry.id === "network_policy"), true);
});

test("动作联网属性由已批准连接用途投影，不能依据名称或缺配置推断为离线", () => {
  const options = fixture({ agent: { id: "app", revision: 1, execution: { kind: "node-action" } },
    application: { ...application, manifest: { actions: [{ id: "local", title: "联网同步", connectionIds: [] },
      { id: "send", title: "保存内容", connectionIds: ["business"] },
      { id: "search", title: "阅读资料", connectionIds: ["search"] },
      { id: "generate", title: "生成内容", connectionIds: ["model"] }] } },
    architecture: { version: 1, status: "passed", delivery: "ready", design: { capabilities: [],
      connections: [{ id: "business", purpose: "business" }, { id: "search", purpose: "search" }, { id: "model", purpose: "model" }] } } });
  const facts = groupCapabilityFacts(options);
  assert.equal(item(facts, "web_search").requiresNetwork, true);
  assert.equal(item(facts, "web_fetch").requiresNetwork, true);
  assert.equal(item(facts, "action:send").requiresNetwork, true);
  assert.equal(item(facts, "action:search").requiresNetwork, true);
  assert.equal(item(facts, "action:local").requiresNetwork, false);
  assert.equal(item(facts, "action:generate").requiresNetwork, false);
  assert.equal(item(facts, "conversation").requiresNetwork, false);
  assert.equal(item(facts, "read_group_material").requiresNetwork, false);
});

test("公开连接投影不含地址、服务名称、模型、凭据或诊断原文，版本只绑定配置身份", () => {
  const source = { version: 9, connections: [{ id: "model", kind: "model", version: 9, configured: true,
    provider: "PRIVATE_PROVIDER", baseUrl: "https://private-fixture.invalid", model: "PRIVATE_MODEL", secret: "PRIVATE_SECRET",
    headerName: "PRIVATE_HEADER", reason: "PRIVATE_DIAGNOSTIC", status: "configured", testedAt: null }] };
  const view = publicConnectionFacts(source);
  assert.deepEqual(Object.keys(view.connections[0]).sort(), ["allowFallback", "configured", "id", "kind", "status", "testedAt", "version"]);
  const options = fixture({ connectionView: source }), facts = groupCapabilityFacts(options);
  assert.doesNotMatch(JSON.stringify(facts) + JSON.stringify(view), /PRIVATE_|https:/);
  const health = structuredClone(options);
  health.connectionView.connections[0].status = "verified"; health.connectionView.connections[0].testedAt = date;
  assert.equal(facts.capabilityVersion, groupCapabilityFacts(health).capabilityVersion);
  const changed = structuredClone(options); changed.connectionView.version++;
  assert.notEqual(facts.capabilityVersion, groupCapabilityFacts(changed).capabilityVersion);
  assert.equal(facts.capabilityVersion, groupCapabilityFacts({ ...options, defaultModelConfigured: false }).capabilityVersion);
  const updated = structuredClone(options); updated.agent.revision++;
  assert.notEqual(facts.capabilityVersion, groupCapabilityFacts(updated).capabilityVersion);
});

test("默认模型不透明版本绑定能力身份，专属模型配置不依赖默认模型实例", () => {
  const options = fixture({ defaultModelVersion: "platform-instance-one:0" });
  const initial = groupCapabilityFacts(options);
  const replaced = groupCapabilityFacts({ ...options, defaultModelVersion: "platform-instance-one:1" });
  const restarted = groupCapabilityFacts({ ...options, defaultModelVersion: "platform-instance-two:0" });
  assert.notEqual(initial.capabilityVersion, replaced.capabilityVersion);
  assert.notEqual(initial.capabilityVersion, restarted.capabilityVersion);
  assert.doesNotMatch(JSON.stringify(initial), /platform-instance-one/);
  const dedicated = { ...options, connectionView: { version: 1, connections: [{ id: "model", kind: "model", version: 1,
    configured: true, status: "configured" }] } };
  assert.equal(groupCapabilityFacts(dedicated).capabilityVersion,
    groupCapabilityFacts({ ...dedicated, defaultModelVersion: "platform-instance-two:9", defaultModelConfigured: false }).capabilityVersion);
});

test("未交付定义和无法核对的程序不承诺可运行，轻量工具未验证业务效果", () => {
  const pending = groupCapabilityFacts(fixture({ ready: false, approved: false }));
  assert.equal(pending.capabilities.every((entry) => entry.availability === "unavailable"), true);
  const workflow = fixture({ agent: { id: "flow", revision: 1, execution: { kind: "node-json" } } });
  assert.equal(item(groupCapabilityFacts(workflow), "run_developed_workflow").availability, "unavailable");
  const checked = groupCapabilityFacts({ ...workflow, workflowChecked: true });
  assert.equal(item(checked, "run_developed_workflow").verification.status, "delivery_checked");
  assert.equal(item(checked, "read_workspace_file").verification.status, "unverified");
  const app = fixture({ agent: { id: "app", revision: 1, execution: { kind: "node-action" } }, deliveryFailed: true });
  const blocked = groupCapabilityFacts(app);
  assert.equal(item(blocked, "run_application_action").availability, "unavailable");
  assert.equal(blocked.capabilities.every((entry) => entry.availability === "unavailable"), true);
});
