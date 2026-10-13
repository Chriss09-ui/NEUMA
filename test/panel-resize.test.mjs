import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../public/panel-resize.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const VARIABLE = "--test-panel-width", STORAGE_KEY = "test-panel-width";

function setup({ defaultWidth = 208, minWidth = 160, maxWidth = 360, availableMax = maxWidth,
  stored, enabled = true, collapsed = false, collapsedWidth = 40,
  observer = true, storageBlocked = false, handleRect = { top: 0, height: 900 } } = {}) {
  class Events {
    listeners = new Map();
    addEventListener(type, callback, options = {}) {
      if (options.signal?.aborted) return;
      const callbacks = this.listeners.get(type) ?? new Set(); callbacks.add(callback); this.listeners.set(type, callbacks);
      options.signal?.addEventListener("abort", () => this.removeEventListener(type, callback), { once: true });
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    dispatchEvent(event) { for (const callback of [...(this.listeners.get(event.type) ?? [])]) callback(event); }
    listenerCount() { return [...this.listeners.values()].reduce((count, callbacks) => count + callbacks.size, 0); }
  }
  const makeClasses = () => {
    const names = new Set();
    return { add: (...values) => values.forEach((value) => names.add(value)),
      remove: (...values) => values.forEach((value) => names.delete(value)),
      toggle: (value, active) => active ? names.add(value) : names.delete(value), contains: (value) => names.has(value) };
  };
  let clock = 0;
  const properties = new Map(), attributes = new Map(), captures = new Set(), writes = [], releases = [], observations = [], collapses = [], expands = [], callbacks = [];
  const layout = new Events(); layout.classList = makeClasses();
  layout.style = { setProperty: (key, value) => properties.set(key, String(value)), getPropertyValue: (key) => properties.get(key) ?? "",
    removeProperty: (key) => properties.delete(key) };
  layout.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1280, bottom: 900, width: 1280, height: 900 });
  const document = { activeElement: null, getElementById: () => null, body: { style: {}, classList: makeClasses() }, documentElement: { style: {} } };
  const handleProperties = new Map();
  const handle = new Events(); handle.classList = makeClasses(); handle.inert = false;
  handle.style = { setProperty: (key, value) => handleProperties.set(key, String(value)), getPropertyValue: (key) => handleProperties.get(key) ?? "",
    removeProperty: (key) => handleProperties.delete(key) };
  handle.getBoundingClientRect = () => ({ left: 396, width: 8, ...handleRect, bottom: handleRect.top + handleRect.height });
  handle.setAttribute = (key, value) => attributes.set(key, String(value));
  handle.getAttribute = (key) => attributes.get(key) ?? null;
  handle.removeAttribute = (key) => attributes.delete(key);
  Object.defineProperty(handle, "tabIndex", { get: () => Number(attributes.get("tabindex") ?? 0),
    set: (value) => attributes.set("tabindex", String(value)) });
  handle.setPointerCapture = (id) => captures.add(id);
  handle.hasPointerCapture = (id) => captures.has(id);
  handle.releasePointerCapture = (id) => { captures.delete(id); releases.push(id); };
  handle.focus = () => { document.activeElement = handle; handle.dispatchEvent({ type: "focus" }); };
  const watchTarget = new Events(); watchTarget.classList = makeClasses(); watchTarget.getBoundingClientRect = layout.getBoundingClientRect;
  const values = new Map(stored === undefined ? [] : [[STORAGE_KEY, String(stored)]]);
  const storage = { getItem(key) { if (storageBlocked) throw new Error("Storage unavailable"); return values.get(key) ?? null; },
    setItem(key, value) { writes.push({ key, value: String(value) }); if (storageBlocked) throw new Error("Storage unavailable"); values.set(key, String(value)); } };
  const windowRef = new Events(); windowRef.localStorage = storage; windowRef.performance = { now: () => clock };
  windowRef.innerWidth = 1280; windowRef.innerHeight = 900; windowRef.document = document;
  windowRef.getComputedStyle = () => ({ columnGap: "0px" });
  const makeObserver = (kind) => class {
    constructor(callback) { this.callback = callback; this.kind = kind; this.targets = []; this.disconnected = false; observations.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  };
  if (observer) { windowRef.ResizeObserver = makeObserver("resize"); windowRef.MutationObserver = makeObserver("mutation"); }
  const context = vm.createContext({ window: windowRef, document, AbortController,
    ...(observer ? { ResizeObserver: windowRef.ResizeObserver, MutationObserver: windowRef.MutationObserver } : {}) });
  vm.runInContext(source, context);
  assert.equal(typeof context.initPanelResize, "function", "panel-resize.js 应导出 initPanelResize");
  const applied = () => Number.parseFloat(layout.style.getPropertyValue(VARIABLE));
  const callbackState = () => ({ width: applied(), captured: handle.hasPointerCapture(7),
    resizing: layout.classList.contains("is-panel-resizing") });
  const rememberCallback = (kind, state) => callbacks.push({ kind, ...state, revealing: layout.classList.contains("is-panel-revealing") });
  const controller = context.initPanelResize({ layout, handle, variable: VARIABLE, storageKey: STORAGE_KEY, label: "测试栏",
    defaultWidth, minWidth, maxWidth, getMax: () => availableMax, isEnabled: () => enabled, isCollapsed: () => collapsed,
    collapsedWidth, windowRef, storage, now: () => clock, watch: [watchTarget],
    collapse() { const state = callbackState(); collapsed = true; collapses.push(state); rememberCallback("collapse", state); },
    expand() { const state = callbackState(); collapsed = false; expands.push(state); rememberCallback("expand", state); } });
  const emit = (type, fields = {}, target = handle) => {
    const event = { type, button: 0, isPrimary: true, pointerId: 7, clientX: 400, clientY: 350, shiftKey: false, timeStamp: clock, ...fields,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; } };
    if (type === "lostpointercapture") captures.delete(event.pointerId);
    target.dispatchEvent(event); if (target !== windowRef && !event.propagationStopped) windowRef.dispatchEvent(event); return event;
  };
  const notify = () => {
    if (observer) { for (const item of observations) if (!item.disconnected) item.callback([{ target: layout }]); }
    else windowRef.dispatchEvent({ type: "resize" });
  };
  return { controller, layout, handle, windowRef, watchTarget, document, values, writes, releases, observations, collapses, expands, callbacks, emit, applied, notify,
    grip: () => handle.style.getPropertyValue("--panel-grip-y") || "50%", setRect: (value) => { handleRect = { ...handleRect, ...value }; },
    time: (value) => { clock = value; }, setMax: (value) => { availableMax = value; notify(); },
    setEnabled: (value) => { enabled = value; controller.refresh(); },
    setCollapsed: (value) => { collapsed = value; notify(); }, collapsed: () => collapsed };
}

