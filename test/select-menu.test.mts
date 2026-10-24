import test from "node:test";
import assert from "node:assert/strict";
import { createSelectMenu } from "../public/select-menu.js";

function fixture(rows = [
  { value: "", label: "群内成员自主协作" },
  { value: "unready", label: "尚未就绪", disabled: true },
  { value: "a", label: "微积分可视化学习助手" },
  { value: "b", label: "材料阅读测试" },
]) {
  class FixtureEvent {
declare type: string;
declare target: Target;
declare key: string;
declare bubbles: boolean;
declare ctrlKey: boolean;
declare metaKey: boolean;
declare altKey: boolean;
declare defaultPrevented: boolean;
declare propagationStopped: boolean;
    constructor(type: string, values = {}) { this.type = type; Object.assign(this, values); }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.propagationStopped = true; }
  }
  class Target {
    listeners = new Map<string, ((event: FixtureEvent) => unknown)[]>();
declare Event: typeof FixtureEvent;
declare innerHeight: number;
declare defaultView: Target;
declare activeElement: Element;
declare createElement: (tagName: string) => Element;

    addEventListener(type: string, handler: (event: FixtureEvent) => unknown) {
      const handlers = this.listeners.get(type) ?? [];
      handlers.push(handler); this.listeners.set(type, handlers);
    }
    dispatchEvent(event: FixtureEvent) {
      event.target ??= this;
      for (const handler of this.listeners.get(event.type) ?? []) handler(event);
      return !event.defaultPrevented;
    }
    fire(type: string, values: object = {}) { const event = new FixtureEvent(type, values); this.dispatchEvent(event); return event; }
  }
  const document = new Target();
  const window = new Target();
  window.Event = FixtureEvent; window.innerHeight = 600;
  document.defaultView = window;
  class Element extends Target {
declare tagName: string;
declare ownerDocument: Target;
declare text: string;
declare parent: Element | undefined;
declare id: string;
declare value: string;
declare label: string;
declare type: string;
declare tabIndex: number;
dataset: Record<string,string> = {};
declare rect: { top: number; bottom: number; height: number; };
    constructor(tagName: string) { super(); this.tagName = tagName.toUpperCase(); this.ownerDocument = document; }
    children: Element[] = []; attributes = new Map(); className = ""; disabled = false;
    hidden = false; scrollTop = 0; clientHeight = 80; offsetHeight = 40;
    classList = {
      toggle: (name: string, force?: boolean) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        if (force ?? !names.has(name)) names.add(name); else names.delete(name);
        this.className = [...names].join(" ");
      },
      add(..._names: string[]) {}, remove(..._names: string[]) {},
      contains: (name: string) => this.className.split(/\s+/).includes(name),
    };
    get textContent(): string { return this.text ?? this.children.map((child) => child.textContent).join(""); }
    set textContent(value: string) { this.text = String(value); this.children = []; }
    get offsetTop() { return (this.parent?.children.indexOf(this) ?? 0) * 40 || 0; }
    replaceChildren(...children: Element[]) { this.text = ""; this.children = []; this.append(...children); this.scrollTop = 0; }
    append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
    setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    removeAttribute(name: string) { this.attributes.delete(name); }
    contains(target: unknown): boolean { return target === this || this.children.some((child) => child.contains(target)); }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return this.rect ?? { top: 500, bottom: 540, height: 40 }; }
  }
  document.createElement = (tagName: string) => new Element(tagName);
  const select = document.createElement("select"), trigger = document.createElement("button");
  const menu = document.createElement("div"), value = document.createElement("span"), icon = document.createElement("span");
  menu.id = "group-recipient-menu"; menu.rect = { top: 550, bottom: 710, height: 160 };
  trigger.append(icon, value); select.value = rows[0]?.value ?? "";
  function setOptions(next: { value: string; label: string; disabled?: boolean }[]) {
    select.replaceChildren(...next.map((row) => {
      const option = document.createElement("option");
      option.value = row.value; option.label = row.label; option.disabled = Boolean(row.disabled);
      option.textContent = row.label; return option;
    }));
  }
  setOptions(rows);
  const renderIcon = (target: { textContent: string; }, option: { value: string; }) => { target.textContent = option.value === "" ? "群星核" : `星核:${option.value}`; };
  const control = createSelectMenu({ select, trigger, menu, value, icon, renderIcon, document, window });
  const activeValue = () => {
    const id = trigger.getAttribute("aria-activedescendant");
    const index = menu.children.findIndex((button) => button.id === id);
    return select.children[index]?.value;
  };
  return { select, trigger, menu, value, icon, control, document, window, setOptions, activeValue };
}

