/** The locked CommonJS package ships no declarations; these are its three consumed APIs. */
declare module "semver" {
  interface Semver {
    satisfies(version: string, range: string): boolean;
    validRange(range: string): string | null;
    maxSatisfying(versions: readonly string[], range: string): string | null;
  }
  const semver: Semver;
  export default semver;
}
