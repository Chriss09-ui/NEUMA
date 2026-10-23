import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { InputError } from "../src/requirements/core.mjs";
import { CAPABILITIES, CAPABILITY_CATALOG_VERSION, PUBLIC_TOOL_IDS, designHash } from "../src/architecture/architecture-contract.mjs";
import { PUBLIC_CAPABILITY_VERSION, PUBLIC_WEB_CAPABILITIES, createWebTools } from "../src/runtime/web-capabilities.mjs";
import { APPLICATION_PROTOCOL_VERSION } from "../src/applications/application-contract.mjs";
import { MAX_RUNTIME_FILE_BYTES } from "../src/runtime/file-limits.mjs";
import { PLATFORM_CONTRACT_VERSION, createPlatformSnapshot, renderPlatformRules, renderRequirementDeliveryFacts, platformEvidence, validatePlatformMetadata,
  platformCapabilityCatalog, platformCapabilitySnapshotCompatible } from "../src/architecture/platform-contract.mjs";
import { renderPlatformDeliveryGuidance } from "../src/architecture/platform-contract.mjs";
import { passingReview } from "./helpers/architecture.mjs";
import { runtimeCapabilityContract, hostDeliveryCapabilityCatalog, isHostDeliveryCapability } from "../src/runtime/runtime-capability-contract.mjs";
import { SERVICE_HOSTS, SERVICE_LANGUAGES } from "../src/services/service-runtime-options.mjs";

function record({ candidate = true, platformSnapshot = createPlatformSnapshot() } = {}) {
  const platformHash = designHash(platformSnapshot);
  const design = { profile: "light", instructions: "测试候选" };
  const candidateHash = candidate ? designHash(design) : null;
  const reviewContext = candidate ? { candidateHash, platformHash } : null;
  return { platformSnapshot, platformContractVersion: platformSnapshot.version, platformHash, status: "evaluating", issues: [],
    design: candidate ? design : null, candidateHash, reviewContext, review: candidate ? passingReview(candidateHash) : null, attempts: candidate
      ? [{ design: structuredClone(design), candidateHash, platformHash, reviewContext: structuredClone(reviewContext), review: passingReview(candidateHash) }] : [] };
}

