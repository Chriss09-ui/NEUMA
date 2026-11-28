import type { FormElement, FormDocument } from "./form-dom.js";
import type { ApplicationApi, ServicesResult, WorkflowTask } from "./ui-api-types.js";
import type { ValueSchema } from "./ui-types.js";
interface ServiceTaskRow<E> { form: E; note: E; fields: E; submit: E; task?: WorkflowTask | undefined; choice?: E | undefined; read?: (() => unknown) | undefined; schemaKey?: string | undefined }
interface ServicePermission<E> { row: E; field: E; title: E }
interface ServiceItem<E> {
  id: string; root: E; content: E; feedback: E; retry: E; data?: ServicesResult;
  operations: Map<string, ServicePermission<E>>; tasks: Map<string, ServiceTaskRow<E>>; taskSection?: E;
  busy: boolean; loading: boolean; generation: number; selectionDirty: boolean;
  environments?: Map<string, { status: E; prepare: E }>; serviceStatus?: E; runButtons?: E[]; runControls?: E;
  versionRow?: E; history?: E; historyKey?: string; rollback?: E; logs?: E; log?: E;
  gatewayStatus?: E; gatewayHelp?: E; actionList?: E; conversation?: ServicePermission<E>; gatewaySave?: E; gatewayRevoke?: E;
  addresses?: E; endpoints?: { key: "apiUrl" | "mcpUrl"; row: E; value: E }[]; tokenBox?: E; token?: E;
}
type Interval = number | { unref?: (() => unknown) | undefined };
type Schedule = (callback: () => void, delay: number) => Interval;
type Unschedule = (timer: Interval | undefined) => unknown;
const unscheduleInterval: Unschedule = (timer) => clearInterval(timer as ReturnType<typeof setInterval> | undefined);
import { errorInfo } from "./ui-types.js";
import { createApplicationApi } from "./application-api.js";

const statuses: Record<string, string> = { ready: "已就绪", running: "正在执行", stopped: "已停止", interrupted: "执行已中断", failed: "执行失败",
  waiting_input: "等待补充", needs_review: "需要核实上次执行", completed: "已完成", pending: "等待执行", cancelled: "已取消" };

