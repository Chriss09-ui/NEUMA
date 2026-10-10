import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../public/skills-view.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const STORAGE_KEY = "neuma-skills-list-width";

function setup({ width = 1280, gap = 24, top = 0, height = 700, viewportHeight = 900, stored, observer = true, storageBlocked = false, measurable = true } = {}) {
  class Events {
    listeners = new Map();
    addEventListener(type, callback, options = {}) {
      if (options.signal?.aborted) return;
      const handlers = this.listeners.get(type) ?? new Set(); handlers.add(callback); this.listeners.set(type, handlers);
      options.signal?.addEventListener("abort", () => this.removeEventListener(type, callback), { once: true });
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    dispatchEvent(event) { for (const callback of [...(this.listeners.get(event.type) ?? [])]) callback(event); }
    listenerCount() { return [...this.listeners.values()].reduce((count, callbacks) => count + callbacks.size, 0); }
  }
  const properties = new Map(), attributes = new Map(), captures = new Set(), writes = [], observations = [], releases = [];
  const classes = new Set();
  const classList = {
    add: (...names) => names.forEach((name) => classes.add(name)),
    remove: (...names) => names.forEach((name) => classes.delete(name)),
    toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
    contains: (name) => classes.has(name),
  };
  const layout = new Events();
  layout.style = { setProperty: (key, value) => properties.set(key, String(value)), getPropertyValue: (key) => properties.get(key) ?? "", removeProperty: (key) => properties.delete(key) };
  layout.classList = classList;
  if (measurable) layout.getBoundingClientRect = () => ({ width, left: 100, right: 100 + width, height, top, bottom: top + height });
  const handle = new Events();
  handle.style = {}; handle.classList = classList;
  handle.setAttribute = (key, value) => attributes.set(key, String(value));
  handle.getAttribute = (key) => attributes.get(key) ?? null;
  handle.setPointerCapture = (id) => captures.add(id);
  handle.hasPointerCapture = (id) => captures.has(id);
  handle.releasePointerCapture = (id) => { captures.delete(id); releases.push(id); };
  handle.focus = () => { handle.focused = true; };
  const values = new Map(stored === undefined ? [] : [[STORAGE_KEY, String(stored)]]);
  const storage = {
    getItem(key) { if (storageBlocked) throw new Error("Storage unavailable"); return values.get(key) ?? null; },
    setItem(key, value) { writes.push({ key, value: String(value) }); if (storageBlocked) throw new Error("Storage unavailable"); values.set(key, String(value)); },
  };
  const windowRef = new Events();
  windowRef.innerHeight = viewportHeight;
  windowRef.getComputedStyle = () => ({ columnGap: `${gap}px`, gap: `${gap}px` });
  windowRef.localStorage = storage;
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; this.targets = []; observations.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; this.targets = []; }
  }
  if (observer) windowRef.ResizeObserver = ResizeObserver;
  const context = vm.createContext({ window: windowRef, getComputedStyle: windowRef.getComputedStyle,
    ...(observer ? { ResizeObserver } : {}), AbortController, document: { body: { style: {}, classList }, documentElement: { style: {} } } });
  vm.runInContext(source, context);
  assert.equal(typeof context.initSkillSplitter, "function", "skills-view.js 应导出 initSkillSplitter");
  const splitter = context.initSkillSplitter({ layout, handle, windowRef, storage });
  const emit = (type, fields = {}, target = handle) => {
    const event = { type, button: 0, isPrimary: true, pointerId: 7, clientX: 400, shiftKey: false, ...fields,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; } };
    if (type === "lostpointercapture") captures.delete(event.pointerId);
    target.dispatchEvent(event); if (target !== windowRef && !event.propagationStopped) windowRef.dispatchEvent(event); return event;
  };
  const resize = (nextWidth, nextGap = gap) => {
    width = nextWidth; gap = nextGap;
    if (observer) for (const item of observations) { if (!item.disconnected) item.callback([{ target: layout }]); }
    else windowRef.dispatchEvent({ type: "resize" });
  };
  const setBounds = (bounds) => {
    width = bounds.width ?? width; top = bounds.top ?? top; height = bounds.height ?? height;
    windowRef.innerHeight = bounds.viewportHeight ?? windowRef.innerHeight;
  };
  return { splitter, layout, handle, windowRef, writes, values, observations, releases, emit, resize,
    setBounds, gripY: () => Number.parseFloat(layout.style.getPropertyValue("--skills-grip-y")),
    applied: () => Number.parseFloat(layout.style.getPropertyValue("--skills-list-width")) };
}

