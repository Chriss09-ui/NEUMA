import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const [entrypoint, dependencyDirectory] = process.argv.slice(2);
const protocolWrite = process.stdout.write.bind(process.stdout);
const send = (value) => protocolWrite(JSON.stringify(value) + "\n");
// Application logging uses stderr so ordinary print statements cannot corrupt the channel.
console.log = (...args) => console.error(...args);
let active = null, sequence = 0, loaded;
const waiting = new Map();
const group = (name, methods) => Object.freeze(Object.fromEntries(methods.map((method) => [method, (args = {}) => {
  if (!active) return Promise.reject(new Error("request_finished"));
  const id = `call_${++sequence}`, requestId = active;
  return new Promise((resolve, reject) => { waiting.set(id, { requestId, resolve, reject }); send({ type: "call", requestId, id, capability: `${name}.${method}`, args }); });
}])));
const ctx = Object.freeze({ connection: group("connection", ["call", "readResult"]), state: group("state", ["get", "set"]),
  files: group("files", ["list", "read", "write"]), material: group("material", ["list", "read", "image"]),
  web: group("web", ["search", "fetch"]), model: group("model", ["call"]),
  progress: (value) => { if (active) send({ type: "progress", requestId: active, value }); },
  // Locked dependencies live outside generated sources. This also supports CommonJS packages.
  require: dependencyDirectory ? createRequire(pathToFileURL(`${dependencyDirectory}/package.json`)) : undefined });

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", async (line) => {
  try {
    const message = JSON.parse(line);
    if (message.type === "reply") {
      const call = waiting.get(message.id);
      if (!call || call.requestId !== message.requestId || active !== message.requestId) throw new Error("invalid_reply");
      waiting.delete(message.id);
      if (message.ok) call.resolve(message.value); else call.reject(Object.assign(new Error(message.error || "capability_failed"), { reason: message.reason || "capability_failed" }));
      return;
    }
    if (message.type === "health" && !active) { send({ type: "health", id: message.id, ok: true }); return; }
    if (message.type !== "run" || active || message.protocolVersion !== 1) throw new Error("invalid_request");
    active = message.requestId;
    loaded ??= await import(pathToFileURL(entrypoint).href);
    const action = loaded.actions && Object.hasOwn(loaded.actions, message.actionId) ? loaded.actions[message.actionId] : null;
    const value = typeof action === "function" ? await action(message.input, ctx)
      : typeof loaded.run === "function" ? await loaded.run({ actionId: message.actionId, input: message.input }, ctx)
        : (() => { throw new Error("unknown_action"); })();
    if (waiting.size) throw new Error("unfinished_capability_calls");
    send({ type: "result", requestId: active, ok: true, value: value === undefined ? null : value }); active = null;
  } catch (error) {
    const requestId = active; active = null;
    for (const call of waiting.values()) call.reject(new Error("request_failed")); waiting.clear();
    send({ type: "result", requestId, ok: false, error: "action_failed", reason: typeof error?.reason === "string" && /^[a-z_]{1,80}$/.test(error.reason) ? error.reason : "action_failed" });
  }
});
lines.on("close", () => process.exit(0));
try { loaded = await import(pathToFileURL(entrypoint).href); send({ type: "ready", protocolVersion: 1 }); }
catch { process.stderr.write("service_module_load_failed\n"); process.exit(1); }
