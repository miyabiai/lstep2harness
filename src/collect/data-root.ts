import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const toolRoot = fileURLToPath(new URL("../../", import.meta.url));
const platformRoot = process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
  : process.platform === "win32" ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
    : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
// 空欄（設定例のまま）は未指定として扱う
const configuredRoot = process.env.LSTEP2HARNESS_DATA_DIR?.trim() || undefined;
if (configuredRoot && (!isAbsolute(configuredRoot) || [resolve("/"), homedir(), resolve(toolRoot)].includes(resolve(configuredRoot)))) {
  throw new Error("LSTEP2HARNESS_DATA_DIRにはツール専用の保存先を指定してください");
}

/** 取得内容と照合記録の保存先。LSTEP2HARNESS_DATA_DIR があればそこ、なければ OS のアプリ用データ領域。 */
export const DATA_ROOT = configuredRoot ?? join(platformRoot, "lstep2harness");
