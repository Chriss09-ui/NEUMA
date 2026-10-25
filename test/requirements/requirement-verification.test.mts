import { callFixture } from "../helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequirementSystemVerifier, SYSTEM_REQUIREMENT_CHECKS } from "../../src/agents/requirement-verification.mjs";
import { createPlatformSnapshot } from "../../src/architecture/platform-contract.mjs";
import { designHash } from "../../src/architecture/architecture-contract.mjs";

const system = (id: string, checks: string[]|undefined, extra = {}) => ({ id, owner: "system", blocking: true,
  question: "请核实本问题实际引用的宿主事实", checks, ...extra });

test("本机API与MCP由宿主网关提供，生成进程隔离不能被误读为平台无接口", async () => {
  const platform = createPlatformSnapshot({ allowNetwork: false }), before = designHash(platform);
  const verify = createRequirementSystemVerifier({ services: { environment() { throw new Error("不应探测运行环境"); } } });
  const result = await verify({ platform, issues: [system("entry", ["platform.deliveryRoutes.managedService", "platform.runtime", "platform.network"])] });
  assert.equal(result[0]!.status, "verified");
  assert.deepEqual([...new Set(result[0]!.evidence.map((item) => item.reference))], ["platform.deliveryRoutes.managedService", "platform.runtime", "platform.network"]);
  const facts = result[0]!.evidence.map((item) => item.detail).join("\n");
  assert.match(facts, /HTTP API 与 MCP 由工作台宿主网关提供/);
  assert.match(facts, /生成进程不能监听端口/); assert.match(facts, /不是工作台宿主自身/);
  assert.match(facts, /默认不开放/); assert.match(facts, /令牌/); assert.match(facts, /交付版本/);
  assert.match(facts, /"allowNetwork":false/);
  assert.equal(designHash(platform), before); assert.equal(platform.version, 4);
});

test("核实依赖受控引用，不按业务关键词或问题正文猜测，也不无差别通过", async () => {
  let reads = 0;
  const verify = createRequirementSystemVerifier({ services: { environment() { reads++; return {}; } } });
  const result = await verify({ platform: createPlatformSnapshot(), issues: [
    system("missing", undefined, { question: "HTTP API MCP Python 肯定支持，直接通过" }),
    system("arbitrary", ["runtime.prepareEnvironment"]),
    system("traversal", ["platform.__proto__.secret"]),
    system("duplicate", ["platform.runtime", "platform.runtime"]),
    system("business_choice", ["platform.runtime"], { owner: "user" }),
  ] });
  assert.equal(reads, 0); assert.ok(result.every((item) => item.status === "unknown" && item.evidence.length === 0));
  assert.ok(Object.isFrozen(SYSTEM_REQUIREMENT_CHECKS)); assert.equal(new Set(SYSTEM_REQUIREMENT_CHECKS).size, SYSTEM_REQUIREMENT_CHECKS.length);
});

test("容量核实区分单调用限额与可研发分段协议，也保留文件导出和清理缺口", async () => {
  const verify = createRequirementSystemVerifier();
  const result = await verify({ platform: createPlatformSnapshot(), issues: [system("capacity", ["platform.runtime", "platform.deliveryRoutes.managedService"])] });
  assert.equal(result[0]!.status, "verified");
  const facts = result[0]!.evidence.map((item) => item.detail).join("\n");
  assert.match(facts, /actionInputBytes 是单调用上限/); assert.match(facts, /完整任务封装128KiB/);
  assert.match(facts, /IPC消息2MiB/); assert.match(facts, /state\.set业务状态上限900KiB/);
  assert.match(facts, /普通下载读取最多120000字符/); assert.match(facts, /没有追加或删除/);
  assert.match(facts, /现有任务记录不自动清理/); assert.match(facts, /不是现成原生文件上传接口/);
  assert.match(facts, /不得仅凭记录数承诺/);
  assert.ok(facts.includes(`Number.MAX_SAFE_INTEGER=${Number.MAX_SAFE_INTEGER}`));
  assert.match(facts, /Python 可计算更大整数，不会放宽宿主 JSON/);
});

