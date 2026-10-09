import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillManager } from "../src/skills/skill-manager.mjs";
import { createPiSession } from "../src/runtime/pi-runtime.mjs";

function document(name, body = "Original instructions.") {
  return `---\nname: ${name}\ndescription: Boundary test skill.\n---\n\n${body}\n`;
}

async function writeSkill(directory, name, body) {
  await mkdir(directory, { recursive: true });
  const content = document(name, body);
  await writeFile(join(directory, "SKILL.md"), content);
  return content;
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuma-skills-boundaries-")));
  const home = join(root, "home"), dataDir = join(root, "data");
  await mkdir(home);
  const manager = new SkillManager({ dataDir, home, getProjects: async () => [] });
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, home, dataDir, manager };
}

async function skillNamed(manager, name) {
  const skill = (await manager.list({ refresh: true })).skills.find((item) => item.name === name);
  assert.ok(skill, `未发现测试技能 ${name}`);
  return skill;
}

for (const [source, relative] of [
  ["Codex 系统", ".codex/skills/.system/protected-skill"],
  ["Codex 插件", ".codex/plugins/cache/example/1.0.0/skills/protected-skill"],
  ["Claude 插件", ".claude/plugins/cache/example/1.0.0/skills/protected-skill"],
]) {
  test(`${source}技能经自选目录和用户目录软链接发现后仍然不能编辑、删除或导入`, async (t) => {
    const { root, home, manager } = await fixture(t);
    const protectedDir = join(home, relative);
    const original = await writeSkill(protectedDir, "protected-skill");
    const userRoot = join(home, ".agents/skills"); await mkdir(userRoot, { recursive: true });
    await symlink(protectedDir, join(userRoot, "protected-alias"));
    await manager.addSource({ path: protectedDir });
    const skill = await skillNamed(manager, "protected-skill");
    assert.equal(skill.readOnly, true); assert.equal(skill.canEdit, false); assert.equal(skill.canTrash, false);
    const detail = await manager.detail(skill.id);
    await assert.rejects(manager.save(skill.id, { content: document("protected-skill", "Changed instructions."), revision: detail.revision }));
    await assert.rejects(manager.trashSkill(skill.id, { confirm: true, revision: detail.revision, action: "skill" }));
    const source = (await manager.sources()).find((item) => item.path === protectedDir);
    assert.ok(source); assert.equal(source.readOnly, true); assert.equal(source.canImport, false);
    const incoming = join(root, "incoming"); await writeSkill(incoming, "incoming");
    await assert.rejects(manager.previewImport({ path: incoming, targetId: source.id, name: "incoming" }));
    await assert.rejects(manager.importSkill({ path: incoming, targetId: source.id, name: "incoming" }));
    assert.equal(await readFile(join(protectedDir, "SKILL.md"), "utf8"), original);
    assert.deepEqual(await manager.listTrash(), []);
  });
}

test("插件 latest 指向临时安装目录时，登记真实目标和父来源仍不能绕过只读保护", async (t) => {
  const { root, home, manager } = await fixture(t);
  const packageRoot = join(home, ".codex/.tmp/bundled/pkg"), targetRoot = join(packageRoot, "skills"), protectedDir = join(targetRoot, "protected-skill");
  const original = await writeSkill(protectedDir, "bundled-plugin-skill");
  const parentContent = await writeSkill(packageRoot, "bundled-parent-skill");
  const toolRoot = join(home, ".codex/plugins/cache/tool"); await mkdir(toolRoot, { recursive: true });
  await symlink(targetRoot, join(toolRoot, "latest"));
  await manager.addSource({ path: targetRoot });
  await manager.addSource({ path: packageRoot });
  const skill = await skillNamed(manager, "bundled-plugin-skill"), detail = await manager.detail(skill.id);
  assert.equal(skill.readOnly, true); assert.equal(skill.canEdit, false); assert.equal(skill.canTrash, false);
  await assert.rejects(manager.save(skill.id, { content: document("bundled-plugin-skill", "Attempted source bypass."), revision: detail.revision }));
  await assert.rejects(manager.previewRemoval(skill.id, { action: "skill" }));
  const parent = await skillNamed(manager, "bundled-parent-skill");
  assert.equal(parent.canTrash, false);
  await assert.rejects(manager.previewRemoval(parent.id, { action: "skill" }));
  const source = (await manager.sources()).find((item) => item.path === targetRoot);
  assert.ok(source); assert.equal(source.readOnly, true); assert.equal(source.canImport, false);
  const incoming = join(root, "incoming"); await writeSkill(incoming, "incoming");
  await assert.rejects(manager.previewImport({ path: incoming, targetId: source.id, name: "incoming" }));
  await assert.rejects(manager.importSkill({ path: incoming, targetId: source.id, name: "incoming" }));
  assert.equal(await readFile(join(protectedDir, "SKILL.md"), "utf8"), original);
  assert.equal(await readFile(join(packageRoot, "SKILL.md"), "utf8"), parentContent);
  assert.equal(await realpath(join(toolRoot, "latest")), targetRoot);
  assert.deepEqual(await manager.listTrash(), []);
});

