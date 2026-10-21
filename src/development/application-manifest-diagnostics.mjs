import Ajv from "ajv";
import { isDeepStrictEqual } from "node:util";
import { validateApplicationManifest, validateValueSchema, VALUE_SCHEMA_RULES } from "../applications/application-contract.mjs";
import { validateServiceManifest, SERVICE_MANIFEST_SCHEMA, SERVICE_CAPABILITIES } from "../services/service-contract.mjs";
import { SERVICE_HOSTS, SERVICE_LANGUAGES } from "../services/service-runtime-options.mjs";

const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false }), validators = new WeakMap();
const plain = (value) => value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const list = (value) => Array.isArray(value) ? value : [];
const jsonSchema = () => ({ type: "object", properties: {}, required: [], additionalProperties: false });
const operation = () => ({ id: "diagnostic", inputSchema: jsonSchema(), outputSchema: jsonSchema(), connectionIds: [] });
const action = () => ({ ...operation(), title: "结构核对" });
const application = () => ({ protocolVersion: 2, runtime: "node-action", entrypoint: "diagnostic.mjs", page: null, actions: [action()], stateVersion: 1, evidenceIds: [] });
const SERVICE_REMEDIES = Object.freeze({
  invalid_service_manifest: "按公开服务清单补齐字段及类型；不使用额外字段。",
  unsupported_service_runtime: "服务版本为1，语言和托管方式使用平台已支持值。",
  invalid_service_entrypoint: "应用骨架的服务入口必须是安全相对路径，扩展名匹配服务语言；同步计划、应用入口及任务文件清单，不要改用例来绕过。",
  invalid_service_operations: "服务必须声明1至80个真实操作。",
  invalid_service_operation: "操作编号须唯一且为安全标识；idempotent为布尔值。",
  invalid_service_operation_visibility: "操作可见性只能为public或internal。",
  invalid_service_connections: "连接依赖使用安全编号数组。",
  duplicate_service_operation: "为不同操作使用不同编号，并同步公开动作契约。",
  invalid_service_limits: "资源设置须在平台允许的安全整数范围内。",
  invalid_service_dependencies: "依赖包清单须为至多200项的数组。",
  invalid_dependency_lock: "依赖须有固定名称、版本、文件名和64位小写SHA256摘要；通过依赖核实工具取得，不猜测工件。",
  invalid_dependency_url: "通过依赖核实工具取得有效下载地址。",
  untrusted_dependency_source: "只使用可信官方HTTPS依赖工件来源；地址不能带账号、密码、片段。",
  unsupported_dependency_format: "依赖工件格式须匹配语言；Python使用wheel，JavaScript使用npm归档。",
  invalid_dependency_path: "仅JavaScript包可声明受限node_modules安装位置。",
  duplicate_dependency: "依赖安装位置或规范化名称不能重复。",
  dependency_filename_collision: "同一工件文件名不能绑定不同摘要。",
  invalid_service_capabilities: "能力只可选平台公开服务能力且不能重复。",
  docker_image_must_be_pinned: "Docker使用核实后的官方library镜像和固定sha256摘要。",
  invalid_docker_build_steps: "构建步骤为至多20组参数数组，每组1至40项，不得包含换行或空字节。",
  unexpected_docker_configuration: "只有Docker托管方式可填写docker配置。",
  invalid_workflow: "按公开流程结构核对入口、步骤、依赖和重试，不改变已批准权限。",
  workflow_entry_must_be_public: "流程入口必须是已公开操作。",
  workflow_entry_connections_incomplete: "流程公开入口必须声明各步骤所需连接。",
  invalid_data_migration: "迁移起始版本须低于目标版本，迁移和核验使用不同内部操作。",
  migration_must_be_internal_and_offline: "迁移及核验操作必须存在、仅内部可见且不依赖外部连接。",
});
const schemaReasons = new Map([
  ["输入输出 schema 无效或含不支持的规则", "schema_rule_unsupported"], ["schema 描述无效", "schema_rule_unsupported"],
  ["schema 规则与数据类型不匹配", "schema_type_mismatch"], ["对象 schema 必须明确字段、required 及 additionalProperties=false", "schema_object_invalid"],
  ["required 重复", "schema_object_invalid"], ["schema 属性名称无效", "schema_property_invalid"],
  ...["schema 上下限无效", "schema 数值边界无效", "schema 最小值不能大于最大值"].map((message) => [message, "schema_bounds_invalid"]),
  ["schema enum 无效", "schema_type_mismatch"], ["enum 与 schema 类型不匹配", "schema_type_mismatch"],
]);
const resourceRanges = Object.freeze({ timeoutMs: [1, 3600000], memoryMiB: [32, 8192], scratchMiB: [1, 2048], logBytes: [1024, 1048576] });

