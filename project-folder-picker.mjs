import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, normalize } from "node:path";
import { promisify } from "node:util";
import { InputError } from "./core.mjs";

const runFile = promisify(execFile);
const PICK_FOLDER = `try
  set selectedFolder to choose folder with prompt "选择要添加到 NUEMA 的项目文件夹"
  return POSIX path of selectedFolder
on error number -128
  return ""
end try`;

export function createProjectFolderPicker({ platform = process.platform, run = runFile, inspect = stat } = {}) {
  let selecting = false;
  return async ({ signal } = {}) => {
    signal?.throwIfAborted();
    if (platform !== "darwin") throw new InputError("当前系统暂不支持选择窗口，请手动填写项目路径。");
    if (selecting) throw new InputError("文件夹选择窗口已经打开，请先完成或取消当前选择。");
    selecting = true;
    try {
      const { stdout } = await run("/usr/bin/osascript", ["-e", PICK_FOLDER], {
        encoding: "utf8", maxBuffer: 16_384, timeout: 300_000, signal,
        env: { PATH: "/usr/bin:/bin", HOME: homedir(), LANG: "en_US.UTF-8" },
      });
      signal?.throwIfAborted();
      const selected = stdout.replace(/\r?\n$/, "");
      if (!selected) return { cancelled: true };
      if (!isAbsolute(selected) || selected.includes("\0")) throw new InputError("未能读取所选文件夹，请重新选择或手动填写路径。");
      const path = normalize(selected).replace(/\/$/, "") || "/";
      if (!(await inspect(path)).isDirectory()) throw new InputError("请选择项目所在的文件夹。");
      signal?.throwIfAborted();
      return { cancelled: false, path, name: basename(path) || path };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof InputError) throw error;
      throw new InputError("暂时无法打开文件夹选择器，请重试或手动填写项目路径。");
    } finally {
      selecting = false;
    }
  };
}