for (const [label, parentRelative, protectedRelative] of [
  ["系统技能", ".codex/skills", ".codex/skills/.system/builtin"],
  ["插件技能", ".codex", ".codex/plugins/cache/example/1.0.0/skills/builtin"],
]) {
  test(`带 SKILL.md 的父目录不能整体回收其中的${label}子目录`, async (t) => {
    const { home, manager } = await fixture(t);
    const parentDir = join(home, parentRelative), protectedDir = join(home, protectedRelative);
    const parentContent = await writeSkill(parentDir, "parent-with-protected-child");
    const protectedContent = await writeSkill(protectedDir, "protected-child");
    await manager.addSource({ path: parentDir });
    const parent = await skillNamed(manager, "parent-with-protected-child");
    assert.equal(parent.canTrash, false);
    await assert.rejects(manager.previewRemoval(parent.id, { action: "skill" }));
    assert.equal(await readFile(join(parentDir, "SKILL.md"), "utf8"), parentContent);
    assert.equal(await readFile(join(protectedDir, "SKILL.md"), "utf8"), protectedContent);
    assert.deepEqual(await manager.listTrash(), []);
  });
}

test("同名的不同技能实体分别列出，共享软链接只形成一个实体并保留来源", async (t) => {
  const { home, manager } = await fixture(t);
  const sharedDir = join(home, ".agents/skills/shared"); await writeSkill(sharedDir, "shared-skill");
  const claudeRoot = join(home, ".claude/skills"); await mkdir(claudeRoot, { recursive: true });
  await symlink(sharedDir, join(claudeRoot, "shared-alias"));
  await writeSkill(join(home, ".agents/skills/first-copy"), "same-name", "First copy.");
  await writeSkill(join(home, ".codex/skills/second-copy"), "same-name", "Second copy.");
  const { skills } = await manager.list({ refresh: true });
  const shared = skills.filter((item) => item.name === "shared-skill");
  assert.equal(shared.length, 1); assert.equal(shared[0].locations.length, 2); assert.equal(shared[0].sources.length, 2);
  const sameNames = skills.filter((item) => item.name === "same-name");
  assert.equal(sameNames.length, 2); assert.notEqual(sameNames[0].id, sameNames[1].id);
  assert.notEqual(sameNames[0].filePath, sameNames[1].filePath);
});

