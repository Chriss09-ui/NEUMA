/** Structural checks for data read from private stores; semantic gates stay in their owners. */
export type Check = (value: unknown) => boolean;
export const string: Check = (value) => typeof value === "string";
export const number: Check = (value) => typeof value === "number" && Number.isFinite(value);
export const boolean: Check = (value) => typeof value === "boolean";
export const optional = (check: Check): Check => (value) => value === undefined || check(value);
export const nullable = (check: Check): Check => (value) => value === null || check(value);
export const array = (check: Check): Check => (value) => Array.isArray(value) && value.every(check);
export const object = (fields: Record<string, Check>): Check => (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.entries(fields).every(([key, check]) => check(Reflect.get(value, key)));
export const oneOf = (...values: readonly unknown[]): Check => (value) => values.includes(value);
