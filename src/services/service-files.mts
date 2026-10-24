import { errorField } from "../runtime/type-boundary.mjs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ServiceError } from "./service-contract.mjs";

export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new ServiceError("unsafe_service_directory");
  return realpath(path);
}
export async function atomicJSON(path: string, value: unknown) {
  await privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export async function readJSON(path: string, fallback: unknown = null): Promise<unknown> {
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) throw new ServiceError("unsafe_service_record"); return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (errorField(error, "code") === "ENOENT") return fallback; throw error; }
}
export function inside(root: string, path: string) { const part = relative(resolve(root), resolve(path)); return part === "" || !part.startsWith("..") && !isAbsolute(part); }
export async function directoryBytes(root: string, { allowInternalLinks = false, maxBytes = 1024 * 1024 * 1024, hash = false } = {}) {
  root = await realpath(root); let bytes = 0, count = 0; const digest = createHash("sha256");
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (++count > 100000) throw new ServiceError("service_file_limit");
      const path = join(directory, entry.name), name = `${prefix}${entry.name}`, info = await lstat(path);
      if (info.isSymbolicLink()) {
        if (!allowInternalLinks || !inside(root, await realpath(path))) throw new ServiceError("service_symlink_denied");
        if (hash) digest.update(`${name}:link:${relative(root, await realpath(path))}\n`); continue;
      }
      if (info.isDirectory()) { await walk(path, `${name}/`); continue; }
      if (!info.isFile() || info.nlink !== 1) throw new ServiceError("unsafe_service_file");
      bytes += info.size; if (bytes > maxBytes) throw new ServiceError("service_disk_limit");
      if (hash) digest.update(name).update("\0").update(await readFile(path)).update("\0");
    }
  };
  await walk(root, ""); return { bytes, files: count, ...(hash ? { hash: digest.digest("hex") } : {}) };
}
