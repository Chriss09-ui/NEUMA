import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { agentId as validateAgentId } from "../agents/agent-storage.mjs";
import { MaterialRunner } from "./material-runner.mjs";
import { MATERIAL_PARSER_VERSION, MAX_MATERIAL_BYTES, MAX_LEGACY_MATERIAL_BYTES, MAX_PARSER_RESPONSE, materialFailure, materialFormat, materialId, materialName, validateMaterialSignature } from "./material-formats.mjs";

const cancelled = () => new DOMException("材料读取已停止", "AbortError");
const metadataFile = (id) => `attachments/${materialId(id)}/descriptor.json`;
const schema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const idParameter = { type: "string", description: "材料列表中的 id", maxLength: 80 };
const renderedStatus = (descriptor) => descriptor.kind === "image" || descriptor.status === "uploaded" || descriptor.visionPages?.length
  ? "needs_vision" : descriptor.status === "failed" ? "ready" : descriptor.status;

async function nextChunk(iterator, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(cancelled()); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => iterator.next()).then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

function publicDescriptor(value) {
  const { agentId, schemaVersion, ...descriptor } = value;
  if (descriptor.size > MAX_MATERIAL_BYTES) Object.assign(descriptor, { status: "failed", failureReason: "material_too_large", error: "材料超过 20 MiB，请缩小文件后重新上传" });
  return structuredClone(descriptor);
}

function requireMaterialSize(descriptor) {
  if (descriptor.size > MAX_MATERIAL_BYTES) throw materialFailure("material_too_large", "材料超过 20 MiB，请缩小文件后重新上传");
  return descriptor;
}

function validDescriptor(value, agentId, id) {
  if (!value || value.schemaVersion !== 1 || value.agentId !== agentId || value.id !== id || materialName(value.name) !== value.name
      || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_LEGACY_MATERIAL_BYTES || !/^[a-f0-9]{64}$/.test(value.sha256)
      || value.kind !== materialFormat(value.name).kind || typeof value.mimeType !== "string"
      || !["uploaded", "ready", "needs_vision", "failed"].includes(value.status)) throw materialFailure("invalid_material", "材料记录无效，请保留原文件并重新上传");
  return value;
}

export class MaterialStore {
  constructor({ storage, runner = new MaterialRunner() }) {
    if (!storage?.directory || !storage?.readJson || !storage?.writeJson) throw new TypeError("MaterialStore requires AgentStorage");
    this.storage = storage; this.runner = runner; this.flights = new Map(); this.work = new Set(); this.operations = new Set(); this.updates = new Map(); this.closing = null;
  }

