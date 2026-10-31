import type {MotionAvatar,MotionScope,MotionMutation} from "../../public/agent-avatar-motion.js";
import { fixtureText } from "../helpers/m7-test-boundaries.mjs";
import { objectFields } from "../../src/runtime/type-boundary.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { avatarShapes, avatarColors, avatarIcon, parseAvatarIcon, resolveAgentAvatar, avatarFaceLayout } from "../../public/agent-avatar.js";
import { avatarPointerPose, advanceAvatarPose, restingAvatarPose, installAvatarMotion } from "../../public/agent-avatar-motion.js";

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
  assert.deepEqual(resolveAgentAvatar(JSON.parse(String(JSON.stringify({ id: "stable-id", profile: {} })))), previous);
  assert.deepEqual(resolveAgentAvatar({ id: "stable-id", profile: { icon: "star:9:9" } }), previous);
  assert.deepEqual(resolveAgentAvatar({ id: "stable-id", profile: { icon: " 📝 " } }), { type: "text", text: "📝" });
  assert.deepEqual(resolveAgentAvatar({ id: "stable-id", profile: { icon: "<img>" } }), { type: "text", text: "<img>" });
});

test("所有生产图形资源独立可用且坐标尺寸一致，小头像与大头像使用相同比例", async () => {
  for (const file of [...avatarShapes.map((shape) => `${shape.id}-mask.png`), "core.png"]) {
    const bytes = await readFile(new URL(`../../public/assets/avatars/${file}`, import.meta.url));
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    assert.equal(bytes.readUInt32BE(16), 256); assert.equal(bytes.readUInt32BE(20), 256);
    assert.ok(bytes.length > 500 && bytes.length < 100_000);
  }
});

test("内核旋转和跟随变形始终留在六种外壳内部", async () => {
  const decode = async (name: string) => sharp(await readFile(new URL(`../../public/assets/avatars/${name}.png`, import.meta.url)))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const core = await decode("core");
  let radius = 0;
  for (let y = 0; y < core.info.height; y++) for (let x = 0; x < core.info.width; x++) {
    if (core.data![(y * core.info.width + x) * 4 + 3]! > 0) radius = Math.max(radius, Math.hypot(x - 139, y - 134));
  }
  for (const { id, face } of avatarShapes) {
    const mask = await decode(`${id}-mask`);
    let inradius = Infinity;
    for (let y = 0; y < mask.info.height; y++) for (let x = 0; x < mask.info.width; x++) {
      const offset = (y * mask.info.width + x) * 4;
      const coverage = (.2126 * mask.data![offset]! + .7152 * mask.data![offset + 1]! + .0722 * mask.data![offset + 2]!) * mask.data![offset + 3]! / 255;
      if (coverage < 128) inradius = Math.min(inradius, Math.hypot(x - face.x, y - face.y));
    }
    // Enclosing every visible core pixel in a circle checks all angles, including between keyframes.
    const clearance = inradius - Math.SQRT1_2 - (radius + Math.SQRT1_2) * face.scale;
    assert.ok(clearance * 32 / 256 >= 3, `${id}: full-rotation clearance must remain at least 3px at sidebar size`);
    for (const size of [32, 112]) for (const distance of [.25, .5, .75, 1, 2]) for (let angle = 0; angle < 360; angle += 15) {
      const radians = angle * Math.PI / 180;
      const target = avatarPointerPose({ dx: Math.cos(radians) * size * distance, dy: Math.sin(radians) * size * distance, size, shape: id });
      let next = advanceAvatarPose(restingAvatarPose(), target, 16);
      for (let frame = 0; frame < 45; frame++) {
        const p = next.pose;
        const minStretch = (p.sx + p.sy - Math.hypot(p.sx - p.sy, 2 * p.sxy)) / 2;
        const centerDrift = Math.hypot((p.sx - 1) * (face.x - 128) + p.sxy * (face.y - 128),
          p.sxy * (face.x - 128) + (p.sy - 1) * (face.y - 128));
        const gap = (inradius - Math.SQRT1_2) * minStretch - centerDrift
          - (radius + Math.SQRT1_2) * face.scale - Math.hypot(p.cx, p.cy) / size * 256;
        assert.ok(gap * 32 / 256 >= 1, `${id}: moving face must keep 1px clearance even during spring overshoot`);
        next = advanceAvatarPose(p, target, 16, next.velocity);
      }
    }
  }
});