test("显示权威选择与星核，鼠标切换仅产生一次冒泡 change，重复选择不发送", () => {
  const { select, trigger, menu, value, icon, document } = fixture();
  const changes: {value:string;bubbles:boolean}[] = [];
  select.addEventListener("change", (event) => changes.push({ value: select.value, bubbles: event.bubbles }));
  assert.equal(value.textContent, "群内成员自主协作");
  assert.equal(icon.textContent, "群星核");
  assert.equal(menu.children[0]!.getAttribute("aria-selected"), "true");
  assert.equal(menu.children[0]!.children.at(-1)!.getAttribute("aria-hidden"), "true");
  assert.equal(menu.children[0]!.children.at(-1)!.hidden, false);
  trigger.fire("click");
  assert.equal(menu.hidden, false);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  menu.children[2]!.fire("click");
  assert.equal(select.value, "a");
  assert.equal(value.textContent, "微积分可视化学习助手");
  assert.equal(icon.textContent, "星核:a");
  assert.equal(menu.hidden, true);
  assert.equal(document.activeElement, trigger);
  assert.deepEqual(changes, [{ value: "a", bubbles: true }]);
  trigger.fire("click"); menu.children[2]!.fire("click");
  assert.equal(changes.length, 1);
  trigger.fire("click"); menu.children[0]!.fire("click");
  assert.equal(select.value, "");
  assert.equal(value.textContent, "群内成员自主协作");
});

test("不能选未就绪项，原生 select 禁用或无可选项时关闭并禁用触发器", () => {
  const { select, trigger, menu, control, setOptions } = fixture();
  assert.equal(menu.children[1]!.disabled, true);
  assert.equal(menu.children[1]!.getAttribute("aria-disabled"), "true");
  trigger.fire("click"); menu.children[1]!.fire("click");
  assert.equal(select.value, ""); assert.equal(menu.hidden, false);
  select.disabled = true; control.refresh();
  assert.equal(trigger.disabled, true); assert.equal(menu.hidden, true);
  trigger.fire("click"); assert.equal(menu.hidden, true);
  select.disabled = false; setOptions([]); control.refresh();
  assert.equal(trigger.disabled, true); assert.equal(menu.children.length, 0);
  setOptions([{ value: "a", label: "未就绪", disabled: true }]); control.refresh();
  assert.equal(trigger.disabled, true);
});

test("change 回调观察到菜单已关闭，可转移焦点而不被组件夺回", () => {
  const { select, trigger, menu, value, document } = fixture();
  const input = document.createElement("input");
  let changes = 0;
  select.addEventListener("change", () => {
    changes++;
    assert.equal(menu.hidden, true);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(trigger.getAttribute("aria-activedescendant"), null);
    assert.equal(value.textContent, "微积分可视化学习助手");
    assert.equal(document.activeElement, trigger);
    input.focus();
  });
  trigger.fire("click"); menu.children[2]!.fire("click");
  assert.equal(changes, 1); assert.equal(document.activeElement, input);
  trigger.fire("click"); menu.children[2]!.fire("click");
  assert.equal(changes, 1); assert.equal(document.activeElement, trigger);
});

test("键盘跳过禁用项，Home/End 定位，Escape 不修改选择，Enter/Space 确认后保留焦点", () => {
  const { select, trigger, menu, activeValue, document } = fixture();
  trigger.focus(); trigger.fire("keydown", { key: "ArrowDown" });
  assert.equal(activeValue(), "");
  trigger.fire("keydown", { key: "ArrowDown" });
  assert.equal(activeValue(), "a"); assert.equal(select.value, "");
  const escape = trigger.fire("keydown", { key: "Escape" });
  assert.equal(escape.defaultPrevented, true); assert.equal(escape.propagationStopped, true);
  assert.equal(menu.hidden, true); assert.equal(select.value, "");
  assert.equal(trigger.getAttribute("aria-activedescendant"), null);
  trigger.fire("keydown", { key: "End" }); assert.equal(activeValue(), "b");
  trigger.fire("keydown", { key: "ArrowUp" }); assert.equal(activeValue(), "a");
  trigger.fire("keydown", { key: "ArrowUp" }); assert.equal(activeValue(), "");
  trigger.fire("keydown", { key: "End" }); trigger.fire("keydown", { key: "Enter" });
  assert.equal(select.value, "b"); assert.equal(menu.hidden, true); assert.equal(document.activeElement, trigger);
  trigger.fire("keydown", { key: "Home" }); trigger.fire("keydown", { key: " " });
  assert.equal(select.value, ""); assert.equal(menu.hidden, true);
});

