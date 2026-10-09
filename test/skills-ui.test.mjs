import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const controllerSource = (await readFile(new URL("../public/skills.js", import.meta.url), "utf8")).replace(/^import .*;\n/gm, "");
const viewSource = (await readFile(new URL("../public/skills-view.js", import.meta.url), "utf8")).replace(/^export /gm, "");
const settle = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
const sourceFixture = [
  { id: "common", label: "通用技能", path: "/demo/.agents/skills", kind: "common", readOnly: false, exists: true, canImport: true },
  { id: "cache", label: "插件缓存", path: "/demo/cache", kind: "plugin", readOnly: true, exists: true, canImport: false },
  { id: "custom", label: "自选目录", path: "/demo/local", kind: "custom", readOnly: false, exists: true, custom: true, canImport: true },
];
function fixture(id, overrides = {}) {
  return { id, name: `技能 ${id}`, description: "整理本机材料", filePath: `/demo/${id}/SKILL.md`, baseDir: `/demo/${id}`,
    locations: [{ id: `${id}-real`, path: `/demo/${id}`, sourceId: "common", label: "通用技能", isLink: false, canRemoveLink: false }],
    sources: [{ id: "common", label: "通用技能" }], diagnostics: [], readOnly: false, canEdit: true, canTrash: true, status: "ready",
    content: `---\nname: ${id}\ndescription: 整理材料\n---\n技能 ${id} 的原始内容\n`, revision: `revision-${id}`, files: [{ path: "references/help.md", type: "file", size: 42 }], ...overrides };
}