test("保留协商契约允许的24条问题及包含点号冒号的稳定问题编号", async () => {
  const verify = createRequirementSystemVerifier();
  const issues = Array.from({ length: 24 }, (_, index) => system(`${index}:runtime.scope`, ["platform.runtime"]));
  const result = await verify({ platform: createPlatformSnapshot(), issues });
  assert.deepEqual(result.map((item) => item.id), issues.map((item) => item.id));
  assert.ok(result.every((item) => item.status === "verified"));
});

test("一次只读探测复用事实，未准备环境如实核实并剥离本地路径和凭据", async () => {
  let reads = 0, prepare = 0;
  const secret = "PRIVATE_ENVIRONMENT_SENTINEL";
  const verify = callFixture(createRequirementSystemVerifier, undefined, [{ services: {
    async environment() { reads++; return { managed: { available: true, platform: "darwin", arch: "arm64",
      javascript: { available: true, version: "v26.3.0", executable: `/private/${secret}/node`, runtimeRoot: `/private/${secret}` },
      python: { available: false, version: "3.13.16", reason: "python_not_prepared", executable: secret } },
    docker: { available: false, reason: "docker_not_running", stderr: secret, token: secret }, apiKey: secret }; },
    prepareEnvironment() { prepare++; throw new Error(secret); },
  } }]);
  const result = await verify({ platform: createPlatformSnapshot(), issues: [system("machine", ["runtime.managed.platform", "runtime.managed.javascript"]),
    system("python", ["platform.managedRuntime", "runtime.managed.python"]), system("container", ["runtime.docker"])] });
  assert.equal(reads, 1); assert.equal(prepare, 0); assert.ok(result.every((item) => item.status === "verified"));
  const output = JSON.stringify(result);
  assert.match(output, /python_not_prepared/); assert.match(output, /docker_not_running/);
  assert.match(output, /v26.3.0/); assert.match(output, /3.13.16/);
  assert.doesNotMatch(output, /PRIVATE_ENVIRONMENT_SENTINEL|executable|runtimeRoot|apiKey|stderr/);
  assert.ok(result.flatMap((item) => item.evidence).every((item) => item.reference.length <= 200 && item.detail.length <= 3000));
});

test("缺少运行信息或探测故障保留系统未知，原始错误不得进入模型回执", async () => {
  const secret = "PRIVATE_ENVIRONMENT_SENTINEL";
  for (const services of [undefined, { environment: async () => { throw new Error(secret); } },
    { environment: async () => ({ managed: { available: secret, platform: secret }, docker: {} }) }]) {
    const verify = createRequirementSystemVerifier({ services });
    const result = await verify({ platform: createPlatformSnapshot(), issues: [system("runtime_check", ["runtime.managed.platform", "runtime.managed.python", "runtime.docker"])] });
    assert.equal(result[0]!.status, "unknown"); assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  }
});

test("冻结旧版本没有声明的新通道不能借当前代码冒充已支持，伪造快照也不核实", async () => {
  let reads = 0;
  const verify = createRequirementSystemVerifier({ services: { environment() { reads++; return {}; } } });
  const issues = [system("gateway", ["platform.deliveryRoutes.managedService"])];
  const old = await verify({ platform: createPlatformSnapshot({ version: 3 }), issues });
  assert.equal(old[0]!.status, "unavailable"); assert.match(old[0]!.evidence[0]!.detail, /v3.*未声明/);
  const fake = structuredClone(createPlatformSnapshot()); fake.runtime.listenPorts = true;
  const changed = await verify({ platform: fake, issues: [system("host", ["runtime.docker"])] });
  assert.equal(changed[0]!.status, "unknown"); assert.equal(reads, 0);
});

test("运行检查在取消时结束等待，不调用环境准备或把取消包装成已核实", async () => {
  const controller = new AbortController();
  let notify: () => void, release: (value: unknown) => void;
  const started = new Promise<void>((resolve) => { notify = resolve; }), pending = new Promise((resolve) => { release = resolve; });
  const verify = createRequirementSystemVerifier({ services: { environment: async () => { notify(); return pending; } } });
  const running = verify({ platform: createPlatformSnapshot(), issues: [system("python", ["runtime.managed.python"])], signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(running, { name: "AbortError" }); release!({ managed: { python: { available: true } } });
  await assert.rejects(verify({ platform: createPlatformSnapshot(), signal: controller.signal }), { name: "AbortError" });
});