test("列宽默认值与存储偏好更新可访问范围，初始化不保存", () => {
  const ui = setup();
  assert.equal(ui.applied(), 208); assert.equal(ui.writes.length, 0);
  assert.equal(ui.handle.getAttribute("role"), "separator"); assert.equal(ui.handle.getAttribute("aria-orientation"), "vertical");
  assert.equal(ui.handle.getAttribute("aria-valuemin"), "160"); assert.equal(ui.handle.getAttribute("aria-valuemax"), "360");
  assert.equal(ui.handle.getAttribute("aria-valuenow"), "208");
  assert.equal(ui.handle.getAttribute("aria-hidden"), "false"); assert.equal(ui.handle.inert, false); assert.equal(ui.handle.tabIndex, 0);
  const navigation = setup({ defaultWidth: 232, minWidth: 175, maxWidth: 320 });
  assert.equal(navigation.applied(), 232); assert.equal(navigation.handle.getAttribute("aria-valuemin"), "175");
  assert.equal(navigation.handle.getAttribute("aria-valuemax"), "320");
});

test("手柄纵向跟随悬停并夹紧边缘，滚动与刷新重算相对坐标，离开后键盘焦点使用中心", () => {
  const ui = setup({ handleRect: { top: 100, height: 300 } });
  assert.equal(ui.grip(), "50%"); ui.handle.focus(); assert.equal(ui.grip(), "50%");
  ui.emit("pointerenter", { clientY: 160 }); assert.equal(ui.grip(), "60px");
  ui.emit("pointermove", { clientY: 250 }); assert.equal(ui.grip(), "150px");
  ui.emit("pointermove", { clientY: 90 }); assert.equal(ui.grip(), "14px");
  ui.emit("pointermove", { clientY: 410 }); assert.equal(ui.grip(), "286px");
  ui.emit("pointermove", { clientY: 250 });
  ui.setRect({ top: 120 }); ui.emit("scroll", {}, ui.windowRef); assert.equal(ui.grip(), "130px");
  ui.setRect({ top: 150 }); ui.controller.refresh(); assert.equal(ui.grip(), "100px");
  ui.emit("pointerleave"); assert.equal(ui.grip(), "50%");
  assert.equal(ui.document.activeElement, ui.handle);
  assert.equal(ui.applied(), 208); assert.equal(ui.writes.length, 0);
});

test("活动拖拽保留并更新纵向手柄，忽略其他指针，禁用与释放监听后不再跟随", () => {
  const ui = setup({ handleRect: { top: 100, height: 300 } });
  ui.emit("pointerdown", { clientY: 170 }); assert.equal(ui.grip(), "70px");
  ui.emit("pointerleave"); assert.equal(ui.grip(), "70px");
  ui.emit("pointermove", { pointerId: 9, clientX: 500, clientY: 290 }, ui.windowRef); assert.equal(ui.grip(), "70px");
  ui.emit("pointermove", { clientX: 410, clientY: 230 }, ui.windowRef);
  assert.equal(ui.grip(), "130px"); assert.equal(ui.applied(), 218);
  ui.setEnabled(false); const disabledPosition = ui.grip();
  assert.equal(ui.handle.hasPointerCapture(7), false);
  ui.emit("pointerenter", { clientY: 200 }); ui.emit("pointermove", { clientY: 250 });
  assert.equal(ui.grip(), disabledPosition); assert.equal(ui.applied(), 208);
  ui.setEnabled(true); ui.emit("pointerenter", { clientY: 200 }); assert.equal(ui.grip(), "100px");
  ui.controller.dispose(); const disposedPosition = ui.grip();
  ui.emit("pointerenter", { clientY: 300 }); ui.emit("pointermove", { clientY: 350 });
  ui.setRect({ top: 150 }); ui.emit("scroll", {}, ui.windowRef); ui.notify();
  assert.equal(ui.grip(), disposedPosition);
  assert.equal(ui.handle.listenerCount(), 0); assert.equal(ui.windowRef.listenerCount(), 0); assert.equal(ui.writes.length, 0);
});

test("空间变化只夹紧显示宽度，空间恢复后还原偏好且不改存储", () => {
  const ui = setup({ stored: 340, availableMax: 220 });
  assert.equal(ui.applied(), 220); assert.equal(ui.values.get(STORAGE_KEY), "340");
  assert.equal(ui.handle.getAttribute("aria-valuemax"), "220");
  ui.setMax(180); assert.equal(ui.applied(), 180);
  ui.setMax(360); assert.equal(ui.applied(), 340); assert.equal(ui.writes.length, 0);
  ui.setMax(120); assert.ok(ui.applied() <= 120);
  assert.ok(Number(ui.handle.getAttribute("aria-valuemin")) <= Number(ui.handle.getAttribute("aria-valuemax")));
  ui.setMax(360); assert.equal(ui.applied(), 340); assert.equal(ui.values.get(STORAGE_KEY), "340");
});

