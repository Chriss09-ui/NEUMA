import type { SkillDiagnostic, SkillLocation, SkillSource, SkillSummary, SkillTrashRecord } from "../src/contracts/skill.mjs";
export type { SkillDiagnostic, SkillLocation, SkillSource, SkillSummary, SkillTrashRecord };
export interface SkillFile { path: string; type: string; size?: number | undefined }
export interface SkillDetail extends SkillSummary { content: string; revision: string; files?: SkillFile[] | undefined }
export interface SkillSnapshot { skills: SkillSummary[]; sources: SkillSource[]; warnings?: (string | SkillDiagnostic)[] | undefined; checkedAt: string }
export interface SkillImpact { targetPath?: string | undefined; path?: string | undefined; action?: string | undefined; skillCount?: number | undefined; skills?: (string | Partial<SkillSummary> & { path?: string | undefined })[] | undefined; aliases?: (string | { path?: string | undefined; label?: string | undefined })[] | undefined; diagnostics?: (string | { message: string })[] | undefined; revision: string; locationId?: string | undefined }
