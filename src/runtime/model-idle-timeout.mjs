export const DEFAULT_MODEL_IDLE_TIMEOUT_MS = 90_000;

export function modelIdleTimeoutMs(config = {}) {
  const value = config.llmIdleTimeoutMs ?? config.llmTimeoutMs ?? DEFAULT_MODEL_IDLE_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    throw new TypeError("模型无响应等待时间必须为正整数毫秒");
  return value;
}

/** Watch transport inactivity, never the total duration or model response contents. */
export function withModelIdleTimeout(fetchImpl, { idleTimeoutMs = DEFAULT_MODEL_IDLE_TIMEOUT_MS, onDiagnostic } = {}) {
  modelIdleTimeoutMs({ llmIdleTimeoutMs: idleTimeoutMs });
  return async (input, init = {}) => {
    const external = init.signal ?? input?.signal;
    external?.throwIfAborted();
    const controller = new AbortController(), started = performance.now();
    let timer, reader, unreadErrorResponse, streamController, finished = false, firstResponseMs = null, lastDataMs = null;
    let chunkCount = 0, receivedBytes = 0;
    const cleanup = () => { clearTimeout(timer); external?.removeEventListener("abort", cancelled); };
    const finish = () => { finished = true; cleanup(); };
    const stop = (reason) => {
      if (finished) return;
      finish(); controller.abort(reason);
      try { streamController?.error(reason); } catch { /* The consumer may have already cancelled. */ }
      try { void (reader ? reader.cancel(reason) : unreadErrorResponse?.body?.cancel(reason))?.catch(() => {}); }
      catch { /* Cleanup must not delay cancellation. */ }
    };
    const cancelled = () => stop(external.reason);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const diagnostic = { phase: firstResponseMs === null ? "headers" : "body", idleTimeoutMs,
          elapsedMs: Math.round(performance.now() - started), firstResponseMs, lastDataMs, chunkCount, receivedBytes };
        const error = Object.assign(new Error(`NEUMA_MODEL_IDLE_TIMEOUT: 连续 ${idleTimeoutMs} 毫秒未收到模型响应数据`), {
          name: "TimeoutError", code: "NEUMA_MODEL_IDLE_TIMEOUT", reason: "idle_timeout", idleTimeoutMs, diagnostic,
        });
        try { void Promise.resolve(onDiagnostic?.(diagnostic)).catch(() => {}); } catch { /* Diagnostics do not control the request. */ }
        stop(error);
      }, idleTimeoutMs);
    };
    const wait = async (operation) => {
      controller.signal.throwIfAborted();
      let abort;
      try {
        return await Promise.race([Promise.resolve().then(() => {
          controller.signal.throwIfAborted(); return operation();
        }), new Promise((_, reject) => {
          abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener("abort", abort, { once: true });
          if (controller.signal.aborted) abort();
        })]);
      } finally { controller.signal.removeEventListener("abort", abort); }
    };
    external?.addEventListener("abort", cancelled, { once: true });
    reset();
    try {
      const response = await wait(() => fetchImpl(input, { ...init, signal: controller.signal }));
      controller.signal.throwIfAborted();
      firstResponseMs = Math.round(performance.now() - started);
      reset();
      const lazyErrorBody = response.ok === false;
      if (lazyErrorBody && (typeof response.text !== "function" || response.body === null)) { finish(); return response; }
      if (lazyErrorBody) {
        // Error consumers may discard the body without reading it. Only start body waiting on demand.
        clearTimeout(timer); unreadErrorResponse = response;
      } else if (!response.body?.getReader) {
        // Some injected transports provide only text(); real Fetch responses use the stream below.
        if (!response.body && !(response instanceof Response) && typeof response.text === "function") {
          return new Proxy(response, { get(target, key) {
            if (key === "text") return async () => {
              try { return await wait(() => target.text()); } finally { finish(); }
            };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          } });
        }
        finish(); return response;
      }
      if (!lazyErrorBody) reader = response.body.getReader();
      const body = new ReadableStream({
        start(value) { streamController = value; },
        async pull(value) {
          try {
            if (!reader) { reader = response.body.getReader(); reset(); }
            const next = await wait(() => reader.read());
            if (next.done) { finish(); value.close(); return; }
            if (next.value.byteLength > 0) {
              chunkCount++; receivedBytes += next.value.byteLength;
              lastDataMs = Math.round(performance.now() - started); reset();
            }
            value.enqueue(next.value);
          } catch (error) { stop(error); }
        },
        cancel(reason) { stop(reason); },
      }, { highWaterMark: 0 });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      stop(error); throw error;
    }
  };
}
