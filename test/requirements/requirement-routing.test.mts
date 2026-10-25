import {fixtureToolAt} from "../helpers/m7-test-boundaries.mjs";
import {objectFields} from "../../src/runtime/type-boundary.mjs";
import type {SessionEvent,SessionMessage} from "../../src/runtime/pi-port.mjs";
import type {ToolResult} from "../../src/contracts/tools.mjs";
interface RoutingRecord {options:PiSessionOptions;disposed:boolean;aborted:boolean;compaction?:boolean;payload?:unknown;stopReason?:string;release?:()=>void}
interface DriverInput {record:RoutingRecord;session:{messages:SessionMessage[]};submit:(value:unknown)=>Promise<ToolResult>;emit:(event:SessionEvent)=>void}
import type { PiSessionOptions } from "../../src/runtime/pi-port.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { classifyRequirementInput } from "../../src/main/requirement-routing.mjs";
import { ProviderError } from "../../src/requirements/core.mjs";
import type { UnknownRecord } from "../../src/contracts/json.mjs";

const deferred = () => { let resolve!:()=>void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const requirement = { agentId: "draft-one", status: "needs_input", lastQuestion: "希望交付什么形式的结果？",
  draft: { goal: { value: "整理用户的材料", source: "user" } }, consultation: { privateInternalRecord: "不可进入寻址输入" } };

function fixture(driver:(input:DriverInput)=>unknown|Promise<unknown>) {
  const records: RoutingRecord[] = [], progress: UnknownRecord[] = [];
  const sessionFactory = async (options: PiSessionOptions) => {
    const record:RoutingRecord = { options, disposed: false, aborted: false };
    let listener:((event:SessionEvent)=>void)|null|undefined;
    const session = { messages: [] as SessionMessage[], subscribe(fn:(event:SessionEvent)=>void) { listener = fn; return () => { listener = null; }; },
      setAutoCompactionEnabled(value:boolean) { record.compaction = value; },
      async prompt(text: string) {
        record.payload = JSON.parse(text);
        await driver({ record, session, submit: (value: unknown) => fixtureToolAt(options.customTools!,0).execute("route-call", value), emit: (event:SessionEvent) => listener?.(event) });
        session.messages.push({ role: "assistant", stopReason: record.stopReason ?? "stop" });
      },
      async abort() { record.aborted = true; record.release?.(); }, dispose() { record.disposed = true; },
    };
    records.push(record); return session;
  };
  const route = (message:string, options:Partial<Parameters<typeof classifyRequirementInput>[0]> = {}) => classifyRequirementInput({ config: {}, cwd: "/unused-fixture", dataDir: "/unused-fixture",
    sessionFactory, message, requirement, onProgress: (event) => progress.push(event), ...options });
  return { route, records, progress };
}

test("需求寻址只有只读提交工具，原始消息与当前问题明确绑定，不读取协商内部记录", async () => {
  const f = fixture(async ({ record, submit }) => {
    assert.deepEqual(record.options.customTools!.map((tool) => tool.name), ["submit_requirement_route"]);
    assert.equal(record.options.maxOutputTokens, 1024);
    assert.equal(record.compaction, false);
    const receipt = await submit({ route: "continue", quote: "" });
    assert.equal(receipt.terminate, true);
  });
  const message = "给我一份清单，保存成文件。";
  assert.equal(await f.route(message), "continue");
  assert.deepEqual(f.records[0]!.payload, { currentUserMessage: message, currentRequirement: {
    agentId: requirement.agentId, status: requirement.status, lastQuestion: requirement.lastQuestion, draft: requirement.draft,
  } });
  assert.doesNotMatch(JSON.stringify(f.records[0]!.payload), /privateInternalRecord|不可进入寻址输入/);
  assert.equal(f.records[0]!.disposed, true);
  assert.ok(f.progress.every((event) => event.type === "status"), "寻址不把内部文字当作业务回答输出");
});

test("新建和离开必须引用真实本轮原话，伪造或空引用不能切换", async () => {
  for (const route of ["new", "outside"]) {
    const f = fixture(async ({ submit }) => {
      for (const quote of ["", " ", "历史里曾说过的离开指令", "x".repeat(801)])
        await assert.rejects(submit({ route, quote }), /原话短句/);
      await submit({ route, quote: route === "new" ? "创建另一个助手" : "先暂停创建" });
    });
    assert.equal(await f.route(route === "new" ? "保留刚才的草稿，创建另一个助手。" : "先暂停创建，我要看看群任务。"), route);
    assert.equal(f.records[0]!.disposed, true);
  }
});

test("长材料后的明确切换可以引用短句，不要求复制整段材料", async () => {
  const quote = "先暂停创建，我要看另外的群任务。", message = "材料原文。".repeat(1800) + quote;
  const f = fixture(async ({ record, submit }) => {
    assert.equal(objectFields(objectFields(objectFields(record.options.customTools![0]!.parameters).properties).quote).maxLength, 800);
    await submit({ route: "outside", quote });
  });
  assert.ok(message.length > 800);
  assert.equal(await f.route(message), "outside");
});

test("只有自然语言回答而没有有效提交，不能替代需求寻址", async () => {
  const f = fixture(async () => {});
  await assert.rejects(f.route("补充要求"), (error) => error instanceof ProviderError && error.diagnostic.reason === "requirement_routing_failed");
  assert.equal(f.records[0]!.disposed, true);
});

test("寻址最多两轮，连续无有效提交会停止且保留独立失败原因", async () => {
  const f = fixture(async ({ emit, record }) => {
    emit({ type: "turn_end" }); assert.equal(record.aborted, false);
    emit({ type: "turn_end" }); assert.equal(record.aborted, true);
  });
  await assert.rejects(f.route("补充要求"), (error) => error instanceof ProviderError && error.diagnostic.reason === "routing_budget");
  assert.equal(f.records.length, 1); assert.equal(f.records[0]!.disposed, true);
});

test("取消寻址会中断会话并释放资源，不能迟到切换需求", async () => {
  const started = deferred(), controller = new AbortController();
  const f = fixture(async ({ record, submit }) => {
    await new Promise<void>((resolve) => { record.release = resolve; started.resolve!(); });
    await assert.rejects(submit({ route: "outside", quote: "暂停创建" }), { name: "AbortError" });
  });
  const pending = f.route("暂停创建", { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await started.promise; controller.abort(); await rejected;
  assert.equal(f.records[0]!.aborted, true); assert.equal(f.records[0]!.disposed, true);
  const before = fixture(async () => assert.fail("预先取消不能创建模型会话"));
  await assert.rejects(before.route("继续", { signal: controller.signal }), { name: "AbortError" });
  assert.equal(before.records.length, 0);
});
