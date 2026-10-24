import type { PortInfo, ProjectView } from "../src/contracts/project.mjs";
export type { ProjectView };
export interface ProjectAddition { id: string; name: string; status: string; cancelRequested?: boolean | undefined; progress?: string | undefined; description?: string | undefined; kind?: string | undefined; path?: string | undefined; setup?: ProjectView["setup"] | undefined; canStop?: boolean | undefined }
export interface RuntimeProject { id: string; name: string; path?: string | undefined; runtime?: { state: string; source?: string | undefined; reason?: string | undefined; ports?: number[] | undefined } | undefined }
export interface RuntimePorts extends PortInfo { projects?: RuntimeProject[] | undefined }
export interface RuntimeSnapshotView { projects: RuntimeProject[]; ports: RuntimePorts[]; summary: Record<string, string>; checkedAt: string; warnings?: string[] | undefined; error?: string | undefined }