test("已展开无横向位移的纵向移动不保存夹紧宽度，空间恢复仍还原偏好", () => {
  const ui = setup({ stored: 340, availableMax: 220 }); ui.emit("pointerdown");
  for (const clientY of [400, 500, 500]) {
    ui.emit("pointermove", { clientX: 400, clientY }, ui.windowRef);
    assert.equal(ui.applied(), 220); assert.equal(ui.writes.length, 0);
  }
  ui.emit("pointerup", { clientX: 400, clientY: 500 }, ui.windowRef);
  assert.equal(ui.writes.length, 0); assert.equal(ui.values.get(STORAGE_KEY), "340");
  assert.equal(ui.handle.hasPointerCapture(7), false); assert.equal(ui.layout.classList.contains("is-panel-resizing"), false);
  ui.setMax(360); assert.equal(ui.applied(), 340); assert.equal(ui.collapses.length, 0);
});

test("已展开无横向位移时仅按下和释放不保存夹紧宽度或丢失偏好", () => {
  const ui = setup({ stored: 340, availableMax: 220 }); ui.emit("pointerdown");
  ui.emit("pointerup", {}, ui.windowRef);
  assert.equal(ui.applied(), 220); assert.equal(ui.writes.length, 0); assert.equal(ui.values.get(STORAGE_KEY), "340");
  assert.equal(ui.handle.hasPointerCapture(7), false); assert.equal(ui.layout.classList.contains("is-panel-resizing"), false);
  ui.setMax(360); assert.equal(ui.applied(), 340);
});

test("已展开无横向位移时最小宽度的纯纵向移动不保存或折叠", () => {
  const ui = setup({ stored: 160 }); assert.equal(ui.applied(), 160);
  ui.emit("pointerdown"); ui.emit("pointermove", { clientX: 400, clientY: 500 }, ui.windowRef);
  ui.time(500); ui.emit("pointermove", { clientX: 400, clientY: 600 }, ui.windowRef);
  ui.emit("pointerup", { clientX: 400, clientY: 600 }, ui.windowRef);
  assert.equal(ui.applied(), 160); assert.equal(ui.writes.length, 0); assert.equal(ui.values.get(STORAGE_KEY), "160");
  assert.equal(ui.collapsed(), false); assert.equal(ui.collapses.length, 0); assert.equal(ui.handle.hasPointerCapture(7), false);
});

test("已保存最小宽度从按下等待350ms，轻微左移抖动不足24px不会折叠", () => {
  const ui = setup({ stored: 160 }); ui.emit("pointerdown");
  ui.time(349); ui.emit("pointermove", { clientX: 399 }, ui.windowRef); assert.equal(ui.collapses.length, 0);
  ui.time(350); ui.emit("pointermove", { clientX: 398 }, ui.windowRef); assert.equal(ui.collapses.length, 0);
  ui.time(500); ui.emit("pointermove", { clientX: 398 }, ui.windowRef);
  ui.emit("pointermove", { clientX: 398, clientY: 600 }, ui.windowRef); assert.equal(ui.collapses.length, 0);
  ui.emit("pointermove", { clientX: 376, clientY: 600 }, ui.windowRef); assert.equal(ui.collapses.length, 0);
  ui.emit("pointermove", { clientX: 375, clientY: 600 }, ui.windowRef);
  assert.equal(ui.collapsed(), true); assert.equal(ui.collapses.length, 1); assert.equal(ui.writes.length, 0);
});

test("主指针在窗口中实时拖动，忽略其他按钮和指针，释放才保存", () => {
  const ui = setup();
  ui.emit("pointerdown", { button: 2 }); ui.emit("pointermove", { clientX: 500 }, ui.windowRef);
  ui.emit("pointerdown", { isPrimary: false }); assert.equal(ui.applied(), 208); assert.equal(ui.handle.hasPointerCapture(7), false);
  ui.emit("pointerdown"); assert.equal(ui.handle.hasPointerCapture(7), true); assert.equal(ui.document.activeElement, ui.handle);
  assert.equal(ui.layout.classList.contains("is-panel-resizing"), true);
  ui.emit("pointermove", { pointerId: 9, clientX: 700 }, ui.windowRef); assert.equal(ui.applied(), 208);
  ui.emit("pointermove", { clientX: 900 }, ui.windowRef); assert.equal(ui.applied(), 360);
  ui.emit("pointermove", { clientX: 450 }, ui.windowRef); assert.equal(ui.applied(), 258); assert.equal(ui.writes.length, 0);
  ui.emit("pointerup", { clientX: 450 }, ui.windowRef);
  assert.equal(ui.handle.hasPointerCapture(7), false); assert.equal(ui.layout.classList.contains("is-panel-resizing"), false);
  assert.deepEqual(ui.writes, [{ key: STORAGE_KEY, value: "258" }]);
});

test("到最小值释放只保存最小宽度，不折叠", () => {
  const ui = setup({ stored: 300 });
  ui.emit("pointerdown"); ui.emit("pointermove", { clientX: 260 }, ui.windowRef);
  assert.equal(ui.applied(), 160); assert.equal(ui.handle.classList.contains("at-minimum"), true);
  ui.time(500); ui.emit("pointerup", { clientX: 260 }, ui.windowRef);
  assert.equal(ui.collapses.length, 0); assert.deepEqual(ui.writes, [{ key: STORAGE_KEY, value: "160" }]);
});

test("最小值等待350ms前的大幅越界不计入后续24px，折叠回调前恢复偏好并清除拖拽", () => {
  const ui = setup({ stored: 300 });
  ui.emit("pointerdown"); ui.emit("pointermove", { clientX: 260 }, ui.windowRef);
  ui.time(349); ui.emit("pointermove", { clientX: 210 }, ui.windowRef); assert.equal(ui.collapses.length, 0);
  ui.time(350); ui.emit("pointermove", { clientX: 187 }, ui.windowRef); assert.equal(ui.collapses.length, 0);
  ui.emit("pointermove", { clientX: 186 }, ui.windowRef);
  assert.deepEqual(ui.collapses, [{ width: 300, captured: false, resizing: false }]);
  assert.equal(ui.values.get(STORAGE_KEY), "300"); assert.equal(ui.writes.length, 0);
  ui.emit("pointermove", { clientX: 200 }, ui.windowRef); ui.emit("pointerup", { clientX: 200 }, ui.windowRef);
  assert.equal(ui.collapses.length, 1); assert.equal(ui.writes.length, 0); assert.equal(ui.applied(), 300);
  ui.setCollapsed(false); assert.equal(ui.applied(), 300);
});

