import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

// Classify whole files. Files mixing doubles and real SDK/process execution belong in integration.
// test/ 顶层只保留 server 组装测试和 native-check.yml 固定引用的四个入口；其余测试按领域子目录存放，条目使用相对 test 根的路径。
export const TEST_LAYERS = Object.freeze({
  unit: Object.freeze([
    "installation/source-launcher.test.mjs", "build/typescript-boundaries.test.mjs", "build/m4-architecture-boundaries.test.mjs", "build/m4-development-boundaries.test.mjs",
    "runtime/model-context.test.mjs", "architecture/architecture-model-context.test.mjs",
    "applications/application-ui.test.mjs", "applications/application-context-ui.test.mjs", "applications/application-assistant-ui.test.mjs", "applications/application-context.test.mjs", "runtime/web-capabilities.test.mjs", "agents/agent-connections.test.mjs",
    "agents/agent-api.test.mjs", "agents/agent-attachments.test.mjs", "agents/agent-avatar.test.mjs", "agents/agent-conversations.test.mjs",
    "agents/agent-details.test.mjs", "agents/agent-library.test.mjs", "agents/agent-runtime.test.mjs", "runtime/agent-scheduler.test.mjs",
    "agents/agents-ui.test.mjs", "architecture/architecture-contract.test.mjs", "architecture/architecture-platform.test.mjs", "architecture/platform-contract.test.mjs", "architecture/architecture-research.test.mjs", "build/browser-selection.test.mjs",
    "architecture/architecture-review-progress.test.mjs", "architecture/architecture-reference-selectors.test.mjs", "architecture/architecture-native-finding-closure.test.mjs",
    "ui/chat-ui.test.mjs", "ui/rich-text.test.mjs", "collaboration/collaboration-api.test.mjs", "collaboration/collaboration-ui.test.mjs", "requirements/core.test.mjs",
    "development/development-api.test.mjs", "development/development-case-schema.test.mjs", "development/development-context.test.mjs", "development/development-contract.test.mjs", "development/development-diagnostics.test.mjs", "development/development-fixtures.test.mjs", "development/development-store.test.mjs",
    "development/development-ui.test.mjs", "development/development-workspace.test.mjs", "development/development.test.mjs", "requirements/input-framing.test.mjs", "collaboration/group-question.test.mjs",
    "collaboration/groups.test.mjs", "collaboration/group-avatar.test.mjs", "collaboration/group-messages.test.mjs", "collaboration/group-conversations.test.mjs", "collaboration/group-conversation-removal.test.mjs", "collaboration/group-mentions.test.mjs", "collaboration/group-mention-composer.test.mjs", "collaboration/group-routing.test.mjs", "collaboration/group-reply-protocol.test.mjs", "collaboration/group-replies.test.mjs", "installation/installation-migration.test.mjs", "isolation-native.test.mjs", "requirements/jev-connection.test.mjs",
    "collaboration/main-agent.test.mjs", "collaboration/main-context-focus.test.mjs", "collaboration/main-materials.test.mjs", "collaboration/main-requirements.test.mjs", "requirements/requirement-calculation-diagnostics.test.mjs", "requirements/requirement-calculations.test.mjs", "requirements/requirement-capacity-guidance.test.mjs", "requirements/requirement-platform-binding.test.mjs", "requirements/requirement-routing.test.mjs", "requirements/requirement-system-notes.test.mjs", "requirements/requirement-system-resume.test.mjs", "requirements/requirement-verification.test.mjs",
    "requirements/requirement-facts.test.mjs", "runtime/model-connection-api.test.mjs", "ui/panel-resize.test.mjs", "build/preview-release.test.mjs", "projects/project-diagnostics.test.mjs",
    "projects/project-folder-picker.test.mjs", "projects/project-inspection.test.mjs", "projects/project-removal.test.mjs", "project-runtime.test.mjs",
    "projects/project-script-plan.test.mjs", "projects/project-view.test.mjs", "projects/projects-ui.test.mjs", "runtime/providers.test.mjs",
    "build/release.test.mjs", "requirements/requirements-ui.test.mjs", "ui/runtime-view.test.mjs", "server.test.mjs",
    "runtime/session-shutdown.test.mjs", "runtime/settings-ui.test.mjs", "runtime/settings.test.mjs", "ui/shell.test.mjs",
    "ui/select-menu.test.mjs", "installation/skills-api.test.mjs", "installation/skills-splitter.test.mjs", "installation/skills-ui.test.mjs", "installation/skills.test.mjs", "ui/state.test.mjs", "requirements/task-spec-schema.test.mjs", "build/test-layers.test.mjs", "development/value-schema-rules.test.mjs",
    "build/hygiene-leftovers.test.mjs",
  ]),
  integration: Object.freeze([
    "build/build-pipeline.test.mjs", "collaboration/controller-storage-boundaries.test.mjs",
    "runtime/model-context-native.test.mjs",
    "applications/application-store.test.mjs", "applications/application-resources.test.mjs", "applications/application-service.test.mjs", "requirements/input-framing-integration.test.mjs",
    "development/node-action.test.mjs", "applications/application-delivery-integration.test.mjs", "applications/dashboard-application-integration.test.mjs", "agents/agent-web-runtime.test.mjs", "services/python-gateway-integration.test.mjs",
    "agents/agent-attachments-api.test.mjs", "agents/agent-build-view.test.mjs", "collaboration/agent-collaboration-runtime.test.mjs",
    "agents/agent-material-runtime.test.mjs", "agents/agent-prototype.test.mjs", "agents/agent-active-runtime.test.mjs", "agents/agent-storage.test.mjs",
    "architecture/architecture-integration.test.mjs", "architecture/architecture.test.mjs", "architecture/architecture-recorded-failures.test.mjs", "architecture/architecture-deferred-verification.test.mjs", "architecture/architecture-confirmed-context.test.mjs", "requirements/requirement-calculation-integration.test.mjs", "requirements/requirement-consultation-history.test.mjs", "development/development-delivery.test.mjs",
    "development-executor.test.mjs", "development/development-fixture-integration.test.mjs", "development/development-integration.test.mjs", "development/development-artifacts.test.mjs", "development/development-file-tools.test.mjs", "collaboration/groups-integration.test.mjs",
    "installation/installation.test.mjs", "collaboration/main-context-integration.test.mjs", "runtime/materials-runner.test.mjs", "agents/materials.test.mjs",
    "runtime/model-connection.test.mjs", "runtime/pi-runtime.test.mjs", "runtime/pi-session-state.test.mjs", "development/development-session-recovery.test.mjs", "build/prepare-package.test.mjs", "ui/rich-text-assets.test.mjs", "project-platform.test.mjs",
    "projects/project-script-runtime.test.mjs", "projects/projects.test.mjs", "installation/skills-boundaries.test.mjs",
  ]),
  // The build-view file also has two state checks, and is intentionally present in integration.
  browser: Object.freeze(["agents/agent-artifact-document.test.mjs", "agents/agent-build-view.test.mjs", "agents/agent-layout.test.mjs", "ui/sidebar-layout.test.mjs"]),
});

