import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, lstat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DevelopmentExecutor } from "../src/development/development-executor.mjs";
import { bundledIsolationHelper, checkedIsolationHelper, isolatedNodeArguments, NODE_INPUT_BOOTSTRAP, readIsolationStatus } from "../src/runtime/isolation-native.mjs";

const CANARY = { readDenied: true, writeDenied: true, codeWriteDenied: true, hardlinkDenied: true, metadataDenied: true,
  symlinkReadDenied: true, scratchWorked: true, networkDenied: true, subprocessDenied: true };

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuma-native-unit-")));
  const helper = join(root, "trusted-test-helper"), codeDir = join(root, "code"), writableDir = join(root, "work");
  await mkdir(codeDir); await mkdir(writableDir); await writeFile(helper, "fake helper; never executed", { mode: 0o700 });
  await writeFile(join(codeDir, "main.mjs"), "console.log(JSON.stringify({ok:true}));");
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, helper, codeDir, writableDir };
}

function nativeMock({ status = true, cleanup = true, journal = false } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const call = { command, args, options, input: "" }; calls.push(call);
    const child = new EventEmitter(); child.pid = 900000 + calls.length;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin.on("data", (data) => { call.input += data.toString("utf8"); });
    child.kill = () => {};
    queueMicrotask(() => { void (async () => {
      if (args[0] === "--cleanup") {
        if (cleanup) await rm(args[1], { force: true });
        child.emit("close", cleanup ? 0 : 1, null); return;
      }
      const statusPath = args[args.indexOf("--status") + 1];
      if (journal) await writeFile(join(dirname(statusPath), "windows-cleanup.bin"), "mock protected journal");
      if (status) await writeFile(statusPath, JSON.stringify({ protocol: 1, status: "passed", exitCode: 0, cleanupComplete: true }));
      child.stdout.write(args.at(-1).endsWith("probe.mjs") ? JSON.stringify(CANARY) : '{"ok":true}');
      child.emit("exit", 0, null); child.emit("close", 0, null);
    })().catch((error) => child.emit("error", error)); });
    return child;
  };
  return { calls, spawnImpl };
}

test("只选择本包支持架构的独立原生程序，缺少时不启动普通Node", async (t) => {
  assert.equal(bundledIsolationHelper({ platform: "linux", arch: "arm64" }),
    fileURLToPath(new URL("../native/isolation/bin/linux-arm64/neuma-isolation", import.meta.url)));
  assert.match(bundledIsolationHelper({ platform: "win32", arch: "x64" }), /win32-x64[/\\]neuma-isolation\.exe$/);
  assert.equal(bundledIsolationHelper({ platform: "linux", arch: "ia32" }), null);
  const data = await fixture(t);
  for (const platform of ["linux", "win32"]) {
    const executor = new DevelopmentExecutor({ platform, nativeHelperPath: join(data.root, "missing"), spawnImpl: () => assert.fail("不允许回退执行") });
    const probe = await executor.probe(); assert.equal(probe.available, false); assert.match(probe.reason, /缺少/);
    assert.equal((await executor.run({ codeDir: data.codeDir, entrypoint: "main.mjs", input: "hello" })).status, "not_run");
  }
});

test("原生辅助程序入口拒绝链接，避免安装包入口被换成外部目标", async (t) => {
  const data = await fixture(t); assert.equal(await checkedIsolationHelper(data.helper), data.helper);
  const linked = join(data.root, "linked-helper"); await symlink(data.helper, linked);
  assert.equal(await checkedIsolationHelper(linked), null);
});

test("Linux协议把长中文输入送入stdin，进程参数不携带任务内容", async (t) => {
  const data = await fixture(t), mock = nativeMock();
  const executor = new DevelopmentExecutor({ platform: "linux", nativeHelperPath: data.helper, spawnImpl: mock.spawnImpl, temporaryDir: data.root, killImpl: () => {} });
  const input = "中文输入".repeat(8000);
  const result = await executor.run({ codeDir: data.codeDir, entrypoint: "main.mjs", workspaceDir: data.writableDir, input });
  assert.equal(result.status, "passed"); assert.deepEqual(result.output, { ok: true });
  assert.equal(mock.calls.length, 2); assert.equal(mock.calls[1].input, input);
  assert.equal(mock.calls[1].args.some((value) => value.includes(input)), false);
  assert.equal(mock.calls[1].options.shell, false);
  assert.ok(mock.calls[1].args.includes("--max-old-space-size=128"));
});

