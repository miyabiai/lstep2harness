import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { assertHarnessPlatform, wranglerCommand, wranglerEnv } from "../d1/wrangler.js";
import type { HarnessDatabase } from "../harness/database.js";
import { cloudflareEnv, type HarnessConnection } from "../harness/connection.js";
import { quote } from "../sql/render.js";
import { ensurePrivateDir, readJsonFile, writePrivateFile } from "../util.js";

/**
 * 並行運用ブリッジ（Lステップの「Webhook転送」→ L Harness）:
 * 1. ./bridge に Worker 一式をコピー（初回）し、wrangler.toml を作る
 * 2. 受信パスのトークンを作って .lstep2harness/bridge.json に保存（0600）
 * 3. --deploy なら、L Harness 側で動いているシナリオ・自動応答が無いことを確かめてから、wrangler deploy と秘密の登録
 * 4. Lステップの「Webhook転送」に貼る URL を表示する（人に見せない URL）
 */
interface BridgeState {
  path_token: string;
  worker_name: string;
  /** どの移行先向けのブリッジか（別の移行先のつなぎ先で配備し直して、先の転送を壊さないため） */
  target: string;
  created_at: string;
}

/** ブリッジの Worker 名。同じ Cloudflare アカウントにほかのフォルダから配備したブリッジと重ならないよう、フォルダごとに末尾を変える */
function bridgeWorkerName(): string {
  return `lstep2harness-bridge-${randomBytes(4).toString("hex")}`;
}

function bridgeTarget(connection: HarnessConnection): string {
  return `${connection.cloudflare_account_id ?? "-"}:${connection.d1_database_id ?? connection.d1_database_name}:${connection.line_account_id}`;
}

/** 前に配備した wrangler.toml の重複排除（KV）の設定を引き継ぐ（TOML として正式に読む。壊れていれば止める） */
export function keptKvBlock(previous: string | null): string {
  if (!previous) return "";
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(previous) as Record<string, unknown>;
  } catch {
    throw new Error("前に作った bridge/wrangler.toml を TOML として読めませんでした。重複排除（KV）の設定を控えてからそのファイルを消し、もう一度実行してください");
  }
  const kv = doc.kv_namespaces;
  if (!Array.isArray(kv) || !kv.length) return "";
  return `\n${stringifyToml({ kv_namespaces: kv })}`;
}

export interface BridgeResult {
  step: "bridge";
  deployed: boolean;
  /** Lステップの Webhook転送に貼る URL（受信パスのトークン入り。チャットに貼らず、ファイルから写してもらう） */
  urlFile: string;
  /** 転送先 URL が完成しているか（false なら、ファイルの <あなたのサブドメイン> を Cloudflare の workers.dev のサブドメインに置き換える） */
  urlComplete: boolean;
  /** 並行運用中に二重送信になりうる、L Harness で動いている自動の送信 */
  activeAutomations: { scenarios: number; autoReplies: number; automations: number };
}

/** 動いている自動の送信を数える（L Harness が入れる組み込みの「マイル」自動応答は数えない） */
export async function countActiveAutomations(database: HarnessDatabase, lineAccountId: string): Promise<BridgeResult["activeAutomations"]> {
  const scope = `is_active=1 AND (line_account_id=${quote(lineAccountId)} OR line_account_id IS NULL)`;
  const [scenarios, autoReplies] = await database.queryMany([
    `SELECT COUNT(*) AS c FROM scenarios WHERE ${scope}`,
    `SELECT COUNT(*) AS c FROM auto_replies WHERE ${scope} AND id <> 'builtin-mileage-wallet-keyword'`,
  ]);
  let automations = 0;
  try {
    automations = Number((await database.query<{ c: number }>(`SELECT COUNT(*) AS c FROM automations WHERE ${scope}`))[0]?.c ?? 0);
  } catch (error) {
    // 古い版の L Harness には表が無い。それ以外の失敗は確かめられないので止める
    if (!/no such table/i.test((error as Error).message)) throw error;
  }
  return { scenarios: Number(scenarios[0]?.c ?? 0), autoReplies: Number(autoReplies[0]?.c ?? 0), automations };
}

