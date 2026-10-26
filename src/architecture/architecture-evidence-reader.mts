import type { UnknownRecord } from "../contracts/json.mjs";
import type { ToolSchema } from "../contracts/tools.mjs";
import type { NeumaTool } from "../runtime/execution-port.mjs";
import { objectFields, isRecord, isInteger } from "../runtime/type-boundary.mjs";
type EvidenceSource = "candidate" | "requirements" | "runtimeCapabilities" | "contextManifest" | "evidence" | "confirmedRequirementContext" | "deferredVerifications" | "acceptanceAdapterGuide";
interface EvidenceRequest { source: EvidenceSource; pointer: string; offset?: number; limit?: number; pathOffset?: number; acceptanceId?: string }
interface EvidenceReference { source: EvidenceSource; path: string; quote: string }
interface EvidenceReceipt { role: string; candidateHash: unknown; contextHash: string; reference: EvidenceReference; quoteHash: string }
interface ScopeEntry { acceptanceId: string; adapterId: string; scope: string; criterionPath: string; adapterRulePaths: string[] }
interface ScopeReceipt { role: string; candidateHash: unknown; contextHash: string; criterionPath: string; pointer: string;
  row: { acceptanceId: string; adapterId: string; scope: string; criterionQuote: string; adapterQuote: string } }
interface EvidenceIndex { sources: { source: string; path: string }[]; candidate: Record<string, { id?: string; path: string }[]>;
  requirements: { id: string; path: string }[]; priorFindings?: { findingRef: string; findingId: unknown }[]; acceptanceScope?: ScopeEntry[] }
interface ReadPage extends UnknownRecord { found: boolean; contextHash: string; receiptId?: string; reference?: EvidenceReference;
  quoteHash?: string; candidateHash?: unknown; total?: number; offset?: number; nextOffset?: number | null; offsetUnit?: string }
interface ReferenceHint extends UnknownRecord { issuePath: unknown; reference: { receiptId: string }; source: EvidenceSource; path: string; quote: string }
/** Resolution preserves uninspected input fields and types only the selectors this reader expands. */
type ResolvedReference<T> = T extends { receiptId: string } ? EvidenceReference
  : T extends { source: string; path: string } ? T & { quote: string } : T;
type ResolvedReferences<T> = T extends unknown[] ? ResolvedReference<T[number]>[] : T;
type ResolvedCandidatePaths<T> = T extends unknown[] ? (T[number] extends infer R ? R extends { receiptId: string } ? string : R : never)[] : T;
type ResolvedFinding<T, K extends "id" | "findingId"> = T extends { findingRef: unknown } ? Omit<T, "findingRef"> & Record<K, unknown> : T;
type ResolvedIssue<T> = ResolvedFinding<{ [K in keyof T]: K extends "references" ? ResolvedReferences<T[K]>
  : K extends "candidatePaths" ? ResolvedCandidatePaths<T[K]> : T[K] }, "id">;
type ResolvedIssues<T> = T extends unknown[] ? ResolvedIssue<T[number]>[] : T;
type ResolvedFindings<T> = T extends unknown[] ? ResolvedFinding<T[number], "findingId">[] : T;
type ResolvedScope<T> = T extends { adapterRulePath: string } | { scopeReceiptId: string }
  ? Omit<T, "adapterRulePath" | "scopeReceiptId"> & { adapterId: string; scope: string; criterionQuote: string; adapterQuote: string } : T;
type ResolvedScopes<T> = T extends unknown[] ? ResolvedScope<T[number]>[] : T;
export type ResolvedReviewSubmission<T> = { [K in keyof T]: K extends "issues" ? ResolvedIssues<T[K]>
  : K extends "priorFindingDecisions" ? ResolvedFindings<T[K]> : K extends "acceptanceScopeChecks" ? ResolvedScopes<T[K]> : T[K] };
const sourceName = (value: unknown): value is EvidenceSource => typeof value === "string" && SOURCES.some((source) => source === value);
const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

import { createHash, randomUUID } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { ACCEPTANCE_ADAPTERS, validateAcceptanceVerification } from "../verification/acceptance-contract.mjs";