test("未登记的外部原件仅通过链接发现时只读，登记真实目录后才允许编辑", async (t) => {
  const { root, home, manager } = await fixture(t);
  const external = join(root, "external"), original = await writeSkill(external, "external-skill");
  const sourceRoot = join(home, ".agents/skills"); await mkdir(sourceRoot, { recursive: true });
  await symlink(external, join(sourceRoot, "external-alias"));
  const linked = await skillNamed(manager, "external-skill"), detail = await manager.detail(linked.id);
  assert.equal(linked.readOnly, true); assert.equal(linked.canEdit, false); assert.equal(linked.canTrash, false);
  await assert.rejects(manager.save(linked.id, { content: document("external-skill", "Changed before registration."), revision: detail.revision }));
  assert.equal(await readFile(join(external, "SKILL.md"), "utf8"), original);
  await manager.addSource({ path: external });
  const registered = await skillNamed(manager, "external-skill"), current = await manager.detail(registered.id);
  assert.equal(registered.id, linked.id); assert.equal(registered.readOnly, false); assert.equal(registered.canEdit, true);
  const updated = document("external-skill", "Changed after registration.");
  await manager.save(registered.id, { content: updated, revision: current.revision });
  assert.equal(await readFile(join(external, "SKILL.md"), "utf8"), updated);
});

test("断开的技能链接产生诊断，不阻止其他技能发现，也不冒充有效技能", async (t) => {
  const { root, home, manager } = await fixture(t);
  const skillRoot = join(home, ".claude/skills"); await mkdir(skillRoot, { recursive: true });
  await symlink(join(root, "missing-target"), join(skillRoot, "broken-link"));
  await writeSkill(join(skillRoot, "valid"), "valid-skill");
  const catalog = await manager.list({ refresh: true });
  assert.deepEqual(catalog.skills.map((item) => item.name), ["valid-skill"]);
  assert.ok(catalog.warnings.length > 0);
  assert.equal((await lstat(join(skillRoot, "broken-link"))).isSymbolicLink(), true);
});

test("移入回收站的父技能范围包括嵌套技能，保留同级技能并可完整恢复", async (t) => {
  const { home, manager } = await fixture(t);
  const skillRoot = join(home, ".agents/skills"), parentDir = join(skillRoot, "parent");
  const parentContent = await writeSkill(parentDir, "parent-skill");
  const childContent = await writeSkill(join(parentDir, "children/child"), "child-skill");
  const siblingDir = join(skillRoot, "sibling"), siblingContent = await writeSkill(siblingDir, "sibling-skill");
  const parent = await skillNamed(manager, "parent-skill");
  const preview = await manager.previewRemoval(parent.id, { action: "skill" });
  assert.equal(preview.path, parentDir); assert.equal(preview.skillCount, 2);
  await assert.rejects(manager.trashSkill(parent.id, { action: "skill", revision: preview.revision, confirm: false }));
  assert.equal(await readFile(join(parentDir, "SKILL.md"), "utf8"), parentContent);
  await manager.trashSkill(parent.id, { action: "skill", revision: preview.revision, confirm: true });
  await assert.rejects(lstat(parentDir), { code: "ENOENT" });
  assert.equal(await readFile(join(siblingDir, "SKILL.md"), "utf8"), siblingContent);
  assert.deepEqual((await manager.list({ refresh: true })).skills.map((item) => item.name), ["sibling-skill"]);
  const trash = await manager.listTrash(); assert.equal(trash.length, 1);
  await manager.restore(trash[0].id);
  assert.equal(await readFile(join(parentDir, "SKILL.md"), "utf8"), parentContent);
  assert.equal(await readFile(join(parentDir, "children/child/SKILL.md"), "utf8"), childContent);
});

test("移走嵌套子技能只影响该目录，父技能与其他子技能保持原文件", async (t) => {
  const { home, manager } = await fixture(t);
  const parentDir = join(home, ".agents/skills/parent"), childDir = join(parentDir, "child");
  const parentContent = await writeSkill(parentDir, "parent-skill");
  await writeSkill(childDir, "child-skill");
  const otherContent = await writeSkill(join(parentDir, "other"), "other-skill");
  const child = await skillNamed(manager, "child-skill");
  const preview = await manager.previewRemoval(child.id, { action: "skill" });
  assert.equal(preview.path, childDir); assert.equal(preview.skillCount, 1);
  await manager.trashSkill(child.id, { action: "skill", revision: preview.revision, confirm: true });
  await assert.rejects(lstat(childDir), { code: "ENOENT" });
  assert.equal(await readFile(join(parentDir, "SKILL.md"), "utf8"), parentContent);
  assert.equal(await readFile(join(parentDir, "other/SKILL.md"), "utf8"), otherContent);
});

