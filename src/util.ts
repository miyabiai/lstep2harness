import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** あちこちで使う小さな道具（JSON ファイル・実行したユーザーだけが読める保存・URL 判定）。 */

/** JSON ファイルを読む。無ければ null。 */
export function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** 実行したユーザーだけが読み書きできるフォルダ（0700）を用意する。既にあれば権限だけ直す（Windows 等では何もしない）。 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* Windows 等 */
  }
}

/** 顧客データを含むファイルを実行したユーザーだけが読める権限（0600）で書く。上書きでも権限を直す。 */
export function writePrivateFile(path: string, data: string): void {
  writeFileSync(path, data, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows 等 */
  }
}

/** http:// か https:// で始まる文字列か */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

/** シェルにそのまま貼れるよう単引用符で囲む（$() やバッククォートを展開させない）。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
