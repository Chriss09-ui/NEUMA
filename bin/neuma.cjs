#!/usr/bin/env node
"use strict";

const parts = process.versions.node.split(".").map(Number);
if (parts[0] < 22 || (parts[0] === 22 && parts[1] < 19)) {
  process.stderr.write("NEUMA 需要 Node.js 22.19 或更新版本，请先更新 Node.js。\n");
  process.exitCode = 1;
} else {
  import("../installation-cli.mjs").then(({ runCli }) => runCli()).catch(() => {
    process.stderr.write("NEUMA 启动失败，请检查安装是否完整。\n");
    process.exitCode = 1;
  });
}