test("首次大幅越界、停顿、重复或纯纵向移动与释放都不会自动折叠", () => {
  const ui = setup({ stored: 300 });
  ui.emit("pointerdown"); ui.emit("pointermove", { clientX: 190 }, ui.windowRef);
  assert.equal(ui.applied(), 160); assert.equal(ui.collapses.length, 0);
  ui.time(500); assert.equal(ui.collapses.length, 0);
  ui.emit("pointermove", { clientX: 190 }, ui.windowRef); assert.equal(ui.collapses.length, 0);
  ui.emit("pointermove", { clientX: 190, clientY: 600 }, ui.windowRef); assert.equal(ui.collapses.length, 0);
  ui.emit("pointerup", { clientX: 190, clientY: 600 }, ui.windowRef);
  assert.equal(ui.collapses.length, 0); assert.equal(ui.applied(), 160);
});

test("最小边界消耗越界距离，向右1px立即调宽并清空累计拉动，回到最小重新等待", () => {
  const ui = setup({ stored: 300 });
  ui.emit("pointerdown"); ui.emit("pointermove", { clientX: 190 }, ui.windowRef); assert.equal(ui.applied(), 160);
  ui.time(350); ui.emit("pointermove", { clientX: 178 }, ui.windowRef); assert.equal(ui.collapses.length, 0);
  ui.emit("pointermove", { clientX: 179 }, ui.windowRef);
  assert.equal(ui.applied(), 161); assert.equal(ui.collapses.length, 0);
  ui.time(600); ui.emit("pointermove", { clientX: 178 }, ui.windowRef); assert.equal(ui.applied(), 160);
  ui.time(949); ui.emit("pointermove", { clientX: 160 }, ui.windowRef); assert.equal(ui.collapses.length, 0);
  ui.time(950); ui.emit("pointermove", { clientX: 148 }, ui.windowRef); assert.equal(ui.collapses.length, 0);
  ui.emit("pointermove", { clientX: 137 }, ui.windowRef); assert.equal(ui.collapses.length, 0);
  ui.emit("pointermove", { clientX: 136 }, ui.windowRef); assert.equal(ui.collapses.length, 1);
});

test("取消、丢失capture、失焦和Escape都回滚且清除折叠暂停状态", () => {
  for (const kind of ["pointercancel", "lostpointercapture", "blur", "Escape", "cancel"]) {
    const ui = setup({ stored: 300 });
    ui.emit("pointerdown"); ui.emit("pointermove", { clientX: 260 }, ui.windowRef);
    ui.time(350); ui.emit("pointermove", { clientX: 248 }, ui.windowRef); ui.time(500);
    if (kind === "Escape") ui.emit("keydown", { key: "Escape" });
    else if (kind === "cancel") ui.controller.cancel();
    else ui.emit(kind, {}, kind === "lostpointercapture" ? ui.handle : ui.windowRef);
    assert.equal(ui.applied(), 300, kind); assert.equal(ui.writes.length, 0, kind);
    assert.equal(ui.handle.hasPointerCapture(7), false, kind); assert.equal(ui.layout.classList.contains("is-panel-resizing"), false, kind);
    ui.emit("pointerdown"); ui.emit("pointermove", { clientX: 190 }, ui.windowRef);
    assert.equal(ui.collapses.length, 0, `${kind} 后的新拖动必须重新暂停`);
    ui.time(850); ui.emit("pointermove", { clientX: 178 }, ui.windowRef);
    assert.equal(ui.collapses.length, 0, `${kind} 前的累计拉动不能进入新拖动`); ui.controller.cancel();
  }
});

test("禁用取消活动拖拽并移除键盘入口，恢复后仍使用原偏好", () => {
  const ui = setup({ stored: 300 });
  ui.emit("pointerdown"); ui.emit("pointermove", { clientX: 440 }, ui.windowRef); assert.equal(ui.applied(), 340);
  ui.setEnabled(false);
  assert.equal(ui.applied(), 300); assert.equal(ui.handle.hasPointerCapture(7), false); assert.equal(ui.writes.length, 0);
  assert.equal(ui.handle.getAttribute("aria-hidden"), "true"); assert.equal(ui.handle.inert, true); assert.equal(ui.handle.tabIndex, -1);
  ui.emit("pointerup", {}, ui.windowRef); ui.emit("pointerdown"); ui.emit("pointermove", { clientX: 700 }, ui.windowRef);
  ui.emit("keydown", { key: "End" }); ui.emit("dblclick");
  assert.equal(ui.applied(), 300); assert.equal(ui.writes.length, 0); assert.equal(ui.collapses.length, 0);
  ui.setEnabled(true); assert.equal(ui.applied(), 300); assert.equal(ui.handle.inert, false); assert.equal(ui.handle.tabIndex, 0);
  assert.equal(ui.handle.getAttribute("aria-hidden"), "false");
});

test("键盘按16或48px调宽，Home/End到边界，最小处左键不折叠", () => {
  const ui = setup();
  assert.equal(ui.emit("keydown", { key: "ArrowRight" }).defaultPrevented, true); assert.equal(ui.applied(), 224);
  ui.emit("keydown", { key: "ArrowRight", shiftKey: true }); assert.equal(ui.applied(), 272);
  ui.emit("keydown", { key: "ArrowLeft" }); assert.equal(ui.applied(), 256);
  ui.emit("keydown", { key: "ArrowLeft", shiftKey: true }); assert.equal(ui.applied(), 208);
  ui.emit("keydown", { key: "End" }); assert.equal(ui.applied(), 360);
  ui.emit("keydown", { key: "Home" }); assert.equal(ui.applied(), 160);
  ui.time(500); ui.emit("keydown", { key: "ArrowLeft" }); assert.equal(ui.applied(), 160); assert.equal(ui.collapses.length, 0);
  const count = ui.writes.length; ui.emit("keydown", { key: "Enter" }); assert.equal(ui.writes.length, count);
});

