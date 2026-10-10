const byId = (id) => document.getElementById(id);
const MIMO_URL = "https://api.xiaomimimo.com/v1/chat/completions";
const form = byId("settings-form");
const fields = { chatUrl: byId("settings-chat-url"), model: byId("settings-model"), apiKey: byId("settings-api-key"),
  jevApiKey: byId("settings-jev-key"), jevModel: byId("settings-jev-model") };
let current = null, saving = false, clearJev = false;
let loading = null, loadSequence = 0;
let modelTest = null, modelTestSequence = 0;
const editedFields = new Set();

function showError(message = "") { byId("settings-error").textContent = message; byId("settings-error").hidden = !message; }

function keyHelp(secret, optional) {
  if (!secret?.set) return optional ? "未设置。留空则不启用。" : "未设置。";
  return `已设置${secret.hint ? `（末尾 ${secret.hint}）` : ""}。留空表示不修改，填写新值会替换。`;
}

function setStatus(id, configured, optional) {
  const el = byId(id);
  el.className = `status ${configured ? "ok" : optional ? "" : "off"}`;
  el.textContent = configured ? "已配置" : optional ? "未启用" : "未配置";
}

function fill(settings, preserveEdits = false) {
  current = settings;
  if (!preserveEdits) { editedFields.clear(); clearJev = false; }
  for (const [key, field] of Object.entries(fields)) {
    if (!editedFields.has(key)) field.value = ["apiKey", "jevApiKey"].includes(key) ? "" : settings[key];
  }
  fields.apiKey.placeholder = settings.apiKey.set ? "••••••••••••" : "粘贴 API Key";
  fields.jevApiKey.placeholder = settings.jevApiKey.set ? "••••••••••••" : "粘贴 TypeSafe API Key";
  byId("settings-api-key-help").textContent = keyHelp(settings.apiKey, false);
  byId("settings-jev-key-help").textContent = clearJev ? "保存后将清除 Jev Key 并停用 Jev。" : keyHelp(settings.jevApiKey, true);
  byId("settings-clear-jev").hidden = !settings.jevApiKey.set;
  byId("settings-clear-jev").textContent = clearJev ? "撤销清除" : "清除此 Key";
  setStatus("settings-llm-status", settings.llmConfigured, false);
  setStatus("settings-jev-status", settings.jevConfigured, true);
}

async function load() {
  if (loading || saving || modelTest) return;
  const request = { sequence: ++loadSequence }; loading = request;
  updateControls();
  try {
    const response = await fetch("/api/settings");
    if (!response.ok) throw new Error();
    const result = await response.json();
    if (request.sequence !== loadSequence || saving) return;
    fill(result, true);
    showError();
  } catch {
    if (request.sequence === loadSequence && !saving) showError("无法读取当前配置，请确认本地服务正在运行。");
  } finally { if (loading === request) { loading = null; updateControls(); } }
}

for (const [key, field] of Object.entries(fields)) field.addEventListener("input", () => {
  editedFields.add(key);
  if (["chatUrl", "model", "apiKey"].includes(key)) {
    invalidateTest("model");
  } else invalidateTest("jev");
});

function updateControls() {
  for (const el of form.querySelectorAll("input, button")) el.disabled = saving || !!modelTest;
  byId("settings-save").textContent = saving ? "保存中…" : "保存设置";
  for (const kind of ["model", "jev"]) {
    const testing = modelTest?.kind === kind;
    byId(`settings-${kind}-test`).disabled = saving || !!modelTest || !!loading || !current;
    byId(`settings-${kind}-test`).textContent = testing ? "测试中…" : "测试连接";
    byId(`settings-${kind}-test-cancel`).hidden = !testing;
    byId(`settings-${kind}-test-cancel`).disabled = !testing;
  }
}

function showTestResult(message = "", state = "", kind = "model") {
  const result = byId(`settings-${kind}-test-result`);
  result.textContent = message; result.hidden = !message; result.dataset.state = state;
}

function cancelModelTest(message = "测试已取消。", kind = modelTest?.kind) {
  if (!modelTest || modelTest.kind !== kind) return;
  const request = modelTest; modelTest = null; modelTestSequence++;
  request.controller.abort(); showTestResult(message, "cancelled", request.kind); updateControls();
}

