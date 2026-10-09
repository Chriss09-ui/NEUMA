import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rename, rm, rmdir, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { InputError } from "../requirements/core.mjs";

const MAIN_LIMIT = 1024 * 1024;
const FILE_LIMIT = 64 * 1024 * 1024;
const PACKAGE_LIMIT = 256 * 1024 * 1024;
const ENTRY_LIMIT = 5000;
const DIRECTORY_LIMIT = 30000;
const TRASH_DIR = ".neuma-skill-trash";
const SKIP_DIRS = new Set([".git", "node_modules", TRASH_DIR]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const inside = (root, path) => {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
};
const check = (signal) => signal?.throwIfAborted();
const fail = (message, conflict = false) => {
  const error = new InputError(message);
  if (conflict) error.code = "SKILL_CONFLICT";
  return error;
};
const exists = async (path) => {
  try { return await lstat(path); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
};
const diagnostic = (message, type = "warning") => ({ type, message });
const credentials = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|auth(?:\..*)?|tokens?(?:\..*)?|passwords?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i;

function localPath(value, home) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw fail("请提供完整的本地目录路径");
  const path = value.trim().startsWith("~/") ? join(home, value.trim().slice(2)) : value.trim();
  if (!isAbsolute(path)) throw fail("请使用完整路径，或以 ~/ 开头的路径");
  return resolve(path);
}

async function canonicalMissing(path) {
  const missing = [];
  let current = resolve(path);
  while (true) {
    try { return join(await realpath(current), ...missing.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current)); current = parent;
    }
  }
}

// Management metadata and staging directories must never follow a directory link.
async function realDirectory(path, create = false) {
  const absolute = resolve(path), parts = [];
  let current = absolute;
  while (dirname(current) !== current) { parts.push(current); current = dirname(current); }
  parts.push(current);
  for (const part of parts.reverse()) {
    let info = await exists(part);
    if (!info && create) {
      try { await mkdir(part, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      info = await lstat(part);
    }
    if (!info) throw Object.assign(new Error("directory_missing"), { code: "ENOENT" });
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail("管理目录不能包含符号链接");
  }
  return absolute;
}

async function readBounded(path, limit, { singleLink = false, signal } = {}) {
  check(signal);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw fail("文件必须是普通文件，不能读取链接或特殊文件");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || (singleLink && info.nlink !== 1)) throw fail("文件必须是普通文件，管理数据不允许链接");
    if (info.size > limit) throw fail(`文件超过大小上限（${Math.round(limit / 1024 / 1024)} MiB）`);
    const chunks = []; let length = 0;
    while (length <= limit) {
      check(signal);
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead)); length += bytesRead;
    }
    if (length > limit) throw fail("文件读取期间增长，已超过大小上限");
    const after = await handle.stat();
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw fail("文件读取期间已变更，请刷新后重试", true);
    return { buffer: Buffer.concat(chunks), info: after };
  } finally { await handle.close(); }
}

async function writeExclusive(path, content, mode = 0o600) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
}