test("技能列宽默认 300 px，初始化夹紧存储值并更新可访问范围但不写存储", () => {
  const ui = setup();
  assert.equal(ui.applied(), 300);
  assert.equal(ui.handle.getAttribute("role"), "separator");
  assert.equal(ui.handle.getAttribute("aria-orientation"), "vertical");
  assert.equal(ui.handle.getAttribute("aria-valuemin"), "220");
  assert.equal(ui.handle.getAttribute("aria-valuemax"), "640");
  assert.equal(ui.handle.getAttribute("aria-valuenow"), "300");
  assert.equal(ui.writes.length, 0);
  const constrained = setup({ width: 900, gap: 40, stored: 620 });
  assert.equal(constrained.applied(), 440);
  assert.equal(constrained.handle.getAttribute("aria-valuemax"), "440");
  assert.equal(constrained.values.get(STORAGE_KEY), "620");
  const insufficient = setup({ width: 650, gap: 40 });
  assert.ok(insufficient.applied() <= 190, "可用空间不足时仍给右侧保留 420 px");
  assert.ok(Number(insufficient.handle.getAttribute("aria-valuemin")) <= Number(insufficient.handle.getAttribute("aria-valuemax")));
});

test("主按钮拖拽捕获指针、实时夹紧，其他指针无效且完成前不保存", () => {
  const ui = setup({ width: 1000 });
  ui.emit("pointerdown", { button: 2 }); ui.emit("pointermove", { clientX: 500 });
  assert.equal(ui.applied(), 300); assert.equal(ui.handle.hasPointerCapture(7), false);
  ui.emit("pointerdown", { isPrimary: false });
  assert.equal(ui.handle.hasPointerCapture(7), false);
  ui.emit("pointerdown"); assert.equal(ui.handle.hasPointerCapture(7), true);
  ui.emit("pointermove", { pointerId: 9, clientX: 500 }); assert.equal(ui.applied(), 300);
  ui.emit("pointermove", { clientX: 900 }); assert.equal(ui.applied(), 556);
  ui.emit("pointermove", { clientX: 100 }); assert.equal(ui.applied(), 220);
  ui.emit("pointermove", { clientX: 460 }); assert.equal(ui.applied(), 360);
  assert.equal(ui.writes.length, 0);
  ui.emit("pointerup", { clientX: 460 });
  assert.equal(ui.handle.hasPointerCapture(7), false);
  assert.deepEqual(ui.writes, [{ key: STORAGE_KEY, value: "360" }]);
});

test("取消拖拽与丢失指针捕获回退开始前的偏好，取消值不落盘", () => {
  const ui = setup({ stored: 500 });
  ui.emit("pointerdown"); ui.emit("pointermove", { clientX: 450 }); assert.equal(ui.applied(), 550);
  ui.emit("pointercancel"); assert.equal(ui.applied(), 500); assert.equal(ui.writes.length, 0);
  assert.equal(ui.handle.hasPointerCapture(7), false);
  ui.emit("pointerdown"); ui.emit("pointermove", { clientX: 470 }); assert.equal(ui.applied(), 570);
  ui.emit("lostpointercapture"); assert.equal(ui.applied(), 500); assert.equal(ui.writes.length, 0);
  ui.resize(900); assert.equal(ui.applied(), 456);
  ui.resize(1280); assert.equal(ui.applied(), 500);
});

test("键盘以 16 或 48 px 调整，Home/End 到边界，双击恢复 300 px 并保存", () => {
  const ui = setup();
  assert.equal(ui.emit("keydown", { key: "ArrowRight" }).defaultPrevented, true); assert.equal(ui.applied(), 316);
  ui.emit("keydown", { key: "ArrowRight", shiftKey: true }); assert.equal(ui.applied(), 364);
  ui.emit("keydown", { key: "ArrowLeft" }); assert.equal(ui.applied(), 348);
  ui.emit("keydown", { key: "ArrowLeft", shiftKey: true }); assert.equal(ui.applied(), 300);
  ui.emit("keydown", { key: "Home" }); assert.equal(ui.applied(), 220);
  ui.emit("keydown", { key: "End" }); assert.equal(ui.applied(), 640);
  const count = ui.writes.length;
  assert.equal(ui.emit("keydown", { key: "Enter" }).defaultPrevented, undefined); assert.equal(ui.writes.length, count);
  ui.emit("dblclick"); assert.equal(ui.applied(), 300); assert.equal(ui.values.get(STORAGE_KEY), "300");
  assert.equal(ui.writes.length, 7);
});

