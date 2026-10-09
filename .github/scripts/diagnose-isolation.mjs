import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DevelopmentExecutor } from "../../development-executor.mjs";

let remainingBytes = 16384, printed = 0;
const loaderWrapper = fileURLToPath(new URL("./windows-loader.exe", import.meta.url));
const report = (line) => {
  if (printed >= 128) return;
  const match = /^NEUMA_ISOLATION_FAIL line=(\d{1,6}) win32=(\d{1,10})$/.exec(line.trim());
  if (match) { printed += 1; console.log(`NEUMA_ISOLATION_FAIL line=${match[1]} win32=${match[2]}`); return; }
  const safe = line.trim();
  if (/^NEUMA_LOADER_(?:DLL|MESSAGE) pid=\d{1,10} name=[A-Za-z0-9_.-]{1,128}$/.test(safe)
    || /^NEUMA_LOADER_EXCEPTION pid=\d{1,10} code=\d{1,10} first=[01]$/.test(safe)
    || /^NEUMA_LOADER_EXIT pid=\d{1,10} code=\d{1,10}$/.test(safe)
    || /^NEUMA_LOADER_ERROR code=\d{1,10}$/.test(safe)) { printed += 1; console.log(safe); }
};
const executor = new DevelopmentExecutor({ spawnImpl: (command, args, options) => {
  const useWrapper = process.platform === "win32" && args[0] === "--node" && existsSync(loaderWrapper);
  const child = spawn(useWrapper ? loaderWrapper : command, useWrapper ? [command, ...args] : args,
    options.stdio === "ignore" ? { ...options, stdio: ["ignore", "ignore", "pipe"] } : options);
  let pending = "";
  child.stderr?.on("data", (data) => {
    if (remainingBytes <= 0) return;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const part = bytes.subarray(0, remainingBytes); remainingBytes -= part.length;
    pending += part.toString("utf8");
    const lines = pending.split("\n"); pending = lines.pop().slice(-512);
    for (const line of lines) report(line);
  });
  child.once("close", () => report(pending));
  return child;
} });
const checks = ["readDenied", "writeDenied", "codeWriteDenied", "hardlinkDenied", "metadataDenied", "symlinkReadDenied", "scratchWorked", "networkDenied", "subprocessDenied"];
const sandboxRun = executor.sandboxRun.bind(executor);
// This script only calls the executor's fixed canary. Publish its booleans and
// bounded status fields rather than raw output, which may contain OS paths.
executor.sandboxRun = async (input) => {
  const result = await sandboxRun(input);
  let canary;
  try { canary = JSON.parse(result.stdout); } catch {}
  const status = ["passed", "failed", "error", "not_run"].includes(result.status) ? result.status : "unknown";
  const exitCode = Number.isSafeInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 0xffffffff ? result.exitCode : null;
  const observed = Object.fromEntries(checks.map((key) => [key, typeof canary?.[key] === "boolean" ? canary[key] : null]));
  console.log(JSON.stringify({ canaryStatus: status, exitCode, checks: observed }));
  return result;
};
const result = await executor.probe();
console.log(JSON.stringify({ available: result.available, kind: result.kind }));
if (!result.available) process.exitCode = 1;
