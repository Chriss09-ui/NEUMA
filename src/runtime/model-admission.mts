/** Domain callbacks own policy and durable accounting; this owns dispatch ordering. */
export async function admitModelRequest({ signal, persist, check }: {
  signal?: AbortSignal | null | undefined;
  persist?: (() => unknown | Promise<unknown>) | undefined;
  check?: (() => unknown | Promise<unknown>) | undefined;
}): Promise<void> {
  signal?.throwIfAborted();
  await persist?.();
  signal?.throwIfAborted();
  await check?.();
  signal?.throwIfAborted();
}
