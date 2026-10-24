import type { JsonValue } from "../contracts/json.mjs";
import type { ToolSchema, ToolInputValidation } from "../contracts/tools.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
interface DraftDiagnostic { status: string; reason: string; issues?: { path: string; reason: string; allowedFields?: string[]; requiredFields?: string[]; allowedFieldsTruncated?: boolean; requiredFieldsTruncated?: boolean }[]; issuesTruncated?: boolean }
import { createHash, randomUUID } from "node:crypto";
import { types } from "node:util";
import { InputError } from "../requirements/core.mjs";
import { architectureToolValidation } from "./architecture-tool-diagnostics.mjs";

const LIMITS = Object.freeze({ bytes: 256 * 1024, depth: 32, nodes: 100_000, updates: 24 });
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const plain = (value: object) => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
const encodePointer = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");
const hash = (nonce: string, value: unknown) => createHash("sha256").update(nonce).update(JSON.stringify(value)).digest("hex");

function fail(path: string, reason: string, message: string): never {
  throw Object.assign(new InputError(message), { validationIssue: { path, reason } });
}

function cloneJson(value: unknown, { signal, root = "submission" }: { signal?: AbortSignal | undefined; root?: string } = {}): JsonValue {
  const budget = { bytes: 0, nodes: 0 }, ancestors = new Set();
  const charge = (bytes: number) => {
    budget.bytes += bytes;
    if (budget.bytes > LIMITS.bytes) fail(root, "size_limit", "修订材料超过256KiB JSON字节额度，请只提交必要的局部字段。");
  };
  const copy = (current: unknown, depth: number): JsonValue => {
    signal?.throwIfAborted();
    if (++budget.nodes > LIMITS.nodes || depth > LIMITS.depth) fail(root, "size_limit", "修订材料超过32层或100000节点额度。");
    if (current === null || typeof current === "boolean" || typeof current === "number" && Number.isFinite(current)) {
      charge(Buffer.byteLength(JSON.stringify(current))); return current;
    }
    if (typeof current === "string") {
      if (Buffer.byteLength(current, "utf8") > LIMITS.bytes) fail(root, "size_limit", "修订字符串超过JSON字节额度。");
      charge(Buffer.byteLength(JSON.stringify(current))); return current;
    }
    if (!current || typeof current !== "object" || types.isProxy(current) || ancestors.has(current)
      || !Array.isArray(current) && !plain(current)) fail(root, "invalid_type", "修订仅接受无循环的普通JSON值。");
    const array = Array.isArray(current);
    if (array && (Object.getPrototypeOf(current) !== Array.prototype || current.length > LIMITS.nodes))
      fail(root, "invalid_type", "修订数组必须是有界普通JSON数组。");
    const descriptors = Object.getOwnPropertyDescriptors(current), ownKeys = Reflect.ownKeys(current);
    if (ownKeys.some((key) => typeof key !== "string") || array && ownKeys.length !== current.length + 1)
      fail(root, "invalid_type", "修订JSON不能包含符号、稀疏数组或额外数组字段。");
    ancestors.add(current); charge(2);
    const result: JsonValue[] | { [key: string]: JsonValue } = array ? [] : {};
    let count = 0;
    for (const key of ownKeys as string[]) {
      if (array && key === "length") continue;
      const descriptor = descriptors[key]!;
      if (forbidden.has(key) || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable
        || array && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= current.length))
        fail(root, "invalid_type", "修订JSON不能包含原型字段、访问器、隐藏或越界数组字段。");
      if (count++) charge(1);
      if (!array) {
        if (Buffer.byteLength(key, "utf8") > LIMITS.bytes) fail(root, "size_limit", "修订JSON字段超过字节额度。");
        charge(Buffer.byteLength(JSON.stringify(key)) + 1);
      }
      Reflect.set(result, key, copy(descriptor.value, depth + 1));
    }
    ancestors.delete(current); return result;
  };
  return copy(value, 0);
}

function branches(schema: ToolSchema | undefined): ToolSchema[] {
  if (!schema || typeof schema !== "object") return [];
  return [schema, ...[...schema.anyOf ?? [], ...schema.oneOf ?? [], ...schema.allOf ?? [], schema.then, schema.else]
    .flatMap(branches)];
}

