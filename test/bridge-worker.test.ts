import { describe, expect, it } from "vitest";
import worker, { freshEvents, hmacSha256Base64, type Env } from "../bridge/src/index.js";

const TOKEN = "A".repeat(24) + "b".repeat(24);
const SECRET = "fictional-channel-secret";

function setup(overrides: Partial<Env> = {}, harnessStatus = 200) {
  const forwarded: Array<{ url: string; signature: string | null; body: string }> = [];
  const pending: Promise<unknown>[] = [];
  const env: Env = {
    HARNESS_URL: "https://fictional-harness.example.workers.dev",
    LINE_CHANNEL_SECRET: SECRET,
    PATH_TOKEN: TOKEN,
    HARNESS: {
      async fetch(request: Request) {
        forwarded.push({ url: request.url, signature: request.headers.get("X-Line-Signature"), body: await request.text() });
        return new Response("ok", { status: harnessStatus });
      },
    },
    ...overrides,
  };
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
  const send = async (body: string, headers: Record<string, string> = {}, path = `/lstep/line/${TOKEN}`) => {
    const response = await worker.fetch(new Request(`https://bridge.example.workers.dev${path}`, { method: "POST", body, headers }), env, ctx);
    await Promise.all(pending);
    return response;
  };
  return { env, send, forwarded };
}

function event(overrides: Record<string, unknown> = {}) {
  return { type: "message", timestamp: Date.now(), webhookEventId: "01FICTIONAL", replyToken: "reply-token", source: { type: "user", userId: "U11111111111111111111111111111111" }, message: { type: "text", text: "こんにちは" }, ...overrides };
}

describe("並行運用ブリッジ（Worker）", () => {
  it("署名を付け直し、replyToken を外して L Harness の /webhook へ渡す", async () => {
    const { send, forwarded } = setup();
    const body = JSON.stringify({ destination: "Ufictionalbot", events: [event()] });
    const response = await send(body, { "X-Line-Signature": await hmacSha256Base64(SECRET, new TextEncoder().encode(body)) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, accepted: 1, stale: 0 });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].url).toBe("https://fictional-harness.example.workers.dev/webhook");
    const sent = JSON.parse(forwarded[0].body);
    expect(sent.destination).toBe("Ufictionalbot");
    expect(sent.events[0].replyToken).toBeUndefined();
    expect(sent.events[0].message.text).toBe("こんにちは");
    expect(forwarded[0].signature).toBe(await hmacSha256Base64(SECRET, new TextEncoder().encode(forwarded[0].body)));
  });

  it("署名が付いていない転送も、受信パスのトークンが合えば受ける", async () => {
    const { send, forwarded } = setup();
    expect((await send(JSON.stringify({ events: [event()] }))).status).toBe(200);
    expect(forwarded).toHaveLength(1);
  });

  it("トークン違い・署名違いは断り、L Harness へ渡さない", async () => {
    const { send, forwarded } = setup();
    const body = JSON.stringify({ events: [event()] });
    expect((await send(body, {}, `/lstep/line/${"C".repeat(48)}`)).status).toBe(404);
    expect((await send(body, {}, "/lstep/line/short")).status).toBe(404);
    expect((await send(body, { "X-Line-Signature": "forged" })).status).toBe(401);
    expect((await worker.fetch(new Request(`https://b.example/lstep/line/${TOKEN}`), setup().env, { waitUntil() {} })).status).toBe(404);
    expect(forwarded).toEqual([]);
  });

  it("古いイベントは捨て、接続確認（events が空）には 200 を返すだけ", async () => {
    const { send, forwarded } = setup();
    const stale = await send(JSON.stringify({ events: [event({ timestamp: Date.now() - 3_600_000 })] }));
    expect(await stale.json()).toMatchObject({ accepted: 0, stale: 1 });
    expect((await send(JSON.stringify({ destination: "U", events: [] }))).status).toBe(200);
    expect(forwarded).toEqual([]);
    expect(freshEvents({ MAX_EVENT_AGE_SECONDS: "0" } as Env, [{ timestamp: 1 }])).toHaveLength(1);
  });

  it("同じイベントの再送は一度だけ渡す（重複排除を設定したとき）", async () => {
    const store = new Map<string, string>();
    const { send, forwarded } = setup({ DEDUP: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } } });
    const body = JSON.stringify({ events: [event()] });
    await send(body);
    const second = await send(body);
    expect(await second.json()).toMatchObject({ accepted: 0, duplicate: 1 });
    expect(forwarded).toHaveLength(1);
  });

  it("L Harness へ渡せなければ 502 を返し、重複排除の印も付けない（再送で渡せる）", async () => {
    const store = new Map<string, string>();
    const dedup = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v); } };
    const body = JSON.stringify({ events: [event()] });
    const failing = setup({ DEDUP: dedup }, 503);
    expect((await failing.send(body)).status).toBe(502);
    expect(store.size).toBe(0);
    const recovered = setup({ DEDUP: dedup });
    expect((await recovered.send(body)).status).toBe(200);
    expect(recovered.forwarded).toHaveLength(1);
    expect(store.size).toBe(1);
    const unreachable = setup({ HARNESS: { fetch: async () => { throw new Error("down"); } } });
    expect((await unreachable.send(body)).status).toBe(502);
  });

  it("チャネルシークレット未設定・壊れた本文・大きすぎる本文を断る", async () => {
    expect((await setup({ LINE_CHANNEL_SECRET: "" }).send("{}")).status).toBe(503);
    expect((await setup().send("not json")).status).toBe(400);
    expect((await setup().send("x".repeat(2_000_001))).status).toBe(413);
  });
});
