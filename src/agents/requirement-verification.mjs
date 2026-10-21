import { INPUT_FRAMING_FACTS, measureConnectionFraming, normalizeVerificationContext } from "../applications/input-framing.mjs";

export const SYSTEM_REQUIREMENT_CHECKS = Object.freeze([
  "platform.deliveryRoutes.downloadableFiles", "platform.deliveryRoutes.hostedApplication",
  "platform.deliveryRoutes.developedWorkflow", "platform.deliveryRoutes.managedService",
  "platform.runtime", "platform.managedRuntime", "platform.connections", "platform.network",
  "platform.businessCapabilities", "platform.publicCapabilities",
  "runtime.managed.platform", "runtime.managed.javascript", "runtime.managed.python", "runtime.docker",
]);
const allowedChecks = new Set(SYSTEM_REQUIREMENT_CHECKS);
const identifier = /^[A-Za-z0-9_.:-]{1,120}$/;
const knownReasons = new Set(["python_not_prepared", "python_runtime_changed", "python_invalid", "python_unavailable",
  "unsupported_managed_platform", "unsupported_service_runtime", "docker_not_running", "docker_unavailable", "unsupported_docker_platform"]);
const evidence = (source, reference, detail) => ({ source, reference, detail: detail.slice(0, 3000) });
const unknown = (id, message = "本轮未取得足以核实该系统问题的宿主事实；由系统继续核实，不转问用户技术问题。") => ({ id, status: "unknown", message, evidence: [] });
const version = (value) => typeof value === "string" && /^v?\d{1,3}(?:\.\d{1,3}){1,3}(?:[a-z0-9.+-]{0,32})$/i.test(value) ? value : null;
const machine = (value) => typeof value === "string" && ["darwin", "linux", "win32", "arm64", "x64", "ia32", "arm"].includes(value) ? value : null;

// Fixed selectors deliberately avoid evaluating model-supplied property paths or executable checks.
const platformSelectors = {
  "platform.deliveryRoutes.downloadableFiles": (snapshot) => snapshot.deliveryRoutes?.downloadableFiles,
  "platform.deliveryRoutes.hostedApplication": (snapshot) => snapshot.deliveryRoutes?.hostedApplication,
  "platform.deliveryRoutes.developedWorkflow": (snapshot) => snapshot.deliveryRoutes?.developedWorkflow,
  "platform.deliveryRoutes.managedService": (snapshot) => snapshot.deliveryRoutes?.managedService,
  "platform.runtime": (snapshot) => snapshot.runtime,
  "platform.managedRuntime": (snapshot) => snapshot.managedRuntime,
  "platform.connections": (snapshot) => snapshot.connections,
  "platform.network": (snapshot) => snapshot.network,
  "platform.businessCapabilities": (snapshot) => snapshot.businessCapabilities,
  "platform.publicCapabilities": (snapshot) => snapshot.publicCapabilities,
};

