import { isSafeHarnessUrl } from "../harness/api.js";
import type { HarnessConnection } from "../harness/connection.js";

/** POST /api/admin/refresh-profiles の結果（data に包まれる版と包まれない版がある） */
interface RefreshProfilesResult {
  processed?: number;
  updated?: number;
  notFound?: number;
  otherErrors?: number;
  hasMore?: boolean;
  nextOffset?: number;
}

export interface EnrichResult {
  step: "enriched";
  finished: boolean;
  updated: number;
  notFound: number;
  errors: number;
}

/**
 * 移した友だちの表示名・アイコン・ステータスメッセージを LINE から取り直す。
 * L Harness 標準の POST /api/admin/refresh-profiles を offset 送りで呼ぶだけ
 * （チャネルアクセストークンは L Harness 側が持っているものを使う。こちらでは扱わない）。
 * ブロック中の人は対象外。
 */
export async function runEnrich(
  connection: Pick<HarnessConnection, "harness_url" | "line_account_id">,
  apiKey: string | undefined,
  options: { limit?: number; maxRounds?: number; log?: (message: string) => void; fetchImpl?: typeof fetch } = {},
): Promise<EnrichResult> {
  if (!connection.harness_url) throw new Error("L Harness の URL がつなぎ先にありません。connect を --harness-url 付きでやり直してください");
  if (!isSafeHarnessUrl(connection.harness_url)) throw new Error("L Harness の URL は https://… で指定してください（API キーを送るため）");
  if (!apiKey) throw new Error("HARNESS_API_KEY（.env）が空です。L Harness のセットアップ完了時に出た API キーを貼ってください");
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = connection.harness_url.replace(/\/+$/, "");
  // 無料プランの Worker は1回の呼び出しで外部通信50件まで。1人=LINE取得+DB更新なので20人ずつ
  const batch = Math.min(Math.max(options.limit ?? 20, 1), 500);
  const maxRounds = options.maxRounds ?? 1000;
  let offset = 0;
  let updated = 0;
  let notFound = 0;
  let errors = 0;
  for (let round = 0; round < maxRounds; round++) {
    const url = `${base}/api/admin/refresh-profiles?offset=${offset}&limit=${batch}&accountId=${encodeURIComponent(connection.line_account_id)}`;
    const res = await fetchImpl(url, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(120_000) });
    const json = (await res.json().catch(() => null)) as ({ success?: boolean; error?: string; data?: RefreshProfilesResult } & RefreshProfilesResult) | null;
    if (!res.ok || json?.success === false) throw new Error(`L Harness の refresh-profiles が失敗しました (HTTP ${res.status}${typeof json?.error === "string" ? `: ${json.error.slice(0, 200)}` : ""})`);
    const d: RefreshProfilesResult | undefined = json?.data ?? json ?? undefined;
    if (!d || typeof d.processed !== "number") throw new Error("L Harness の refresh-profiles の応答が JSON の結果ではありません（HTML のページなど）。URL が L Harness の Worker か確認してください。0人とは扱いません");
    updated += d.updated ?? 0;
    notFound += d.notFound ?? 0;
    errors += d.otherErrors ?? 0;
    // 最初の回で全員エラーなら、続けても同じなので止めて理由の調べ方を出す
    if (round === 0 && (d.processed ?? 0) > 0 && (d.updated ?? 0) === 0 && (d.otherErrors ?? 0) === (d.processed ?? 0)) {
      throw new Error([
        `最初の ${d.processed} 人が全員エラーでした。L Harness 側で LINE の取得か D1 の更新が失敗しています。`,
        "よくある原因: D1 無料枠の書き込み上限（1 日 10 万行。移行直後に起きやすい。翌日 09:00 JST に回復、または Workers 有料プラン）、チャネルアクセストークンの誤り、移したLステップと L Harness のLINE公式アカウントが違う。",
        "詳しい理由は L Harness の Worker ログで分かります: npx wrangler tail <Worker 名> を動かしてから、もう一度 enrich --limit 1",
      ].join("\n"));
    }
    options.log?.(`  … ${offset + (d.processed ?? 0)}人まで（更新 ${updated}）`);
    if (!d.hasMore) return { step: "enriched", finished: true, updated, notFound, errors };
    offset = d.nextOffset ?? offset + (d.processed ?? batch);
  }
  return { step: "enriched", finished: false, updated, notFound, errors };
}