test("ResizeObserver 暂时夹紧列宽，隐藏布局不应用，空间恢复后还原原偏好", () => {
  const ui = setup({ stored: 620 });
  assert.equal(ui.observations.length, 1); assert.deepEqual(ui.observations[0].targets, [ui.layout]);
  ui.resize(900, 64); assert.equal(ui.applied(), 416);
  assert.equal(ui.handle.getAttribute("aria-valuemax"), "416");
  ui.resize(0); assert.equal(ui.applied(), 416);
  ui.splitter.refresh(); assert.equal(ui.applied(), 416);
  assert.equal(ui.values.get(STORAGE_KEY), "620"); assert.equal(ui.writes.length, 0);
  ui.resize(1400, 24); assert.equal(ui.applied(), 620);
  assert.equal(ui.handle.getAttribute("aria-valuenow"), "620");
});

test("没有 ResizeObserver 时用窗口 resize，dispose 后停止响应尺寸变化", () => {
  const ui = setup({ observer: false, stored: 600 });
  assert.ok(ui.windowRef.listeners.get("resize")?.size);
  ui.resize(900); assert.equal(ui.applied(), 456);
  ui.resize(1400); assert.equal(ui.applied(), 600);
  ui.splitter.dispose(); const applied = ui.applied();
  ui.resize(900); assert.equal(ui.applied(), applied);
  assert.equal(ui.windowRef.listenerCount(), 0);
});

test("dispose 清理活动拖拽、指针捕获、监听器与观察器，卸载不保存半次拖拽", () => {
  const ui = setup({ stored: 500 });
  ui.emit("pointerdown"); ui.emit("pointermove", { clientX: 450 });
  assert.equal(ui.applied(), 550); assert.equal(ui.handle.hasPointerCapture(7), true);
  ui.splitter.dispose(); const afterDispose = ui.applied();
  assert.equal(ui.handle.hasPointerCapture(7), false); assert.ok(ui.releases.includes(7));
  assert.equal(ui.handle.listenerCount(), 0); assert.equal(ui.windowRef.listenerCount(), 0); assert.equal(ui.observations[0].disconnected, true);
  ui.emit("pointermove", { clientX: 700 }); ui.emit("pointerup"); ui.emit("keydown", { key: "End" }); ui.resize(900);
  assert.equal(ui.applied(), afterDispose); assert.equal(ui.writes.length, 0);
  assert.doesNotThrow(() => ui.splitter.dispose());
});

test("存储失败或损坏不影响宽度调整，旧 fake DOM 不可测量时返回无副作用接口", () => {
  const blocked = setup({ storageBlocked: true }); assert.equal(blocked.applied(), 300);
  assert.doesNotThrow(() => blocked.emit("keydown", { key: "ArrowRight" })); assert.equal(blocked.applied(), 316);
  assert.doesNotThrow(() => blocked.emit("dblclick")); assert.equal(blocked.applied(), 300);
  const invalid = setup({ stored: "not-a-width" }); assert.equal(invalid.applied(), 300);
  const legacy = setup({ measurable: false });
  assert.doesNotThrow(() => legacy.splitter.refresh()); assert.doesNotThrow(() => legacy.splitter.dispose());
  assert.equal(legacy.layout.style.getPropertyValue("--skills-list-width"), "");
  assert.equal(legacy.handle.listenerCount(), 0); assert.equal(legacy.windowRef.listenerCount(), 0); assert.equal(legacy.writes.length, 0);
});

test("悬停手柄沿分隔线跟随鼠标，按布局坐标夹紧到可见手柄边界且不改变列宽", () => {
  const ui = setup({ top: 120, height: 700 });
  ui.emit("pointerenter", { clientY: 350 }); assert.equal(ui.gripY(), 230);
  ui.emit("pointermove", { clientY: 610 }); assert.equal(ui.gripY(), 490);
  ui.emit("pointermove", { clientY: 100 }); assert.equal(ui.gripY(), 28);
  ui.emit("pointermove", { clientY: 900 }); assert.equal(ui.gripY(), 672);
  assert.equal(ui.applied(), 300); assert.equal(ui.writes.length, 0);
  const short = setup({ top: 120, height: 40 });
  short.emit("pointerenter", { clientY: 121 }); assert.equal(short.gripY(), 20);
  short.emit("pointermove", { clientY: 900 }); assert.equal(short.gripY(), 20);
});

