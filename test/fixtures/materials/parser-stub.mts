let source = "";
for await (const chunk of process.stdin) source += chunk;
const request: { ignoreTermination?: boolean; delay?: number; crash?: boolean; value?: unknown } = JSON.parse(source);
if (request.ignoreTermination) process.on("SIGTERM", () => {});
await new Promise((resolve) => setTimeout(resolve, request.delay ?? 10));
if (request.crash) process.exit(2);
process.stdout.write(JSON.stringify({ ok: true, result: { value: request.value } }));
