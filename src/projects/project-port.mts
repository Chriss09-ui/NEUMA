import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Server } from "node:http";
import type { ProjectRecord, ProjectSetup, ProjectView } from "../contracts/project.mjs";
import type { UnknownRecord } from "../contracts/json.mjs";
export interface ProjectChild extends EventEmitter { stdout: Readable | null; stderr: Readable | null; pid?: number | null | undefined; exitCode: number | null; signalCode: NodeJS.Signals | null; managedPids?: number[]; supervisor?: ChildProcess; jobManaged?: boolean; neumaClosed?: boolean; kill(signal?: NodeJS.Signals | number): boolean; stopTree?: () => Promise<void> }
export type ProjectSpawner = (command: string, args: string[], options: SpawnOptions) => ProjectChild | Promise<ProjectChild>;
export interface ProjectRun { status: string; url: string | null; child?: ProjectChild | null; server?: Server | null; background?: boolean; ownsService?: boolean; launcher?: ProjectChild; launcherExited?: boolean; launcherExitCode?: number | null; launcherDone?: Promise<void>; monitorController?: AbortController; monitorPromise?: Promise<void>; stopping?: boolean; startupFailed?: boolean; servicesReadyOnce?: boolean; stopFailed?: boolean; stopPromise?: Promise<unknown> | null; error?: string | null; pageOpened?: boolean; openError?: string | null; checkingPage?: boolean; openingPage?: Promise<void> | null; getPageUrl?: () => string | null; removalStopFailed?: boolean }
export interface ProjectInspectOptions { signal?: AbortSignal | undefined; instructions?: string | undefined; onProgress?: ((event: UnknownRecord) => void) | undefined }
export interface ProjectAnalyzer { (project: ProjectRecord, options: ProjectInspectOptions): Promise<Partial<ProjectRecord> & { setup: ProjectSetup }>; forget?(path: string): void; dispose?(): void }
export interface ProjectPending { controller: AbortController; pending?: Promise<ProjectView>; listeners?: Set<(event: UnknownRecord) => void> }
