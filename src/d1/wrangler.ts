import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateFile } from "../util.js";
import type { HarnessDatabase } from "../harness/database.js";

/**
 * wrangler d1 execute のラッパー（本番の L Harness の D1 へ書き込み・読み出し）。
 * - 認証は wrangler 自身（`wrangler login` か CLOUDFLARE_API_TOKEN 環境変数）に任せる
 * - 起動コマンドは LSTEP2HARNESS_WRANGLER で差し替えられる（例: 複数の Cloudflare アカウントを切り替える自前の道具）
 */
export interface WranglerD1Options {
  databaseName: string;
  /** wrangler を動かすフォルダ（L Harness の apps/worker など wrangler.toml がある場所）。無ければ今いる場所 */
  cwd?: string;
  /** --remote（既定）/ --local */
  remote?: boolean;
  env?: Record<string, string>;
  /** wrangler の起動コマンド（既定: 手元の wrangler、無ければ版を固定した npx） */
  command?: string[];
}

/** npx で取ってくる wrangler の版。最新版をその場で取らないよう固定する（bridge/package.json と揃える） */
export const WRANGLER_VERSION = "4.150.0";

/** 使う wrangler の起動コマンド。LSTEP2HARNESS_WRANGLER → dir の node_modules → 版を固定した npx の順 */
export function wranglerCommand(dir?: string, override = process.env.LSTEP2HARNESS_WRANGLER): string[] {
  if (override?.trim()) return override.trim().split(/\s+/);
  const bin = dir ? join(dir, "node_modules", ".bin", "wrangler") : null;
  if (bin && existsSync(bin)) return [bin];
  return ["npx", "--yes", `wrangler@${WRANGLER_VERSION}`];
}

/**
 * 本番の L Harness へつなぐ操作は Windows では受け付けない。
 * Windows では wrangler（npx.cmd）をコマンドプロンプト経由でしか起動できず、顧客データを含む SQL が
 * コマンド行で解釈されうるため。WSL（Linux）で動かしてもらう。
 */
export function assertHarnessPlatform(platform: string = process.platform): void {
  if (platform === "win32") {
    throw new Error("Windows では本番の L Harness へつなぐ操作（connect・--harness・bridge）に対応していません。WSL（Windows 上の Linux）で動かしてください。手元の試験用DBへの移行（--db）は使えます");
  }
}

export interface WranglerResult { code: number; stdout: string; stderr: string }

export type WranglerRunner = (args: string[], opts: WranglerD1Options) => Promise<WranglerResult>;

/**
 * wrangler に渡す環境変数。.env の空欄（CLOUDFLARE_API_TOKEN= など）は「指定なし」として外す
 * （空の値が残ると、wrangler login の代わりに空のトークンで認証しようとするため）。
 */
export function wranglerEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // wrangler は既定で出力（照合のために読み出した顧客データを含む）を自分のログフォルダにも書くので止める
  const env: NodeJS.ProcessEnv = { ...base, ...extra, FORCE_COLOR: "0", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false" };
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) if (!env[key]?.trim()) delete env[key];
  return env;
}

export const runWrangler: WranglerRunner = (args, opts) => {
  const [cmd, ...pre] = opts.command ?? wranglerCommand(opts.cwd);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...pre, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: wranglerEnv(opts.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    // 文字コードの区切りで読む（Buffer ごとに toString すると、日本語や絵文字が受け取りの切れ目で壊れる）
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
};

/** エラー文に出してよい wrangler の出力（末尾だけ。SQL の中身＝顧客データが混ざる行は落とす） */
function errorTail(result: WranglerResult): string {
  return `${result.stderr}\n${result.stdout}`.split("\n")
    .filter((line) => line.trim() && !/INSERT INTO|SELECT |VALUES \(/i.test(line))
    .slice(-8).join("\n").slice(-1500);
}

/** Cloudflare 側の一時的な失敗（アップロード失敗・内部エラー・5xx・通信断）か。待って再試行すると通ることが多い */
export function isTransientD1Error(message: string): boolean {
  return /Please retry|InternalError|internal error|<Code>5\d\d<\/Code>|HTTP 5\d\d|status 5\d\d|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|Network connection lost|network error|ENOTFOUND|EAI_AGAIN/i.test(message);
}

export class WranglerD1 implements HarnessDatabase {
  constructor(
    readonly opts: WranglerD1Options,
    private readonly run: WranglerRunner = runWrangler,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (run === runWrangler) assertHarnessPlatform();
  }

  get label(): string {
    return `D1「${this.opts.databaseName}」(${this.opts.remote === false ? "local" : "remote"})`;
  }

  private async execute(extraArgs: string[]): Promise<string> {
    const args = ["d1", "execute", this.opts.databaseName, this.opts.remote === false ? "--local" : "--remote", ...extraArgs];
    const result = await this.run(args, this.opts);
    if (result.code !== 0) throw new Error(`wrangler d1 execute が失敗しました (exit ${result.code})\n${errorTail(result)}`);
    return result.stdout;
  }

  /** 一時的な失敗は少し待って最大 retries 回まで再試行する（大量のファイル投入で実際に起きる） */
  private async withRetry<T>(work: () => Promise<T>, retries = 3, waits = [5_000, 15_000, 30_000]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        if (attempt >= retries || !isTransientD1Error((error as Error).message)) throw error;
        await this.wait(waits[Math.min(attempt, waits.length - 1)]);
      }
    }
  }

  /** SQL ファイルを1つ流す */
  executeFile(file: string): Promise<void> {
    return this.withRetry(async () => { await this.execute(["--file", file, "--yes"]); });
  }

  /** 1回に送る SQL の長さの目安（D1 の1文の上限は 100KB。コマンド行の長さにも収める） */
  readonly maxCommandBytes = 180_000;

  /** 文をまとめて1回で流し、文ごとの結果の行を返す（読み出し用）。SQL（顧客データを含む）は起動引数に出さず、本人だけが読める一時ファイルで渡す */
  queryMany(statements: string[]): Promise<Array<Array<Record<string, unknown>>>> {
    return this.withRetry(async () => {
      const dir = mkdtempSync(join(tmpdir(), "lstep2harness-query-"));
      const file = join(dir, "query.sql");
      let stdout: string;
      try {
        writePrivateFile(file, statements.map((s) => s.replace(/;\s*$/, "")).join(";\n") + ";\n");
        stdout = await this.execute(["--file", file, "--json", "--yes"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      const start = stdout.indexOf("[");
      if (start < 0) throw new Error("wrangler の結果を読み取れませんでした");
      const parsed = JSON.parse(stdout.slice(start)) as Array<{ results?: Array<Record<string, unknown>> }>;
      return parsed.map((entry) => entry.results ?? []);
    });
  }

  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    return ((await this.queryMany([sql]))[0] ?? []) as T[];
  }

  /** 今の状態に戻すための D1 Time Travel のしおり（remote のみ。取れなければ null） */
  async bookmark(): Promise<string | null> {
    if (this.opts.remote === false) return null;
    try {
      const result = await this.run(["d1", "time-travel", "info", this.opts.databaseName, "--json"], this.opts);
      if (result.code !== 0) return null;
      const start = result.stdout.indexOf("{");
      const parsed = JSON.parse(result.stdout.slice(start)) as { bookmark?: string };
      return typeof parsed.bookmark === "string" && parsed.bookmark ? parsed.bookmark : null;
    } catch {
      return null;
    }
  }
}
