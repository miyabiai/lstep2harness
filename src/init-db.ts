import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalD1 } from "./d1/local.js";

export const BOOTSTRAP_SCHEMA = fileURLToPath(new URL("../schema/line-harness-bootstrap.sql", import.meta.url));

/**
 * 移行の試験用データベースを新しく作る。L Harness と同じスキーマに、停止中の移行先アカウントを1つだけ入れる。
 * 認証情報はダミーなので、このデータベースから LINE へ送信されることはない。
 */
export function createTestDatabase(dbPath: string, lineAccountId: string, name = "移行の試験用（停止中）"): void {
  const path = resolve(dbPath);
  if (!lineAccountId.trim()) throw new Error("移行先アカウントIDを指定してください");
  if (existsSync(path)) throw new Error("指定したデータベースは既にあります。新しいファイル名を指定してください");
  // 既にあるフォルダ（作業フォルダなど）の権限は変えない。新しく作るフォルダだけ 0700 にする
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // 同時に作られても上書きしないよう、無いときだけ作る（wx）
  try { closeSync(openSync(path, "wx", 0o600)); }
  catch { throw new Error("指定したデータベースは既にあります。新しいファイル名を指定してください"); }
  const database = new LocalD1(path);
  try {
    database.loadSchema(BOOTSTRAP_SCHEMA);
    database.db.prepare("INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret,is_active) VALUES (?,?,?,?,?,0)")
      .run(lineAccountId.trim(), `test-channel-${lineAccountId.trim()}`, name, "not-a-live-token", "not-a-live-secret");
  } finally {
    database.close();
  }
}