function platformCheck(reference, snapshot) {
  const fact = platformSelectors[reference](snapshot);
  if (fact === undefined) return { status: "unavailable", evidence: evidence("platform", reference,
    `当前冻结的平台版本 v${snapshot.version} 未声明该交付能力，不能引用新版实现替旧版承诺。`) };
  const scope = reference === "platform.deliveryRoutes.managedService" && fact.externalEntry === "opt_in_loopback_gateway"
    ? "本机专属 HTTP API 与 MCP 由工作台宿主网关提供，共用已验收动作和任务调度，支持提交任务、查询任务与结果、取消任务。默认不开放，须选择动作和客户端令牌，绑定交付版本；不要求生成代码监听端口。可研发多个获批动作，经 ctx.files/state 保存分段及临时索引、检查完整性，再输出最终结果；这不是现成原生文件上传接口，也不证明某个容量、智能体交付、网关启用或业务验收已通过。任务记录和文件读写另有限制，须实际设计及验收；需求阶段不执行尚未生成的程序。"
    : reference === "platform.runtime"
      ? `这里的 listenPorts/directNetwork/subprocess 等限制针对生成代码执行环境，不是工作台宿主自身。生成进程不能监听端口或自行取得网络及凭据；需要外部接口时使用平台允许的宿主网关，需要连接时走已声明能力桥，不放宽进程隔离。actionInputBytes 是单调用上限，不是整个多动作任务的容量；经已批准动作及 files/state 可设计分段接收和完整性核对，不保证任意字节量或最大记录数已通过。${snapshot.version === 4
        ? "当前实现限额：API/MCP请求体256KiB；任务入口的完整任务封装128KiB；动作值1MiB；受管进程单条IPC消息2MiB。ctx.files.write单次120000字符且替换，read分页24000字符，普通下载读取最多120000字符；文件工具没有追加或删除动作，读取经过文本脱敏。ctx.state.set业务状态上限900KiB，含元数据存储1MiB。任务记录总计16MiB，事件单条128KiB，现有任务记录不自动清理；结束接收不代表已删除任务审计中的原始输入。JSON整数字段及汇总需符合宿主安全整数限制。不得仅凭记录数承诺任意路径长度、总字节量、完整单文件导出或任意大整数；确有缺口时保留阻断。若总字节、字段长度、数值及输出结构已有明确边界，应按实际结构推导保守上界并逐层比较；落在单次入口内无需分段。可检查的容量推导可以支持进入研发，实际程序与最大边界仍待研发验收；未执行待生成代码本身不证明当前平台不可承载。"
        : "文件、状态、任务记录、通信及数值精度限制仍须按对应交付版本独立核实。"}`
      : reference === "platform.managedRuntime"
        ? "这是平台已实现的运行通道和正式适配范围；实际机器准备情况要另查 runtime，不证明环境已准备或隔离探测已通过。"
        : reference === "platform.deliveryRoutes.downloadableFiles"
          ? "已授权的现有专属目录文件工具可以保存文本产物供下载；文件生成与保存本身不自动成为专属后台代码功能，也不证明文件中的脚本已执行。"
          : reference === "platform.network" ? "冻结联网政策同时约束代码、连接和材料工具，不能因选择 Python、MCP 或 Docker 而扩大授权。"
            : "这里只核实平台提供的契约和边界，不证明用户具体服务、资料、配置或业务结果可用。";
  const numeric = reference === "platform.runtime" && snapshot.version === 4
    ? `\n宿主 JSON 数值边界：Number.MAX_SAFE_INTEGER=${Number.MAX_SAFE_INTEGER}；整数及汇总绝对值须不超过该值。Python 可计算更大整数，不会放宽宿主 JSON 及跨语言交付边界。`
    : "";
  return { status: "verified", evidence: evidence("platform", reference, `${JSON.stringify(fact)}\n${scope}${numeric}`) };
}

function runtimeCheck(reference, environment) {
  const managed = environment?.managed;
  if (reference === "runtime.managed.platform") {
    if (!managed || typeof managed.available !== "boolean" || !machine(managed.platform) || !machine(managed.arch)) return null;
    return evidence("runtime", reference, JSON.stringify({ available: managed.available, platform: managed.platform, arch: managed.arch,
      scope: "当前机器的受管运行目标；仍须交付时真实执行和隔离探测，不代表已有用户服务启动。" }));
  }
  const language = reference === "runtime.managed.javascript" ? "javascript" : reference === "runtime.managed.python" ? "python" : null;
  if (language) {
    const current = managed?.[language];
    if (!current || typeof current.available !== "boolean") return null;
    return evidence("runtime", reference, JSON.stringify({ available: current.available, language,
      version: version(current.version), reason: knownReasons.has(current.reason) ? current.reason : current.available ? null : "environment_not_ready",
      scope: "只读检查已安装环境；未准备不等于平台不支持，不下载、不安装，不宣称隔离或实际业务执行通过。" }));
  }
  const current = environment?.docker;
  if (!current || typeof current.available !== "boolean") return null;
  return evidence("runtime", reference, JSON.stringify({ available: current.available, host: "docker", version: version(current.version),
    reason: knownReasons.has(current.reason) ? current.reason : current.available ? null : "environment_not_ready",
    verified: false, scope: "只读检查 Docker 引擎状态；不构建或运行镜像，不代表容器交付已验收，缺少引擎仅影响需要 Docker 的功能。" }));
}

