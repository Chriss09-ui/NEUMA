import { createApplicationApi } from "./application-api.js";

const statuses = { ready: "已就绪", running: "正在执行", stopped: "已停止", interrupted: "执行已中断", failed: "执行失败",
  waiting_input: "等待补充", needs_review: "需要核实上次执行", completed: "已完成", pending: "等待执行", cancelled: "已取消" };

export function createServiceView({ document, api, container, clipboard, onChange = () => {}, schedule = setInterval, unschedule = clearInterval }) {
  const states = new Map(); let current = null, timer = null;
  const node = (tag, className = "", text = "") => { const value = document.createElement(tag); value.className = className; value.textContent = text; return value; };
  const button = (text, action, className = "secondary") => {
    const value = node("button", className, text); value.type = "button"; value.addEventListener("click", action); return value;
  };
  const section = (parent, title) => { const value = node("section", "service-section"); value.append(node("h3", "", title)); parent.append(value); return value; };
  function input(parent, title, schema = {}) {
    if (schema.type === "object") {
      const group = node("fieldset", "service-input-group"), fields = new Map(); group.append(node("legend", "", title)); parent.append(group);
      for (const [key, definition] of Object.entries(schema.properties || {})) fields.set(key, input(group, definition.title || definition.description || key, definition));
      return () => Object.fromEntries([...fields].map(([key, read]) => [key, read()]));
    }
    const label = node("label", "connection-field", title);
    const field = node(schema.enum ? "select" : schema.type === "string" ? "textarea" : "input");
    if (schema.enum) for (const option of schema.enum) { const item = node("option", "", String(option)); item.value = JSON.stringify(option); field.append(item); }
    else field.type = schema.type === "boolean" ? "checkbox" : ["integer", "number"].includes(schema.type) ? "number" : "text";
    if (field.type === "number" && schema.type === "integer") field.step = "1";
    if (schema.type === "array") field.placeholder = "每行一项";
    label.append(field); parent.append(label);
    return () => schema.enum ? JSON.parse(field.value) : schema.type === "boolean" ? field.checked
      : ["integer", "number"].includes(schema.type) ? Number(field.value)
        : schema.type === "array" ? field.value.split(/\r?\n/).filter(Boolean) : field.value;
  }
  function state(id) {
    if (states.has(id)) return states.get(id);
    const item = { id, root: node("div", "service-settings"), operations: new Map(), tasks: new Map(), busy: false, loading: false, generation: 0, selectionDirty: false };
    item.feedback = node("p", "muted-note", "正在读取运行状态…"); item.feedback.setAttribute("role", "status"); item.feedback.setAttribute("aria-live", "polite");
    item.root.append(node("p", "muted-note small", "功能在这台电脑运行，随 NEUMA 启停。关闭网页后仍可继续，退出 NEUMA 或关机后停止。"), item.feedback,
      button("刷新状态", () => load(item), "ghost-button"));
    const environments = section(item.root, "运行环境"); item.environments = new Map();
    for (const [key, title] of [["javascript", "JavaScript"], ["python", "Python"], ["docker", "Docker（可选）"]]) {
      const row = node("div", "service-environment"), status = node("span", "muted-note small");
      const prepare = button(key === "docker" ? "检查 Docker" : "准备环境", () => operate(item, () => api.prepareService(id, key === "docker" ? item.data?.service?.language || "javascript" : key, key === "docker" ? "docker" : "managed")));
      row.append(node("strong", "", title), status, prepare); environments.append(row); item.environments.set(key, { status, prepare });
    }
    environments.append(node("p", "muted-note small", "只准备当前功能需要的环境。Docker 需在本机安装并启动后使用。"));
    const service = section(item.root, "当前功能"); item.serviceStatus = node("p", "muted-note"); service.append(item.serviceStatus);
    item.runButtons = [
      button("启动", () => operate(item, () => api.startService(id, item.data.deliveryVersion))),
      button("停止", () => operate(item, () => api.stopService(id, item.data.deliveryVersion))),
      button("重新启动", () => operate(item, () => api.restartService(id, item.data.deliveryVersion))),
    ];
    const controls = node("div", "connection-actions"); controls.append(...item.runButtons); service.append(controls);
    const history = node("label", "connection-field", "交付版本"); item.history = node("select"); history.append(item.history); service.append(history);
    item.rollback = button("恢复所选版本", () => operate(item, () => api.rollbackService(id, item.history.value))); service.append(item.rollback);
    const logs = node("details", "panel-disclosure"); logs.append(node("summary", "", "运行记录")); item.log = node("pre", "service-log");
    logs.append(button("读取记录", () => operate(item, async () => { const result = await api.serviceLogs(id, item.data.deliveryVersion); item.log.textContent = result.text || "暂无运行记录。"; }, false), "ghost-button"), item.log); service.append(logs);
    const gateway = section(item.root, "给本机其他工具使用");
    gateway.append(node("p", "muted-note small", "选择允许调用的功能后再开启接口。调用方需要下方地址和访问令牌。"));
    item.gatewayStatus = node("p", "muted-note"); item.actionList = node("fieldset", "service-action-list"); item.actionList.append(node("legend", "sr-only", "允许调用的功能"));
    item.gatewaySave = button("开启或更新接口", () => operate(item, async () => {
      const actionIds = [...item.operations].filter(([, field]) => field.checked).map(([actionId]) => actionId);
      if (!actionIds.length) throw new Error("请先选择至少一项允许调用的功能。");
      const result = await api.configureGateway(id, actionIds, item.data.deliveryVersion); item.token.value = current === id ? result.token || "" : ""; item.tokenBox.hidden = !item.token.value;
      item.selectionDirty = false;
    }));
    item.gatewayRevoke = button("停用接口", () => operate(item, async () => { await api.revokeGateway(id); item.token.value = ""; item.tokenBox.hidden = true; }));
    item.addresses = node("p", "service-addresses muted-note small"); item.tokenBox = node("div", "service-token"); item.tokenBox.hidden = true;
    const tokenLabel = node("label", "connection-field", "访问令牌（仅本次显示）"); item.token = node("input"); item.token.type = "password"; item.token.readOnly = true; item.token.autocomplete = "off"; tokenLabel.append(item.token);
    item.tokenBox.append(tokenLabel, button("复制访问令牌", () => operate(item, async () => {
      if (!clipboard?.writeText) throw new Error("无法自动复制，请在输入框中选择并复制令牌。"); await clipboard.writeText(item.token.value);
    }, false)), node("p", "muted-note small", "离开此面板后不再显示，请按需保存给调用方。"));
    const sharingActions = node("div", "connection-actions"); sharingActions.append(item.gatewaySave, item.gatewayRevoke);
    gateway.append(item.gatewayStatus, item.actionList, sharingActions, item.addresses, item.tokenBox);
    item.taskSection = section(item.root, "等待处理的流程"); states.set(id, item); return item;
  }
  function refresh(item) {
    if (!item.data) return;
    const { environment = {}, service, workers = [], history = [], gateway = {}, workflowTasks = [] } = item.data;
    for (const [key, controls] of item.environments) {
      const available = key === "docker" ? environment.docker : environment.managed?.[key];
      controls.status.textContent = key !== "docker" && environment.managed?.available === false ? "当前平台尚未支持"
        : available?.available ? `可用${available.version ? ` · ${available.version}` : ""}` : "尚未准备";
      controls.prepare.disabled = item.busy || key !== "docker" && available?.available || key !== "docker" && environment.managed?.available === false;
    }
    item.serviceStatus.textContent = service ? `${service.language === "python" ? "Python" : "JavaScript"} · ${service.host === "docker" ? "Docker" : "NEUMA 托管"} · ${statuses[workers[0]?.status || service.status] || "已交付，尚未启动"}` : "这个智能体尚无需要独立运行的功能。";
    for (const control of item.runButtons) control.disabled = item.busy || !service || !item.data.deliveryVersion;
    const historyKey = JSON.stringify(history.map((entry) => [entry.deliveryVersion, entry.active]));
    if (historyKey !== item.historyKey) {
      const selected = item.history.value; item.history.replaceChildren();
      for (const entry of history) { const option = node("option", "", `${entry.active ? "当前 · " : ""}${entry.deliveryVersion}`); option.value = entry.deliveryVersion; item.history.append(option); }
      item.history.value = history.some((entry) => entry.deliveryVersion === selected) ? selected : item.data.deliveryVersion || ""; item.historyKey = historyKey;
    }
    item.rollback.disabled = item.busy || !history.length;
    const outdatedGateway = gateway.enabled && gateway.deliveryVersion && gateway.deliveryVersion !== item.data.deliveryVersion;
    item.gatewayStatus.textContent = outdatedGateway ? "接口仍绑定旧版本，请选择当前功能后更新接口。"
      : gateway.status === "failed" ? gateway.message || "接口启动失败，请检查运行环境后重试。"
        : gateway.status === "suspended" ? "接口暂时暂停。" : gateway.enabled ? "接口已开启，仅本机可访问。" : "接口未开启。";
    if (outdatedGateway) { item.token.value = ""; item.tokenBox.hidden = true; }
    item.addresses.textContent = [gateway.apiUrl && `API：${gateway.apiUrl}`, gateway.mcpUrl && `MCP：${gateway.mcpUrl}`].filter(Boolean).join("\n");
    const actions = service?.operations || service?.actions || item.data.actions || [];
    for (const action of actions) {
      if (!item.operations.has(action.id)) {
        const label = node("label", "connection-field", action.title || action.name || action.id), field = node("input"); field.type = "checkbox";
        field.addEventListener("change", () => { item.selectionDirty = true; }); label.append(field); item.actionList.append(label); item.operations.set(action.id, field);
      }
      const field = item.operations.get(action.id); if (!item.selectionDirty) field.checked = (gateway.actionIds || []).includes(action.id); field.disabled = item.busy;
    }
    for (const [actionId, field] of item.operations) if (!actions.some((action) => action.id === actionId)) { field.parentElement?.remove(); item.operations.delete(actionId); }
    item.gatewaySave.disabled = item.busy || !actions.length; item.gatewayRevoke.disabled = item.busy || !gateway.enabled;
    item.taskSection.hidden = !workflowTasks.some((task) => ["waiting_input", "interrupted", "needs_review"].includes(task.status));
    for (const task of workflowTasks.filter((task) => ["waiting_input", "interrupted", "needs_review"].includes(task.status))) {
      let row = item.tasks.get(task.id);
      if (!row) {
        const form = node("form", "service-task"), note = node("p", "muted-note"), fields = node("div");
        const submit = node("button", "secondary", "继续执行"); submit.type = "submit"; form.append(note, fields, submit);
        row = { form, note, fields, submit }; item.tasks.set(task.id, row); item.taskSection.append(form);
        form.addEventListener("submit", (event) => { event.preventDefault(); return operate(item, () => {
          let resolution;
          if (row.task.status === "needs_review") {
            const outcome = row.choice?.value;
            if (!["completed", "retry"].includes(outcome)) throw new Error("请先核实上次操作的结果，再选择继续方式。");
            resolution = { stepId: row.task.waiting.stepId, index: row.task.waiting.index, outcome,
              ...(outcome === "completed" ? { output: row.read?.() } : { explicitlyApproved: true }) };
          }
          return api.resumeTask(item.id, row.task.id, resolution ? undefined : row.read?.() ?? {}, row.task.version, `resume_${globalThis.crypto.randomUUID()}`, resolution);
        }); });
      }
      row.task = task; row.form.hidden = false; row.note.textContent = task.waiting?.prompt || statuses[task.status]; row.submit.disabled = item.busy;
      if (task.status === "needs_review") row.note.textContent = "上次操作可能已经产生结果，需要先核实，避免重复执行。";
      const schemaKey = JSON.stringify([task.status, task.waiting?.inputSchema || null, task.waiting?.outputSchema || null]);
      if (row.schemaKey !== schemaKey) {
        row.fields.replaceChildren();
        if (task.status === "needs_review") {
          const label = node("label", "connection-field", "核实后的处理方式"), choice = node("select");
          for (const [value, title] of [["", "请选择"], ["completed", "上次已经完成，补充实际结果"], ["retry", "确认重新执行，接受可能重复产生的外部操作"]]) {
            const option = node("option", "", title); option.value = value; choice.append(option);
          }
          label.append(choice); row.fields.append(label); row.choice = choice;
          const result = node("div"); result.hidden = true; row.fields.append(result);
          row.read = input(result, "实际完成结果", task.waiting.outputSchema || { type: "string" });
          choice.addEventListener("change", () => { result.hidden = choice.value !== "completed"; });
        } else row.read = task.waiting?.inputSchema ? input(row.fields, "补充内容", task.waiting.inputSchema) : () => ({});
        row.schemaKey = schemaKey;
      }
    }
    for (const [taskId, row] of item.tasks) if (!workflowTasks.some((task) => task.id === taskId && ["waiting_input", "interrupted", "needs_review"].includes(task.status))) row.form.hidden = true;
  }
  async function load(item) {
    if (item.loading || item.busy) return; item.loading = true; const generation = ++item.generation;
    try { const data = await api.services(item.id); if (generation !== item.generation) return; item.data = data; item.feedback.textContent = ""; item.feedback.setAttribute("data-error", "false"); refresh(item); }
    catch (error) { if (generation !== item.generation) return; item.feedback.textContent = error.message || "运行状态读取失败，请重试。"; item.feedback.setAttribute("data-error", "true"); }
    finally { item.loading = false; }
  }
  async function operate(item, action, reload = true) {
    if (item.busy) return; item.busy = true; item.generation++; item.feedback.textContent = "正在处理…"; item.feedback.setAttribute("data-error", "false"); refresh(item);
    try { await action(); item.feedback.textContent = "已完成。"; if (reload) { item.data = await api.services(item.id); refresh(item); onChange(item.id); } }
    catch (error) { item.feedback.textContent = error.message || "操作未完成，请重试。"; item.feedback.setAttribute("data-error", "true"); }
    finally { item.busy = false; refresh(item); }
  }
  function hide() { if (current) { const item = states.get(current); item.token.value = ""; item.tokenBox.hidden = true; } current = null; unschedule(timer); timer = null; container.replaceChildren(); }
  return { async show(id) { if (current !== id) hide(); current = id; const item = state(id); container.replaceChildren(item.root); await load(item);
      if (!timer && current === id) { timer = schedule(() => { if (current === id && !document.hidden) void load(item); }, 5000); timer?.unref?.(); } },
    hide, reload: () => current ? load(state(current)) : Promise.resolve(), remove(id) { if (current === id) hide(); states.delete(id); } };
}

if (typeof document !== "undefined") {
  const container = document.getElementById("agent-services-content");
  if (container) {
    const view = createServiceView({ document, api: createApplicationApi(), container, clipboard: globalThis.navigator?.clipboard,
      onChange: (agentId) => document.dispatchEvent(new CustomEvent("neuma:agent-services-changed", { detail: { agentId } })) });
    document.addEventListener("neuma:agent-services-view", (event) => event.detail.active ? view.show(event.detail.agentId) : view.hide());
    document.addEventListener("neuma:agent-removed", (event) => view.remove(event.detail.id));
  }
}
