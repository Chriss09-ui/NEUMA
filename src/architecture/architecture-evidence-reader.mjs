import { createHash, randomUUID } from "node:crypto";
import { InputError } from "../requirements/core.mjs";
import { ACCEPTANCE_ADAPTERS, validateAcceptanceVerification } from "../verification/acceptance-contract.mjs";

const SOURCES = ["candidate", "requirements", "runtimeCapabilities", "contextManifest", "evidence", "confirmedRequirementContext", "deferredVerifications", "acceptanceAdapterGuide"];
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const hash = (value) => createHash("sha256").update(value).digest("hex");
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
const stableId = (value) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(value);
const encodePointer = (value) => value.replace(/~/g, "~0").replace(/\//g, "~1");
const SAFE_KEYS = new Set(["id", "text", "content", "value", "label", "source", "kind", "evidence", "messageId", "quote", "version", "items",
  "requirements", "resolvedIssues", "decisions", "issueId", "dimension", "critical", "applicability", "reason", "status", "adapters",
  "stage", "owner", "scope", "proves", "doesNotProve", "splitRule", "delivery", "characters", "sha256"]);

function at(value, pointer) {
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

function declaredKeys(schema, result = new Set(SAFE_KEYS)) {
  if (!schema || typeof schema !== "object") return result;
  for (const [key, child] of Object.entries(schema.properties ?? {})) { result.add(key); declaredKeys(child, result); }
  declaredKeys(schema.items, result);
  for (const child of [...schema.anyOf ?? [], ...schema.allOf ?? [], ...schema.oneOf ?? []]) declaredKeys(child, result);
  return result;
}

function safePaths(value, keys, limit = 512, root = "") {
  const paths = [], stack = [{ value, path: root, depth: 0 }];
  while (stack.length && paths.length < limit) {
    const current = stack.pop(); paths.push(current.path);
    if (!current.value || typeof current.value !== "object" || current.depth >= 12) continue;
    const entries = Object.entries(current.value).filter(([key]) => Array.isArray(current.value) ? /^\d{1,5}$/.test(key) : keys.has(key));
    for (const [key, child] of entries.reverse()) stack.push({ value: child,
      path: `${current.path}/${encodePointer(key)}`, depth: current.depth + 1 });
  }
  return { paths, truncated: stack.length > 0 };
}

function nearbyPaths(value, pointer, keys, fallback) {
  if (typeof pointer !== "string" || !pointer.startsWith("/") || /~(?![01])/u.test(pointer)) return fallback;
  const parts = pointer.slice(1).split("/");
  const branch = parts[0].replace(/~1/g, "/").replace(/~0/g, "~");
  if (!(Array.isArray(value) ? /^\d{1,5}$/u.test(branch) : keys.has(branch))) return fallback;
  let nearest, current = value;
  for (let length = 1; length < parts.length; length++) {
    const key = parts[length - 1].replace(/~1/g, "/").replace(/~0/g, "~");
    if (!(Array.isArray(current) ? /^\d{1,5}$/u.test(key) : keys.has(key))) break;
    const path = `/${parts.slice(0, length).join("/")}`, selected = at(value, path);
    if (!selected.found) break;
    nearest = { path, value: selected.value }; current = selected.value;
  }
  return nearest ? safePaths(nearest.value, keys, 512, nearest.path) : fallback;
}

function evidenceIndex(context, candidateSchema) {
  const candidate = {};
  for (const [key, schema] of Object.entries(candidateSchema?.properties ?? {})) {
    if (schema?.type !== "array" || !Array.isArray(context.candidate?.[key])) continue;
    candidate[key] = context.candidate[key].map((item, index) => {
      const id = stableId(item?.id) ? item.id : stableId(item?.requirementId) ? item.requirementId : undefined;
      return { ...(id ? { id } : {}), path: `/${encodePointer(key)}/${index}` };
    });
  }
  return { sources: SOURCES.filter((source) => Object.hasOwn(context, source)).map((source) => ({ source, path: "" })), candidate,
    requirements: Array.isArray(context.requirements) ? context.requirements.flatMap((item, index) => stableId(item?.id) ? [{ id: item.id, path: `/${index}` }] : []) : [] };
}

function validRequest(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => Object.hasOwn(REQUEST_FIELDS, key))
    && SOURCES.includes(value.source) && typeof value.pointer === "string" && value.pointer.length <= 500
    && (value.offset === undefined || Number.isSafeInteger(value.offset) && value.offset >= 0)
    && (value.limit === undefined || Number.isSafeInteger(value.limit) && value.limit >= 1 && value.limit <= 1000)
    && (value.pathOffset === undefined || Number.isSafeInteger(value.pathOffset) && value.pathOffset >= 0 && value.pathOffset <= 512)
    && (value.acceptanceId === undefined || stableId(value.acceptanceId) && value.source === "acceptanceAdapterGuide"
      && ["offset", "limit", "pathOffset"].every((key) => !Object.hasOwn(value, key)));
}

function adapterRulePaths(guide, adapterId) {
  const paths = [
    ...["proves", "doesNotProve", "splitRule", "executionRule"].map((key) => `/adapters/${adapterId}/${key}`),
    ...["caseSetRule", "requirementCoverageRule", "splitRule", ...(adapterId === "host-business" ? ["hostBusinessRule"] : [])]
      .map((key) => `/composition/${key}`),
    ...["rule", "measure", "outcomeRule"].map((key) => `/admission/${adapterId}/${key}`),
    ...(Array.isArray(guide?.admission?.[adapterId]?.excludedProof)
      ? guide.admission[adapterId].excludedProof.map((_item, index) => `/admission/${adapterId}/excludedProof/${index}`) : []),
  ];
  return paths.filter((path) => { const selected = at(guide, path); return typeof selected.value === "string" && selected.value.trim(); });
}

function sliceQuote(text, offset, limit, byteLimit) {
  let start = offset, end;
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]) && /[\uD800-\uDBFF]/u.test(text[start - 1])) start--;
  end = Math.min(text.length, start + limit);
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end]) && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
  if (end <= start) end = Math.min(text.length, start + 2);
  let quote = text.slice(start, end);
  while (Buffer.byteLength(quote, "utf8") > byteLimit && end > start) {
    end--;
    if (end > start && /[\uDC00-\uDFFF]/u.test(text[end]) && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
    quote = text.slice(start, end);
  }
  return { start, end, quote };
}

