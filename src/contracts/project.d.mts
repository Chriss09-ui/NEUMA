import type { UnknownRecord } from "./json.mjs";
export interface ProjectCommand { command: string; args: string[] }
export interface ProjectLaunch extends ProjectCommand { url: string | null; background?: boolean; stop?: ProjectCommand | null; healthUrls?: string[] }
export interface ProjectSetup { status: string; source?: string; summary: string; reason?: string; diagnostic?: { stage?: string; reason?: string; retries?: number; recordId?: string; recorded?: boolean } }
export interface ProjectRecord extends UnknownRecord { id: string; name: string; description: string; path: string; root: string; kind: string; entry?: string | null | undefined; scripts: string[]; launch: ProjectLaunch | null; allowLaunch: boolean; addedAt: string; setup?: ProjectSetup | undefined }
export interface ProjectView extends ProjectRecord { status: string; url: string | null; pageOpened: boolean; openingPage: boolean; openError: string | null; error: string | null; canLaunch: boolean; canStop: boolean }
export interface ProcessInfo { pid: number; ppid?: number; name: string; cwd?: string | undefined; exe?: string }
export interface PortInfo { address: string; port: number; protocol: string; pid: number | null; processName: string; cwd?: string }
export interface RuntimeSnapshot { checkedAt: string; ports: PortInfo[]; processes: ProcessInfo[]; warnings: string[]; complete: boolean }
