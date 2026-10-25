import { withModelIdleTimeout } from "../../src/runtime/model-idle-timeout.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { ApplicationTaskStore } from "../../src/applications/task-store.mjs";
import { domainValidators } from "../../src/runtime/domain-contract-ports.mjs";
import { readStoredObject } from "../../src/runtime/storage-port.mjs";
import type { AgentStoragePort, JsonStoragePort } from "../../src/runtime/storage-port.mjs";
import { validateApplicationManifest } from "../../src/applications/application-contract.mjs";

function storage(value: unknown): AgentStoragePort {
  return { ready: Promise.resolve(), async readJson() { return value; }, async writeJson() {},
    async agentIds() { return ["agent"]; }, async directory() { return "/unused"; },
    async jsonFiles() { return []; }, async removeFile() {}, async removeDirectory() {} };
}
test("未知磁盘数据不能被当作任务或状态版本消费，失败保留原记录", async () => {
  const malformed = { version: 1, agentId: "agent", tasks: [{ agentId: "agent", events: [], sequence: "0" }] };
  const original = structuredClone(malformed);
  const store = new ApplicationTaskStore({ storage: storage(malformed) });
  await assert.rejects(store.ready, /应用任务记录无效/);
  assert.deepEqual(malformed, original);
  const badState = { stateVersion: 1, version: "1", state: {} };
  const stateStorage = storage(badState); stateStorage.agentIds = async () => [];
  const stateStore = new ApplicationTaskStore({ storage: stateStorage });
  await assert.rejects(stateStore.getState("agent"), /应用状态记录无效/);
});
test("存储注入端口返回原始未知数据时先检查对象信封", async () => {
  const port: JsonStoragePort = { async readJson() { return "untrusted"; }, async writeJson() {} };
  await assert.rejects(readStoredObject(port, "agent", "record.json"), /存储记录格式无效/);
});
test("三组过渡契约端口复用正式校验，不把合法版本标签当作完整提交", () => {
  const spec = { version: 1, items: [] };
  assert.deepEqual(domainValidators.taskSpec(spec), spec);
  assert.throws(() => domainValidators.taskSpec({ ...spec, version: 2 }));
  assert.throws(() => domainValidators.architecture({ schemaVersion: 3 }));
  assert.throws(() => domainValidators.development({ schemaVersion: 3, runtime: "node-action" }));
});
test("应用标识的外部对象不能靠隐式字符串转换流入可信契约", () => {
  const manifest = { protocolVersion: 2, runtime: "node-action", entrypoint: "run.mjs", page: null, stateVersion: 1,
    evidenceIds: ["evidence"], actions: [{ id: { toString() { return "execute"; } }, title: "执行",
      inputSchema: { type: "string" }, outputSchema: { type: "string" }, connectionIds: [] }] };
  assert.throws(() => validateApplicationManifest(manifest), /动作标识或名称无效/);
});


test("Fetch输入按结构读取取消信号，兼容其他传输实现的Request对象", async () => {
  const controller = new AbortController(); controller.abort();
  // A fetch-compatible input can carry a signal without being an instance of the host Request class.
  const input = Object.assign(new URL("https://fixture.invalid"), { signal: controller.signal });
  let requests = 0;
  const wrapped = withModelIdleTimeout(async () => { requests++; return new Response("unused"); });
  await assert.rejects(wrapped(input), { name: "AbortError" });
  assert.equal(requests, 0);
});
