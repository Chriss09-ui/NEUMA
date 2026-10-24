import type { IncomingMessage, ServerResponse } from "node:http";
import type { RawMaterial } from "../contracts/material.mjs";
import type { ProviderConfig } from "../requirements/requirement-provider-port.mjs";
export interface HttpRouteContext {
  request: IncomingMessage; response: ServerResponse; address: URL; signal: AbortSignal;
  readBody(maxBytes?: number): Promise<Record<string, unknown>>;
  sendJson(response: ServerResponse, status: number, value: unknown): void;
}
export type SendMaterial = (response: ServerResponse, file: RawMaterial, download: boolean, signal?: AbortSignal) => Promise<void>;
export type PublicFailure = (error: unknown, config: ProviderConfig) => { status: number; payload: { error: string; diagnostic?: unknown; [key: string]: unknown } };
