import test from "node:test";
import assert from "node:assert/strict";
import { renderGroupAvatar } from "../../public/group-avatar.js";
import { resolveAgentAvatar } from "../../public/agent-avatar.js";

function avatarDocument() {
  const document:{listeners:number;createElement(tagName:string):Element;addEventListener():void} = {listeners:0,createElement:(tagName)=>new Element(tagName),addEventListener:()=>{document.listeners++;}};
  class Element {
    declare tagName:string;declare ownerDocument:typeof document;declare text:string|undefined;
    constructor(tagName: string) { this.tagName = tagName.toUpperCase(); this.ownerDocument = document; }
    children:Element[] = []; dataset:Record<string,string> = {}; attributes = new Map<string,string>(); className = ""; replacements = 0;
    classList = {
      add: (...names:string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      contains: (name: string) => this.className.split(/\s+/).includes(name),
      toggle: (name: string, force: unknown) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        if (force ?? !names.has(name)) names.add(name); else names.delete(name);
        this.className = [...names].join(" ");
      },
    };
    get textContent():string { return this.text ?? this.children.map((child) => child.textContent).join(""); }
    set textContent(value) { this.text = String(value); this.children = []; }
    replaceChildren(...children: unknown[]) { this.replacements++; this.text = ""; this.children = children as Element[]; }
    append(...children: unknown[]) { this.children.push(...children as Element[]); }
    setAttribute(name:string, value: unknown) { this.attributes.set(name, String(value)); }
    getAttribute(name:string) { return this.attributes.get(name) ?? null; }
    addEventListener() { document.listeners++; }
    querySelector(selector:string) { return descendants(this).find((element) => element !== this && element.classList.contains(selector.slice(1))) ?? null; }
  }
  document.createElement = (tagName: string) => new Element(tagName);
  document.addEventListener = () => { document.listeners++; };
  return document;
}

type AvatarNode=ReturnType<ReturnType<typeof avatarDocument>["createElement"]>;
function descendants(element:AvatarNode):AvatarNode[] { return [element, ...element.children.flatMap(descendants)]; }
function roots(target:AvatarNode) { return descendants(target).filter((element) => element.classList.contains("star-avatar")); }

test("群头像依成员顺序显示一至四个星核，更多成员只保留前四个", () => {
  const document = avatarDocument(), target = document.createElement("span");
  const memberIds = ["a", "b", "c", "d", "e"];
  for (const count of [1, 2, 3, 4, 5]) {
    renderGroupAvatar(target, { memberIds: memberIds.slice(0, count) });
    assert.equal(target.dataset.memberCount, String(Math.min(count, 4)));
    assert.deepEqual(target.children.map((element) => element.dataset.memberId), memberIds.slice(0, Math.min(count, 4)));
    assert.equal(roots(target).length, Math.min(count, 4));
    assert.ok(target.children.every((element: { classList: { contains: (arg0: string) => unknown; }; }) => element.classList.contains("group-avatar-member")));
    assert.ok(roots(target).every((element) => element.dataset.avatarMotion === "false" && element.dataset.activity === "idle"));
  }
  assert.equal(target.classList.contains("group-avatar"), true);
  assert.equal(target.getAttribute("aria-hidden"), "true");
  assert.equal(document.listeners, 0);
});

test("群头像保留各成员选定的造型颜色，缺失资料或旧文字图标按稳定 ID 显示星核", () => {
  const document = avatarDocument(), target = document.createElement("span");
  const members = [{ id: "b", profile: { icon: "star:3:2" } }, { id: "a", profile: { icon: "star:1:1" } },
    { id: "c", profile: { icon: "📝" } }];
  renderGroupAvatar(target, { memberIds: ["a", "b", "c", "missing"] }, members);
  const avatars = roots(target);
  assert.deepEqual(avatars.slice(0, 2).map(({ dataset }) => [dataset.shape, dataset.color]), [["shield", "blue"], ["disc", "orange"]]);
  for (const [index, id] of [[2, "c"], [3, "missing"]] as const) {
    const expected = resolveAgentAvatar({ id }); assert.equal(expected.type,"star"); if(expected.type!=="star") throw new Error("Expected generated avatar");
    assert.equal(avatars[index]!.dataset.shape, expected.shape);
    assert.equal(avatars[index]!.dataset.color, expected.color);
  }
  assert.equal(target.textContent, "");
  assert.equal(members[2]!.profile.icon, "📝");
});

test("无效与重复成员 ID 不占位置，不改输入和个人图标设置", () => {
  const document = avatarDocument(), target = document.createElement("span");
  const group = Object.freeze({ memberIds: Object.freeze([null, 7, "", " ", "a", "a", "b", "c", "d", "e"]) });
  const members = Object.freeze([Object.freeze({ id: "a", profile: Object.freeze({ icon: "star:4:7" }) }),
    Object.freeze({ id: "b", profile: Object.freeze({ icon: "旧头像" }) })]);
  const original = JSON.stringify({ group, members });
  renderGroupAvatar(target, group, members);
  assert.deepEqual(target.children.map((element) => element.dataset.memberId), ["a", "b", "c", "d"]);
  assert.equal(JSON.stringify({ group, members }), original);
  assert.equal(target.children[0]!.dataset.avatarIcon, "star:4:7");
  assert.equal(target.children[1]!.dataset.avatarIcon, resolveAgentAvatar({ id: "b" }).icon);
});

test("相同组合复用节点，成员资料或顺序变化及时更新，空群清除旧头像", () => {
  const document = avatarDocument(), target = document.createElement("span");
  const group = { memberIds: ["a", "b"] }, members = [{ id: "a", profile: { icon: "star:0:0" } }];
  renderGroupAvatar(target, group, members);
  const previous = target.children[0], replacements = target.replacements;
  renderGroupAvatar(target, group, members);
  assert.equal(target.children[0], previous); assert.equal(target.replacements, replacements);
  members[0]!.profile.icon = "star:5:3";
  renderGroupAvatar(target, group, members);
  assert.notEqual(target.children[0], previous); assert.equal(target.children[0]!.dataset.avatarIcon, "star:5:3");
  renderGroupAvatar(target, { memberIds: ["b", "a"] }, members);
  assert.deepEqual(target.children.map((element) => element.dataset.memberId), ["b", "a"]);
  renderGroupAvatar(target, { memberIds: [] }, members);
  assert.equal(target.dataset.memberCount, "0"); assert.equal(target.children.length, 0);
  assert.equal(target.textContent, "");
  renderGroupAvatar(target, null, members);
  assert.equal(target.children.length, 0);
  assert.doesNotThrow(() => renderGroupAvatar(null, group, members));
});
