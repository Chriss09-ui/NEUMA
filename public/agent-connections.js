import { createApplicationApi } from "./application-api.js";

export function connectionStatus(requirement, connection) {
  if (connection?.status === "verified") return "已验证";
  if (connection?.status === "failed") return "验证失败";
  if (connection?.configured) return "已配置，尚未验证";
  return requirement.required ? "必需待配置" : "可选";
}

export function createConnectionView({ document, api, container, onChange = () => {} }) {
  const agents = new Map();
  let currentId = null;
  const node = (tag, className, text = "") => {
    const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
  };
  const states = (id) => {
    if (!agents.has(id)) agents.set(id, { entries: new Map(), loaded: false, loading: false, version: 0, error: "" });
    return agents.get(id);
  };
  function entry(id, requirement, connection) {
    const owner = states(id), existing = owner.entries.get(requirement.id);
    if (existing) { existing.connection = connection; existing.requirement = requirement; return existing; }
    const item = { requirement, connection, busy: false, note: "", error: false,
      draft: { id: requirement.id, kind: requirement.kind, provider: connection?.provider || (requirement.kind === "search" ? "tavily"
        : requirement.kind === "model" ? "openai-compatible" : "http-json"), baseUrl: connection?.baseUrl || "",
        model: connection?.model || "", authType: connection?.authType || "bearer", headerName: connection?.headerName || "X-API-Key",
        allowFallback: connection?.allowFallback === true, secret: "" } };
    owner.entries.set(requirement.id, item); return item;
  }
  function field(item, form, labelText, key, options = {}) {
    const label = node("label", "connection-field", labelText);
    const control = node(options.choices ? "select" : "input", "");
    if (options.choices) for (const [value, text] of options.choices) {
      const option = node("option", "", text); option.value = value; control.append(option);
    }
    else { control.type = options.type || "text"; control.autocomplete = options.type === "password" ? "new-password" : "off"; }
    control.name = key; control.value = item.draft[key];
    if (options.type === "checkbox") control.checked = item.draft[key];
    if (options.placeholder) control.placeholder = options.placeholder;
    control.addEventListener(options.type === "checkbox" || options.choices ? "change" : "input", () => {
      item.draft[key] = options.type === "checkbox" ? control.checked : control.value;
      item.note = "有尚未保存的修改。"; item.error = false; refresh(item);
    });
    label.append(control); form.append(label); return control;
  }
  function refresh(item) {
    if (!item.form) return;
    item.status.textContent = connectionStatus(item.requirement, item.connection);
    item.feedback.textContent = item.note;
    item.feedback.setAttribute("data-error", String(item.error));
    item.form.setAttribute("aria-busy", String(item.busy));
    item.save.disabled = item.busy; item.test.disabled = item.busy || !item.connection?.configured;
    item.clear.disabled = item.busy || !item.connection?.configured;
  }
  async function operate(id, item, type) {
    if (item.busy) return;
    item.busy = true; item.error = false; item.note = type === "save" ? "正在保存…" : type === "test" ? "正在测试连接…" : "正在清除…"; refresh(item);
    const submitted = { ...item.draft };
    try {
      const result = type === "save" ? await api.saveConnection(id, { ...submitted, expectedVersion: states(id).version })
        : type === "test" ? await api.testConnection(id, submitted.id)
          : await api.removeConnection(id, submitted.id, states(id).version);
      if (result.version !== undefined) states(id).version = result.version;
      if (type === "remove") {
        item.connection = null; item.draft.secret = ""; item.secret.value = ""; item.note = "已清除专属配置。";
      } else {
        item.connection = result.connection || result.connections?.find((value) => value.id === submitted.id) || item.connection;
        if (type === "save") {
          const edited = Object.keys(submitted).some((key) => item.draft[key] !== submitted[key]);
          if (item.draft.secret === submitted.secret) { item.draft.secret = ""; item.secret.value = ""; }
          item.note = edited ? "已保存提交的配置；当前修改尚未保存。" : "已保存，新任务将使用此配置。";
        } else {
          item.note = result.message || result.test?.message || (item.connection?.status === "verified" ? "连接测试通过。" : "已配置，尚未验证；没有可用的无副作用测试操作。");
          item.error = item.connection?.status === "failed" || result.ok === false;
        }
      }
      onChange(id);
    } catch (error) { item.error = true; item.note = `${error.message || "操作失败，请重试。"}${type === "save" ? " 输入已保留。" : ""}`; }
    finally { item.busy = false; refresh(item); }
  }
  function formFor(id, item) {
    if (item.form) { refresh(item); return item.form; }
    const form = node("form", "connection-card"); form.autocomplete = "off"; item.form = form;
    const heading = node("div", "connection-heading"), title = node("h3", "", item.requirement.label || item.requirement.title || { search: "专属搜索", model: "专属模型", business: "业务接口" }[item.requirement.kind]);
    item.status = node("span", "connection-status"); heading.append(title, item.status); form.append(heading);
    form.append(node("p", "muted-note small", item.requirement.description || (item.draft.kind === "search"
      ? "不填写也能搜索和读取公开网页。专属服务失败时，按你的备用选择处理。"
      : item.draft.kind === "model" ? "留空时继承平台模型；专属模型只用于这个智能体。" : "填写已设计操作使用的服务地址与认证信息。")));
    if (item.draft.kind === "search") field(item, form, "服务商", "provider", { choices: [["tavily", "Tavily"], ["exa", "Exa"]] });
    if (item.draft.kind !== "search") field(item, form, "接口地址", "baseUrl", { type: "url", placeholder: "https://api.example.com" });
    if (item.draft.kind === "model") field(item, form, "模型名称", "model", { placeholder: "输入服务商提供的模型名称" });
    if (item.draft.kind !== "search") field(item, form, "认证方式", "authType", { choices: item.draft.kind === "business"
      ? [["none", "匿名"], ["bearer", "Bearer"], ["header", "API Key Header"]] : [["none", "匿名"], ["bearer", "Bearer"]] });
    if (item.draft.kind === "business") {
      field(item, form, "API Key 请求头名称", "headerName", { placeholder: "X-API-Key" });
    }
    item.secret = field(item, form, "认证信息", "secret", { type: "password", placeholder: item.connection?.hasSecret ? "已保存；留空保留现有认证" : "填写 API Key 或访问令牌" });
    if (item.draft.kind === "search") field(item, form, "专属服务失败时，允许使用平台免费服务", "allowFallback", { type: "checkbox" });
    const footer = node("div", "connection-actions");
    item.save = node("button", "primary", "保存"); item.save.type = "submit";
    item.test = node("button", "secondary", "测试连接"); item.test.type = "button";
    item.clear = node("button", "ghost-button", "清除配置"); item.clear.type = "button";
    item.feedback = node("p", "connection-feedback muted-note small"); item.feedback.setAttribute("role", "status"); item.feedback.setAttribute("aria-live", "polite");
    footer.append(item.save, item.test, item.clear); form.append(footer, item.feedback);
    form.addEventListener("submit", (event) => { event.preventDefault(); return operate(id, item, "save"); });
    item.test.addEventListener("click", () => operate(id, item, "test"));
    item.clear.addEventListener("click", () => operate(id, item, "remove"));
    refresh(item); return form;
  }
  function render(id) {
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
  async function load(id) {
    const item = states(id); if (item.loading) return;
    item.loading = true; item.error = ""; render(id);
    try {
      const result = await api.connections(id); item.version = result.version;
      const requirements = [...(result.requirements || [])];
      for (const connection of result.connections || []) if (!requirements.some((requirement) => requirement.id === connection.id)) requirements.push({ id: connection.id, kind: connection.kind, required: false });
      for (const requirement of requirements) if (["search", "model", "business"].includes(requirement.kind)) entry(id, requirement, result.connections?.find((value) => value.id === requirement.id));
      item.loaded = true;
    } catch (error) { item.error = error.message || "连接配置读取失败。"; }
    finally { item.loading = false; render(id); }
  }
  return { async show(id) { currentId = id; render(id); if (!states(id).loaded) await load(id); },
    hide() { currentId = null; container.replaceChildren(); }, remove(id) { agents.delete(id); if (currentId === id) this.hide(); } };
}

if (typeof document !== "undefined") {
  const container = document.getElementById("agent-connections-content");
  if (container) {
    const view = createConnectionView({ document, api: createApplicationApi(), container,
      onChange: (agentId) => document.dispatchEvent(new CustomEvent("neuma:agent-connections-changed", { detail: { agentId } })) });
    document.addEventListener("neuma:agent-connections-view", (event) => event.detail.active ? view.show(event.detail.agentId) : view.hide());
    document.addEventListener("neuma:agent-removed", (event) => view.remove(event.detail.id));
  }
}
