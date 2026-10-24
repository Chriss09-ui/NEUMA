export function activeApplicationResult(source: { id: string; name: string; draft: unknown }) {
  const architectureRef = { version: 2, candidateHash: "a".repeat(64) };
  const developmentRef = { id: "dev_active", codeHash: "b".repeat(64), planHash: "c".repeat(64) };
  const agent = { ...source, mode: "designed", status: "ready", revision: 2, architectureRef, developmentRef,
    execution: { kind: "node-action", buildId: developmentRef.id, codeHash: developmentRef.codeHash, entrypoint: "actions.mjs" } };
  const architecture = { agentId: source.id, name: source.name, draft: source.draft, ...architectureRef,
    sourceFingerprint: "d".repeat(64), status: "passed", delivery: "ready", issues: [] };
  const development = { id: developmentRef.id, agentId: source.id, architectureRef, status: "completed", phase: "packaging",
    delivery: "needs_connection", summary: "内部功能可用，本机接口待配置。", tasks: [], package: {
      codeHash: developmentRef.codeHash, planHash: developmentRef.planHash, entrypoint: "actions.mjs" } };
  const application = { deliveryVersion: `${developmentRef.id}:${developmentRef.codeHash}`, pageReady: false,
    manifest: { runtime: "node-action", entrypoint: "actions.mjs", page: null }, actions: [] };
  return JSON.parse(JSON.stringify({ agent, architecture, development, application, activeRuntime: { architecture, development, application } }));
}
