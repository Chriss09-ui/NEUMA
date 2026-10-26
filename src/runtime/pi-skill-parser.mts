import { dirname } from "node:path";
/** Skill catalog parsing uses the locked parser without exposing its runtime to the catalog. */
export async function parseRuntimeSkill(temporary: string, file: string, originalPath: string, signal?: AbortSignal) {
  const sdk = await import("@earendil-works/pi-coding-agent"); signal?.throwIfAborted();
  const result = sdk.loadSkills({ cwd: temporary, agentDir: temporary, skillPaths: [file], includeDefaults: false });
  return { skill: result.skills[0] ? { ...result.skills[0], filePath: originalPath, baseDir: dirname(originalPath),
    sourceInfo: sdk.createSyntheticSourceInfo(originalPath, { source: "catalog", baseDir: dirname(originalPath) }) } : null,
    diagnostics: result.diagnostics.map(item => ({ type: item.type, message: String(item.message).replaceAll(temporary, dirname(originalPath)) })) };
}
