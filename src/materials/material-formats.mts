export interface MaterialFormat { kind: string; mimeType: string; extension: string }
import { extname } from "node:path";
import { InputError } from "../requirements/core.mjs";
import { MAX_RUNTIME_FILE_BYTES } from "../runtime/file-limits.mjs";

export const MAX_MATERIAL_BYTES = MAX_RUNTIME_FILE_BYTES;
// Retain valid legacy descriptors so old materials do not corrupt the whole list.
export const MAX_LEGACY_MATERIAL_BYTES = 50 * 1024 * 1024;
export const MAX_MATERIAL_TEXT = 4_000_000;
export const MAX_PARSER_RESPONSE = 40 * 1024 * 1024;
export const MATERIAL_PARSER_VERSION = "materials-v1_kreuzberg-4.10.2_sharp-0.35.5";

const textExtensions = new Set("txt md markdown mdx py js mjs cjs jsx ts tsx java c cpp cxx cc h hpp cs go rs rb php swift kt kts scala sh bash zsh fish ps1 sql html htm css scss sass less vue svelte json jsonl ndjson yaml yml xml toml ini cfg conf log rst tex r ipynb dockerfile makefile".split(" "));
const formats: Record<string, [string, string]> = {
  doc: ["document", "application/msword"], docx: ["document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"], rtf: ["document", "application/rtf"],
  xls: ["spreadsheet", "application/vnd.ms-excel"], xlsx: ["spreadsheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], csv: ["spreadsheet", "text/csv"], tsv: ["spreadsheet", "text/tab-separated-values"],
  ppt: ["presentation", "application/vnd.ms-powerpoint"], pptx: ["presentation", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  pdf: ["pdf", "application/pdf"], png: ["image", "image/png"], jpg: ["image", "image/jpeg"], jpeg: ["image", "image/jpeg"], webp: ["image", "image/webp"], gif: ["image", "image/gif"], tif: ["image", "image/tiff"], tiff: ["image", "image/tiff"], bmp: ["image", "image/bmp"],
};
const forbiddenName = /^(?:\..*|node_modules|venv|__pycache__|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*(?:secret|credential|token|password|api[_-]?key|access[_-]?key|private[_-]?key).*|.*\.(?:pem|key|p12|pfx))$/i;

export function materialFailure(reason: string, message: string) {
  const error = new InputError(message);
  return Object.assign(error, { reason });
}

export function materialId(id: unknown) {
  if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))
    throw materialFailure("invalid_material", "材料标识无效");
  return id;
}

export function materialName(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 240 || /[\/\\\x00-\x1f\x7f]/.test(value))
    throw materialFailure("invalid_material_name", "请使用不含路径或控制字符的文件名");
  const name = value.normalize("NFKC").trim().replace(/[<>:"|?*]/g, "_");
  if (/[\/\\\x00-\x1f\x7f]/.test(name) || forbiddenName.test(name) || name === ".."
      || name.length > 180 || /[. ]$/.test(name)) throw materialFailure("invalid_material_name", "不支持隐藏文件、凭据文件或过长文件名");
  return name;
}

export function materialFormat(name: string) {
  const extension = extname(name).slice(1).toLowerCase();
  const lower = name.toLowerCase();
  if (textExtensions.has(extension) || ["dockerfile", "makefile"].includes(lower)) {
    const mimeType = extension === "json" ? "application/json" : ["yaml", "yml"].includes(extension) ? "application/yaml"
      : extension === "xml" ? "application/xml" : ["md", "markdown"].includes(extension) ? "text/markdown" : "text/plain";
    return { kind: "text", mimeType, extension };
  }
  if (!formats[extension]) throw materialFailure("unsupported_material", "暂不支持这个文件类型；可上传常见文档、表格、图片和文本代码文件");
  const [kind, mimeType] = formats[extension]!;
  return { kind, mimeType, extension };
}

export function validateMaterialSignature(format: MaterialFormat, prefix: Buffer) {
  const hex = prefix.subarray(0, 8).toString("hex"), ascii = prefix.subarray(0, 16).toString("ascii");
  const signature = format.extension === "pdf" ? ascii.startsWith("%PDF-")
    : ["docx", "xlsx", "pptx"].includes(format.extension) ? hex.startsWith("504b0304")
      : ["doc", "xls", "ppt"].includes(format.extension) ? hex === "d0cf11e0a1b11ae1"
        : format.extension === "rtf" ? ascii.startsWith("{\\rtf")
          : format.extension === "png" ? hex === "89504e470d0a1a0a"
            : ["jpg", "jpeg"].includes(format.extension) ? hex.startsWith("ffd8ff")
              : format.extension === "gif" ? /^GIF8[79]a/.test(ascii)
                : format.extension === "webp" ? ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP"
                  : ["tif", "tiff"].includes(format.extension) ? /^(?:49492a00|4d4d002a|49492b00|4d4d002b)/.test(hex)
                    : format.extension === "bmp" ? ascii.startsWith("BM") : true;
  if (!signature) throw materialFailure("material_type_mismatch", "文件内容与扩展名不一致，或文件已经损坏");
}

export function decodeMaterialText(bytes: Buffer) {
  let encoding = "utf-8", content = bytes;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = "utf-16le"; content = bytes.subarray(2); }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = "utf-16be"; content = bytes.subarray(2); }
  else if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) content = bytes.subarray(3);
  let text;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(content); }
  catch {
    if (encoding !== "utf-8") throw materialFailure("material_encoding", "文件的文字编码无效，请另存为 UTF-8 后上传");
    try { encoding = "gb18030"; text = new TextDecoder(encoding, { fatal: true }).decode(content); }
    catch { throw materialFailure("material_encoding", "无法识别文件的文字编码，请另存为 UTF-8 后上传"); }
  }
  if (text.includes("\0") || /[\x01-\x08\x0b\x0e-\x1f]/.test(text)) throw materialFailure("material_binary_text", "这个文件包含二进制内容，无法按文本读取");
  return { text, encoding };
}

export function redactMaterialText(text: string) {
  const keepLines = (value: string, replacement: string) => replacement + (value.match(/\r\n|\r|\n/g) ?? []).join("");
  return text.replace(/(\b(?:[\w-]*(?:api[_-]?key|token|secret|password|passwd|authorization)[\w-]*)["']?\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'[^']*'|[^\r\n,;]+)/gi,
    (match, prefix) => prefix + keepLines(match.slice(prefix.length), "[已隐藏]"))
    .replace(/Bearer\s+[\w.+\/-]+/gi, (match) => keepLines(match, "Bearer [已隐藏]"))
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, (match) => keepLines(match, "[已隐藏私钥]"));
}
