import test from "node:test";
import assert from "node:assert/strict";
import { createProjectFolderPicker } from "../src/projects/project-folder-picker.mjs";
import { InputError } from "../src/requirements/core.mjs";

test("系统选择器返回完整文件夹路径，路径不拼接进命令且不继承模型凭据", async () => {
  let inspected;
  const pick = createProjectFolderPicker({ platform: "darwin",
    run: async (file, args, options) => {
      assert.equal(file, "/usr/bin/osascript");
      assert.match(args[1], /choose folder/);
      assert.equal(options.shell, undefined);
      assert.deepEqual(Object.keys(options.env).sort(), ["HOME", "LANG", "PATH"]);
      return { stdout: "/Users/test/研究 项目$(test)/\n" };
    },
    inspect: async (path) => { inspected = path; return { isDirectory: () => true }; },
  });
  assert.deepEqual(await pick(), { cancelled: false, path: "/Users/test/研究 项目$(test)", name: "研究 项目$(test)" });
  assert.equal(inspected, "/Users/test/研究 项目$(test)");
});

test("用户取消不是错误，也不访问任何文件夹", async () => {
  const pick = createProjectFolderPicker({ platform: "darwin", run: async () => ({ stdout: "\n" }),
    inspect: async () => assert.fail("取消后不应读取文件夹") });
  assert.deepEqual(await pick(), { cancelled: true });
});

test("打开期间拒绝重复请求，取消后释放选择器", async () => {
  let calls = 0;
  const pick = createProjectFolderPicker({ platform: "darwin", run: async (_file, _args, { signal }) => {
    if (++calls > 1) return { stdout: "\n" };
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  const controller = new AbortController();
  const pending = pick({ signal: controller.signal });
  await assert.rejects(pick(), /选择窗口已经打开/);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(await pick(), { cancelled: true });
  assert.equal(calls, 2);
});

test("不支持的平台和提前取消不会启动系统程序", async () => {
  const run = async () => assert.fail("不应启动选择器");
  await assert.rejects(createProjectFolderPicker({ platform: "freebsd", run })(), /手动填写/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createProjectFolderPicker({ platform: "darwin", run })({ signal: controller.signal }), { name: "AbortError" });
});

test("Windows 与 Linux 使用预编译系统窗口辅助程序，安全解析结果并支持取消", async () => {
  for (const [platform, path, name] of [["win32", "C:\\研究 项目", "研究 项目"], ["linux", "/home/user/研究 项目", "研究 项目"]]) {
    const pick = createProjectFolderPicker({ platform, helper: async () => "/fixture/helper",
      run: async (file, args, options) => { assert.equal(file, "/fixture/helper"); assert.deepEqual(args, ["pick-folder"]); assert.equal(options.shell, undefined); return { stdout: JSON.stringify({ cancelled: false, path }) }; },
      inspect: async () => ({ isDirectory: () => true }) });
    assert.deepEqual(await pick(), { cancelled: false, path, name });
    assert.deepEqual(await createProjectFolderPicker({ platform, helper: async () => "/fixture/helper", run: async () => ({ stdout: '{"cancelled":true}' }), inspect: async () => assert.fail("取消不读取目录") })(), { cancelled: true });
  }
});

test("不可用窗口和非法选取提供安全错误，不泄露系统输出", async () => {
  const pick = createProjectFolderPicker({ platform: "darwin", run: async () => { throw new Error("private-native-diagnostic"); } });
  await assert.rejects(pick(), (error) => error instanceof InputError && !error.message.includes("private-native"));
  for (const stdout of ["relative/path\n", "/file\n"]) {
    await assert.rejects(createProjectFolderPicker({ platform: "darwin", run: async () => ({ stdout }),
      inspect: async () => ({ isDirectory: () => false }) })(), InputError);
  }
});