const SOURCES: EvidenceSource[] = ["candidate", "requirements", "runtimeCapabilities", "contextManifest", "evidence", "confirmedRequirementContext", "deferredVerifications", "acceptanceAdapterGuide"];
const object = (properties: Record<string, ToolSchema>): ToolSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const RECEIPT_SCHEMA = object({ receiptId: { type: "string", pattern: "^ref_[a-f0-9]{64}$" } });
const REFERENCE_SELECTOR_SCHEMA = object({ source: { type: "string", enum: SOURCES }, path: { type: "string", maxLength: 500 } });
const SCOPE_RECEIPT_SCHEMA = { type: "string", pattern: "^scope_[a-f0-9]{64}$" };
const REQUEST_FIELDS = {
  source: { type: "string", enum: SOURCES }, pointer: { type: "string", maxLength: 500 },
  offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, limit: { type: "integer", minimum: 1, maximum: 1000 },
  pathOffset: { type: "integer", minimum: 0, maximum: 512 },
  acceptanceId: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,79}$" },
};
const REQUEST_SCHEMA = { type: "object", properties: REQUEST_FIELDS, required: ["source", "pointer"], additionalProperties: false };
const MAX_BATCH_QUOTE_BYTES = 24 * 1024;
const stableId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(value);
const encodePointer = (value: string) => value.replace(/~/g, "~0").replace(/\//g, "~1");
const SAFE_KEYS = new Set(["id", "text", "content", "value", "label", "source", "kind", "evidence", "messageId", "quote", "version", "items",
  "requirements", "resolvedIssues", "decisions", "issueId", "dimension", "critical", "applicability", "reason", "status", "adapters",
  "stage", "owner", "scope", "proves", "doesNotProve", "splitRule", "delivery", "characters", "sha256"]);

function at(value: unknown, pointer: unknown): { found: boolean; value?: unknown } {
  if (pointer === "") return { found: true, value };
  if (typeof pointer !== "string" || !pointer.startsWith("/") || /~(?![01])/u.test(pointer)) return { found: false };
  let current = value;
  for (const key of pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (["__proto__", "prototype", "constructor"].includes(key) || !current || typeof current !== "object") return { found: false };
    const entry = Object.getOwnPropertyDescriptor(current, key);
    if (!entry || !Object.hasOwn(entry, "value")) return { found: false };
    current = entry.value;
  }
  return { found: true, value: current };
}

function declaredKeys(schema: ToolSchema | undefined, result = new Set(SAFE_KEYS)): Set<string> {
  if (!schema || typeof schema !== "object") return result;
  for (const [key, child] of Object.entries(schema.properties ?? {})) { result.add(key); declaredKeys(child, result); }
  declaredKeys(schema.items, result);
  for (const child of [...schema.anyOf ?? [], ...schema.allOf ?? [], ...schema.oneOf ?? []]) declaredKeys(child, result);
  return result;
}

function safePaths(value: unknown, keys: Set<string>, limit = 512, root = "") {
  const paths: string[] = [], stack = [{ value, path: root, depth: 0 }];
  while (stack.length && paths.length < limit) {
    const current = stack.pop()!; paths.push(current.path);
    if (!current.value || typeof current.value !== "object" || current.depth >= 12) continue;
    const entries = Object.entries(current.value).filter(([key]) => Array.isArray(current.value) ? /^\d{1,5}$/.test(key) : keys.has(key));
    for (const [key, child] of entries.reverse()) stack.push({ value: child,
      path: `${current.path}/${encodePointer(key)}`, depth: current.depth + 1 });
  }
  return { paths, truncated: stack.length > 0 };
}

function nearbyPaths(value: unknown, pointer: unknown, keys: Set<string>, fallback: ReturnType<typeof safePaths>) {
  if (typeof pointer !== "string" || !pointer.startsWith("/") || /~(?![01])/u.test(pointer)) return fallback;
  const parts = pointer.slice(1).split("/");
  const branch = parts[0]!.replace(/~1/g, "/").replace(/~0/g, "~");
  if (!(Array.isArray(value) ? /^\d{1,5}$/u.test(branch) : keys.has(branch))) return fallback;
  let nearest, current = value;
  for (let length = 1; length < parts.length; length++) {
    const key = parts[length - 1]!.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!(Array.isArray(current) ? /^\d{1,5}$/u.test(key) : keys.has(key))) break;
    const path = `/${parts.slice(0, length).join("/")}`, selected = at(value, path);
    if (!selected.found) break;
    nearest = { path, value: selected.value }; current = selected.value;
  }
  return nearest ? safePaths(nearest.value, keys, 512, nearest.path) : fallback;
}

function evidenceIndex(context: UnknownRecord, candidateSchema: ToolSchema | undefined): EvidenceIndex {
  const candidate: EvidenceIndex["candidate"] = {}, design = objectFields(context.candidate);
  for (const [key, schema] of Object.entries(candidateSchema?.properties ?? {})) {
    if (schema?.type !== "array" || !Array.isArray(design[key])) continue;
    candidate[key] = rows(design[key]).map((input, index) => {
      const item = objectFields(input);
      const id = stableId(item?.id) ? item.id : stableId(item?.requirementId) ? item.requirementId : undefined;
      return { ...(id ? { id } : {}), path: `/${encodePointer(key)}/${index}` };
    });
  }
  return { sources: SOURCES.filter((source) => Object.hasOwn(context, source)).map((source) => ({ source, path: "" })), candidate,
    requirements: Array.isArray(context.requirements) ? rows(context.requirements).flatMap((input, index) => { const item = objectFields(input); return stableId(item.id) ? [{ id: item.id, path: `/${index}` }] : []; }) : [] };
}

