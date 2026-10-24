import test from "node:test";
import assert from "node:assert/strict";
import { sourceApplicationOptions } from "../scripts/start-source.mjs";

test("源码启动显式传递仓库根与Agent cwd，数据和配置仍由原启动器传入", () => {
  let seen;
  const options = sourceApplicationOptions("/synthetic/source", (input) => { seen = input; return "handler"; });
  assert.equal(options.root, "/synthetic/source");
  assert.equal(options.createHandler({ dataDir: "/synthetic/source/.neuma", envPath: "/synthetic/source/.env" }), "handler");
  assert.deepEqual(seen, { dataDir: "/synthetic/source/.neuma", envPath: "/synthetic/source/.env", cwd: "/synthetic/source" });
});