test("父技能回收预览包含内部外部引用的影响，移走父目录仍保留外部技能原件", async (t) => {
  const { root, home, manager } = await fixture(t);
  const parentDir = join(home, ".agents/skills/parent"); await writeSkill(parentDir, "parent-skill");
  const external = join(root, "external"), externalContent = await writeSkill(external, "external-skill");
  const alias = join(parentDir, "external-reference"); await symlink(external, alias);
  const parent = await skillNamed(manager, "parent-skill"), outside = await skillNamed(manager, "external-skill");
  const preview = await manager.previewRemoval(parent.id, { action: "skill" });
  assert.ok(preview.aliases.some((item) => item.skillId === outside.id && item.linkPath === alias));
  await manager.trashSkill(parent.id, { action: "skill", revision: preview.revision, confirm: true });
  await assert.rejects(lstat(parentDir), { code: "ENOENT" });
  assert.equal(await readFile(join(external, "SKILL.md"), "utf8"), externalContent);
  const trash = (await manager.listTrash())[0]; await manager.restore(trash.id);
  assert.equal(await realpath(alias), external);
  assert.equal((await skillNamed(manager, "external-skill")).id, outside.id);
});

test("仅移走共享技能的链接不会删除真实技能，恢复后重新显示同一实体的两个来源", async (t) => {
  const { home, manager } = await fixture(t);
  const originalDir = join(home, ".agents/skills/shared"), original = await writeSkill(originalDir, "shared-skill");
  const linkDir = join(home, ".claude/skills/shared-alias"); await mkdir(join(home, ".claude/skills"), { recursive: true });
  await symlink(originalDir, linkDir);
  const shared = await skillNamed(manager, "shared-skill");
  const location = shared.locations.find((item) => item.isLink && item.canRemoveLink);
  assert.ok(location);
  const preview = await manager.previewRemoval(shared.id, { action: "link", locationId: location.id });
  await manager.trashSkill(shared.id, { action: "link", locationId: location.id, revision: preview.revision, confirm: true });
  await assert.rejects(lstat(linkDir), { code: "ENOENT" });
  assert.equal(await readFile(join(originalDir, "SKILL.md"), "utf8"), original);
  assert.equal((await skillNamed(manager, "shared-skill")).locations.length, 1);
  const trash = await manager.listTrash(); assert.equal(trash.length, 1); assert.equal(trash[0].action, "link");
  await manager.restore(trash[0].id);
  assert.equal((await lstat(linkDir)).isSymbolicLink(), true);
  assert.equal((await skillNamed(manager, "shared-skill")).locations.length, 2);
});

test("单个子技能不能借祖先软链接移走整个技能集合的引用", async (t) => {
  const { home, manager } = await fixture(t);
  const collection = join(home, ".agents/skills/collection");
  await writeSkill(collection, "collection-skill");
  const childContent = await writeSkill(join(collection, "child"), "child-skill");
  const alias = join(home, ".claude/skills/collection-alias"); await mkdir(join(home, ".claude/skills"), { recursive: true });
  await symlink(collection, alias);
  const child = await skillNamed(manager, "child-skill");
  const location = child.locations.find((item) => item.isLink);
  assert.ok(location); assert.equal(location.canRemoveLink, false);
  await assert.rejects(manager.previewRemoval(child.id, { action: "link", locationId: location.id }));
  assert.equal((await lstat(alias)).isSymbolicLink(), true);
  assert.equal(await readFile(join(collection, "child/SKILL.md"), "utf8"), childContent);
});