function validRequest(input: unknown): input is EvidenceRequest {
  const value = objectFields(input);
  return isRecord(input)
    && Object.keys(value).every((key) => Object.hasOwn(REQUEST_FIELDS, key))
    && sourceName(value.source) && typeof value.pointer === "string" && value.pointer.length <= 500
    && (value.offset === undefined || isInteger(value.offset) && value.offset >= 0)
    && (value.limit === undefined || isInteger(value.limit) && value.limit >= 1 && value.limit <= 1000)
    && (value.pathOffset === undefined || isInteger(value.pathOffset) && value.pathOffset >= 0 && value.pathOffset <= 512)
    && (value.acceptanceId === undefined || stableId(value.acceptanceId) && value.source === "acceptanceAdapterGuide"
      && ["offset", "limit", "pathOffset"].every((key) => !Object.hasOwn(value, key)));
}

function adapterRulePaths(guide: unknown, adapterId: string) {
  const admission = objectFields(objectFields(objectFields(guide).admission)[adapterId]);
  const paths = [
    ...["proves", "doesNotProve", "splitRule", "executionRule"].map((key) => `/adapters/${adapterId}/${key}`),
    ...["caseSetRule", "requirementCoverageRule", "splitRule", ...(adapterId === "host-business" ? ["hostBusinessRule"] : [])]
      .map((key) => `/composition/${key}`),
    ...["rule", "measure", "outcomeRule"].map((key) => `/admission/${adapterId}/${key}`),
    ...(Array.isArray(admission.excludedProof)
      ? rows(admission.excludedProof).map((_item, index) => `/admission/${adapterId}/excludedProof/${index}`) : []),
  ];
  return paths.filter((path) => { const selected = at(guide, path); return typeof selected.value === "string" && selected.value.trim(); });
}

function sliceQuote(text: string, offset: number, limit: number, byteLimit: number) {
  let start = offset, end;
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!) && /[\uD800-\uDBFF]/u.test(text[start - 1]!)) start--;
  end = Math.min(text.length, start + limit);
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end]!) && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
  if (end <= start) end = Math.min(text.length, start + 2);
  let quote = text.slice(start, end);
  while (Buffer.byteLength(quote, "utf8") > byteLimit && end > start) {
    end--;
    if (end > start && /[\uDC00-\uDFFF]/u.test(text[end]!) && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
    quote = text.slice(start, end);
  }
  return { start, end, quote };
}

function receiptError(path: string, reason = "invalid_receipt") {
  return Object.assign(new InputError(`${path} 引用回执未知、过期或格式混合；请在本次评审重新读取证据，不要重写回执。`),
    { validationIssue: { path, reason } });
}

function selectorError(path: string, reason: string, entry?: ScopeEntry | null) {
  const diagnostic = { path, reason, allowedAdapterRulePaths: entry?.adapterRulePaths ?? [] };
  return Object.assign(new InputError("范围规则选择无效；仅能选择本轮完整材料中本条实际适配器的合法规则：" + JSON.stringify(diagnostic)),
    { validationIssue: { path, reason } });
}

function referenceSelectorError(path: string, reason: string, reference?: UnknownRecord, characters?: number) {
  const validationIssue = { path, reason, ...(reference ? { source: reference.source, sourcePath: reference.path } : {}),
    ...(characters === undefined ? {} : { characters, limit: 1000 }),
    remedy: "选择具体子字段，或用 read_architecture_evidence 读取局部原文后显式选择 receiptId；引用仍须支持判断。" };
  return Object.assign(new InputError("评审原文选择无效；只引用本轮完整材料中存在且不超过1000字符的具体字段：" + JSON.stringify(validationIssue)),
    { validationIssue });
}

