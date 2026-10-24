import type { ExtractionResult } from "@kreuzberg/node";
import type { MaterialRequest } from "./material-port.mjs";
import type { MaterialLocation, MaterialImage, ParsedMaterial } from "../contracts/material.mjs";
import { objectFields } from "../runtime/type-boundary.mjs";
interface DocumentPart { text: string; sheet?: string; page?: number; slide?: number; part?: string; imageParts?: string[] }
interface ImageCandidate { data: Uint8Array | string; part?: string; pageNumber?: number | null; page_number?: number | null; slides?: number[] }
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { MAX_MATERIAL_BYTES, MAX_MATERIAL_TEXT, decodeMaterialText, materialFailure, materialFormat, redactMaterialText } from "./material-formats.mjs";
import { materialArchive, presentationParts } from "./material-archive.mjs";

async function inputBytes(request: MaterialRequest) {
  const handle = await open(request.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw materialFailure("invalid_material", "材料文件无效");
    if (info.size > MAX_MATERIAL_BYTES) throw materialFailure("material_too_large", "材料超过 20 MiB");
    const bytes = await handle.readFile();
    if (bytes.length > MAX_MATERIAL_BYTES || createHash("sha256").update(bytes).digest("hex") !== request.sha256)
      throw materialFailure("material_changed", "原始材料已被修改，请重新上传");
    return bytes;
  } finally { await handle.close(); }
}

function bitmap(bytes: Buffer) {
  if (bytes.length < 54 || bytes.toString("ascii", 0, 2) !== "BM") throw materialFailure("material_image_failed", "图片已损坏");
  const offset = bytes.readUInt32LE(10), header = bytes.readUInt32LE(14), width = bytes.readInt32LE(18), signedHeight = bytes.readInt32LE(22);
  const bits = bytes.readUInt16LE(28), compression = bytes.readUInt32LE(30), height = Math.abs(signedHeight);
  if (header < 40 || width <= 0 || !height || width * height > 40_000_000 || ![24, 32].includes(bits) || compression !== 0)
    throw materialFailure("material_image_unsupported", "暂不支持这种 BMP 编码，请另存为 PNG 或 JPEG");
  const stride = Math.ceil(width * bits / 32) * 4;
  if (offset < 54 || offset + stride * height > bytes.length) throw materialFailure("material_image_failed", "图片已损坏");
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = offset + (signedHeight < 0 ? y : height - y - 1) * stride;
    for (let x = 0; x < width; x++) {
      const source = row + x * bits / 8, target = (y * width + x) * 3;
      pixels[target] = bytes[source + 2]!; pixels[target + 1] = bytes[source + 1]!; pixels[target + 2] = bytes[source]!;
    }
  }
  return { pixels, width, height, channels: 3 as const };
}

async function imageMetadata(bytes: Buffer, extension: string) {
  const { default: sharp } = await import("sharp");
  if (extension === "bmp") { const value = bitmap(bytes); return { width: value.width, height: value.height, pageCount: 1, warnings: [] }; }
  const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
  return { width: metadata.width, height: metadata.pageHeight ?? metadata.height,
    pageCount: ["tif", "tiff"].includes(extension) ? metadata.pages ?? 1 : 1,
    warnings: extension === "gif" && (metadata.pages ?? 0) > 1 ? ["GIF 只读取第一帧。"] : [] };
}

async function normalizeImage(bytes: Buffer, { extension = "png", page = 1 } = {}) {
  const { default: sharp } = await import("sharp");
  let input;
  if (extension === "bmp") { const value = bitmap(bytes); input = sharp(value.pixels, { raw: { width: value.width, height: value.height, channels: value.channels } }); }
  else input = sharp(bytes, { limitInputPixels: 40_000_000, page: ["tif", "tiff"].includes(extension) ? page - 1 : 0, pages: 1 });
  const { data, info } = await input.rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  if (data.length > 8 * 1024 * 1024) throw materialFailure("material_image_limit", "图片处理结果过大，请缩小图片后重试");
  return { data: data.toString("base64"), mimeType: "image/png", width: info.width, height: info.height, page };
}