function token(): string {
  // 48 文字の英数字（推測されない受信パス）
  return randomBytes(48).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 48).padEnd(48, "x");
}

function packagedBridgeDir(): string {
  // dist/commands/bridge.js → ../../bridge
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "bridge");
}

/**
 * Worker のソース一式を、毎回、同梱の版に揃える（このツールを更新したら、配備し直すだけで直しが届くように）。
 * wrangler.toml は呼び出し側で作り直し、重複排除（KV）の設定だけ引き継ぐ。
 * このリポジトリのフォルダで動かしているときは、同梱の雛形そのものが bridge/ なので何もしない
 */
export function syncBridgeTemplate(bridgeDir: string): void {
  const src = packagedBridgeDir();
  if (!existsSync(join(src, "src", "index.ts"))) throw new Error(`ブリッジの雛形が見つかりません: ${src}`);
  if (resolve(src) === resolve(bridgeDir)) return;
  mkdirSync(bridgeDir, { recursive: true });
  cpSync(src, bridgeDir, { recursive: true, force: true, filter: (p) => !p.includes("node_modules") && !p.includes(".wrangler") && !p.endsWith("wrangler.toml") });
}

/** コマンドを動かして標準出力を返す */
export type CommandRunner = (cmd: string, args: string[], cwd: string, input?: string, env?: Record<string, string>) => Promise<string>;

const runCommand: CommandRunner = (cmd, args, cwd, input, env) => new Promise<string>((resolveP, reject) => {
  const child = spawn(cmd, args, { cwd, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: wranglerEnv(env) });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (d: string) => (stdout += d));
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (d: string) => (stderr += d));
  if (input !== undefined) {
    child.stdin!.write(input);
    child.stdin!.end();
  }
  child.on("error", reject);
  // 秘密を渡すコマンドの引数は出さない
  child.on("close", (code) => (code === 0 ? resolveP(stdout) : reject(new Error(`wrangler ${args.find((a) => /^(deploy|secret)$/.test(a)) ?? ""} が失敗しました (exit ${code})\n${stderr.split("\n").slice(-6).join("\n")}`))));
});

export function bridgeToml(state: BridgeState, connection: HarnessConnection): string {
  if (!connection.harness_url) throw new Error("L Harness の URL がつなぎ先にありません。connect を --harness-url 付きでやり直してください");
  const worker = connection.harness_worker_name ?? new URL(connection.harness_url).hostname.split(".")[0];
  const lines = [
    "# lstep2harness bridge（自動生成。直したいときは lstep2harness bridge を再実行）",
    `name = ${JSON.stringify(state.worker_name)}`,
    'main = "src/index.ts"',
    'compatibility_date = "2025-01-01"',
    "workers_dev = true",
    ...(connection.cloudflare_account_id ? [`account_id = ${JSON.stringify(connection.cloudflare_account_id)}`] : []),
    "",
    "# L Harness へのサービス連携（同じアカウントの Worker を workers.dev の URL で呼ぶとエラー1042で遮断されるため）",
    "[[services]]",
    'binding = "HARNESS"',
    `service = ${JSON.stringify(worker)}`,
    "",
    "[vars]",
    `HARNESS_URL = ${JSON.stringify(connection.harness_url)}`,
    'STRIP_REPLY_TOKEN = "1"',
    'MAX_EVENT_AGE_SECONDS = "600"',
    "",
  ];
  return lines.join("\n");
}

export interface BridgeOptions {
  deploy?: boolean;
  /** 受信パスのトークンを作り直す（URL が漏れたとき。同じ Worker のまま、前の URL は使えなくなる） */
  rotateToken?: boolean;
  /** L Harness 側で動いている自動の送信があっても配備する */
  acceptActive?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  database: HarnessDatabase;
  run?: CommandRunner;
  fetchImpl?: typeof fetch;
}

