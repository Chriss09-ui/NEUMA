import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/settings.js", import.meta.url), "utf8");
const settle = () => new Promise(setImmediate);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settings = (overrides = {}) => ({ chatUrl: "https://example.test/v1/chat/completions", model: "old-model", jevModel: "jev",
  apiKey: { set: false, hint: "" }, jevApiKey: { set: true, hint: "" }, llmConfigured: false, jevConfigured: true, ...overrides });

async function setup({ load, save, probe, probeJev } = {}) {
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
  vm.runInNewContext(source, { document, CustomEvent: Event, AbortController,
    fetch: async (path, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ path, body, signal: options.signal });
      if (path === "/api/settings/test-model") return await (probe?.(body, options.signal) ?? Response.json({ ok: true, model: body.model, latencyMs: 125 }));
      if (path === "/api/settings/test-jev") return await (probeJev?.(body, options.signal) ?? Response.json({ ok: true, model: body.jevModel, latencyMs: 80 }));
      return body ? await (save?.(body) ?? Response.json(settings({ ...body })))
        : await (load?.() ?? Response.json(settings()));
    },
  });
  await settle();
  return { get, requests,
    route: (page) => document.dispatchEvent(new Event("neuma:route", { detail: { page } })),
    input: async (id, value) => { get(id).value = value; await get(id).dispatchEvent(new Event("input")); },
    click: async (id) => { await get(id).dispatchEvent(new Event("click")); await settle(); },
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

test("读取配置时禁止测试连接但保留输入编辑，读取成功后可测试", async () => {
  const pending = deferred(), ui = await setup({ load: () => pending.promise });
  assert.equal(ui.get("settings-model-test").disabled, true);
  assert.equal(ui.get("settings-model").disabled, false);
  await ui.input("settings-model", "pending-edit");
  await ui.click("settings-model-test");
  assert.equal(ui.requests.length, 1);
  pending.resolve(Response.json(settings())); await settle();
  assert.equal(ui.get("settings-model-test").disabled, false);
  assert.equal(ui.get("settings-model").value, "pending-edit");
});

test("连接测试使用当前未保存值并裁剪空白，不保存或清空新 Key", async () => {
  const ui = await setup();
  await ui.input("settings-chat-url", "  https://example.test/v2/chat/completions  ");
  await ui.input("settings-model", "  unsaved-model  ");
  await ui.input("settings-api-key", "  synthetic-new-key  ");
  await ui.click("settings-model-test");
  assert.equal(ui.requests.at(-1).path, "/api/settings/test-model");
  assert.deepEqual(ui.requests.at(-1).body, { chatUrl: "https://example.test/v2/chat/completions", model: "unsaved-model", apiKey: "synthetic-new-key" });
  assert.equal(ui.requests.filter((request) => request.path === "/api/settings" && request.body).length, 0);
  assert.equal(ui.get("settings-api-key").value, "  synthetic-new-key  ");
  assert.equal(ui.get("settings-model").value, "  unsaved-model  ");
  assert.equal(ui.get("settings-model-test-result").hidden, false);
  assert.equal(ui.get("settings-model-test-result").dataset.state, "success");
  assert.match(ui.get("settings-model-test-result").textContent, /连接成功/);
  assert.match(ui.get("settings-model-test-result").textContent, /unsaved-model/);
  assert.match(ui.get("settings-model-test-result").textContent, /125/);
});

test("Key 留空测试不发送替换字段，读取已保存 Key 时不获取明文", async () => {
  const ui = await setup({ load: () => Response.json(settings({ apiKey: { set: true, hint: "test" } })) });
  await ui.input("settings-api-key", "  ");
  await ui.click("settings-model-test");
  assert.deepEqual(ui.requests.at(-1).body, { chatUrl: settings().chatUrl, model: settings().model });
  assert.equal(ui.get("settings-api-key").value, "  ");
});

test("测试中锁定配置与保存且防止重复请求，取消按钮仍可用", async () => {
  const pending = deferred(), ui = await setup({ probe: () => pending.promise });
  await ui.input("settings-model", "draft-model");
  const running = ui.click("settings-model-test"); await settle();
  for (const id of ["settings-chat-url", "settings-model", "settings-api-key", "settings-jev-model", "settings-jev-key", "settings-save", "settings-use-mimo", "settings-model-test"])
    assert.equal(ui.get(id).disabled, true, id);
  assert.equal(ui.get("settings-model-test-cancel").disabled, false);
  assert.equal(ui.get("settings-model-test-cancel").hidden, false);
  assert.equal(ui.get("settings-model-test").textContent, "测试中…");
  assert.equal(ui.get("settings-model-test-result").dataset.state, "testing");
  await ui.click("settings-model-test"); await ui.submit();
  assert.equal(ui.requests.filter((request) => request.body).length, 1);
  pending.resolve(Response.json({ ok: true, model: "draft-model", latencyMs: 99 })); await running; await settle();
  assert.equal(ui.get("settings-model").disabled, false);
  assert.equal(ui.get("settings-save").disabled, false);
  assert.equal(ui.get("settings-model-test-cancel").hidden, true);
  assert.equal(ui.get("settings-model-test").textContent, "测试连接");
});

test("保存中不能发起连接测试，保存结束恢复测试按钮", async () => {
  const pending = deferred(), ui = await setup({ save: () => pending.promise });
  await ui.input("settings-model", "saved-model");
  const running = ui.submit(); await settle();
  assert.equal(ui.get("settings-model-test").disabled, true);
  await ui.click("settings-model-test");
  assert.equal(ui.requests.filter((request) => request.path === "/api/settings/test-model").length, 0);
  pending.resolve(Response.json(settings({ model: "saved-model" }))); await running;
  assert.equal(ui.get("settings-model-test").disabled, false);
});

test("取消测试中止请求并保持输入，迟到结果不能覆盖下一次测试", async () => {
  const pending = deferred(); let probes = 0;
  const ui = await setup({ probe: () => ++probes === 1 ? pending.promise : Response.json({ ok: true, model: "draft-model", latencyMs: 42 }) });
  await ui.input("settings-model", "draft-model");
  await ui.input("settings-api-key", "synthetic-draft-key");
  const running = ui.click("settings-model-test"); await settle();
  const signal = ui.requests.at(-1).signal;
  await ui.click("settings-model-test-cancel");
  assert.equal(signal.aborted, true);
  assert.equal(ui.get("settings-model-test-result").dataset.state, "cancelled");
  assert.equal(ui.get("settings-model-test").disabled, false);
  assert.equal(ui.get("settings-model").value, "draft-model");
  assert.equal(ui.get("settings-api-key").value, "synthetic-draft-key");
  await ui.click("settings-model-test");
  const result = ui.get("settings-model-test-result").textContent;
  pending.resolve(Response.json({ ok: true, model: "old-test", latencyMs: 9000 })); await running; await settle();
  assert.equal(ui.get("settings-model-test-result").dataset.state, "success");
  assert.equal(ui.get("settings-model-test-result").textContent, result);
});

test("离开设置中止测试，迟到异常不会覆盖取消状态或保存提示", async () => {
  const pending = deferred(), ui = await setup({ probe: () => pending.promise });
  await ui.input("settings-model", "draft-model");
  const running = ui.click("settings-model-test"); await settle();
  const signal = ui.requests.at(-1).signal;
  await ui.route("chat");
  assert.equal(signal.aborted, true);
  assert.equal(ui.get("settings-model-test-result").dataset.state, "cancelled");
  const cancelled = ui.get("settings-model-test-result").textContent;
  pending.reject(new Error("synthetic-late-private-payload")); await running;
  await ui.route("settings"); await settle();
  assert.equal(ui.get("settings-model-test-result").textContent, cancelled);
  assert.equal(ui.get("settings-model").value, "draft-model");
  assert.equal(ui.get("settings-error").hidden, true);
});

test("测试失败与保存错误分别展示，网络异常使用稳定提示", async () => {
  const ui = await setup({ save: () => Response.json({ error: "保存失败示例" }, { status: 400 }),
    probe: () => Response.json({ error: "认证失败，请检查 API Key" }, { status: 502 }) });
  await ui.input("settings-model", "draft-model"); await ui.submit();
  assert.equal(ui.get("settings-error").textContent, "保存失败示例");
  await ui.click("settings-model-test");
  assert.equal(ui.get("settings-model-test-result").dataset.state, "error");
  assert.match(ui.get("settings-model-test-result").textContent, /测试失败.*认证失败/);
  assert.equal(ui.get("settings-error").textContent, "保存失败示例");
  const network = await setup({ probe: () => { throw new Error("synthetic-provider-private-payload"); } });
  await network.click("settings-model-test");
  assert.equal(network.get("settings-model-test-result").dataset.state, "error");
  assert.match(network.get("settings-model-test-result").textContent, /测试失败/);
  assert.doesNotMatch(network.get("settings-model-test-result").textContent, /synthetic-provider-private-payload/);
  assert.equal(network.get("settings-error").hidden, true);
});

test("修改主模型配置或快捷地址清除旧测试结果，Jev 修改不影响结果", async () => {
  const ui = await setup();
  await ui.click("settings-model-test");
  const result = ui.get("settings-model-test-result").textContent;
  await ui.input("settings-jev-model", "new-jev");
  await ui.input("settings-jev-key", "synthetic-jev-key");
  await ui.click("settings-clear-jev");
  assert.equal(ui.get("settings-model-test-result").textContent, result);
  assert.equal(ui.get("settings-model-test-result").hidden, false);
  for (const [id, value] of [["settings-chat-url", "https://new.example.test/v1/chat/completions"], ["settings-model", "next-model"], ["settings-api-key", "synthetic-next-key"]]) {
    await ui.input(id, value);
    assert.equal(ui.get("settings-model-test-result").hidden, true, id);
    await ui.click("settings-model-test");
    assert.equal(ui.get("settings-model-test-result").hidden, false);
  }
  await ui.click("settings-use-mimo");
  assert.equal(ui.get("settings-model-test-result").hidden, true);
});

test("保存成功清除测试结果，保存失败保留结果", async () => {
  for (const success of [true, false]) {
    const ui = await setup({ save: (body) => success ? Response.json(settings({ ...body })) : Response.json({ error: "保存失败" }, { status: 400 }) });
    await ui.input("settings-model", "draft-model");
    await ui.click("settings-model-test");
    assert.equal(ui.get("settings-model-test-result").hidden, false);
    await ui.submit();
    assert.equal(ui.get("settings-model-test-result").hidden, success);
  }
});

test("读取设置期间两个测试均不可用，Jev 测试不要求主模型已配置", async () => {
  const pending = deferred(), ui = await setup({ load: () => pending.promise });
  assert.equal(ui.get("settings-model-test").disabled, true);
  assert.equal(ui.get("settings-jev-test").disabled, true);
  await ui.click("settings-jev-test");
  assert.equal(ui.requests.length, 1);
  pending.resolve(Response.json(settings({ chatUrl: "", model: "", llmConfigured: false }))); await settle();
  assert.equal(ui.get("settings-jev-test").disabled, false);
  await ui.click("settings-jev-test");
  assert.equal(ui.get("settings-jev-test-result").dataset.state, "success");
  assert.match(ui.get("settings-jev-test-result").textContent, /连接成功.*jev.*80/);
});

test("Jev 测试使用当前草稿且不发送主模型字段，不保存或清空输入", async () => {
  const ui = await setup();
  await ui.input("settings-model", "unsaved-main-model");
  await ui.input("settings-jev-model", "  unsaved-jev  ");
  await ui.input("settings-jev-key", "  synthetic-new-jev-key  ");
  await ui.click("settings-jev-test");
  assert.equal(ui.requests.at(-1).path, "/api/settings/test-jev");
  assert.deepEqual(ui.requests.at(-1).body, { jevModel: "unsaved-jev", jevApiKey: "synthetic-new-jev-key" });
  assert.equal(ui.requests.filter((request) => request.path === "/api/settings" && request.body).length, 0);
  assert.equal(ui.get("settings-jev-key").value, "  synthetic-new-jev-key  ");
  assert.equal(ui.get("settings-jev-model").value, "  unsaved-jev  ");
  assert.equal(ui.get("settings-model").value, "unsaved-main-model");
  assert.match(ui.get("settings-jev-test-result").textContent, /连接成功.*unsaved-jev/);
});

test("Jev 留空 Key 省略字段，清除选择和新 Key 按当前草稿发送", async () => {
  const ui = await setup();
  await ui.click("settings-jev-test");
  assert.deepEqual(ui.requests.at(-1).body, { jevModel: "jev" });
  await ui.click("settings-clear-jev"); await ui.click("settings-jev-test");
  assert.deepEqual(ui.requests.at(-1).body, { jevModel: "jev", clear: ["jevApiKey"] });
  assert.equal(ui.get("settings-clear-jev").textContent, "撤销清除");
  await ui.input("settings-jev-key", "  synthetic-replacement-key  "); await ui.click("settings-jev-test");
  assert.deepEqual(ui.requests.at(-1).body, { jevModel: "jev", jevApiKey: "synthetic-replacement-key" });
  await ui.click("settings-clear-jev"); await ui.click("settings-jev-test");
  assert.deepEqual(ui.requests.at(-1).body, { jevModel: "jev" });
  assert.equal(ui.get("settings-clear-jev").textContent, "清除此 Key");
});

test("Jev 测试锁定表单与另一个测试，仅显示当前测试取消按钮", async () => {
  const pending = deferred(), ui = await setup({ probeJev: () => pending.promise });
  await ui.click("settings-model-test");
  const modelResult = ui.get("settings-model-test-result").textContent;
  const running = ui.click("settings-jev-test"); await settle();
  for (const id of ["settings-chat-url", "settings-model", "settings-api-key", "settings-jev-model", "settings-jev-key", "settings-save", "settings-model-test", "settings-jev-test"])
    assert.equal(ui.get(id).disabled, true, id);
  assert.equal(ui.get("settings-jev-test").textContent, "测试中…");
  assert.equal(ui.get("settings-model-test").textContent, "测试连接");
  assert.equal(ui.get("settings-jev-test-cancel").hidden, false);
  assert.equal(ui.get("settings-jev-test-cancel").disabled, false);
  assert.equal(ui.get("settings-model-test-cancel").hidden, true);
  assert.equal(ui.get("settings-model-test-cancel").disabled, true);
  assert.equal(ui.get("settings-model-test-result").textContent, modelResult);
  await ui.click("settings-model-test"); await ui.click("settings-jev-test"); await ui.submit();
  assert.equal(ui.requests.filter((request) => request.body).length, 2);
  pending.resolve(Response.json({ ok: true, model: "jev", latencyMs: 55 })); await running; await settle();
  assert.equal(ui.get("settings-jev-test").disabled, false);
  assert.equal(ui.get("settings-model-test").disabled, false);
  assert.equal(ui.get("settings-jev-test-cancel").hidden, true);
});

test("主模型测试和保存期间均不能发起 Jev 测试", async () => {
  const pendingModel = deferred(), pendingSave = deferred();
  const ui = await setup({ probe: () => pendingModel.promise, save: () => pendingSave.promise });
  const runningModel = ui.click("settings-model-test"); await settle();
  assert.equal(ui.get("settings-jev-test").disabled, true);
  assert.equal(ui.get("settings-jev-test-cancel").hidden, true);
  await ui.click("settings-jev-test");
  assert.equal(ui.requests.filter((request) => request.path === "/api/settings/test-jev").length, 0);
  pendingModel.resolve(Response.json({ ok: true, model: "old-model", latencyMs: 1 })); await runningModel; await settle();
  await ui.input("settings-model", "saved-model");
  const runningSave = ui.submit(); await settle();
  assert.equal(ui.get("settings-jev-test").disabled, true);
  await ui.click("settings-jev-test");
  assert.equal(ui.requests.filter((request) => request.path === "/api/settings/test-jev").length, 0);
  pendingSave.resolve(Response.json(settings({ model: "saved-model" }))); await runningSave;
  assert.equal(ui.get("settings-jev-test").disabled, false);
});

test("两类配置只清除各自结果，Jev 清除和撤销操作也清除 Jev 结果", async () => {
  const ui = await setup();
  await ui.click("settings-model-test"); await ui.click("settings-jev-test");
  const modelResult = ui.get("settings-model-test-result").textContent;
  for (const [id, value] of [["settings-jev-model", "next-jev"], ["settings-jev-key", "synthetic-next-jev-key"]]) {
    await ui.input(id, value);
    assert.equal(ui.get("settings-jev-test-result").hidden, true, id);
    assert.equal(ui.get("settings-model-test-result").textContent, modelResult);
    assert.equal(ui.get("settings-model-test-result").hidden, false);
    await ui.click("settings-jev-test");
  }
  for (let toggle = 0; toggle < 2; toggle++) {
    await ui.click("settings-clear-jev");
    assert.equal(ui.get("settings-jev-test-result").hidden, true);
    assert.equal(ui.get("settings-model-test-result").textContent, modelResult);
    await ui.click("settings-jev-test");
  }
  const jevResult = ui.get("settings-jev-test-result").textContent;
  await ui.input("settings-model", "next-main-model");
  assert.equal(ui.get("settings-model-test-result").hidden, true);
  assert.equal(ui.get("settings-jev-test-result").hidden, false);
  assert.equal(ui.get("settings-jev-test-result").textContent, jevResult);
  await ui.click("settings-use-mimo");
  assert.equal(ui.get("settings-jev-test-result").textContent, jevResult);
});

test("取消后跨类型重测，旧成功不能覆盖新类型结果或解除其锁定", async () => {
  for (const first of ["model", "jev"]) {
    const second = first === "model" ? "jev" : "model", pending = deferred(), next = deferred();
    const ui = await setup({ probe: () => first === "model" ? pending.promise : next.promise,
      probeJev: () => first === "jev" ? pending.promise : next.promise });
    await ui.input("settings-jev-key", "synthetic-unsaved-jev-key");
    const oldRun = ui.click(`settings-${first}-test`); await settle();
    const signal = ui.requests.at(-1).signal;
    await ui.click(`settings-${first}-test-cancel`);
    assert.equal(signal.aborted, true);
    assert.equal(ui.get(`settings-${first}-test-result`).dataset.state, "cancelled");
    const cancelled = ui.get(`settings-${first}-test-result`).textContent;
    const nextRun = ui.click(`settings-${second}-test`); await settle();
    pending.resolve(Response.json({ ok: true, model: "late-old-model", latencyMs: 9000 })); await oldRun; await settle();
    assert.equal(ui.get(`settings-${first}-test-result`).textContent, cancelled);
    assert.equal(ui.get(`settings-${second}-test-result`).dataset.state, "testing");
    assert.equal(ui.get(`settings-${second}-test`).disabled, true);
    assert.equal(ui.get(`settings-${second}-test-cancel`).hidden, false);
    assert.equal(ui.get("settings-jev-key").value, "synthetic-unsaved-jev-key");
    next.resolve(Response.json({ ok: true, model: "new-result", latencyMs: 20 })); await nextRun; await settle();
    assert.equal(ui.get(`settings-${second}-test-result`).dataset.state, "success");
    assert.match(ui.get(`settings-${second}-test-result`).textContent, /new-result/);
  }
});

test("离开设置取消 Jev 测试，迟到错误不影响另一类结果和保存错误", async () => {
  const pending = deferred(), ui = await setup({ probeJev: () => pending.promise,
    save: () => Response.json({ error: "保存错误示例" }, { status: 400 }) });
  await ui.input("settings-model", "unsaved-main"); await ui.submit();
  await ui.click("settings-model-test");
  const modelResult = ui.get("settings-model-test-result").textContent;
  const running = ui.click("settings-jev-test"); await settle();
  const signal = ui.requests.at(-1).signal;
  await ui.route("chat");
  assert.equal(signal.aborted, true);
  assert.equal(ui.get("settings-jev-test-result").dataset.state, "cancelled");
  const cancelled = ui.get("settings-jev-test-result").textContent;
  pending.reject(new Error("synthetic-private-jev-payload")); await running; await settle();
  await ui.route("settings"); await settle();
  assert.equal(ui.get("settings-model-test-result").textContent, modelResult);
  assert.equal(ui.get("settings-jev-test-result").textContent, cancelled);
  assert.equal(ui.get("settings-error").textContent, "保存错误示例");
});

test("Jev 测试失败独立展示且不暴露网络异常，保存成功清除两类结果", async () => {
  let probes = 0;
  const ui = await setup({ probeJev: () => {
    if (++probes === 1) return Response.json({ error: "Jev 认证失败" }, { status: 502 });
    throw new Error("synthetic-private-jev-payload");
  } });
  await ui.input("settings-model", "draft-main"); await ui.click("settings-model-test");
  const modelResult = ui.get("settings-model-test-result").textContent;
  await ui.click("settings-jev-test");
  assert.equal(ui.get("settings-jev-test-result").dataset.state, "error");
  assert.match(ui.get("settings-jev-test-result").textContent, /测试失败.*Jev 认证失败/);
  assert.equal(ui.get("settings-model-test-result").textContent, modelResult);
  await ui.click("settings-jev-test");
  assert.match(ui.get("settings-jev-test-result").textContent, /测试失败/);
  assert.doesNotMatch(ui.get("settings-jev-test-result").textContent, /synthetic-private-jev-payload/);
  assert.equal(ui.get("settings-error").hidden, true);
  await ui.submit();
  assert.equal(ui.get("settings-model-test-result").hidden, true);
  assert.equal(ui.get("settings-jev-test-result").hidden, true);
});