test("双击恢复默认偏好，暂时受空间限制时不把夹紧值存为默认", () => {
  const ui = setup({ stored: 300 }); ui.setMax(180); ui.emit("dblclick");
  assert.equal(ui.applied(), 180); assert.equal(ui.values.get(STORAGE_KEY), "208");
  ui.setMax(360); assert.equal(ui.applied(), 208);
  assert.deepEqual(ui.writes, [{ key: STORAGE_KEY, value: "208" }]);
});

test("dispose回滚半次拖动并清理监听和观察，不保存取消的值", () => {
  const ui = setup({ stored: 300 }); ui.emit("pointerdown"); ui.emit("pointermove", { clientX: 440 }, ui.windowRef);
  assert.equal(ui.applied(), 340); assert.ok(ui.observations.some((item) => item.targets.includes(ui.layout)));
  assert.ok(ui.observations.some((item) => item.targets.includes(ui.watchTarget)));
  ui.controller.dispose(); assert.equal(ui.applied(), 300); assert.equal(ui.writes.length, 0);
  assert.equal(ui.handle.hasPointerCapture(7), false); assert.ok(ui.releases.includes(7));
  assert.equal(ui.handle.listenerCount(), 0); assert.equal(ui.windowRef.listenerCount(), 0);
  assert.equal(ui.observations.every((item) => item.disconnected), true);
  ui.emit("pointermove", { clientX: 500 }, ui.windowRef); ui.emit("pointerup", {}, ui.windowRef);
  ui.emit("keydown", { key: "End" }); ui.emit("dblclick"); ui.setMax(180);
  assert.equal(ui.applied(), 300); assert.equal(ui.writes.length, 0); assert.doesNotThrow(() => ui.controller.dispose());
});

test("没有观察器时窗口resize仍夹紧，dispose后停止响应", () => {
  const ui = setup({ stored: 340, observer: false });
  assert.ok(ui.windowRef.listeners.get("resize")?.size);
  ui.setMax(180); assert.equal(ui.applied(), 180); ui.setMax(360); assert.equal(ui.applied(), 340);
  ui.controller.dispose(); ui.setMax(180); assert.equal(ui.applied(), 340); assert.equal(ui.windowRef.listenerCount(), 0);
});

test("存储不可用或损坏不会阻止交互", () => {
  for (const stored of ["invalid-width", "Infinity"]) assert.equal(setup({ stored }).applied(), 208);
  const ui = setup({ storageBlocked: true }); assert.equal(ui.applied(), 208);
  assert.doesNotThrow(() => ui.emit("keydown", { key: "ArrowRight" })); assert.equal(ui.applied(), 224);
  assert.doesNotThrow(() => ui.emit("dblclick")); assert.equal(ui.applied(), 208);
});

const foldedProfiles = [
  { defaultWidth: 208, minWidth: 160, maxWidth: 360, collapsedWidth: 40, stored: 300 },
  { defaultWidth: 232, minWidth: 175, maxWidth: 320, collapsedWidth: 72, stored: 280 }
];

test("两栏折叠态手柄仍可操作，当前值和最小值显示真实折叠宽度", () => {
  for (const profile of foldedProfiles) {
    const ui = setup({ ...profile, collapsed: true });
    assert.equal(ui.handle.getAttribute("aria-valuenow"), String(profile.collapsedWidth));
    assert.equal(ui.handle.getAttribute("aria-valuemin"), String(profile.collapsedWidth));
    assert.equal(ui.handle.getAttribute("aria-hidden"), "false"); assert.equal(ui.handle.inert, false); assert.equal(ui.handle.tabIndex, 0);
    assert.equal(ui.applied(), profile.stored); assert.equal(ui.writes.length, 0);
  }
});

test("两栏折叠右拉每1px立即预览，零时钟下无死区或动画等待", () => {
  for (const profile of foldedProfiles) {
    const ui = setup({ ...profile, collapsed: true }); ui.emit("pointerdown");
    assert.equal(ui.applied(), profile.collapsedWidth); assert.equal(ui.handle.hasPointerCapture(7), true);
    assert.equal(ui.layout.classList.contains("is-panel-revealing"), true);
    assert.equal(ui.layout.classList.contains("is-panel-resizing"), false);
    for (const distance of [1, 16]) {
      ui.emit("pointermove", { clientX: 400 + distance }, ui.windowRef);
      assert.equal(ui.applied(), profile.collapsedWidth + distance);
      assert.equal(ui.handle.getAttribute("aria-valuenow"), String(profile.collapsedWidth + distance));
      assert.equal(ui.collapsed(), true); assert.equal(ui.expands.length, 0); assert.equal(ui.writes.length, 0);
      ui.notify(); assert.equal(ui.applied(), profile.collapsedWidth + distance); assert.equal(ui.handle.hasPointerCapture(7), true);
    }
    ui.controller.cancel(); assert.equal(ui.applied(), profile.stored);
  }
});

test("不足32px右拉或向左预览后松手回到折叠，不保存宽度", () => {
  for (const profile of foldedProfiles) for (const distance of [31, 0, -20]) {
    const ui = setup({ ...profile, collapsed: true }); ui.emit("pointerdown");
    ui.emit("pointermove", { clientX: 400 + distance }, ui.windowRef);
    assert.equal(ui.applied(), profile.collapsedWidth + Math.max(0, distance));
    assert.equal(ui.collapsed(), true); assert.equal(ui.expands.length, 0);
    ui.emit("pointerup", { clientX: 400 + distance }, ui.windowRef);
    assert.equal(ui.collapsed(), true); assert.equal(ui.applied(), profile.stored); assert.equal(ui.writes.length, 0);
    assert.equal(ui.handle.hasPointerCapture(7), false); assert.equal(ui.layout.classList.contains("is-panel-revealing"), false);
    assert.equal(ui.handle.getAttribute("aria-valuenow"), String(profile.collapsedWidth));
  }
});

