import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/settings.js", import.meta.url), "utf8");
const settle = () => new Promise(setImmediate);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settings = (overrides = {}) => ({ chatUrl: "https://example.test/v1/chat/completions", model: "old-model", jevModel: "jev",
  apiKey: { set: false, hint: "" }, jevApiKey: { set: true, hint: "" }, llmConfigured: false, jevConfigured: true, ...overrides });

async function setup({ load, save } = {}) {
  class Events {
    listeners = new Map();
    addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
    dispatchEvent(event) { return Promise.all((this.listeners.get(event.type) ?? []).map((callback) => callback(event))); }
  }
  const document = new Events(), nodes = new Map(), requests = [];
  class Element extends Events {
    value = ""; textContent = ""; hidden = false; disabled = false; dataset = {};
    focus() { document.activeElement = this; }
    querySelectorAll(selector) { return selector === "input, button" ? [...nodes.values()].filter((node) => node !== this) : []; }
  }
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  document.getElementById = get;
  class Event { constructor(type, fields = {}) { this.type = type; Object.assign(this, fields); } }
  vm.runInNewContext(source, { document, CustomEvent: Event,
    fetch: async (path, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ path, body });
      return body ? await (save?.(body) ?? Response.json(settings({ ...body })))
        : await (load?.() ?? Response.json(settings()));
    },
  });
  await settle();
  return { get, requests,
    route: (page) => document.dispatchEvent(new Event("neuma:route", { detail: { page } })),
    input: async (id, value) => { get(id).value = value; await get(id).dispatchEvent(new Event("input")); },
    click: (id) => get(id).dispatchEvent(new Event("click")),
    submit: () => get("settings-form").dispatchEvent({ type: "submit", preventDefault() {} }),
  };
}

test("设置初始化和路由共享正在读取的请求，迟到结果保留已修改字段", async () => {
  const pending = deferred(), ui = await setup({ load: () => pending.promise });
  await ui.route("settings");
  assert.equal(ui.requests.length, 1);
  await ui.input("settings-model", "edited-model");
  await ui.input("settings-api-key", "synthetic-input");
  pending.resolve(Response.json(settings())); await settle();
  assert.equal(ui.get("settings-model").value, "edited-model");
  assert.equal(ui.get("settings-api-key").value, "synthetic-input");
  assert.equal(ui.get("settings-chat-url").value, settings().chatUrl);
});

test("离开再返回设置保留尚未保存的输入与清除选择", async () => {
  const ui = await setup();
  await ui.input("settings-model", "unsaved-model");
  await ui.click("settings-clear-jev");
  await ui.route("chat"); await ui.route("settings"); await settle();
  assert.equal(ui.get("settings-model").value, "unsaved-model");
  assert.equal(ui.get("settings-clear-jev").textContent, "撤销清除");
  await ui.submit();
  assert.deepEqual(ui.requests.at(-1).body, { model: "unsaved-model", clear: ["jevApiKey"] });
});

test("快捷地址属于未保存修改，返回设置时不会被服务端旧地址覆盖", async () => {
  const ui = await setup();
  await ui.click("settings-use-mimo");
  await ui.route("chat"); await ui.route("settings"); await settle();
  assert.equal(ui.get("settings-chat-url").value, "https://api.xiaomimimo.com/v1/chat/completions");
});

test("保存后旧读取结果和旧读取失败都不能回写表单或错误", async () => {
  for (const failure of [false, true]) {
    const pending = deferred(); let loads = 0;
    const ui = await setup({ load: () => ++loads === 1 ? Response.json(settings()) : pending.promise,
      save: (body) => Response.json(settings({ ...body })) });
    await ui.route("settings");
    await ui.input("settings-model", "saved-model");
    await ui.submit();
    if (failure) pending.reject(new Error("旧读取失败"));
    else pending.resolve(Response.json(settings()));
    await settle();
    assert.equal(ui.get("settings-model").value, "saved-model");
    assert.equal(ui.get("settings-error").hidden, true);
    assert.match(ui.get("settings-note").textContent, /已保存/);
  }
});
