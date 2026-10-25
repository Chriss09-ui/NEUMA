import test from "node:test";
import assert from "node:assert/strict";
import { createGroupMentionComposer, groupMentionQuery, shiftGroupMentions } from "../../public/group-mention-composer.js";

const member = (id: string, name: string, ready = true, color = 1) => ({ id, name, ready, description: `${name}的职责`, profile: { icon: `star:0:${color}` } });
const defaultMembers = [member("writer", "方案搭建员"), member("researcher", "资料研究员", true, 6), member("checker", "验收检查员", false)];
function fixture(members = defaultMembers) {
  class Event {
declare type: string;
declare target: Target;
declare key: string;
declare bubbles: boolean;
declare shiftKey: boolean;
declare inputType: string;
declare isComposing: boolean;
declare keyCode: number;
declare defaultPrevented: boolean;
declare cancelBubble: boolean;
    constructor(type: string, values = {}) { this.type = type; Object.assign(this, values); }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.cancelBubble = true; }
  }
  class Target {
    listeners = new Map<string, ((event: Event) => unknown)[]>();
declare defaultView: { Event: typeof Event; };
declare activeElement: Element;
declare createElement: (tag: string) => Element;

    addEventListener(type: string, callback: (event: Event) => unknown) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]); }
    dispatchEvent(event: Event) { event.target ||= this; for (const callback of this.listeners.get(event.type) || []) callback(event); return !event.defaultPrevented; }
    fire(type: string, values = {}) { const event = new Event(type, values); this.dispatchEvent(event); return event; }
  }
  const document = new Target(), window = new Target(); document.defaultView = { Event };
  class Element extends Target {
    children: Element[] = []; attributes = new Map(); dataset: Record<string,string> = {}; className = ""; value = ""; hidden = false; disabled = false;
    selectionStart = 0; selectionEnd = 0; scrollTop = 0; clientHeight = 120; offsetHeight = 40; maxLength = 4000;
declare tagName: string;
declare ownerDocument: Target;
declare text: string;
declare parent: Element | undefined;
declare id: string;
declare type: string;
declare tabIndex: number;
declare title: string;
declare inert: boolean;
    constructor(tag: string) { super(); this.tagName = tag.toUpperCase(); this.ownerDocument = document; }
    classList = {
      add: (...values: string[]) => { this.className = [...new Set([...this.className.split(/\s+/), ...values])].join(" ").trim(); },
      remove: (...values: string[]) => { this.className = this.className.split(/\s+/).filter((name) => !values.includes(name)).join(" "); },
      contains: (name: string) => this.className.split(/\s+/).includes(name),
      toggle: (name: string, enabled?: boolean) => { if (enabled) this.classList.add(name); else this.classList.remove(name); },
    };
    get textContent(): string { return (this.text || "") + this.children.map((child) => child.textContent).join(""); }
    set textContent(text: string) { this.text = String(text); this.children = []; }
    get offsetTop() { return (this.parent?.children.indexOf(this) ?? 0) * 40 || 0; }
    append(...children: Element[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children: Element[]) { this.children = []; this.text = ""; this.append(...children); }
    setAttribute(name: string, value: string) { this.attributes.set(name, String(value)); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    removeAttribute(name: string) { this.attributes.delete(name); }
    contains(target: unknown): boolean { return this === target || this.children.some((child) => child.contains(target)); }
    focus() { document.activeElement = this; document.fire("focusin", { target: this }); }
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  }
  document.createElement = (tag: string) => new Element(tag);
  const input = document.createElement("textarea"), popup = document.createElement("div"), selected = document.createElement("div");
  popup.id = "group-mention-popup";
  const control = createGroupMentionComposer({ input, popup, selected, document, window });
  control.setMembers(members, "group-one");
  const type = (text: string, caret = text.length) => { input.focus(); input.value = text; input.setSelectionRange(caret, caret); input.fire("input"); };
  const active = () => popup.children.find((row) => row.id === input.getAttribute("aria-activedescendant"));
  return { input, popup, selected, control, document, window, type, active, Event };
}

test("@ 仅在合适的普通文字边界开启，支持中文筛选及带空格名字", () => {
  assert.deepEqual(groupMentionQuery("请看，@资料", 6), { start: 3, end: 6, query: "资料" });
  assert.deepEqual(groupMentionQuery("@Data Research", 14), { start: 0, end: 14, query: "Data Research" });
  for (const value of ["a@b", "https://a/@b", "` @资料", "> @资料", "\\@资料", "@资料\n下一行"]) assert.equal(groupMentionQuery(value, value.length), null, value);
  assert.equal(groupMentionQuery("@资料", 1, 3), null);
});

test("反引号和波浪围栏内不弹候选，围栏闭合后及行内代码闭合后正常触发", () => {
  for (const value of ["```js\n@资料", "~~~text\n@资料", "`` 示例 @资料", "```js\n~~~\n@资料"]) {
    assert.equal(groupMentionQuery(value, value.length), null, value);
  }
  for (const value of ["```js\nconst a = 1;\n```\n@资料", "~~~\n示例\n~~~\n@资料", "``示例`` @资料", "\\` @资料"]) {
    assert.equal(groupMentionQuery(value, value.length)?.query, "资料", value);
  }
});

test("浮层展示真实星河头像及姓名颜色，筛选后按 Enter 选择并保留周围正文和光标", () => {
  const ui = fixture(); ui.type("前文 @资 后文", 5);
  assert.equal(ui.popup.classList.contains("is-open"), true);
  assert.equal(ui.popup.getAttribute("aria-hidden"), "false"); assert.equal(ui.popup.inert, false);
  assert.equal(ui.popup.children.length, 1);
  const row = ui.active(); assert.equal(row!.dataset.memberId, "researcher"); assert.equal(row!.dataset.avatarColor, "lime");
  assert.equal(row!.children[0]!.dataset.avatarKind, "star");
  const event = ui.input.fire("keydown", { key: "Enter" });
  assert.equal(event.defaultPrevented, true); assert.equal(event.cancelBubble, true);
  assert.equal(ui.input.value, "前文 @资料研究员 后文"); assert.equal(ui.input.selectionStart, 9);
  assert.equal(ui.document.activeElement, ui.input); assert.equal(ui.popup.inert, true);
  assert.equal(ui.selected.hidden, false); assert.equal(ui.selected.children[0]!.dataset.avatarColor, "lime");
  assert.deepEqual(ui.control.requestMentions(), [{ memberId: "researcher", start: 3, end: 9, text: "@资料研究员" }]);
});

test("方向键跳过未就绪成员，Tab 选择；Esc 只关闭候选并阻止上层设置栏响应", () => {
  const ui = fixture(); ui.type("@");
  assert.equal(ui.active()!.dataset.memberId, "writer");
  assert.equal(ui.popup.children[2]!.disabled, true);
  ui.popup.children[2]!.fire("click"); assert.equal(ui.input.value, "@");
  ui.input.fire("keydown", { key: "ArrowUp" }); assert.equal(ui.active()!.dataset.memberId, "researcher");
  ui.input.fire("keydown", { key: "Tab" }); assert.equal(ui.input.value, "@资料研究员 ");
  ui.type(`${ui.input.value}@`);
  const escape = ui.input.fire("keydown", { key: "Escape" });
  assert.equal(escape.defaultPrevented, true); assert.equal(escape.cancelBubble, true); assert.equal(ui.popup.inert, true);
  ui.control.setMembers([...defaultMembers], "group-one"); assert.equal(ui.popup.inert, true, "轮询不能重新打开已用 Esc 关闭的候选");
  ui.input.fire("click"); assert.equal(ui.popup.inert, false);
});

test("中文输入法确认 Enter 不选择或提交；组合输入结束后刷新中文筛选", () => {
  const ui = fixture(); ui.type("@"); ui.input.fire("compositionstart");
  assert.equal(ui.popup.inert, true);
  ui.type("@资料"); const enter = ui.input.fire("keydown", { key: "Enter", isComposing: true, keyCode: 229 });
  assert.equal(enter.defaultPrevented, undefined); assert.equal(ui.input.value, "@资料");
  ui.input.fire("compositionend"); assert.equal(ui.active()!.dataset.memberId, "researcher");
  ui.input.fire("keydown", { key: "Enter" }); assert.equal(ui.input.value, "@资料研究员 ");
});

test("同名候选有可区分信息和真实身份；支持多个提及并把范围归一到 trim 后正文", () => {
  const ui = fixture([member("research-one", "研究员"), member("research-two", "研究员", true, 6)]);
  ui.type("  @"); assert.match(ui.popup.children[0]!.textContent, /arch-one/); assert.match(ui.popup.children[1]!.textContent, /arch-two/);
  ui.popup.children[1]!.fire("click"); ui.type(`${ui.input.value}@`); ui.popup.children[0]!.fire("click");
  assert.deepEqual(ui.control.requestMentions(), [
    { memberId: "research-two", start: 0, end: 4, text: "@研究员" },
    { memberId: "research-one", start: 5, end: 9, text: "@研究员" },
  ]);
  assert.equal(ui.selected.children.length, 2);
});

test("正文编辑仅移动未触及的绑定；删除或改写名字立即取消原身份", () => {
  const ui = fixture(); ui.type("@"); ui.popup.children[1]!.fire("click");
  ui.type(`说明：${ui.input.value}`); ui.type(`${ui.input.value}你好`);
  assert.deepEqual(ui.control.requestMentions(), [{ memberId: "researcher", start: 3, end: 9, text: "@资料研究员" }]);
  ui.type(ui.input.value.replace("资料研究员", "方案搭建员"));
  assert.deepEqual(ui.control.requestMentions(), []); assert.equal(ui.selected.hidden, true);
  assert.deepEqual(shiftGroupMentions("@资料研究员 ", "邮箱@资料研究员 ", [{ memberId: "a", start: 0, end: 6, text: "@资料研究员" }]), []);
});

test("实际编辑范围区分相同名字的不同出现位置，无法定位的重复文本编辑保守失效", () => {
  const ui = fixture([member("research-one", "研究员"), member("research-two", "研究员", true, 6)]);
  ui.type("@"); ui.popup.children[1]!.fire("click");
  ui.input.setSelectionRange(0, 0); ui.input.fire("beforeinput", { inputType: "insertText", data: "@研究员 " });
  ui.input.value = `@研究员 ${ui.input.value}`; ui.input.setSelectionRange(5, 5); ui.input.fire("input");
  assert.deepEqual(ui.control.requestMentions(), [{ memberId: "research-two", start: 5, end: 9, text: "@研究员" }]);
  ui.input.setSelectionRange(0, 5); ui.input.fire("beforeinput", { inputType: "deleteContentBackward" });
  ui.input.value = ui.input.value.slice(5); ui.input.setSelectionRange(0, 0); ui.input.fire("input");
  assert.deepEqual(ui.control.requestMentions(), [{ memberId: "research-two", start: 0, end: 4, text: "@研究员" }]);
  assert.deepEqual(shiftGroupMentions("@研究员 ", "@研究员 @研究员 ", [{ memberId: "research-two", start: 0, end: 4, text: "@研究员" }]), []);
});

test("在已经完整输入的名字中部重新选择不会留下重复尾巴，正文尾部仍保留", () => {
  const ui = fixture(); ui.type("请看 @资料研究员 的意见", 5);
  ui.input.fire("keydown", { key: "Enter" });
  assert.equal(ui.input.value, "请看 @资料研究员 的意见");
  assert.deepEqual(ui.control.requestMentions(), [{ memberId: "researcher", start: 3, end: 9, text: "@资料研究员" }]);
});

test("轮询保持打开状态、活动成员、原节点和滚动位置；成员被删除会更新候选", () => {
  const ui = fixture(); ui.type("@"); ui.input.fire("keydown", { key: "ArrowDown" });
  const row = ui.active(); ui.popup.scrollTop = 27;
  ui.control.setMembers(structuredClone(defaultMembers), "group-one");
  assert.equal(ui.active(), row); assert.equal(ui.popup.scrollTop, 27); assert.equal(ui.document.activeElement, ui.input);
  ui.control.setMembers([defaultMembers[0]!], "group-one");
  assert.equal(ui.active()!.dataset.memberId, "writer"); assert.equal(ui.popup.children.length, 1);
});

test("独立草稿保存身份，切群关闭候选；过期或未就绪的已选成员阻止发送，移除标签同步删正文", () => {
  const ui = fixture(); ui.type("@"); ui.popup.children[1]!.fire("click"); const draft = ui.control.snapshot();
  ui.control.setMembers([member("other", "其他成员")], "group-two"); ui.control.restore();
  assert.equal(ui.input.value, ""); assert.equal(ui.selected.hidden, true);
  ui.control.setMembers(defaultMembers, "group-one"); ui.control.restore(draft);
  assert.equal(ui.control.requestMentions()[0]!.memberId, "researcher");
  ui.control.setMembers([defaultMembers[0]!, { ...defaultMembers[1]!, ready: false }], "group-one");
  assert.throws(() => ui.control.requestMentions(), /尚未就绪/);
  ui.control.setMembers([defaultMembers[0]!], "group-one");
  assert.throws(() => ui.control.requestMentions(), /已移出群组/);
  ui.selected.children[0]!.fire("click"); assert.equal(ui.input.value.trim(), ""); assert.deepEqual(ui.control.requestMentions(), []);
  assert.equal(ui.selected.hidden, true);
});

test("点击选项保留文本框焦点，外部交互关闭；全部不可用及空结果不会拦截 Tab", () => {
  const ui = fixture([member("a", "未就绪成员", false)]); ui.type("@");
  assert.equal(ui.active(), undefined); assert.equal(ui.input.fire("keydown", { key: "Tab" }).defaultPrevented, undefined);
  ui.type("@不存在"); assert.match(ui.popup.textContent, /没有匹配/);
  assert.equal(ui.popup.fire("pointerdown").defaultPrevented, true);
  ui.document.fire("pointerdown", { target: ui.document.createElement("button") }); assert.equal(ui.popup.inert, true);
});

test("移除同一成员的重复提及不破坏其他成员绑定，发送成功重置后标签消失", () => {
  const ui = fixture(); ui.type("@"); ui.popup.children[0]!.fire("click");
  ui.type(`${ui.input.value}@`); ui.popup.children[1]!.fire("click");
  ui.type(`${ui.input.value}@`); ui.popup.children[0]!.fire("click");
  assert.equal(ui.selected.children.length, 2); ui.selected.children[0]!.fire("click");
  assert.deepEqual(ui.control.requestMentions(), [{ memberId: "researcher", start: 0, end: 6, text: "@资料研究员" }]);
  ui.control.restore(); assert.equal(ui.selected.hidden, true); assert.deepEqual(ui.control.requestMentions(), []);
});
