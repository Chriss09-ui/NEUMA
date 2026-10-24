import type { FormElement, FormDocument } from "./form-dom.js";
import type { ApplicationApi, ConnectionRequirement, ConnectionView } from "./ui-api-types.js";
interface ConnectionDraft extends Record<string, unknown> { id: string; kind: string; provider: string; baseUrl: string; model: string; authType: string; headerName: string; allowFallback: boolean; secret: string; protocol: string; username: string; values: Record<string, unknown>; oauth: { scopes?: string | string[] | undefined; [key: string]: unknown } }
interface ConnectionItem<E> { requirement: ConnectionRequirement; connection: ConnectionView | null | undefined; profile: string | undefined; busy: boolean; note: string; error: boolean; draft: ConnectionDraft; form?: E | null | undefined; fields?: Map<string, E> | undefined; controls?: Map<string, E | E> | undefined; status?: E | undefined; feedback?: E | undefined; save?: E | undefined; test?: E | undefined; clear?: E | undefined; authorize?: E | undefined; cancelAuth?: E | undefined; discover?: E | undefined; oauthDetails?: E | undefined; authorization?: E | undefined; discovery?: E | undefined; specification?: E | undefined; secret?: E | E | undefined }
interface ConnectionState<E> { entries: Map<string, ConnectionItem<E>>; versions: Map<string | undefined, number>; loaded: boolean; loading: boolean; version: number; error: string }
import { errorInfo } from "./ui-types.js";
import { createApplicationApi } from "./application-api.js";

export function connectionStatus(requirement: { required?: boolean | undefined }, connection: Partial<ConnectionView> | null | undefined) {
  if (["awaiting_authorization", "exchanging"].includes(connection?.authorization?.status!)) return "等待登录授权";
  if (connection?.authType === "oauth" && !connection.hasSecret) return "需要登录授权";
  if (connection?.status === "verified") return "已验证";
  if (connection?.status === "failed") return "验证失败";
  if (connection?.configured) return "已配置，尚未验证";
  return requirement.required ? "必需待配置" : "可选";
}

