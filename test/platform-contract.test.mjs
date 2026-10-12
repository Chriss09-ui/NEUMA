import test from "node:test";
import assert from "node:assert/strict";
import { InputError } from "../src/requirements/core.mjs";
import { CAPABILITIES, CAPABILITY_CATALOG_VERSION, PUBLIC_TOOL_IDS, designHash } from "../src/architecture/architecture-contract.mjs";
import { PUBLIC_CAPABILITY_VERSION } from "../src/runtime/web-capabilities.mjs";
import { APPLICATION_PROTOCOL_VERSION } from "../src/applications/application-contract.mjs";
import { MAX_RUNTIME_FILE_BYTES } from "../src/runtime/file-limits.mjs";
import { PLATFORM_CONTRACT_VERSION, createPlatformSnapshot, renderPlatformRules, platformEvidence, validatePlatformMetadata } from "../src/architecture/platform-contract.mjs";
import { passingReview } from "./helpers/architecture.mjs";

function record({ candidate = true } = {}) {
  const platformSnapshot = createPlatformSnapshot();
  const platformHash = designHash(platformSnapshot);
  const design = { profile: "light", instructions: "测试候选" };
  const candidateHash = candidate ? designHash(design) : null;
  const reviewContext = candidate ? { candidateHash, platformHash } : null;
  return { platformSnapshot, platformContractVersion: PLATFORM_CONTRACT_VERSION, platformHash, status: "evaluating", issues: [],
    design: candidate ? design : null, candidateHash, reviewContext, review: candidate ? passingReview(candidateHash) : null, attempts: candidate
      ? [{ design: structuredClone(design), candidateHash, platformHash, reviewContext: structuredClone(reviewContext), review: passingReview(candidateHash) }] : [] };
}

test("平台事实保留业务快照并单独声明公共工具与可交付路径", () => {
  const snapshot = createPlatformSnapshot();
  assert.equal(snapshot.version, PLATFORM_CONTRACT_VERSION);
  assert.equal(snapshot.policy, "deliverable_first");
  assert.equal(snapshot.capabilityCatalogVersion, CAPABILITY_CATALOG_VERSION);
  assert.equal(snapshot.publicCapabilityVersion, PUBLIC_CAPABILITY_VERSION);
  assert.deepEqual(snapshot.businessCapabilities, CAPABILITIES);
  assert.notEqual(snapshot.businessCapabilities[0], CAPABILITIES[0]);
  assert.deepEqual(snapshot.publicTools, ["web_search", "web_fetch", ...PUBLIC_TOOL_IDS]);
  assert.equal(snapshot.deliveryRoutes.downloadableFiles.profile, "light");
  assert.equal(snapshot.deliveryRoutes.downloadableFiles.developmentRequired, false);
  assert.equal(snapshot.deliveryRoutes.downloadableFiles.browserResult, "unverified");
  assert.equal(snapshot.deliveryRoutes.hostedApplication.runtime, "node-action");
  assert.equal(snapshot.deliveryRoutes.hostedApplication.protocolVersion, APPLICATION_PROTOCOL_VERSION);
  assert.equal(snapshot.deliveryRoutes.hostedApplication.developmentRequired, true);
  assert.equal(snapshot.deliveryRoutes.developedWorkflow.runtime, "node-action");
  assert.equal(snapshot.deliveryRoutes.developedWorkflow.legacyRuntime, "node-json");
  assert.equal(snapshot.deliveryRoutes.browserExecution.status, "unavailable");
  assert.equal(snapshot.runtime.runtimeFileBytes, MAX_RUNTIME_FILE_BYTES);
  assert.equal(snapshot.runtime.sameAgentExecution, "serial");
  assert.equal(snapshot.runtime.directNetwork, false);
  assert.equal(snapshot.runtime.installDependencies, false);
  assert.equal(snapshot.connections.readiness, "configuration_required_actual_result_verifies");
  assert.equal(snapshot.connections.publicSearchFallback, "automatic_provider_fallback");
  assert.equal(snapshot.connections.dedicatedSearchFallback, "explicit_consent_only");
});

test("平台快照是可序列化且深度冻结的独立事实，不收集配置或凭据值", () => {
  const sentinel = "TEST_ONLY_PRIVATE_VALUE_MUST_NOT_APPEAR";
  const snapshot = createPlatformSnapshot({ config: { apiKey: sentinel }, credentials: sentinel });
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), createPlatformSnapshot());
  assert.equal(JSON.stringify(snapshot).includes(sentinel), false);
  const visit = (value) => {
    assert.equal(Object.isFrozen(value), true);
    if (!Array.isArray(value)) assert.equal(Object.getPrototypeOf(value), Object.prototype);
    for (const child of Object.values(value)) if (child && typeof child === "object") visit(child);
  };
  visit(snapshot);
  assert.throws(() => { snapshot.deliveryRoutes.hostedApplication.runtime = "browser"; }, TypeError);
  assert.throws(() => { snapshot.businessCapabilities.push({ id: "new" }); }, TypeError);
  assert.equal(CAPABILITIES.length, snapshot.businessCapabilities.length);
});

