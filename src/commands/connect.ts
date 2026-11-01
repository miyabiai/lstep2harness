import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertHarnessPlatform, WRANGLER_VERSION } from "../d1/wrangler.js";
import { HarnessApi, HarnessApiError } from "../harness/api.js";
import type { HarnessDatabase } from "../harness/database.js";
import { connectionPath, findHarnessInstall, openD1, saveConnection, type HarnessConnection } from "../harness/connection.js";
import { ensureHarnessEnvSlots } from "../harness/env-file.js";
import { quote } from "../sql/render.js";

/**
 * 本番の L Harness へのつなぎ先を決めて lstep2harness.config.json に書く。L Harness には書き込まない。
 * create-line-harness の導入フォルダ（既定 ~/.line-harness）から D1・Worker の値を読み、
 * D1 の line_accounts から移行先アカウントを選ぶ（1つならそれ、複数なら --line-account-id で選ぶ）。
 */
export interface ConnectOptions {
  harnessDir?: string;
  d1?: string;
  harnessUrl?: string;
  lineAccountId?: string;
  local?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ConnectSummary {
  step: "connected";
  config: string;
  database: string;
  harnessUrl: string | null;
  account: { id: string; name: string; isActive: boolean; friends: number };
  /** HARNESS_API_KEY の確認結果（リッチメニュー・プロフィールの取り直しに使う） */
  apiKey: "ok" | "missing" | "rejected" | "unreachable" | "no-url" | "mismatch";
  /** 移行の後に要る値で .env に無いもの */
  missingSecrets: string[];
  /** .env に足した空の欄（利用者に開いて値を貼ってもらう） */
  addedEnvSlots: string[];
}

export interface ConnectDependencies {
  openDatabase?: (connection: HarnessConnection, local: boolean) => HarnessDatabase;
  fetchImpl?: typeof fetch;
}

interface AccountRow { id: string; name: string; is_active: number; friends: number }

export async function runConnect(options: ConnectOptions, dependencies: ConnectDependencies = {}): Promise<ConnectSummary> {
  if (!dependencies.openDatabase) assertHarnessPlatform();
  const env = options.env ?? process.env;
  const install = findHarnessInstall(options.harnessDir, options.cwd);
  if (options.harnessDir && !install) throw new Error(`L Harness の導入フォルダを読めませんでした: ${options.harnessDir}（.line-harness-config.json か apps/worker/wrangler.toml があるフォルダを指定してください）`);
  const databaseName = options.d1 ?? install?.d1DatabaseName;
  if (!databaseName) {
    throw new Error("L Harness の導入フォルダが見つかりません。create-line-harness で入れたフォルダを --harness-dir で指定するか、D1 の名前を --d1 で指定してください");
  }
  // --d1 / --harness-url で導入フォルダと違う移行先を指定したときは、導入フォルダの ID・Worker 名・アカウントを混ぜない
  // （別の L Harness の値が混ざると、ブリッジや投入先の照合が別の導入先を指す）
  const sameInstall = Boolean(install)
    && (!options.d1 || options.d1 === install!.d1DatabaseName)
    && (!options.harnessUrl || (Boolean(install!.workerUrl) && options.harnessUrl.replace(/\/+$/, "") === install!.workerUrl!.replace(/\/+$/, "")));
  const trusted = sameInstall ? install : null;
  const workerDir = trusted ? join(trusted.dir, "apps", "worker") : undefined;
  const connection: HarnessConnection = {
    d1_database_name: databaseName,
    d1_database_id: trusted?.d1DatabaseId,
    harness_url: options.harnessUrl ?? trusted?.workerUrl,
    harness_worker_name: options.harnessUrl && options.harnessUrl !== trusted?.workerUrl
      ? new URL(options.harnessUrl).hostname.split(".")[0]
      : trusted?.workerName ?? (options.harnessUrl ? new URL(options.harnessUrl).hostname.split(".")[0] : undefined),
    harness_worker_dir: workerDir && existsSync(join(workerDir, "wrangler.toml")) ? workerDir : undefined,
    // wrangler が実際に使うアカウント（環境変数があればそちら）を記録し、計画と投入の照合に使う
    cloudflare_account_id: env.CLOUDFLARE_ACCOUNT_ID?.trim() || trusted?.accountId,
    line_account_id: "",
  };
  const database = (dependencies.openDatabase ?? ((c, local) => openD1(c, local)))(connection, Boolean(options.local));
  let accounts: AccountRow[];
  try {
    // 認証情報の列は読まない
    accounts = await database.query<AccountRow>("SELECT a.id,a.name,a.is_active,(SELECT COUNT(*) FROM friends f WHERE f.line_account_id=a.id) AS friends FROM line_accounts a ORDER BY a.display_order, a.id");
  } catch (error) {
    throw new Error(`L Harness のデータベースを読めませんでした。L Harness と同じ Cloudflare アカウントに wrangler でログインしているか（npx wrangler@${WRANGLER_VERSION} login）、D1 の名前を確認してください。\n${(error as Error).message}`);
  }
  const chosen = options.lineAccountId
    ? accounts.find((account) => account.id === options.lineAccountId)
    : accounts.length === 1 ? accounts[0] : undefined;
  if (!chosen) {
    if (options.lineAccountId) throw new Error(`L Harness に移行先アカウント ${quote(options.lineAccountId)} がありません`);
    if (!accounts.length) throw new Error("L Harness に LINE アカウントが登録されていません。先に create-line-harness のセットアップを終えてください");
    const list = accounts.map((account) => `  ${account.id}  ${account.name}（友だち ${account.friends}人${account.is_active ? "" : "・停止中"}）`).join("\n");
    throw new Error(`L Harness に複数のアカウントがあります。--line-account-id で移行先を選んでください:\n${list}`);
  }
  connection.line_account_id = chosen.id;

  let apiKey: ConnectSummary["apiKey"] = "no-url";
  if (connection.harness_url) {
    if (!env.HARNESS_API_KEY) apiKey = "missing";
    else {
      try {
        const listed = await new HarnessApi(connection.harness_url, env.HARNESS_API_KEY, dependencies.fetchImpl).lineAccounts();
        // URL の先の L Harness に、D1 で選んだ移行先アカウントが無ければ、URL とデータベースが別の導入先を指している
        apiKey = listed.some((account) => account.id === chosen.id) ? "ok" : "mismatch";
      } catch (error) {
        apiKey = error instanceof HarnessApiError && [401, 403].includes(error.status) ? "rejected" : "unreachable";
      }
    }
  }
  saveConnection(connection, options.cwd);
  const addedEnvSlots = ensureHarnessEnvSlots(options.cwd);
  return {
    step: "connected",
    config: connectionPath(options.cwd),
    database: database.label,
    harnessUrl: connection.harness_url ?? null,
    account: { id: chosen.id, name: chosen.name, isActive: chosen.is_active === 1, friends: Number(chosen.friends) },
    apiKey,
    missingSecrets: ["HARNESS_API_KEY", "LINE_CHANNEL_SECRET"].filter((key) => !env[key]),
    addedEnvSlots,
  };
}