test("无效鼠标坐标或无尺寸布局不移动手柄", () => {
  const ui = setup({ top: 100 });
  ui.emit("pointerenter", { clientY: 400 }); assert.equal(ui.gripY(), 300);
  for (const clientY of [undefined, NaN, Infinity, -Infinity]) {
    ui.emit("pointermove", { clientY }); assert.equal(ui.gripY(), 300);
  }
  ui.setBounds({ width: 0 }); ui.emit("pointermove", { clientY: 500 }); assert.equal(ui.gripY(), 300);
  ui.setBounds({ width: 1280, height: 0 }); ui.emit("pointermove", { clientY: 500 }); assert.equal(ui.gripY(), 300);
});

test("活动拖动即使离开分隔线仍跟随鼠标，其他指针不修改高度或列宽", () => {
  const ui = setup({ top: 120 });
  ui.emit("pointerenter", { clientY: 350 }); ui.emit("pointerdown", { clientY: 350 });
  ui.emit("pointerleave", { clientY: 350 });
  ui.emit("pointermove", { clientX: 460, clientY: 500 }, ui.windowRef);
  assert.equal(ui.applied(), 360); assert.equal(ui.gripY(), 380); assert.equal(ui.writes.length, 0);
  ui.emit("pointermove", { pointerId: 9, clientX: 900, clientY: 800 }, ui.windowRef);
  assert.equal(ui.applied(), 360); assert.equal(ui.gripY(), 380);
  ui.emit("pointermove", { pointerId: 9, clientX: 900, clientY: 800 });
  assert.equal(ui.applied(), 360); assert.equal(ui.gripY(), 380);
  ui.emit("focus"); assert.equal(ui.gripY(), 380);
  ui.setBounds({ top: 200 }); ui.emit("scroll", {}, ui.windowRef); assert.equal(ui.gripY(), 300);
  ui.emit("pointerup", {}, ui.windowRef); assert.equal(ui.writes.length, 1);
});

test("键盘聚焦时手柄回到分隔线可见部分的中心", () => {
  const ui = setup({ top: 120, height: 1400, viewportHeight: 900 });
  ui.emit("pointerenter", { clientY: 200 }); assert.equal(ui.gripY(), 80);
  ui.emit("focus"); assert.equal(ui.gripY(), 80, "鼠标点击引发聚焦时保留鼠标位置");
  ui.emit("pointerleave");
  ui.emit("focus"); assert.equal(ui.gripY(), 390);
  ui.setBounds({ top: -200, height: 700 }); ui.emit("focus"); assert.equal(ui.gripY(), 450);
  assert.equal(ui.applied(), 300); assert.equal(ui.writes.length, 0);
});

test("scroll 与 refresh 根据最近鼠标高度重新定位，离开后使用可见线段中点", () => {
  const ui = setup({ top: 120, height: 1400, viewportHeight: 900 });
  ui.emit("pointerenter", { clientY: 500 }); assert.equal(ui.gripY(), 380);
  ui.setBounds({ top: 200 }); ui.emit("scroll", {}, ui.windowRef); assert.equal(ui.gripY(), 300);
  ui.setBounds({ top: -100 }); ui.splitter.refresh(); assert.equal(ui.gripY(), 600);
  ui.emit("pointerleave"); ui.setBounds({ top: 120 }); ui.splitter.refresh(); assert.equal(ui.gripY(), 390);
  assert.equal(ui.applied(), 300); assert.equal(ui.writes.length, 0);
});

test("dispose 后悬停、聚焦和滚动不再移动手柄", () => {
  const ui = setup({ top: 120 });
  ui.emit("pointerenter", { clientY: 400 }); assert.equal(ui.gripY(), 280);
  ui.splitter.dispose(); const previous = ui.gripY();
  ui.setBounds({ top: 200 });
  ui.emit("pointerenter", { clientY: 600 }); ui.emit("pointermove", { clientY: 700 });
  ui.emit("focus"); ui.emit("scroll", {}, ui.windowRef); ui.splitter.refresh();
  assert.equal(ui.gripY(), previous);
  assert.equal(ui.handle.listenerCount(), 0); assert.equal(ui.windowRef.listenerCount(), 0);
});
