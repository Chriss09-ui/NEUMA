import type { ApplicationApi } from "../../public/ui-api-types.js";

/** Fail immediately if a scenario reaches an API method it did not arrange. */
export function applicationApiFixture(overrides: Partial<ApplicationApi> = {}): ApplicationApi {
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected application API call in this scenario"); };
  const unexpectedUrl = (): never => { throw new Error("Unexpected application artifact URL in this scenario"); };
  return { application: unexpected, open: unexpected, close: unexpected, getState: unexpected, saveState: unexpected,
    run: unexpected, tasks: unexpected, task: unexpected, artifactPreview: unexpected, artifactDownloadUrl: unexpectedUrl,
    downloadArtifact: unexpected, events: unexpected, cancel: unexpected, resumeTask: unexpected, services: unexpected,
    prepareService: unexpected, startService: unexpected, stopService: unexpected, restartService: unexpected,
    serviceLogs: unexpected, rollbackService: unexpected, gateway: unexpected, configureGateway: unexpected,
    revokeGateway: unexpected, materials: unexpected, connections: unexpected, saveConnection: unexpected,
    testConnection: unexpected, discoverConnection: unexpected, authorizeConnection: unexpected,
    connectionAuthorization: unexpected, cancelConnectionAuthorization: unexpected, connectionResult: unexpected,
    removeConnection: unexpected, ...overrides };
}
