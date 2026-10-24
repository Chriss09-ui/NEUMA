import type { SpawnOptions } from "node:child_process";

interface ProcessOutput {
  on(event: "data", listener: (bytes: Buffer | string) => void): unknown;
}
interface ProcessInput {
  on?(event: "error", listener: (error: Error) => void): unknown;
  write?(bytes: string): unknown;
  end?(bytes?: string): unknown;
}
/** The process operations used by the isolation executor and cleanup helper. */
export interface IsolationProcess {
  pid?: number | undefined;
  stdin?: ProcessInput | null;
  stdout?: ProcessOutput | null;
  stderr?: ProcessOutput | null;
  kill(signal?: NodeJS.Signals): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit" | "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}
export type IsolationSpawner = (command: string, args: readonly string[], options: SpawnOptions) => IsolationProcess;
