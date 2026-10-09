import { spawn } from "node:child_process";
import { DevelopmentExecutor } from "../../development-executor.mjs";

let remainingBytes = 16384, printed = 0;
const report = (line) => {
  if (printed >= 32) return;
  const match = /^NEUMA_ISOLATION_FAIL line=(\d{1,6}) win32=(\d{1,10})$/.exec(line.trim());
  if (match) { printed += 1; console.log(`NEUMA_ISOLATION_FAIL line=${match[1]} win32=${match[2]}`); }
};
const executor = new DevelopmentExecutor({ spawnImpl: (command, args, options) => {
  const child = spawn(command, args, options.stdio === "ignore" ? { ...options, stdio: ["ignore", "ignore", "pipe"] } : options);
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
const result = await executor.probe();
console.log(JSON.stringify({ available: result.available, kind: result.kind }));
if (!result.available) process.exitCode = 1;