function target(value: JsonValue, schema: ToolSchema, pointer: unknown, index: number) {
  const field = `revise_architecture_submission.updates[${index}].path`;
  if (typeof pointer !== "string" || !pointer.startsWith("/") || pointer.length > 500 || /~(?![01])/u.test(pointer))
    fail(field, "invalid_reference", "修订路径必须是非根JSON Pointer，且只能指向当前稿已有的声明字段。");
  const parts = pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let current: unknown = value, schemas = [schema], parent: object | undefined, key: string | undefined;
  for (const part of parts) {
    if (forbidden.has(part) || !current || typeof current !== "object")
      fail(field, "invalid_reference", "修订路径不能越界、访问原型或新增字段。");
    const descriptor = Object.getOwnPropertyDescriptor(current, part), variants = schemas.flatMap(branches);
    let next;
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(part) || Number(part) >= current.length)
        fail(field, "invalid_reference", "数组修订只允许当前已存在的规范索引，不允许追加或删除。");
      next = variants.flatMap((entry) => entry.items && typeof entry.items === "object" && !Array.isArray(entry.items) ? [entry.items] : []);
    } else next = variants.flatMap((entry) => Object.hasOwn(entry.properties ?? {}, part) ? [entry.properties![part]!] : []);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable || !next.length)
      fail(field, "invalid_reference", "路径不在当前完整稿和工具声明字段中；请替换已有的上级声明字段。");
    parent = current; key = part; current = descriptor.value; schemas = next;
  }
  return { parent: parent!, key: key!, parts, path: `/${parts.map(encodePointer).join("/")}` };
}

export function createArchitectureSubmissionRepair({ schema }: { schema: ToolSchema }) {
  const frozenSchema = structuredClone(schema), nonce = randomUUID();
  let draft: JsonValue = null, submissionHash: string | null = null;
  const reference = () => submissionHash ? { submissionHash } : null;
  const parameters = { type: "object", additionalProperties: false, required: ["submissionHash", "updates"], properties: {
    submissionHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    updates: { type: "array", minItems: 1, maxItems: LIMITS.updates, items: { type: "object", additionalProperties: false,
      required: ["path", "value"], properties: { path: { type: "string", minLength: 1, maxLength: 500 }, value: {} } } },
  }, description: "仅局部修订本轮宿主明确提供的可编辑基底或正式语义检查拒绝的完整草稿。提供当前submissionHash与最多24个已有声明字段的JSON Pointer替换；不增删字段，不替换根，允许替换整个已有数组。完整JSON及更新材料各限256KiB、32层、100000节点；仍须完整通过原结构、语义和独立评审。" };
  return { parameters, reference,
    capture(value: unknown, { signal }: { signal?: AbortSignal | undefined } = {}) {
      const candidate = cloneJson(value, { signal });
      const checked = architectureToolValidation(candidate, frozenSchema, { root: "submission" });
      if (!checked.valid) fail(checked.issues[0]!.path, checked.issues[0]!.reason, "只有通过原提交工具完整结构校验的草稿才能局部修订，请先纠正完整提交结构。");
      signal?.throwIfAborted();
      draft = candidate; submissionHash = hash(nonce, draft); return reference();
    },
    apply(value: unknown, { signal }: { signal?: AbortSignal | undefined } = {}) {
      signal?.throwIfAborted();
      if (!draft) fail("revise_architecture_submission", "required_field", "本会话尚无可修订的宿主基底或已拒绝完整稿，请先按原工具提交完整结果。");
      const params = objectFields(cloneJson(value, { signal, root: "revise_architecture_submission" }));
      if (!params || Array.isArray(params) || Object.keys(params).some((key) => !["submissionHash", "updates"].includes(key))
        || Object.keys(params).length !== 2 || params.submissionHash !== submissionHash)
        fail("revise_architecture_submission.submissionHash", "invalid_reference", "草稿版本已变化或修订参数无效，请使用当前submissionHash。");
      if (!Array.isArray(params.updates) || !params.updates.length || params.updates.length > LIMITS.updates)
        fail("revise_architecture_submission.updates", "size_limit", "每次只允许1至24个已有字段替换。");
      const candidate = cloneJson(draft, { signal }), changes: (ReturnType<typeof target> & { value: JsonValue })[] = [];
      for (const [index, update] of params.updates.entries()) {
        signal?.throwIfAborted();
        if (!update || Array.isArray(update) || typeof update !== "object" || Object.keys(update).length !== 2
          || !Object.hasOwn(update, "path") || !Object.hasOwn(update, "value"))
          fail(`revise_architecture_submission.updates[${index}]`, "invalid_type", "每个替换项只能包含path与合法JSON value。");
        const change = target(candidate, frozenSchema, update.path, index);
        if (changes.some((previous) => previous.parts.every((part, depth) => change.parts[depth] === part)
          || change.parts.every((part, depth) => previous.parts[depth] === part)))
          fail(`revise_architecture_submission.updates[${index}].path`, "invalid_reference", "修订路径不能重复或存在父子重叠，请只替换必要的单一层级。");
        changes.push({ ...change, value: update.value as JsonValue });
      }
      for (const change of changes) { signal?.throwIfAborted(); Reflect.set(change.parent, change.key, change.value); }
      return cloneJson(candidate, { signal });
    },
  };
}

