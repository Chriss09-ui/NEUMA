import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { InputError } from "../requirements/core.mjs";
import { GroupStorage, id } from "../collaboration/group-store.mjs";
import { MaterialStore } from "../materials/material-store.mjs";
import { MAX_MATERIAL_BYTES, materialId, materialName } from "../materials/material-formats.mjs";

const names = { list_materials: "list_main_materials", read_material: "read_main_material", read_material_image: "read_main_material_image" };
const cancelled = () => new DOMException("主对话材料传递已停止", "AbortError");

function refsOf(values) {
  if (!Array.isArray(values) || values.length > 10) throw new InputError("每轮最多传递10份主对话材料");
  const ids = values.map((value) => materialId(typeof value === "string" ? value : value?.id));
  if (new Set(ids).size !== ids.length) throw new InputError("主对话材料引用不能重复");
  return ids;
}

export class MainMaterials {
  constructor({ dataDir, collaboration, storage = new GroupStorage({ dataDir: join(dataDir, "main-materials") }), materials } = {}) {
    this.storage = storage;
    this.materials = materials ?? new MaterialStore({ storage });
    this.collaboration = collaboration;
    this.operations = new Set(); this.closing = null; this.epoch = 0;
    this.ready = Promise.resolve(storage.ready); this.ready.catch(() => {});
  }

  async upload(conversationId, options) {
    id(conversationId, "主对话"); await this.ready; await this.closing;
    return this.materials.upload(conversationId, options);
  }

  async list(conversationId) {
    id(conversationId, "主对话"); await this.ready;
    return this.materials.list(conversationId);
  }

  async resolve(conversationId, attachmentIds = []) {
    id(conversationId, "主对话"); const refs = refsOf(attachmentIds); await this.ready;
    return this.materials.resolve(conversationId, refs);
  }

  tools(conversationId) {
    id(conversationId, "主对话");
    return this.materials.tools(conversationId).map((tool) => ({ ...tool, name: names[tool.name],
      description: tool.description.replaceAll("当前 Agent", "当前主对话") }));
  }

  async forward(conversationId, groupId, attachmentIds, { mutationId, signal } = {}) {
    id(conversationId, "主对话"); id(groupId, "群"); id(mutationId, "操作");
    const refs = refsOf(attachmentIds), epoch = this.epoch;
    if (!refs.length) throw new InputError("请选择至少一份主对话材料");
    await this.ready; await this.closing;
    if (signal?.aborted || epoch !== this.epoch) throw cancelled();
    if (typeof this.collaboration?.importMaterial !== "function") throw new InputError("群材料传递尚未就绪");
    const controller = new AbortController();
    const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const operation = { controller }; operation.done = new Promise((resolve) => { operation.finish = resolve; });
    this.operations.add(operation);
    try {
      const descriptors = await this.resolve(conversationId, refs); activeSignal.throwIfAborted();
      const forwarded = [];
      for (const descriptor of descriptors) {
        activeSignal.throwIfAborted();
        const sourceId = materialId(descriptor.id), name = materialName(descriptor.name);
        if (name !== descriptor.name || !Number.isSafeInteger(descriptor.size) || descriptor.size < 1
          || descriptor.size > MAX_MATERIAL_BYTES || !/^[a-f0-9]{64}$/.test(descriptor.sha256))
          throw new InputError("主对话材料记录无效，请重新上传");
        const raw = await this.materials.raw(conversationId, sourceId);
        const expectedPath = await this.storage.path(conversationId, `attachments/${sourceId}/original/${name}`);
        if (raw.path !== expectedPath || raw.name !== name || raw.size !== descriptor.size || raw.mimeType !== descriptor.mimeType)
          throw new InputError("只能传递当前主对话自己的材料原件");
        const handle = await open(expectedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await handle.stat(); activeSignal.throwIfAborted();
          if (!info.isFile() || info.nlink !== 1 || info.size !== descriptor.size || info.size > MAX_MATERIAL_BYTES)
            throw new InputError("材料原件已改变或不是普通文件，请重新上传");
          // Verify the same open file while streaming. A failed digest aborts publication at the receiver.
          async function* source() {
            const stream = handle.createReadStream({ autoClose: false, signal: activeSignal });
            const hash = createHash("sha256"); let bytes = 0;
            try {
              for await (const chunk of stream) {
                activeSignal.throwIfAborted(); bytes += chunk.length;
                if (bytes > descriptor.size || bytes > MAX_MATERIAL_BYTES) throw new InputError("材料原件已改变，请重新上传");
                hash.update(chunk); yield chunk;
              }
              const current = await handle.stat();
              if (!current.isFile() || current.nlink !== 1 || current.size !== descriptor.size
                || bytes !== descriptor.size || hash.digest("hex") !== descriptor.sha256)
                throw new InputError("材料原件已改变，请重新上传");
            } finally { stream.destroy(); }
          }
          const childMutation = `main-file-${createHash("sha256").update(JSON.stringify({ conversationId, groupId, mutationId, sourceId })).digest("hex")}`;
          const imported = await this.collaboration.importMaterial(groupId, { name, mimeType: descriptor.mimeType,
            source: source(), mutationId: childMutation }, { signal: activeSignal });
          activeSignal.throwIfAborted(); forwarded.push(materialId(imported?.attachment?.id));
        } finally { await handle.close(); }
      }
      return { attachmentIds: forwarded };
    } catch (error) {
      if (activeSignal.aborted) throw cancelled();
      if (error instanceof InputError || error?.name === "AbortError") throw error;
      throw new InputError("主对话材料未能传递，请检查材料后重试");
    } finally { this.operations.delete(operation); operation.finish(); }
  }

  close() {
    if (this.closing) return this.closing;
    this.epoch++;
    const operations = [...this.operations];
    for (const operation of operations) operation.controller.abort();
    const closing = Promise.allSettled([this.materials.close(), ...operations.map((operation) => operation.done)]);
    this.closing = closing;
    void closing.finally(() => { if (this.closing === closing) this.closing = null; });
    return closing;
  }
}
