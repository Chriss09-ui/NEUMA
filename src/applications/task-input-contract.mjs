import { InputError } from "../requirements/core.mjs";
import { APPLICATION_TASK_INPUT_BYTES } from "../runtime/runtime-capability-contract.mjs";

export function validateApplicationTaskEnvelope(value) {
  let source;
  try { source = JSON.stringify(value); } catch { throw new InputError("应用数据必须是 JSON"); }
  if (!source || Buffer.byteLength(source) > APPLICATION_TASK_INPUT_BYTES) throw new InputError("应用数据超过大小限制");
  return JSON.parse(source);
}
