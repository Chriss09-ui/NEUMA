import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { inspectDevelopmentCode, validateCodePath } from "./development-workspace.mjs";
import { bundledIsolationHelper, checkedIsolationHelper, cleanupWindowsIsolation, isolatedNodeArguments,
  nativeIsolationRequest, readIsolationStatus, recoverWindowsIsolation } from "./isolation-native.mjs";

const inside = (root, path) => { const part = relative(root, path); return part === "" || (!part.startsWith("..") && !isAbsolute(part)); };
const quoted = (value) => JSON.stringify(value);
const isolationKind = (platform) => ({ darwin: "macos-seatbelt", linux: "linux-landlock-seccomp", win32: "windows-lpac-job" }[platform] ?? "unsupported");
const unavailable = (reason, platform) => ({ available: false, reason, kind: isolationKind(platform) });
const outcome = (status, reason, extra = {}) => ({ status, exitCode: null, stdout: "", stderr: "", reason, ...extra });

function sandboxProfile({ codeDir, writableDir, readableDir, nodePath }) {
  const resources = ["/System/Library", "/usr/lib", "/usr/share/icu", "/private/var/db/dyld"];
  return `(version 1)
(deny default)
(deny network*)
(allow process-exec (literal ${quoted(nodePath)}))
(allow signal (target same-sandbox))
(allow sysctl-read)
; Attribute lookup does not permit reading application records or directory contents.
(allow file-read-metadata)
(allow file-read-data (literal "/"))
(allow file-read* ${resources.map((path) => `(subpath ${quoted(path)})`).join(" ")})
(allow file-read* (literal ${quoted(nodePath)}))
(allow file-read-data (regex #"^/(opt/homebrew|usr/local)/(Cellar|opt)/.*\\.dylib$"))
(allow file-map-executable ${resources.map((path) => `(subpath ${quoted(path)})`).join(" ")} (literal ${quoted(nodePath)})
  (regex #"^/(opt/homebrew|usr/local)/(Cellar|opt)/.*\\.dylib$"))
(allow file-read* (subpath ${quoted(codeDir)}))
${readableDir ? `(allow file-read* (subpath ${quoted(readableDir)}))` : ""}
(allow file-read* file-write* (subpath ${quoted(writableDir)}))
(allow file-read* file-write* (literal "/dev/null"))
(allow file-read* (literal "/dev/urandom") (literal "/dev/random"))`;
}

