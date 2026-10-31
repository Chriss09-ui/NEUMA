import type { FormElement, FormDocument } from "./form-dom.js";
import type { ApplicationApi, ServicesResult, WorkflowTask } from "./ui-api-types.js";
import type { ValueSchema } from "./ui-types.js";
interface ServiceTaskRow<E> { form: E; note: E; fields: E; submit: E; task?: WorkflowTask | undefined; choice?: E | undefined; read?: (() => unknown) | undefined; schemaKey?: string | undefined }
interface ServiceItem<E> { id: string; root: E; operations: Map<string, E>; tasks: Map<string, ServiceTaskRow<E>>; busy: boolean; loading: boolean; generation: number; selectionDirty: boolean; feedback?: E; environments?: Map<string, { status: E; prepare: E }>; data?: ServicesResult | undefined; serviceStatus?: E; runButtons?: E[]; history?: E; rollback?: E; log?: E; gatewayStatus?: E; actionList?: E; gatewaySave?: E; gatewayRevoke?: E; addresses?: E; tokenBox?: E; token?: E; taskSection?: E; historyKey?: string | undefined }
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
  const section = (parent: E, title: string) => { const value = node("section", "service-section"); value.append(node("h3", "", title)); parent.append(value); return value; };
  function input(parent: E, title: string, schema: Partial<ValueSchema> & { title?: string | undefined } = {}): () => unknown {
    if (schema.type === "object") {
      const group = node("fieldset", "service-input-group"), fields = new Map<string, () => unknown>(); group.append(node("legend", "", title)); parent.append(group);
      for (const [key, definition] of Object.entries(schema.properties || {})) fields.set(key, input(group, (definition as ValueSchema & { title?: string }).title || definition.description || key, definition));
      return () => Object.fromEntries([...fields].map(([key, read]) => [key, read()]));
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
    else (field as E).type = schema.type === "boolean" ? "checkbox" : ["integer", "number"].includes(schema.type!) ? "number" : "text";
    if (field.type === "number") (field as E).step = schema.type === "integer" ? "1" : "any";
    label.append(field); parent.append(label);
    return () => schema.enum ? JSON.parse(field.value!) : schema.type === "boolean" ? (field as E).checked
      : ["integer", "number"].includes(schema.type!) ? Number(field.value) : field.value;
  }
  function state(id: string): ServiceItem<E> {
    if (states.has(id)) return states.get(id)!;
    const item: ServiceItem<E> = { id, root: node("div", "service-settings"), operations: new Map(), tasks: new Map(), busy: false, loading: false, generation: 0, selectionDirty: false };
    item.feedback! = node("p", "service-feedback muted-note", "正在读取运行状态…"); item.feedback!.setAttribute("role", "status"); item.feedback!.setAttribute("aria-live", "polite");
    const intro = node("div", "service-intro");
    intro.append(node("p", "muted-note small", "功能在这台电脑运行，随 NEUMA 启停。关闭网页后仍可继续，退出 NEUMA 或关机后停止。"),
      button("刷新状态", () => load(item), "ghost-button"));
    item.root.append(intro, item.feedback!);
    const environments = section(item.root, "运行环境"); item.environments! = new Map();
    for (const [key, title] of [["javascript", "JavaScript"], ["python", "Python"], ["docker", "Docker（可选）"]] as const) {
      const row = node("div", "service-environment"), status = node("span", "service-environment-status");
      const prepare = button(key === "docker" ? "检查 Docker" : "准备环境", () => operate(item, () => api.prepareService(id, key === "docker" ? item.data?.service?.language || "javascript" : key, key === "docker" ? "docker" : "managed")));
      row.append(node("strong", "", title), status, prepare); environments.append(row); item.environments!.set(key, { status, prepare });
    }
    environments.append(node("p", "service-hint muted-note small", "只准备当前功能需要的环境。Docker 需在本机安装并启动后使用。"));
    const service = section(item.root, "当前功能"); item.serviceStatus! = node("p", "service-status muted-note"); service.append(item.serviceStatus!);
    item.runButtons! = [
      button("启动", () => operate(item, () => api.startService(id, item.data!.deliveryVersion))),
      button("停止", () => operate(item, () => api.stopService(id, item.data!.deliveryVersion))),
      button("重新启动", () => operate(item, () => api.restartService(id, item.data!.deliveryVersion))),
    ];
    const controls = node("div", "connection-actions"); controls.append(...item.runButtons!); service.append(controls);
    const versionRow = node("div", "service-version-row"), history = node("label", "connection-field", "交付版本"); item.history! = node("select"); history.append(item.history!);
    item.rollback! = button("恢复所选版本", () => operate(item, () => api.rollbackService(id, item.history!.value!))); versionRow.append(history, item.rollback!); service.append(versionRow);
    const logs = node("details", "panel-disclosure"); logs.append(node("summary", "", "运行记录")); item.log! = node("pre", "service-log");
    logs.append(button("读取记录", () => operate(item, async () => { const result = await api.serviceLogs(id, item.data!.deliveryVersion); item.log!.textContent = result.text || "暂无运行记录。"; }, false), "ghost-button"), item.log!); service.append(logs);
    const gateway = section(item.root, "给本机其他工具使用");
    gateway.append(node("p", "muted-note small", "选择允许调用的功能后再开启接口。调用方需要下方地址和访问令牌。"));
    item.gatewayStatus! = node("p", "service-status muted-note"); item.actionList! = node("fieldset", "service-action-list"); item.actionList!.append(node("legend", "sr-only", "允许调用的功能"));
    item.gatewaySave! = button("开启或更新接口", () => operate(item, async () => {
      const actionIds = [...item.operations].filter(([, field]) => (field as E).checked).map(([actionId]) => actionId);
      if (!actionIds.length) throw new Error("请先选择至少一项允许调用的功能。");
      const result = await api.configureGateway(id, actionIds, item.data!.deliveryVersion); item.token!.value = current === id ? result.token || "" : ""; item.tokenBox!.hidden = !item.token!.value;
      item.selectionDirty = false;
    }));
    item.gatewayRevoke! = button("停用接口", () => operate(item, async () => { await api.revokeGateway(id); item.token!.value = ""; item.tokenBox!.hidden = true; }));
    item.addresses! = node("p", "service-addresses muted-note small"); item.tokenBox! = node("div", "service-token"); item.tokenBox!.hidden = true;
    const tokenLabel = node("label", "connection-field", "访问令牌（仅本次显示）"); item.token! = node("input"); item.token!.type = "password"; item.token!.readOnly = true; item.token!.autocomplete = "off"; tokenLabel.append(item.token!);
    item.tokenBox!.append(tokenLabel, button("复制访问令牌", () => operate(item, async () => {
      if (!clipboard?.writeText) throw new Error("无法自动复制，请在输入框中选择并复制令牌。"); await clipboard.writeText(item.token!.value!);
    }, false)), node("p", "muted-note small", "离开此面板后不再显示，请按需保存给调用方。"));
    const sharingActions = node("div", "connection-actions"); sharingActions.append(item.gatewaySave!, item.gatewayRevoke!);
    gateway.append(item.gatewayStatus!, item.actionList!, sharingActions, item.addresses!, item.tokenBox!);
    item.taskSection! = section(item.root, "等待处理的流程"); states.set(id, item); return item;
  }
  function refresh(item: ServiceItem<E>) {
    if (!item.data) return;
    const { environment = {}, service, workers = [], history = [], gateway = {}, workflowTasks = [] } = item.data;
    for (const [key, controls] of item.environments!) {
      const available = key === "docker" ? environment.docker : environment.managed?.[key as "javascript" | "python"];
      controls.status.textContent = key !== "docker" && environment.managed?.available === false ? "当前平台尚未支持"
        : available?.available ? `可用${available.version ? ` · ${available.version}` : ""}` : "尚未准备";
      controls.status.setAttribute("data-ready", available?.available ? "true" : "false");
      controls.prepare.disabled = item.busy || key !== "docker" && Boolean(available?.available) || key !== "docker" && environment.managed?.available === false;
    }
    item.serviceStatus!.textContent = service ? `${service.language === "python" ? "Python" : "JavaScript"} · ${service.host === "docker" ? "Docker" : "NEUMA 托管"} · ${statuses[(workers[0]?.status || service.status)!] || "已交付，尚未启动"}` : "这个智能体尚无需要独立运行的功能。";
    for (const control of item.runButtons!) control.disabled = item.busy || !service || !item.data!.deliveryVersion;
    const historyKey = JSON.stringify(history.map((entry) => [entry.deliveryVersion, entry.active]));
    if (historyKey !== item.historyKey) {
      const selected = item.history!.value; item.history!.replaceChildren();
      if (!history.length) { const option = node("option", "", "暂无交付版本"); option.value = ""; item.history!.append(option); }
      for (const entry of history) { const option = node("option", "", `${entry.active ? "当前 · " : ""}${entry.deliveryVersion}`); option.value = entry.deliveryVersion; item.history!.append(option); }
      item.history!.value = history.some((entry) => entry.deliveryVersion === selected) ? selected : item.data!.deliveryVersion || ""; item.historyKey = historyKey;
    }
    item.history!.disabled = item.busy || !history.length; item.rollback!.disabled = item.busy || !history.length;
    const outdatedGateway = gateway.enabled && gateway.deliveryVersion && gateway.deliveryVersion !== item.data!.deliveryVersion;
    item.gatewayStatus!.textContent = outdatedGateway ? "接口仍绑定旧版本，请选择当前功能后更新接口。"
      : gateway.status === "failed" ? gateway.message || "接口启动失败，请检查运行环境后重试。"
        : gateway.status === "suspended" ? "接口暂时暂停。" : gateway.enabled ? "接口已开启，仅本机可访问。" : "接口未开启。";
    if (outdatedGateway) { item.token!.value = ""; item.tokenBox!.hidden = true; }
    item.addresses!.textContent = [gateway.apiUrl && `API：${gateway.apiUrl}`, gateway.mcpUrl && `MCP：${gateway.mcpUrl}`].filter(Boolean).join("\n");
    const actions = service?.operations || service?.actions || item.data.actions || [];
    for (const action of actions) {
      if (!item.operations.has(action.id)) {
        const label = node("label", "connection-field", action.title || action.name || action.id), field = node("input"); field.type = "checkbox";
        field.addEventListener("change", () => { item.selectionDirty = true; }); label.append(field); item.actionList!.append(label); item.operations.set(action.id, field);
      }
      const field = item.operations.get(action.id)!; if (!item.selectionDirty) (field as E).checked = (gateway.actionIds || []).includes(action.id); field.disabled = item.busy;
    }
    for (const [actionId, field] of item.operations) if (!actions.some((action) => action.id === actionId)) { field.parentElement?.remove(); item.operations.delete(actionId); }
    item.gatewaySave!.disabled = item.busy || !actions.length; item.gatewayRevoke!.disabled = item.busy || !gateway.enabled;
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
      const schemaKey = JSON.stringify([task.status, task.waiting?.inputSchema || null, task.waiting?.outputSchema || null]);
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
    try { const data = await api.services(item.id); if (generation !== item.generation) return; item.data = data; item.feedback!.textContent = ""; item.feedback!.setAttribute("data-error", "false"); refresh(item); }
    catch (caught) { const error = errorInfo(caught); if (generation !== item.generation) return; item.feedback!.textContent = error.message || "运行状态读取失败，请重试。"; item.feedback!.setAttribute("data-error", "true"); }
    finally { item.loading = false; }
  }
  async function operate(item: ServiceItem<E>, action: () => Promise<unknown>, reload = true) {
    if (item.busy) return; item.busy = true; item.generation++; item.feedback!.textContent = "正在处理…"; item.feedback!.setAttribute("data-error", "false"); refresh(item);
    try { await action(); item.feedback!.textContent = "已完成。"; if (reload) { item.data = await api.services(item.id); refresh(item); onChange(item.id); } }
    catch (caught) { const error = errorInfo(caught); item.feedback!.textContent = error.message || "操作未完成，请重试。"; item.feedback!.setAttribute("data-error", "true"); }
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