export function createArchitectureUnsubmittedDraft({ schema, binding }: { schema: ToolSchema; binding: unknown }) {
  const frozenSchema = structuredClone(schema), nonce = randomUUID(), context = cloneJson(binding);
  let draft: JsonValue = null, draftHash: string | null = null, lastDiagnostic: DraftDiagnostic | null = null;
  const clear = () => { draft = null; draftHash = null; };
  const reference = () => draftHash ? { draftHash, submitToolName: "submit_architecture_draft" } : null;
  const diagnostic = () => lastDiagnostic ? structuredClone(lastDiagnostic) : null;
  const report = (reason: string, counts: Record<string, number> = {}, validation?: ToolInputValidation) => {
    const issues = validation?.issues?.slice(0, 4).map(({ path, reason, allowedFields, requiredFields, allowedFieldsTruncated, requiredFieldsTruncated }) => ({ path, reason,
      ...(allowedFields ? { allowedFields: [...allowedFields] } : {}), ...(requiredFields ? { requiredFields: [...requiredFields] } : {}),
      ...(allowedFieldsTruncated ? { allowedFieldsTruncated: true } : {}), ...(requiredFieldsTruncated ? { requiredFieldsTruncated: true } : {}) }));
    lastDiagnostic = { status: reason === "schema_valid_unsubmitted" ? "eligible_unsubmitted" : "ineligible", reason, ...counts,
      ...(issues ? { issues, issuesTruncated: validation!.issues.length > issues.length } : {}) };
    while (issues?.length && JSON.stringify(lastDiagnostic).length > 1024) {
      const issue = issues.findLast((entry) => entry.allowedFields?.length || entry.requiredFields?.length);
      if (issue) {
        const field = (issue.allowedFields?.length ?? 0) >= (issue.requiredFields?.length ?? 0) ? "allowedFields" : "requiredFields";
        issue[field]!.pop(); issue[`${field}Truncated`] = true;
      } else { issues.pop(); lastDiagnostic.issuesTruncated = true; }
    }
    return null;
  };
  const parameters = { type: "object", additionalProperties: false, required: ["draftHash"], properties: {
    draftHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
  } };
  return { parameters, reference, clear, diagnostic,
    snapshot() { return draft === null ? null : cloneJson(draft); },
    captureAssistant(input: unknown, { signal, retain = true }: { signal?: AbortSignal | undefined; retain?: boolean } = {}) {
      const message = objectFields(input);
      signal?.throwIfAborted(); clear();
      if (message?.role !== "assistant" || message.stopReason !== "stop") return report("not_normal_stop");
      if (!Array.isArray(message.content) || message.content.length !== 1 || message.content[0].type !== "text"
        || typeof message.content[0].text !== "string")
        return report("not_single_text", { contentBlocks: Array.isArray(message.content) ? message.content.length : 0 });
      const text = message.content[0].text, counts = { textBytes: Buffer.byteLength(text, "utf8"), textLength: text.length };
      if (counts.textBytes > LIMITS.bytes) return report("text_size_limit", counts);
      try {
        const value = cloneJson(JSON.parse(text), { signal, root: "unsubmittedDraft" });
        if (!value || Array.isArray(value) || typeof value !== "object") return report("not_object", counts);
        const checked = architectureToolValidation(value, frozenSchema, { root: "submission" });
        if (!checked.valid) return report("schema_rejected", counts, checked);
        signal?.throwIfAborted();
        report("schema_valid_unsubmitted", counts);
        if (retain) { draft = value; draftHash = hash(nonce, { context, value }); }
        return reference();
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof InputError || error instanceof SyntaxError)) throw error;
        if (error instanceof SyntaxError) {
          const position = /\bposition ([0-9]{1,7})\b/u.exec(error.message), offset = position ? Number(position[1]) : null;
          return report("invalid_json", { ...counts, ...(offset !== null && offset <= text.length ? { jsonOffset: offset } : {}) });
        }
        return report(objectFields(objectFields(error).validationIssue).reason === "size_limit" ? "json_size_limit" : "invalid_json_value", counts);
      }
    },
    consume(value: unknown, { signal }: { signal?: AbortSignal | undefined } = {}) {
      signal?.throwIfAborted();
      const current = draft, currentHash = draftHash; clear();
      const params = objectFields(cloneJson(value, { signal, root: "submit_architecture_draft" }));
      if (!current || !params || Array.isArray(params) || typeof params !== "object" || Object.keys(params).length !== 1
        || !Object.hasOwn(params, "draftHash") || params.draftHash !== currentHash)
        fail("submit_architecture_draft.draftHash", "invalid_reference", "未提交草稿不存在、已失效或编号不属于本轮，请使用原正式工具提交完整结果。");
      return cloneJson(current, { signal });
    },
  };
}
