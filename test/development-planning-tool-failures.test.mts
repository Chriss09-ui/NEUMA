import { objectFields } from "../src/runtime/type-boundary.mjs";
import { callFixture, recordArray, toolText } from "./helpers/m7-test-boundaries.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, link, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import { AgentStorage } from "../src/agents/agent-storage.mjs";
import { hashValue } from "../src/development/development-contract.mjs";
import { developmentSessionBinding, projectDevelopmentPlanningToolFailures, readDevelopmentPlanningToolFailures,
  validatedDevelopmentPlanningToolFailures, PLANNING_TOOL_FAILURE_MAX_BYTES } from "../src/development/development-sessions.mjs";
import { piSessionManager, readPiBoundSession, PI_READ_ONLY_SESSION_MAX_BYTES } from "../src/runtime/pi-session-state.mjs";
import { developmentRevisionReference, developmentRevisionContext, developmentRevisionReadTool,
  DEVELOPMENT_REVISION_MAX_BYTES } from "../src/architecture/architecture-development-revision.mjs";

const prefix = "草稿用例尚不符合已保存骨架，原文件未修改：";
const metadata = { id: "r_envelope_measure", acceptanceId: "acc_task_framing_capacity_envelope_measure",
  taskId: "task_input", actionId: "compute", kind: "input-rejection", inputTarget: "task-envelope" };
const issue = () => ({ path: "planningFiles.cases[0].kind", reason: "input_rejection_not_rejected",
  source: { path: "cases/boundary.json", localIndex: 0, caseId: metadata.id },
  remedy: "当前正式任务信封序列化为448字节，上限131072字节，尚未超过大小限制；该目标只检查正式任务信封，不执行业务校验。主动核对目标与夹具，不缩小要求或改变原断言。" });
type ProposedCase = typeof metadata & { input?: string; assertions?: string[]; mocks?: string[] };
type CallBlock = { type: "toolCall"; id: string; name: string; arguments: { path: string; cases: ProposedCase[] } };
type ThinkingBlock = { type: "thinking"; thinking: string };
const assistant = (callId: string): { role: "assistant"; content: [ThinkingBlock, CallBlock, ...{ type: "unknown" }[]]; timestamp: number } => ({ role: "assistant", content: [{ type: "thinking", thinking: "SYNTHETIC_PRIVATE_THOUGHT" },
  { type: "toolCall", id: callId, name: "save_plan_cases", arguments: { path: "cases/boundary.json",
    cases: [{ ...metadata, input: "PRIVATE_INPUT", assertions: ["PRIVATE_ASSERTIONS"], mocks: ["PRIVATE_MOCKS"] }] } }],
  timestamp: 1 });
const reply = (callId: string, issues: ReturnType<typeof issue>[] = [issue()]) => ({ role: "toolResult", toolName: "save_plan_cases", toolCallId: callId,
  isError: true, content: [{ type: "text", text: prefix + JSON.stringify({ saved: false, issues }) }], timestamp: 2 });

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "neuma-planning-failures-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new AgentStorage({ dataDir: join(root, "data") });
  await storage.ready;
  const architecture = { requirements: [{ id: "req_input" }], platformHash: "fixed-platform", runtimeCapabilities: {}, sourceFingerprint: "fixed-source" };
  const record = { agentId: "failure_agent", id: "failure_run", version: 1, revision: 1,
    architecture, architectureRef: { version: 1, candidateHash: "a".repeat(64) }, phase: "planning", status: "failed", delivery: "blocked",
    summary: "规划尚未提交", plan: null, planHash: null, package: null, tasks: [], deliveries: [], reviews: [], reports: [], sessions: {} as Record<string, {bindingHash:string;role:string;file:string;turns:number}> };
  const binding = developmentSessionBinding(record, "planner", { previousPlanHash: null }), key = hashValue(binding);
  const directory = await storage.directory(record.agentId, `development/sessions/${record.id}/${key}`, { create: true });
  const cwd = await storage.directory(record.agentId, `development/workspaces/${record.id}/code`, { create: true });
  const native = await piSessionManager(sdk, { cwd, storage: { directory, binding } });
  native.manager.appendMessage({ role: "user", content: "仅合成本地会话", timestamp: 0 });
  record.sessions[key] = { bindingHash: key, role: "planner", file: basename(native.manager.getSessionFile()!), turns: 2 };
  const options = { cwd, storage: { directory, binding, file: record.sessions[key].file } };
  const file = join(directory, options.storage.file);
  const add = (callId: string, issues?: Parameters<typeof reply>[1]) => { callFixture(native.manager.appendMessage, native.manager, [assistant(callId)]); return callFixture(native.manager.appendMessage, native.manager, [reply(callId, issues)]); };
  return { root, storage, record, binding, key, native, cwd, directory, options, file, add };
}