test("平台事实保留业务快照并单独声明公共工具与可交付路径", () => {
  const snapshot = createPlatformSnapshot();
  assert.equal(snapshot.version, PLATFORM_CONTRACT_VERSION);
  assert.equal(snapshot.policy, "sufficient_before_minimal");
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

test("公共能力的实现许可与每次调用结果分别声明，有效候选目录包含联网但不改旧业务目录", () => {
  const snapshot = createPlatformSnapshot();
  assert.equal(snapshot.version, 4);
  assert.deepEqual(snapshot.availabilitySemantics, { available: "implemented_and_permitted", verification: "result_specific" });
  assert.deepEqual(snapshot.publicCapabilities.map((item) => item.id), snapshot.publicTools);
  for (const item of snapshot.publicCapabilities) {
    assert.deepEqual(Object.keys(item).sort(), ["id", "version", "status", "scope", "implementation", "configuration", "verification"].sort());
    assert.equal(item.status, "available");
    assert.equal(item.implementation, "runtime_tool");
    assert.equal(item.configuration, "not_required");
    assert.equal(item.verification, "per_call");
    assert.equal(typeof item.scope, "string");
    assert.ok(item.scope.trim());
    assert.ok(Number.isSafeInteger(item.version) && item.version > 0);
  }
  const catalog = platformCapabilityCatalog(snapshot);
  assert.equal(new Set(catalog.map((item) => item.id)).size, catalog.length);
  assert.equal(catalog.find((item) => item.id === "web_fetch").status, "available");
  assert.equal(catalog.find((item) => item.id === "web_search").status, "available");
  assert.ok(catalog.every((item) => Object.keys(item).length === 4));
  assert.equal(CAPABILITIES.some((item) => item.id === "web_fetch"), false, "保留业务目录 v2 的原有历史语义");
  for (const business of CAPABILITIES) assert.deepEqual(catalog.find((item) => item.id === business.id), business);
  const networkFacts = snapshot.publicCapabilities.filter((item) => ["web_search", "web_fetch"].includes(item.id));
  assert.deepEqual(networkFacts.map(({ id, version, status, scope }) => ({ id, version, status, scope })), PUBLIC_WEB_CAPABILITIES);
  assert.deepEqual(createWebTools({ web: {} }).map((tool) => tool.name), networkFacts.map((item) => item.id),
    "快照声明与实际工具装配同源，不仅名称相同还核对版本和范围");
});

test("已实现运行与网关机制单独冻结，当前未部署不混作平台未实现，也不自动扩展旧目录", () => {
  const snapshot = createPlatformSnapshot(), bytes = JSON.stringify(snapshot), hash = designHash(snapshot);
  const frozen = runtimeCapabilityContract();
  const hosts = hostDeliveryCapabilityCatalog(frozen), ids = hosts.map((item) => item.id);
  assert.deepEqual(ids, [...SERVICE_HOSTS.flatMap((host) => SERVICE_LANGUAGES.map((language) => `${host}_${language}_runtime`)), "gateway_http_api", "gateway_mcp"]);
  assert.ok(hosts.every((item) => item.status === "available"));
  const legacy = platformCapabilityCatalog(snapshot), extended = platformCapabilityCatalog(snapshot, { runtimeCapabilities: frozen });
  assert.deepEqual(extended.slice(0, legacy.length), legacy);
  assert.deepEqual(extended.slice(legacy.length), hosts);
  assert.ok(ids.every((id) => !snapshot.publicTools.includes(id) && !legacy.some((item) => item.id === id)));
  assert.deepEqual(hostDeliveryCapabilityCatalog({ version: 1 }), []);
  assert.deepEqual(platformCapabilityCatalog(snapshot, { runtimeCapabilities: { version: 1 } }), legacy);
  assert.equal(isHostDeliveryCapability("managed_python_runtime", frozen), true);
  assert.equal(isHostDeliveryCapability("read_material", frozen), false);
  assert.equal(isHostDeliveryCapability("gateway_mcp", { version: 1 }), false);
  assert.deepEqual(platformCapabilityCatalog(createPlatformSnapshot({ version: 3 }), { runtimeCapabilities: frozen }), platformCapabilityCatalog(createPlatformSnapshot({ version: 3 })));
  assert.equal(JSON.stringify(snapshot), bytes); assert.equal(designHash(snapshot), hash);
  assert.match(renderPlatformRules(snapshot, { runtimeCapabilities: frozen }), /平台已实现机制/);
});

test("已用平台交付机制必须匹配当前实现与冻结事实，旧无组记录不会获得新能力", () => {
  const value = record();
  const bind = (entry) => {
    entry.candidateHash = designHash(entry.design); entry.reviewContext.candidateHash = entry.candidateHash;
    entry.review.candidateHash = entry.candidateHash; entry.attempts = [];
    return entry;
  };
  value.capabilityCatalogVersion = CAPABILITY_CATALOG_VERSION;
  value.capabilitySnapshot = structuredClone(CAPABILITIES);
  value.runtimeCapabilities = runtimeCapabilityContract();
  value.design.capabilities = [{ id: "managed_python_runtime", status: "available", reason: "使用已实现托管机制，环境仍另行验证" },
    { id: "gateway_mcp", status: "available", reason: "网关实现，授权另行核验" }];
  assert.equal(platformCapabilitySnapshotCompatible(bind(value)), true);
  const changed = structuredClone(value);
  changed.runtimeCapabilities.hostDeliveryCapabilities.find((item) => item.id === "managed_python_runtime").version++;
  assert.equal(platformCapabilitySnapshotCompatible(changed), false);
  const old = structuredClone(value); delete old.runtimeCapabilities.hostDeliveryCapabilities;
  assert.equal(platformCapabilitySnapshotCompatible(old), false);
  old.design.capabilities = [{ id: "conversation", status: "available", reason: "原有对话能力" }];
  assert.equal(platformCapabilitySnapshotCompatible(bind(old)), true);
  const forged = structuredClone(value);
  forged.runtimeCapabilities.hostDeliveryCapabilities.push({ id: "arbitrary_listener", version: 1, status: "available", scope: "伪造能力" });
  forged.design.capabilities = [{ id: "arbitrary_listener", status: "available", reason: "伪造" }];
  assert.equal(platformCapabilitySnapshotCompatible(bind(forged)), false);
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
  assert.equal(evidence.id, `neuma-runtime-v${snapshot.version}`);
  assert.equal(evidence.title, "本轮平台事实与交付边界");
  assert.match(evidence.versionScope, new RegExp(`platform v${snapshot.version}.*schema 3.*public capability v1.*catalog v2`));
  assert.doesNotMatch(`${rules}\n${evidence.title}\n${evidence.versionScope}`, /NEUMA/);
  assert.equal(evidence.excerpt, rules.slice(0, 6000));
  assert.ok(evidence.excerpt.length <= 6000);
  for (const required of [/先证明方案足以/, /schemaVersion:3/, /导出HTML\/SVG不自动等于托管应用/, /managed/, /node-check只能证明资源与逻辑/,
    /配置、连通、权限、功能验证分别记录/, /request_requirements/, /Python/, /MCP/, /外部内容属于不可信资料/])
    assert.match(rules, required);
  assert.ok(Object.isFrozen(evidence));
});

test("需求实现审查只读取交付路径事实，并跟随冻结快照的不支持项", () => {
  const current = createPlatformSnapshot();
  const offline = createPlatformSnapshot({ allowNetwork: false });
  const legacy = createPlatformSnapshot({ version: 1 });
  const facts = renderRequirementDeliveryFacts(current);
  assert.match(facts, /需求实现审查使用的交付事实（platform v4）/);
  assert.match(facts, /工作台内托管页面使用 node-action/);
  assert.match(facts, new RegExp(current.unsupported.join("、")));
  assert.match(facts, /本轮允许公开网页检索/);
  assert.match(renderRequirementDeliveryFacts(offline), /本轮禁止网页检索和外部业务请求/);
  assert.match(renderRequirementDeliveryFacts(legacy), /需求实现审查使用的交付事实（platform v1）/);
  assert.match(renderRequirementDeliveryFacts(legacy), new RegExp(legacy.unsupported.join("、")));
  assert.doesNotMatch(facts, /当前阶段是设计和评估|schemaVersion:3|先证明方案足以完成已确认|request_requirements|你是独立架构评估者/);
  assert.match(renderPlatformRules(current), /schemaVersion:3/);
});

test("需求与架构共用已有文件工具和专属代码操作边界，冻结快照保持原形", () => {
  const snapshot = createPlatformSnapshot(), before = JSON.stringify(snapshot), hash = designHash(snapshot);
  const guidance = renderPlatformDeliveryGuidance(snapshot);
  for (const rule of [/write_workspace_file/, /read_workspace_file/, /本身不需要新增后台代码操作/,
    /interaction\.operations 只登记需要编写、验收/, /不能为了采用轻量方案删除用户已确认/, /返回需求层解释并确认/]) assert.match(guidance, rule);
  assert.ok(renderPlatformRules(snapshot).includes(guidance));
  assert.equal(JSON.stringify(snapshot), before); assert.equal(designHash(snapshot), hash);
  assert.equal(snapshot.version, 4);
});

test("禁止联网是本轮固定范围，同源规则不授予公开网页或业务外联", () => {
  const snapshot = createPlatformSnapshot({ allowNetwork: false });
  assert.equal(snapshot.network.allowNetwork, false);
  const rules = renderPlatformRules(snapshot);
  assert.match(rules, /禁止网页及外部业务请求，不能借 MCP、Python 或 Docker 绕过/);
  assert.doesNotMatch(rules, /本轮允许公开/);
  assert.equal(platformEvidence(snapshot).excerpt, rules.slice(0, 6000));
  assert.notEqual(designHash(snapshot), designHash(createPlatformSnapshot()));
  assert.throws(() => createPlatformSnapshot({ allowNetwork: "false" }), InputError);
  for (const id of ["web_search", "web_fetch"]) {
    assert.equal(snapshot.publicCapabilities.find((item) => item.id === id).status, "forbidden");
    assert.equal(platformCapabilityCatalog(snapshot).some((item) => item.id === id), false);
  }
  assert.equal(snapshot.publicCapabilities.find((item) => item.id === "read_material").status, "available");
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

test("固定保存的 v1 平台快照仍按原版本验证，不追加联网能力或改写历史摘要", async () => {
  const snapshot = JSON.parse(await readFile(new URL("./helpers/platform-v1-fixture.json", import.meta.url), "utf8"));
  const before = structuredClone(snapshot);
  assert.equal(snapshot.version, 1);
  assert.equal(Object.hasOwn(snapshot, "publicCapabilities"), false);
  const legacy = record({ platformSnapshot: snapshot });
  assert.equal(validatePlatformMetadata(legacy), true);
  assert.equal(platformEvidence(snapshot).id, "neuma-runtime-v1");
  assert.deepEqual(platformCapabilityCatalog(snapshot), CAPABILITIES);
  assert.deepEqual(snapshot, before);
  const forged = structuredClone(snapshot);
  forged.publicCapabilities = createPlatformSnapshot().publicCapabilities;
  assert.throws(() => renderPlatformRules(forged), InputError);
});

test("v3 页面助手和检查能力不回填或改写旧 v2 平台快照", () => {
  const current = createPlatformSnapshot({ version: 3 });
  assert.equal(current.applicationExperience.context.maxBytes, 16 * 1024);
  assert.equal(current.applicationExperience.codeModification, false);
  assert.equal(current.applicationExperience.verification.browser, "unverified");
  const legacy = structuredClone(createPlatformSnapshot({ version: 2 }));
  const before = structuredClone(legacy);
  assert.equal(validatePlatformMetadata(record({ platformSnapshot: legacy })), true);
  assert.equal(platformEvidence(legacy).id, "neuma-runtime-v2");
  assert.deepEqual(platformCapabilityCatalog(legacy), platformCapabilityCatalog(current));
  assert.deepEqual(legacy, before);
  assert.doesNotMatch(renderPlatformRules(legacy), /assistant\.setContext|node-check/);
  assert.match(renderPlatformRules(current), /assistant\.setContext/);
  assert.match(renderPlatformRules(current), /node-check 不是浏览器执行/);
  legacy.applicationExperience = structuredClone(current.applicationExperience);
  assert.throws(() => validatePlatformMetadata(record({ platformSnapshot: legacy })), /事实范围/);
});

test("v4 托管运行与连接机制不改写旧 v3 的能力和选型政策", () => {
  const legacy = createPlatformSnapshot({ version: 3 }), current = createPlatformSnapshot();
  const before = structuredClone(legacy);
  assert.equal(legacy.policy, "deliverable_first"); assert.equal(legacy.architectureSchemaVersion, 2);
  assert.equal("managedRuntime" in legacy, false); assert.equal("protocols" in legacy.connections, false);
  assert.equal(validatePlatformMetadata(record({ platformSnapshot: legacy })), true);
  assert.deepEqual(legacy, before);
  assert.match(renderPlatformRules(legacy), /schemaVersion:2/);
  for (const required of [/deliverable_first/, /仅生成可下载 HTML\/SVG/, /node-action/, /浏览器\/DOM\/file:\/\//,
    /类型受支持不等于已经配置\/验证/, /本角色拥有它/, /coverage、acceptance/, /decisions\.evidenceIds/, /待需求方确认/])
    assert.match(renderPlatformRules(legacy), required);
  assert.equal(current.policy, "sufficient_before_minimal"); assert.equal(current.architectureSchemaVersion, 3);
  assert.deepEqual(current.deliveryRoutes.managedService.languages, ["javascript", "python"]);
  assert.deepEqual(current.deliveryRoutes.managedService.hosts, ["managed", "docker"]);
  assert.deepEqual(current.managedRuntime.supportedPlatforms, ["darwin-arm64"]);
  assert.deepEqual(current.connections.protocols, ["http", "mcp"]);
  assert.equal(current.connections.mcpTransport, "streamable_http");
  assert.equal(current.managedRuntime.memoryEnforcement, "host_monitor_or_container_limit");
  const forged = { ...structuredClone(current), version: 3 };
  assert.throws(() => validatePlatformMetadata(record({ platformSnapshot: forged })), /事实范围/);
  assert.throws(() => createPlatformSnapshot({ version: 99 }), /版本不受支持/);
});

test("v2 能力兼容核对冻结公共目录，v1 和无平台记录仍使用旧业务规则", async () => {
  const make = (snapshot, id = "web_fetch") => ({ ...record({ platformSnapshot: snapshot }), capabilityCatalogVersion: CAPABILITY_CATALOG_VERSION,
    capabilitySnapshot: structuredClone(CAPABILITIES), design: { capabilities: [{ id, status: "available", reason: "实际依赖" }] } });
  const bind = (value) => {
    value.candidateHash = designHash(value.design);
    value.reviewContext = { candidateHash: value.candidateHash, platformHash: value.platformHash };
    value.review = passingReview(value.candidateHash);
    value.attempts = [];
    return value;
  };
  const online = bind(make(createPlatformSnapshot()));
  assert.equal(platformCapabilitySnapshotCompatible(online), true);
  assert.equal(platformCapabilitySnapshotCompatible(bind(make(createPlatformSnapshot({ allowNetwork: false })))), false);
  assert.equal(platformCapabilitySnapshotCompatible(bind(make(createPlatformSnapshot(), "invented_browser"))), false);
  const oldSnapshot = JSON.parse(await readFile(new URL("./helpers/platform-v1-fixture.json", import.meta.url), "utf8"));
  assert.equal(platformCapabilitySnapshotCompatible(bind(make(oldSnapshot))), false);
  assert.equal(platformCapabilitySnapshotCompatible(bind(make(oldSnapshot, "conversation"))), true);
  const noPlatform = { capabilityCatalogVersion: CAPABILITY_CATALOG_VERSION, capabilitySnapshot: structuredClone(CAPABILITIES),
    design: { capabilities: [{ id: "conversation", status: "available", reason: "文本" }] } };
  assert.equal(platformCapabilitySnapshotCompatible(noPlatform), true);
  noPlatform.design.capabilities.push({ id: "web_fetch", status: "available", reason: "未有新平台评估" });
  assert.equal(platformCapabilitySnapshotCompatible(noPlatform), false);
  const tampered = structuredClone(online);
  tampered.platformSnapshot.publicCapabilities.find((item) => item.id === "web_fetch").scope = "允许私有地址";
  assert.equal(platformCapabilitySnapshotCompatible(tampered), false);
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