async function setup({ onRequest, initialSkills = [fixture("one"), fixture("two")] } = {}) {
  class Events {
    listeners = new Map();
    addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
    async dispatchEvent(event) { return Promise.all((this.listeners.get(event.type) ?? []).map((callback) => callback(event))); }
  }
  const document = new Events(), window = new Events(), elements = new Map(), requests = [];
  class Element extends Events {
    children = []; dataset = {}; attributes = new Map(); value = ""; hidden = false; disabled = false; open = false; readOnly = false;
    constructor(tagName = "div", id = "") { super(); this.tagName = tagName.toUpperCase(); this.id = id; }
    get textContent() { return this._text || this.children.map((child) => child.textContent).join(""); }
    set textContent(value) { this._text = String(value ?? ""); this.children = []; }
    get childElementCount() { return this.children.length; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this._text = ""; this.children = [...children]; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    focus() { document.activeElement = this; }
    async click() { if (!this.disabled) await this.dispatchEvent({ type: "click" }); }
    showModal() { this.open = true; document.activeElement = this; }
    close() { this.open = false; void this.dispatchEvent({ type: "close" }); }
  }
  const get = (id) => { if (!elements.has(id)) elements.set(id, new Element("div", id)); return elements.get(id); };
  document.getElementById = get; document.createElement = (tag) => new Element(tag);
  const closes = ["sources", "import", "delete", "trash"].map((name) => {
    const button = get(`close-${name}`); button.dataset.skillsClose = `skills-${name}-dialog`; return button;
  });
  document.querySelectorAll = (selector) => selector === "[data-skills-close]" ? closes : [];
  class Event { constructor(type, fields = {}) { this.type = type; Object.assign(this, fields); } preventDefault() { this.defaultPrevented = true; } }
  let skills = [...initialSkills], sources = [...sourceFixture], trash = [{ id: "old", name: "旧技能", originalPath: "/demo/old", action: "skill" }];
  const listing = () => ({ skills, sources, checkedAt: "2026-10-09T02:00:00Z", warnings: [] });
  vm.runInNewContext(`${viewSource}\n${controllerSource}`, {
    document, window, AbortController,
    fetch: async (path, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      const request = { path, body, signal: options.signal }; requests.push(request);
      const override = await onRequest?.(request);
      if (override !== undefined) return override instanceof Response ? override : Response.json(override);
      if (path === "/api/skills" || path === "/api/skills/scan") return Response.json(listing());
      if (path === "/api/skills/sources" && !body) return Response.json({ sources });
      if (path === "/api/skills/sources" && body) {
        sources = [...sources, { id: "added", label: "新增目录", path: body.path, kind: "custom", custom: true, exists: true, canImport: true }]; return Response.json({ sources });
      }
      if (path.includes("/sources/") && path.endsWith("/remove")) { sources = sources.filter((source) => source.id !== path.split("/")[4]); return Response.json({ sources }); }
      if (path === "/api/skills/pick-folder") return Response.json({ path: "/demo/picked", name: "picked", cancelled: false });
      if (path === "/api/skills/import/preview") return Response.json({ path: body.path, targetPath: `/demo/.agents/skills/${body.name || "picked"}`, name: body.name || "picked", skillCount: 2,
        skills: [{ name: "根技能", path: body.path }, { name: "子技能", path: `${body.path}/child` }], diagnostics: [], revision: "import-revision" });
      if (path === "/api/skills/import") { const imported = fixture("imported"); skills.push(imported); return Response.json(imported); }
      if (path === "/api/skills/trash") return Response.json({ entries: trash });
      if (path.includes("/trash/") && path.endsWith("/restore")) { trash = []; return Response.json(fixture("restored")); }
      const match = path.match(/^\/api\/skills\/([^/]+)(?:\/(save|trash)(?:\/(preview))?)?$/);
      if (match) {
        const skill = skills.find((item) => item.id === match[1]);
        if (match[2] === "save") { const saved = { ...skill, content: body.content, revision: "saved-revision" }; skills = skills.map((item) => item.id === skill.id ? saved : item); return Response.json(saved); }
        if (match[2] === "trash" && match[3]) return Response.json({ revision: "trash-revision", path: skill.baseDir, action: body.action, locationId: body.locationId,
          skillCount: 2, skills: [{ name: "根技能", path: skill.baseDir }, { name: "子技能", path: `${skill.baseDir}/child` }], aliases: [{ path: "/demo/alias/one" }] });
        if (match[2] === "trash") { skills = skills.filter((item) => item.id !== skill.id); return Response.json({ id: "trashed", name: skill.name }); }
        return skill ? Response.json(skill) : Response.json({ error: "未找到技能" }, { status: 404 });
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  });
  const route = async (page) => { await document.dispatchEvent(new Event("neuma:route", { detail: { page } })); await settle(); };
  const click = async (id) => { await get(id).click(); await settle(); };
  const input = async (id, value, type = "input") => { get(id).value = value; await get(id).dispatchEvent(new Event(type)); await settle(); };
  const submit = async (id) => { await get(id).dispatchEvent(new Event("submit")); await settle(); };
  const select = async (id) => { const item = get("skills-list").children.find((node) => node.dataset.skillId === id); assert.ok(item, `列表中应有 ${id}`); await item.click(); await settle(); };
  return { get, requests, document, window, route, click, input, submit, select };
}

test("技能页在进入时读取，重复路由共享请求，搜索与来源筛选不改详情", async () => {
  const pending = deferred(), ui = await setup({ onRequest: ({ path }) => path === "/api/skills" ? pending.promise : undefined });
  assert.equal(ui.requests.length, 0);
  await ui.route("skills"); await ui.route("skills");
  assert.equal(ui.requests.length, 1);
  pending.resolve({ skills: [fixture("one"), fixture("two", { name: "另一技能", sources: [{ id: "cache", label: "插件缓存" }], locations: [{ sourceId: "cache", path: "/demo/cache/two" }] })], sources: sourceFixture }); await settle();
  await ui.select("one"); await ui.input("skills-search", "另一");
  assert.equal(ui.get("skills-list").children.length, 1);
  assert.equal(ui.get("skills-detail-name").textContent, "技能 one");
  await ui.input("skills-source-filter", "common", "change");
  assert.match(ui.get("skills-list").textContent, /没有符合/);
});

test("未保存草稿跨页保留，切换技能有取消、放弃和保存三种选择", async () => {
  const ui = await setup(); await ui.route("skills"); await ui.select("one");
  await ui.input("skills-editor", "本机未保存草稿"); await ui.route("chat"); await ui.route("skills");
  assert.equal(ui.get("skills-editor").value, "本机未保存草稿");
  assert.equal(ui.requests.filter((request) => request.path === "/api/skills").length, 1);
  await ui.select("two"); assert.equal(ui.get("skills-unsaved-dialog").open, true);
  await ui.click("skills-unsaved-cancel"); assert.equal(ui.get("skills-detail-name").textContent, "技能 one");
  await ui.select("two"); await ui.click("skills-unsaved-save");
  assert.equal(ui.requests.find((request) => request.path.endsWith("/save")).body.content, "本机未保存草稿");
  assert.equal(ui.get("skills-detail-name").textContent, "技能 two");
  await ui.input("skills-editor", "丢弃这条"); await ui.select("one"); await ui.click("skills-unsaved-discard");
  assert.equal(ui.get("skills-detail-name").textContent, "技能 one");
  assert.equal(ui.get("skills-editor").value, "本机未保存草稿");
});

test("保存失败保留草稿并阻止切换，关闭浏览器仅在有草稿时提示", async () => {
  const ui = await setup({ onRequest: ({ path }) => path.endsWith("/save") ? Response.json({ error: "磁盘不可写" }, { status: 500 }) : undefined });
  await ui.route("skills"); await ui.select("one");
  let prevented = false;
  await ui.window.dispatchEvent({ type: "beforeunload", preventDefault() { prevented = true; } }); assert.equal(prevented, false);
  await ui.input("skills-editor", "仍需保存"); await ui.select("two"); await ui.click("skills-unsaved-save");
  assert.equal(ui.get("skills-detail-name").textContent, "技能 one"); assert.equal(ui.get("skills-editor").value, "仍需保存");
  assert.match(ui.get("skills-unsaved-error").textContent, /磁盘不可写/);
  await ui.window.dispatchEvent({ type: "beforeunload", preventDefault() { prevented = true; } }); assert.equal(prevented, true);
});

test("迟到详情不能覆盖新选择，正文以原文编辑且不解释 HTML", async () => {
  const pending = deferred(), content = "<script>window.unwanted = true</script>\n<iframe src=example></iframe>";
  const ui = await setup({ onRequest: ({ path }) => path === "/api/skills/one" ? pending.promise : path === "/api/skills/two" ? fixture("two", { content }) : undefined });
  await ui.route("skills"); await ui.select("one"); await ui.select("two");
  pending.resolve(fixture("one")); await settle();
  assert.equal(ui.get("skills-detail-name").textContent, "技能 two"); assert.equal(ui.get("skills-editor").value, content);
  assert.equal(ui.window.unwanted, undefined); assert.equal(ui.get("skills-editor").children.length, 0);
});

test("外部更新在重扫与保存时保留草稿，冲突后只能显式重新读取", async () => {
  let detailReads = 0;
  const ui = await setup({ onRequest: ({ path }) => {
    if (path === "/api/skills/one") return ++detailReads === 1 ? fixture("one") : fixture("one", { content: "磁盘的新版本", revision: "new-disk" });
    if (path.endsWith("/save")) return Response.json({ error: "文件已更新", code: "SKILL_CONFLICT" }, { status: 409 });
  } });
  await ui.route("skills"); await ui.select("one"); await ui.input("skills-editor", "保留我的编辑"); await ui.click("skills-save");
  assert.equal(ui.get("skills-editor").value, "保留我的编辑"); assert.equal(ui.get("skills-conflict").hidden, false);
  assert.equal(ui.get("skills-save").disabled, true);
  await ui.click("skills-conflict-view"); assert.equal(ui.get("skills-disk-content").textContent, "磁盘的新版本");
  await ui.click("skills-conflict-reload"); assert.equal(ui.get("skills-editor").value, "磁盘的新版本");
  await ui.input("skills-editor", "再编辑"); await ui.click("skills-refresh");
  assert.equal(ui.get("skills-editor").value, "再编辑");
});

test("扫描失败保留已有列表，局部读取诊断和空状态可见", async () => {
  const ui = await setup({ onRequest: ({ path }) => path === "/api/skills/scan" ? Response.json({ error: "目录读取失败" }, { status: 500 }) : undefined });
  await ui.route("skills"); await ui.click("skills-refresh");
  assert.equal(ui.get("skills-list").children.length, 2); assert.match(ui.get("skills-status").textContent, /上次结果/);
  const empty = await setup({ onRequest: ({ path }) => path === "/api/skills" ? { skills: [], sources: sourceFixture, warnings: [{ message: "一个目录不可读取" }] } : undefined });
  await empty.route("skills"); assert.match(empty.get("skills-list").textContent, /尚未发现/); assert.match(empty.get("skills-warnings").textContent, /不可读取/);
});

test("大量扫描诊断默认折叠，技能仍可搜索选择，重扫保留用户展开状态", async () => {
  const warnings = Array.from({ length: 28 }, (_, index) => `链接已失效：/demo/link-${index}`);
  const ui = await setup({ onRequest: ({ path }) => ["/api/skills", "/api/skills/scan"].includes(path)
    ? { skills: [fixture("one"), fixture("two")], sources: sourceFixture, warnings } : undefined });
  await ui.route("skills");
  assert.equal(ui.get("skills-warning-panel").hidden, false);
  assert.equal(Boolean(ui.get("skills-warning-panel").open), false);
  assert.equal(ui.get("skills-warning-summary").textContent, "扫描诊断（28）");
  await ui.select("one"); assert.equal(ui.get("skills-editor").value, fixture("one").content);
  ui.get("skills-warning-panel").open = true;
  await ui.click("skills-refresh"); assert.equal(ui.get("skills-warning-panel").open, true);
  const clean = await setup(); await clean.route("skills");
  assert.equal(clean.get("skills-warning-panel").hidden, true);
});

test("只读技能隐藏保存和实体回收，列出共享路径和附带资源", async () => {
  const locked = fixture("one", { readOnly: true, canEdit: false, canTrash: false, readOnlyReason: "插件缓存只读", content: "只读正文" });
  const ui = await setup({ initialSkills: [locked] }); await ui.route("skills"); await ui.select("one");
  assert.equal(ui.get("skills-editor").readOnly, true); assert.equal(ui.get("skills-save").hidden, true); assert.equal(ui.get("skills-delete").hidden, true);
  assert.match(ui.get("skills-shared-note").textContent, /插件缓存只读/); assert.match(ui.get("skills-files").textContent, /references\/help.md/);
});

test("读取失败的只读技能仍展示诊断，附带资源清单排除根说明文件", async () => {
  const locked = fixture("one", { readOnly: true, canEdit: false, canTrash: false, revision: null, content: "",
    diagnostics: [{ message: "SKILL.md 无法读取" }], files: [{ path: "SKILL.md", type: "file", size: 1 }, { path: "guide.md", type: "file", size: 10 }] });
  const ui = await setup({ initialSkills: [locked] }); await ui.route("skills"); await ui.select("one");
  assert.equal(ui.get("skills-detail-content").hidden, false); assert.match(ui.get("skills-detail-diagnostics").textContent, /无法读取/);
  assert.equal(ui.get("skills-files-count").textContent, "1"); assert.doesNotMatch(ui.get("skills-files").textContent, /SKILL\.md/);
});

test("目录选择使用本机 picker，停止扫描不请求删除文件", async () => {
  const ui = await setup(); await ui.route("skills"); await ui.click("skills-sources-open"); await ui.click("skills-source-pick");
  assert.deepEqual(ui.requests.find((request) => request.path === "/api/skills/pick-folder").body, { purpose: "source" });
  assert.equal(ui.get("skills-source-path").value, "/demo/picked"); await ui.submit("skills-source-form");
  assert.equal(ui.requests.find((request) => request.path === "/api/skills/sources" && request.body).body.path, "/demo/picked");
  const row = ui.get("skills-sources-list").children.find((node) => node.textContent.includes("自选目录")); await row.children[1].click(); await settle();
  assert.ok(ui.requests.some((request) => request.path === "/api/skills/sources/custom/remove"));
  assert.equal(ui.requests.some((request) => request.path.endsWith("/trash")), false);
});

test("导入每次选目标，预览列子技能，修改目标名称后旧预览不能提交", async () => {
  const ui = await setup(); await ui.route("skills"); await ui.click("skills-import-open");
  assert.equal(ui.get("skills-import-target").value, "");
  assert.equal(ui.get("skills-import-target").children.some((node) => node.value === "cache"), false);
  await ui.click("skills-import-pick"); assert.equal(ui.get("skills-import-path").value, "/demo/picked");
  await ui.input("skills-import-target", "common", "change"); await ui.submit("skills-import-form");
  assert.match(ui.get("skills-import-preview").textContent, /2 个技能/); assert.match(ui.get("skills-import-preview").textContent, /子技能/);
  await ui.input("skills-import-name", "new-name"); assert.equal(ui.get("skills-import-confirm").disabled, true);
  await ui.submit("skills-import-form"); await ui.click("skills-import-confirm");
  const request = ui.requests.find((request) => request.path === "/api/skills/import"); assert.equal(request.body.name, "new-name"); assert.equal(request.body.revision, "import-revision");
  assert.equal(ui.get("skills-detail-name").textContent, "技能 imported");
  await ui.click("skills-import-open"); assert.equal(ui.get("skills-import-target").value, "");
});

test("同名导入错误保留输入且不执行复制，迟到预览不能重新放行", async () => {
  const pending = deferred(); let previews = 0;
  const ui = await setup({ onRequest: ({ path }) => path === "/api/skills/import/preview" ? ++previews === 1
    ? Response.json({ error: "目标目录已存在" }, { status: 409 }) : pending.promise : undefined });
  await ui.route("skills"); await ui.click("skills-import-open"); await ui.input("skills-import-path", "/demo/source");
  await ui.input("skills-import-target", "common", "change"); await ui.submit("skills-import-form");
  assert.equal(ui.get("skills-import-path").value, "/demo/source"); assert.match(ui.get("skills-import-error").textContent, /已存在/); assert.equal(ui.get("skills-import-confirm").disabled, true);
  await ui.submit("skills-import-form"); await ui.input("skills-import-name", "different");
  pending.resolve({ revision: "stale", skillCount: 1, targetPath: "/demo/source" }); await settle();
  assert.equal(ui.get("skills-import-confirm").disabled, true); assert.equal(ui.requests.some((request) => request.path === "/api/skills/import"), false);
});

test("实体回收确认列出嵌套技能和关联别名，确认请求绑定预览版本", async () => {
  const ui = await setup(); await ui.route("skills"); await ui.select("one"); await ui.click("skills-delete");
  assert.equal(ui.get("skills-delete-dialog").open, true); assert.match(ui.get("skills-delete-impact").textContent, /子技能/); assert.match(ui.get("skills-delete-impact").textContent, /alias\/one/);
  assert.equal(ui.requests.some((request) => request.path === "/api/skills/one/trash"), false);
  await ui.click("skills-delete-confirm");
  assert.deepEqual(ui.requests.find((request) => request.path === "/api/skills/one/trash").body, { confirm: true, revision: "trash-revision", action: "skill" });
});

test("叶级链接动作明确仅移除此入口，回收恢复冲突不覆盖", async () => {
  const linked = fixture("one", { locations: [{ id: "leaf", path: "/demo/link/one", label: "Codex", sourceId: "common", isLink: true, canRemoveLink: true }] });
  const ui = await setup({ initialSkills: [linked], onRequest: ({ path }) => path.endsWith("/restore") ? Response.json({ error: "原位置已占用" }, { status: 409 }) : undefined });
  await ui.route("skills"); await ui.select("one"); await ui.get("skills-locations").children[0].children[1].click(); await settle();
  assert.equal(ui.get("skills-delete-title").textContent, "移除此入口"); assert.match(ui.get("skills-delete-note").textContent, /原技能文件保留/);
  assert.equal(ui.requests.find((request) => request.path.endsWith("/trash/preview")).body.locationId, "leaf");
  assert.doesNotMatch(ui.get("skills-delete-impact").textContent, /同时失效/);
  await ui.click("close-delete"); await ui.click("skills-trash-open"); await ui.get("skills-trash-list").children[0].children[1].click(); await settle();
  assert.match(ui.get("skills-trash-error").textContent, /已占用/); assert.equal(ui.get("skills-trash-list").children.length, 1);
});