test("原生只读提取绑定planner失败，保留公开字节诊断与精确验收引用，不复制正文或改文件", async (t) => {
  const f = await fixture(t), entryId = f.add("call-one"), before = await readFile(f.file), beforeStat = await stat(f.file), recordHash = hashValue(f.record);
  const projection = await readDevelopmentPlanningToolFailures(f.storage, f.record); assert.ok("failures" in projection);
  assert.equal(projection.status, "available"); assert.equal(projection.current, false); assert.equal(projection.trust, "untrusted-reference");
  assert.equal(projection.source!.recordHash, recordHash); assert.equal(projection.source!.bindingHash, f.key);
  assert.match(projection.source!.sessionHash!, /^[a-f0-9]{64}$/u); assert.equal(projection.source!.leafId, entryId);
  assert.deepEqual(projection.failures[0]!.issues[0]!.proposedCaseRef, metadata);
  assert.equal(projection.failures[0]!.issues[0]!.remedy, issue().remedy); assert.equal(objectFields(projection.failures[0]!.issues[0]).measurement, undefined);
  assert.equal(projection.bytes, Buffer.byteLength(JSON.stringify(projection)));
  assert.doesNotMatch(JSON.stringify(projection), /SYNTHETIC_PRIVATE_THOUGHT|PRIVATE_INPUT|PRIVATE_ASSERTIONS|PRIVATE_MOCKS|thinking|sessions|budgets/u);
  assert.deepEqual(await readFile(f.file), before); assert.equal(hashValue(f.record), recordHash);
  const afterStat = await stat(f.file);
  for (const key of ["size", "mtimeMs", "ctimeMs", "mode", "ino"] as const) assert.equal(afterStat[key], beforeStat[key], key);
  assert.deepEqual(validatedDevelopmentPlanningToolFailures(projection, f.record), projection);
});

test("只采用当前原生分支最近四条失败，兄弟分支不泄漏且完整计数遗漏", async (t) => {
  const f = await fixture(t), root = f.native.manager.getLeafId();
  f.add("sibling"); f.native.manager.branch(root!);
  const entries = [];
  for (let index = 0; index < 6; index++) entries.push(f.add(`current-${index}`));
  const projection = await readDevelopmentPlanningToolFailures(f.storage, f.record); assert.ok("failures" in projection);
  assert.equal(projection.status, "available"); assert.equal(projection.omittedFailures, 2);
  assert.deepEqual(projection.failures.map((row) => row.entryId), entries.slice(-4));
  assert.doesNotMatch(JSON.stringify(projection), /sibling/u);
});

test("投影不触发thinking、未知块及用例输入/断言/替身访问器", async (t) => {
  const f = await fixture(t); f.add("guarded");
  const source = (await readDevelopmentPlanningToolFailures(f.storage, f.record)).source!, message = assistant("guarded"), unknown = { type: "unknown" as const };
  let touched = 0;
  const forbidden = () => { touched++; throw new Error("PRIVATE_FIELD_READ"); };
  Object.defineProperty(message.content[0], "thinking", { get: forbidden });
  Object.defineProperty(unknown, "text", { get: forbidden }); message.content.push(unknown);
  const proposed = message.content[1]!.arguments!.cases[0];
  for (const key of ["input", "assertions", "mocks"]) Object.defineProperty(proposed, key, { get: forbidden });
  Object.defineProperty(message, "thinking", { get: forbidden });
  const branch = [{ type: "message", id: "assistant", message }, { type: "message", id: "result", message: reply("guarded") }];
  const projection = projectDevelopmentPlanningToolFailures({ getBranch: () => branch }, source); assert.ok("failures" in projection);
  assert.equal(projection.status, "available"); assert.equal(touched, 0);
  assert.deepEqual(projection.failures[0]!.issues[0]!.proposedCaseRef, metadata);
  for (const target of ["content", "cases"]) {
    const guarded = assistant("guarded"), array = target === "content" ? guarded.content : guarded.content[1]!.arguments!.cases;
    Object.defineProperty(array, "0", { get: forbidden });
    const outcome = projectDevelopmentPlanningToolFailures({ getBranch: () => [{ type: "message", id: "a", message: guarded },
      { type: "message", id: "b", message: reply("guarded") }] }, source);
    assert.equal(outcome.status, "unavailable"); assert.equal(touched, 0);
  }
  const tampered = structuredClone(projection);
  Object.defineProperty(tampered.failures, "0", { get: forbidden });
  assert.equal(validatedDevelopmentPlanningToolFailures(tampered, f.record).status, "unavailable"); assert.equal(touched, 0);
});

