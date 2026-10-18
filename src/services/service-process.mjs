import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { ServiceError } from "./service-contract.mjs";

export function cleanServiceEnvironment(directory, executable) {
  return { PATH: `${dirname(executable)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, HOME: directory, TMPDIR: directory, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", OPENSSL_CONF: "/dev/null", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" };
}
export function managedSandboxProfile({ executable, runtimeRoot, codeDir, dependencyDir, workerDir, scratchDir }) {
  const quoted = JSON.stringify;
  const roots = ["/System/Library", "/usr/lib", "/usr/share/icu", "/private/var/db/dyld"];
  const read = [...roots, codeDir, workerDir, runtimeRoot, dependencyDir].filter(Boolean);
  return `(version 1)
(deny default)
(deny network*)
(allow process-exec (literal ${quoted(executable)}))
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read-data (literal "/"))
(allow file-read* ${read.map((path) => `(subpath ${quoted(path)})`).join(" ")} (literal ${quoted(executable)}))
(allow file-read-data (regex #"^/(opt/homebrew|usr/local)/(Cellar|opt)/.*\\.dylib$"))
(allow file-map-executable ${read.map((path) => `(subpath ${quoted(path)})`).join(" ")} (literal ${quoted(executable)}) (regex #"^/(opt/homebrew|usr/local)/(Cellar|opt)/.*\\.dylib$"))
(allow file-read* file-write* (subpath ${quoted(scratchDir)}))
(allow file-read* file-write* (literal "/dev/null"))
(allow file-read* (literal "/dev/urandom") (literal "/dev/random"))`;
}
export function killProcessGroup(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
}
export async function commandResult(command, args, { cwd, env, signal, timeoutMs = 10000, maxBytes = 1024 * 1024, input, spawnImpl = spawn } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child, timer, output = Buffer.alloc(0), errors = Buffer.alloc(0), finished = false, failure;
    const stop = (reason) => { failure ??= new ServiceError(reason); killProcessGroup(child); };
    const abort = () => stop("cancelled");
    const collect = (kind, bytes) => {
      if (output.length + errors.length + bytes.length > maxBytes) { stop("command_output_limit"); return; }
      if (kind === "stdout") output = Buffer.concat([output, bytes]); else errors = Buffer.concat([errors, bytes]);
    };
    const finish = (code) => {
      if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure) reject(failure); else resolve({ code, stdout: output.toString("utf8"), stderr: errors.toString("utf8") });
    };
    try {
      child = spawnImpl(command, args, { cwd, env, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      child.on("error", () => { failure = new ServiceError("command_unavailable"); finish(null); });
      child.on("close", finish); child.stdout.on("data", (bytes) => collect("stdout", bytes)); child.stderr.on("data", (bytes) => collect("stderr", bytes));
      child.stdin.on("error", () => {}); child.stdin.end(input);
      timer = setTimeout(() => stop("command_timeout"), timeoutMs); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    } catch { failure = new ServiceError("command_unavailable"); finish(null); }
  });
}