function receiptError(path, reason = "invalid_receipt") {
  return Object.assign(new InputError(`${path} 引用回执未知、过期或格式混合；请在本次评审重新读取证据，不要重写回执。`),
    { validationIssue: { path, reason } });
}

function selectorError(path, reason, entry) {
  const diagnostic = { path, reason, allowedAdapterRulePaths: entry?.adapterRulePaths ?? [] };
  return Object.assign(new InputError("范围规则选择无效；仅能选择本轮完整材料中本条实际适配器的合法规则：" + JSON.stringify(diagnostic)),
    { validationIssue: { path, reason } });
}

function referenceSelectorError(path, reason) {
  return Object.assign(new InputError("评审原文选择无效；只引用本轮完整材料中存在且不超过1000字符的具体字段，长内容请细化路径或读取局部原文。"),
    { validationIssue: { path, reason } });
}

export function createArchitectureEvidenceReader({ context, candidateHash, candidateSchema, role = "reviewer" }) {
  const frozen = structuredClone(context), contextHash = hash(JSON.stringify(frozen)), nonce = randomUUID(), receipts = new Map();
  const scopeReceipts = new Map();
  const keys = declaredKeys(candidateSchema);
  for (const source of SOURCES) keys.add(source);
  for (const key of Object.keys(frozen.acceptanceAdapterGuide?.adapters ?? {})) keys.add(key);
  const pathCatalog = new Map(SOURCES.map((source) => [source, safePaths(frozen[source], keys)]));
  const parameters = { type: "object", additionalProperties: false,
    properties: { ...REQUEST_FIELDS, requests: { type: "array", minItems: 1, maxItems: 16, items: REQUEST_SCHEMA } },
    oneOf: [{ required: ["source", "pointer"], not: { required: ["requests"] } },
      { required: ["requests"], not: { anyOf: Object.keys(REQUEST_FIELDS).map((key) => ({ required: [key] })) } }] };
  const index = evidenceIndex(frozen, candidateSchema);
  const scopeEntries = (frozen.candidate?.acceptance ?? []).flatMap((criterion, position) => {
    if (!stableId(criterion?.id) || typeof criterion.expected !== "string" || !criterion.expected.trim()) return [];
    let descriptor;
    try { descriptor = validateAcceptanceVerification(criterion); } catch { return []; }
    const adapter = frozen.acceptanceAdapterGuide?.adapters?.[descriptor.adapterId];
    if (adapter?.scope !== ACCEPTANCE_ADAPTERS[descriptor.adapterId].scope) return [];
    return [{ acceptanceId: criterion.id, adapterId: descriptor.adapterId, scope: adapter.scope,
      criterionPath: `/acceptance/${position}/expected`, adapterRulePaths: adapterRulePaths(frozen.acceptanceAdapterGuide, descriptor.adapterId) }];
  });
  if (scopeEntries.length) index.acceptanceScope = scopeEntries;
  const fullSource = (source) => {
    const manifest = frozen.contextManifest?.[source], serialized = JSON.stringify(frozen[source]);
    return manifest?.delivery === "full" && typeof serialized === "string"
      && manifest.characters === serialized.length && manifest.sha256 === hash(serialized);
  };
  const fullScopeSources = ["candidate", "acceptanceAdapterGuide"].every(fullSource);
  function read(request, quoteBudget = Infinity) {
    const { source, pointer, offset = 0, limit = 500, pathOffset = 0, acceptanceId } = request;
    if (acceptanceId !== undefined) {
      const matches = scopeEntries.filter((entry) => entry.acceptanceId === acceptanceId), entry = matches[0];
      if (matches.length !== 1 || !entry.adapterRulePaths.includes(pointer))
        throw new InputError("范围回执只能选择当前验收项及其实际适配器在索引中列出的规则路径");
      const page = read({ source, pointer, limit: 1000 }, quoteBudget);
      if (!page.receiptId) return page;
      const criterionQuote = sliceQuote(at(frozen.candidate, entry.criterionPath).value, 0, 1000, Infinity).quote;
      const adapterQuote = page.reference.quote;
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
      const catalog = nearbyPaths(frozen[source], pointer, keys, pathCatalog.get(source));
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
  function resolveReceipt(reference, path) {
    if (Object.keys(reference).length !== 1 || typeof reference.receiptId !== "string") throw receiptError(path);
    const receipt = receipts.get(reference.receiptId);
    if (!receipt || receipt.role !== role || receipt.candidateHash !== candidateHash || receipt.contextHash !== contextHash
      || hash(receipt.reference.quote) !== receipt.quoteHash) throw receiptError(path);
    const current = at(frozen[receipt.reference.source], receipt.reference.path);
    const text = current.found ? typeof current.value === "string" ? current.value : JSON.stringify(current.value) : "";
    if (!text?.includes(receipt.reference.quote)) throw receiptError(path);
    return receipt.reference;
  }
  const tool = { name: "read_architecture_evidence", label: "读取本轮评审依据", parameters, executionMode: "sequential",
    description: "只读当前已提供的评审材料。可用source/pointer单读，或requests一次批读1至16项。每项offset/limit按UTF-16代码单元，最多1000，避开代理对；批量quote总计最多24KiB UTF-8，nextOffset可续页。返回绑定本轮的receiptId，可在issues.references直接提交{receiptId}；candidate来源的非根有效路径回执也可用于candidatePaths。范围判断优先直接按reviewEvidenceIndex.acceptanceScope选择短行{acceptanceId,adapterRulePath,sufficient,reason}；完整提供的当前材料无需先读或复制回执。需要精读时可读取{source:acceptanceAdapterGuide,pointer:合法规则路径,acceptanceId}，不混分页参数；返回scopeReceiptId后也可提交短行{acceptanceId,scopeReceiptId,sufficient,reason}。两种短行均严格四字段，不能混用，宿主恢复当前精确原文及适配器后完整验证，不判断充分或通过。回执不允许跨验收、跨适配器或跨会话复用。路径不存在时优先返回对应分支邻近安全路径页。可读取不代表语义足以支持结论。",
    async execute(_id, args, signal) {
      signal?.throwIfAborted();
      const batch = args && Object.hasOwn(args, "requests");
      if (batch ? Object.keys(args).length !== 1 || !Array.isArray(args.requests) || !args.requests.length
        || args.requests.length > 16 || !args.requests.every(validRequest) : !validRequest(args))
        throw new InputError("证据读取参数无效，请使用已声明的来源、路径及分页范围");
      let result;
      if (!batch) result = read(args);
      else {
        let quoteBudget = MAX_BATCH_QUOTE_BYTES;
        const results = args.requests.map((request) => {
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
    referenceHints(submission, validationIssues) {
      const hints = [], seen = new Set();
      if (!Array.isArray(validationIssues)) return hints;
      for (const issue of validationIssues.slice(0, 64)) {
        if (issue?.reason !== "reference_quote_mismatch" || typeof issue.path !== "string") continue;
        const indices = issue.path.match(/^review\.issues\[(\d+)\]\.references\[(\d+)\]$/u);
        if (!indices || seen.has(issue.path)) continue;
        const reference = submission?.issues?.[Number(indices[1])]?.references?.[Number(indices[2])];
        if (!reference || typeof reference !== "object" || Array.isArray(reference) || Object.hasOwn(reference, "receiptId")
          || !SOURCES.includes(reference.source) || typeof reference.path !== "string" || reference.path.length > 500
          || !at(frozen[reference.source], reference.path).found) continue;
        let page;
        try { page = read({ source: reference.source, pointer: reference.path, offset: 0, limit: 500 }); }
        catch (error) { if (error instanceof InputError) continue; throw error; }
        if (!page.receiptId) continue;
        seen.add(issue.path);
        const { reference: current, receiptId, ...details } = page;
        hints.push({ issuePath: issue.path, reference: { receiptId }, ...details, source: current.source, path: current.path, quote: current.quote });
        if (hints.length === 12) break;
      }
      return hints;
    },
    submissionSchema(schema) {
      const result = structuredClone(schema), references = result.properties?.issues?.items?.properties?.references;
      if (references) references.items = { anyOf: [references.items, RECEIPT_SCHEMA, REFERENCE_SELECTOR_SCHEMA] };
      const paths = result.properties?.issues?.items?.properties?.candidatePaths;
      if (paths) paths.items = { anyOf: [paths.items, RECEIPT_SCHEMA] };
      const scope = result.properties?.acceptanceScopeChecks;
      if (scope?.items?.properties) scope.items = { anyOf: [object({
        acceptanceId: scope.items.properties.acceptanceId, adapterRulePath: { type: "string", minLength: 1, maxLength: 500 },
        sufficient: scope.items.properties.sufficient, reason: scope.items.properties.reason,
      }), object({
        acceptanceId: scope.items.properties.acceptanceId, scopeReceiptId: SCOPE_RECEIPT_SCHEMA,
        sufficient: scope.items.properties.sufficient, reason: scope.items.properties.reason,
      }), scope.items] };
      return result;
    },
    resolveSubmission(value) {
      const result = structuredClone(value);
      let selectorBytes = 0;
      const selectedQuotes = new Set();
      if (Array.isArray(result?.acceptanceScopeChecks)) result.acceptanceScopeChecks = result.acceptanceScopeChecks.map((row, index) => {
        if (!row || typeof row !== "object") return row;
        if (Object.hasOwn(row, "adapterRulePath") && !Object.hasOwn(row, "scopeReceiptId")) {
          const path = `review.acceptanceScopeChecks[${index}].adapterRulePath`;
          const entries = scopeEntries.filter((entry) => entry.acceptanceId === row.acceptanceId), entry = entries[0];
          if (Object.keys(row).length !== 4 || !["acceptanceId", "adapterRulePath", "sufficient", "reason"].every((key) => Object.hasOwn(row, key)))
            throw selectorError(path, "invalid_selector", entries.length === 1 ? entry : null);
          if (!fullScopeSources) throw selectorError(path, "context_not_full");
          if (result.candidateHash !== candidateHash) throw selectorError("review.candidateHash", "candidate_mismatch");
          if (entries.length !== 1) throw selectorError(path, "invalid_reference");
          if (!entry.adapterRulePaths.includes(row.adapterRulePath)) throw selectorError(path, "scope_rule_invalid", entry);
          return { acceptanceId: row.acceptanceId, adapterId: entry.adapterId, scope: entry.scope,
            criterionQuote: sliceQuote(at(frozen.candidate, entry.criterionPath).value, 0, 1000, Infinity).quote,
            adapterQuote: sliceQuote(at(frozen.acceptanceAdapterGuide, row.adapterRulePath).value, 0, 1000, Infinity).quote,
            sufficient: row.sufficient, reason: row.reason };
        }
        if (!Object.hasOwn(row, "scopeReceiptId")) return row;
        const path = `review.acceptanceScopeChecks[${index}].scopeReceiptId`, receipt = scopeReceipts.get(row.scopeReceiptId);
        if (Object.keys(row).length !== 4 || !["acceptanceId", "scopeReceiptId", "sufficient", "reason"].every((key) => Object.hasOwn(row, key))
          || !receipt || receipt.role !== role || receipt.candidateHash !== candidateHash || receipt.contextHash !== contextHash
          || row.acceptanceId !== receipt.row.acceptanceId) throw receiptError(path);
        const entries = scopeEntries.filter((entry) => entry.acceptanceId === row.acceptanceId), entry = entries[0];
        if (entries.length !== 1 || entry.adapterId !== receipt.row.adapterId || entry.scope !== receipt.row.scope
          || !entry.adapterRulePaths.includes(receipt.pointer)
          || !at(frozen.candidate, receipt.criterionPath).value?.includes(receipt.row.criterionQuote)
          || !at(frozen.acceptanceAdapterGuide, receipt.pointer).value?.includes(receipt.row.adapterQuote)) throw receiptError(path);
        return { ...structuredClone(receipt.row), sufficient: row.sufficient, reason: row.reason };
      });
      if (!Array.isArray(result?.issues)) return result;
      for (const [index, issue] of result.issues.entries()) {
        if (Array.isArray(issue?.candidatePaths)) issue.candidatePaths = issue.candidatePaths.map((reference, position) => {
          if (!reference || typeof reference !== "object") return reference;
          const path = `review.issues[${index}].candidatePaths[${position}]`;
          const resolved = resolveReceipt(reference, path);
          if (resolved.source !== "candidate" || !resolved.path || !at(frozen.candidate, resolved.path).found) throw receiptError(path);
          return resolved.path;
        });
        if (!Array.isArray(issue?.references)) continue;
        issue.references = issue.references.map((reference, position) => {
          if (!reference || typeof reference !== "object") return reference;
          const path = `review.issues[${index}].references[${position}]`;
          if (Object.hasOwn(reference, "receiptId")) return structuredClone(resolveReceipt(reference, path));
          if (Object.hasOwn(reference, "quote")) return reference;
          if (Object.keys(reference).length !== 2 || !SOURCES.includes(reference.source) || typeof reference.path !== "string"
            || reference.path.length > 500) throw referenceSelectorError(path, "invalid_selector");
          if (result.candidateHash !== candidateHash) throw referenceSelectorError("review.candidateHash", "candidate_mismatch");
          if (!fullSource(reference.source)) throw referenceSelectorError(path, "context_not_full");
          const current = at(frozen[reference.source], reference.path);
          const quote = current.found ? typeof current.value === "string" ? current.value : JSON.stringify(current.value) : undefined;
          if (typeof quote !== "string" || !quote.trim()) throw referenceSelectorError(path, "reference_path_missing");
          if (quote.length > 1000) throw referenceSelectorError(path, "reference_too_broad");
          const key = JSON.stringify(reference);
          if (!selectedQuotes.has(key)) { selectorBytes += Buffer.byteLength(quote); selectedQuotes.add(key); }
          if (selectorBytes > MAX_BATCH_QUOTE_BYTES) throw referenceSelectorError(path, "batch_quote_limit");
          return { source: reference.source, path: reference.path, quote };
        });
      }
      return result;
    } };
}