test("真实外壳按CSS幅度连续摇摆和缩放，32px头像始终保留至少1px外边距", async () => {
  const css = (await readFile(new URL("../../public/style.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const scalesFor = (selector: string) => Object.fromEntries(rules
    .filter(([, selectors]) => selectors!.split!(",").some((value) => value.trim() === selector))
    .flatMap(([, , body]) => [...body!.matchAll!(/--avatar-scale-([\w-]+)\s*:\s*([^;]+)/g)]
      .map(([, name, value]) => [name, Number(value!.trim!())])));
  const sway = css.match(/@keyframes\s+star-avatar-sway\s*\{((?:[^{}]|\{[^{}]*\})*)\}/)?.[1];
  assert.ok(sway, "read the production sway keyframes before checking their geometry");
  const transforms = [...sway.matchAll(/transform\s*:\s*([^;}]+)/g)].map(([, value]) => value!.trim!());
  assert.ok(transforms.length > 0);
  const angles: ((number))[] = [], scaleNames = new Set<string>();
  for (const transform of transforms) {
    const rotate = /rotate\(\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))deg\s*\)/;
    const scale = /scale\(\s*var\(\s*--avatar-scale-([\w-]+)\s*\)\s*\)/;
    assert.match(transform, rotate); assert.match(transform, scale);
    assert.equal(transform.replace(rotate, "").replace(scale, "").trim(), "", "extend the geometry check when adding another transform");
    angles.push(Number(transform.match!(rotate)![1]) * Math.PI / 180);
    scaleNames.add(transform.match!(scale)![1]!);
  }
  const minAngle = Math.min(...angles), maxAngle = Math.max(...angles), defaults = scalesFor(".star-avatar");
  for (const { id } of avatarShapes) {
    const scales = { ...defaults, ...scalesFor(`.star-avatar[data-shape="${id}"]`) };
    const values = [...scaleNames].map((name) => scales[name]);
    assert.ok(values.every((value) => Number.isFinite(value) && value > 0), `${id}: all sway scale parameters must be positive numbers`);
    const peak = Math.max(...values);
    const { data, info } = await sharp(await readFile(new URL(`../../public/assets/avatars/${id}-mask.png`, import.meta.url)))
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let extent = 0, visiblePixels = 0;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * 4;
      const coverage = (.2126 * data[offset]! + .7152 * data[offset + 1]! + .0722 * data[offset + 2]!) * data[offset + 3]! / 255;
      if (coverage < 8) continue;
      visiblePixels++;
      for (const [cornerX, cornerY] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const px = x + cornerX! - info.width / 2, py = y + cornerY! - info.height / 2;
        const candidates = [minAngle, maxAngle];
        // Coordinate extrema occur at interval endpoints or zero derivatives, so this covers every angle between keyframes.
        for (const stationary of [Math.atan2(-py, px), Math.atan2(px, py)]) {
          for (let turn = Math.ceil((minAngle - stationary) / Math.PI); turn <= Math.floor((maxAngle - stationary) / Math.PI); turn++)
            candidates.push(stationary + turn * Math.PI);
        }
        for (const angle of candidates) {
          const cosine = Math.cos(angle), sine = Math.sin(angle);
          extent = Math.max(extent, Math.abs(px * cosine - py * sine), Math.abs(px * sine + py * cosine));
        }
      }
    }
    assert.ok(visiblePixels > 0, `${id}: the mask must contain a visible shell`);
    const margin = (Math.min(info.width, info.height) / 2 - extent * peak) * 32 / info.width;
    assert.ok(margin + 1e-6 >= 1, `${id}: CSS sway leaves ${margin.toFixed(3)}px; sidebar avatars need at least 1px outside the shell`);
  }
});

