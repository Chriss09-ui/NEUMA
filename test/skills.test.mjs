import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SkillManager } from "../src/skills/skill-manager.mjs";
import { InputError } from "../src/requirements/core.mjs";

const text = (name = "example", description = "处理测试材料") => `---\nname: ${name}\ndescription: ${description}\n---\n\n# Instructions\nRead references/guide.md when needed.\n`;

async function fixture(t, projects = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuma-skills-test-")));
  const home = join(root, "home"), dataDir = join(root, "data");
  await mkdir(home); await mkdir(dataDir);
  const manager = new SkillManager({ home, dataDir, getProjects: async () => projects });
  t.after(async () => { await manager.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, home, dataDir, manager };
}

async function skill(path, name = "example", content = text(name)) {
  await mkdir(path, { recursive: true }); await writeFile(join(path, "SKILL.md"), content); return path;
}

test("constructor is lazy; nested, hidden builtin and project skills are catalogued with invalid files", async (t) => {
  const project = { root: "", name: "项目" };
  const { root, home, dataDir, manager } = await fixture(t, [project]);
  project.root = join(root, "project");
  await skill(join(home, ".agents/skills/lark"), "lark");
  await skill(join(home, ".agents/skills/lark/lark-doc"), "lark-doc");
  await skill(join(home, ".codex/skills/.system/creator"), "creator");
  await skill(join(project.root, ".pi/skills/project-skill"), "project-skill");
  await skill(join(home, ".claude/skills/broken"), "broken", "---\nname: broken\n---\nInstructions");
  await writeFile(join(home, ".agents/skills/lark/.gitignore"), "SKILL.md\nlark-doc/\n");
  assert.equal(manager.loaded, false);
  assert.equal(manager.catalog, null);
  assert.deepEqual(await readdir(dataDir), []);
  const result = await manager.list();
  assert.equal(result.skills.length, 5);
  assert.equal(result.skills.find((item) => item.name === "creator").readOnly, true);
  assert.equal(result.skills.find((item) => item.name === "broken").status, "invalid");
  assert.equal(result.skills.find((item) => item.name === "broken").canEdit, true);
  assert.equal(result.skills.find((item) => item.name === "project-skill").sources[0].label, "项目 · .pi");
  assert.deepEqual(await readdir(dataDir), []);
  assert.ok(result.checkedAt);
});

test("bounded main files remain visible and parser paths never expose staging locations", async (t) => {
  const { home, manager } = await fixture(t);
  await skill(join(home, ".agents/skills/oversized"), "oversized", "x".repeat(1024 * 1024 + 1));
  await skill(join(home, ".agents/skills/fallback"), "ignored", "---\ndescription: 有说明\n---\nBody");
  const result = await manager.scan();
  const invalid = result.skills.find((item) => item.name === "oversized");
  assert.equal(invalid.status, "invalid");
  assert.match(invalid.diagnostics[0].message, /1 MiB/);
  const fallback = result.skills.find((item) => item.name === "fallback");
  assert.ok(fallback);
  assert.equal(JSON.stringify(result).includes("neuma-skill-parse-"), false);
  const detail = await manager.detail(invalid.id);
  assert.equal(detail.content, ""); assert.equal(detail.revision, null);
});

test("save updates only the original main file and refuses stale or oversized content", async (t) => {
  const { home, manager } = await fixture(t);
  const root = await skill(join(home, ".agents/skills/example"));
  await mkdir(join(root, "references")); await writeFile(join(root, "references/guide.md"), "keep");
  const item = (await manager.list()).skills[0], original = await manager.detail(item.id);
  const changed = text("renamed", "新的说明");
  const saved = await manager.save(item.id, { content: changed, revision: original.revision });
  assert.equal(saved.id, item.id); assert.equal(saved.name, "renamed"); assert.equal(saved.content, changed);
  assert.equal(await readFile(join(root, "references/guide.md"), "utf8"), "keep");
  await assert.rejects(manager.save(item.id, { content: text(), revision: original.revision }), { code: "SKILL_CONFLICT" });
  await assert.rejects(manager.save(item.id, { content: "x".repeat(1024 * 1024 + 1), revision: saved.revision }), InputError);
  await assert.rejects(manager.save(item.id, { content: '---\nname: "broken\n---\nBody', revision: saved.revision }), /YAML/);
  await assert.rejects(manager.save(item.id, { content: '---\nname: broken\nBody', revision: saved.revision }), /分隔符/);
  assert.equal(await readFile(join(root, "SKILL.md"), "utf8"), changed);
  const repaired = await manager.save(item.id, { content: "---\nname: invalid\n---\nBody", revision: saved.revision });
  assert.equal(repaired.status, "invalid"); assert.ok(repaired.diagnostics.length);
});

test("directory aliases merge while shared main files do not merge separate packages", async (t) => {
  const { home, manager } = await fixture(t);
  const common = join(home, ".agents/skills"), root = await skill(join(common, "original"));
  await symlink(root, join(common, "alias"));
  await symlink(common, join(root, "cycle"));
  const other = join(common, "other"); await mkdir(other);
  await symlink(join(root, "SKILL.md"), join(other, "SKILL.md"));
  const hard = join(common, "hard"); await mkdir(hard); await link(join(root, "SKILL.md"), join(hard, "SKILL.md"));
  const result = await manager.list();
  assert.equal(result.skills.length, 3);
  assert.equal(result.skills.find((item) => item.baseDir === root).locations.length, 2);
  assert.ok(result.skills.every((item) => item.readOnly));
  assert.ok(result.warnings.some((item) => item.includes("循环")));
  await assert.rejects(manager.save(result.skills[0].id, { content: text(), revision: (await manager.detail(result.skills[0].id)).revision }), InputError);
});

test("source registration persists and removing a source never removes its files", async (t) => {
  const { root, home, dataDir, manager } = await fixture(t);
  const custom = await skill(join(root, "custom/example"));
  const sources = await manager.addSource({ path: dirname(custom) });
  const source = sources.find((item) => item.custom);
  assert.equal(source.canImport, true);
  const restarted = new SkillManager({ home, dataDir });
  assert.equal((await restarted.list()).skills.length, 1);
  await manager.removeSource(source.id);
  assert.equal((await manager.list()).skills.length, 0);
  assert.equal(await readFile(join(custom, "SKILL.md"), "utf8"), text());
  await restarted.dispose();
});

test("whole local packages import without modifying source; duplicate target requires a different name", async (t) => {
  const { root, manager } = await fixture(t);
  const source = await skill(join(root, "importable/example"));
  await skill(join(source, "nested"), "nested");
  await mkdir(join(source, "scripts")); await writeFile(join(source, "scripts/run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await symlink("run.sh", join(source, "scripts/alias.sh"));
  const targetId = (await manager.sources()).find((item) => item.label === "通用 Agent Skills").id;
  const preview = await manager.previewImport({ path: source, targetId });
  assert.equal(preview.skillCount, 2);
  const imported = await manager.importSkill({ path: source, targetId, revision: preview.revision });
  assert.equal(imported.name, "example");
  assert.equal(await readFile(join(imported.baseDir, "scripts/alias.sh"), "utf8"), "#!/bin/sh\nexit 0\n");
  assert.equal(await readFile(join(source, "SKILL.md"), "utf8"), text());
  await assert.rejects(manager.previewImport({ path: source, targetId }), { code: "SKILL_CONFLICT" });
  const alternate = await manager.previewImport({ path: source, targetId, name: "alternate" });
  assert.equal((await manager.importSkill({ path: source, targetId, name: "alternate", revision: alternate.revision })).name, "example");
  assert.equal((await manager.list()).skills.length, 4);
});

test("import rejects changed sources, escaping links, credential files and invalid directory names", async (t) => {
  const { root, manager } = await fixture(t);
  const source = await skill(join(root, "importable/example"));
  const targetId = (await manager.sources()).find((item) => item.label === "通用 Agent Skills").id;
  const preview = await manager.previewImport({ path: source, targetId });
  await writeFile(join(source, "extra.txt"), "changed");
  await assert.rejects(manager.importSkill({ path: source, targetId, revision: preview.revision }), { code: "SKILL_CONFLICT" });
  await symlink(root, join(source, "outside"));
  await assert.rejects(manager.previewImport({ path: source, targetId }), /包外/);
  await rm(join(source, "outside"));
  for (const name of [".env", "private.key", "credentials.json"]) {
    await writeFile(join(source, name), "test fixture, never read");
    await assert.rejects(manager.previewImport({ path: source, targetId }), /凭据|环境/);
    await rm(join(source, name));
  }
  await assert.rejects(manager.previewImport({ path: source, targetId, name: "../escape" }), InputError);
  assert.equal(await readFile(join(source, "SKILL.md"), "utf8"), text());
});

test("Codex import targets remain writable outside builtins; package size limits prevent copying large attachments", async (t) => {
  const { root, home, manager } = await fixture(t);
  await skill(join(home, ".codex/skills/.system/builtin"), "builtin");
  const source = await skill(join(root, "importable/example"));
  const targetId = (await manager.sources()).find((item) => item.label === "Codex Skills").id;
  const large = join(source, "large.bin");
  const handle = await open(large, "w"); await handle.truncate(64 * 1024 * 1024 + 1); await handle.close();
  await assert.rejects(manager.previewImport({ path: source, targetId }), /单文件 64 MiB/);
  await rm(large);
  const preview = await manager.previewImport({ path: source, targetId });
  const imported = await manager.importSkill({ path: source, targetId, revision: preview.revision });
  assert.equal(imported.canEdit, true); assert.equal(imported.canTrash, true);
  assert.equal(imported.baseDir, join(home, ".codex/skills/example"));
  assert.equal(await readFile(join(home, ".codex/skills/.system/builtin/SKILL.md"), "utf8"), text("builtin"));
});

test("nested removal preview and recycled payload are recoverable across restart without overwriting conflicts", async (t) => {
  const { home, dataDir, manager } = await fixture(t);
  const source = await skill(join(home, ".agents/skills/parent"), "parent");
  await skill(join(source, "child"), "child");
  const item = (await manager.list()).skills.find((entry) => entry.name === "parent");
  const preview = await manager.previewRemoval(item.id);
  assert.equal(preview.skillCount, 2);
  await assert.rejects(manager.trashSkill(item.id, { confirm: false, revision: preview.revision }), InputError);
  const entry = await manager.trashSkill(item.id, { confirm: true, revision: preview.revision });
  assert.equal((await manager.list()).skills.length, 0);
  assert.equal(await readFile(join(entry.storedPath, "child/SKILL.md"), "utf8"), text("child"));
  const restarted = new SkillManager({ home, dataDir });
  assert.equal((await restarted.listTrash()).length, 1);
  await skill(source, "new");
  await assert.rejects(restarted.restore(entry.id), { code: "SKILL_CONFLICT" });
  assert.equal((await restarted.listTrash()).length, 1);
  await rm(source, { recursive: true });
  const restored = await restarted.restore(entry.id);
  assert.equal(restored.id, item.id);
  assert.equal((await restarted.list()).skills.length, 2);
  assert.equal((await restarted.listTrash()).length, 0);
  await restarted.dispose();
});

test("metadata symlinks and hardlinks fail before touching managed files", async (t) => {
  const { root, dataDir, manager } = await fixture(t);
  const source = await skill(join(root, "custom/example"));
  await mkdir(join(dataDir, "skills"));
  const innocent = join(root, "innocent.json"); await writeFile(innocent, JSON.stringify({ version: 1, sources: [] }));
  await symlink(innocent, join(dataDir, "skills/sources.json"));
  await assert.rejects(manager.addSource({ path: source }), InputError);
  assert.equal(await readFile(join(source, "SKILL.md"), "utf8"), text());
  await rm(join(dataDir, "skills/sources.json"));
  await link(innocent, join(dataDir, "skills/sources.json"));
  await assert.rejects(manager.addSource({ path: source }), InputError);
});

test("cancelled scans and imports preserve source data and do not poison the management queue", async (t) => {
  const { root, manager } = await fixture(t);
  const source = await skill(join(root, "importable/example"));
  const signal = AbortSignal.abort();
  await assert.rejects(manager.scan({ signal }), { name: "AbortError" });
  const targetId = (await manager.sources()).find((item) => item.label === "通用 Agent Skills").id;
  await assert.rejects(manager.previewImport({ path: source, targetId }, { signal }), { name: "AbortError" });
  assert.equal(await readFile(join(source, "SKILL.md"), "utf8"), text());
  assert.equal((await manager.list()).skills.length, 0);
});
