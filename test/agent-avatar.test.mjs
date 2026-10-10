import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { avatarShapes, avatarColors, avatarIcon, parseAvatarIcon, resolveAgentAvatar, avatarFaceLayout } from "../public/agent-avatar.js";
import { avatarPointerPose, advanceAvatarPose, restingAvatarPose, installAvatarMotion } from "../public/agent-avatar-motion.js";

test("六种造型八种配色能无损保存到现有图标字段，非法选择不变成路径或样式", () => {
  const icons = new Set();
  for (const shape of avatarShapes) for (const color of avatarColors) {
    const icon = avatarIcon({ shape: shape.id, color: color.id });
    icons.add(icon); assert.ok(icon.length <= 16);
    assert.deepEqual(parseAvatarIcon(icon), { shape: shape.id, color: color.id });
    assert.deepEqual(resolveAgentAvatar({ id: "one", profile: { icon } }), { type: "star", shape: shape.id, color: color.id, icon });
  }
  assert.equal(icons.size, 48);
  for (const icon of [null, {}, "star:6:0", "star:0:8", "star:01:1", "star:0:0; color:red", "star:../../a:1"])
    assert.equal(parseAvatarIcon(icon), null);
  assert.throws(() => avatarIcon({ shape: "../../a", color: "mint" }), TypeError);
  assert.throws(() => avatarIcon({ shape: "cut", color: "red;" }), TypeError);
});

test("默认造型按稳定ID分配，改名、刷新和缺失资料都不改组合，旧图标仍是文本", () => {
  const previous = resolveAgentAvatar({ id: "stable-id", name: "旧名称" });
  assert.deepEqual(resolveAgentAvatar({ id: "stable-id", name: "新名称", profile: { icon: "  " } }), previous);
  assert.deepEqual(resolveAgentAvatar(JSON.parse(JSON.stringify({ id: "stable-id", profile: {} }))), previous);
  assert.deepEqual(resolveAgentAvatar({ id: "stable-id", profile: { icon: "star:9:9" } }), previous);
  assert.deepEqual(resolveAgentAvatar({ id: "stable-id", profile: { icon: " 📝 " } }), { type: "text", text: "📝" });
  assert.deepEqual(resolveAgentAvatar({ id: "stable-id", profile: { icon: "<img>" } }), { type: "text", text: "<img>" });
});

test("所有生产图形资源独立可用且坐标尺寸一致，小头像与大头像使用相同比例", async () => {
  for (const file of [...avatarShapes.map((shape) => `${shape.id}-mask.png`), "core.png"]) {
    const bytes = await readFile(new URL(`../public/assets/avatars/${file}`, import.meta.url));
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    assert.equal(bytes.readUInt32BE(16), 256); assert.equal(bytes.readUInt32BE(20), 256);
    assert.ok(bytes.length > 500 && bytes.length < 100_000);
  }
});

test("靠近区域可转向，左右上下跟随对称；小头像幅度和圆核位移受控", () => {
  for (const size of [28, 32, 48, 112]) {
    const right = avatarPointerPose({ dx: size, dy: 0, size });
    const left = avatarPointerPose({ dx: -size, dy: 0, size });
    assert.ok(right.ry > 0 && left.ry < 0); assert.equal(right.ry, -left.ry);
    assert.ok(right.cx > 0 && left.cx < 0); assert.equal(right.scale, left.scale);
    assert.ok(right.scale <= (size < 80 ? 1.025 : 1.035));
    assert.ok(Math.abs(right.ry) <= (size < 80 ? 4.5 : 9));
    assert.ok(Math.abs(right.cx) <= size * .02);
    assert.ok(avatarPointerPose({ dx: 0, dy: size, size }).rx < 0);
    assert.ok(avatarPointerPose({ dx: 0, dy: -size, size }).rx > 0);
    assert.deepEqual(avatarPointerPose({ dx: 1000, dy: 1000, size }), restingAvatarPose());
  }
  for (const size of [0, -1, NaN]) assert.deepEqual(avatarPointerPose({ dx: 1, dy: 1, size }), restingAvatarPose());
});

test("内部可见图案按外壳视觉中心定位，盾形上移且菱形收小，画布留白不参与居中", () => {
  const centers = { cut: [124, 130], shield: [128, 118], trapezoid: [128, 135],
    disc: [128, 127], diamond: [128, 128], pentagon: [128, 132] };
  for (const shape of avatarShapes) {
    const layout = avatarFaceLayout(shape.id), scale = layout.size / 100;
    const center = [layout.left / 100 * 256 + 139 * scale, layout.top / 100 * 256 + 134 * scale];
    assert.ok(Math.abs(center[0] - centers[shape.id][0]) < .01);
    assert.ok(Math.abs(center[1] - centers[shape.id][1]) < .01);
    assert.ok(scale >= .9 && scale <= 1);
    assert.ok(layout.left / 100 * 256 + 94 * scale > 40);
    assert.ok(layout.top / 100 * 256 + 177 * scale < 185);
  }
  assert.ok(avatarShapes.find((shape) => shape.id === "shield").face.y < 128);
  assert.ok(avatarFaceLayout("diamond").size < avatarFaceLayout("cut").size);
  assert.throws(() => avatarFaceLayout("unknown"), TypeError);
});

test("六种图案的跟随位移控制在校准中心附近，尖底或尖角造型幅度更轻", () => {
  for (const shape of avatarShapes) for (const size of [32, 112]) {
    const pose = avatarPointerPose({ dx: size * .5, dy: size * .5, size, shape: shape.id });
    const limit = ["shield", "diamond"].includes(shape.id) ? .018 : .02;
    assert.ok(Math.abs(pose.cx) <= size * limit && Math.abs(pose.cy) <= size * limit);
    assert.ok(pose.cx > 0 && pose.cy > 0);
  }
});