test("两栏右拉32px仍实时预览，松手才吸附展开原偏好且不落盘", () => {
  for (const profile of foldedProfiles) {
    const ui = setup({ ...profile, collapsed: true }); ui.emit("pointerdown");
    ui.emit("pointermove", { clientX: 432 }, ui.windowRef);
    assert.equal(ui.applied(), profile.collapsedWidth + 32); assert.equal(ui.collapsed(), true); assert.equal(ui.expands.length, 0);
    ui.emit("pointerup", { clientX: 432 }, ui.windowRef);
    assert.equal(ui.collapsed(), false); assert.equal(ui.expands.length, 1); assert.equal(ui.applied(), profile.stored);
    assert.equal(ui.values.get(STORAGE_KEY), String(profile.stored)); assert.equal(ui.writes.length, 0);
    assert.equal(ui.handle.hasPointerCapture(7), false); assert.equal(ui.layout.classList.contains("is-panel-revealing"), false);
    assert.equal(ui.layout.classList.contains("is-panel-resizing"), false);
    assert.deepEqual([ui.callbacks[0].captured, ui.callbacks[0].resizing, ui.callbacks[0].revealing], [false, false, false]);
  }
});

test("两栏触及可读最小宽度立即展开，恰好最小值松手保留原偏好", () => {
  for (const profile of foldedProfiles) {
    const ui = setup({ ...profile, collapsed: true }); const boundary = 400 + profile.minWidth - profile.collapsedWidth;
    ui.emit("pointerdown"); ui.emit("pointermove", { clientX: boundary }, ui.windowRef);
    assert.equal(ui.collapsed(), false); assert.equal(ui.expands.length, 1); assert.equal(ui.applied(), profile.minWidth);
    assert.equal(ui.handle.getAttribute("aria-valuenow"), String(profile.minWidth));
    assert.equal(ui.layout.classList.contains("is-panel-revealing"), false);
    assert.equal(ui.layout.classList.contains("is-panel-resizing"), true);
    ui.notify(); assert.equal(ui.handle.hasPointerCapture(7), true); assert.equal(ui.applied(), profile.minWidth);
    ui.emit("pointerup", { clientX: boundary }, ui.windowRef);
    assert.equal(ui.applied(), profile.stored); assert.equal(ui.collapsed(), false); assert.equal(ui.writes.length, 0);
    assert.equal(ui.values.get(STORAGE_KEY), String(profile.stored));
  }
});

test("两栏直接跨过最小值后连续增减始终跟随总位移，释放才保存选定宽度", () => {
  for (const profile of foldedProfiles) {
    const ui = setup({ ...profile, collapsed: true }); const boundary = 400 + profile.minWidth - profile.collapsedWidth;
    ui.emit("pointerdown"); ui.emit("pointermove", { clientX: boundary + 80 }, ui.windowRef);
    assert.equal(ui.collapsed(), false); assert.equal(ui.expands.length, 1); assert.equal(ui.applied(), profile.minWidth + 80);
    ui.emit("pointermove", { clientX: boundary + 95 }, ui.windowRef); assert.equal(ui.applied(), profile.minWidth + 95);
    ui.emit("pointermove", { clientX: boundary + 60 }, ui.windowRef); assert.equal(ui.applied(), profile.minWidth + 60);
    assert.equal(ui.writes.length, 0); assert.equal(ui.expands.length, 1);
    ui.emit("pointerup", { clientX: boundary + 60 }, ui.windowRef);
    assert.deepEqual(ui.writes, [{ key: STORAGE_KEY, value: String(profile.minWidth + 60) }]);
    assert.equal(ui.layout.classList.contains("is-panel-resizing"), false); assert.equal(ui.handle.hasPointerCapture(7), false);
  }
});

test("触及最小值后同手势调宽立即生效，不改用存储偏好作为坐标基准", () => {
  const ui = setup({ collapsed: true, stored: 300 }); ui.emit("pointerdown");
  ui.emit("pointermove", { clientX: 520 }, ui.windowRef); assert.equal(ui.applied(), 160);
  ui.emit("pointermove", { clientX: 540 }, ui.windowRef); assert.equal(ui.applied(), 180);
  ui.emit("pointermove", { clientX: 525 }, ui.windowRef); assert.equal(ui.applied(), 165);
  ui.emit("pointerup", { clientX: 525 }, ui.windowRef);
  assert.deepEqual(ui.writes, [{ key: STORAGE_KEY, value: "165" }]); assert.equal(ui.expands.length, 1);
});

test("短拉松手展开时空间夹紧不覆盖原偏好，空间恢复仍还原它", () => {
  const ui = setup({ collapsed: true, stored: 300, availableMax: 220 }); ui.emit("pointerdown");
  ui.emit("pointermove", { clientX: 432 }, ui.windowRef); assert.equal(ui.applied(), 72);
  ui.setMax(180); assert.equal(ui.applied(), 72); assert.equal(ui.collapsed(), true);
  ui.emit("pointerup", { clientX: 432 }, ui.windowRef);
  assert.equal(ui.collapsed(), false); assert.equal(ui.applied(), 180); assert.equal(ui.values.get(STORAGE_KEY), "300");
  assert.equal(ui.writes.length, 0); ui.setMax(360); assert.equal(ui.applied(), 300);
});