function cleanEnv(writableDir, nodePath) {
  return { PATH: dirname(nodePath), HOME: writableDir, TMPDIR: writableDir, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", OPENSSL_CONF: "/dev/null" };
}

/** Execute Node JSON entrypoints only after a real OS boundary passes canary checks. */
export class DevelopmentExecutor {
  constructor({ platform = process.platform, arch = process.arch, sandboxPath = "/usr/bin/sandbox-exec", nodePath = process.execPath,
    nativeHelperPath = bundledIsolationHelper({ platform, arch }),
    spawnImpl = spawn, killImpl = process.kill.bind(process), timeoutMs = 10000, maxOutputBytes = 128 * 1024,
    temporaryDir = tmpdir() } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
      || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1024 * 1024)
      throw new TypeError("执行时限或输出上限无效");
    Object.assign(this, { platform, arch, sandboxPath, nodePath, nativeHelperPath, spawnImpl, killImpl, timeoutMs, maxOutputBytes, temporaryDir });
    this.probeResult = null;
    this.probePromise = null;
  }

  async canonicalDirectory(path) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid_directory");
    const resolved = await realpath(path);
    // macOS exposes temporary directories through these two system aliases.
    const canonicalInput = resolve(path).replace(/^\/tmp\//, "/private/tmp/").replace(/^\/var\//, "/private/var/");
    const windowsCaseOnly = this.platform === "win32" && resolve(path).toLowerCase() === resolved.toLowerCase();
    if (resolve(path) !== resolved && canonicalInput !== resolved && !windowsCaseOnly) throw new Error("symlink_directory");
    return resolved;
  }

  async sandboxRun({ codeDir, entrypoint, input, writableDir, readableDir, workingDir = writableDir, signal, timeoutMs = this.timeoutMs }) {
    if (signal?.aborted) return outcome("error", "cancelled");
    let command = this.sandboxPath, args, nativeRequest, cleanupComplete = true;
    if (this.platform === "darwin") args = ["-p", sandboxProfile({ codeDir, writableDir, readableDir, nodePath: this.nodePath }), this.nodePath,
      ...isolatedNodeArguments(join(codeDir, entrypoint))];
    else if (["linux", "win32"].includes(this.platform)) {
      const helperPath = await checkedIsolationHelper(this.nativeHelperPath);
      if (!helperPath) return outcome("error", "isolation_helper_unavailable");
      try {
        nativeRequest = await nativeIsolationRequest({ helperPath, temporaryDir: this.temporaryDir, platform: this.platform,
          nodePath: this.nodePath, codeDir, writableDir, readableDir, workingDir, entrypoint, timeoutMs, maxOutputBytes: this.maxOutputBytes });
        ({ command, args } = nativeRequest);
      } catch { return outcome("error", "isolation_setup_failed"); }
    } else return outcome("not_run", "当前平台没有操作系统隔离执行器");
    try { return await new Promise((resolveResult) => {
      let child, timer, settled = false, reason = "", stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), exitCode = null;
      const kill = () => {
        if (!child?.pid) return;
        if (this.platform === "win32") { try { child.kill("SIGKILL"); } catch {} }
        else try { this.killImpl(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
      };
      const finish = async () => {
        if (settled) return; settled = true;
        clearTimeout(timer); signal?.removeEventListener("abort", abort); kill();
        let status = { status: reason ? "error" : exitCode === 0 ? "passed" : "failed", exitCode, ...(reason ? { reason } : {}) };
        if (nativeRequest) {
          if (!reason) status = await readIsolationStatus(nativeRequest.statusPath, exitCode) ?? { status: "error", exitCode, reason: "isolation_setup_failed" };
          if (this.platform === "win32" && !await cleanupWindowsIsolation({ helperPath: command, journalPath: nativeRequest.journalPath, spawnImpl: this.spawnImpl }))
            { cleanupComplete = false; status = { status: "error", exitCode, reason: reason || "cleanup_failed" }; }
        }
        resolveResult({ ...status,
          stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), ...(reason ? { reason } : {}) });
      };
      const stop = (why) => {
        if (settled) return;
        if (!reason) reason = why;
        clearTimeout(timer); kill();
        // Reap the child before cleaning its working directory. A broken pipe
        // must not prevent cancellation forever after the process group dies.
        if (child?.pid && !settled) timer = setTimeout(finish, 1000);
        else finish();
      };
      const abort = () => stop("cancelled");
      const collect = (stream, data) => {
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const remaining = Math.max(0, this.maxOutputBytes - stdout.length - stderr.length);
        if (stream === "stdout") stdout = Buffer.concat([stdout, bytes.subarray(0, remaining)]);
        else stderr = Buffer.concat([stderr, bytes.subarray(0, remaining)]);
        if (bytes.length > remaining) stop("output_limit");
      };
      try {
        child = this.spawnImpl(command, args, { cwd: workingDir, env: cleanEnv(writableDir, this.nodePath),
          detached: this.platform !== "win32", windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
        child.stdout?.on("data", (value) => collect("stdout", value));
        child.stderr?.on("data", (value) => collect("stderr", value));
        child.stdin?.on("error", () => { /* The child may exit before consuming input. */ });
        child.stdin?.end(input);
        child.on("error", () => stop("spawn_failed"));
        child.on("exit", (code, terminationSignal) => { exitCode = code; if (terminationSignal && !reason) reason = "process_terminated"; kill(); });
        child.on("close", (code, terminationSignal) => {
          exitCode = code; if (terminationSignal && !reason) reason = "process_terminated"; finish();
        });
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => stop("timeout"), timeoutMs);
        if (signal?.aborted) abort();
      } catch { stop("spawn_failed"); }
    }); } finally { if (nativeRequest?.controlDir && cleanupComplete) await rm(nativeRequest.controlDir, { recursive: true, force: true }); }
  }

  async probe({ signal } = {}) {
    if (signal?.aborted) return unavailable("cancelled", this.platform);
    if (this.probeResult) return { ...this.probeResult };
    // Only one canary runs per executor, even when two Agent calls arrive at once.
    if (!this.probePromise) this.probePromise = this.probeIsolation({ signal });
    const pending = this.probePromise;
    try { const result = await pending; return signal?.aborted ? unavailable("cancelled", this.platform) : { ...result }; }
    finally { if (this.probePromise === pending) this.probePromise = null; }
  }

  async probeIsolation({ signal } = {}) {
    if (!["darwin", "linux", "win32"].includes(this.platform)) return unavailable("当前平台没有操作系统隔离执行器", this.platform);
    if (this.platform !== "darwin" && !await checkedIsolationHelper(this.nativeHelperPath))
      return unavailable("当前安装包缺少本平台的原生隔离辅助程序；生成代码执行保持禁用", this.platform);
    if (this.platform === "win32" && !await recoverWindowsIsolation({ helperPath: this.nativeHelperPath, temporaryDir: this.temporaryDir, spawnImpl: this.spawnImpl }))
      return unavailable("上次隔离运行的权限尚未安全清理；生成代码执行保持禁用", this.platform);
    let directory;
    try {
      this.nodePath = await realpath(this.nodePath);
      directory = await mkdtemp(join(this.temporaryDir, "neuma-isolation-probe-")); directory = await realpath(directory);
      const codeDir = join(directory, "code"), writableDir = join(directory, "scratch"), outside = join(directory, "metadata");
      await Promise.all([mkdir(codeDir), mkdir(writableDir), mkdir(outside)]);
      const canary = join(outside, "canary.json"); await writeFile(canary, '"private-canary"');
      const source = `import fs from 'node:fs';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
const denied = (fn, codes=['EPERM','EACCES']) => { try { fn(); return false; } catch (error) { return codes.includes(error.code); } };
const scratch = ${JSON.stringify(join(writableDir, "allowed.txt"))};
fs.writeFileSync(scratch, 'allowed');
const networkDenied = await new Promise(resolve => { const server=net.createServer(); server.once('error', error=>resolve(['EPERM','EACCES'].includes(error.code))); server.listen(0,'127.0.0.1',()=>server.close(()=>resolve(false))); });
const child = spawnSync(process.execPath,['-e','process.exit(0)'],{timeout:500});
const symlink=${JSON.stringify(join(writableDir, "linked-symbolic.json"))};
let symlinkReadDenied=false;
try { fs.symlinkSync(${JSON.stringify(canary)},symlink); symlinkReadDenied=denied(()=>fs.readFileSync(symlink)); }
catch(error){symlinkReadDenied=['EPERM','EACCES'].includes(error.code)}
console.log(JSON.stringify({readDenied:denied(()=>fs.readFileSync(${JSON.stringify(canary)})),
writeDenied:denied(()=>fs.writeFileSync(${JSON.stringify(join(outside, "blocked.txt"))},'bad')),
codeWriteDenied:denied(()=>fs.writeFileSync(${JSON.stringify(join(codeDir, "blocked.txt"))},'bad')),
hardlinkDenied:denied(()=>fs.linkSync(${JSON.stringify(canary)},${JSON.stringify(join(writableDir, "linked.json"))}),['EPERM','EACCES','EXDEV']),
metadataDenied:denied(()=>fs.chmodSync(${JSON.stringify(canary)},0o600)),symlinkReadDenied,
scratchWorked:fs.readFileSync(scratch,'utf8')==='allowed',networkDenied,
subprocessDenied:['EPERM','EACCES'].includes(child.error?.code)}));`;
      // Only the fixed canary program is launched before the boundary is verified.
      await writeFile(join(codeDir, "probe.mjs"), source);
      const run = await this.sandboxRun({ codeDir, entrypoint: "probe.mjs", input: "", writableDir, signal, timeoutMs: Math.min(5000, this.timeoutMs) });
      if (signal?.aborted) return unavailable("cancelled", this.platform);
      let result; try { result = JSON.parse(run.stdout); } catch {}
      const outsideUnchanged = await readFile(canary, "utf8") === '"private-canary"'
        && await lstat(join(outside, "blocked.txt")).then(() => false, (error) => error.code === "ENOENT");
      if (run.status !== "passed" || !outsideUnchanged || !isDeepStrictEqual(result, { readDenied: true, writeDenied: true, codeWriteDenied: true, hardlinkDenied: true,
        metadataDenied: true, symlinkReadDenied: true, scratchWorked: true, networkDenied: true, subprocessDenied: true }))
        return unavailable("操作系统隔离未通过启动与越界读写检查；当前环境不能安全执行生成代码", this.platform);
      return (this.probeResult = { available: true, reason: "操作系统隔离已通过代码只读、工作目录写入、外部读写及网络和子进程禁用检查", kind: isolationKind(this.platform) });
    } catch {
      if (signal?.aborted) return unavailable("cancelled", this.platform);
      return unavailable("无法建立或验证操作系统隔离环境", this.platform);
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }

  async run({ codeDir, entrypoint, input, workspaceDir, workspaceReadOnly = false, signal }) {
    if (signal?.aborted) return outcome("error", "cancelled");
    const availability = await this.probe({ signal });
    if (!availability.available) return outcome(signal?.aborted ? "error" : "not_run", availability.reason);
    let scratch;
    try {
      validateCodePath(entrypoint);
      if (!/\.(?:mjs|cjs|js)$/.test(entrypoint) || typeof input !== "string" || Buffer.byteLength(input) > 128 * 1024) return outcome("error", "invalid_entrypoint_or_input");
      codeDir = await this.canonicalDirectory(codeDir);
      const code = await inspectDevelopmentCode(codeDir);
      if (!code.files.some((file) => file.path === entrypoint)) return outcome("error", "entrypoint_missing");
      let writableDir, workingDir, readableDir;
      if (workspaceDir) {
        workspaceDir = await this.canonicalDirectory(workspaceDir);
        // Direct Node filesystem access must meet the same credential/link
        // boundary as the text tools before the OS grants directory access.
        try { await inspectDevelopmentCode(workspaceDir); }
        catch { return outcome("error", "workspace_contains_unsafe_files"); }
        workingDir = workspaceDir;
        if (workspaceReadOnly) readableDir = workspaceDir;
        else writableDir = workspaceDir;
      }
      if (!writableDir) { scratch = await mkdtemp(join(this.temporaryDir, "neuma-code-run-")); writableDir = await realpath(scratch); }
      workingDir ??= writableDir;
      if ([writableDir, workingDir].some((path) => inside(path, codeDir) || inside(codeDir, path))) return outcome("error", "code_and_working_directory_overlap");
      const run = await this.sandboxRun({ codeDir, entrypoint, input, writableDir, workingDir, readableDir, signal });
      if (run.status !== "passed") return run;
      try { return { ...run, output: JSON.parse(run.stdout) }; }
      catch { return { ...run, status: "failed", reason: "stdout_must_be_one_json_value" }; }
    } catch {
      return outcome("error", signal?.aborted ? "cancelled" : "invalid_code_or_execution_directory");
    } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
  }

  async verify({ snapshot, entrypoint, cases, stateful = false, signal }) {
    const report = { status: "not_run", codeHash: snapshot?.hash ?? null, results: [], summary: "没有实际执行验收", stateful };
    if (typeof stateful !== "boolean") return { ...report, stateful: false, status: "error", summary: "验收状态模式无效" };
    if (!Array.isArray(cases) || cases.length === 0) return report;
    if (cases.length > 200) return { ...report, status: "error", summary: "验收用例数量超限" };
    try {
      if (!snapshot || (await inspectDevelopmentCode(snapshot.path)).hash !== snapshot.hash)
        return { ...report, status: "error", summary: "代码快照已改变或版本无效" };
    } catch { return { ...report, status: "error", summary: "代码快照无法校验" }; }
    const ids = new Set();
    for (const item of cases) {
      if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id) || typeof item.input !== "string"
        || !Array.isArray(item.assertions) || item.assertions.length === 0 || item.assertions.length > 100
        || item.assertions.some((assertion) => !assertion || typeof assertion.path !== "string" || typeof assertion.expectedJson !== "string"))
        return { ...report, status: "error", summary: "验收用例必须有唯一标识和具体值断言" };
      ids.add(item.id);
      try { for (const assertion of item.assertions) JSON.parse(assertion.expectedJson); }
      catch { return { ...report, status: "error", summary: "验收断言包含无效 JSON" }; }
    }
    const availability = await this.probe({ signal });
    if (!availability.available) return { ...report, ...(signal?.aborted ? { status: "error" } : {}),
      results: cases.map((item) => ({ caseId: item.id, status: "not_run", input: item.input, exitCode: null, reason: availability.reason })), summary: availability.reason };
    let verificationWorkspace;
    try {
      // Persistent-state scenarios share only this verification's fresh space.
      // Their frozen order is significant; user workspaces are never reused.
      if (stateful) verificationWorkspace = await realpath(await mkdtemp(join(this.temporaryDir, "neuma-verification-state-")));
      for (const item of cases) {
        const run = await this.run({ codeDir: snapshot.path, entrypoint, input: item.input, signal,
          ...(verificationWorkspace ? { workspaceDir: verificationWorkspace } : {}) });
        const result = { caseId: item.id, ...(item.taskId === undefined ? {} : { taskId: item.taskId }),
          ...(item.acceptanceId === undefined ? {} : { acceptanceId: item.acceptanceId }), status: run.status,
          input: item.input, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr, reason: run.reason ?? "",
          expected: item.assertions.map(({ path, expectedJson }) => ({ path, value: JSON.parse(expectedJson) })) };
        if (run.status === "passed") {
          result.actual = run.output;
          const failures = result.expected.filter(({ path, value }) => {
            let actual = run.output;
            if (path !== "") for (const key of path.split(".")) {
              if (actual === null || typeof actual !== "object" || !Object.hasOwn(actual, key)) return true;
              actual = actual[key];
            }
            return !isDeepStrictEqual(actual, value);
          });
          if (failures.length) { result.status = "failed"; result.reason = "assertion_mismatch: " + failures.map((item) => item.path || "<root>").join(", "); }
        }
        report.results.push(result);
        if (signal?.aborted) break;
      }
    } catch { return { ...report, status: "error", summary: signal?.aborted ? "验收已取消" : "验收工作目录或执行过程异常" }; }
    finally { if (verificationWorkspace) await rm(verificationWorkspace, { recursive: true, force: true }); }
    if (report.results.length < cases.length) for (const item of cases.slice(report.results.length))
      report.results.push({ caseId: item.id, status: "not_run", input: item.input, exitCode: null, reason: "cancelled" });
    try {
      if ((await inspectDevelopmentCode(snapshot.path)).hash !== snapshot.hash) return { ...report, status: "error", summary: "验收期间代码版本改变，证据无效" };
    } catch { return { ...report, status: "error", summary: "验收后代码快照无法校验" }; }
    report.status = report.results.some((result) => result.status === "error") ? "error"
      : report.results.some((result) => result.status === "failed") ? "failed"
        : report.results.some((result) => result.status === "not_run") ? "not_run" : "passed";
    report.summary = `${report.results.filter((result) => result.status === "passed").length}/${cases.length} 条验收通过`;
    return report;
  }
}
