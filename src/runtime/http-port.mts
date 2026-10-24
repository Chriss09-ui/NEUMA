import type { IncomingHttpHeaders } from "node:http";
import type { RawMaterial } from "../contracts/material.mjs";
import type { ProviderConfig } from "../requirements/requirement-provider-port.mjs";
export interface HttpRouteContext {
  request: HttpRequest; response: HttpResponse; address: URL; signal: AbortSignal;
  readBody(maxBytes?: number): Promise<Record<string, unknown>>;
  sendJson(response: HttpResponse, status: number, value: unknown): void;
}
export interface HttpRequest extends AsyncIterable<Buffer> {
  method?: string | undefined;
  url?: string | undefined;
  headers: IncomingHttpHeaders;
  destroy?(): unknown;
}
export interface HttpResponse {
  writableEnded?: boolean;
  destroyed?: boolean;
  headersSent?: boolean;
  writeHead(status: number, headers: Record<string, string | number | string[]>): unknown;
  write?(data: string | Uint8Array): unknown;
  end(data?: string | Uint8Array): unknown;
  flushHeaders?(): unknown;
  destroy?(): unknown;
  on?(event: "close", listener: () => void): unknown;
  removeListener?(event: "close", listener: () => void): unknown;
}
export type SendMaterial = (response: HttpResponse, file: RawMaterial, download: boolean, signal?: AbortSignal) => Promise<void>;
export type PublicFailure = (error: unknown, config: Partial<ProviderConfig>) => { status: number; payload: { error: string; diagnostic?: unknown; [key: string]: unknown } };