  async upload(agentId, { name, mimeType, source, signal } = {}) {
    await this.closing;
    validateAgentId(agentId); const safeName = materialName(name), format = materialFormat(safeName), id = randomUUID();
    signal?.throwIfAborted();
    if (!Buffer.isBuffer(source) && !(source instanceof Uint8Array) && !source?.[Symbol.asyncIterator]) throw materialFailure("invalid_material", "上传请求缺少文件内容");
    const rawPath = await this.storage.path(agentId, `workspace/inputs/${id}/${safeName}`, true);
    const privatePath = await this.storage.path(agentId, `attachments/${id}/original/${safeName}`, true);
    let published = false, handle, originalHandle;
    const controller = new AbortController(), onAbort = () => controller.abort();
    const operation = { controller }; operation.done = new Promise((resolve) => { operation.finish = resolve; });
    signal?.addEventListener("abort", onAbort, { once: true }); this.operations.add(operation);
    try {
      if (signal?.aborted) controller.abort(); controller.signal.throwIfAborted();
      handle = await open(rawPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      originalHandle = await open(privatePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const hash = createHash("sha256"); let size = 0, prefix = Buffer.alloc(0);
      const chunks = Buffer.isBuffer(source) || source instanceof Uint8Array ? [source] : source;
      const iterator = chunks[Symbol.asyncIterator]?.() ?? chunks[Symbol.iterator]();
      while (true) {
        const step = await nextChunk(iterator, controller.signal);
        if (step.done) break;
        const value = step.value;
        controller.signal.throwIfAborted();
        if (!(value instanceof Uint8Array)) throw materialFailure("invalid_material", "上传文件数据无效");
        const chunk = Buffer.from(value); size += chunk.length;
        if (size > MAX_MATERIAL_BYTES) throw materialFailure("material_too_large", "单个材料不能超过 20 MiB");
        if (prefix.length < 16) prefix = Buffer.concat([prefix, chunk.subarray(0, 16 - prefix.length)]);
        hash.update(chunk); await handle.writeFile(chunk); await originalHandle.writeFile(chunk);
      }
      controller.signal.throwIfAborted();
      if (!size) throw materialFailure("material_empty", "不能上传空文件");
      validateMaterialSignature(format, prefix); await handle.chmod(0o400); await originalHandle.chmod(0o400);
      await handle.close(); handle = null; await originalHandle.close(); originalHandle = null;
      const descriptor = { schemaVersion: 1, agentId, id, name: safeName, mimeType: format.mimeType, kind: format.kind, size,
        sha256: hash.digest("hex"), parserVersion: MATERIAL_PARSER_VERSION, status: "uploaded", createdAt: new Date().toISOString() };
      await this.storage.writeJson(agentId, metadataFile(id), descriptor, { signal: controller.signal }); published = true;
      return { attachment: publicDescriptor(descriptor) };
    } finally {
      await handle?.close(); await originalHandle?.close(); signal?.removeEventListener("abort", onAbort);
      try { if (!published) { await this.storage.removeDirectory(agentId, `workspace/inputs/${id}`); await this.storage.removeDirectory(agentId, `attachments/${id}`); } }
      finally { this.operations.delete(operation); operation.finish(); }
    }
  }

  async get(agentId, id) {
    validateAgentId(agentId); materialId(id);
    const value = await this.storage.readJson(agentId, metadataFile(id), { maxBytes: 64 * 1024 });
    if (!value) throw materialFailure("material_missing", "没有找到当前 Agent 的这份材料");
    return publicDescriptor(validDescriptor(value, agentId, id));
  }

  async list(agentId) {
    validateAgentId(agentId); let root;
    try { root = await this.storage.directory(agentId, "attachments"); } catch (error) { if (error.code === "ENOENT") return { attachments: [] }; throw error; }
    const attachments = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      materialId(entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw materialFailure("invalid_material", "材料目录只允许普通目录");
      const value = await this.storage.readJson(agentId, metadataFile(entry.name), { maxBytes: 64 * 1024 });
      if (value) attachments.push(publicDescriptor(validDescriptor(value, agentId, entry.name)));
    }
    return { attachments: attachments.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  }

  async raw(agentId, id) {
    const descriptor = requireMaterialSize(await this.get(agentId, id)), path = await this.storage.path(agentId, `attachments/${id}/original/${descriptor.name}`);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size !== descriptor.size || info.size > MAX_MATERIAL_BYTES) throw materialFailure("material_changed", "原始材料已被修改，请重新上传");
    } finally { await handle.close(); }
    return { path, name: descriptor.name, mimeType: descriptor.mimeType, size: descriptor.size };
  }

  async verify(agentId, descriptor, signal) {
    signal?.throwIfAborted();
    const raw = await this.raw(agentId, descriptor.id), handle = await open(raw.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size !== descriptor.size) throw materialFailure("material_changed", "原始材料已被修改，请重新上传");
      const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let bytes = 0;
      while (true) {
        signal?.throwIfAborted(); const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes);
        if (!bytesRead) break;
        bytes += bytesRead;
        if (bytes > MAX_MATERIAL_BYTES) throw materialFailure("material_too_large", "材料超过 20 MiB");
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (bytes !== descriptor.size || hash.digest("hex") !== descriptor.sha256) throw materialFailure("material_changed", "原始材料已被修改，请重新上传");
      return raw;
    } finally { await handle.close(); }
  }

