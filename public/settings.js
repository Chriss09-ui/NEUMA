const byId = (id) => document.getElementById(id);
const MIMO_URL = "https://api.xiaomimimo.com/v1/chat/completions";
const form = byId("settings-form");
const fields = { chatUrl: byId("settings-chat-url"), model: byId("settings-model"), apiKey: byId("settings-api-key"),
  jevApiKey: byId("settings-jev-key"), jevModel: byId("settings-jev-model") };
let current = null, saving = false, clearJev = false;

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

function fill(settings) {
  current = settings; clearJev = false;
  fields.chatUrl.value = settings.chatUrl;
  fields.model.value = settings.model;
  fields.jevModel.value = settings.jevModel;
  fields.apiKey.value = fields.jevApiKey.value = "";
  fields.apiKey.placeholder = settings.apiKey.set ? "••••••••••••" : "粘贴 API Key";
  fields.jevApiKey.placeholder = settings.jevApiKey.set ? "••••••••••••" : "粘贴 TypeSafe API Key";
  byId("settings-api-key-help").textContent = keyHelp(settings.apiKey, false);
  byId("settings-jev-key-help").textContent = keyHelp(settings.jevApiKey, true);
  byId("settings-clear-jev").hidden = !settings.jevApiKey.set;
  setStatus("settings-llm-status", settings.llmConfigured, false);
  setStatus("settings-jev-status", settings.jevConfigured, true);
}

async function load() {
  try {
    const response = await fetch("/api/settings");
    if (!response.ok) throw new Error();
    fill(await response.json());
    showError();
  } catch { showError("无法读取当前配置，请确认本地服务正在运行。"); }
}

function setSaving(value) {
  saving = value;
  for (const el of form.querySelectorAll("input, button")) el.disabled = value;
  byId("settings-save").textContent = value ? "保存中…" : "保存设置";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving) return;
  const body = {};
  for (const [key, el] of Object.entries(fields)) {
    const value = el.value.trim();
    if (key === "apiKey" || key === "jevApiKey") { if (value) body[key] = value; }
    else if (value !== (current?.[key] ?? "")) body[key] = value;
  }
  if (clearJev && !body.jevApiKey) body.clear = ["jevApiKey"];
  if (!Object.keys(body).length) { byId("settings-note").textContent = "没有需要保存的修改。"; return; }
  setSaving(true); showError();
  try {
    const response = await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "保存失败，请重试");
    fill(result);
    byId("settings-note").textContent = `已保存（${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}），下一轮对话起生效。`;
    document.dispatchEvent(new CustomEvent("neuma:settings-changed"));
  } catch (failure) { showError(failure.message); }
  finally { setSaving(false); }
});

for (const toggle of form.querySelectorAll("[data-reveal]")) {
  toggle.addEventListener("click", () => {
    const target = byId(toggle.dataset.reveal);
    target.type = target.type === "password" ? "text" : "password";
    toggle.textContent = target.type === "password" ? "显示" : "隐藏";
  });
}
byId("settings-use-mimo").addEventListener("click", () => { fields.chatUrl.value = MIMO_URL; fields.chatUrl.focus(); });
byId("settings-clear-jev").addEventListener("click", () => {
  clearJev = !clearJev;
  fields.jevApiKey.value = "";
  byId("settings-clear-jev").textContent = clearJev ? "撤销清除" : "清除此 Key";
  byId("settings-jev-key-help").textContent = clearJev ? "保存后将清除 Jev Key 并停用 Jev。" : keyHelp(current?.jevApiKey, true);
});
document.addEventListener("neuma:route", (event) => { if (event.detail.page === "settings" && !saving) void load(); });
void load();