function invalidateTest(kind) {
  cancelModelTest("", kind); showTestResult("", "", kind);
}

async function testConnection(kind = "model") {
  if (saving || modelTest || loading || !current) return;
  const body = kind === "jev" ? { jevModel: fields.jevModel.value.trim() }
    : { chatUrl: fields.chatUrl.value.trim(), model: fields.model.value.trim() };
  const key = (kind === "jev" ? fields.jevApiKey : fields.apiKey).value.trim();
  if (key) body[kind === "jev" ? "jevApiKey" : "apiKey"] = key;
  else if (kind === "jev" && clearJev) body.clear = ["jevApiKey"];
  const request = { kind, sequence: ++modelTestSequence, controller: new AbortController() };
  modelTest = request; updateControls(); showTestResult("正在测试连接…", "testing", kind);
  try {
    const response = await fetch(`/api/settings/test-${kind}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: request.controller.signal });
    const result = await response.json();
    if (request.sequence !== modelTestSequence || request.controller.signal.aborted) return;
    if (!response.ok) { showTestResult(`测试失败：${result.error || "服务暂时无法完成测试，请重试。"}`, "error", kind); return; }
    if (result.ok !== true || typeof result.model !== "string" || !Number.isFinite(result.latencyMs) || result.latencyMs < 0) {
      showTestResult("测试失败：测试结果不完整，请重试。", "error", kind); return;
    }
    showTestResult(`连接成功 · ${result.model} · ${Math.round(result.latencyMs)} ms`, "success", kind);
  } catch {
    if (request.sequence === modelTestSequence && !request.controller.signal.aborted)
      showTestResult("测试失败：无法连接本地服务，请确认 NEUMA 正在运行。", "error", kind);
  } finally {
    if (modelTest === request) { modelTest = null; updateControls(); }
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving || modelTest) return;
  const body = {};
  for (const [key, el] of Object.entries(fields)) {
    const value = el.value.trim();
    if (key === "apiKey" || key === "jevApiKey") { if (value) body[key] = value; }
    else if (value !== (current?.[key] ?? "")) body[key] = value;
  }
  if (clearJev && !body.jevApiKey) body.clear = ["jevApiKey"];
  if (!Object.keys(body).length) { byId("settings-note").textContent = "没有需要保存的修改。"; return; }
  loadSequence++; loading = null;
  saving = true; updateControls(); showError();
  try {
    const response = await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "保存失败，请重试");
    fill(result);
    showTestResult(); showTestResult("", "", "jev");
    byId("settings-note").textContent = `已保存（${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}），下一轮对话起生效。`;
    document.dispatchEvent(new CustomEvent("neuma:settings-changed"));
  } catch (failure) { showError(failure.message); }
  finally { saving = false; updateControls(); }
});

byId("settings-model-test").addEventListener("click", () => { void testConnection(); });
byId("settings-model-test-cancel").addEventListener("click", () => cancelModelTest("测试已取消。", "model"));
byId("settings-jev-test").addEventListener("click", () => { void testConnection("jev"); });
byId("settings-jev-test-cancel").addEventListener("click", () => cancelModelTest("测试已取消。", "jev"));

for (const toggle of form.querySelectorAll("[data-reveal]")) {
  toggle.addEventListener("click", () => {
    const target = byId(toggle.dataset.reveal);
    target.type = target.type === "password" ? "text" : "password";
    toggle.textContent = target.type === "password" ? "显示" : "隐藏";
  });
}
byId("settings-use-mimo").addEventListener("click", () => {
  fields.chatUrl.value = MIMO_URL; editedFields.add("chatUrl"); invalidateTest("model"); fields.chatUrl.focus();
});
byId("settings-clear-jev").addEventListener("click", () => {
  clearJev = !clearJev;
  invalidateTest("jev");
  editedFields.add("jevApiKey");
  fields.jevApiKey.value = "";
  byId("settings-clear-jev").textContent = clearJev ? "撤销清除" : "清除此 Key";
  byId("settings-jev-key-help").textContent = clearJev ? "保存后将清除 Jev Key 并停用 Jev。" : keyHelp(current?.jevApiKey, true);
});
document.addEventListener("neuma:route", (event) => {
  if (event.detail.page !== "settings") cancelModelTest("");
  else if (!saving && !modelTest && !editedFields.size) void load();
});
void load();