test("工具调用/回执歧义和用例source失配明确拒绝，不改号或猜测验收", async (t) => {
  const f = await fixture(t); f.add("same");
  const source = (await readDevelopmentPlanningToolFailures(f.storage, f.record)).source!;
  type Row = { type: string; id: string; message: ReturnType<typeof assistant> | ReturnType<typeof reply> };
  const entries = (): Row[] => [{ type: "message", id: "a", message: assistant("same") }, { type: "message", id: "b", message: reply("same") }];
  for (const mutate of [
    (rows: Row[]) => rows.push({ type: "message", id: "c", message: assistant("same") }),
    (rows: Row[]) => rows.push({ type: "message", id: "c", message: reply("same") }),
    (rows: Row[]) => rows.reverse(),
  ]) {
    const rows = entries(); mutate(rows);
    assert.equal(objectFields(projectDevelopmentPlanningToolFailures({ getBranch: () => rows }, source)).reason, "planning_tool_failure_ambiguous");
  }
  for (const mutation of [{ caseId: "another" }, { localIndex: 1 }, { path: "cases/another.json" }]) {
    const rows = entries(), wrong = issue(); Object.assign(wrong.source, mutation); rows[1]!.message = reply("same", [wrong]);
    assert.equal(objectFields(projectDevelopmentPlanningToolFailures({ getBranch: () => rows }, source)).reason, "planning_tool_failure_case_reference_mismatch");
  }
});

test("非固定失败、非error及非法JSON不被当作planning_case_invalid证据", async (t) => {
  const f = await fixture(t); f.add("fixed"); const source = (await readDevelopmentPlanningToolFailures(f.storage, f.record)).source!;
  for (const patch of [{ isError: false }, { toolName: "another_tool" }, { content: [{ type: "text", text: "PRIVATE_API_ERROR" }] }]) {
    const rows = [{ type: "message", id: "a", message: assistant("fixed") }, { type: "message", id: "b", message: { ...reply("fixed"), ...patch } }];
    assert.equal(objectFields(projectDevelopmentPlanningToolFailures({ getBranch: () => rows }, source)).reason, "planning_tool_failures_missing");
  }
  for (const body of ["{", JSON.stringify({ saved: true, issues: [issue()] }), JSON.stringify({ saved: false, issues: [issue()], arbitrary: "private" })]) {
    const message = reply("fixed"); const part = message.content[0]!; assert.equal(part.type, "text"); if (part.type === "text") part.text = prefix + body;
    const result = projectDevelopmentPlanningToolFailures({ getBranch: () => [{ type: "message", id: "a", message: assistant("fixed") }, { type: "message", id: "b", message }] }, source);
    assert.equal(objectFields(result).reason, "planning_tool_failure_invalid");
  }
});