test("靠近时明显转向，左右上下跟随对称且幅度受控", () => {
  for (const size of [28, 32, 48, 112]) {
    const right = avatarPointerPose({ dx: size * .5, dy: 0, size });
    const left = avatarPointerPose({ dx: -size * .5, dy: 0, size });
    assert.ok(right.ry > 0 && left.ry < 0); assert.equal(right.ry, -left.ry);
    assert.ok(right.cx > 0 && left.cx < 0); assert.equal(right.scale, left.scale);
    assert.ok(right.scale <= 1.04);
    assert.ok(right.ry >= 6 && right.ry <= 16, "nearby pointer must produce a visible turn");
    assert.ok(right.cx >= size * .03 && right.cx <= size * .06, "face follows without reaching the shell edge");
    assert.ok(right.cr >= 25 && left.cr <= -25, "mouth visibly swivels with the pointer");
    assert.equal(right.cr, -left.cr);
    assert.ok(right.sx > 1.06 && right.sy < .98, "shell stretches toward the pointer and compresses across it");
    const down = avatarPointerPose({ dx: 0, dy: size * .5, size });
    assert.ok(down.sy > 1.06 && down.sx < .98);
    assert.ok(avatarPointerPose({ dx: 0, dy: size, size }).rx < 0);
    assert.ok(avatarPointerPose({ dx: 0, dy: -size, size }).rx > 0);
    assert.deepEqual(avatarPointerPose({ dx: 1000, dy: 1000, size }), restingAvatarPose());
  }
  for (const size of [0, -1, NaN]) assert.deepEqual(avatarPointerPose({ dx: 1, dy: 1, size }), restingAvatarPose());
});

test("内部可见图案按外壳视觉中心定位，盾形上移且菱形收小，画布留白不参与居中", () => {
  const centers:Record<string,number[]> = { cut: [124, 130], shield: [128, 118], trapezoid: [128, 135],
    disc: [128, 127], diamond: [128, 128], pentagon: [128, 132] };
  for (const shape of avatarShapes) {
    const layout = avatarFaceLayout(shape.id), scale = layout.size / 100;
    const center = [layout.left / 100 * 256 + 139 * scale, layout.top / 100 * 256 + 134 * scale];
    assert.ok(Math.abs(center[0]! - centers[shape.id]![0]!) < .01);
    assert.ok(Math.abs(center[1]! - centers[shape.id]![1]!) < .01);
    assert.ok(scale >= .9 && scale <= 1);
    assert.ok(layout.left / 100 * 256 + 94 * scale > 40);
    assert.ok(layout.top / 100 * 256 + 177 * scale < 185);
  }
  assert.ok(avatarShapes.find!((shape) => shape.id === "shield")!.face.y < 128);
  assert.ok(avatarFaceLayout("diamond").size < avatarFaceLayout("cut").size);
  assert.throws(() => avatarFaceLayout("unknown"), TypeError);
});

test("六种图案斜向跟随和伸缩连续，尖底或尖角造型的圆核位移更轻", () => {
  for (const shape of avatarShapes) for (const size of [32, 112]) {
    const pose = avatarPointerPose({ dx: size * .5, dy: size * .5, size, shape: shape.id });
    const limit = ["shield", "diamond"].includes(shape.id) ? .045 : .055;
    assert.ok(Math.hypot(pose.cx, pose.cy) <= size * limit);
    assert.ok(pose.cx > 0 && pose.cy > 0);
    assert.ok(pose.sxy > 0, "diagonal pull must deform along the diagonal");
    const opposite = avatarPointerPose({ dx: -size * .5, dy: size * .5, size, shape: shape.id });
    assert.equal(pose.sxy, -opposite.sxy);
  }
});

test("移开后柔和回弹并收敛，不留下持续更新的微小误差", () => {
  let pose = avatarPointerPose({ dx: 30, dy: -20, size: 112 });
  const target = restingAvatarPose(), initial = pose.ry;
  const first = advanceAvatarPose(pose, target, 16);
  assert.ok(first.pose.ry > 0 && first.pose.ry < initial); assert.equal(first.moving, true);
  let result = first, overshoot = 0;
  for (let index = 0; index < 120; index++) {
    result = advanceAvatarPose(result.pose, target, 16, result.velocity);
    overshoot = Math.min(overshoot, result.pose.ry);
  }
  assert.ok(overshoot < 0 && overshoot > -initial * .05, "return has a small, bounded spring rebound");
  assert.deepEqual(result.pose, target); assert.equal(result.moving, false);
  assert.ok(Object.values(result.velocity).every((value) => value === 0));
});

