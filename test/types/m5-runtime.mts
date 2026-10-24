import type { ConnectionConfiguration, ConnectionOperation } from "../../src/contracts/connection.mjs";
import type { ServiceManifest } from "../../src/contracts/service.mjs";
import type { DeliveryRecord } from "../../src/services/service-port.mjs";
import { httpCall } from "../../src/connections/http-adapter.mjs";
import { MCPAdapter } from "../../src/connections/mcp-adapter.mjs";
import { serviceDelivery } from "../../src/services/service-records.mjs";
import { validateServiceManifest } from "../../src/services/service-contract.mjs";

// Compile-only counterexamples keep raw protocol data at its validating boundary.
export function checkedRuntimeInputs(raw: unknown, connection: ConnectionConfiguration, operation: ConnectionOperation) {
  // @ts-expect-error Disk JSON cannot become a delivery without validating its record.
  const delivery: DeliveryRecord = raw;
  // @ts-expect-error HTTP operation inputs must be object envelopes, not unknown values.
  void httpCall(connection, operation, raw);
  // @ts-expect-error MCP operation inputs must be object envelopes, not unknown values.
  void new MCPAdapter().call(connection, operation, raw);
  // @ts-expect-error An unverified model response is not an executable service manifest.
  const manifest: ServiceManifest = raw;
  void delivery; void manifest;
  const validated: ServiceManifest = validateServiceManifest(raw);
  const checked: DeliveryRecord = serviceDelivery(raw);
  return { validated, checked };
}