test("只读入口拒绝旧头、错误cwd/绑定、重复ID、环断链及被native跳过的坏行，原文件不变", async (t) => {
  const f = await fixture(t); f.add("validation"); const original = await readFile(f.file, "utf8"), entries = recordArray(sdk.parseSessionEntries(original));
  const variants: ((rows: Record<string, unknown>[]) => void)[] = [
    (rows) => { rows[0]!.version = Number(rows[0]!.version) - 1; },
    (rows) => { rows[0]!.cwd = join(f.root, "foreign"); },
    (rows) => rows.push({ ...rows[0] }),
    (rows) => { objectFields(rows.find((entry) => entry.type === "custom")!.data).bindingHash = "b".repeat(64); },
    (rows) => rows.push({ ...rows.find((entry) => entry.type === "custom"), id: "other-binding", parentId: rows.at(-1)!.id }),
    (rows) => { rows.at(-1)!.id = rows.at(-2)!.id; },
    (rows) => { rows.at(-1)!.parentId = rows.at(-1)!.id; },
    (rows) => { rows.at(-1)!.parentId = "missing"; },
    (rows) => { rows.at(-2)!.parentId = null; },
  ];
  for (const mutate of variants) {
    const rows = structuredClone(entries); mutate(rows); const changed = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(f.file, changed);
    await assert.rejects(readPiBoundSession(sdk, f.options)); assert.equal(await readFile(f.file, "utf8"), changed);
  }
  const malformed = original + "not-json\n"; await writeFile(f.file, malformed);
  await assert.rejects(readPiBoundSession(sdk, f.options), { reason: "session_file_invalid" });
  assert.equal(await readFile(f.file, "utf8"), malformed);
});

test("缺失/链接/超限文件和陈旧摘要不可用，不创建替代会话，不吞取消", async (t) => {
  const f = await fixture(t); f.add("bounded"); const initial = await readDevelopmentPlanningToolFailures(f.storage, f.record);
  await appendFile(f.file, "\n");
  assert.equal(objectFields(await readDevelopmentPlanningToolFailures(f.storage, f.record, { expectedSessionHash: initial.source!.sessionHash! })).reason, "session_changed");
  for (const [name, create] of [["linked.jsonl", () => symlink(f.file, join(f.directory, "linked.jsonl"))],
    ["hard.jsonl", () => link(f.file, join(f.directory, "hard.jsonl"))]] as const) {
    await create!(); await assert.rejects(readPiBoundSession(sdk, { ...f.options, storage: { ...f.options.storage, file: name } }), { reason: "session_file_invalid" });
    await rm(join(f.directory, name));
  }
  await assert.rejects(readPiBoundSession(sdk, { ...f.options, storage: { ...f.options.storage, file: "../outside.jsonl" } }), { reason: "session_reference_invalid" });
  await truncate(f.file, PI_READ_ONLY_SESSION_MAX_BYTES + 1);
  assert.equal(objectFields(await readDevelopmentPlanningToolFailures(f.storage, f.record)).reason, "session_size_limit");
  await rm(f.file); assert.equal(objectFields(await readDevelopmentPlanningToolFailures(f.storage, f.record)).reason, "planner_session_missing");
  await assert.rejects(stat(f.file), { code: "ENOENT" });
  const controller = new AbortController(); controller.abort(new Error("stopped"));
  await assert.rejects(readDevelopmentPlanningToolFailures(f.storage, f.record, { signal: controller.signal }), /stopped/u);
});

test("投影64KiB严格计UTF8，源绑定篡改不可继承，全部记录仍适用512KiB额度", async (t) => {
  const f = await fixture(t); f.add("limits"); const projection = await readDevelopmentPlanningToolFailures(f.storage, f.record); assert.ok("failures" in projection);
  const native = await readPiBoundSession(sdk, f.options), branch = native.manager.getBranch();
  const last = branch.at(-1), large = Array.from({ length: 30 }, () => ({ ...issue(), remedy: "中".repeat(1200) }));
  assert.ok(last && last.type === "message"); callFixture(Reflect.set, Reflect, [last, "message", reply("limits", large)]);
  assert.equal(objectFields(projectDevelopmentPlanningToolFailures({ getBranch: () => branch }, projection.source!)).reason, "planning_tool_failures_too_large");
  const changed = structuredClone(projection); changed.source!.runId = "another";
  assert.equal(objectFields(validatedDevelopmentPlanningToolFailures(changed, f.record)).reason, "planning_tool_failure_reference_invalid");
  assert.equal(objectFields(validatedDevelopmentPlanningToolFailures(projection, Object.assign({}, f.record, { revision: 2 }))).reason, "planning_tool_failure_reference_invalid");
  const reference = callFixture(developmentRevisionReference, undefined, [f.record, f.record.architecture, { planningToolFailures: projection }]);
  assert.equal(reference.status, "available"); assert.ok(reference.bytes! <= DEVELOPMENT_REVISION_MAX_BYTES);
  assert.deepEqual(reference.planningToolFailures, projection);
  assert.equal(objectFields(callFixture(developmentRevisionReference, undefined, [{ ...f.record, summary: "x".repeat(DEVELOPMENT_REVISION_MAX_BYTES) }, f.record.architecture, { planningToolFailures: projection }])).reason, "historical_reference_too_large");
  assert.ok(projection.bytes <= PLANNING_TOOL_FAILURE_MAX_BYTES);
});