function motionFixture() {
  class Events {
    listeners=new Map<string,(((event:Pick<PointerEvent,"clientX"|"clientY"|"pointerType">)=>unknown)|((event:Pick<PointerEvent,"relatedTarget">)=>unknown)|(()=>unknown))[]>();
    addEventListener(type:string,callback:((event:Pick<PointerEvent,"clientX"|"clientY"|"pointerType">)=>unknown)|((event:Pick<PointerEvent,"relatedTarget">)=>unknown)|(()=>unknown)){this.listeners.set(type,[...(this.listeners.get(type)||[]),callback]);}
    removeEventListener(type:string,callback:((event:Pick<PointerEvent,"clientX"|"clientY"|"pointerType">)=>unknown)|((event:Pick<PointerEvent,"relatedTarget">)=>unknown)|(()=>unknown)){this.listeners.set(type,(this.listeners.get(type)||[]).filter(item=>item!==callback));}
    emit(type:string,fields:Partial<Pick<PointerEvent,"clientX"|"clientY"|"pointerType"|"relatedTarget">>={}){for(const callback of this.listeners.get(type)||[])Reflect.apply(callback,this,[fields]);}
  }
  const reduce = Object.assign(new Events(), { matches: false });
  class DocumentEvents extends Events {declare documentElement:undefined;declare querySelectorAll:()=>MotionAvatar[];declare querySelector:()=>MotionScope|null;}
  const document = Object.assign(new DocumentEvents(),{hidden:false});
  const frames = new Map<number,(time:number)=>unknown>(); let frameId = 0, time = 0;
  class WindowEvents extends Events {declare MutationObserver:typeof Observer;}
  const window = Object.assign(new WindowEvents(), { matchMedia: () => reduce,
    requestAnimationFrame: (callback:(time:number)=>unknown) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id:number) => frames.delete(id) });
  let mutationCallback:((records:MotionMutation[])=>void)|null;
  class Observer {
    constructor(callback:(records:MotionMutation[])=>void) { mutationCallback! = callback; }
    observe() {}
    disconnect() { mutationCallback = null; }
  }
  window.MutationObserver=Observer;
  const world = { style: {} as {transform:string} }, core = { style: {} as {transform:string} }, shell = { style: {} as {transform:string} }, bounds = { left: 100, top: 100, width: 32, height: 32 };
  const element = { isConnected: true, dataset: {shape:"shield"} as {shape:string;activity?:string}, getBoundingClientRect: () => bounds,
    querySelector: (selector: string) => selector === ".star-avatar-world" ? world : selector === ".star-avatar-shell" ? shell : core };
  let scope: { querySelectorAll: () => never[]; }|null = null;
  document.querySelectorAll = () => [element]; document.querySelector = () => scope;
  const flush = () => { const entries = [...frames]; frames.clear(); time += 16; for (const [, callback] of entries) callback(time); };
  const settle = () => { for (let i = 0; frames.size && i < 200; i++) flush(); assert.equal(frames.size, 0); };
  return { document, window, reduce, frames, world, core, shell, bounds, element, flush, settle,
    mutate: (record:MotionMutation) => mutationCallback?.([record]),
    modal: () => { scope = { querySelectorAll: () => [] }; },
    move: (x = 142, y = 110, pointerType = "mouse") => document.emit("pointermove", { clientX: x, clientY: y, pointerType }) };
}

