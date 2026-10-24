import type { JsonStoragePort } from "../runtime/storage-port.mjs";
import type { ConnectionCredentials } from "../contracts/connection.mjs";
export interface ConnectionFile { data: Buffer; contentType?: string; name?: string }
export type ConnectionFileResolver = (reference: string, options: { signal?: AbortSignal | undefined }) => Promise<ConnectionFile>;
export interface VaultPort { put(agentId: string, value: unknown): Promise<string>; get(agentId: string, reference?: string): Promise<ConnectionCredentials> }
export interface CredentialStoragePort extends JsonStoragePort { dataDir?: string }