test("共享规则和同源证据明确文件、托管应用、连接就绪与浏览器验证边界", () => {
  const snapshot = createPlatformSnapshot();
  const rules = renderPlatformRules(snapshot);
  const evidence = platformEvidence(snapshot);
  assert.equal(evidence.id, "neuma-runtime-v1");
  assert.match(evidence.versionScope, /platform v1.*schema 2.*public capability v1.*catalog v2/);
  assert.equal(evidence.excerpt, rules);
  assert.ok(evidence.excerpt.length <= 6000);
  for (const required of [/deliverable_first/, /schemaVersion:2/, /仅生成可下载 HTML\/SVG/, /node-action/, /浏览器\/DOM\/file:\/\//,
    /类型受支持不等于已经配置\/验证/, /本角色拥有它/, /coverage、acceptance/, /decisions\.evidenceIds/, /待需求方确认/])
    assert.match(rules, required);
  assert.ok(Object.isFrozen(evidence));
});

test("禁止联网是本轮固定范围，同源规则不授予公开网页或业务外联", () => {
  const snapshot = createPlatformSnapshot({ allowNetwork: false });
  assert.equal(snapshot.network.allowNetwork, false);
  const rules = renderPlatformRules(snapshot);
  assert.match(rules, /用户禁止联网.*web_search\/web_fetch 和业务外部请求不可使用/);
  assert.doesNotMatch(rules, /本轮允许公开/);
  assert.equal(platformEvidence(snapshot).excerpt, rules);
  assert.notEqual(designHash(snapshot), designHash(createPlatformSnapshot()));
  assert.throws(() => createPlatformSnapshot({ allowNetwork: "false" }), InputError);
});

test("平台渲染拒绝同版本伪造的能力事实和额外敏感字段", () => {
  const snapshot = JSON.parse(JSON.stringify(createPlatformSnapshot()));
  snapshot.deliveryRoutes.browserExecution.status = "available";
  assert.throws(() => renderPlatformRules(snapshot), /事实范围/);
  const injected = JSON.parse(JSON.stringify(createPlatformSnapshot()));
  injected.apiKey = "TEST_ONLY_PRIVATE_VALUE";
  assert.throws(() => platformEvidence(injected), (error) => error instanceof InputError
    && !error.message.includes(injected.apiKey));
});

test("旧记录完全缺平台字段时保持兼容，新记录允许尚未产生候选", () => {
  const legacy = { contractVersion: 1, candidateHash: "legacy", attempts: [{ candidateHash: "legacy_attempt" }] };
  const before = structuredClone(legacy);
  assert.equal(validatePlatformMetadata(legacy), true);
  assert.deepEqual(legacy, before);
  assert.equal(validatePlatformMetadata(record({ candidate: false })), true);
  assert.equal(validatePlatformMetadata(JSON.parse(JSON.stringify(record()))), true);
});

test("平台元数据不能部分出现，版本与摘要必须匹配", () => {
  for (const mutate of [
    (value) => { delete value.platformSnapshot; },
    (value) => { delete value.platformHash; },
    (value) => { value.platformContractVersion++; },
    (value) => { value.platformHash = "a".repeat(64); },
    (value) => { value.platformSnapshot.network.allowNetwork = false; },
  ]) {
    const value = JSON.parse(JSON.stringify(record()));
    mutate(value);
    assert.throws(() => validatePlatformMetadata(value), InputError);
  }
  assert.throws(() => validatePlatformMetadata({ reviewContext: { platformHash: "a".repeat(64) } }), /不完整/);
  assert.throws(() => validatePlatformMetadata({ attempts: [{ platformHash: "a".repeat(64) }] }), /不完整/);
});

test("候选和所有修订评估绑定同一平台快照，不能在修订中替换事实", () => {
  for (const mutate of [
    (value) => { delete value.reviewContext; },
    (value) => { value.reviewContext.candidateHash = "a".repeat(64); },
    (value) => { value.reviewContext.platformHash = "a".repeat(64); },
    (value) => { value.reviewContext.extra = true; },
    (value) => { value.review.candidateHash = "a".repeat(64); },
    (value) => { value.review.checks = []; },
    (value) => { value.design.instructions = "另一个候选"; },
    (value) => { delete value.attempts[0].platformHash; },
    (value) => { delete value.attempts[0].reviewContext; },
    (value) => { delete value.attempts[0].review; },
    (value) => { value.attempts[0].platformHash = "a".repeat(64); },
    (value) => { value.attempts[0].reviewContext.candidateHash = "a".repeat(64); },
    (value) => { value.attempts[0].review.candidateHash = "a".repeat(64); },
    (value) => { value.attempts[0].design.instructions = "修订已改变"; },
  ]) {
    const value = JSON.parse(JSON.stringify(record())); mutate(value);
    assert.throws(() => validatePlatformMetadata(value), InputError);
  }
  const unbound = record({ candidate: false });
  unbound.reviewContext = { candidateHash: "a".repeat(64), platformHash: unbound.platformHash };
  assert.throws(() => validatePlatformMetadata(unbound), /缺少评估候选/);
});

test("已通过的新记录必须保留通过评估且没有阻断，未完成阶段不冒充通过", () => {
  const passed = record(); passed.status = "passed";
  assert.equal(validatePlatformMetadata(passed), true);
  for (const mutate of [
    (value) => { delete value.review; },
    (value) => { value.review = null; },
    (value) => { value.review.verdict = "revise"; value.review.checks[0].passed = false; },
    (value) => { value.issues.push({ id: "capability_gap", blocking: true }); },
  ]) {
    const value = JSON.parse(JSON.stringify(passed)); mutate(value);
    assert.throws(() => validatePlatformMetadata(value), InputError);
  }
  for (const status of ["evaluating", "failed", "cancelled"]) {
    const value = record(); value.status = status; value.review = null;
    assert.equal(validatePlatformMetadata(value), true);
  }
});