function documentParts(result: ExtractionResult, kind: string, archive: ReturnType<typeof materialArchive> | null): DocumentPart[] {
  if (kind === "presentation" && archive) return presentationParts(archive);
  const pages = result.pages;
  if (Array.isArray(pages) && pages.length) return pages.map((page, index) => ({
    text: page.content || String(objectFields(page).text ?? "") || (page.tables ?? []).map((table) => table.markdown ?? "").join("\n\n"),
    ...(kind === "spreadsheet" ? { sheet: result.metadata?.sheetNames?.[(page.pageNumber ?? index + 1) - 1] ?? `工作表 ${index + 1}` }
      : { page: page.pageNumber ?? (typeof objectFields(page).page_number === "number" ? Number(objectFields(page).page_number) : undefined) ?? index + 1 }),
    ...(kind === "presentation" ? { slide: page.pageNumber ?? (typeof objectFields(page).page_number === "number" ? Number(objectFields(page).page_number) : undefined) ?? index + 1 } : {}),
  }));
  return [{ text: result.content ?? "" }];
}

async function parse(request: MaterialRequest, bytes: Buffer): Promise<ParsedMaterial> {
  const format = materialFormat(request.name), warnings = [];
  if (format.kind === "text") {
    const decoded = decodeMaterialText(bytes), text = redactMaterialText(decoded.text.slice(0, MAX_MATERIAL_TEXT));
    if (decoded.text.length > MAX_MATERIAL_TEXT) warnings.push("材料文字过长，当前解析保留前 400 万字；请拆分材料以阅读剩余内容。");
    return { text, locations: [{ start: 0, end: text.length, lineStart: 1 }], images: [], encoding: decoded.encoding, warnings, status: "ready", pageCount: null, truncated: decoded.text.length > MAX_MATERIAL_TEXT };
  }
  if (format.kind === "image") return { text: "", locations: [], images: [], status: "needs_vision", ...await imageMetadata(bytes, format.extension) };
  const archive = ["docx", "xlsx", "pptx"].includes(format.extension) ? materialArchive(bytes) : null;
  const { extractBytes } = await import("@kreuzberg/node");
  // The pinned 4.10.2 wrapper drops ocr.enabled. Omitting OCR is the supported native-only path.
  const result = await extractBytes(bytes, request.mimeType, { forceOcr: false, useCache: false,
    enableQualityProcessing: false, outputFormat: "markdown", includeDocumentStructure: true,
    pages: { extractPages: true, insertPageMarkers: false }, images: { extractImages: true } });
  const parts = documentParts(result, format.kind, archive), locations: MaterialLocation[] = [], visionPages: number[] = [];
  let text = "";
  for (const part of parts) {
    const content = redactMaterialText(String(part.text));
    const label = part.sheet ? `工作表 ${part.sheet}` : part.slide ? `幻灯片 ${part.slide}` : part.page ? `第 ${part.page} 页` : request.name;
    const start = text.length;
    if (text) text += "\n\n";
    text += `【${label}】\n${content || "本页没有可读取的文字，请使用图片读取工具查看。"}`;
    locations.push({ start, end: text.length, ...(part.page ? { page: part.page } : {}), ...(part.slide ? { slide: part.slide } : {}), ...(part.sheet ? { sheet: part.sheet } : {}), ...(part.part ? { part: part.part } : {}) });
    if (format.kind === "pdf" && part.page && content.replace(/\s/g, "").length < 32) visionPages.push(part.page);
    if (text.length >= MAX_MATERIAL_TEXT) break;
  }
  const originalLength = text.length;
  text = text.slice(0, MAX_MATERIAL_TEXT);
  if (originalLength > MAX_MATERIAL_TEXT || locations.length < parts.length) warnings.push("材料文字过长，当前解析只保留前 400 万字；请拆分材料以阅读剩余内容。");
  const images: MaterialImage[] = [];
  let imageBytes = 0;
  const candidates: ImageCandidate[] = [];
  if (archive) for (const [name, entry] of archive) {
    if (/^(?:word|xl|ppt)\/media\/[^/]+\.(?:png|jpe?g|webp|gif|tiff?|bmp)$/i.test(name)) {
      const slides = parts.filter((part) => part.imageParts?.includes(name)).map((part) => part.slide).filter((slide): slide is number => slide !== undefined);
      candidates.push({ data: entry.get(), part: name, pageNumber: slides[0] ?? null, slides });
    }
  }
  candidates.push(...(result.images ?? []));
  const seenImages = new Set();
  for (const image of candidates) {
    if (images.length >= 24) { warnings.push("文档内图片较多，当前只处理前 24 张图片。"); break; }
    try {
      const data = typeof image.data === "string" ? Buffer.from(image.data, "base64") : Buffer.from(image.data ?? []);
      if (!data.length || data.length > MAX_MATERIAL_BYTES) continue;
      const digest = createHash("sha256").update(data).digest("hex");
      if (seenImages.has(digest)) continue;
      seenImages.add(digest);
      const normalized = await normalizeImage(data, { extension: extname(image.part ?? "").slice(1).toLowerCase() || "png" });
      if (imageBytes + normalized.data.length > 8 * 1024 * 1024) { warnings.push("文档内图片较多，部分图片未生成预览。"); break; }
      imageBytes += normalized.data.length;
      images.push({ ...normalized, id: `image-${images.length + 1}`, page: image.pageNumber ?? image.page_number ?? null, source: "embedded",
        ...(image.part ? { part: image.part } : {}), ...(image.slides?.length ? { slides: image.slides } : {}) });
    } catch { warnings.push("文档内有一张图片无法读取。图片外的文字仍可使用。"); }
  }
  const pageCount = parts.some((part) => part.page) ? Math.max(...parts.map((part) => part.page ?? 0))
    : result.metadata?.pageCount ?? (typeof objectFields(result.metadata?.pages).totalCount === "number" ? Number(objectFields(result.metadata?.pages).totalCount) : null) ?? null;
  const metadata = result.metadata ?? {};
  const alternateNames = objectFields(metadata.format).sheetNames ?? objectFields(objectFields(metadata.format).excel).sheetNames;
  const sheetNames = metadata.sheetNames ?? (Array.isArray(alternateNames) && alternateNames.every((value: unknown) => typeof value === "string") ? alternateNames : []);
  return { text, locations, images, warnings, pageCount, sheetNames, visionPages,
    status: visionPages.length || !String(result.content ?? "").trim() && format.kind === "pdf" ? "needs_vision" : "ready",
    truncated: originalLength > MAX_MATERIAL_TEXT || locations.length < parts.length };
}