test("首包完整保留最多四条失败摘要与验收元数据，完整诊断仍可精确分页", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 5; index++) f.add(`summary-${index}`, [issue(), { ...issue(), path: "planningFiles.cases[0].input" }]);
  const projection = await readDevelopmentPlanningToolFailures(f.storage, f.record); assert.ok("failures" in projection);
  const reference = callFixture(developmentRevisionReference, undefined, [f.record, f.record.architecture, { planningToolFailures: projection }]), context = developmentRevisionContext(reference);
  assert.equal(context.planningToolFailuresSummary!.failures!.length, 4); assert.equal(context.planningToolFailuresSummary!.omittedFailures, 1);
  for (const row of context.planningToolFailuresSummary!.failures!) {
    assert.equal(row.issueCount, 2);
  }
  assert.equal(context.planningToolFailuresSummary!.total, 1); assert.equal(context.planningToolFailuresSummary!.retained, 1);
  assert.equal(context.planningToolFailuresSummary!.issues![0]!.remedy, issue().remedy);
  assert.deepEqual(context.planningToolFailuresSummary!.issues![0]!.proposedCaseRef, metadata);
  const tool = developmentRevisionReadTool(reference), first = JSON.parse(toolText((await tool.execute("read", { section: "planningToolFailures", limit: 1000 }))));
  assert.ok(first.nextOffset > 0); let body = first.text, offset = first.nextOffset;
  while (offset !== null) {
    const page = JSON.parse(toolText((await tool.execute("read", { section: "planningToolFailures", offset, limit: 1000 }))));
    body += page.text; offset = page.nextOffset;
  }
  assert.deepEqual(JSON.parse(body), projection);
});

test("首包按独立问题去重保留第4项关键反证，含验收引用和完整公开remedy", async (t) => {
  const f = await fixture(t), cases = Array.from({ length: 4 }, (_, index) => ({ ...metadata,
    id: index === 3 ? metadata.id : `case_${index}`, acceptanceId: index === 3 ? metadata.acceptanceId : `acceptance_${index}` }));
  const proposal = assistant("four-issues"); proposal.content[1]!.arguments!.cases = cases;
  callFixture(f.native.manager.appendMessage, f.native.manager, [proposal]);
  const issues = cases.map((item, index) => ({ ...issue(), source: { path: "cases/boundary.json", localIndex: index, caseId: item.id },
    path: `planningFiles.cases[${index}].kind`, remedy: index === 3 ? issue().remedy : `公开错误${index}` }));
  callFixture(f.native.manager.appendMessage, f.native.manager, [reply("four-issues", issues)]);
  const projection = await readDevelopmentPlanningToolFailures(f.storage, f.record); assert.ok("failures" in projection);
  const summary = developmentRevisionContext(callFixture(developmentRevisionReference, undefined, [f.record, f.record.architecture, { planningToolFailures: projection }])).planningToolFailuresSummary;
  assert.equal(summary!.total, 4); assert.equal(summary!.retained, 4); assert.equal(summary!.omitted, 0);
  const envelope = summary!.issues!.find((row) => row.source!.caseId === metadata.id);
  assert.equal(envelope!.proposedCaseRef!.acceptanceId, metadata.acceptanceId); assert.equal(envelope!.remedy, issue().remedy);
  assert.equal(envelope!.toolCallId, "four-issues"); assert.equal(envelope!.entryId, projection.failures[0]!.entryId);
});