export function createArchitectureEvidenceReader({ context, candidateHash, candidateSchema, priorFindings, role = "reviewer" }: {
  context: unknown; candidateHash: unknown; candidateSchema?: ToolSchema | undefined; priorFindings?: unknown; role?: string
}) {
  const frozen = objectFields(structuredClone(context)), contextHash = hash(JSON.stringify(frozen)), nonce = randomUUID(), receipts = new Map<string, EvidenceReceipt>();
  const scopeReceipts = new Map<string, ScopeReceipt>();
  const keys = declaredKeys(candidateSchema);
  for (const source of SOURCES) keys.add(source);
  for (const key of Object.keys(objectFields(objectFields(frozen.acceptanceAdapterGuide).adapters))) keys.add(key);
  const pathCatalog = new Map(SOURCES.map((source) => [source, safePaths(frozen[source], keys)]));
  const parameters = { type: "object", additionalProperties: false,
    properties: { ...REQUEST_FIELDS, requests: { type: "array", minItems: 1, maxItems: 16, items: REQUEST_SCHEMA } },
    oneOf: [{ required: ["source", "pointer"], not: { required: ["requests"] } },
      { required: ["requests"], not: { anyOf: Object.keys(REQUEST_FIELDS).map((key) => ({ required: [key] })) } }] };
  const index = evidenceIndex(frozen, candidateSchema);
  const priorRows = objectFields(priorFindings).findings ?? [];
  if (!Array.isArray(priorRows)) throw new InputError("历史问题索引字段无效");
  const findingEntries = priorRows.map((rawFinding, position) => { const finding = objectFields(rawFinding); return ({
    findingRef: `F${position + 1}_${hash(JSON.stringify({ candidateHash, current: objectFields(priorFindings).current, finding })).slice(0, 12)}`,
    findingId: finding.findingId,
  }); });
  if (findingEntries.length) index.priorFindings = findingEntries;
  const findingReferenceError = (path: string) => Object.assign(new InputError("历史问题引用无效；请从本轮reviewEvidenceIndex.priorFindings选择findingRef，不截短编号，也不混填完整编号。"),
    { validationIssue: { path, reason: "invalid_reference" } });
  const resolveFinding = (row: unknown, field: string, path: string, submittedHash: unknown): unknown => {
    if (!row || typeof row !== "object" || !Object.hasOwn(row, "findingRef")) return row;
    const item = objectFields(row);
    const entry = findingEntries.find(entry => entry.findingRef === item.findingRef);
    if (!entry || Object.hasOwn(row, field) || submittedHash !== candidateHash) throw findingReferenceError(`${path}.findingRef`);
    const { findingRef: _ref, ...fields } = item;
    return { ...fields, [field]: entry.findingId };
  };
  const criteria = objectFields(frozen.candidate).acceptance ?? [];
  if (!Array.isArray(criteria)) throw new InputError("验收证据索引字段无效");
  const scopeEntries: ScopeEntry[] = criteria.flatMap((rawCriterion, position) => {
    const criterion = objectFields(rawCriterion);
    if (!stableId(criterion?.id) || typeof criterion.expected !== "string" || !criterion.expected.trim()) return [];
    let descriptor;
    try { descriptor = validateAcceptanceVerification(criterion); } catch { return []; }
    const adapter = objectFields(objectFields(objectFields(frozen.acceptanceAdapterGuide).adapters)[descriptor.adapterId]);
    if (adapter?.scope !== ACCEPTANCE_ADAPTERS[descriptor.adapterId].scope) return [];
    return [{ acceptanceId: criterion.id, adapterId: descriptor.adapterId, scope: adapter.scope,
      criterionPath: `/acceptance/${position}/expected`, adapterRulePaths: adapterRulePaths(frozen.acceptanceAdapterGuide, descriptor.adapterId) }];
  });
  if (scopeEntries.length) index.acceptanceScope = scopeEntries;
  const fullSource = (source: string) => {
    const manifest = objectFields(objectFields(frozen.contextManifest)[source]), serialized = JSON.stringify(frozen[source]);
    return manifest?.delivery === "full" && typeof serialized === "string"
      && manifest.characters === serialized.length && manifest.sha256 === hash(serialized);
  };
  const fullScopeSources = ["candidate", "acceptanceAdapterGuide"].every(fullSource);
  function read(request: EvidenceRequest, quoteBudget = Infinity): ReadPage {
    const { source, pointer, offset = 0, limit = 500, pathOffset = 0, acceptanceId } = request;
    if (acceptanceId !== undefined) {
      const matches = scopeEntries.filter((entry) => entry.acceptanceId === acceptanceId), entry = matches[0]!;
      if (matches.length !== 1 || !entry.adapterRulePaths.includes(pointer))
        throw new InputError("范围回执只能选择当前验收项及其实际适配器在索引中列出的规则路径");
      const page = read({ source, pointer, limit: 1000 }, quoteBudget);
      if (!page.receiptId) return page;
      const criterionQuote = sliceQuote(at(frozen.candidate, entry.criterionPath).value as string, 0, 1000, Infinity).quote;
      const adapterQuote = page.reference!.quote;
      const scopeReceiptId = `scope_${hash(JSON.stringify({ nonce, role, candidateHash, contextHash, acceptanceId,
        adapterId: entry.adapterId, scope: entry.scope, criterionPath: entry.criterionPath, pointer, criterionQuote, adapterQuote }))}`;
      if (!scopeReceipts.has(scopeReceiptId) && receipts.size + scopeReceipts.size >= 256)
        throw new InputError("本次评审引用回执额度已用完，请复用已有回执");
      scopeReceipts.set(scopeReceiptId, { role, candidateHash, contextHash, criterionPath: entry.criterionPath, pointer,
        row: { acceptanceId, adapterId: entry.adapterId, scope: entry.scope, criterionQuote, adapterQuote } });
      return { ...page, scopeReceiptId, acceptanceId, adapterId: entry.adapterId, scope: entry.scope, criterionPath: entry.criterionPath };
    }
    const selected = at(frozen[source], pointer);
    if (!selected.found) {
      const catalog = nearbyPaths(frozen[source], pointer, keys, pathCatalog.get(source)!);
      return { found: false, reason: "reference_path_missing", source, contextHash,
        availablePaths: catalog.paths.slice(pathOffset, pathOffset + 24), pathOffset,
        nextPathOffset: pathOffset + 24 < catalog.paths.length ? pathOffset + 24 : null, pathsTruncated: catalog.truncated };
    }
    const serialized = typeof selected.value === "string" ? selected.value : JSON.stringify(selected.value);
    if (typeof serialized !== "string" || offset >= serialized.length) return { found: true, contextHash, source, pointer,
      total: serialized?.length ?? 0, offset, nextOffset: null, offsetUnit: "UTF-16", reason: "empty_slice" };
    const { start, end, quote } = sliceQuote(serialized, offset, limit, quoteBudget);
    if (!quote) return { found: true, contextHash, source, pointer, total: serialized.length, offset: start,
      nextOffset: start, offsetUnit: "UTF-16", reason: "batch_quote_limit" };
    const reference = { source, path: pointer, quote };
    const receiptId = `ref_${hash(JSON.stringify({ nonce, role, candidateHash, contextHash, source, pointer, start, end }))}`;
    if (!receipts.has(receiptId) && receipts.size + scopeReceipts.size >= 256) throw new InputError("本次评审引用回执额度已用完，请复用已有回执");
    receipts.set(receiptId, { role, candidateHash, contextHash, reference, quoteHash: hash(quote) });
    return { found: true, receiptId, contextHash, candidateHash, reference, quoteHash: hash(quote),
      total: serialized.length, offset: start, nextOffset: end < serialized.length ? end : null, offsetUnit: "UTF-16" };
  }
  function resolveReceipt(reference: object, path: string) {
    if (Object.keys(reference).length !== 1 || typeof objectFields(reference).receiptId !== "string") throw receiptError(path);
    const receipt = receipts.get(objectFields(reference).receiptId as string);
    if (!receipt || receipt.role !== role || receipt.candidateHash !== candidateHash || receipt.contextHash !== contextHash
      || hash(receipt.reference.quote) !== receipt.quoteHash) throw receiptError(path);
    const current = at(frozen[receipt.reference.source], receipt.reference.path);
    const text = current.found ? typeof current.value === "string" ? current.value : JSON.stringify(current.value) : "";
    if (!text?.includes(receipt.reference.quote)) throw receiptError(path);
    return receipt.reference;
  }
  const tool: NeumaTool = { name: "read_architecture_evidence", label: "读取本轮评审依据", parameters, executionMode: "sequential",
    description: "只读当前已提供的评审材料。可用source/pointer单读，或requests一次批读1至16项。每项offset/limit按UTF-16代码单元，最多1000，避开代理对；批量quote总计最多24KiB UTF-8，nextOffset可续页。返回绑定本轮的receiptId，可在issues.references直接提交{receiptId}；candidate来源的非根有效路径回执也可用于candidatePaths。范围判断优先直接按reviewEvidenceIndex.acceptanceScope选择短行{acceptanceId,adapterRulePath,sufficient,reason}；完整提供的当前材料无需先读或复制回执。需要精读时可读取{source:acceptanceAdapterGuide,pointer:合法规则路径,acceptanceId}，不混分页参数；返回scopeReceiptId后也可提交短行{acceptanceId,scopeReceiptId,sufficient,reason}。两种短行均严格四字段，不能混用，宿主恢复当前精确原文及适配器后完整验证，不判断充分或通过。回执不允许跨验收、跨适配器或跨会话复用。路径不存在时优先返回对应分支邻近安全路径页。可读取不代表语义足以支持结论。",
    async execute(_id, input, signal) {
      signal?.throwIfAborted();
      const args = objectFields(input);
      const batch = args && Object.hasOwn(args, "requests");
      let single: EvidenceRequest | undefined, requests: EvidenceRequest[] = [];
      if (batch) {
        const supplied = args.requests;
        if (Object.keys(args).length !== 1 || !Array.isArray(supplied) || !supplied.length || supplied.length > 16 || !supplied.every(validRequest))
          throw new InputError("证据读取参数无效，请使用已声明的来源、路径及分页范围");
        requests = supplied;
      } else {
        if (!validRequest(args)) throw new InputError("证据读取参数无效，请使用已声明的来源、路径及分页范围");
        single = args;
      }
      let result;
      if (!batch) result = read(single!);
      else {
        let quoteBudget = MAX_BATCH_QUOTE_BYTES;
        const results = requests.map((request) => {
          signal?.throwIfAborted();
          const item = read(request, quoteBudget);
          quoteBudget -= Buffer.byteLength(item.reference?.quote ?? "", "utf8");
          return item;
        });
        result = { results, contextHash, candidateHash, quoteBytes: MAX_BATCH_QUOTE_BYTES - quoteBudget, quoteByteLimit: MAX_BATCH_QUOTE_BYTES };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    } };
  return { tool, contextHash, get index() { return structuredClone(index); },
    referenceHints(submission: unknown, validationIssues: unknown, { canonicalSubmission = submission }: { canonicalSubmission?: unknown } = {}) {
      const hints: ReferenceHint[] = [], seen = new Set<string>();
      let quoteBudget = MAX_BATCH_QUOTE_BYTES;
      if (!Array.isArray(validationIssues)) return hints;
      for (const issueInput of rows(validationIssues).slice(0, 64)) {
        const issue = objectFields(issueInput);
        if (issue?.reason === "repair_candidate_reference_unrelated") {
          const location = typeof issue.path === "string" ? issue.path.match(/^review\.issues\[(\d+)\]\.(references|candidatePaths)$/u) : undefined;
          const root = issue.candidatePath;
          if (!location || typeof root !== "string" || root.length > 500 || !at(frozen.candidate, root).found) continue;
          // Semantic diagnostics address the merged draft, whose order may differ from the submitted patch.
          const explanation = objectFields(issue.findingId
            ? rows(objectFields(canonicalSubmission).issues).find(row => objectFields(row).id === issue.findingId)
            : rows(objectFields(canonicalSubmission).issues)[Number(location[1])]);
          if (!stableId(explanation?.id)) continue;
          const key = JSON.stringify([explanation.id, root]);
          if (seen.has(key)) continue;
          seen.add(key);
          const preferred = ["expected", "verification/adapterId", "choice", "response", "completion", "purpose", "input"]
            .map(field => `${root}/${field}`).filter(pointer => at(frozen.candidate, pointer).found).slice(0, 2);
          const pointers = preferred.length ? preferred : [root];
          for (const pointer of pointers) {
            let page;
            try { page = read({ source: "candidate", pointer, offset: 0, limit: 1000 }, quoteBudget); }
            catch (error) { if (error instanceof InputError) continue; throw error; }
            if (!page.receiptId) continue;
            const { reference: current, receiptId, ...details } = page;
            quoteBudget -= Buffer.byteLength(current!.quote);
            hints.push({ issuePath: issue.path, issueId: explanation.id, candidatePath: root,
              target: "merged-review-draft", reference: { receiptId }, ...details,
              source: current!.source, path: current!.path, quote: current!.quote });
            if (hints.length === 12 || quoteBudget <= 0) return hints;
          }
          continue;
        }
        if (!["reference_quote_mismatch", "reference_too_broad"].includes(String(issue?.reason)) || typeof issue.path !== "string") continue;
        const indices = issue.path.match(/^review\.issues\[(\d+)\]\.references\[(\d+)\]$/u);
        if (!indices || seen.has(issue.path)) continue;
        const reference = objectFields(rows(objectFields(rows(objectFields(submission).issues)[Number(indices[1])]).references)[Number(indices[2])]);
        if (!reference || typeof reference !== "object" || Array.isArray(reference) || Object.hasOwn(reference, "receiptId")
          || !sourceName(reference.source) || typeof reference.path !== "string" || reference.path.length > 500
          || !at(frozen[reference.source], reference.path).found) continue;
        seen.add(issue.path);
        const value = at(frozen[reference.source], reference.path).value;
        const children = issue.reason === "reference_too_broad" && value && typeof value === "object"
          ? Object.entries(value).filter(([, child]) => typeof child === "string" && child.trim() && child.length <= 1000)
            .sort(([a], [b]) => Number(["reason", "description", "text", "proves"].includes(b)) - Number(["reason", "description", "text", "proves"].includes(a)))
            .slice(0, 4).map(([key]) => `${reference.path}/${encodePointer(key)}`) : [];
        for (const pointer of children.length ? children : [reference.path]) {
          let page;
          try { page = read({ source: reference.source, pointer, offset: 0, limit: children.length ? 1000 : 500 }, quoteBudget); }
          catch (error) { if (error instanceof InputError) continue; throw error; }
          if (!page.receiptId) continue;
          const { reference: current, receiptId, ...details } = page;
          quoteBudget -= Buffer.byteLength(current!.quote);
          hints.push({ issuePath: issue.path, reference: { receiptId }, ...details, source: current!.source, path: current!.path, quote: current!.quote });
          if (hints.length === 12 || quoteBudget <= 0) return hints;
        }
      }
      return hints;
    },
    submissionSchema(schema: ToolSchema) {
      const result = structuredClone(schema), references = result.properties?.issues?.items?.properties?.references;
      if (references) {
        references.items = { anyOf: [REFERENCE_SELECTOR_SCHEMA, RECEIPT_SCHEMA, references.items!] };
        references.description = "优先只交{source,path}，由宿主从本轮完整原文填入quote；长字段先细化路径或读取receiptId。含quote的写法仅兼容精确旧引用，不能改写原文。";
      }
      const paths = result.properties?.issues?.items?.properties?.candidatePaths;
      if (paths) paths.items = { anyOf: [paths.items!, RECEIPT_SCHEMA] };
      const scope = result.properties?.acceptanceScopeChecks;
      if (scope?.items?.properties) scope.items = { anyOf: [object({
        acceptanceId: scope.items.properties.acceptanceId!, adapterRulePath: { type: "string", minLength: 1, maxLength: 500 },
        sufficient: scope.items.properties.sufficient!, reason: scope.items.properties.reason!,
      }), object({
        acceptanceId: scope.items.properties.acceptanceId!, scopeReceiptId: SCOPE_RECEIPT_SCHEMA,
        sufficient: scope.items.properties.sufficient!, reason: scope.items.properties.reason!,
      }), scope.items] };
      if (findingEntries.length) {
        for (const [key, field] of [["issues", "id"], ["priorFindingDecisions", "findingId"]] as const) {
          const item = result.properties?.[key]?.items;
          if (!item?.properties) continue;
          item.properties.findingRef = { type: "string", enum: findingEntries.map(entry => entry.findingRef),
            description: "选择本轮历史问题短引用，宿主恢复完整编号；不得与完整编号混填。" };
          if (field === "findingId") item.properties[field]!.enum = findingEntries.map(entry => entry.findingId);
          item.required = item.required!.filter(key => key !== field);
          item.oneOf = [{ required: [field], not: { required: ["findingRef"] } },
            { required: ["findingRef"], not: { required: [field] } }];
        }
      }
      return result;
    },
    resolveSubmission<T>(value: T): ResolvedReviewSubmission<T> {
      const rawResult = structuredClone(value), result = objectFields(rawResult);
      const problems: unknown[] = []; let firstMessage: string | undefined;
      const collect = (original: unknown, resolve: () => unknown): unknown => {
        try { return resolve(); }
        catch (error) {
          if (!(error instanceof InputError) || !error.validationIssue) throw error;
          firstMessage ??= error.message; problems.push(error.validationIssue); return original;
        }
      };
      if (Array.isArray(result?.priorFindingDecisions)) result.priorFindingDecisions = result.priorFindingDecisions.map((row, position) =>
        collect(row, () => resolveFinding(row, "findingId", `review.priorFindingDecisions[${position}]`, result.candidateHash)));
      if (Array.isArray(result?.issues)) result.issues = result.issues.map((row, position) =>
        collect(row, () => resolveFinding(row, "id", `review.issues[${position}]`, result.candidateHash)));
      let selectorBytes = 0;
      const selectedQuotes = new Set<string>();
      if (Array.isArray(result?.acceptanceScopeChecks)) result.acceptanceScopeChecks = result.acceptanceScopeChecks.map((input, index) => collect(input, () => {
        if (!input || typeof input !== "object") return input;
        const row = objectFields(input);
        if (Object.hasOwn(row, "adapterRulePath") && !Object.hasOwn(row, "scopeReceiptId")) {
          const path = `review.acceptanceScopeChecks[${index}].adapterRulePath`;
          const entries = scopeEntries.filter((entry) => entry.acceptanceId === row.acceptanceId), entry = entries[0]!;
          if (Object.keys(row).length !== 4 || !["acceptanceId", "adapterRulePath", "sufficient", "reason"].every((key) => Object.hasOwn(row, key)))
            throw selectorError(path, "invalid_selector", entries.length === 1 ? entry : null);
          if (!fullScopeSources) throw selectorError(path, "context_not_full");
          if (result.candidateHash !== candidateHash) throw selectorError("review.candidateHash", "candidate_mismatch");
          if (entries.length !== 1) throw selectorError(path, "invalid_reference");
          if (typeof row.adapterRulePath !== "string" || !entry.adapterRulePaths.includes(row.adapterRulePath)) throw selectorError(path, "scope_rule_invalid", entry);
          return { acceptanceId: row.acceptanceId, adapterId: entry.adapterId, scope: entry.scope,
            criterionQuote: sliceQuote(at(frozen.candidate, entry.criterionPath).value as string, 0, 1000, Infinity).quote,
            adapterQuote: sliceQuote(at(frozen.acceptanceAdapterGuide, row.adapterRulePath).value as string, 0, 1000, Infinity).quote,
            sufficient: row.sufficient, reason: row.reason };
        }
        if (!Object.hasOwn(row, "scopeReceiptId")) return row;
        const path = `review.acceptanceScopeChecks[${index}].scopeReceiptId`, receipt = typeof row.scopeReceiptId === "string" ? scopeReceipts.get(row.scopeReceiptId) : undefined;
        if (Object.keys(row).length !== 4 || !["acceptanceId", "scopeReceiptId", "sufficient", "reason"].every((key) => Object.hasOwn(row, key))
          || !receipt || receipt.role !== role || receipt.candidateHash !== candidateHash || receipt.contextHash !== contextHash
          || row.acceptanceId !== receipt.row.acceptanceId) throw receiptError(path);
        const entries = scopeEntries.filter((entry) => entry.acceptanceId === row.acceptanceId), entry = entries[0]!;
        if (entries.length !== 1 || entry.adapterId !== receipt.row.adapterId || entry.scope !== receipt.row.scope
          || !entry.adapterRulePaths.includes(receipt.pointer)
          || !(at(frozen.candidate, receipt.criterionPath).value as string | undefined)?.includes(receipt.row.criterionQuote)
          || !(at(frozen.acceptanceAdapterGuide, receipt.pointer).value as string | undefined)?.includes(receipt.row.adapterQuote)) throw receiptError(path);
        return { ...structuredClone(receipt.row), sufficient: row.sufficient, reason: row.reason };
      }));
      for (const [index, rawIssue] of rows(result.issues).entries()) {
        const issue = objectFields(rawIssue);
        if (Array.isArray(issue?.candidatePaths)) issue.candidatePaths = rows(issue.candidatePaths).map((reference, position) => collect(reference, () => {
          if (!reference || typeof reference !== "object") return reference;
          const path = `review.issues[${index}].candidatePaths[${position}]`;
          const resolved = resolveReceipt(reference, path);
          if (resolved.source !== "candidate" || !resolved.path || !at(frozen.candidate, resolved.path).found) throw receiptError(path);
          return resolved.path;
        }));
        if (!Array.isArray(issue?.references)) continue;
        issue.references = rows(issue.references).map((input, position) => collect(input, () => {
          if (!input || typeof input !== "object") return input;
          const reference = objectFields(input);
          const path = `review.issues[${index}].references[${position}]`;
          if (Object.hasOwn(reference, "receiptId")) return structuredClone(resolveReceipt(reference, path));
          if (Object.hasOwn(reference, "quote")) return reference;
          if (Object.keys(reference).length !== 2 || !sourceName(reference.source) || typeof reference.path !== "string"
            || reference.path.length > 500) throw referenceSelectorError(path, "invalid_selector");
          if (result.candidateHash !== candidateHash) throw referenceSelectorError("review.candidateHash", "candidate_mismatch");
          if (!fullSource(reference.source)) throw referenceSelectorError(path, "context_not_full");
          const current = at(frozen[reference.source], reference.path);
          const quote = current.found ? typeof current.value === "string" ? current.value : JSON.stringify(current.value) : undefined;
          if (typeof quote !== "string" || !quote.trim()) throw referenceSelectorError(path, "reference_path_missing");
          if (quote.length > 1000) throw referenceSelectorError(path, "reference_too_broad", reference, quote.length);
          const key = JSON.stringify(reference);
          if (!selectedQuotes.has(key)) { selectorBytes += Buffer.byteLength(quote); selectedQuotes.add(key); }
          if (selectorBytes > MAX_BATCH_QUOTE_BYTES) throw referenceSelectorError(path, "batch_quote_limit");
          return { source: reference.source, path: reference.path, quote };
        }));
      }
      if (problems.length) {
        const issues = problems.slice(0, 64), total = problems.length, truncated = total > issues.length;
        throw Object.assign(new InputError(firstMessage + (total > 1 ? "；全部引用选择问题：" + JSON.stringify({ issues, total, truncated }) : "")), {
          validationIssue: issues[0], validationIssues: issues, validationIssueTotal: total, validationIssuesTruncated: truncated,
          referenceSelection: true,
        });
      }
      return rawResult as ResolvedReviewSubmission<T>;
    } };
}
