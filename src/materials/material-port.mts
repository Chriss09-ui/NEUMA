import type { AgentStoragePort } from "../runtime/storage-port.mjs";
import type { ParsedMaterial, MaterialImage } from "../contracts/material.mjs";
export type { MaterialDescriptor, RawMaterial, ParsedMaterial, MaterialImage } from "../contracts/material.mjs";
export interface ImageOptions { page?: unknown; imageId?: unknown; signal?: AbortSignal | undefined }
export interface MaterialUpload { name?: unknown; mimeType?: unknown; source?: Uint8Array | AsyncIterable<unknown> | undefined; signal?: AbortSignal | undefined }
export interface MaterialStoragePort extends Pick<AgentStoragePort, "directory" | "readJson" | "writeJson" | "removeDirectory"> { path(agentId: string, path: string, create?: boolean): Promise<string> }
export interface MaterialRequest { action: "parse" | "image"; path: string; name: string; mimeType: string; sha256: string; scratch: string; page?: number | undefined }
export type MaterialResult = ParsedMaterial | MaterialImage;
export interface MaterialRunnerPort { run(request: MaterialRequest, options?: { signal?: AbortSignal | undefined }): Promise<unknown>; close?(): Promise<unknown> }