function declaredPath(schema, pointer, required) {
  let current = schema, result = "";
  for (const key of pointer.split("/").slice(1).map((entry) => entry.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (current?.type === "array" && /^(0|[1-9][0-9]{0,4})$/.test(key)) { result += `[${key}]`; current = current.items; }
    else if (Object.hasOwn(current?.properties ?? {}, key)) { result += `.${key}`; current = current.properties[key]; }
    else break;
  }
  if (required && Object.hasOwn(current?.properties ?? {}, required)) result += `.${required}`;
  return result;
}

function ordinaryJson(value) {
  const pending = [[value, 0, false]], seen = new Set(); let nodes = 0;
  while (pending.length) {
    const [current, depth, leaving] = pending.pop(); if (leaving) { seen.delete(current); continue; }
    if (++nodes > 100000 || depth > 64) return false;
    if (current === null || ["string", "boolean"].includes(typeof current) || typeof current === "number" && Number.isFinite(current)) continue;
    if (!current || typeof current !== "object" || seen.has(current) || !(Array.isArray(current) ? Object.getPrototypeOf(current) === Array.prototype : plain(current))) return false;
    seen.add(current);
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) return false;
    pending.push([current, depth, true]);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(current) && key === "length") continue;
      if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return false;
      pending.push([descriptor.value, depth + 1]);
    }
  }
  return true;
}

// Synthetic manifests are only probes of existing validators; they are never installed or executed.
function serviceBase(language = "javascript", host = "managed") {
  return { schemaVersion: 1, language, host, entrypoint: language === "python" ? "diagnostic.py" : "diagnostic.mjs", operations: [operation()],
    ...(host === "docker" ? { docker: { baseImage: `node@sha256:${"0".repeat(64)}` } } : {}) };
}
function packageBase(language) {
  const filename = language === "python" ? "diagnostic-1-py3-none-any.whl" : "diagnostic-1.tgz";
  return { name: "diagnostic", version: "1", url: `https://${language === "python" ? "files.pythonhosted.org" : "registry.npmjs.org"}/${filename}`,
    sha256: "0".repeat(64), filename };
}

