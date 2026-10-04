import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectReader, validateProjectPlan, validateScriptCommand } from "../project-inspection.mjs";

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nuema-script-plan-")));
  const root = join(base, "project");
  await mkdir(root);
  await writeFile(join(root, "start2.sh"), "#!/bin/bash\ncase \"$1\" in start) echo started;; stop) echo stopped;; esac\n");
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root, project: { root, path: root, kind: "other" } };
}

test("可读取各类 Shell 启动脚本，隐藏访问密码和令牌但保留启动内容", async (t) => {
  const { root } = await fixture(t);
  const reader = createProjectReader(root);
  const source = ["#!/bin/bash", "export ACCESS_PASS='fixture-pass,more'", "PASSWORD=fixture-password",
    'SERVICE_TOKEN="fixture-token;more"', "API_KEY=fixture-api-key", 'CLIENT_SECRET="fixture-line-one\nfixture-line-two"',
    "API_PORT=3001", "python3 app.py"].join("\n");
  for (const extension of ["sh", "bash", "zsh", "command"]) {
    const file = `launch.${extension}`;
    await writeFile(join(root, file), source);
    const result = await reader.read(file);
    assert.doesNotMatch(result.text, /fixture-/);
    assert.match(result.text, /ACCESS_PASS=\[已隐藏\]/);
    assert.match(result.text, /API_PORT=3001/);
    assert.match(result.text, /python3 app.py/);
  }
  await writeFile(join(root, ".env"), "TOKEN=fixture-private");
  await writeFile(join(root, "credentials.sh"), "echo fixture-private");
  for (const file of [".env", "credentials.sh"]) await assert.rejects(reader.read(file));
});

test("后台多服务脚本保留启动停止参数和全部本机健康检查地址", async (t) => {
  const { root, project } = await fixture(t);
  const healthUrls = ["http://127.0.0.1:3000", "http://localhost:3001/health", "http://127.0.0.1:3002/health", "http://[::1]:3003/"];
  const result = await validateProjectPlan(project, { status: "ready", summary: "使用现有脚本启动四个服务。", kind: "script",
    command: "bash", args: ["start2.sh", "start"], background: true, stop: { command: "/bin/bash", args: ["start2.sh", "stop"] },
    url: healthUrls[0], healthUrls });
  assert.equal(result.kind, "script");
  assert.equal(result.launch.command, "/bin/bash");
  assert.deepEqual(result.launch.args, [join(root, "start2.sh"), "start"]);
  assert.deepEqual(result.launch.stop, { command: "/bin/bash", args: [join(root, "start2.sh"), "stop"] });
  assert.equal(result.launch.background, true);
  assert.equal(result.launch.url, "http://127.0.0.1:3000/");
  assert.deepEqual(result.launch.healthUrls, healthUrls.map((url) => new URL(url).href));
});

test("前台脚本无需后台停止配置并将入口规范为项目内绝对路径", async (t) => {
  const { root, project } = await fixture(t);
  const result = await validateProjectPlan(project, { status: "ready", summary: "运行已有脚本。", kind: "script",
    command: "sh", args: ["./start2.sh", "start"] });
  assert.deepEqual(result.launch, { command: "/bin/sh", args: [join(root, "start2.sh"), "start"], url: null,
    background: false, stop: null, healthUrls: [] });
});

test("脚本方案拒绝内联命令、越界文件、凭据文件和不完整后台配置", async (t) => {
  const { base, root, project } = await fixture(t);
  await writeFile(join(base, "outside.sh"), "echo outside");
  await symlink(join(base, "outside.sh"), join(root, "escape.sh"));
  await writeFile(join(root, ".private.sh"), "echo hidden");
  await symlink(join(root, ".private.sh"), join(root, "hidden-alias.sh"));
  await writeFile(join(root, "readme.txt"), "echo wrong-type");
  for (const command of [
    { command: "bash", args: ["-c", "echo inline"] }, { command: "bash", args: ["-e", "start2.sh"] },
    { command: "/usr/bin/env", args: ["bash", "start2.sh"] }, { command: "bash", args: ["escape.sh"] },
    { command: "bash", args: ["../outside.sh"] }, { command: "bash", args: ["hidden-alias.sh"] },
    { command: "bash", args: ["readme.txt"] }, { command: "bash", args: ["missing.sh"] },
  ]) await assert.rejects(validateScriptCommand(root, command));
  const plan = { status: "ready", summary: "后台服务。", kind: "script", command: "bash", args: ["start2.sh", "start"],
    background: true, stop: { command: "bash", args: ["start2.sh", "stop"] }, url: "http://localhost:3000", healthUrls: ["http://localhost:3000/health"] };
  for (const change of [{ stop: null }, { url: null }, { healthUrls: [] }, { background: "true" },
    { healthUrls: ["http://example.com/health"] }, { healthUrls: ["http://localhost:3000/health?token=private"] },
    { healthUrls: ["http://name:pass@localhost:3000/"] }, { healthUrls: "http://localhost:3000" },
    { stop: { command: "bash", args: ["-c", "echo stop"] } }]) await assert.rejects(validateProjectPlan(project, { ...plan, ...change }));
});
