import { textWithinLimit } from "../runtime/text-length.mjs";

export interface Presentation { points: number; language: "unchanged" | "zh" | "en"; layout: "unchanged" | "ordered" | "unordered" | "table" }

export const boundedRevisionText = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && textWithinLimit(value, limit);

export function presentation(input: Record<string, unknown>): Presentation | null {
  if (!Number.isInteger(input.points) || typeof input.points !== "number"
    || input.points !== 0 && (input.points < 2 || input.points > 10)
    || input.language !== "unchanged" && input.language !== "zh" && input.language !== "en"
    || input.layout !== "unchanged" && input.layout !== "ordered" && input.layout !== "unordered" && input.layout !== "table"
    || !input.points && input.language === "unchanged" && input.layout === "unchanged") return null;
  return { points: input.points, language: input.language, layout: input.layout };
}

export function matchesFormat(output: string, format: Presentation) {
  if (format.language === "zh" && !/\p{Script=Han}/u.test(output) || format.language === "en" && !/[a-z]{2}/i.test(output)) return false;
  const lines = output.trim().split(/\r?\n/);
  if (format.layout === "table") {
    const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(cell => cell.trim());
    const divider = lines.findIndex(line => { const row = cells(line); return row.length >= 2 && row.every(cell => /^:?-{3,}:?$/.test(cell)); });
    if (divider < 1) return false;
    const columns = cells(lines[divider]!).length;
    if (cells(lines[divider - 1]!).length !== columns) return false;
    let rows = 0;
    for (const line of lines.slice(divider + 1)) {
      if (!line.includes("|")) break;
      if (cells(line).length !== columns) return false;
      rows++;
    }
    return rows > 0 && (!format.points || rows === format.points);
  }
  const ordered = lines.filter(line => /^\d{1,2}[.、)）][ \t]*\S/.test(line)).length;
  const unordered = lines.filter(line => /^[-*•][ \t]+\S/.test(line)).length;
  const entries = ordered + unordered;
  if (format.layout === "ordered" && (!ordered || unordered) || format.layout === "unordered" && (!unordered || ordered)) return false;
  return !format.points || entries === format.points;
}
