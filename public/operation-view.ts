export interface OperationReference { version: 1; domain: string; ownerId: string; operationId: string; generation: string }
export interface OperationView<T> { operation: OperationReference; cursor: string; changed: boolean; reset: boolean; snapshot: T | null }
export function pauseObservation(signal?: AbortSignal, ms = 750) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
/** Only observations repeat. Input submission and explicit cancellation have separate owners. */
export async function observeOperation<T>(read: (cursor?: string) => Promise<OperationView<T>>, reference: OperationReference,
  options: { signal?: AbortSignal | undefined; update(snapshot: T, reference: OperationReference): boolean; disconnected?: (() => void) | undefined }) {
  let cursor: string | undefined, failures = 0;
  while (true) {
    options.signal?.throwIfAborted();
    let view: OperationView<T>;
    try { view = await read(cursor); failures = 0; }
    catch (error) {
      options.signal?.throwIfAborted();
      if (++failures > 3) throw error;
      options.disconnected?.(); await pauseObservation(options.signal, 1000); continue;
    }
    options.signal?.throwIfAborted();
    if (["domain", "ownerId", "operationId", "generation"].some(key => Reflect.get(reference, key) !== Reflect.get(view.operation, key)))
      throw new Error("任务身份已变化，请重新加载。");
    if (view.cursor !== cursor && view.snapshot !== null && options.update(view.snapshot, view.operation)) return view.snapshot;
    cursor = view.cursor;
    await pauseObservation(options.signal);
  }
}