test("外部点击、窗口变化和页面滚动关闭；菜单内滚动与 pointerdown 保留键盘焦点", () => {
  const { trigger, menu, document, window } = fixture();
  trigger.focus(); trigger.fire("click");
  document.fire("pointerdown", { target: trigger.children[0] }); assert.equal(menu.hidden, false);
  document.fire("pointerdown", { target: menu.children[2]!.children[0] }); assert.equal(menu.hidden, false);
  const pointer = menu.fire("pointerdown", { target: menu.children[2] });
  assert.equal(pointer.defaultPrevented, true); assert.equal(document.activeElement, trigger);
  document.fire("scroll", { target: menu }); assert.equal(menu.hidden, false);
  document.fire("scroll", { target: document }); assert.equal(menu.hidden, true);
  trigger.fire("click"); window.fire("resize"); assert.equal(menu.hidden, true);
  trigger.fire("click"); document.fire("pointerdown", { target: document }); assert.equal(menu.hidden, true);
  trigger.fire("click"); const tab = trigger.fire("keydown", { key: "Tab" });
  assert.equal(menu.hidden, true); assert.equal(tab.defaultPrevented, undefined);
});

test("定期刷新保留展开、活动成员及滚动位置，名称/图标/当前选择同步更新", () => {
  const { select, trigger, menu, value, icon, control, setOptions, activeValue } = fixture();
  trigger.fire("click"); trigger.fire("keydown", { key: "End" }); menu.scrollTop = 57;
  setOptions([
    { value: "b", label: "材料阅读新版" }, { value: "", label: "群内协作新版" },
    { value: "a", label: "数学助手新版" },
  ]);
  control.refresh();
  assert.equal(menu.hidden, false); assert.equal(activeValue(), "b"); assert.equal(menu.scrollTop, 57);
  assert.equal(value.textContent, "群内协作新版"); assert.equal(icon.textContent, "群星核");
  assert.equal(menu.children[1]!.getAttribute("aria-selected"), "true");
  select.value = "a"; select.fire("change");
  assert.equal(value.textContent, "数学助手新版"); assert.equal(icon.textContent, "星核:a");
  assert.equal(activeValue(), "b"); assert.equal(menu.scrollTop, 57);
  trigger.fire("keydown", { key: "Enter" });
  assert.equal(select.value, "b"); assert.equal(value.textContent, "材料阅读新版");
});

test("刷新支持空字符串活动值，删除或禁用活动项时回到可选成员", () => {
  const { trigger, menu, control, setOptions, activeValue } = fixture();
  trigger.fire("click"); assert.equal(activeValue(), "");
  setOptions([{ value: "a", label: "成员 A" }, { value: "", label: "自主协作" }]);
  control.refresh(); assert.equal(activeValue(), "");
  setOptions([{ value: "a", label: "成员 A" }, { value: "", label: "禁用", disabled: true }]);
  control.refresh(); assert.equal(activeValue(), "a"); assert.equal(menu.hidden, false);
  setOptions([]); control.refresh(); assert.equal(menu.hidden, true);
  assert.equal(trigger.getAttribute("aria-activedescendant"), null);
});

test("菜单根据可用空间向上展开，鼠标悬停更新活动项但不立即选择", () => {
  const { select, trigger, menu, control, activeValue } = fixture();
  trigger.fire("click"); assert.equal(menu.classList.contains("opens-above"), true);
  menu.children[2]!.fire("mouseover"); assert.equal(activeValue(), "a"); assert.equal(select.value, "");
  menu.children[1]!.fire("mouseover"); assert.equal(activeValue(), "a");
  trigger.rect = { top: 80, bottom: 120, height: 40 }; control.refresh();
  assert.equal(menu.classList.contains("opens-above"), false);
  assert.equal(menu.children[2]!.classList.contains("is-active"), true);
});

test("可打印输入按选项名称定位，不匹配时不改选择", () => {
  const { select, trigger, activeValue } = fixture([
    { value: "a", label: "Apple" }, { value: "bad", label: "Bee", disabled: true }, { value: "b", label: "Beta" },
  ]);
  const event = trigger.fire("keydown", { key: "b" });
  assert.equal(activeValue(), "b"); assert.equal(select.value, "a"); assert.equal(event.defaultPrevented, true);
  trigger.fire("keydown", { key: "e" }); assert.equal(activeValue(), "b");
  trigger.fire("keydown", { key: "z" }); assert.equal(select.value, "a");
});
