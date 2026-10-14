import test from "node:test";
import assert from "node:assert/strict";
import { createSidebarAvatarMotion } from "../public/sidebar-motion.js";

function fixture({ reduced = false, animate = true, fault, scrollTop = 0 } = {}) {
  class Events {
    handlers = new Map();
    addEventListener(type, handler) { this.handlers.set(type, [...this.handlers.get(type) ?? [], handler]); }
    emit(type) { for (const handler of this.handlers.get(type) ?? []) handler({ type }); }
  }
  const document = new Events(), window = new Events(), preference = new Events();
  window.innerWidth = 1440; window.innerHeight = 900; preference.matches = reduced;
  const animations = [], measurements = [];
  const rect = (left, top, width = 24, height = 24) => ({ left, top, width, height, right: left + width, bottom: top + height });
  class Element extends Events {
    constructor(kind, { id = "", role = "", key = "", index = 0 } = {}) {
      super(); Object.assign(this, { kind, id, role, key, index });
      this.children = []; this.attributes = new Map(); this.style = {}; this.dataset = {};
      this.classes = new Set(); this.scrollTop = 0;
      this.classList = { add: (...names) => names.forEach((name) => this.classes.add(name)),
        remove: (...names) => names.forEach((name) => this.classes.delete(name)),
        contains: (name) => this.classes.has(name),
        toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
      if (animate) this.animate = (frames, options) => {
        if (fault === "animate") throw new Error("Animation unavailable");
        let resolve, reject;
        const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
        const animation = { frames, options, finished, resolve, reject, progress: 0, cancelled: false,
          cancel() { this.cancelled = true; reject(new Error("cancelled")); } };
        this.animation = animation; animations.push({ element: this, animation }); return animation;
      };
    }
    get firstElementChild() { return this.children[0]; }
    append(child) { child.parent = this; this.children.push(child); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((item) => item !== this); this.parent = null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return name === "href" ? this.key : this.attributes.get(name); }
    descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    querySelectorAll(selector) {
      const nodes = this.descendants();
      if (selector === ".sidebar") return nodes.filter((item) => item.kind === "sidebar");
      if (selector === "#sidebar-scroll") return nodes.filter((item) => item.kind === "scroll");
      if (selector === "[data-avatar-motion]") return nodes.filter((item) => "avatarMotion" in item.dataset);
      return nodes.filter((item) => item.kind === "link" && item.role === (selector.includes("rail") ? "compact" : "expanded"));
    }
    cloneNode(deep) {
      const copy = new Element(this.kind, this); copy.classes = new Set(this.classes);
      copy.attributes = new Map(this.attributes); copy.style = { ...this.style }; copy.dataset = { ...this.dataset };
      if (deep) for (const child of this.children) copy.append(child.cloneNode(true));
      if (this.kind === "shell") measurements.push(copy);
      return copy;
    }
    rootShell() { let current = this; while (current && current.kind !== "shell") current = current.parent; return current; }
    getBoundingClientRect() {
      if (fault === "measure" && this.rootShell()?.classes.has("sidebar-motion-measure")) throw new Error("Cannot measure");
      if (this.kind === "shell") return rect(0, 0, 1440, 900);
      if (this.kind === "sidebar") return rect(0, 0, 240, 900);
      if (this.kind === "scroll") {
        if (this.rootShell().classes.has("sidebar-motion-measure")) this.scrollTop = Math.min(this.scrollTop, this.rootShell().classes.has("sidebar-collapsed") ? 80 : 400);
        return rect(0, 120, this.rootShell().classes.has("sidebar-collapsed") ? 72 : 240, 750);
      }
      if (this.classes.has("sidebar-avatar-flight")) {
        const from = rect(Number.parseFloat(this.style.left), Number.parseFloat(this.style.top), Number.parseFloat(this.style.width), Number.parseFloat(this.style.height));
        const end = this.animation?.frames[1].transform.match(/translate\(([-.\d]+)px, ([-.\d]+)px\) scale\(([-.\d]+), ([-.\d]+)\)/);
        const progress = this.animation?.progress ?? 0;
        return rect(from.left + Number(end?.[1] ?? 0) * progress, from.top + Number(end?.[2] ?? 0) * progress,
          from.width * (1 + (Number(end?.[3] ?? 1) - 1) * progress), from.height * (1 + (Number(end?.[4] ?? 1) - 1) * progress));
      }
      const compact = this.role === "compact", scroll = this.rootShell().querySelector("#sidebar-scroll");
      return rect(compact ? 22 : 36, (compact ? 280 : 400) + this.index * 52 - scroll.scrollTop, compact ? 28 : 24, compact ? 28 : 24);
    }
  }
  const body = new Element("body"), shell = new Element("shell", { id: "app-shell" }), sidebar = new Element("sidebar"), scroll = new Element("scroll");
  body.append(shell); shell.append(sidebar); sidebar.append(scroll); scroll.scrollTop = scrollTop;
  const avatars = { expanded: new Map(), compact: new Map() };
  const add = (key, role, index = 0) => {
    const link = new Element("link", { role, key, index }), avatar = new Element("avatar", { role, key, index });
    const part = new Element("part"); part.dataset.avatarMotion = "true"; avatar.append(part);
    link.append(avatar); scroll.append(link); avatars[role].set(key, avatar); return avatar;
  };
  for (const key of ["#agent/one", "#group/two"]) for (const role of ["expanded", "compact"]) add(key, role, avatars[role].size);
  document.body = body; document.getElementById = (id) => id === "app-shell" ? shell : null;
  document.createElement = (tag) => new Element(tag);
  window.getComputedStyle = (element) => ({ visibility: element.classes.has("sidebar-avatar-in-flight") ? "hidden" : "visible" });
  const motion = createSidebarAvatarMotion({ document, window, reducedMotion: preference });
  const toggle = (collapsed) => { motion.prepare(collapsed); shell.classList.toggle("sidebar-collapsed", collapsed); };
  const ghosts = () => body.children.filter((item) => item.classes.has("sidebar-avatar-flight"));
  return { document, window, preference, body, shell, scroll, avatars, animations, measurements, add, motion, toggle, ghosts };
}

test("same Agent and group avatars move from their actual source to measured destination once", async () => {
  const state = fixture(); state.add("#agent/one", "expanded");
  state.toggle(true);
  assert.equal(state.ghosts().length, 2);
  assert.equal(state.measurements[0].parent, null);
  for (const { element, animation } of state.animations) {
    assert.equal(Number.parseFloat(element.style.top), element.key === "#agent/one" ? 400 : 452);
    assert.equal(animation.options.duration, 320);
    assert.match(animation.frames[1].transform, /translate\(-14px, -120px\) scale/);
    assert.equal(element.getAttribute("aria-hidden"), "true");
    assert.equal(element.firstElementChild.dataset.avatarMotion, "false");
    assert.equal(state.avatars.compact.get(element.key).classes.has("sidebar-avatar-in-flight"), true);
    animation.resolve();
  }
  await Promise.resolve();
  assert.equal(state.ghosts().length, 0);
  assert.equal([...state.avatars.compact.values()].some((avatar) => avatar.classes.has("sidebar-avatar-in-flight")), false);
});

test("rapid reversal continues from in-flight position and old completion cannot remove new flight", async () => {
  const state = fixture(); state.toggle(true);
  const old = state.animations[0]; old.animation.progress = .5;
  const position = old.element.getBoundingClientRect(); old.animation.resolve();
  state.toggle(false);
  const current = state.animations[2];
  assert.equal(Number.parseFloat(current.element.style.left), position.left);
  assert.equal(Number.parseFloat(current.element.style.top), position.top);
  assert.equal(Number.parseFloat(current.element.style.width), position.width);
  assert.equal(old.animation.cancelled, true);
  await Promise.resolve();
  assert.equal(state.ghosts().length, 2);
  assert.equal(state.avatars.expanded.get("#agent/one").classes.has("sidebar-avatar-in-flight"), true);
  state.motion.cancel();
});

test("reduced motion and unavailable animation API leave actual avatars visible", () => {
  for (const options of [{ reduced: true }, { animate: false }]) {
    const state = fixture(options); state.toggle(true);
    assert.equal(state.ghosts().length, 0);
    assert.equal([...state.avatars.compact.values()].some((avatar) => avatar.classes.has("sidebar-avatar-in-flight")), false);
    assert.equal(state.measurements.every((item) => !item.parent), true);
  }
});

test("measurement and animation exceptions clean up clones and restore avatars", () => {
  for (const fault of ["measure", "animate"]) {
    const state = fixture({ fault }); assert.doesNotThrow(() => state.toggle(true));
    assert.equal(state.ghosts().length, 0);
    assert.equal(state.measurements.every((item) => !item.parent), true);
    assert.equal([...state.avatars.expanded.values()].some((avatar) => avatar.classes.has("sidebar-avatar-in-flight")), false);
  }
});

test("avatars outside scrolled viewport do not fly in from invisible positions", () => {
  const state = fixture({ scrollTop: 400 }); state.toggle(true);
  assert.equal(state.ghosts().length, 0);
  assert.equal(state.animations.length, 0);
});

test("target measurement clamps scroll naturally without cancelling on automatic layout clamp", () => {
  const state = fixture({ scrollTop: 200 }); state.toggle(true);
  assert.equal(state.ghosts().length, 2);
  state.scroll.scrollTop = 80; state.scroll.emit("scroll");
  assert.equal(state.ghosts().length, 2);
  state.scroll.scrollTop = 40; state.scroll.emit("scroll");
  assert.equal(state.ghosts().length, 0);
});

test("resize, page scroll, route change, visibility and new reduced-motion preference cancel safely", () => {
  for (const boundary of ["resize", "scroll", "neuma:route", "visibilitychange", "reduced"]) {
    const state = fixture(); state.toggle(true);
    if (boundary === "reduced") { state.preference.matches = true; state.preference.emit("change"); }
    else if (["resize", "scroll"].includes(boundary)) state.window.emit(boundary);
    else state.document.emit(boundary);
    assert.equal(state.ghosts().length, 0, boundary);
    assert.equal(state.animations.every(({ animation }) => animation.cancelled), true, boundary);
    assert.equal([...state.avatars.compact.values()].some((avatar) => avatar.classes.has("sidebar-avatar-in-flight")), false, boundary);
  }
});
