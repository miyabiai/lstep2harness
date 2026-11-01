import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { WranglerD1 } from "../d1/wrangler.js";
import { isHttpUrl, readJsonFile, writePrivateFile } from "../util.js";

/**
 * 本番の L Harness へのつなぎ先（秘密でない値）。`connect` が作り、migrate・apply・bridge などが読む。
 * 秘密（HARNESS_API_KEY・LINE_CHANNEL_SECRET・Cloudflare のトークン）は .env に置き、ここには書かない。
 */
export interface HarnessConnection {
  /** D1 データベース名（wrangler d1 execute に渡す） */
  d1_database_name: string;
  /** D1 データベース ID（並行運用ブリッジの設定に書く） */
  d1_database_id?: string;
  /** L Harness の Worker の URL（https://…） */
  harness_url?: string;
  /** L Harness の Worker 名（ブリッジからのサービス連携に使う） */
  harness_worker_name?: string;
  /** wrangler を動かすフォルダ（L Harness の apps/worker）。無ければ今いる場所 */
  harness_worker_dir?: string;
  /** Cloudflare のアカウントID（複数アカウントにログインしているとき wrangler が迷わないように渡す） */
  cloudflare_account_id?: string;
  /** 移行先の line_accounts.id */
  line_account_id: string;
  /** 並行運用ブリッジの Worker 名 */
  bridge_worker_name?: string;
}

export const CONNECTION_FILE = "lstep2harness.config.json";

export function connectionPath(cwd = process.cwd()): string {
  return resolve(cwd, CONNECTION_FILE);
}

export function loadConnection(cwd = process.cwd()): HarnessConnection {
  const connection = readJsonFile<HarnessConnection>(connectionPath(cwd));
  if (!connection?.d1_database_name || !connection.line_account_id) {
    throw new Error(`本番の L Harness へのつなぎ先がありません（${CONNECTION_FILE}）。先に connect を実行してください`);
  }
  return connection;
}

export function saveConnection(connection: HarnessConnection, cwd = process.cwd()): void {
  writePrivateFile(connectionPath(cwd), JSON.stringify(connection, null, 2) + "\n");
}

/** wrangler に渡す Cloudflare の値（.env・環境変数にあるものとつなぎ先のアカウントID） */
export function cloudflareEnv(connection?: Pick<HarnessConnection, "cloudflare_account_id">, env = process.env): Record<string, string> {
  const vars: Record<string, string> = {};
  if (env.CLOUDFLARE_API_TOKEN) vars.CLOUDFLARE_API_TOKEN = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || connection?.cloudflare_account_id;
  if (accountId) vars.CLOUDFLARE_ACCOUNT_ID = accountId;
  return vars;
}

export function openD1(connection: Pick<HarnessConnection, "d1_database_name" | "harness_worker_dir" | "cloudflare_account_id">, local = false, env = process.env): WranglerD1 {
  // 環境変数の Cloudflare アカウントが、つなぎ先を決めたときと違えば止める（同じ名前の別のデータベースへ入れないため）
  const fromEnv = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (fromEnv && connection.cloudflare_account_id && fromEnv !== connection.cloudflare_account_id) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID（.env・環境変数）が、connect で決めたつなぎ先の Cloudflare アカウントと違います。どちらが正しいか確かめて、connect をやり直してください");
  }
  const cwd = connection.harness_worker_dir ? resolve(connection.harness_worker_dir) : undefined;
  if (cwd && !existsSync(cwd)) throw new Error(`L Harness の apps/worker が見つかりません: ${cwd}`);
  return new WranglerD1({ databaseName: connection.d1_database_name, cwd, remote: !local, env: cloudflareEnv(connection, env) });
}

/** 投入先の取り違えを止めるための名前（計画に記録し、apply で照らし合わせる） */
export function targetKey(connection: Pick<HarnessConnection, "d1_database_name" | "d1_database_id" | "cloudflare_account_id">, local = false): string {
  // 同じ名前の別のデータベース（別の Cloudflare アカウントなど）と取り違えないよう、分かるものは全部含める
  return [local ? "d1-local" : "d1", connection.cloudflare_account_id ?? "-", connection.d1_database_id ?? "-", connection.d1_database_name].join(":");
}

