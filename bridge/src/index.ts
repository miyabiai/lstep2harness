/**
 * lstep2harness-bridge
 *
 * Lステップの「Webhook転送」（オプション機能）を受け取り、L Harness に流す。
 * Lステップ公式アカウントの Webhook URL は Lステップのままにして、切り替えまで L Harness にも同じ出来事を届ける。
 *
 *   POST /lstep/line/<PATH_TOKEN>
 *     LINE の Webhook（友だち追加・ブロック・メッセージ・ポストバック等）
 *     → LINE_CHANNEL_SECRET で X-Line-Signature を付け直して L Harness の /webhook へ POST
 *       （L Harness から見ると LINE から直接届いたのと同じになる）
 *
 * Lステップの転送にはタグや友だち情報の変更は入らない（LINE 上の出来事だけ）。
 *
 * 受け付けの条件:
 *  - 受信パスのトークン（推測できない長さ）が一致すること
 *  - X-Line-Signature が付いていれば、チャネルシークレットで検証して一致すること
 *  - 各イベントの timestamp が今から MAX_EVENT_AGE_SECONDS 以内であること（盗み見た通信の使い回し対策。古いイベントは捨てる）
 * replyToken は Lステップが先に使うので、既定で外してから渡す（L Harness からの返信が失敗・二重にならないように）。
 * L Harness へ渡せたときだけ 2xx を返す（渡せなければ 502 を返し、送り手が再送できるようにする）。
 */

/** L Harness の Worker へのサービス連携（同じアカウントの Worker を workers.dev の URL で呼ぶとエラー1042で遮断されるため） */
interface ServiceFetcher {
  fetch(request: Request): Promise<Response>;
}

interface DedupStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface WaitContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  HARNESS?: ServiceFetcher;
  DEDUP?: DedupStore;
  HARNESS_URL: string;
  LINE_CHANNEL_SECRET: string;
  PATH_TOKEN: string;
  /** "0" で replyToken を外さずに渡す。既定 "1" */
  STRIP_REPLY_TOKEN?: string;
  /** イベントの timestamp を受け付ける古さ（秒）。既定 600。"0" で確かめない */
  MAX_EVENT_AGE_SECONDS?: string;
}

const TOKEN_RE = /^[A-Za-z0-9]{32,128}$/;
const DEFAULT_MAX_EVENT_AGE_SECONDS = 600;
const MAX_BODY_BYTES = 2_000_000;

interface LineEvent {
  timestamp?: number;
  webhookEventId?: string;
  replyToken?: string;
  [key: string]: unknown;
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function hmacSha256Base64(secret: string, body: ArrayBuffer | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, body);
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** 受け付ける新しさのイベントだけ残す */
export function freshEvents(env: Env, events: LineEvent[], now = Date.now()): LineEvent[] {
  const limit = Number(env.MAX_EVENT_AGE_SECONDS ?? DEFAULT_MAX_EVENT_AGE_SECONDS);
  if (Number.isFinite(limit) && limit <= 0) return events;
  const limitMs = (Number.isFinite(limit) ? limit : DEFAULT_MAX_EVENT_AGE_SECONDS) * 1000;
  return events.filter((ev) => typeof ev.timestamp === "number" && Math.abs(now - ev.timestamp) <= limitMs);
}

/** 渡し済みの出来事を除く（重複排除を設定したときだけ。渡し済みの印は L Harness へ渡せた後に付ける） */
async function unseen(env: Env, events: LineEvent[]): Promise<LineEvent[]> {
  if (!env.DEDUP) return events;
  const kept: LineEvent[] = [];
  for (const ev of events) {
    if (ev.webhookEventId && (await env.DEDUP.get(`line:${ev.webhookEventId}`))) continue;
    kept.push(ev);
  }
  return kept;
}

async function markSeen(env: Env, events: LineEvent[]): Promise<void> {
  if (!env.DEDUP) return;
  for (const ev of events) if (ev.webhookEventId) await env.DEDUP.put(`line:${ev.webhookEventId}`, "1", { expirationTtl: 60 * 60 });
}

function harnessFetch(env: Env, path: string, init: RequestInit): Promise<Response> {
  const url = env.HARNESS_URL.replace(/\/+$/, "") + path;
  return env.HARNESS ? env.HARNESS.fetch(new Request(url, init)) : fetch(url, init);
}

/** 署名を付け直して L Harness の /webhook へ渡す */
export async function forwardToHarness(env: Env, payload: { destination?: string; events: LineEvent[] }): Promise<number> {
  if ((env.STRIP_REPLY_TOKEN ?? "1") !== "0") for (const ev of payload.events) delete ev.replyToken;
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const signature = await hmacSha256Base64(env.LINE_CHANNEL_SECRET, body);
  const res = await harnessFetch(env, "/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Line-Signature": signature, "X-Lstep2harness-Bridge": "1" },
    body,
  });
  if (!res.ok) console.warn(`L Harness /webhook が ${res.status} を返しました`);
  return res.status;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export default {
  async fetch(request: Request, env: Env, _ctx?: WaitContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return json(200, { ok: true });
    if (request.method !== "POST") return new Response("not found", { status: 404 });
    const m = url.pathname.match(/^\/lstep\/line\/([A-Za-z0-9]+)$/);
    if (!m || !env.PATH_TOKEN || !TOKEN_RE.test(env.PATH_TOKEN) || !timingSafeEqual(m[1], env.PATH_TOKEN)) {
      return new Response("not found", { status: 404 });
    }
    if (!env.LINE_CHANNEL_SECRET) return json(503, { ok: false, error: "LINE_CHANNEL_SECRET 未設定" });
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_BODY_BYTES) return json(413, { ok: false });
    const signature = request.headers.get("X-Line-Signature");
    if (signature !== null && !timingSafeEqual(signature, await hmacSha256Base64(env.LINE_CHANNEL_SECRET, raw))) {
      return json(401, { ok: false, error: "署名不一致" });
    }
    let payload: { destination?: string; events?: LineEvent[] };
    try {
      payload = JSON.parse(new TextDecoder().decode(raw)) as typeof payload;
    } catch {
      return json(400, { ok: false, error: "JSON ではありません" });
    }
    const all = Array.isArray(payload.events) ? payload.events : [];
    // 接続確認（events が空）は受けたと返すだけ
    if (!all.length) return json(200, { ok: true, accepted: 0 });
    const fresh = freshEvents(env, all);
    const events = await unseen(env, fresh);
    if (events.length) {
      let status: number;
      try {
        status = await forwardToHarness(env, { destination: payload.destination, events });
      } catch {
        status = 0;
      }
      if (status < 200 || status >= 300) return json(502, { ok: false, error: "L Harness へ渡せませんでした" });
      await markSeen(env, events);
    }
    return json(200, { ok: true, accepted: events.length, stale: all.length - fresh.length, duplicate: fresh.length - events.length });
  },
};
