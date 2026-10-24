import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

// Classify whole files. Files mixing doubles and real SDK/process execution belong in integration.
export const TEST_LAYERS = Object.freeze({
  unit: Object.freeze([
    "model-context.test.mjs", "architecture-model-context.test.mjs",
    "application-ui.test.mjs", "application-context-ui.test.mjs", "application-assistant-ui.test.mjs", "application-context.test.mjs", "web-capabilities.test.mjs", "agent-connections.test.mjs",
    "agent-api.test.mjs", "agent-attachments.test.mjs", "agent-avatar.test.mjs", "agent-conversations.test.mjs",
    "agent-details.test.mjs", "agent-library.test.mjs", "agent-runtime.test.mjs", "agent-scheduler.test.mjs",
    "agents-ui.test.mjs", "architecture-contract.test.mjs", "architecture-platform.test.mjs", "platform-contract.test.mjs", "architecture-research.test.mjs", "browser-selection.test.mjs",
    "architecture-review-progress.test.mjs", "architecture-reference-selectors.test.mjs", "architecture-native-finding-closure.test.mjs",
    "chat-ui.test.mjs", "rich-text.test.mjs", "collaboration-api.test.mjs", "collaboration-ui.test.mjs", "core.test.mjs",
    "development-api.test.mjs", "development-case-schema.test.mjs", "development-context.test.mjs", "development-contract.test.mjs", "development-diagnostics.test.mjs", "development-fixtures.test.mjs", "development-store.test.mjs",
    "development-ui.test.mjs", "development-workspace.test.mjs", "development.test.mjs", "input-framing.test.mjs", "group-question.test.mjs",
    "groups.test.mjs", "group-avatar.test.mjs", "group-messages.test.mjs", "group-conversations.test.mjs", "group-conversation-removal.test.mjs", "group-mentions.test.mjs", "group-mention-composer.test.mjs", "group-routing.test.mjs", "group-reply-protocol.test.mjs", "group-replies.test.mjs", "installation-migration.test.mjs", "isolation-native.test.mjs", "jev-connection.test.mjs",
    "main-agent.test.mjs", "main-context-focus.test.mjs", "main-materials.test.mjs", "main-requirements.test.mjs", "requirement-calculation-diagnostics.test.mjs", "requirement-calculations.test.mjs", "requirement-capacity-guidance.test.mjs", "requirement-platform-binding.test.mjs", "requirement-routing.test.mjs", "requirement-system-notes.test.mjs", "requirement-system-resume.test.mjs", "requirement-verification.test.mjs",
    "requirement-facts.test.mjs", "model-connection-api.test.mjs", "panel-resize.test.mjs", "preview-release.test.mjs", "project-diagnostics.test.mjs",
    "project-folder-picker.test.mjs", "project-inspection.test.mjs", "project-removal.test.mjs", "project-runtime.test.mjs",
    "project-script-plan.test.mjs", "project-view.test.mjs", "projects-ui.test.mjs", "providers.test.mjs",
    "release.test.mjs", "requirements-ui.test.mjs", "runtime-view.test.mjs", "server.test.mjs",
    "session-shutdown.test.mjs", "settings-ui.test.mjs", "settings.test.mjs", "shell.test.mjs",
    "select-menu.test.mjs", "skills-api.test.mjs", "skills-splitter.test.mjs", "skills-ui.test.mjs", "skills.test.mjs", "state.test.mjs", "task-spec-schema.test.mjs", "test-layers.test.mjs", "value-schema-rules.test.mjs",
  ]),
  integration: Object.freeze([
    "model-context-native.test.mjs",
    "application-store.test.mjs", "application-resources.test.mjs", "application-service.test.mjs", "input-framing-integration.test.mjs",
    "node-action.test.mjs", "application-delivery-integration.test.mjs", "dashboard-application-integration.test.mjs", "agent-web-runtime.test.mjs", "python-gateway-integration.test.mjs",
    "agent-attachments-api.test.mjs", "agent-build-view.test.mjs", "agent-collaboration-runtime.test.mjs",
    "agent-material-runtime.test.mjs", "agent-prototype.test.mjs", "agent-active-runtime.test.mjs", "agent-storage.test.mjs",
    "architecture-integration.test.mjs", "architecture.test.mjs", "architecture-recorded-failures.test.mjs", "architecture-deferred-verification.test.mjs", "architecture-confirmed-context.test.mjs", "requirement-calculation-integration.test.mjs", "requirement-consultation-history.test.mjs", "development-delivery.test.mjs",
    "development-executor.test.mjs", "development-fixture-integration.test.mjs", "development-integration.test.mjs", "development-artifacts.test.mjs", "development-file-tools.test.mjs", "groups-integration.test.mjs",
    "installation.test.mjs", "main-context-integration.test.mjs", "materials-runner.test.mjs", "materials.test.mjs",
    "model-connection.test.mjs", "pi-runtime.test.mjs", "pi-session-state.test.mjs", "development-session-recovery.test.mjs", "prepare-package.test.mjs", "rich-text-assets.test.mjs", "project-platform.test.mjs",
    "project-script-runtime.test.mjs", "projects.test.mjs", "skills-boundaries.test.mjs",
  ]),
  // The build-view file also has two state checks, and is intentionally present in integration.
  browser: Object.freeze(["agent-artifact-document.test.mjs", "agent-build-view.test.mjs", "agent-layout.test.mjs", "sidebar-layout.test.mjs"]),
});