test("预览遇到范围变化只夹紧当前指针宽度，空间恢复不会跳到偏好值", () => {
  const ui = setup({ collapsed: true, stored: 300, availableMax: 220 }); ui.emit("pointerdown");
  ui.emit("pointermove", { clientX: 500 }, ui.windowRef); assert.equal(ui.applied(), 140);
  ui.setMax(130); assert.equal(ui.applied(), 130); assert.equal(ui.handle.getAttribute("aria-valuenow"), "130");
  assert.equal(ui.collapsed(), true); assert.equal(ui.expands.length, 0);
  ui.setMax(360); assert.equal(ui.applied(), 140); assert.equal(ui.handle.getAttribute("aria-valuenow"), "140");
  assert.equal(ui.values.get(STORAGE_KEY), "300"); assert.equal(ui.writes.length, 0);
  ui.emit("pointermove", { clientX: 530 }, ui.windowRef); assert.equal(ui.applied(), 170); assert.equal(ui.collapsed(), false);
  ui.emit("pointerup", { clientX: 530 }, ui.windowRef); assert.equal(ui.values.get(STORAGE_KEY), "170");
});

test("预览和恰好开到最小值后的纯纵向移动不算调宽，不丢被夹紧的偏好", () => {
  for (const clientX of [400, 520]) {
    const ui = setup({ collapsed: true, stored: 300, availableMax: 220 }); ui.emit("pointerdown");
    ui.emit("pointermove", { clientX }, ui.windowRef);
    for (const [time, clientY] of [[0, 400], [500, 500], [1000, 500]]) {
      ui.time(time); ui.emit("pointermove", { clientX, clientY }, ui.windowRef);
      assert.equal(ui.applied(), clientX === 400 ? 40 : 160); assert.equal(ui.writes.length, 0);
    }
    ui.emit("pointerup", { clientX, clientY: 500 }, ui.windowRef);
    assert.equal(ui.collapsed(), clientX === 400); assert.equal(ui.applied(), 220);
    assert.equal(ui.writes.length, 0); assert.equal(ui.values.get(STORAGE_KEY), "300");
    ui.setMax(360); assert.equal(ui.applied(), 300);
  }
});

test("取消预览或实际展开调宽都回到最初折叠偏好，状态回调前清理拖拽", () => {
  for (const phase of ["revealing", "resizing"]) for (const kind of ["pointercancel", "lostpointercapture", "blur", "Escape", "cancel"]) {
    const ui = setup({ collapsed: true, stored: 300 }); ui.emit("pointerdown");
    const clientX = phase === "revealing" ? 416 : 530; ui.emit("pointermove", { clientX }, ui.windowRef);
    assert.equal(ui.collapsed(), phase === "revealing");
    if (kind === "Escape") ui.emit("keydown", { key: "Escape" });
    else if (kind === "cancel") ui.controller.cancel();
    else ui.emit(kind, {}, kind === "lostpointercapture" ? ui.handle : ui.windowRef);
    assert.equal(ui.collapsed(), true, phase + "/" + kind); assert.equal(ui.applied(), 300, phase + "/" + kind);
    assert.equal(ui.values.get(STORAGE_KEY), "300"); assert.equal(ui.writes.length, 0);
    assert.equal(ui.handle.hasPointerCapture(7), false); assert.equal(ui.layout.classList.contains("is-panel-revealing"), false);
    assert.equal(ui.layout.classList.contains("is-panel-resizing"), false);
    if (phase === "resizing") {
      const rollback = ui.callbacks.at(-1); assert.equal(rollback.kind, "collapse");
      assert.deepEqual([rollback.captured, rollback.resizing, rollback.revealing], [false, false, false]);
      assert.equal(ui.expands.length, 1); assert.equal(ui.collapses.length, 1);
    } else assert.equal(ui.callbacks.length, 0);
    ui.emit("pointerup", { clientX }, ui.windowRef); assert.equal(ui.writes.length, 0);
  }
});

test("同一手势即时拉出再等待350ms拉动24px只折叠一次，不保存途中宽度", () => {
  const ui = setup({ collapsed: true, stored: 300 }); ui.emit("pointerdown");
  ui.emit("pointermove", { clientX: 530 }, ui.windowRef); assert.equal(ui.applied(), 170); assert.equal(ui.expands.length, 1);
  ui.emit("pointermove", { clientX: 520 }, ui.windowRef); assert.equal(ui.applied(), 160);
  ui.time(349); ui.emit("pointermove", { clientX: 488 }, ui.windowRef); assert.equal(ui.collapses.length, 0);
  ui.time(350); ui.emit("pointermove", { clientX: 465 }, ui.windowRef); assert.equal(ui.collapses.length, 0);
  ui.emit("pointermove", { clientX: 464 }, ui.windowRef);
  assert.equal(ui.collapsed(), true); assert.equal(ui.expands.length, 1); assert.equal(ui.collapses.length, 1);
  assert.equal(ui.applied(), 300); assert.equal(ui.values.get(STORAGE_KEY), "300"); assert.equal(ui.writes.length, 0);
  assert.deepEqual([ui.callbacks.at(-1).captured, ui.callbacks.at(-1).resizing, ui.callbacks.at(-1).revealing], [false, false, false]);
  ui.emit("pointerup", { clientX: 464 }, ui.windowRef); assert.equal(ui.writes.length, 0);
});

test("外部开合取消临时预览或宽度但保留外部状态，不调用回滚开合", () => {
  for (const phase of ["revealing", "resizing", "ordinary"]) {
    const ui = setup({ collapsed: phase !== "ordinary", stored: 300 }); ui.emit("pointerdown");
    const clientX = phase === "revealing" ? 416 : phase === "resizing" ? 530 : 440;
    ui.emit("pointermove", { clientX }, ui.windowRef); const externallyCollapsed = phase !== "revealing";
    ui.setCollapsed(externallyCollapsed);
    assert.equal(ui.collapsed(), externallyCollapsed); assert.equal(ui.applied(), 300); assert.equal(ui.writes.length, 0);
    assert.equal(ui.collapses.length, 0); assert.equal(ui.expands.length, phase === "resizing" ? 1 : 0);
    assert.equal(ui.handle.hasPointerCapture(7), false); assert.equal(ui.layout.classList.contains("is-panel-revealing"), false);
    assert.equal(ui.layout.classList.contains("is-panel-resizing"), false);
    ui.emit("pointerup", { clientX }, ui.windowRef); assert.equal(ui.writes.length, 0);
  }
});