async function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  let onAbort;
  const cancelled = new Promise((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true }); });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

export function createRequirementSystemVerifier({ services, connections } = {}) {
  return async function verifySystemIssues({ issues = [], platform, verificationContext, signal } = {}) {
    signal?.throwIfAborted();
    const requested = Array.isArray(issues) ? issues.slice(0, 24).filter((issue) => typeof issue?.id === "string" && identifier.test(issue.id)) : [];
    // Requirements import the check vocabulary; load the architecture validator only when verifying to avoid an initialization cycle.
    try { const { platformCapabilityCatalog } = await import("../architecture/platform-contract.mjs"); platformCapabilityCatalog(platform); }
    catch { signal?.throwIfAborted(); return requested.map(({ id }) => unknown(id, "当前平台快照未通过宿主契约校验，系统不能据此确认能力。")); }
    let environment, environmentRead = false, connectionMeasurement;
    const results = [];
    for (const issue of requested) {
      signal?.throwIfAborted();
      const checks = issue.checks;
      if (issue.owner !== "system" || !Array.isArray(checks) || !checks.length || checks.length > SYSTEM_REQUIREMENT_CHECKS.length
        || new Set(checks).size !== checks.length || checks.some((reference) => !allowedChecks.has(reference))) {
        results.push(unknown(issue.id, "系统问题缺少受支持的具体核实引用，不能凭问题措辞判断为已核实。")); continue;
      }
      if (checks.some((reference) => reference.startsWith("runtime.")) && !environmentRead) {
        environmentRead = true;
        try { if (typeof services?.environment === "function") environment = await abortable(Promise.resolve().then(() => services.environment()), signal); }
        catch { signal?.throwIfAborted(); }
      }
      if (checks.includes("platform.runtime") && platform.version === 4 && !connectionMeasurement) {
        const context = normalizeVerificationContext(verificationContext);
        connectionMeasurement = { status: "unknown", reason: context ? "connections_unavailable" : "agent_unbound",
          scope: "未测得当前连接封装，不能假定空配置或固定余量；这里只说明测量缺失，不否认平台通道。" };
        if (context && typeof connections?.snapshot === "function") {
          try {
            const snapshot = await abortable(Promise.resolve().then(() => connections.snapshot(context.agentId)), signal);
            connectionMeasurement = measureConnectionFraming(snapshot, context.agentId);
          } catch { signal?.throwIfAborted(); connectionMeasurement = { status: "unknown", reason: "snapshot_read_failed" }; }
        }
      }
      const found = checks.map((reference) => reference.startsWith("platform.") ? platformCheck(reference, platform)
        : { status: "verified", evidence: runtimeCheck(reference, environment) });
      const status = found.some((item) => !item.evidence) ? "unknown" : found.some((item) => item.status === "unavailable") ? "unavailable" : "verified";
      results.push({ id: issue.id, status, message: status === "verified"
        ? "已读取该问题指定的宿主事实；由预评估继续判断这些事实是否足以支持方案，不能据此宣称业务或执行已通过。"
        : status === "unavailable" ? "指定能力未在当前冻结平台版本中提供，系统须继续处理缺口；不能要求用户回答内部实现。"
          : "部分指定事实未能只读核实，保留系统阻断；未把探测异常改写成用户需求问题。",
        evidence: [...found.map((item) => item.evidence).filter(Boolean),
          ...(checks.includes("platform.runtime") && platform.version === 4 ? [
            evidence("platform", "platform.runtime", JSON.stringify({ type: "input_framing_contract", ...INPUT_FRAMING_FACTS })),
            evidence("platform", "platform.runtime", JSON.stringify({ type: "current_connection_framing", ...connectionMeasurement })),
          ] : [])] });
    }
    signal?.throwIfAborted(); return results;
  };
}