async function render(request: MaterialRequest, bytes: Buffer) {
  const format = materialFormat(request.name), page = request.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1) throw materialFailure("invalid_material_page", "材料页码无效");
  if (format.kind === "image") {
    const metadata = await imageMetadata(bytes, format.extension);
    if (page > metadata.pageCount) throw materialFailure("invalid_material_page", "材料页码超出范围");
    return { ...await normalizeImage(bytes, { extension: format.extension, page }), pageCount: metadata.pageCount, warnings: metadata.warnings };
  }
  if (format.kind !== "pdf") throw materialFailure("material_no_image", "请从材料的图片列表中选择要读取的图片");
  const { pdfPageCount, renderPdfPageSync } = await import("@kreuzberg/node");
  const copy = join(request.scratch, "input.pdf");
  await writeFile(copy, bytes, { flag: "wx", mode: 0o400 });
  const pageCount = pdfPageCount(copy);
  if (page > pageCount) throw materialFailure("invalid_material_page", "材料页码超出范围");
  const png = renderPdfPageSync(copy, page - 1, { dpi: 150 });
  return { ...await normalizeImage(png), page, pageCount, warnings: [] };
}

let request;
try {
  const chunks = []; let length = 0;
  for await (const chunk of process.stdin) { length += chunk.length; if (length > 16_384) throw materialFailure("invalid_material", "材料解析请求无效"); chunks.push(chunk); }
  const input = objectFields(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if ((input.action !== "parse" && input.action !== "image") || typeof input.path !== "string" || typeof input.name !== "string" || typeof input.mimeType !== "string" || typeof input.sha256 !== "string" || typeof input.scratch !== "string" || input.page !== undefined && typeof input.page !== "number") throw materialFailure("invalid_material", "材料解析请求无效");
  request = input as typeof input & MaterialRequest;
  if (!["parse", "image"].includes(request.action) || typeof request.path !== "string" || !/^[a-f0-9]{64}$/.test(request.sha256))
    throw materialFailure("invalid_material", "材料解析请求无效");
  const bytes = await inputBytes(request);
  const result = request.action === "parse" ? await parse(request, bytes) : await render(request, bytes);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (failure) {
  const error = objectFields(failure);
  const known = error?.reason && typeof error.message === "string";
  const encrypted = /password|encrypt|加密/i.test(String(error?.message ?? ""));
  process.stdout.write(JSON.stringify({ ok: false, reason: known ? error.reason : encrypted ? "material_encrypted" : "material_parse_failed",
    message: known ? error.message : encrypted ? "不支持加密或需要密码的材料，请解密后重新上传" : "材料无法解析，请检查文件是否损坏或采用了不支持的编码" }));
}
