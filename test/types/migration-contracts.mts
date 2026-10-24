import type { JsonValue } from "../../src/contracts/json.mjs";
import type { ApplicationTaskInput } from "../../src/contracts/application.mjs";
import type { ArchitectureDesignCheckpointVersion, DevelopmentPlanEnvelope, TaskSpecV1 } from "../../src/contracts/versions.mjs";
import type { PiSessionPort } from "../../src/runtime/pi-port.mjs";
import type { JsonStoragePort } from "../../src/runtime/storage-port.mjs";
import { validateActionInput } from "../../src/applications/application-contract.mjs";

// Compile-only counterexamples: an unused @ts-expect-error must fail typecheck too.
export function requireCheckedInput(raw: unknown): JsonValue {
  // @ts-expect-error External input cannot be assigned to a trusted task envelope.
  const task: ApplicationTaskInput = raw;
  void task;
  // @ts-expect-error A version-2 task specification cannot enter the version-1 protocol.
  const spec: TaskSpecV1 = { version: 2, items: [] };
  // @ts-expect-error Modern plans cannot silently use the legacy runtime.
  const plan: DevelopmentPlanEnvelope = { schemaVersion: 3, runtime: "node-json" };
  // @ts-expect-error Unknown checkpoint versions must not receive a current budget policy.
  const checkpoint: ArchitectureDesignCheckpointVersion = 4;
  void spec; void plan; void checkpoint;
  return validateActionInput({ inputSchema: { type: "string" } }, raw);
}
export async function requireStoredValidation(storage: JsonStoragePort) {
  const value = await storage.readJson("agent", "record.json");
  // @ts-expect-error Disk JSON remains unknown until its owning validator runs.
  return value.version;
}
// A cancellation/failure double implements only the port used by NEUMA.
export const sessionDouble = {
  async prompt() {}, async abort() {}, dispose() {}, subscribe() { return () => {}; },
  setAutoCompactionEnabled() {}, getLastAssistantText() { return undefined; }, messages: [],
} satisfies PiSessionPort;
