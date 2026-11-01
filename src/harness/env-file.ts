import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** 本番の L Harness へ移すときに .env に貼ってもらう値（値はこのツールが表示・記録しない） */
export const HARNESS_ENV_SLOTS: Array<{ key: string; note: string }> = [
  { key: "HARNESS_API_KEY", note: "L Harness の API キー（create-line-harness の完了画面の API Key）。リッチメニューの取り込み・アイコンの取り直しに使う" },
  { key: "LINE_CHANNEL_SECRET", note: "LINE Developers の Messaging API チャネルの「チャネルシークレット」。並行運用ブリッジだけで使う" },
  { key: "CLOUDFLARE_API_TOKEN", note: "（任意）wrangler login を使わずに D1 へ書き込むときだけ" },
  { key: "CLOUDFLARE_ACCOUNT_ID", note: "（任意）上と組で使う Cloudflare のアカウントID" },
];

/**
 * .env に、本番の L Harness 用の欄（空の値）を足す。既にある欄・値には触れない。
 * 無ければ本人だけが読める権限（0600）で作る。足した欄の名前を返す。
 */
export function ensureHarnessEnvSlots(cwd = process.cwd()): string[] {
  const path = resolve(cwd, ".env");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const present = new Set(text.split(/\r?\n/).map((line) => line.split("=")[0].trim()).filter(Boolean));
  const missing = HARNESS_ENV_SLOTS.filter((slot) => !present.has(slot.key));
  if (!missing.length) return [];
  const lines = missing.flatMap((slot) => [`# ${slot.note}`, `${slot.key}=`]);
  const prefix = text && !text.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${text}${prefix}${lines.join("\n")}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows 等 */
  }
  return missing.map((slot) => slot.key);
}
