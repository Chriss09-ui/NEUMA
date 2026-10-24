#!/usr/bin/env node
"use strict";

const parts = process.versions.node.split(".").map(Number);
const supported = parts[0]! >= 26 || (parts[0] === 24 && parts[1]! >= 15)
  || (parts[0] === 22 && (parts[1]! > 22 || (parts[1] === 22 && parts[2]! >= 2)));
if (!supported) {
  process.stderr.write("NEUMA 需要 Node.js 22.22.2+（22.x）、24.15+（24.x）或 26+，请先更新 Node.js。\n");
  process.exitCode = 1;
} else {
  import("../src/installation/installation-cli.mjs").then(({ runCli }) => runCli()).catch(() => {
    process.stderr.write("NEUMA 启动失败，请检查安装是否完整。\n");
    process.exitCode = 1;
  });
}