export function selectTestFiles(layer, availableFiles) {
  if (!Object.hasOwn(TEST_LAYERS, layer)) throw new Error("测试层必须是 unit、integration 或 browser");
  const available = [...new Set(availableFiles)].filter((name) => name.endsWith(".test.mjs")).sort();
  const known = new Set(Object.values(TEST_LAYERS).flat());
  const unclassified = available.filter((name) => !known.has(name));
  const selected = new Set(TEST_LAYERS[layer]);
  if (layer === "integration") for (const name of unclassified) selected.add(name);
  return { files: available.filter((name) => selected.has(name)), unclassified,
    missing: [...known].filter((name) => !available.includes(name)).sort() };
}

export function testEnvironment(layer, source) {
  if (!Object.hasOwn(TEST_LAYERS, layer)) throw new Error("测试层必须是 unit、integration 或 browser");
  const env = { ...source };
  if (layer === "browser") env.NEUMA_REQUIRE_BROWSER_TESTS = "1";
  else { delete env.NEUMA_REQUIRE_BROWSER_TESTS; delete env.NEUMA_TEST_BROWSER; }
  return env;
}

async function main() {
  const [layer, ...options] = process.argv.slice(2);
  if (options.some((option) => option !== "--list") || options.length > 1)
    throw new Error("用法：node scripts/run-tests.mjs <unit|integration|browser> [--list]");
  const entries = await readdir(new URL("../test/", import.meta.url), { withFileTypes: true });
  const { files, unclassified, missing } = selectTestFiles(layer, entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  if (unclassified.length) process.stderr.write(`未分类测试默认加入 integration，请更新 scripts/run-tests.mjs：${unclassified.join("、")}\n`);
  if (missing.length) process.stderr.write(`测试分类中的文件已不存在，请清理清单：${missing.join("、")}\n`);
  if (!files.length) throw new Error(`测试层 ${layer} 没有可运行的测试文件`);
  process.stdout.write(`测试层 ${layer}：${files.length} 个文件${options.includes("--list") ? "（仅列出）" : ""}\n`);
  if (options.includes("--list")) { for (const file of files) process.stdout.write(`test/${file}\n`); return; }
  const started = performance.now();
  const code = await new Promise((done, reject) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files.map((file) => `test/${file}`)], {
      cwd: ROOT, env: testEnvironment(layer, process.env), stdio: "inherit", windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => done(exitCode ?? (signal === "SIGINT" ? 130 : 1)));
  });
  process.stdout.write(`测试层 ${layer} 耗时 ${((performance.now() - started) / 1000).toFixed(2)} 秒\n`);
  process.exitCode = code;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