export function diagnoseApplicationManifest(value, { root = "plan.application", schema, plan, snapshot, allowUnverified = true, limit = 64 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new TypeError("应用诊断额度无效");
  const issues = [], seen = new Set(); let total = 0, nodes = 0;
  const add = (path, reason, extra = {}) => {
    const identity = `${path}:${reason}`; if (seen.has(identity)) return;
    seen.add(identity); total++;
    if (issues.length < limit) issues.push({ path, reason, remedy: SERVICE_REMEDIES[reason] ?? (reason.startsWith("schema_")
      ? "核对该位置的公开VALUE_SCHEMA_RULES；properties[n]表示该对象属性在原索引中的第n项，不回显动态属性名。"
      : "修正应用索引骨架中该字段，保持公开契约、服务与实际交付一致；不要修改用例掩盖骨架错误。"), ...extra });
  };
  if (!ordinaryJson(value)) { add(root, "application_invalid"); return { valid: false, issues, total, retained: issues.length, truncated: false }; }
  const structural = (current, definition, path) => {
    if (!definition) return;
    let validate = validators.get(definition); if (!validate) { validate = ajv.compile(definition); validators.set(definition, validate); }
    if (!validate(current)) for (const error of validate.errors ?? []) add(path + declaredPath(definition, error.instancePath, error.params?.missingProperty),
      ["required", "type", "enum", "const", "minItems", "maxItems", "additionalProperties"].includes(error.keyword) ? error.keyword : "schema_invalid");
  };
  const fields = (current, allowed, path) => {
    if (!plain(current)) { add(path, "type", { expectedType: "object" }); return; }
    for (const key of allowed) if (!Object.hasOwn(current, key)) add(`${path}.${key}`, "required");
    if (Object.keys(current).some((key) => !allowed.includes(key))) add(path, "additionalProperties");
  };
  const serviceProbe = (candidate, path, extra) => { try { validateServiceManifest(candidate); } catch (error) {
    if (Object.hasOwn(SERVICE_REMEDIES, error?.reason)) add(path, error.reason, extra);
  } };
  const valueProbe = (candidate, path, depth = 0) => { try { validateValueSchema(candidate, depth); } catch (error) {
    add(path, schemaReasons.get(error.message?.replace(/^应用契约无效：/, "")) ?? "schema_rule_unsupported");
  } };
  const valueIssues = (current, path, depth = 0) => {
    if (++nodes > 10000 || depth > VALUE_SCHEMA_RULES.limits.depth + 1) { add(path, "schema_bounds_invalid"); return; }
    valueProbe(current, path, depth);
    if (!plain(current) || depth > 0 && !Object.keys(current).length) return;
    const type = VALUE_SCHEMA_RULES.types.includes(current.type) ? current.type : null;
    if (!type) {
      add(`${path}.type`, "schema_rule_unsupported", { allowed: [...VALUE_SCHEMA_RULES.types] });
      if (Object.hasOwn(current, "description")) valueProbe({ type: "string", description: current.description }, `${path}.description`, depth);
      return;
    }
    const base = type === "object" ? jsonSchema() : type === "array" ? { type, items: {} } : { type };
    if (Object.keys(current).some((key) => !VALUE_SCHEMA_RULES.keywords.includes(key))) add(path, "schema_rule_unsupported");
    const allowed = [...VALUE_SCHEMA_RULES.commonKeywords, ...VALUE_SCHEMA_RULES.applicable[type]];
    for (const key of VALUE_SCHEMA_RULES.keywords) if (Object.hasOwn(current, key) && !allowed.includes(key)) add(`${path}.${key}`, "schema_type_mismatch");
    for (const key of ["description", "enum", ...VALUE_SCHEMA_RULES.lengthKeywords, ...VALUE_SCHEMA_RULES.numericKeywords])
      if (Object.hasOwn(current, key)) valueProbe({ ...base, [key]: current[key] }, `${path}.${key}`, depth);
    for (const [minimum, maximum] of VALUE_SCHEMA_RULES.intervals) if (current[minimum] !== undefined && current[maximum] !== undefined)
      valueProbe({ ...base, [minimum]: current[minimum], [maximum]: current[maximum] }, `${path}.${minimum}`, depth);
    if (type === "object") {
      if (!plain(current.properties) || Object.keys(current.properties).length > VALUE_SCHEMA_RULES.limits.properties) add(`${path}.properties`, "schema_object_invalid");
      if (current.additionalProperties !== false) add(`${path}.additionalProperties`, "schema_object_invalid", { expected: false });
      const properties = plain(current.properties) ? Object.fromEntries(Object.keys(current.properties).slice(0, 100).map((key) => [key, {}])) : {};
      valueProbe({ ...jsonSchema(), properties, required: current.required }, `${path}.required`, depth);
      for (const [index, [key, child]] of Object.entries(plain(current.properties) ? current.properties : {}).slice(0, 100).entries()) {
        if (!new RegExp(VALUE_SCHEMA_RULES.propertyNamePattern).test(key) || VALUE_SCHEMA_RULES.forbiddenPropertyNames.includes(key))
          add(`${path}.properties[${index}]`, "schema_property_invalid");
        valueIssues(child, `${path}.properties[${index}]`, depth + 1);
      }
    } else if (type === "array") valueIssues(current.items, `${path}.items`, depth + 1);
  };
  structural(value, schema, root);
  if (!plain(value)) { add(root, "application_invalid"); return { valid: false, issues, total, retained: issues.length, truncated: total > issues.length }; }
  const managed = value.protocolVersion === 3, service = value.service, languageKnown = SERVICE_LANGUAGES.includes(service?.language), hostKnown = SERVICE_HOSTS.includes(service?.host);
  const language = languageKnown ? service.language : "javascript";
  fields(value, ["protocolVersion", "runtime", "entrypoint", "page", "actions", "stateVersion", "evidenceIds", ...(managed ? ["service"] : [])], root);
  const host = SERVICE_HOSTS.includes(service?.host) ? service.host : "managed", base = serviceBase(language, host);
  const extensions = language === "python" ? [".py"] : [".mjs", ".js", ".cjs"];
  if (managed || service !== undefined) {
    structural(service, SERVICE_MANIFEST_SCHEMA, `${root}.service`);
    if (plain(service)) {
      for (const field of ["schemaVersion", "language", "host"]) serviceProbe({ ...base, [field]: service[field] }, `${root}.service.${field}`,
        { allowed: field === "schemaVersion" ? [1] : field === "language" ? [...SERVICE_LANGUAGES] : [...SERVICE_HOSTS] });
      if (languageKnown) serviceProbe({ ...base, entrypoint: service.entrypoint }, `${root}.service.entrypoint`, { expectedExtensions: extensions });
      if (!Array.isArray(service.operations) || !service.operations.length || service.operations.length > 80) add(`${root}.service.operations`, "invalid_service_operations");
      for (const [index, item] of list(service.operations).slice(0, 80).entries()) {
        const path = `${root}.service.operations[${index}]`;
        for (const field of ["id", "connectionIds", "idempotent", "visibility"]) if (field === "id" || Object.hasOwn(item ?? {}, field))
          serviceProbe({ ...base, operations: [{ ...operation(), [field]: item?.[field] }] }, `${path}.${field}`,
            field === "visibility" ? { allowed: ["public", "internal"] } : undefined);
        for (const field of ["inputSchema", "outputSchema"]) valueIssues(item?.[field], `${path}.${field}`);
        if (list(service.operations).slice(0, index).some((previous) => previous?.id === item?.id)) add(`${path}.id`, "duplicate_service_operation");
      }
      for (const [field, range] of Object.entries(resourceRanges)) if (Object.hasOwn(service.resources ?? {}, field))
        serviceProbe({ ...base, resources: { [field]: service.resources[field] } }, `${root}.service.resources.${field}`, { minimum: range[0], maximum: range[1] });
      if (Object.hasOwn(service, "dataVersion")) serviceProbe({ ...base, dataVersion: service.dataVersion }, `${root}.service.dataVersion`, { minimum: 1, maximum: 1000000 });
      if (Object.hasOwn(service, "capabilities")) serviceProbe({ ...base, capabilities: service.capabilities }, `${root}.service.capabilities`, { allowed: [...SERVICE_CAPABILITIES] });
      if (service.dependencies !== undefined) {
        const packages = service.dependencies?.packages;
        if (packages !== undefined && (!Array.isArray(packages) || packages.length > 200)) add(`${root}.service.dependencies.packages`, "invalid_service_dependencies");
        for (const [index, pkg] of list(packages).slice(0, 200).entries()) {
          const path = `${root}.service.dependencies.packages[${index}]`;
          for (const field of ["name", "version", "url", "sha256", "filename", "installPath"]) if ((!["filename", "installPath"].includes(field) || languageKnown)
            && (field !== "installPath" || Object.hasOwn(pkg ?? {}, field)))
            serviceProbe({ ...base, dependencies: { packages: [{ ...packageBase(language), [field]: pkg?.[field] }] } }, `${path}.${field}`,
              field === "url" ? { allowedHosts: ["registry.npmjs.org", "files.pythonhosted.org"], allowedProtocols: ["https:"] }
                : field === "filename" ? { expectedExtensions: language === "python" ? [".whl"] : [".tgz", ".tar.gz"] } : undefined);
          const previous = list(packages).slice(0, index);
          if (previous.some((item) => item?.installPath && item.installPath === pkg?.installPath
            || !item?.installPath && !pkg?.installPath && typeof item?.name === "string" && typeof pkg?.name === "string"
              && item.name.toLowerCase().replaceAll("_", "-") === pkg.name.toLowerCase().replaceAll("_", "-"))) add(path, "duplicate_dependency");
          if (previous.some((item) => item?.filename === pkg?.filename && item?.sha256 !== pkg?.sha256)) add(`${path}.filename`, "dependency_filename_collision");
        }
      }
      if (hostKnown && host === "docker") {
        serviceProbe({ ...base, docker: { baseImage: service.docker?.baseImage } }, `${root}.service.docker.baseImage`);
        if (service.docker?.buildSteps !== undefined) serviceProbe({ ...base, docker: { ...base.docker, buildSteps: service.docker.buildSteps } }, `${root}.service.docker.buildSteps`);
      } else if (hostKnown && service.docker !== undefined) add(`${root}.service.docker`, "unexpected_docker_configuration");
      const operations = list(service.operations).map((item) => ({ ...operation(), id: item?.id,
        ...(item?.visibility === undefined ? {} : { visibility: item.visibility }), connectionIds: item?.connectionIds ?? [] }));
      let operationsValid = true; try { validateServiceManifest({ ...base, operations }); } catch { operationsValid = false; }
      for (const field of ["workflow", "migration"]) if (service[field] !== undefined && operationsValid
        && (field !== "migration" || service.dataVersion === undefined || Number.isSafeInteger(service.dataVersion) && service.dataVersion >= 1 && service.dataVersion <= 1000000))
        serviceProbe({ ...base, operations, ...(field === "migration" && service.dataVersion !== undefined ? { dataVersion: service.dataVersion } : {}),
          [field]: service[field] }, `${root}.service.${field}`);
      for (const [index, step] of list(service.workflow?.steps).slice(0, 100).entries()) if (step?.waitForInput)
        valueIssues(step.waitForInput.inputSchema, `${root}.service.workflow.steps[${index}].waitForInput.inputSchema`);
    }
  }
  if (![2, 3].includes(value.protocolVersion)) add(`${root}.protocolVersion`, "protocol_mismatch", { allowed: [2, 3] });
  if (value.runtime !== (managed ? "managed-service" : "node-action")) add(`${root}.runtime`, "protocol_mismatch", { allowed: [managed ? "managed-service" : "node-action"] });
  if (!Number.isSafeInteger(value.stateVersion) || value.stateVersion < 1) add(`${root}.stateVersion`, "application_invalid", { minimum: 1 });
  if (!managed) try { validateApplicationManifest({ ...application(), entrypoint: value.entrypoint }, { allowUnverified: true }); }
  catch { add(`${root}.entrypoint`, "entrypoint_mismatch", { expectedExtensions: [".mjs", ".js"] }); }
  if (!Array.isArray(value.actions) || value.actions.length > 80 || !value.actions.length && value.page === null) add(`${root}.actions`, "application_invalid");
  try { validateApplicationManifest({ ...application(), evidenceIds: value.evidenceIds }, { allowUnverified }); }
  catch { add(`${root}.evidenceIds`, "application_invalid"); }
  if (value.page !== null) {
    const page = value.page, pagePath = `${root}.page`;
    const probeHash = allowUnverified ? "" : "0".repeat(64);
    fields(page, ["entrypoint", "resources"], pagePath);
    try { validateApplicationManifest({ ...application(), page: { entrypoint: page?.entrypoint,
      resources: [{ path: page?.entrypoint, sha256: "" }] } }, { allowUnverified: true }); }
    catch { add(`${pagePath}.entrypoint`, "page_entrypoint_invalid", { expectedExtensions: [".html"] }); }
    if (!Array.isArray(page?.resources) || !page.resources.length || page.resources.length > 200) add(`${pagePath}.resources`, "page_resource_invalid");
    for (const [index, resource] of list(page?.resources).slice(0, 200).entries()) {
      const resourcePath = `${pagePath}.resources[${index}]`, pageEntry = resource?.path === "diagnostic-page.html" ? "diagnostic-other-page.html" : "diagnostic-page.html";
      fields(resource, ["path", "sha256"], resourcePath);
      for (const field of ["path", "sha256"]) try {
        validateApplicationManifest({ ...application(), evidenceIds: allowUnverified ? [] : ["diagnostic"], page: { entrypoint: pageEntry, resources: [
          { path: pageEntry, sha256: probeHash }, { path: "diagnostic-resource.css", sha256: probeHash, [field]: resource?.[field] },
        ] } }, { allowUnverified });
      } catch { add(`${resourcePath}.${field}`, "page_resource_invalid"); }
      if (resource?.path === value.entrypoint || list(page?.resources).slice(0, index).some((item) => item?.path === resource?.path)) add(`${resourcePath}.path`, "page_resource_invalid");
    }
    if (typeof page?.entrypoint === "string" && !list(page.resources).some((resource) => resource?.path === page.entrypoint)) add(`${pagePath}.entrypoint`, "page_resource_missing");
  }
  for (const [index, item] of list(value.actions).slice(0, 80).entries()) {
    const path = `${root}.actions[${index}]`;
    fields(item, ["id", "title", "inputSchema", "outputSchema", "connectionIds"], path);
    for (const field of ["inputSchema", "outputSchema"]) valueIssues(item?.[field], `${path}.${field}`);
    for (const field of ["id", "title", "connectionIds"]) try {
      validateApplicationManifest({ ...application(), actions: [{ ...action(), [field]: item?.[field] }] }, { allowUnverified: true });
    } catch { add(`${path}.${field}`, "application_invalid"); }
    if (list(value.actions).slice(0, index).some((previous) => previous?.id === item?.id)) add(`${path}.id`, "duplicate_action");
  }
  if (managed && plain(service)) {
    for (const [fieldPath, entrypoint] of [[`${root}.entrypoint`, value.entrypoint], ...(plan ? [["plan.entrypoint", plan.entrypoint]] : [])])
      if (languageKnown) serviceProbe({ ...base, entrypoint }, fieldPath, { expectedExtensions: extensions });
    if (value.entrypoint !== service.entrypoint) add(`${root}.entrypoint`, "entrypoint_mismatch", { relatedPaths: [`${root}.service.entrypoint`] });
    if (Number.isSafeInteger(service.dataVersion ?? 1) && (service.dataVersion ?? 1) !== value.stateVersion)
      add(`${root}.stateVersion`, "service_data_version_mismatch", { relatedPaths: [`${root}.service.dataVersion`] });
    const operations = list(service.operations).filter((item) => item?.visibility !== "internal");
    for (const [index, item] of list(value.actions).entries()) {
      const matching = operations.find((entry) => entry?.id === item?.id);
      if (!matching) { add(`${root}.actions[${index}].id`, "service_operation_mismatch"); continue; }
      for (const field of ["inputSchema", "outputSchema", "connectionIds"]) if (!isDeepStrictEqual(field === "connectionIds" ? [...list(item?.[field])].sort() : item?.[field],
        field === "connectionIds" ? [...list(matching[field])].sort() : matching[field])) add(`${root}.actions[${index}].${field}`, "service_operation_mismatch");
    }
    for (const [index, item] of list(service.operations).entries()) if (item?.visibility !== "internal" && !list(value.actions).some((entry) => entry?.id === item?.id))
      add(`${root}.service.operations[${index}].id`, "service_operation_mismatch");
  }
  if (plan && plan.entrypoint !== value.entrypoint) add(`${root}.entrypoint`, "entrypoint_mismatch", { relatedPaths: ["plan.entrypoint"] });
  if (plan && plan.runtime !== value.runtime) add(`${root}.runtime`, "protocol_mismatch", { relatedPaths: ["plan.runtime"] });
  try { validateApplicationManifest(value, { allowUnverified, snapshot }); }
  catch (error) {
    if (Object.hasOwn(SERVICE_REMEDIES, error?.reason)) {
      if (!issues.some((item) => item.reason === error.reason)) add(`${root}.service`, error.reason);
    } else if (!total) add(root, "application_invalid");
  }
  return { valid: !total, issues, total, retained: issues.length, truncated: total > issues.length };
}
