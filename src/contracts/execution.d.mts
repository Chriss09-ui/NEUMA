export interface ExecutionAttempt {
  version: 1; id: string; number: number; bindingHash: string;
  phase: "prepared" | "dispatched" | "completed";
  resultRef?: { sha256: string; path: string };
  resolution?: "verified" | "retry_approved";
  uncertain?: boolean;
}
export interface ExecutionDispatch { id: string; beforeDispatch(): Promise<void>; markUnknown(): Promise<void> }
