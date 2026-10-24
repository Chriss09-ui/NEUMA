import type { UnknownRecord } from "./json.mjs";
export interface MaterialDescriptor extends UnknownRecord { id: string; name: string; mimeType: string; kind: string; size: number; sha256: string; status: string; createdAt: string; parserVersion?: string; pageCount?: number | null | undefined; warnings?: string[] | undefined; visionPages?: number[] | undefined; sheetNames?: string[] | undefined }
export interface StoredMaterialDescriptor extends MaterialDescriptor { schemaVersion: 1; agentId: string }
export interface RawMaterial { path: string; name: string; mimeType: string; size: number }
export interface MaterialLocation { start: number; end: number; page?: number; slide?: number; sheet?: string; part?: string; lineStart?: number }
export interface MaterialImage { data: string; mimeType: string; width?: number; height?: number; page?: number | null; id?: string; part?: string; slides?: number[]; source?: string; pageCount?: number | null | undefined; warnings?: string[] | undefined }
export interface ParsedMaterial { text: string; locations: MaterialLocation[]; images: MaterialImage[]; status: string; pageCount?: number | null | undefined; warnings?: string[] | undefined; visionPages?: number[] | undefined; sheetNames?: string[] | undefined; truncated?: boolean; encoding?: string; width?: number; height?: number }