  async execute(agentId, descriptor, request, signal) {
    const raw = await this.verify(agentId, descriptor, signal), jobId = randomUUID(), subpath = `attachments/${descriptor.id}/jobs/${jobId}`;
    const scratch = await this.storage.directory(agentId, subpath, { create: true });
    try { return await this.runner.run({ ...request, path: raw.path, name: descriptor.name, mimeType: descriptor.mimeType, sha256: descriptor.sha256, scratch }, { signal }); }
    finally { await this.storage.removeDirectory(agentId, subpath); }
  }

  async shared(key, action, signal) {
    signal?.throwIfAborted();
    let flight = this.flights.get(key);
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController();
      flight = { controller, subscribers: new Set() };
      flight.promise = Promise.resolve().then(() => action(controller.signal)).finally(() => {
        if (this.flights.get(key) === flight) this.flights.delete(key);
        this.work.delete(flight.promise);
      });
      this.work.add(flight.promise);
      flight.promise.catch(() => {}); this.flights.set(key, flight);
    }
    const token = {}; flight.subscribers.add(token);
    return new Promise((resolve, reject) => {
      let settled = false;
      const release = () => { flight.subscribers.delete(token); signal?.removeEventListener("abort", abort); if (!flight.subscribers.size) flight.controller.abort(); };
      const complete = (error, value) => { if (settled) return; settled = true; release(); error ? reject(error) : resolve(value); };
      const abort = () => complete(cancelled());
      signal?.addEventListener("abort", abort, { once: true });
      flight.promise.then((value) => complete(null, value), (error) => complete(error));
      if (signal?.aborted) abort();
    });
  }

  async parsed(agentId, descriptor, signal) {
    try { return await this.parseCached(agentId, descriptor, signal); }
    catch (error) { await this.recordFailure(agentId, descriptor.id, error, signal); throw error; }
  }

  async updateDescriptor(agentId, id, updates, signal) {
    const key = `${agentId}:${id}`, previous = this.updates.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      const current = await this.get(agentId, id);
      await this.storage.writeJson(agentId, metadataFile(id), { ...current, schemaVersion: 1, agentId, ...updates }, { signal });
    });
    this.updates.set(key, next);
    try { await next; } finally { if (this.updates.get(key) === next) this.updates.delete(key); }
  }

  async recordFailure(agentId, id, error, signal) {
    if (signal?.aborted || error?.name === "AbortError" || !/^material_(?:parser_failed|parse_failed|output_limit|timeout|encrypted|changed|image_failed|image_limit|image_unsupported|binary_text|encoding)$/.test(error?.reason ?? "")) return;
    await this.updateDescriptor(agentId, id, { status: "failed", error: error.message, failureReason: error.reason }).catch(() => {});
  }

  async parseCached(agentId, descriptor, signal) {
    await this.verify(agentId, descriptor, signal);
    const file = `attachments/${descriptor.id}/cache/${descriptor.sha256}.${MATERIAL_PARSER_VERSION}.json`;
    const cached = await this.storage.readJson(agentId, file, { maxBytes: MAX_PARSER_RESPONSE });
    if (cached?.parserVersion === MATERIAL_PARSER_VERSION && cached.sha256 === descriptor.sha256 && typeof cached.result?.text === "string") {
      if (descriptor.status !== cached.result.status || descriptor.parserVersion !== MATERIAL_PARSER_VERSION)
        await this.updateDescriptor(agentId, descriptor.id, { status: cached.result.status, error: null, failureReason: null, parserVersion: MATERIAL_PARSER_VERSION }, signal);
      return cached.result;
    }
    return this.shared(`${agentId}:${descriptor.id}:parse`, async (jobSignal) => {
      const result = await this.execute(agentId, descriptor, { action: "parse" }, jobSignal);
      jobSignal.throwIfAborted(); await this.verify(agentId, descriptor, jobSignal);
      if (typeof result.text !== "string" || !Array.isArray(result.locations) || !Array.isArray(result.images)) throw materialFailure("material_parser_failed", "解析结果格式无效");
      await this.storage.writeJson(agentId, file, { parserVersion: MATERIAL_PARSER_VERSION, sha256: descriptor.sha256, result }, { signal: jobSignal });
      await this.updateDescriptor(agentId, descriptor.id, { parserVersion: MATERIAL_PARSER_VERSION, error: null, failureReason: null,
        status: result.status, pageCount: result.pageCount, warnings: result.warnings ?? [], visionPages: result.visionPages ?? [],
        images: result.images.map(({ data, ...image }) => image), ...(result.sheetNames?.length ? { sheetNames: result.sheetNames } : {}) }, jobSignal);
      return result;
    }, signal);
  }

  async preview(agentId, id, { offset = 0, signal } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw materialFailure("invalid_material_offset", "材料续读位置无效");
    const descriptor = await this.get(agentId, id), result = await this.parsed(agentId, descriptor, signal);
    const text = result.text || (descriptor.kind === "image" ? "这份材料是图片，请使用图片读取工具查看。" : "没有提取到可读文字，请使用图片读取工具查看材料页。");
    if (offset > text.length) throw materialFailure("invalid_material_offset", "材料续读位置超出范围");
    let end = Math.min(offset + 24_000, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    const locations = result.locations.filter((part) => part.end > offset && part.start < end).slice(0, 40);
    const lineStart = descriptor.kind === "text" ? text.slice(0, offset).split(/\r\n|\r|\n/).length : undefined;
    return { attachment: await this.get(agentId, id), text: text.slice(offset, end), nextOffset: end < text.length ? end : null,
      truncated: end < text.length || Boolean(result.truncated), warnings: result.warnings ?? [],
      sourceInfo: { id, name: descriptor.name, sha256: descriptor.sha256, parserVersion: MATERIAL_PARSER_VERSION, offset, end,
        ...(lineStart ? { lineStart, lineEnd: lineStart + text.slice(offset, end).split(/\r\n|\r|\n/).length - 1 } : {}),
        locations, pageCount: result.pageCount, ...(result.sheetNames?.length ? { sheetNames: result.sheetNames } : {}), visionPages: result.visionPages ?? [] } };
  }

  async image(agentId, id, { page = 1, imageId, signal } = {}) {
    try { return await this.imageCached(agentId, id, { page, imageId, signal }); }
    catch (error) { await this.recordFailure(agentId, id, error, signal); throw error; }
  }

  async imageCached(agentId, id, { page = 1, imageId, signal } = {}) {
    if (!Number.isSafeInteger(page) || page < 1 || imageId !== undefined && !/^image-\d+$/.test(imageId)) throw materialFailure("invalid_material_page", "材料页码或图片标识无效");
    const descriptor = await this.get(agentId, id); await this.verify(agentId, descriptor, signal);
    if (imageId || !["image", "pdf"].includes(descriptor.kind)) {
      const result = await this.parsed(agentId, descriptor, signal);
      const image = imageId ? result.images.find((value) => value.id === imageId) : result.images[0];
      if (!image) throw materialFailure("material_no_image", "这份材料中没有找到可读取的图片");
      return { ...image, sourceInfo: { id, name: descriptor.name, imageId: image.id, page: image.page, source: "embedded",
        ...(image.part ? { part: image.part } : {}), ...(image.slides?.length ? { slides: image.slides } : {}) } };
    }
    const file = `attachments/${id}/rendered/${descriptor.sha256}.${MATERIAL_PARSER_VERSION}.${page}.json`;
    const cached = await this.storage.readJson(agentId, file, { maxBytes: 12 * 1024 * 1024 });
    const decorate = (result) => ({ ...result, sourceInfo: { id, name: descriptor.name, page, sha256: descriptor.sha256, parserVersion: MATERIAL_PARSER_VERSION } });
    if (cached?.sha256 === descriptor.sha256 && cached.parserVersion === MATERIAL_PARSER_VERSION && typeof cached.result?.data === "string") {
      if (descriptor.status === "failed" || descriptor.status === "uploaded" || descriptor.pageCount !== cached.result.pageCount)
        await this.updateDescriptor(agentId, id, { pageCount: cached.result.pageCount, warnings: cached.result.warnings ?? [],
          status: renderedStatus(descriptor), error: null, failureReason: null }, signal);
      return decorate(cached.result);
    }
    const result = await this.shared(`${agentId}:${id}:image:${page}`, async (jobSignal) => {
      const rendered = await this.execute(agentId, descriptor, { action: "image", page }, jobSignal);
      jobSignal.throwIfAborted(); await this.verify(agentId, descriptor, jobSignal);
      if (rendered.mimeType !== "image/png" || typeof rendered.data !== "string" || rendered.data.length > 12 * 1024 * 1024) throw materialFailure("material_image_failed", "图片处理结果无效");
      await this.storage.writeJson(agentId, file, { sha256: descriptor.sha256, parserVersion: MATERIAL_PARSER_VERSION, result: rendered }, { signal: jobSignal });
      const current = await this.get(agentId, id);
      await this.updateDescriptor(agentId, id, { pageCount: rendered.pageCount, warnings: [...new Set([...(current.warnings ?? []), ...(rendered.warnings ?? [])])],
        status: renderedStatus(current),
        error: null, failureReason: null, parserVersion: MATERIAL_PARSER_VERSION }, jobSignal);
      return rendered;
    }, signal);
    return decorate(result);
  }

  async resolve(agentId, refs = []) {
    if (!Array.isArray(refs) || refs.length > 10) throw materialFailure("invalid_material", "每轮最多引用 10 份材料");
    const ids = refs.map((value) => materialId(typeof value === "string" ? value : value?.id));
    if (new Set(ids).size !== ids.length) throw materialFailure("invalid_material", "材料引用不能重复");
    return Promise.all(ids.map(async (id) => requireMaterialSize(await this.get(agentId, id))));
  }

  tools(agentId) {
    validateAgentId(agentId);
    const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: {} });
    return [
      { name: "list_materials", label: "正在查看上传材料…", description: "列出当前 Agent 上传的材料及材料 id。", executionMode: "sequential", parameters: schema({}),
        execute: async (_call, _params, signal) => { signal?.throwIfAborted(); return text(await this.list(agentId)); } },
      { name: "read_material", label: "正在阅读材料…", description: "按 id 阅读当前 Agent 的材料；长材料用 nextOffset 续读。返回页码、行号或工作表等真实来源。", executionMode: "sequential",
        parameters: schema({ id: idParameter, offset: { type: "integer", minimum: 0 } }, ["id"]),
        execute: async (_call, { id, offset }, signal) => text(await this.preview(agentId, id, { offset, signal })) },
      { name: "read_material_image", label: "正在查看材料图片…", description: "读取图片、PDF 的指定页或文档图片；page 从 1 开始。扫描 PDF 使用此工具，GIF 只读取第一帧。", executionMode: "sequential",
        parameters: schema({ id: idParameter, page: { type: "integer", minimum: 1 }, imageId: { type: "string", pattern: "^image-\\d+$" } }, ["id"]),
        execute: async (_call, { id, page, imageId }, signal) => { const result = await this.image(agentId, id, { page, imageId, signal }); const { data, ...info } = result;
          return { content: [{ type: "text", text: JSON.stringify(info) }, { type: "image", mimeType: result.mimeType, data }], details: {} }; } },
    ];
  }

  async close() {
    if (this.closing) return this.closing;
    const operations = [...this.operations];
    for (const { controller } of operations) controller.abort();
    const flights = [...this.flights.values()];
    for (const flight of flights) flight.controller.abort();
    this.closing = Promise.allSettled([this.runner.close?.(), ...this.work, ...operations.map((operation) => operation.done), ...this.updates.values()]);
    try { await this.closing; } finally { this.closing = null; }
  }
}
