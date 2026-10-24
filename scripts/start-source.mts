import type { RequestHandlerOptions } from "../src/server.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runSourceApplication } from "../src/installation/installation-runtime.mjs";
import { createRequestHandler } from "../src/server.mjs";

export function sourceApplicationOptions(root: string): { root: string; createHandler(options: RequestHandlerOptions): ReturnType<typeof createRequestHandler> };
export function sourceApplicationOptions<T>(root: string, createHandler: (options: RequestHandlerOptions) => T): { root: string; createHandler(options: RequestHandlerOptions): T };
export function sourceApplicationOptions(root: string, createHandler: (options: RequestHandlerOptions) => unknown = createRequestHandler) {
  root = resolve(root);
  return { root, createHandler: (options: RequestHandlerOptions) => createHandler({ ...options, cwd: root }) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error("源码开发启动必须显式提供仓库根目录");
  await runSourceApplication(sourceApplicationOptions(process.argv[2]));
}