test("真实委托控制器跟随、空闲停帧、离开复位且安装幂等", () => {
  const fixture = motionFixture(), dispose = installAvatarMotion(fixture.document, fixture.window);
  assert.equal(installAvatarMotion(fixture.document, fixture.window), dispose);
  fixture.move(); fixture.settle(); assert.doesNotMatch(fixtureText(objectFields(fixture.core.style).transform), /translate3d\(0\.000px, 0\.000px/);
  assert.match(fixtureText(objectFields(fixture.world.style).transform), /rotateY\([1-9]/);
  assert.doesNotMatch(fixture.core.style.transform, /rotate\(0\.000deg\)/);
  const stretched = fixture.shell.style.transform.match(/matrix\(([^)]+)\)/)![1]!.split(",").map(Number);
  assert.ok(stretched[0]! > 1 && stretched[3]! < 1, "controller must apply the deformation to the actual shell");
  fixture.document.emit("pointerout", { relatedTarget: null }); fixture.settle();
  assert.match(fixtureText(objectFields(fixture.world.style).transform), /rotateY\(0\.000deg\).*scale\(1\.00000\)/);
  assert.match(fixture.core.style.transform, /rotate\(0\.000deg\)/);
  assert.equal(fixture.shell.style.transform, "matrix(1.00000, 0.00000, 0.00000, 1.00000, 0, 0)");
  dispose!(); fixture.move(); assert.equal(fixture.frames.size, 0);
});

test("忙碌状态立即清除已停帧的鼠标姿态，持续移动不会叠加，待机后恢复跟随", () => {
  const fixture = motionFixture(); installAvatarMotion(fixture.document, fixture.window);
  fixture.move(); fixture.settle();
  assert.match(fixtureText(objectFields(fixture.world.style).transform), /rotateY\([1-9]/);
  for (const activity of ["thinking", "working", "queued"]) {
    fixture.element.dataset.activity = activity;
    fixture.mutate({ attributeName: "data-activity", target: fixture.element });
    assert.match(fixtureText(objectFields(fixture.world.style).transform), /rotateY\(0\.000deg\).*scale\(1\.00000\)/);
    assert.match(fixtureText(objectFields(fixture.core.style).transform), /translate3d\(0\.000px, 0\.000px/);
    fixture.move(); fixture.settle();
    assert.match(fixtureText(objectFields(fixture.world.style).transform), /rotateY\(0\.000deg\).*scale\(1\.00000\)/);
  }
  fixture.element.dataset.activity = "idle";
  fixture.move(); fixture.settle(); assert.match(fixtureText(objectFields(fixture.world.style).transform), /rotateY\([1-9]/);
});

test("触屏不触发跟随，减少动态效果即时回正，隐藏头像和页面也清理状态", () => {
  const fixture = motionFixture(); installAvatarMotion(fixture.document, fixture.window);
  fixture.move(142, 110, "touch"); assert.equal(fixture.frames.size, 0);
  fixture.move(); fixture.settle();
  fixture.reduce.matches = true; fixture.reduce.emit("change");
  assert.match(fixtureText(objectFields(fixture.world.style).transform), /scale\(1\.00000\)/); assert.equal(fixture.frames.size, 0);
  fixture.move(); assert.equal(fixture.frames.size, 0);
  fixture.reduce.matches = false; fixture.reduce.emit("change"); fixture.move(); fixture.flush();
  fixture.bounds.width = 0; fixture.settle(); assert.match(fixtureText(objectFields(fixture.world.style).transform), /scale\(1\.00000\)/);
  fixture.bounds.width = 32; fixture.move(); fixture.flush(); fixture.document.hidden = true; fixture.document.emit("visibilitychange");
  assert.match(fixtureText(objectFields(fixture.world.style).transform), /scale\(1\.00000\)/); assert.equal(fixture.frames.size, 0);
});

test("打开弹窗后鼠标只影响前景里的头像，背景头像平滑回正", () => {
  const fixture = motionFixture(); installAvatarMotion(fixture.document, fixture.window);
  fixture.move(); fixture.settle(); fixture.modal(); fixture.move(); fixture.settle();
  assert.match(fixtureText(objectFields(fixture.world.style).transform), /scale\(1\.00000\)/);
});

test("鼠标静止且已停帧时切换路由、弹窗或隐藏资料页，也不会留下倾斜姿态", () => {
  const fixture = motionFixture(); installAvatarMotion(fixture.document, fixture.window);
  fixture.move(); fixture.settle(); fixture.document.emit("neuma:route");
  assert.match(fixtureText(objectFields(fixture.world.style).transform), /scale\(1\.00000\)/); assert.equal(fixture.frames.size, 0);
  fixture.move(); fixture.settle(); fixture.mutate({ attributeName: "open", target: { tagName: "DIALOG" } });
  assert.match(fixtureText(objectFields(fixture.world.style).transform), /scale\(1\.00000\)/); assert.equal(fixture.frames.size, 0);
  fixture.move(); fixture.settle(); fixture.mutate({ attributeName: "hidden", target: { contains: () => true } });
  assert.match(fixtureText(objectFields(fixture.world.style).transform), /scale\(1\.00000\)/); assert.equal(fixture.frames.size, 0);
});