test("生成程序stdout即使输出通过结果，没有受保护的helper状态也不能通过", async (t) => {
  const data = await fixture(t), mock = nativeMock({ status: false });
  const executor = new DevelopmentExecutor({ platform: "linux", nativeHelperPath: data.helper, spawnImpl: mock.spawnImpl, temporaryDir: data.root, killImpl: () => {} });
  const probe = await executor.probe(); assert.equal(probe.available, false);
  assert.equal((await executor.run({ codeDir: data.codeDir, entrypoint: "main.mjs", input: "" })).status, "not_run");
});

test("原生状态校验拒绝不一致退出码、非法字段和未完成权限清理", async (t) => {
  const data = await fixture(t), path = join(data.root, "status.json");
  const good = { protocol: 1, status: "passed", exitCode: 0, cleanupComplete: true };
  await writeFile(path, JSON.stringify(good)); assert.equal((await readIsolationStatus(path, 0)).status, "passed");
  assert.equal(await readIsolationStatus(path, 1), null);
  await writeFile(path, JSON.stringify({ ...good, protocol: 2 })); assert.equal(await readIsolationStatus(path, 0), null);
  await writeFile(path, JSON.stringify({ ...good, cleanupComplete: false })); assert.equal((await readIsolationStatus(path, 0)).reason, "cleanup_failed");
  await writeFile(path, "x".repeat(5000)); assert.equal(await readIsolationStatus(path, 0), null);
});

test("Windows清理失败保留私有journal供下次恢复，不删掉恢复依据", async (t) => {
  const data = await fixture(t), mock = nativeMock({ cleanup: false, journal: true });
  const executor = new DevelopmentExecutor({ platform: "win32", nativeHelperPath: data.helper, spawnImpl: mock.spawnImpl, temporaryDir: data.root, killImpl: () => {} });
  const result = await executor.sandboxRun({ codeDir: data.codeDir, entrypoint: "main.mjs", input: "", writableDir: data.writableDir });
  assert.equal(result.status, "error"); assert.equal(result.reason, "cleanup_failed");
  const args = mock.calls[0].args, journalPath = args[args.indexOf("--journal") + 1];
  assert.equal(await readFile(journalPath, "utf8"), "mock protected journal");
  assert.equal((await lstat(dirname(journalPath))).isDirectory(), true);
  assert.equal(mock.calls[1].args[0], "--cleanup");
});

test("Windows清理完成后删除只属于本次执行的控制目录", async (t) => {
  const data = await fixture(t), mock = nativeMock({ journal: true });
  const executor = new DevelopmentExecutor({ platform: "win32", nativeHelperPath: data.helper, spawnImpl: mock.spawnImpl, temporaryDir: data.root, killImpl: () => {} });
  const result = await executor.sandboxRun({ codeDir: data.codeDir, entrypoint: "main.mjs", input: "", writableDir: data.writableDir });
  assert.equal(result.status, "passed"); const args = mock.calls[0].args;
  await assert.rejects(lstat(dirname(args[args.indexOf("--journal") + 1])), { code: "ENOENT" });
});

test("固定bootstrap恢复现有argv接口，输入限额与受限Node参数固定", () => {
  const args = isolatedNodeArguments("/controlled/main.mjs");
  assert.equal(args.at(-1), "/controlled/main.mjs"); assert.equal(args[args.indexOf("--eval") + 1], NODE_INPUT_BOOTSTRAP);
  assert.match(NODE_INPUT_BOOTSTRAP, /process\.argv=\[process\.execPath,target,/);
  assert.match(NODE_INPUT_BOOTSTRAP, /size>131072/);
});
