export interface SkillDiagnostic { type: string; message: string }
export interface SkillSource { id: string; label: string; path: string; kind: string; readOnly: boolean; custom: boolean; exists: boolean; canImport: boolean }
export interface SkillLocation { id: string; path: string; sourceId: string; label: string; isLink: boolean; canRemoveLink: boolean; linkPath?: string }
export interface SkillSummary { id: string; name: string; description: string; filePath: string; baseDir: string; locations: SkillLocation[]; sources: { id: string; label: string }[]; diagnostics: SkillDiagnostic[]; readOnly: boolean; readOnlyReason: string | null; canEdit: boolean; canTrash: boolean; status: string }
export interface SkillTrashRecord { id: string; originalPath: string; storedPath: string; action: string; trashedAt: string; name: string; skillCount: number; status: string; restoredAt?: string }
