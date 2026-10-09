import { InputError } from "../requirements/core.mjs";

export async function routeSkills({ method, path, manager, readBody, pickFolder, signal }) {
  const options = { signal };
  if (method === "GET" && path === "/api/skills") return { value: await manager.list(options) };
  if (method === "POST" && path === "/api/skills/scan") {
    await readBody();
    return { value: await manager.scan(options) };
  }
  if (method === "GET" && path === "/api/skills/sources") return { value: { sources: await manager.sources() } };
  if (method === "POST" && path === "/api/skills/sources")
    return { value: { sources: await manager.addSource(await readBody(), options) } };
  const source = path.match(/^\/api\/skills\/sources\/([\w-]+)\/remove$/);
  if (method === "POST" && source) {
    await readBody();
    return { value: { sources: await manager.removeSource(source[1]) } };
  }
  if (method === "POST" && path === "/api/skills/pick-folder") {
    const { purpose } = await readBody();
    if (!["source", "import"].includes(purpose)) throw new InputError("请选择查找目录或导入文件夹");
    return { value: await pickFolder({ purpose, signal }) };
  }
  if (method === "POST" && path === "/api/skills/import/preview")
    return { value: await manager.previewImport(await readBody(), options) };
  if (method === "POST" && path === "/api/skills/import")
    return { value: await manager.importSkill(await readBody(), options) };
  if (method === "GET" && path === "/api/skills/trash") return { value: { entries: await manager.listTrash() } };
  const restore = path.match(/^\/api\/skills\/trash\/([\w-]+)\/restore$/);
  if (method === "POST" && restore) {
    await readBody();
    return { value: await manager.restore(restore[1], options) };
  }
  const skill = path.match(/^\/api\/skills\/([\w-]+)(?:\/(save|trash)(?:\/(preview))?)?$/);
  if (skill) {
    const [, id, action, preview] = skill;
    if (method === "GET" && !action) return { value: await manager.detail(id, options) };
    if (method === "POST" && action === "save" && !preview)
      return { value: await manager.save(id, await readBody(6 * 1024 * 1024 + 8192), options) };
    if (method === "POST" && action === "trash") {
      const body = await readBody();
      if (preview) return { value: await manager.previewRemoval(id, body, options) };
      if (body.confirm !== true) throw new InputError("请确认将这个 skill 移至回收站");
      return { value: await manager.trashSkill(id, body, options) };
    }
  }
  return null;
}
