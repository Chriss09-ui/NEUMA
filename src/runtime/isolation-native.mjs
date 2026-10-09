import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const inside = (root, path) => { const part = relative(root, path); return part === "" || (!part.startsWith("..") && !isAbsolute(part)); };
const REASONS = new Set(["isolation_setup_failed", "timeout", "output_limit", "process_terminated", "cleanup_failed"]);

export const NODE_INPUT_BOOTSTRAP = `import {pathToFileURL} from 'node:url';
const target=process.argv[1];
const chunks=[];let size=0;
for await(const chunk of process.stdin){size+=chunk.length;if(size>131072)throw new Error('input_limit');chunks.push(chunk)}
process.argv=[process.execPath,target,Buffer.concat(chunks).toString('utf8')];
await import(pathToFileURL(target).href);`;

export function isolatedNodeArguments(entrypoint) {
  return ["--disable-proto=throw", "--max-old-space-size=128", "--input-type=module", "--eval", NODE_INPUT_BOOTSTRAP, entrypoint];
}

export function bundledIsolationHelper({ platform = process.platform, arch = process.arch } = {}) {
  if (!["linux", "win32"].includes(platform) || !["x64", "arm64"].includes(arch)) return null;
  return join(ROOT, "native", "isolation", "bin", `${platform}-${arch}`, platform === "win32" ? "neuma-isolation.exe" : "neuma-isolation");
}

export async function checkedIsolationHelper(path) {
  if (!path) return null;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return null;
    const canonical = await realpath(path);
    if (resolve(path) !== canonical) return null;
    await access(canonical, constants.X_OK);
    return canonical;
  } catch { return null; }
}

export async function nativeIsolationRequest({ helperPath, temporaryDir, platform, nodePath, codeDir, writableDir, readableDir, workingDir, entrypoint, timeoutMs, maxOutputBytes }) {
  const controlDir = await realpath(await mkdtemp(join(temporaryDir, "neuma-isolation-control-")));
  try {
    if ([codeDir, writableDir, readableDir].filter(Boolean).some((path) => inside(path, controlDir) || inside(controlDir, path)))
      throw new Error("overlapping_control_directory");
    const statusPath = join(controlDir, "status.json"), journalPath = join(controlDir, "windows-cleanup.bin");
    const args = ["--node", nodePath, "--code", codeDir, "--write", writableDir, "--cwd", workingDir,
      "--timeout", String(timeoutMs), "--max-output", String(maxOutputBytes), "--status", statusPath];
    if (readableDir) args.push("--read", readableDir);
    if (platform === "win32") args.push("--journal", journalPath);
    args.push("--", ...isolatedNodeArguments(join(codeDir, entrypoint)));
    return { command: helperPath, args, controlDir, statusPath, journalPath };
  } catch (error) { await rm(controlDir, { recursive: true, force: true }); throw error; }
}

// Generated code never receives access to the control directory. Its stdout
// cannot forge the helper's status or turn failed setup into a passed run.
export async function readIsolationStatus(path, helperExitCode) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096) return null;
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value.protocol !== 1 || !["passed", "failed", "error"].includes(value.status)
      || !Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 0xffffffff
      || typeof value.cleanupComplete !== "boolean"
      || (value.reason !== undefined && !REASONS.has(value.reason))) return null;
    if ((value.status === "passed" && (value.exitCode !== 0 || helperExitCode !== 0 || value.reason))
      || (value.status !== "passed" && helperExitCode === 0)) return null;
    if (!value.cleanupComplete) return { status: "error", exitCode: value.exitCode, reason: "cleanup_failed" };
    return { status: value.status, exitCode: value.exitCode, ...(value.reason ? { reason: value.reason } : {}) };
  } catch { return null; }
}

export async function cleanupWindowsIsolation({ helperPath, journalPath, spawnImpl = spawn }) {
  try { await lstat(journalPath); } catch (error) { return error.code === "ENOENT"; }
  return new Promise((resolveResult) => {
    let child, timer, done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); resolveResult(ok); };
    try {
      child = spawnImpl(helperPath, ["--cleanup", journalPath], { windowsHide: true, shell: false, stdio: "ignore" });
      child.once("error", () => finish(false));
      child.once("close", (code) => finish(code === 0));
      timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(false); }, 3000);
    } catch { finish(false); }
  });
}

export async function recoverWindowsIsolation({ helperPath, temporaryDir, spawnImpl = spawn }) {
  let entries;
  try { entries = await readdir(temporaryDir, { withFileTypes: true }); } catch { return false; }
  const pending = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && /^neuma-isolation-control-[a-zA-Z0-9]+$/.test(entry.name));
  if (pending.length > 128) return false;
  for (const entry of pending) {
    const path = join(temporaryDir, entry.name), journalPath = join(path, "windows-cleanup.bin");
    try { await lstat(journalPath); } catch { continue; }
    const ok = await cleanupWindowsIsolation({ helperPath, journalPath, spawnImpl });
    if (!ok) return false;
    await rm(path, { recursive: true, force: true });
  }
  return true;
}
