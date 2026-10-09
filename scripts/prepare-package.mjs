import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
if (lock.name !== manifest.name || lock.version !== manifest.version || lock.packages?.[""]?.version !== manifest.version) {
  throw new Error("package.json 与锁文件版本不一致，请先修正后打包。");
}
await writeFile(new URL("npm-shrinkwrap.json", root), JSON.stringify(lock, null, 2) + "\n");
await mkdir(new URL("dist/", root), { recursive: true });
process.stdout.write("已从现有锁文件生成 npm-shrinkwrap.json；未下载或安装依赖。\n");