// ---- L Harness の導入フォルダから読む ----

export interface HarnessInstall {
  dir: string;
  workerUrl?: string;
  workerName?: string;
  d1DatabaseName?: string;
  d1DatabaseId?: string;
  accountId?: string;
  /** どこから読んだか（表示用） */
  source: string;
}

interface SavedConfig {
  workerUrl?: string;
  workerPublicUrl?: string;
  workerName?: string;
  projectName?: string;
  d1DatabaseName?: string;
  d1DatabaseId?: string;
  accountId?: string;
  cfAccountId?: string;
}

/** 探す順: 指定フォルダ → 今いるフォルダとその近く → ~/.line-harness（create-line-harness の既定の導入先） */
export function candidateDirs(explicit?: string, cwd = process.cwd(), home = homedir()): string[] {
  if (explicit) return [resolve(cwd, explicit)];
  const dirs = [cwd, resolve(cwd, ".."), resolve(cwd, "line-harness"), resolve(cwd, "line-harness-oss")];
  if (home) dirs.push(join(home, ".line-harness"));
  return [...new Set(dirs)];
}

export function findHarnessInstall(explicit?: string, cwd = process.cwd(), home = homedir()): HarnessInstall | null {
  for (const dir of candidateDirs(explicit, cwd, home)) {
    const hit = readHarnessInstall(dir);
    if (hit) return hit;
  }
  return null;
}

export function readHarnessInstall(dir: string): HarnessInstall | null {
  const configPath = join(dir, ".line-harness-config.json");
  const tomlPath = join(dir, "apps", "worker", "wrangler.toml");
  const fromToml = existsSync(tomlPath) ? parseWranglerToml(readFileSync(tomlPath, "utf8")) : null;
  if (existsSync(configPath)) {
    let saved: SavedConfig;
    try {
      saved = JSON.parse(readFileSync(configPath, "utf8")) as SavedConfig;
    } catch {
      saved = {};
    }
    // API キーなど秘密の値は読まない（.env に利用者が貼る）
    return {
      dir,
      workerUrl: saved.workerPublicUrl || saved.workerUrl || fromToml?.workerUrl,
      workerName: saved.workerName || saved.projectName || fromToml?.workerName,
      d1DatabaseName: saved.d1DatabaseName || fromToml?.d1DatabaseName,
      d1DatabaseId: saved.d1DatabaseId || fromToml?.d1DatabaseId,
      accountId: saved.cfAccountId || saved.accountId || fromToml?.accountId,
      source: configPath,
    };
  }
  if (fromToml && (fromToml.d1DatabaseName || fromToml.workerName)) return { dir, ...fromToml, source: tomlPath };
  return null;
}

/** wrangler.toml から必要な値だけ拾う（TOML として正式に読む。D1 の設定が複数あれば最初の1つだけ使い、名前と ID を別の設定から混ぜない） */
export function parseWranglerToml(text: string): Omit<HarnessInstall, "dir" | "source"> {
  const out: Omit<HarnessInstall, "dir" | "source"> = {};
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch {
    return out;
  }
  const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);
  const table = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
  out.workerName = str(doc.name);
  out.accountId = str(doc.account_id);
  const d1 = Array.isArray(doc.d1_databases) ? table(doc.d1_databases[0]) : {};
  out.d1DatabaseName = str(d1.database_name);
  out.d1DatabaseId = str(d1.database_id);
  const vars = table(doc.vars);
  out.workerUrl = str(vars.WORKER_PUBLIC_URL);
  if (!out.accountId) out.accountId = str(vars.CF_ACCOUNT_ID);
  if (out.workerUrl && !isHttpUrl(out.workerUrl)) delete out.workerUrl;
  for (const key of Object.keys(out) as Array<keyof typeof out>) if (out[key] === undefined) delete out[key];
  return out;
}