async function publishDirectory(from, to, signal) {
  try { await mkdir(to, { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") throw fail("目标目录已存在，不能覆盖", true); throw error; }
  const reservation = await lstat(to);
  let published = false;
  try {
    check(signal);
    const current = await lstat(to);
    if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== reservation.ino || current.dev !== reservation.dev)
      throw fail("目标目录已变更，不能覆盖", true);
    await rename(from, to); published = true;
  } finally {
    if (!published) {
      const current = await exists(to);
      if (current?.ino === reservation.ino && current.dev === reservation.dev) await rmdir(to).catch(() => {});
    }
  }
}

async function readJson(path) {
  await realDirectory(dirname(path));
  if (!await exists(path)) return null;
  try { return JSON.parse((await readBounded(path, 4 * MAIN_LIMIT, { singleLink: true })).buffer.toString("utf8")); }
  catch (error) { if (error instanceof InputError) throw error; throw fail("Skill 管理记录无法读取，请保留文件并检查后重试"); }
}

async function atomicJson(path, value, signal) {
  await realDirectory(dirname(path), true);
  const info = await exists(path);
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw fail("Skill 管理记录不能是链接或特殊文件");
  const temporary = join(dirname(path), `.pending-${randomUUID()}.json`);
  try {
    await writeExclusive(temporary, JSON.stringify(value, null, 2));
    check(signal);
    await realDirectory(dirname(path));
    const current = await exists(path);
    if (current && (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1)) throw fail("Skill 管理记录已变更，请检查后重试");
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

function directoryName(value) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 120
    || [".", "..", TRASH_DIR, ".system"].includes(value) || /[\\/\0]/.test(value)) throw fail("导入目录名无效，请使用单个目录名称");
  return value;
}

export class SkillManager {
  constructor({ dataDir, home = homedir(), getProjects = async () => [] }) {
    this.dataDir = resolve(dataDir); this.home = resolve(home); this.getProjects = getProjects;
    this.metadataDir = join(this.dataDir, "skills");
    this.custom = []; this.trash = []; this.loaded = false; this.catalog = null; this.queue = Promise.resolve();
    this.discoveredProtected = new Set(); this.protectionWarnings = []; this.protectionIncomplete = false;
  }

  _enqueue(task) {
    const pending = this.queue.then(async () => {
      try { return await task(); }
      catch (error) {
        if (error instanceof InputError || error?.name === "AbortError") throw error;
        const messages = { EACCES: "没有目录或文件的读写权限，请检查后重试", EPERM: "系统不允许此文件操作，请检查权限后重试",
          EROFS: "此目录位于只读文件系统，不能修改", ENOENT: "目录或文件已不存在，请刷新后重试", ENOTDIR: "目录路径已变更，请刷新后重试",
          ELOOP: "路径包含失效或循环链接，请检查后重试", EEXIST: "目标位置已存在，不能覆盖", ENOTEMPTY: "目标目录已有文件，不能覆盖",
          EXDEV: "回收目录必须位于同一磁盘，未移动源文件", ENOSPC: "磁盘空间不足，请释放空间后重试", EIO: "本地文件读写失败，请检查目录和回收记录" };
        if (messages[error?.code]) throw fail(messages[error.code], ["ENOENT", "ENOTDIR", "EEXIST", "ENOTEMPTY"].includes(error.code));
        throw error;
      }
    });
    this.queue = pending.catch(() => {});
    return pending;
  }

  async _load() {
    if (this.loaded) return;
    this.dataDir = await canonicalMissing(this.dataDir);
    this.home = await canonicalMissing(this.home);
    this.metadataDir = join(this.dataDir, "skills");
    if (await exists(this.metadataDir)) {
      const sources = await readJson(join(this.metadataDir, "sources.json"));
      const trash = await readJson(join(this.metadataDir, "trash.json"));
      if (sources && (sources.version !== 1 || !Array.isArray(sources.sources)
        || sources.sources.some((item) => typeof item?.path !== "string" || !isAbsolute(item.path)))) throw fail("Skill 来源记录格式无效");
      if (trash && (trash.version !== 1 || !Array.isArray(trash.entries))) throw fail("Skill 回收记录格式无效");
      this.custom = sources?.sources ?? [];
      this.trash = trash?.entries ?? [];
      for (const item of this.trash) {
        if (!/^[a-f0-9-]{36}$/.test(item.id || "") || !["skill", "link"].includes(item.action)
          || typeof item.originalPath !== "string" || !isAbsolute(item.originalPath)
          || item.storedPath !== join(dirname(item.originalPath), TRASH_DIR, item.id)) throw fail("Skill 回收路径记录无效");
      }
    }
    this.loaded = true;
  }

  async _protected() {
    const lexical = [join(this.home, ".codex/skills/.system"), join(this.home, ".codex/plugins"),
      join(this.home, ".claude/plugins"), this.metadataDir,
      "/System", "/Library", "/usr", "/bin", "/sbin", "/Applications", "/opt", "/etc", "/var/db"];
    return [...new Set([...lexical, ...await Promise.all(lexical.map((path) => canonicalMissing(path).catch(() => path))), ...this.discoveredProtected])];
  }

  async _refreshProtection(sources, signal) {
    const roots = [...sources.filter((source) => source.readOnly).map((source) => source.path), join(this.home, ".codex/skills/.system")];
    const visited = new Set(); let count = 0;
    this.protectionWarnings = []; this.protectionIncomplete = false;
    const remember = (path) => {
      if ([...this.discoveredProtected].some((root) => inside(root, path))) return;
      for (const root of this.discoveredProtected) if (inside(path, root)) this.discoveredProtected.delete(root);
      this.discoveredProtected.add(path);
    };
    const walk = async (path, depth = 0) => {
      check(signal);
      if (depth > 64 || count > DIRECTORY_LIMIT) {
        this.protectionIncomplete = true; this.protectionWarnings.push("只读来源超过扫描上限，暂不开放文件修改；请缩小自选扫描来源"); return;
      }
      let info, canonical;
      try { info = await lstat(path); canonical = await realpath(path); }
      catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
          this.protectionIncomplete = true; this.protectionWarnings.push(`只读来源无法完整检查：${path}`);
        }
        return;
      }
      const target = info.isSymbolicLink() ? await lstat(canonical).catch(() => null) : info;
      if (info.isSymbolicLink() || target?.isDirectory()) remember(canonical);
      if (!target?.isDirectory() || visited.has(canonical)) return;
      visited.add(canonical); count++;
      let entries;
      try { entries = await readdir(canonical, { withFileTypes: true }); }
      catch { this.protectionIncomplete = true; this.protectionWarnings.push(`只读来源无法完整检查：${path}`); return; }
      for (const entry of entries) {
        if (entry.name === TRASH_DIR || entry.name === ".git") continue;
        if (entry.isDirectory() || entry.isSymbolicLink()) await walk(join(canonical, entry.name), depth + 1);
      }
    };
    for (const path of roots) await walk(path);
  }

  async _sources(signal) {
    await this._load();
    const seeds = [
      ["通用 Agent Skills", ".agents/skills", "user", false], ["Codex Skills", ".codex/skills", "user", false],
      ["Claude Skills", ".claude/skills", "user", false], ["Pi Skills", ".pi/agent/skills", "user", false],
      ["Codex 插件", ".codex/plugins/cache", "plugin", true], ["Claude 插件", ".claude/plugins/cache", "plugin", true],
    ].map(([label, path, kind, readOnly]) => ({ label, path: join(this.home, path), kind, readOnly, custom: false }));
    let projects;
    try { projects = await this.getProjects(); } catch { projects = []; }
    for (const project of Array.isArray(projects) ? projects : []) {
      const root = project?.root || project?.path;
      if (typeof root !== "string" || !isAbsolute(root)) continue;
      for (const host of [".agents", ".codex", ".claude", ".pi"]) {
        seeds.push({ label: `${project.name || basename(root)} · ${host}`, path: join(root, host, "skills"), kind: "project", readOnly: false, custom: false });
      }
    }
    seeds.push(...this.custom.map((item) => ({ label: basename(item.path), path: item.path, kind: "custom", readOnly: false, custom: true })));
    const protectedRoots = await this._protected(), found = new Map();
    for (const seed of seeds) {
      if (found.has(seed.path)) continue;
      const info = await exists(seed.path).catch(() => null), canonical = await canonicalMissing(seed.path).catch(() => seed.path);
      const readOnly = seed.readOnly || protectedRoots.some((path) => inside(path, canonical) || inside(path, seed.path));
      found.set(seed.path, { ...seed, id: `source_${hash(seed.path).slice(0, 24)}`, readOnly,
        exists: Boolean(info), canImport: !readOnly });
    }
    await this._refreshProtection([...found.values()], signal);
    const allProtected = await this._protected();
    for (const source of found.values()) {
      const canonical = await canonicalMissing(source.path).catch(() => source.path);
      source.readOnly ||= this.protectionIncomplete || allProtected.some((path) => inside(path, canonical) || inside(path, source.path));
      source.canImport = !source.readOnly;
    }
    return [...found.values()];
  }

  async _parse(buffer, originalPath, signal) {
    check(signal);
    const temporary = await mkdtemp(join(tmpdir(), "neuma-skill-parse-"));
    try {
      const leaf = basename(dirname(originalPath)) || "skill";
      const directory = join(temporary, leaf), file = join(directory, "SKILL.md");
      await mkdir(directory, { mode: 0o700 }); await writeExclusive(file, buffer);
      const sdk = await import("@earendil-works/pi-coding-agent");
      check(signal);
      const result = sdk.loadSkills({ cwd: temporary, agentDir: temporary, skillPaths: [file], includeDefaults: false });
      return { skill: result.skills[0] ? { ...result.skills[0], filePath: originalPath, baseDir: dirname(originalPath),
        sourceInfo: sdk.createSyntheticSourceInfo(originalPath, { source: "catalog", baseDir: dirname(originalPath) }) } : null,
        diagnostics: result.diagnostics.map((item) => ({ type: item.type, message: String(item.message).replaceAll(temporary, dirname(originalPath)) })) };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  async _scan({ signal } = {}) {
    check(signal);
    const sources = await this._sources(signal), protectedRoots = await this._protected();
    const writableRoots = await Promise.all(sources.filter((source) => !source.readOnly).map((source) => canonicalMissing(source.path).catch(() => null)));
    const protectedPresent = (await Promise.all(protectedRoots.map(async (path) => await exists(path) ? path : null))).filter(Boolean);
    const entities = new Map(), warnings = [...this.protectionWarnings]; let directoryCount = 0;
    for (const source of sources) {
      if (!source.exists) continue;
      const walk = async (path, depth = 0, linkPath = null, ancestors = new Set()) => {
        check(signal);
        if (depth > 64 || ++directoryCount > DIRECTORY_LIMIT) { warnings.push(`扫描达到目录上限：${source.path}`); return; }
        let info, canonical;
        try { info = await lstat(path); canonical = await realpath(path); }
        catch (error) { warnings.push(`无法读取或链接已失效：${path}`); return; }
        if (info.isSymbolicLink()) linkPath ||= join(await realpath(dirname(path)), basename(path));
        const targetInfo = info.isSymbolicLink() ? await lstat(canonical).catch(() => null) : info;
        if (!targetInfo?.isDirectory()) return;
        if (ancestors.has(canonical)) { warnings.push(`已跳过循环目录链接：${path}`); return; }
        const branch = new Set([...ancestors, canonical]);
        let entries;
        try { entries = await readdir(path, { withFileTypes: true }); }
        catch { warnings.push(`没有目录读取权限：${path}`); return; }
        const primary = entries.find((item) => item.name === "SKILL.md");
        if (primary) {
          const file = join(path, "SKILL.md"), id = `skill_${hash(canonical).slice(0, 24)}`;
          const mainInfo = await lstat(file).catch(() => null);
          const canonicalFile = await realpath(file).catch(() => file);
          const fileInfo = await lstat(canonicalFile).catch(() => null);
          let entity = entities.get(id);
          if (!entity) {
            let parsed = { skill: null, diagnostics: [] }, content = null, revision = null;
            try {
              const data = await readBounded(canonicalFile, MAIN_LIMIT, { signal });
              content = data.buffer.toString("utf8"); revision = hash(data.buffer);
              parsed = await this._parse(data.buffer, join(canonical, "SKILL.md"), signal);
            } catch (error) {
              check(signal); parsed.diagnostics.push(diagnostic(error instanceof InputError ? error.message : "SKILL.md 无法读取"));
            }
            const protectedPath = protectedRoots.some((root) => inside(root, canonical) || inside(root, canonicalFile));
            const shared = mainInfo?.isSymbolicLink() || (fileInfo?.nlink ?? 1) > 1;
            const readOnlyReason = protectedPath ? "系统内置和插件目录只读" : shared ? "主文件为符号链接或硬链接，不能直接改写共享文件" : null;
            entity = { id, name: parsed.skill?.name || basename(canonical), description: parsed.skill?.description || "",
              filePath: join(canonical, "SKILL.md"), baseDir: canonical, locations: [], sources: [],
              diagnostics: parsed.diagnostics, readOnly: protectedPath || Boolean(shared), readOnlyReason,
              canEdit: false, canTrash: false, status: parsed.skill ? (parsed.diagnostics.length ? "warning" : "valid") : "invalid",
              _content: content, _revision: revision };
            entities.set(id, entity);
          }
          const aliasLink = linkPath || (mainInfo?.isSymbolicLink() ? join(canonical, "SKILL.md") : null);
          const currentRootReference = join(await realpath(dirname(path)), basename(path));
          const canRemoveLink = Boolean(aliasLink && [currentRootReference, join(canonical, "SKILL.md")].includes(aliasLink)
            && !source.readOnly && protectedRoots.every((root) => !inside(root, aliasLink)));
          entity.locations.push({ id: `location_${hash(`${source.id}:${file}`).slice(0, 24)}`, path: file,
            sourceId: source.id, label: source.label, isLink: Boolean(aliasLink), canRemoveLink, ...(aliasLink ? { linkPath: aliasLink } : {}) });
          if (!entity.sources.some((item) => item.id === source.id)) entity.sources.push({ id: source.id, label: source.label });
          if (!source.readOnly && !entity.readOnly) entity.canEdit = entity.canTrash = Boolean(fileInfo?.isFile());
        }
        for (const item of entries) {
          if (SKIP_DIRS.has(item.name) || item.name.startsWith(".neuma-skill-import-") || item.name === "SKILL.md") continue;
          if (item.isDirectory() || item.isSymbolicLink()) await walk(join(path, item.name), depth + 1, linkPath, branch);
        }
      };
      await walk(source.path);
    }
    for (const item of entities.values()) {
      const owned = writableRoots.some((root) => root && inside(root, item.baseDir));
      if (!owned && !item.readOnly) { item.readOnly = true; item.readOnlyReason = this.protectionIncomplete
        ? "只读来源尚未完整检查，暂不开放修改" : "实际目录尚未登记为可管理来源，可先登记目录或移除链接引用"; }
      item.canEdit = item.canEdit && owned && !item.readOnly && item._content !== null && Boolean(item._revision);
      item.canTrash = item.canTrash && owned && !item.readOnly
        && !protectedPresent.some((root) => inside(item.baseDir, root));
    }
    const all = [...entities.values()].sort((a, b) => a.name.localeCompare(b.name) || a.baseDir.localeCompare(b.baseDir));
    this.catalog = { entries: new Map(all.map((item) => [item.id, item])), sources, checkedAt: new Date().toISOString(), warnings: [...new Set(warnings)] };
    return this._publicList();
  }

  _summary(item) {
    const { _content, _revision, ...summary } = item;
    return structuredClone(summary);
  }

  _publicList() {
    return { skills: [...this.catalog.entries.values()].map((item) => this._summary(item)), sources: structuredClone(this.catalog.sources),
      checkedAt: this.catalog.checkedAt, warnings: [...this.catalog.warnings] };
  }

  async _entry(id, signal) {
    if (typeof id !== "string") throw fail("Skill 标识无效");
    await this._scan({ signal });
    const item = this.catalog.entries.get(id);
    if (!item) throw fail("Skill 已不存在或来源已移除，请刷新后重试", true);
    return item;
  }

  async _tree(root, { signal, forImport = false } = {}) {
    const canonical = await realpath(root), rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw fail("Skill 根目录必须是真实目录");
    const files = [], fingerprint = []; let total = 0;
    const walk = async (path, depth = 0) => {
      check(signal);
      if (depth > 64 || files.length >= ENTRY_LIMIT) throw fail("Skill 文件数量或目录层级超过上限");
      if (!inside(canonical, await realpath(path))) throw fail("Skill 目录已变更，请刷新后重试", true);
      for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === TRASH_DIR) continue;
        const full = join(path, entry.name), part = relative(canonical, full), info = await lstat(full);
        if (files.length >= ENTRY_LIMIT) throw fail("Skill 文件数量超过上限");
        if (forImport && credentials.test(entry.name)) throw fail(`导入目录含凭据或环境文件：${part}，请先移除这些文件`);
        fingerprint.push([part, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
        if (info.isSymbolicLink()) {
          const target = await realpath(full).catch(() => null);
          if (forImport && (!target || !inside(canonical, target))) throw fail("导入目录包含指向包外或失效的符号链接");
          const linkValue = await readlink(full);
          fingerprint.push([part, linkValue]);
          files.push({ path: part, type: "link", size: info.size, _target: target ? relative(dirname(full), target) : linkValue });
        } else if (info.isDirectory()) {
          files.push({ path: part, type: "directory", size: 0 }); await walk(full, depth + 1);
        } else if (info.isFile()) {
          total += info.size;
          if (info.size > FILE_LIMIT || total > PACKAGE_LIMIT) throw fail("Skill 整包超过上限（单文件 64 MiB，整包 256 MiB）");
          files.push({ path: part, type: "file", size: info.size, _mode: info.mode & 0o777 });
        } else if (forImport) throw fail("导入目录包含特殊文件，已停止导入");
        else files.push({ path: part, type: "other", size: info.size });
      }
    };
    await walk(canonical);
    return { files, revision: hash(JSON.stringify([canonical, rootInfo.dev, rootInfo.ino, rootInfo.mtimeMs, fingerprint])), total };
  }

  async _detail(item, signal) {
    let files = [];
    try { files = (await this._tree(item.baseDir, { signal })).files.map(({ path, type, size }) => ({ path, type, size })); }
    catch (error) { check(signal); item = { ...item, diagnostics: [...item.diagnostics, diagnostic(error instanceof InputError ? error.message : "配套文件无法读取")] }; }
    return { ...this._summary(item), content: item._content ?? "", revision: item._revision, files };
  }

  async _owned(path, { link = false } = {}) {
    const canonical = link ? join(await realpath(dirname(path)), basename(path)) : await canonicalMissing(path);
    const protectedRoots = await this._protected();
    if (protectedRoots.some((root) => inside(root, canonical) || inside(root, path))) throw fail("系统内置和插件目录只读，不能修改");
    const sources = await this._sources();
    if (this.protectionIncomplete) throw fail("只读来源尚未完整检查，暂不能修改文件，请缩小自选扫描来源");
    if ((await this._protected()).some((root) => inside(root, canonical) || inside(root, path))) throw fail("系统内置和插件目录只读，不能修改");
    for (const source of sources) {
      if (source.readOnly) continue;
      const root = await canonicalMissing(source.path).catch(() => null);
      if (root && inside(root, canonical)) return canonical;
      if (link) {
        const reference = join(await canonicalMissing(dirname(source.path)), basename(source.path));
        if (inside(reference, canonical)) return canonical;
      }
    }
    throw fail("此路径不在已登记的可管理来源中");
  }

  list(options = {}) { return this._enqueue(async () => options.refresh || !this.catalog ? this._scan(options) : this._publicList()); }
  scan(options = {}) { return this._enqueue(() => this._scan(options)); }
  sources() { return this._enqueue(() => this._sources()); }
  detail(id, options = {}) { return this._enqueue(async () => this._detail(await this._entry(id, options.signal), options.signal)); }

  save(id, { content, revision }, { signal } = {}) {
    return this._enqueue(async () => {
      if (typeof content !== "string" || Buffer.byteLength(content) > MAIN_LIMIT) throw fail("SKILL.md 必须是文本，且不超过 1 MiB");
      const item = await this._entry(id, signal);
      if (!item.canEdit || item.readOnly) throw fail(item.readOnlyReason || "此 Skill 无法编辑");
      if (!revision || revision !== item._revision) throw fail("SKILL.md 已被修改，请刷新后重新保存", true);
      const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
      if (/^---(?:\n|$)/.test(normalized) && !/\n---(?:\n|$)/.test(normalized.slice(3)))
        throw fail("SKILL.md 的 YAML 头部缺少结束分隔符");
      const parsed = await this._parse(Buffer.from(content), item.filePath, signal);
      if (!parsed.skill && parsed.diagnostics.length && !parsed.diagnostics.some((item) => item.message === "description is required"))
        throw fail("SKILL.md 的 YAML 格式无效，请修正后再保存");
      const path = await this._owned(item.filePath), current = await readBounded(path, MAIN_LIMIT, { singleLink: true, signal });
      if (hash(current.buffer) !== revision) throw fail("SKILL.md 已被修改，请刷新后重新保存", true);
      const temporary = join(item.baseDir, `.neuma-skill-edit-${randomUUID()}`);
      try {
        await realDirectory(item.baseDir);
        await writeExclusive(temporary, content, current.info.mode & 0o777);
        check(signal); await this._owned(item.filePath);
        const last = await readBounded(path, MAIN_LIMIT, { singleLink: true, signal });
        if (hash(last.buffer) !== revision || last.info.ino !== current.info.ino || last.info.dev !== current.info.dev) throw fail("SKILL.md 已被修改，请刷新后重新保存", true);
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
      this.catalog = null;
      return this._detail(await this._entry(id));
    });
  }

  addSource({ path }, { signal } = {}) {
    return this._enqueue(async () => {
      await this._load(); check(signal);
      path = localPath(path, this.home);
      const target = await realpath(path).catch(() => null), info = target ? await lstat(target) : null;
      if (!info?.isDirectory()) throw fail("来源目录不存在或无法读取");
      const current = await this._sources(signal);
      if (current.some((item) => item.path === path)) return current;
      const next = [...this.custom, { path }];
      await atomicJson(join(this.metadataDir, "sources.json"), { version: 1, sources: next }, signal);
      this.custom = next; this.catalog = null;
      return this._sources();
    });
  }

  removeSource(id) {
    return this._enqueue(async () => {
      const source = (await this._sources()).find((item) => item.id === id);
      if (!source?.custom) throw fail("只能移除自行添加的扫描来源，文件不会删除");
      const next = this.custom.filter((item) => item.path !== source.path);
      await atomicJson(join(this.metadataDir, "sources.json"), { version: 1, sources: next });
      this.custom = next; this.catalog = null;
      return this._sources();
    });
  }

  async _previewImport({ path, targetId, name }, signal) {
    check(signal);
    const sources = await this._sources(signal), target = sources.find((item) => item.id === targetId);
    if (!target?.canImport) throw fail("请选择可写的 Skill 来源目录");
    path = localPath(path, this.home);
    const source = await realpath(path).catch(() => null);
    if (!source || !(await lstat(source)).isDirectory()) throw fail("导入路径必须是本地 Skill 目录");
    const mainPath = join(source, "SKILL.md"), mainInfo = await exists(mainPath);
    if (!mainInfo?.isFile() || mainInfo.isSymbolicLink()) throw fail("导入目录必须包含普通的 SKILL.md 主文件");
    const data = await readBounded(mainPath, MAIN_LIMIT, { signal });
    name = directoryName(name || basename(path));
    const targetRoot = await this._owned(target.path), targetPath = join(targetRoot, name);
    await this._owned(targetPath);
    if (inside(source, targetPath) || inside(targetPath, source)) throw fail("导入源目录和目标目录不能互相包含");
    if (await exists(targetPath)) throw fail("目标目录已存在，请修改导入目录名", true);
    const tree = await this._tree(source, { forImport: true, signal });
    const skills = [], diagnostics = [];
    for (const file of tree.files.filter((item) => item.type === "file" && basename(item.path) === "SKILL.md")) {
      const original = join(source, file.path);
      const parsed = await this._parse((await readBounded(original, MAIN_LIMIT, { signal })).buffer, original, signal);
      skills.push({ name: parsed.skill?.name || basename(dirname(original)), path: file.path });
      diagnostics.push(...parsed.diagnostics);
    }
    return { path: source, targetPath, name, skillCount: skills.length, skills, diagnostics,
      revision: hash(JSON.stringify([source, target.id, targetPath, tree.revision, hash(data.buffer)])), _tree: tree, _target: target };
  }

  previewImport(input, { signal } = {}) {
    return this._enqueue(async () => { const { _tree, _target, ...preview } = await this._previewImport(input, signal); return preview; });
  }

  importSkill(input, { signal } = {}) {
    return this._enqueue(async () => {
      const preview = await this._previewImport(input, signal);
      if (!input.revision || input.revision !== preview.revision) throw fail("导入目录或目标已变更，请重新预览", true);
      const root = dirname(preview.targetPath);
      await realDirectory(root, true); await this._owned(root);
      const staging = join(root, `.neuma-skill-import-${randomUUID()}`);
      try {
        await mkdir(staging, { mode: 0o700 });
        for (const file of preview._tree.files) {
          check(signal);
          const from = join(preview.path, file.path), to = join(staging, file.path);
          if (file.type === "directory") await mkdir(to, { mode: 0o700 });
          else if (file.type === "link") await symlink(file._target, to);
          else if (file.type === "file") {
            const data = await readBounded(from, basename(file.path) === "SKILL.md" ? MAIN_LIMIT : FILE_LIMIT, { signal });
            await writeExclusive(to, data.buffer, file._mode);
          }
        }
        check(signal);
        if ((await this._tree(preview.path, { forImport: true, signal })).revision !== preview._tree.revision) throw fail("导入源已变更，请重新预览", true);
        await this._owned(preview.targetPath);
        if (await exists(preview.targetPath)) throw fail("目标目录已存在，请修改导入目录名", true);
        await publishDirectory(staging, preview.targetPath, signal);
      } finally { await rm(staging, { recursive: true, force: true }); }
      this.catalog = null;
      const id = `skill_${hash(await realpath(preview.targetPath)).slice(0, 24)}`;
      return this._detail(await this._entry(id));
    });
  }

  async _previewRemoval(id, { locationId, action = "skill" } = {}, signal) {
    const item = await this._entry(id, signal);
    if (!["skill", "link"].includes(action)) throw fail("移除操作无效");
    let path, location = null, revision;
    if (action === "link") {
      location = item.locations.find((entry) => entry.id === locationId);
      if (!location?.canRemoveLink || !location.linkPath) throw fail("请选择可移除的目录链接引用");
      path = await this._owned(location.linkPath, { link: true });
      const info = await lstat(path);
      if (!info.isSymbolicLink()) throw fail("链接引用已变更，请刷新后重试", true);
      revision = hash(JSON.stringify([path, info.ino, info.dev, info.mtimeMs, await readlink(path)]));
    } else {
      if (!item.canTrash || item.readOnly) throw fail(item.readOnlyReason || "此 Skill 内含受保护目录或无法移入回收区");
      path = await this._owned(item.baseDir);
      revision = (await this._tree(path, { signal })).revision;
    }
    const affected = [...this.catalog.entries.values()].filter((entry) => action === "skill" ? inside(path, entry.baseDir)
      || entry.locations.some((alias) => alias.linkPath && inside(path, alias.linkPath))
      : entry.locations.some((alias) => alias.linkPath === location.linkPath || inside(location.linkPath, alias.path)));
    const aliases = affected.flatMap((entry) => entry.locations.map((alias) => ({ ...alias, skillId: entry.id, name: entry.name })));
    return { revision: hash(JSON.stringify([action, path, revision, aliases.map((alias) => [alias.id, alias.path, alias.linkPath]).sort()])), path, skillCount: affected.length,
      skills: affected.map((entry) => ({ id: entry.id, name: entry.name, path: entry.baseDir })), aliases, action, locationId: location?.id ?? null };
  }

  previewRemoval(id, options = {}, { signal } = {}) { return this._enqueue(() => this._previewRemoval(id, options, signal)); }

  async _writeTrash(entries, signal) {
    await atomicJson(join(this.metadataDir, "trash.json"), { version: 1, entries }, signal);
    this.trash = entries;
  }

  trashSkill(id, { confirm, revision, locationId, action = "skill" }, { signal } = {}) {
    return this._enqueue(async () => {
      if (confirm !== true) throw fail("请先确认移除预览中的目录与影响范围");
      const preview = await this._previewRemoval(id, { locationId, action }, signal);
      if (!revision || revision !== preview.revision) throw fail("Skill 或链接已变更，请重新预览移除范围", true);
      const container = join(dirname(preview.path), TRASH_DIR);
      await realDirectory(container, true);
      const entry = { id: randomUUID(), originalPath: preview.path, action, trashedAt: new Date().toISOString(),
        name: preview.skills[0]?.name || basename(preview.path), skillCount: preview.skillCount, status: "prepared" };
      entry.storedPath = join(container, entry.id);
      await this._writeTrash([...this.trash, entry], signal);
      let moved = false;
      try {
        check(signal); await this._owned(preview.path, { link: action === "link" });
        const again = await this._previewRemoval(id, { locationId, action }, signal);
        if (again.revision !== preview.revision) throw fail("移除范围已变更，请重新预览", true);
        await rename(preview.path, entry.storedPath); moved = true;
        entry.status = "trashed";
        await this._writeTrash(this.trash.map((item) => item.id === entry.id ? entry : item));
      } catch (error) {
        if (moved && !await exists(preview.path)) await rename(entry.storedPath, preview.path).catch(() => {});
        if (!await exists(entry.storedPath)) await this._writeTrash(this.trash.filter((item) => item.id !== entry.id)).catch(() => {});
        this.catalog = null; throw error;
      }
      this.catalog = null;
      return structuredClone(entry);
    });
  }

  listTrash() {
    return this._enqueue(async () => {
      await this._load();
      const entries = [];
      for (const entry of this.trash) {
        if (entry.status === "restored") continue;
        await realDirectory(dirname(entry.storedPath));
        const stored = await exists(entry.storedPath);
        if (stored) entries.push({ ...entry, status: "trashed" });
      }
      return structuredClone(entries);
    });
  }

  restore(id, { signal } = {}) {
    return this._enqueue(async () => {
      await this._load(); check(signal);
      const entry = this.trash.find((item) => item.id === id && item.status !== "restored");
      if (!entry) throw fail("回收记录不存在");
      await realDirectory(dirname(entry.storedPath));
      if (!await exists(entry.storedPath)) throw fail("回收文件已不存在，请检查原目录");
      await this._owned(entry.originalPath, { link: entry.action === "link" });
      if (await exists(entry.originalPath)) throw fail("原目录已有文件，恢复不会覆盖，请先处理冲突", true);
      await realDirectory(dirname(entry.originalPath));
      if (entry.action === "skill") await publishDirectory(entry.storedPath, entry.originalPath, signal);
      else {
        // Creating the reference exclusively prevents replacing a newly created original path.
        const target = await readlink(entry.storedPath);
        check(signal);
        try { await symlink(target, entry.originalPath); }
        catch (error) { if (error.code === "EEXIST") throw fail("原位置已有文件，恢复不会覆盖", true); throw error; }
      }
      const restored = { ...entry, status: "restored", restoredAt: new Date().toISOString() };
      try { await this._writeTrash(this.trash.map((item) => item.id === id ? restored : item)); }
      catch (error) {
        if (entry.action === "link") await rm(entry.originalPath, { force: true }).catch(() => {});
        else if (!await exists(entry.storedPath)) await rename(entry.originalPath, entry.storedPath).catch(() => {});
        throw error;
      }
      if (entry.action === "link") await rm(entry.storedPath, { force: true });
      this.catalog = null;
      if (entry.action === "link") { await this._scan(); return { restored: true, path: entry.originalPath }; }
      const skillId = `skill_${hash(await realpath(entry.originalPath)).slice(0, 24)}`;
      return this._detail(await this._entry(skillId));
    });
  }

  async dispose() { await this.queue; }
}