test("删除预览后新增共享引用会改变影响范围，旧确认不得留下新悬空链接", async (t) => {
  const { home, manager } = await fixture(t);
  const originalDir = join(home, ".agents/skills/shared"), content = await writeSkill(originalDir, "shared-skill");
  const shared = await skillNamed(manager, "shared-skill");
  const preview = await manager.previewRemoval(shared.id, { action: "skill" });
  const alias = join(home, ".claude/skills/new-alias"); await mkdir(join(home, ".claude/skills"), { recursive: true });
  await symlink(originalDir, alias);
  await assert.rejects(manager.trashSkill(shared.id, { action: "skill", revision: preview.revision, confirm: true }));
  assert.equal(await readFile(join(originalDir, "SKILL.md"), "utf8"), content);
  assert.equal(await realpath(alias), originalDir);
  assert.deepEqual(await manager.listTrash(), []);
});

test("恢复与新目录冲突时保留新文件和回收站原件，不覆盖任何一方", async (t) => {
  const { home, manager } = await fixture(t);
  const originalDir = join(home, ".agents/skills/restorable");
  const original = await writeSkill(originalDir, "restorable-skill", "Original body.");
  const skill = await skillNamed(manager, "restorable-skill");
  const preview = await manager.previewRemoval(skill.id, { action: "skill" });
  await manager.trashSkill(skill.id, { action: "skill", revision: preview.revision, confirm: true });
  const trash = (await manager.listTrash())[0];
  const replacement = await writeSkill(originalDir, "replacement-skill", "New body.");
  await assert.rejects(manager.restore(trash.id));
  assert.equal(await readFile(join(originalDir, "SKILL.md"), "utf8"), replacement);
  assert.equal(await readFile(join(trash.storedPath, "SKILL.md"), "utf8"), original);
  assert.ok((await manager.listTrash()).some((item) => item.id === trash.id));
});

test("外部修改后拒绝旧编辑版本，删除预览后新增的子技能不会被旧确认移走", async (t) => {
  const { home, manager } = await fixture(t);
  const parentDir = join(home, ".agents/skills/parent"); await writeSkill(parentDir, "parent-skill");
  const parent = await skillNamed(manager, "parent-skill"), detail = await manager.detail(parent.id);
  const externallyChanged = document("parent-skill", "Edited outside NEUMA.");
  await writeFile(join(parentDir, "SKILL.md"), externallyChanged);
  await assert.rejects(manager.save(parent.id, { content: document("parent-skill", "Old editor save."), revision: detail.revision }));
  assert.equal(await readFile(join(parentDir, "SKILL.md"), "utf8"), externallyChanged);
  const preview = await manager.previewRemoval(parent.id, { action: "skill" });
  const newChild = await writeSkill(join(parentDir, "new-child"), "new-child-skill");
  await assert.rejects(manager.trashSkill(parent.id, { action: "skill", revision: preview.revision, confirm: true }));
  assert.equal(await readFile(join(parentDir, "SKILL.md"), "utf8"), externallyChanged);
  assert.equal(await readFile(join(parentDir, "new-child/SKILL.md"), "utf8"), newChild);
  assert.deepEqual(await manager.listTrash(), []);
});

test("独立技能管理的磁盘资源不会进入真实 Pi 工作会话资源或指令", async (t) => {
  const { root, home, dataDir, manager } = await fixture(t);
  const marker = "MANAGER_ONLY_SKILL_INSTRUCTION";
  await writeSkill(join(home, ".agents/skills/managed"), "managed-skill", marker);
  await writeSkill(join(root, ".agents/skills/project"), "project-skill", marker);
  await writeSkill(join(dataDir, "pi/skills/runtime"), "runtime-skill", marker);
  assert.ok((await manager.list({ refresh: true })).skills.some((item) => item.name === "managed-skill"));
  const session = await createPiSession({ cwd: root, dataDir, customTools: [], systemPrompt: "Controlled test instructions.",
    config: { chatUrl: "http://127.0.0.1:65535/v1/chat/completions", model: "fixture-model", apiKey: "fixture-only" } });
  t.after(() => session.dispose());
  assert.deepEqual(session.resourceLoader.getSkills(), { skills: [], diagnostics: [] });
  assert.equal(session.resourceLoader.getSystemPrompt(), "Controlled test instructions.");
  assert.equal(session.resourceLoader.getSystemPrompt().includes(marker), false);
});