export function selectTestFiles(layer: string, availableFiles: Iterable<string>) {
  if (!Object.hasOwn(TEST_LAYERS, layer)) throw new Error("测试层必须是 unit、integration 或 browser");
  const available = [...new Set(availableFiles)].filter((name) => name.endsWith(".test.mjs")).sort();
  const known = new Set(Object.values(TEST_LAYERS).flat());
  const unclassified = available.filter((name) => !known.has(name));
  const selected = new Set(TEST_LAYERS[layer as keyof typeof TEST_LAYERS]);
  if (layer === "integration") for (const name of unclassified) selected.add(name);
  return { files: available.filter((name) => selected.has(name)), unclassified,
    missing: [...known].filter((name) => !available.includes(name)).sort() };
}

// 递归发现全部测试入口，以相对 test 根的完整路径标识；发现、分类、--list 与实际启动共用该集合。
export async function discoverTestFiles(): Promise<string[]> {
  const root = resolve(ROOT, "test");
  const files: string[] = [];
  const walk = async (relative: string) => {
    for (const entry of await readdir(resolve(root, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && (entry.name.endsWith(".test.mjs") || entry.name.endsWith(".test.mts")))
        files.push(child.replace(/\.test\.mts$/, ".test.mjs"));
    }
  };
  await walk("");
  return [...new Set(files)].sort();
}

export function testEnvironment(layer: string, source: NodeJS.ProcessEnv) {
  if (!Object.hasOwn(TEST_LAYERS, layer)) throw new Error("测试层必须是 unit、integration 或 browser");
  const env = { ...source };
  if (layer === "browser") env.NEUMA_REQUIRE_BROWSER_TESTS = "1";
  else { delete env.NEUMA_REQUIRE_BROWSER_TESTS; delete env.NEUMA_TEST_BROWSER; }
  return env;
}

async function main() {
  const [layer = "all", ...options] = process.argv.slice(2);
  if (options.some((option) => option !== "--list") || options.length > 1)
    throw new Error("用法：node scripts/run-tests.mjs <unit|integration|browser> [--list]");
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  if (!options.includes("--list") && !manifest.neumaBuild) {
    const { buildProject, execute } = await import("./build.mjs");
    const built = await buildProject();
    await execute(process.execPath, [resolve(built, "scripts/run-tests.mjs"), layer, ...options], { cwd: built });
    return;
  }
  if (!options.includes("--list")) {
    const { assertFreshBuild } = await import("./build.mjs");
    await assertFreshBuild(ROOT);
  }
  const available = await discoverTestFiles();
  const { files, unclassified, missing } = layer === "all"
    ? { files: available.filter((name) => name.endsWith(".test.mjs")).sort(), unclassified: [], missing: [] }
    : selectTestFiles(layer, available);
  if (unclassified.length) process.stderr.write(`未分类测试默认加入 integration，请更新 scripts/run-tests.mjs：${unclassified.join("、")}\n`);
  if (missing.length) process.stderr.write(`测试分类中的文件已不存在，请清理清单：${missing.join("、")}\n`);
  if (!files.length) throw new Error(`测试层 ${layer} 没有可运行的测试文件`);
  process.stdout.write(`测试层 ${layer}：${files.length} 个文件${options.includes("--list") ? "（仅列出）" : ""}\n`);
  if (options.includes("--list")) { for (const file of files) process.stdout.write(`test/${file}\n`); return; }
  const started = performance.now();
  const code = await new Promise<number>((done, reject) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files.map((file) => `test/${file}`)], {
      cwd: ROOT, env: layer === "all" ? process.env : testEnvironment(layer, process.env), stdio: "inherit", windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => done(exitCode ?? (signal === "SIGINT" ? 130 : 1)));
  });
  process.stdout.write(`测试层 ${layer} 耗时 ${((performance.now() - started) / 1000).toFixed(2)} 秒\n`);
  process.exitCode = code;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