export async function runBridge(connection: HarnessConnection, options: BridgeOptions): Promise<BridgeResult> {
  if (!options.run) assertHarnessPlatform();
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const bridgeDir = join(cwd, "bridge");
  syncBridgeTemplate(bridgeDir);
  const stateDir = join(cwd, ".lstep2harness");
  const statePath = join(stateDir, "bridge.json");
  let state = readJsonFile<BridgeState>(statePath);
  if (state && state.target !== bridgeTarget(connection)) {
    throw new Error("このフォルダのブリッジは、別の移行先（L Harness・アカウント）向けに作ったものです。配備し直すと先の転送が止まるので止めました。別の移行先には別のフォルダで用意してください");
  }
  if (state && options.rotateToken) {
    if (!options.deploy) throw new Error("--rotate-token は --deploy と一緒に使ってください（配備した Worker のトークンを入れ替えないと、前の URL が使えたままになります）");
    state = { ...state, path_token: token() };
    writePrivateFile(statePath, JSON.stringify(state, null, 2));
  }
  if (!state) {
    state = { path_token: token(), worker_name: connection.bridge_worker_name ?? bridgeWorkerName(), target: bridgeTarget(connection), created_at: new Date().toISOString() };
    ensurePrivateDir(stateDir);
    writePrivateFile(statePath, JSON.stringify(state, null, 2));
  }
  const tomlPath = join(bridgeDir, "wrangler.toml");
  const previous = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : null;
  writeFileSync(tomlPath, bridgeToml(state, connection) + keptKvBlock(previous));

  let deployedSubdomain: string | undefined;
  const activeAutomations = await countActiveAutomations(options.database, connection.line_account_id);
  const active = activeAutomations.scenarios + activeAutomations.autoReplies + activeAutomations.automations;
  if (options.deploy) {
    if (active && !options.acceptActive) {
      throw new Error(`L Harness で動いている自動の送信があります（シナリオ ${activeAutomations.scenarios}・自動応答 ${activeAutomations.autoReplies}・オートメーション ${activeAutomations.automations}）。ブリッジをつなぐと Lステップと二重に送られることがあるので、L Harness の管理画面で止めてから実行してください（承知のうえなら --accept-active）`);
    }
    const channelSecret = env.LINE_CHANNEL_SECRET;
    if (!channelSecret) throw new Error("LINE_CHANNEL_SECRET（.env）が空です。LINE Developers の Messaging API チャネルの「チャネルシークレット」を .env に貼ってください");
    const run = options.run ?? runCommand;
    const cfEnv = cloudflareEnv(connection, env);
    const [cmd, ...pre] = wranglerCommand(bridgeDir, env.LSTEP2HARNESS_WRANGLER);
    const deployed = await run(cmd, [...pre, "deploy"], bridgeDir, undefined, cfEnv);
    // wrangler deploy が表示する Worker の URL（https://<名前>.<サブドメイン>.workers.dev）からサブドメインを読む
    const shown = deployed.match(new RegExp(`https://${state.worker_name.replace(/[^A-Za-z0-9-]/g, "")}\\.([A-Za-z0-9-]+)\\.workers\\.dev`));
    if (shown) deployedSubdomain = shown[1];
    await run(cmd, [...pre, "secret", "put", "LINE_CHANNEL_SECRET"], bridgeDir, channelSecret, cfEnv);
    await run(cmd, [...pre, "secret", "put", "PATH_TOKEN"], bridgeDir, state.path_token, cfEnv);
  }

  let sub = deployedSubdomain ?? "<あなたのサブドメイン>";
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || connection.cloudflare_account_id;
  if (!deployedSubdomain && env.CLOUDFLARE_API_TOKEN && accountId) {
    try {
      const r = await (options.fetchImpl ?? fetch)(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      });
      const j = (await r.json()) as { result?: { subdomain?: string } };
      if (j.result?.subdomain) sub = j.result.subdomain;
    } catch {
      /* 取れなければ置き換え文字のまま */
    }
  }
  const url = `https://${state.worker_name}.${sub}.workers.dev/lstep/line/${state.path_token}`;
  const urlFile = join(stateDir, "bridge-url.txt");
  const urlComplete = !url.includes("<");
  writePrivateFile(urlFile, `Lステップ「Webhook転送」の転送先URL: ${url}\n${urlComplete ? "" : "※ <あなたのサブドメイン> は、Cloudflare の管理画面の Workers の「workers.dev」のサブドメインに置き換えてください\n"}`);
  return { step: "bridge", deployed: Boolean(options.deploy), urlFile, urlComplete, activeAutomations };
}
