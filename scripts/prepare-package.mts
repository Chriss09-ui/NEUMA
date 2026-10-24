import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildProject, checkSourceLocks, SOURCE_ROOT } from "./build.mjs";

export async function preparePackage(root = SOURCE_ROOT) {
  await checkSourceLocks(root, { synchronize: true });
  return buildProject({ root });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  preparePackage().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