test("页面不可用取消预览或调宽，保留当时开合且移除手柄入口", () => {
  for (const phase of ["revealing", "resizing", "ordinary"]) {
    const ui = setup({ collapsed: phase !== "ordinary", stored: 300 }); ui.emit("pointerdown");
    const clientX = phase === "revealing" ? 416 : phase === "resizing" ? 530 : 440;
    ui.emit("pointermove", { clientX }, ui.windowRef); ui.setEnabled(false);
    assert.equal(ui.collapsed(), phase === "revealing"); assert.equal(ui.applied(), 300); assert.equal(ui.writes.length, 0);
    assert.equal(ui.collapses.length, 0); assert.equal(ui.expands.length, phase === "resizing" ? 1 : 0);
    assert.equal(ui.handle.hasPointerCapture(7), false); assert.equal(ui.handle.inert, true); assert.equal(ui.handle.tabIndex, -1);
    assert.equal(ui.handle.getAttribute("aria-hidden"), "true"); assert.equal(ui.layout.classList.contains("is-panel-revealing"), false);
    assert.equal(ui.layout.classList.contains("is-panel-resizing"), false);
    ui.emit("pointerup", { clientX }, ui.windowRef); ui.setEnabled(true);
    assert.equal(ui.collapsed(), phase === "revealing"); assert.equal(ui.values.get(STORAGE_KEY), "300");
  }
});

test("dispose取消折叠预览并清理监听观察，之后不响应或保存", () => {
  const ui = setup({ collapsed: true, stored: 300 }); ui.emit("pointerdown");
  ui.emit("pointermove", { clientX: 416 }, ui.windowRef); assert.equal(ui.applied(), 56);
  ui.controller.dispose(); assert.equal(ui.applied(), 300); assert.equal(ui.collapsed(), true); assert.equal(ui.callbacks.length, 0);
  assert.equal(ui.handle.hasPointerCapture(7), false); assert.equal(ui.layout.classList.contains("is-panel-revealing"), false);
  assert.equal(ui.handle.listenerCount(), 0); assert.equal(ui.windowRef.listenerCount(), 0);
  assert.equal(ui.observations.every((item) => item.disconnected), true);
  ui.emit("pointermove", { clientX: 530 }, ui.windowRef); ui.emit("pointerup", { clientX: 530 }, ui.windowRef);
  ui.emit("keydown", { key: "ArrowRight" }); assert.equal(ui.collapsed(), true); assert.equal(ui.applied(), 300); assert.equal(ui.writes.length, 0);
});

test("折叠态方向键、回车和空格可展开，End展开到最大，双击展开恢复默认", () => {
  for (const key of ["ArrowRight", "Enter", " "]) {
    const ui = setup({ collapsed: true, stored: 300 });
    assert.equal(ui.emit("keydown", { key }).defaultPrevented, true);
    assert.equal(ui.collapsed(), false); assert.equal(ui.applied(), 300); assert.equal(ui.expands.length, 1); assert.equal(ui.writes.length, 0);
  }
  const end = setup({ collapsed: true, stored: 300 }); end.emit("keydown", { key: "End" });
  assert.equal(end.collapsed(), false); assert.equal(end.applied(), 360); assert.equal(end.values.get(STORAGE_KEY), "360");
  const reset = setup({ collapsed: true, stored: 300 }); reset.emit("dblclick");
  assert.equal(reset.collapsed(), false); assert.equal(reset.applied(), 208); assert.equal(reset.values.get(STORAGE_KEY), "208");
  assert.equal(reset.expands.length, 1);
});

test("需求说明打开时历史栏开合与拉出预览不改变主导航宽度预算", () => {
  const classes = () => {
    const names = new Set();
    return { contains: (name) => names.has(name), toggle: (name, active) => active ? names.add(name) : names.delete(name) };
  };
  let shellWidth = 1200;
  const shell = { classList: classes(), getBoundingClientRect: () => ({ width: shellWidth }) };
  const workspace = { classList: classes(), getBoundingClientRect: () => ({ width: 900 }) };
  const page = { hidden: false }, history = { classList: classes() };
  workspace.classList.toggle("context-open", true);
  const elements = new Map([["app-shell", shell], ["main-workspace", workspace], ["page-chat", page], ["main-history", history],
    ["sidebar-resize", {}], ["main-history-resize", {}]]);
  const documentRef = { getElementById: (id) => elements.get(id) ?? null };
  const windowRef = { getComputedStyle: () => ({ paddingLeft: "16px", paddingRight: "36px" }) };
  const context = vm.createContext({ document: { getElementById: () => null }, window: {} });
  vm.runInContext(source, context);
  const captured = []; context.initPanelResize = (options) => { captured.push(options); return options; };
  const controllers = context.initWorkspaceResize({ documentRef, windowRef });
  assert.equal(captured.length, 2); assert.equal(controllers.sidebar, captured[0]); assert.equal(controllers.history, captured[1]);
  assert.equal(controllers.sidebar.minWidth, 175);
  for (const [state, collapsed, revealing] of [["folded", true, false], ["revealing", true, true], ["open", false, false]]) {
    workspace.classList.toggle("history-collapsed", collapsed); workspace.classList.toggle("is-panel-revealing", revealing);
    history.classList.toggle("is-collapsed", collapsed);
    assert.equal(controllers.sidebar.getMax(), 296, state + " 时应一直预留历史最小展开宽度160，保持拉出起点");
  }
  assert.equal(controllers.history.getMax(), 208);
  workspace.classList.toggle("context-open", false);
  assert.equal(controllers.sidebar.getMax(), 600); assert.equal(controllers.history.getMax(), 512);
  workspace.classList.toggle("context-open", true);
  shellWidth = 1000; assert.equal(controllers.sidebar.getMax(), 175);
  page.hidden = true; shellWidth = 700; assert.equal(controllers.sidebar.getMax(), 175);
});