test("移开后逐渐回正并收敛，不留下持续更新的微小误差", () => {
  let pose = avatarPointerPose({ dx: 30, dy: -20, size: 112 });
  const target = restingAvatarPose(), initial = pose.ry;
  const first = advanceAvatarPose(pose, target, 16);
  assert.ok(first.pose.ry > 0 && first.pose.ry < initial); assert.equal(first.moving, true);
  let result;
  for (let index = 0; index < 120; index++) { result = advanceAvatarPose(pose, target, 16); pose = result.pose; }
  assert.deepEqual(pose, target); assert.equal(result.moving, false);
});

function motionFixture() {
  class Events {
    listeners = new Map();
    addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]); }
    removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== callback)); }
    emit(type, fields = {}) { for (const callback of this.listeners.get(type) || []) callback(fields); }
  }
  const reduce = Object.assign(new Events(), { matches: false });
  const document = Object.assign(new Events(), { hidden: false });
  const frames = new Map(); let frameId = 0, time = 0;
  const window = Object.assign(new Events(), { matchMedia: () => reduce,
    requestAnimationFrame: (callback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id) => frames.delete(id) });
  let mutationCallback;
  window.MutationObserver = class {
    constructor(callback) { mutationCallback = callback; }
    observe() {}
    disconnect() { mutationCallback = null; }
  };
  const world = { style: {} }, core = { style: {} }, bounds = { left: 100, top: 100, width: 32, height: 32 };
  const element = { isConnected: true, dataset: { shape: "shield" }, getBoundingClientRect: () => bounds,
    querySelector: (selector) => selector === ".star-avatar-world" ? world : core };
  let scope = null;
  document.querySelectorAll = () => [element]; document.querySelector = () => scope;
  const flush = () => { const entries = [...frames]; frames.clear(); time += 16; for (const [, callback] of entries) callback(time); };
  const settle = () => { for (let i = 0; frames.size && i < 200; i++) flush(); assert.equal(frames.size, 0); };
  return { document, window, reduce, frames, world, core, bounds, element, flush, settle,
    mutate: (record) => mutationCallback?.([record]),
    modal: () => { scope = { querySelectorAll: () => [] }; },
    move: (x = 142, y = 110, pointerType = "mouse") => document.emit("pointermove", { clientX: x, clientY: y, pointerType }) };
}

test("真实委托控制器跟随、空闲停帧、离开复位且安装幂等", () => {
  const fixture = motionFixture(), dispose = installAvatarMotion(fixture.document, fixture.window);
  assert.equal(installAvatarMotion(fixture.document, fixture.window), dispose);
  fixture.move(); fixture.settle(); assert.doesNotMatch(fixture.core.style.transform, /translate3d\(0\.000px, 0\.000px/);
  assert.match(fixture.world.style.transform, /rotateY\([1-9]/);
  fixture.document.emit("pointerout", { relatedTarget: null }); fixture.settle();
  assert.match(fixture.world.style.transform, /rotateY\(0\.000deg\).*scale\(1\.00000\)/);
  dispose(); fixture.move(); assert.equal(fixture.frames.size, 0);
});

test("触屏不触发跟随，减少动态效果即时回正，隐藏头像和页面也清理状态", () => {
  const fixture = motionFixture(); installAvatarMotion(fixture.document, fixture.window);
  fixture.move(142, 110, "touch"); assert.equal(fixture.frames.size, 0);
  fixture.move(); fixture.settle();
  fixture.reduce.matches = true; fixture.reduce.emit("change");
  assert.match(fixture.world.style.transform, /scale\(1\.00000\)/); assert.equal(fixture.frames.size, 0);
  fixture.move(); assert.equal(fixture.frames.size, 0);
  fixture.reduce.matches = false; fixture.reduce.emit("change"); fixture.move(); fixture.flush();
  fixture.bounds.width = 0; fixture.settle(); assert.match(fixture.world.style.transform, /scale\(1\.00000\)/);
  fixture.bounds.width = 32; fixture.move(); fixture.flush(); fixture.document.hidden = true; fixture.document.emit("visibilitychange");
  assert.match(fixture.world.style.transform, /scale\(1\.00000\)/); assert.equal(fixture.frames.size, 0);
});

test("打开弹窗后鼠标只影响前景里的头像，背景头像平滑回正", () => {
  const fixture = motionFixture(); installAvatarMotion(fixture.document, fixture.window);
  fixture.move(); fixture.settle(); fixture.modal(); fixture.move(); fixture.settle();
  assert.match(fixture.world.style.transform, /scale\(1\.00000\)/);
});

test("鼠标静止且已停帧时切换路由、弹窗或隐藏资料页，也不会留下倾斜姿态", () => {
  const fixture = motionFixture(); installAvatarMotion(fixture.document, fixture.window);
  fixture.move(); fixture.settle(); fixture.document.emit("neuma:route");
  assert.match(fixture.world.style.transform, /scale\(1\.00000\)/); assert.equal(fixture.frames.size, 0);
  fixture.move(); fixture.settle(); fixture.mutate({ attributeName: "open", target: { tagName: "DIALOG" } });
  assert.match(fixture.world.style.transform, /scale\(1\.00000\)/); assert.equal(fixture.frames.size, 0);
  fixture.move(); fixture.settle(); fixture.mutate({ attributeName: "hidden", target: { contains: () => true } });
  assert.match(fixture.world.style.transform, /scale\(1\.00000\)/); assert.equal(fixture.frames.size, 0);
});
