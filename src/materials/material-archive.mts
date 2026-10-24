interface ArchiveEntry { name: string; uncompressed: number; get(): Buffer }
import { inflateRawSync } from "node:zlib";
import { posix } from "node:path";
import { materialFailure } from "./material-formats.mjs";

export function materialArchive(bytes: Buffer) {
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) { end = index; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw materialFailure("material_parse_failed", "文档压缩结构无效");
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (count > 10_000 || start + size > end) throw materialFailure("material_parse_failed", "文档压缩结构超过限制");
  const entries = new Map<string, ArchiveEntry>(); let cursor = start, total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > start + size || bytes.readUInt32LE(cursor) !== 0x02014b50) throw materialFailure("material_parse_failed", "文档压缩目录已损坏");
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), compressed = bytes.readUInt32LE(cursor + 20), uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > start + size) throw materialFailure("material_parse_failed", "文档压缩目录已损坏");
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (flags & 1) throw materialFailure("material_encrypted", "不支持加密材料，请解密后重新上传");
    if (![0, 8].includes(method) || name.includes("\\") || name.startsWith("/") || name.split("/").includes("..") || entries.has(name)) throw materialFailure("material_parse_failed", "文档包含不支持的压缩项目");
    total += uncompressed;
    if (total > 100 * 1024 * 1024 || local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) throw materialFailure("material_parse_failed", "文档解压后过大或压缩结构无效，请拆分后上传");
    const offset = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (offset + compressed > start) throw materialFailure("material_parse_failed", "文档压缩内容已损坏");
    entries.set(name, { name, uncompressed, get() {
      const data = bytes.subarray(offset, offset + compressed);
      const output = method === 0 ? data : inflateRawSync(data, { maxOutputLength: uncompressed || 1 });
      if (output.length !== uncompressed) throw materialFailure("material_parse_failed", "文档压缩内容长度无效");
      return output;
    } });
    cursor = next;
  }
  return entries;
}

function xmlValue(value: string) {
  return value.replace(/&#x([\da-f]+);/gi, (_all, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, number) => String.fromCodePoint(Number(number)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function attributes(source: string) {
  return Object.fromEntries([...source.matchAll(/([\w:]+)\s*=\s*(["'])(.*?)\2/gs)].map((match) => [match[1], xmlValue(match[3]!)]));
}

export function presentationParts(archive: Map<string, ArchiveEntry>) {
  const presentation = archive.get("ppt/presentation.xml")?.get().toString("utf8"), relationships = archive.get("ppt/_rels/presentation.xml.rels")?.get().toString("utf8");
  if (!presentation || !relationships) throw materialFailure("material_parse_failed", "演示文稿缺少幻灯片目录");
  const targets = new Map([...relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)].map((match) => {
    const value = attributes(match[1]!);
    return [value.Id, value.TargetMode === "External" ? null : posix.normalize(posix.join("ppt", value.Target ?? ""))];
  }));
  const slides: { slide: number; page: number; part: string; text: string; imageParts: string[] }[] = [];
  for (const match of presentation.matchAll(/<p:sldId\b([^>]*)\/?\s*>/g)) {
    const path = targets.get(attributes(match[1]!)["r:id"]!);
    const entry = path ? archive.get(path) : undefined;
    if (!path || !entry) throw materialFailure("material_parse_failed", "演示文稿缺少目录中的幻灯片");
    const xml = entry.get().toString("utf8"), values = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((value) => xmlValue(value[1]!));
    const slide = slides.length + 1, imageParts = [], notes = [];
    const relPath = posix.join(posix.dirname(path), "_rels", `${posix.basename(path)}.rels`), relXml = archive.get(relPath)?.get().toString("utf8") ?? "";
    for (const relationship of relXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
      const value = attributes(relationship[1]!);
      if (value.TargetMode !== "External" && /\/image$/.test(value.Type ?? "")) imageParts.push(posix.normalize(posix.join(posix.dirname(path), value.Target ?? "")));
      if (value.TargetMode !== "External" && /\/notesSlide$/.test(value.Type ?? "")) {
        const notesPath = posix.normalize(posix.join(posix.dirname(path), value.Target ?? "")), notesXml = archive.get(notesPath)?.get().toString("utf8") ?? "";
        for (const shape of notesXml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)) {
          if (/<p:ph\b[^>]*type=["'](?:sldNum|sldImg)["']/.test(shape[0])) continue;
          notes.push(...[...shape[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((value) => xmlValue(value[1]!)));
        }
      }
    }
    slides.push({ slide, page: slide, part: path, text: values.join("\n") + (notes.length ? `\n\n备注：\n${notes.join("\n")}` : ""), imageParts });
  }
  return slides;
}