export function createConnectionView<E extends FormElement<E> & {children:ArrayLike<unknown>;name?:string} = HTMLElement>({ document, api, container, onChange = () => {} }: { document: FormDocument<E>; api: ApplicationApi; container: E; onChange?: ((agentId: string) => unknown) | undefined }) {
  const agents = new Map<string, ConnectionState<E>>();
  let currentId: string | null = null;
  const node = (tag:string, className: string, text = "") => {
    const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
  };
  const states = (id: string) => {
    if (!agents.has(id)) agents.set(id, { entries: new Map(), versions: new Map(), loaded: false, loading: false, version: 0, error: "" });
    return agents.get(id)!;
  };
  function entry(id: string, requirement: ConnectionRequirement, connection: ConnectionView | undefined) {
    const owner = states(id), entryKey = `${requirement.profile || "legacy"}:${requirement.id}`, existing = owner.entries.get(entryKey);
    if (existing) {
      if (JSON.stringify(existing.requirement.configFields) !== JSON.stringify(requirement.configFields) || existing.requirement.sourceLabel !== requirement.sourceLabel) { existing.form = null; existing.fields = new Map(); }
      existing.connection = connection; existing.requirement = requirement; return existing;
    }
    const item: ConnectionItem<E> = { requirement, connection, profile: requirement.profile, busy: false, note: "", error: false,
      draft: { id: requirement.id, kind: requirement.kind, provider: connection?.provider || (requirement.kind === "search" ? "tavily"
        : requirement.kind === "model" ? "openai-compatible" : "http-json"), baseUrl: connection?.baseUrl || "",
        model: connection?.model || "", authType: connection?.authType || "bearer", headerName: connection?.headerName || "X-API-Key",
        allowFallback: connection?.allowFallback === true, secret: "", protocol: requirement.protocol || connection?.protocol || "http",
        username: connection?.username || "", values: { ...(connection?.values || {}) }, oauth: { ...(connection?.oauth || {}) } } };
    owner.entries.set(entryKey, item); return item;
  }
  function field(item: ConnectionItem<E>, form: E, labelText: string, key: string, options: { choices?: [string, string][] | undefined; type?: string | undefined; placeholder?: string | undefined } = {}) {
    const parts = key.split("."), owner = parts.length === 2 ? item.draft[parts[0]!] as Record<string, unknown> : item.draft, property = parts.at(-1)!;
    const label = node("label", "connection-field", labelText);
    const control = node(options.choices ? "select" : "input", "");
    if (options.choices) for (const [value, text] of options.choices) {
      const option = node("option", "", text); option.value = value; control.append(option);
    }
    else { (control as E).type = options.type || "text"; control.autocomplete = options.type === "password" ? "new-password" : "off"; }
    control.name = key; control.value = (owner[property] ?? "") as string;
    if (options.type === "checkbox") (control as E).checked = owner[property] as boolean;
    if (options.placeholder) (control as E).placeholder = options.placeholder;
    control.addEventListener(options.type === "checkbox" || options.choices ? "change" : "input", () => {
      owner[property] = options.type === "checkbox" ? (control as E).checked : options.type === "number" ? Number(control.value) : control.value!;
      item.note = "有尚未保存的修改。"; item.error = false; refresh(item);
    });
    item.fields! ??= new Map(); item.fields!.set(key, label); item.controls! ??= new Map(); item.controls!.set(key, control);
    label.append(control); form.append(label); return control;
  }
  function refresh(item: ConnectionItem<E>) {
    if (!item.form) return;
    item.status!.textContent = connectionStatus(item.requirement, item.connection);
    item.feedback!.textContent = item.note;
    item.feedback!.setAttribute("data-error", String(item.error));
    item.form.setAttribute("aria-busy", String(item.busy));
    item.save!.disabled = item.busy; item.test!.disabled = item.busy || !item.connection?.configured;
    item.clear!.disabled = item.busy || !item.connection?.configured;
    if (item.authorize) item.authorize.disabled = item.busy || !item.connection?.configured || item.connection.authType !== "oauth";
    if (item.cancelAuth) item.cancelAuth.disabled = item.busy || !item.connection?.configured;
    if (item.discover) item.discover.disabled = item.busy || !item.connection?.configured;
    if (item.draft.kind === "business") {
      item.fields!.get("headerName")!.hidden = item.draft.authType !== "header";
      item.fields!.get("username")!.hidden = item.draft.authType !== "basic";
      item.fields!.get("secret")!.hidden = ["none", "oauth"].includes(item.draft.authType);
      if (item.oauthDetails) item.oauthDetails.hidden = item.draft.authType !== "oauth";
      if (item.authorize) item.authorize.hidden = item.draft.authType !== "oauth";
      if (item.cancelAuth) item.cancelAuth.hidden = item.draft.authType !== "oauth";
    }
  }
  async function operate(id: string, item: ConnectionItem<E>, type: string) {
    if (item.busy) return;
    item.busy = true; item.error = false; item.note = type === "save" ? "正在保存…" : type === "test" ? "正在测试连接…" : "正在清除…"; refresh(item);
    const submitted = structuredClone(item.draft);
    if (typeof submitted.oauth.scopes === "string") submitted.oauth.scopes = submitted.oauth.scopes.split(/[\s,]+/).filter(Boolean);
    try {
      const expectedVersion = states(id).versions.get(item.profile) ?? states(id).version;
      const result = type === "save" ? await api.saveConnection(id, { ...submitted, expectedVersion, profile: item.profile, expectedProfile: item.profile })
        : type === "test" ? await api.testConnection(id, submitted.id, item.profile)
          : type === "authorize" ? await api.authorizeConnection(id, submitted.id, item.profile)
            : type === "cancelAuthorization" ? await api.cancelConnectionAuthorization(id, submitted.id, item.profile)
            : type === "discover" ? await api.discoverConnection(id, submitted.id, item.specification?.value!.trim() ? JSON.parse(item.specification.value!) : undefined, item.profile)
              : await api.removeConnection(id, submitted.id, expectedVersion, item.profile);
      if (result.version !== undefined) { states(id).version = result.version; states(id).versions.set(item.profile, result.version); }
      if (type === "cancelAuthorization") { item.authorization!.replaceChildren(); item.note = "已取消本次登录授权。"; return; }
      if (type === "authorize") {
        const link = node("a", "secondary", "打开服务商登录页面"); link.href = result.authorizationUrl!; link.target = "_blank"; link.rel = "noopener noreferrer";
        item.authorization!.replaceChildren(link); item.note = result.browserOpened
          ? "已打开系统浏览器。登录完成后，点击“刷新连接状态”继续。"
          : "请通过下方入口登录。完成后点击“刷新连接状态”继续。";
        return;
      }
      if (type === "discover") {
        const tools = result.tools || result.operations || [], resources = result.resources || [];
        item.note = `已发现 ${tools.length} 项工具或接口、${resources.length} 项资源。仅已评审的操作可以被智能体使用。`;
        item.discovery!.replaceChildren();
        for (const value of [...tools, ...resources]) item.discovery!.append(node("p", "muted-note small", value.title || value.name || value.description || value.id || value.uri));
        for (const [key, choices] of Object.entries(result.configurationChoices || {})) {
          const label = item.fields!.get(`values.${key}`), control = label?.children?.[0] as E | undefined;
          if (!control) continue;
          control.replaceChildren(); for (const choice of choices) { const option = node("option", "", choice.label); option.value = choice.value; control.append(option); }
          control.value = (item.draft.values[key] || "") as string;
        }
        return;
      }
      if (type === "remove") {
        item.connection = null; item.draft.secret = ""; item.secret!.value = ""; item.note = "已清除专属配置。";
      } else {
        item.connection = result.connection || result.connections?.find((value) => value.id === submitted.id) || item.connection;
        if (type === "save") {
          const edited = JSON.stringify(item.draft) !== JSON.stringify(submitted);
          if (item.draft.secret === submitted.secret) { item.draft.secret = ""; item.secret!.value = ""; }
          for (const definition of item.requirement.configFields || []) if (definition.type === "password" && item.draft.values[definition.key] === submitted.values[definition.key]) {
            item.draft.values[definition.key] = ""; const control = item.controls!.get(`values.${definition.key}`); if (control) control.value = "";
          }
          item.note = edited ? "已保存提交的配置；当前修改尚未保存。" : "已保存，新任务将使用此配置。";
        } else {
          item.note = result.message || result.test?.message || (item.connection?.status === "verified" ? "连接测试通过。" : "已配置，尚未验证；没有可用的无副作用测试操作。");
          item.error = item.connection?.status === "failed" || result.ok === false;
        }
      }
      onChange(id);
    } catch (caught) { const error = errorInfo(caught); item.error = true; item.note = `${error.message || "操作失败，请重试。"}${type === "save" ? " 输入已保留。" : ""}`; }
    finally { item.busy = false; refresh(item); }
  }
  function formFor(id: string, item: ConnectionItem<E>) {
    if (item.form) { refresh(item); return item.form; }
    const form = node("form", "connection-card"); form.autocomplete = "off"; item.form = form;
    const heading = node("div", "connection-heading"), title = node("h3", "", item.requirement.label || item.requirement.title || ({ search: "专属搜索", model: "专属模型", business: "业务接口" } as Record<string, string>)[item.requirement.kind]);
    item.status! = node("span", "connection-status"); heading.append(title, item.status!); form.append(heading);
    if (item.requirement.sourceLabel) form.append(node("p", "muted-note small", item.requirement.sourceLabel));
    form.append(node("p", "muted-note small", item.requirement.description || (item.draft.kind === "search"
      ? "不填写也能搜索和读取公开网页。专属服务失败时，按你的备用选择处理。"
      : item.draft.kind === "model" ? "留空时继承平台模型；专属模型只用于这个智能体。" : "填写已设计操作使用的服务地址与认证信息。")));
    if (item.draft.kind === "search") field(item, form, "服务商", "provider", { choices: [["tavily", "Tavily"], ["exa", "Exa"]] });
    if (item.draft.kind !== "search") field(item, form, "接口地址", "baseUrl", { type: "url", placeholder: "https://api.example.com" });
    if (item.draft.kind === "model") field(item, form, "模型名称", "model", { placeholder: "输入服务商提供的模型名称" });
    if (item.draft.kind !== "search") field(item, form, "认证方式", "authType", { choices: item.draft.kind === "business"
      ? [["none", "匿名"], ["bearer", "访问令牌"], ["header", "请求头密钥"], ["basic", "账号与密码"], ["oauth", "登录授权"]] : [["none", "匿名"], ["bearer", "Bearer"]] });
    if (item.draft.kind === "business") {
      field(item, form, "API Key 请求头名称", "headerName", { placeholder: "X-API-Key" });
      field(item, form, "接口账号（账号密码认证时填写）", "username");
    }
    item.secret! = field(item, form, "认证信息", "secret", { type: "password", placeholder: item.connection?.hasSecret ? "已保存；留空保留现有认证" : "填写 API Key 或访问令牌" });
    if (item.draft.kind === "business") {
      for (const definition of item.requirement.configFields || []) field(item, form, definition.label, `values.${definition.key}`, {
        type: definition.type === "number" ? "number" : definition.type === "password" ? "password" : "text",
        ...(definition.type === "select" ? { choices: (definition.options || []).map((option) => typeof option === "string" ? [option, option] : [option.value, option.label]) } : {}),
      });
      const details = node("details", "connection-authorization"), summary = node("summary", "", "登录授权设置"); item.oauthDetails = details; details.open = true; details.append(summary); form.append(details);
      field(item, details, "服务商身份地址（用于发现授权入口）", "oauth.issuer", { type: "url" });
      field(item, details, "客户端编号", "oauth.clientId");
      field(item, details, "授权地址（服务商未提供发现时填写）", "oauth.authorizationUrl", { type: "url" });
      field(item, details, "令牌地址", "oauth.tokenUrl", { type: "url" });
      field(item, details, "授权范围（用空格分隔）", "oauth.scopes");
      item.authorization! = node("div", "connection-authorization-result"); form.append(item.authorization!);
      item.discovery! = node("div", "connection-discovery"); form.append(item.discovery!);
      if (item.draft.protocol !== "mcp") {
        const label = node("label", "connection-field", "接口说明（可选，粘贴 OpenAPI JSON）");
        item.specification = node("textarea", ""); item.specification.rows = 3; label.append(item.specification); form.append(label);
      }
    }
    if (item.draft.kind === "search") field(item, form, "专属服务失败时，允许使用平台免费服务", "allowFallback", { type: "checkbox" });
    const footer = node("div", "connection-actions");
    item.save! = node("button", "primary", "保存"); item.save!.type = "submit";
    item.test! = node("button", "secondary", "测试连接"); item.test!.type = "button";
    item.clear! = node("button", "ghost-button", "清除配置"); item.clear!.type = "button";
    if (item.draft.kind === "business") {
      item.authorize = node("button", "secondary", "登录授权"); item.authorize.type = "button";
      item.cancelAuth = node("button", "ghost-button", "取消登录"); item.cancelAuth.type = "button";
      item.discover = node("button", "secondary", item.draft.protocol === "mcp" ? "发现工具与资源" : "读取接口说明"); item.discover.type = "button";
      item.authorize.addEventListener("click", () => operate(id, item, "authorize"));
      item.cancelAuth.addEventListener("click", () => operate(id, item, "cancelAuthorization"));
      item.discover.addEventListener("click", () => operate(id, item, "discover")); footer.append(item.authorize, item.cancelAuth, item.discover);
    }
    item.feedback! = node("p", "connection-feedback muted-note small"); item.feedback!.setAttribute("role", "status"); item.feedback!.setAttribute("aria-live", "polite");
    footer.append(item.save!, item.test!, item.clear!); form.append(footer, item.feedback!);
    form.addEventListener("submit", (event) => { event.preventDefault(); return operate(id, item, "save"); });
    item.test!.addEventListener("click", () => operate(id, item, "test"));
    item.clear!.addEventListener("click", () => operate(id, item, "remove"));
    refresh(item); return form;
  }
  function render(id: string) {
    if (id !== currentId) return;
    const item = states(id); container.replaceChildren();
    const note = node("p", "connection-baseline", "公开网页搜索与读取默认可用，无需 Key。工作模型默认继承平台配置。认证信息仅保存在本机服务端。");
    container.append(note);
    if (item.loaded) {
      const reload = node("button", "ghost-button", "刷新连接状态"); reload.type = "button"; reload.disabled = item.loading;
      reload.addEventListener("click", () => load(id)); container.append(reload);
    }
    if (item.error || item.loading) {
      const feedback = node("p", "muted-note", item.error || "正在读取连接…"); feedback.setAttribute("role", "status"); container.append(feedback);
      if (item.error) { const retry = node("button", "secondary", "重试读取"); retry.type = "button"; retry.addEventListener("click", () => load(id)); container.append(retry); }
    }
    for (const value of item.entries.values()) container.append(formFor(id, value));
    if (item.loaded && !item.entries.size) container.append(node("p", "muted-note", "当前需求没有专属连接配置项。需要接入外部服务时，可以让 NEUMA 帮你迭代需求。"));
  }
  async function load(id: string) {
    const item = states(id); if (item.loading) return;
    const wasLoaded = item.loaded;
    item.loading = true; item.error = ""; render(id);
    try {
      const result = await api.connections(id); item.version = result.version;
      const sections = result.active ? [{ ...result.active, sourceLabel: "当前运行版本" }, ...(result.candidate ? [{ ...result.candidate, sourceLabel: "新方案配置 · 交付后启用" }] : [])] : [result];
      const currentKeys = new Set();
      for (const section of sections) {
        item.versions.set(section.profile, section.version);
        const requirements = [...(section.requirements || [])];
        for (const connection of section.connections || []) if (!requirements.some((requirement) => requirement.id === connection.id)) requirements.push({ id: connection.id, kind: connection.kind!, required: false });
        for (const requirement of requirements) if (["search", "model", "business"].includes(requirement.kind)) {
          currentKeys.add(`${section.profile || "legacy"}:${requirement.id}`);
          entry(id, { ...requirement, profile: section.profile, sourceLabel: section.sourceLabel }, section.connections?.find((value) => value.id === requirement.id));
        }
      }
      for (const key of item.entries.keys()) if (!currentKeys.has(key)) item.entries.delete(key);
      item.loaded = true;
      if (wasLoaded) onChange(id);
    } catch (caught) { const error = errorInfo(caught); item.error = error.message || "连接配置读取失败。"; }
    finally { item.loading = false; render(id); }
  }
  return { async show(id: string) { currentId = id; render(id); if (!states(id).loaded) await load(id); },
    hide() { currentId = null; container.replaceChildren(); }, remove(id: string) { agents.delete(id); if (currentId === id) this.hide(); } };
}

if (typeof document !== "undefined") {
  const container = document.getElementById("agent-connections-content");
  if (container) {
    const view = createConnectionView({ document, api: createApplicationApi(), container,
      onChange: (agentId) => document.dispatchEvent(new CustomEvent("neuma:agent-connections-changed", { detail: { agentId } })) });
    document.addEventListener("neuma:agent-connections-view", (event) => event.detail.active ? view.show(event.detail.agentId!) : view.hide());
    document.addEventListener("neuma:agent-removed", (event) => view.remove(event.detail.id));
  }
}