export function createServiceView<E extends FormElement<E> = HTMLElement>({ document, api, container, clipboard, onChange = () => {}, schedule = setInterval, unschedule = unscheduleInterval }: { document: FormDocument<E>; api: ApplicationApi; container: E; clipboard?: Pick<Clipboard, "writeText"> | undefined; onChange?: ((agentId: string) => unknown) | undefined; schedule?: Schedule | undefined; unschedule?: Unschedule | undefined }) {
  const states = new Map<string, ServiceItem<E>>(); let current: string | null = null, timer: Interval | null = null;
  const node = (tag: string, className = "", text = "") => { const value = document.createElement(tag); value.className = className; value.textContent = text; return value; };
  const button = (text: string, action: () => unknown, className = "secondary") => {
    const value = node("button", className, text); value.type = "button"; value.addEventListener("click", action); return value;
  };
  function section(parent: E, title: string, accessory?: E) {
    const value = node("section", "service-section"), header = node("div", "service-heading");
    header.append(node("h3", "", title));
    if (accessory) header.append(accessory);
    value.append(header); parent.append(value); return value;
  }
  function disclosure(title: string, detail?: string) {
    const value = node("details", "service-disclosure"), summary = node("summary");
    summary.append(node("span", "", title));
    if (detail) summary.append(node("small", "", detail));
    value.append(summary); return value;
  }
  function input(parent: E, title: string, schema: Partial<ValueSchema> & { title?: string | undefined } = {}): () => unknown {
    if (schema.type === "object") {
      const group = node("fieldset", "service-input-group"), fields = new Map<string, () => unknown>(); group.append(node("legend", "", title)); parent.append(group);
      for (const [key, definition] of Object.entries(schema.properties || {})) {
        const name = (definition as ValueSchema & { title?: string }).title || definition.description || key;
        if (!schema.required || schema.required.includes(key)) {
          fields.set(key, input(group, name, definition));
        } else {
          const label = node("label", "connection-field", `填写${name}（可选）`), include = node("input");
          include.type = "checkbox"; label.append(include);
          const value = node("div"); value.hidden = true; group.append(label, value);
          const read = input(value, name, definition);
          include.addEventListener("change", () => { value.hidden = !include.checked; });
          fields.set(key, () => include.checked ? read() : undefined);
        }
      }
      return () => Object.fromEntries([...fields].map(([key, read]) => [key, read()] as const).filter(([, value]) => value !== undefined));
    }
    if (schema.type === "array") {
      const group = node("fieldset", "service-input-group"), list = node("div");
      const entries: { root: E; heading: E; remove: E; read: () => unknown }[] = [], limit = schema.maxItems ?? 10000;
      const sync = () => {
        entries.forEach((entry, index) => { entry.heading.textContent = `第 ${index + 1} 项`; entry.remove.setAttribute("aria-label", `移除${title}的第 ${index + 1} 项`); });
        add.disabled = entries.length >= limit;
      };
      const add = button("添加一项", () => {
        if (entries.length >= limit) return;
        const root = node("fieldset", "service-input-group"), heading = node("legend"); root.append(heading); root.setAttribute("tabindex", "-1");
        const read = input(root, "内容", schema.items || {});
        const remove = button("移除此项", () => {
          const index = entries.indexOf(entry); if (index < 0) return;
          entries.splice(index, 1); root.remove(); sync();
          (entries[index]?.root || entries.at(-1)?.root || add).focus?.();
        }, "ghost-button");
        const entry = { root, heading, remove, read }; entries.push(entry); root.append(remove); list.append(root); sync(); root.focus?.();
      });
      add.setAttribute("aria-label", `为${title}添加一项`);
      group.append(node("legend", "", title), list, add); parent.append(group); sync();
      return () => entries.map(entry => entry.read());
    }
    if (schema.type === "null") { parent.append(node("p", "muted-note small", `${title}：空值`)); return () => null; }
    const label = node("label", "connection-field", title);
    const field = node(schema.enum ? "select" : schema.type === "string" ? "textarea" : "input");
    if (schema.enum) for (const option of schema.enum) { const item = node("option", "", String(option)); item.value = JSON.stringify(option); field.append(item); }
    else if (schema.type !== "string") field.type = schema.type === "boolean" ? "checkbox" : ["integer", "number"].includes(schema.type!) ? "number" : "text";
    if (field.type === "number") (field as E).step = schema.type === "integer" ? "1" : "any";
    label.append(field); parent.append(label);
    return () => {
      if (field.type === "number" && field.value === "") throw new Error(`请填写${title}的数值`);
      return schema.enum ? JSON.parse(field.value!) : schema.type === "boolean" ? field.checked
        : field.type === "number" ? Number(field.value) : field.value;
    };
  }
  function state(id: string): ServiceItem<E> {
    if (states.has(id)) return states.get(id)!;
    const item: ServiceItem<E> = { id, root: node("div", "service-settings"), content: node("div", "service-sections"),
      feedback: node("p", "service-feedback", "正在读取运行状态…"), retry: button("重新读取", () => load(item)),
      operations: new Map(), tasks: new Map(), busy: false, loading: false, generation: 0, selectionDirty: false };
    item.feedback.setAttribute("role", "status"); item.retry.hidden = true; item.content.hidden = true;
    item.root.append(item.feedback, item.retry, item.content);
    buildGateway(item);
    item.taskSection = section(item.content, "等待处理的流程");
    const service = section(item.content, "运行管理", button("刷新状态", () => load(item), "ghost-button"));
    item.serviceStatus = node("p", "service-description"); service.append(item.serviceStatus);
    item.runButtons = [
      button("启动", () => operate(item, () => api.startService(id, item.data!.deliveryVersion))),
      button("停止", () => operate(item, () => api.stopService(id, item.data!.deliveryVersion))),
      button("重新启动", () => operate(item, () => api.restartService(id, item.data!.deliveryVersion))),
    ];
    item.runControls = node("div", "service-actions"); item.runControls.append(...item.runButtons);
    item.versionRow = node("div", "service-control-row");
    const history = node("label", "connection-field", "交付版本");
    item.history = node("select"); history.append(item.history);
    item.rollback = button("恢复所选版本", () => operate(item, () => api.rollbackService(id, item.history!.value!)));
    item.versionRow.append(history, item.rollback);
    item.logs = disclosure("运行记录"); item.log = node("pre", "service-log");
    item.logs.append(button("读取记录", () => operate(item, async () => {
      const result = await api.serviceLogs(id, item.data!.deliveryVersion);
      item.log!.textContent = result.text || "暂无运行记录。";
    }, false), "ghost-button"), item.log);
    const environments = disclosure("运行环境", "JavaScript / Python / Docker");
    service.append(item.runControls, item.versionRow, item.logs, environments);
    item.environments = new Map();
    for (const [key, title] of [["javascript", "JavaScript"], ["python", "Python"], ["docker", "Docker（可选）"]] as const) {
      const row = node("div", "service-environment"), status = node("span", "service-environment-status");
      const prepare = button(key === "docker" ? "检查 Docker" : "准备环境", () => operate(item, () => api.prepareService(id, key === "docker" ? item.data?.service?.language || "javascript" : key, key === "docker" ? "docker" : "managed")));
      row.append(node("strong", "", title), status, prepare); environments.append(row); item.environments.set(key, { status, prepare });
    }
    environments.append(node("p", "service-hint", "按需准备环境。使用 Docker 前请先在本机安装并启动。关闭网页后服务会继续运行，退出 NEUMA 或关机后停止。"));
    states.set(id, item); return item;
  }
  function buildGateway(item: ServiceItem<E>) {
    const { id } = item;
    item.gatewayStatus = node("span", "service-gateway-status");
    const gateway = section(item.content, "本机接口", item.gatewayStatus);
    item.gatewayHelp = node("p", "service-description");
    item.actionList = node("fieldset", "service-action-list"); item.actionList.append(node("legend", "sr-only", "允许调用的功能"));
    item.conversation = permission(item, "允许与智能体对话", "用自然语言派任务，可调用智能体的模型和全部已交付动作。材料和文件保存在独立会话中。");
    item.gatewaySave = button("开启接口", () => operate(item, async () => {
      const actionIds = [...item.operations].filter(([, choice]) => choice.field.checked).map(([actionId]) => actionId);
      const conversationVersion = item.conversation!.field.checked ? item.data?.conversationVersion : undefined;
      if (!actionIds.length && !conversationVersion) throw new Error("请先选择至少一项允许调用的功能。");
      const result = conversationVersion
        ? await api.configureGateway(id, actionIds, item.data!.deliveryVersion || conversationVersion, conversationVersion)
        : await api.configureGateway(id, actionIds, item.data!.deliveryVersion);
      item.token!.value = current === id ? result.token || "" : ""; item.tokenBox!.hidden = !item.token!.value;
      item.selectionDirty = false;
    }), "primary");
    item.gatewayRevoke = button("停用接口", () => operate(item, async () => {
      await api.revokeGateway(id); item.selectionDirty = false; item.token!.value = ""; item.tokenBox!.hidden = true;
    }), "ghost-button");
    const sharingActions = node("div", "service-actions"); sharingActions.append(item.gatewaySave, item.gatewayRevoke);
    item.addresses = node("dl", "service-addresses");
    item.endpoints = (["mcpUrl", "apiUrl"] as const).map(key => {
      const row = node("div"), value = node("dd");
      row.append(node("dt", "", key === "mcpUrl" ? "MCP 地址" : "API 地址"), value);
      item.addresses!.append(row); return { key, row, value };
    });
    item.tokenBox = node("div", "service-token"); item.tokenBox.hidden = true;
    const tokenRow = node("div", "service-control-row"), tokenLabel = node("label", "connection-field", "访问令牌");
    item.token = node("input"); item.token.type = "password"; item.token.readOnly = true; item.token.autocomplete = "off"; tokenLabel.append(item.token);
    tokenRow.append(tokenLabel, button("复制访问令牌", () => operate(item, async () => {
      if (!clipboard?.writeText) throw new Error("无法自动复制，请在输入框中选择并复制令牌。"); await clipboard.writeText(item.token!.value!);
    }, false)));
    item.tokenBox.append(tokenRow, node("p", "service-hint", "令牌仅显示一次，请在离开此面板前复制。"));
    gateway.append(item.gatewayHelp, item.actionList, sharingActions, item.addresses, item.tokenBox);
  }
  function permission(item: ServiceItem<E>, name: string, description?: string): ServicePermission<E> {
    const row = node("label", "service-permission"), field = node("input"), title = node("strong", "", name);
    const copy = node("span"); field.type = "checkbox"; copy.append(title);
    if (description) {
      const help = node("small", "", description), helpId = `service-conversation-help-${item.id}`;
      help.setAttribute("id", helpId); field.setAttribute("aria-label", name); field.setAttribute("aria-describedby", helpId);
      copy.append(help);
    }
    field.addEventListener("change", () => { item.selectionDirty = true; updateGatewayButton(item); });
    row.append(field, copy); item.actionList!.append(row); return { row, field, title };
  }
  function updateGatewayButton(item: ServiceItem<E>) {
    const selected = item.conversation!.field.checked || [...item.operations.values()].some(choice => choice.field.checked);
    item.gatewaySave!.disabled = item.busy || !selected;
  }
  function refreshGateway(item: ServiceItem<E>, data: ServicesResult) {
    const { gateway = {}, service, conversationVersion } = data;
    const actions = service?.operations || service?.actions || data.actions || [];
    const hasPermissions = Boolean(conversationVersion || actions.length);
    const conversation = item.conversation!;
    conversation.row.hidden = !conversationVersion;
    if (!conversationVersion || !item.selectionDirty) conversation.field.checked = Boolean(conversationVersion && gateway.conversationVersion);
    conversation.field.disabled = item.busy || !conversationVersion;
    for (const action of actions) {
      const name = action.title || action.name || action.id;
      let choice = item.operations.get(action.id);
      if (!choice) { choice = permission(item, name); item.operations.set(action.id, choice); }
      if (choice.title.textContent !== name) choice.title.textContent = name;
      if (!item.selectionDirty) choice.field.checked = (gateway.actionIds || []).includes(action.id);
      choice.field.disabled = item.busy;
    }
    for (const [id, choice] of item.operations) if (!actions.some(action => action.id === id)) { choice.row.remove(); item.operations.delete(id); }

    const outdated = gateway.enabled && (gateway.deliveryVersion !== (data.deliveryVersion || conversationVersion)
      || gateway.conversationVersion && gateway.conversationVersion !== conversationVersion);
    const status = outdated ? "outdated" : gateway.status === "failed" || gateway.status === "suspended" ? gateway.status
      : gateway.enabled ? "running" : "disabled";
    const labels = { disabled: "未开启", running: "已开启", outdated: "需更新", failed: "启动失败", suspended: "已暂停" };
    const help = { disabled: hasPermissions ? "勾选要开放给本机工具的权限。" : "当前暂无可授权的对话或动作。",
      running: "使用下方地址和访问令牌连接。更新接口会生成新令牌。", outdated: "接口仍绑定旧版本，请选择当前权限并更新接口。",
      failed: gateway.message || "请检查运行环境后重试。", suspended: "接口暂时暂停，恢复后本机工具可继续访问。" };
    item.gatewayStatus!.textContent = labels[status]; item.gatewayStatus!.setAttribute("data-state", status);
    item.gatewayHelp!.textContent = help[status]; item.actionList!.hidden = !hasPermissions;
    item.gatewaySave!.textContent = gateway.enabled ? "更新接口" : "开启接口"; item.gatewaySave!.hidden = !hasPermissions;
    item.gatewayRevoke!.hidden = !gateway.enabled; item.gatewayRevoke!.disabled = item.busy || !gateway.enabled; updateGatewayButton(item);
    item.addresses!.hidden = status !== "running" || !(gateway.mcpUrl || gateway.apiUrl);
    for (const { key, row, value } of item.endpoints!) {
      const address = gateway[key] || "";
      row.hidden = !address; if (value.textContent !== address) value.textContent = address;
    }
    return status;
  }
  function refresh(item: ServiceItem<E>, snapshot?: ServicesResult) {
    if (snapshot) {
      if (item.data?.deliveryVersion !== snapshot.deliveryVersion) item.log!.textContent = "";
      item.data = snapshot;
    }
    if (!item.data) return;
    const { environment = {}, service, workers = [], history = [], workflowTasks = [] } = item.data;
    const gatewayStatus = refreshGateway(item, item.data);
    // Only a fresh snapshot can invalidate a token just returned by the publish request.
    if (snapshot && (gatewayStatus === "outdated" || !snapshot.gateway?.enabled)) { item.token!.value = ""; item.tokenBox!.hidden = true; }
    for (const [key, controls] of item.environments!) {
      const available = key === "docker" ? environment.docker : environment.managed?.[key as "javascript" | "python"];
      controls.status.textContent = key !== "docker" && environment.managed?.available === false ? "当前平台尚未支持"
        : available?.available ? `可用${available.version ? ` · ${available.version}` : ""}` : "尚未准备";
      controls.status.setAttribute("data-ready", available?.available ? "true" : "false");
      controls.prepare.hidden = key !== "docker" && Boolean(available?.available);
      controls.prepare.disabled = item.busy || key !== "docker" && Boolean(available?.available) || key !== "docker" && environment.managed?.available === false;
    }
    item.serviceStatus!.textContent = service ? `${service.language === "python" ? "Python" : "JavaScript"} · ${service.host === "docker" ? "Docker" : "NEUMA 托管"} · ${statuses[(workers[0]?.status || service.status)!] || "已交付，尚未启动"}` : "暂无需要独立运行的服务。";
    item.runControls!.hidden = !service || !item.data.deliveryVersion;
    item.versionRow!.hidden = !history.length; item.logs!.hidden = !item.data.deliveryVersion;
    for (const control of item.runButtons!) control.disabled = item.busy || !service || !item.data!.deliveryVersion;
    const historyKey = JSON.stringify(history.map((entry) => [entry.deliveryVersion, entry.active]));
    if (historyKey !== item.historyKey) {
      const selected = item.history!.value; item.history!.replaceChildren();
      for (const entry of history) { const option = node("option", "", `${entry.active ? "当前 · " : ""}${entry.deliveryVersion}`); option.value = entry.deliveryVersion; item.history!.append(option); }
      item.history!.value = history.some(entry => entry.deliveryVersion === selected) ? selected
        : history.find(entry => entry.active)?.deliveryVersion || history[0]?.deliveryVersion || "";
      item.historyKey = historyKey;
    }
    item.history!.disabled = item.busy || !history.length; item.rollback!.disabled = item.busy || !history.length;
    item.taskSection!.hidden = !workflowTasks.some((task) => ["waiting_input", "interrupted", "needs_review"].includes(task.status));
    for (const task of workflowTasks.filter((task) => ["waiting_input", "interrupted", "needs_review"].includes(task.status))) {
      let row = item.tasks.get(task.id);
      if (!row) {
        const form = node("form", "service-task"), note = node("p", "muted-note"), fields = node("div");
        const submit = node("button", "secondary", "继续执行"); submit.type = "submit"; form.append(note, fields, submit);
        row = { form, note, fields, submit }; item.tasks.set(task.id, row); item.taskSection!.append(form);
        form.addEventListener("submit", (event) => { event.preventDefault(); return operate(item, () => {
          let resolution;
          if (row!.task!.status === "needs_review") {
            const outcome = row!.choice?.value;
            if (!["completed", "retry"].includes(outcome!)) throw new Error("请先核实上次操作的结果，再选择继续方式。");
            resolution = { ...(row!.task!.waiting.attemptId ? { attemptId: row!.task!.waiting.attemptId } : {}), stepId: row!.task!.waiting.stepId, index: row!.task!.waiting.index, outcome,
              ...(outcome === "completed" ? { output: row!.read?.() } : { explicitlyApproved: true }) };
          }
          return api.resumeTask(item.id, row!.task!.id, resolution ? undefined : row!.read ? row!.read() : {}, row!.task!.version, `resume_${globalThis.crypto.randomUUID()}`, resolution);
        }); });
      }
      row.task = task; row.form.hidden = false; row.note.textContent = task.waiting?.prompt || statuses[task.status]!; row.submit.disabled = item.busy;
      if (task.status === "needs_review") row.note.textContent = "上次操作可能已经产生结果，需要先核实，避免重复执行。";
      const schemaKey = JSON.stringify([task.status, task.waiting?.stepId, task.waiting?.index, task.waiting?.attemptId,
        task.waiting?.inputSchema, task.waiting?.outputSchema]);
      if (row.schemaKey !== schemaKey) {
        row.fields.replaceChildren();
        if (task.status === "needs_review") {
          const label = node("label", "connection-field", "核实后的处理方式"), choice = node("select");
          for (const [value, title] of [["", "请选择"], ["completed", "上次已经完成，补充实际结果"], ["retry", "确认重新执行，接受可能重复产生的外部操作"]] as const) {
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
  async function load(item: ServiceItem<E>) {
    if (item.loading || item.busy) return; item.loading = true; const generation = ++item.generation;
    if (!item.data) { item.feedback.textContent = "正在读取运行状态…"; item.feedback.setAttribute("data-error", "false"); item.retry.hidden = true; }
    try {
      const data = await api.services(item.id); if (generation !== item.generation) return;
      refresh(item, data); item.content.hidden = false; item.retry.hidden = true;
      item.feedback.textContent = ""; item.feedback.setAttribute("data-error", "false");
    }
    catch (caught) {
      const error = errorInfo(caught); if (generation !== item.generation) return;
      item.feedback.textContent = error.message || "运行状态读取失败，请重试。"; item.feedback.setAttribute("data-error", "true"); item.retry.hidden = !item.content.hidden;
    }
    finally { item.loading = false; }
  }
  async function operate(item: ServiceItem<E>, action: () => Promise<unknown>, reload = true) {
    if (item.busy) return; item.busy = true; item.generation++; item.feedback.textContent = "正在处理…"; item.feedback.setAttribute("data-error", "false"); refresh(item);
    try { await action(); item.feedback.textContent = "已完成。"; if (reload) { refresh(item, await api.services(item.id)); onChange(item.id); } }
    catch (caught) { const error = errorInfo(caught); item.feedback.textContent = error.message || "操作未完成，请重试。"; item.feedback.setAttribute("data-error", "true"); }
    finally { item.busy = false; refresh(item); }
  }
  function hide() { if (current) { const item = states.get(current)!; item.token!.value = ""; item.tokenBox!.hidden = true; } current = null; unschedule(timer ?? undefined); timer = null; container.replaceChildren(); }
  return { async show(id: string) { if (current !== id) hide(); current = id; const item = state(id); container.replaceChildren(item.root); await load(item);
      if (!timer && current === id) { timer = schedule(() => { if (current === id && !document.hidden) void load(item); }, 5000); typeof timer === "object" && timer?.unref?.(); } },
    hide, reload: () => current ? load(state(current)) : Promise.resolve(), remove(id: string) { if (current === id) hide(); states.delete(id); } };
}

if (typeof document !== "undefined") {
  const container = document.getElementById("agent-services-content");
  if (container) {
    const view = createServiceView({ document, api: createApplicationApi(), container, clipboard: globalThis.navigator?.clipboard,
      onChange: (agentId) => document.dispatchEvent(new CustomEvent("neuma:agent-services-changed", { detail: { agentId } })) });
    document.addEventListener("neuma:agent-services-view", (event) => event.detail.active ? view.show(event.detail.agentId!) : view.hide());
    document.addEventListener("neuma:agent-removed", (event) => view.remove(event.detail.id));
  }
}
