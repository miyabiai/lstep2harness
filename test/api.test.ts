import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LSTEP_API_BASE, LstepApiError, LstepApiSource } from "../src/lstep/api.js";

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;

function page(data: unknown[], next: string | null = null): Response {
  return Response.json({ data, next_cursor: next, client_secret: "SECRET_ROOT", next_page_url: "https://untrusted.invalid/" });
}

function api(handler: Handler = () => undefined) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return await handler(url, init) ?? page([]);
  });
}

function source(fetchImpl: typeof fetch, options: Partial<ConstructorParameters<typeof LstepApiSource>[0]> = {}) {
  return new LstepApiSource({ token: "SECRET_TOKEN", accountId: "account-1", fetchImpl, ...options });
}

function uid(id = 1): string {
  return `U${id.toString(16).padStart(32, "0")}`;
}

function friend(id = 1, extra: Record<string, unknown> = {}) {
  return {
    id, uid: uid(id), name: `友だち${id}`, system_name: `管理名${id}`,
    is_blocked: false, created_at: "2026-10-01T10:00:00+09:00", memo: "メモ",
    is_line_group: false, taiou_mark: { id: 9, name: "対応中", channel_secret: "SECRET_MARK" },
    tags: [], friend_infos: [], channel_secret: "SECRET_FRIEND", ...extra,
  };
}

async function finish<T>(operation: Promise<T>): Promise<T> {
  const settled = operation.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const result = await settled;
  if (!result.ok) throw result.error;
  return result.value;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T01:00:00Z"));
});

afterEach(() => vi.useRealTimers());

describe("LstepApiSource", () => {
  it("doctor uses a read-only request without serializing the token", async () => {
    const fetchImpl = api();
    const client = source(fetchImpl);
    await finish(client.doctor());
    const [input, init] = fetchImpl.mock.calls[0];
    expect(String(input)).toBe(`${LSTEP_API_BASE}/friends?limit=1`);
    expect(init).toMatchObject({ method: "GET", redirect: "manual", headers: { Authorization: "Bearer SECRET_TOKEN" } });
    expect(JSON.stringify(client)).not.toContain("SECRET_TOKEN");
  });

  it.each([401, 403])("stops on HTTP %i and never reads the error body", async (status) => {
    const response = new Response('{"client_secret":"SECRET_ERROR"}', { status });
    const json = vi.spyOn(response, "json");
    const fetchImpl = api(() => response);
    const operation = finish(source(fetchImpl).extract());
    await expect(operation).rejects.toMatchObject({ name: "LstepApiError", status });
    expect(json).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(operation).rejects.not.toHaveProperty("cause");
  });

  it("stops immediately when Retry-After is next month's HTTP-date", async () => {
    const fetchImpl = api(() => new Response("SECRET_ERROR", {
      status: 429, headers: { "Retry-After": "Sun, 01 Nov 2026 00:00:00 GMT" },
    }));
    await expect(finish(source(fetchImpl).doctor())).rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(new Date("2026-10-25T01:00:00Z").getTime());
  });

  it("retries a short rate limit after waiting", async () => {
    const stamps: number[] = [];
    const fetchImpl = api(() => {
      stamps.push(Date.now());
      return stamps.length === 1 ? new Response("SECRET_ERROR", { status: 429 }) : page([]);
    });
    await finish(source(fetchImpl).doctor());
    expect(stamps).toHaveLength(2);
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(1000);
  });

  it("honors a short HTTP-date retry time", async () => {
    const stamps: number[] = [];
    const fetchImpl = api(() => {
      stamps.push(Date.now());
      return stamps.length === 1 ? new Response("", {
        status: 429, headers: { "Retry-After": "Sun, 25 Oct 2026 01:00:02 GMT" },
      }) : page([]);
    });
    await finish(source(fetchImpl).doctor());
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(2000);
  });

  it("reads every cursor page without following response-provided URLs", async () => {
    const fetchImpl = api((url) => {
      if (url.pathname.endsWith("/friends")) {
        return url.searchParams.get("cursor") === "next-friend"
          ? page([friend(2)]) : page([friend(1)], "next-friend");
      }
      return undefined;
    });
    const exported = await finish(source(fetchImpl).extract());
    expect(exported.resources.friends.map((item) => item.row.line_friend_id)).toEqual([uid(1), uid(2)]);
    expect(exported.coverage.friends).toEqual({ status: "complete", count: 2 });
    expect(fetchImpl.mock.calls.every(([input]) => new URL(String(input)).origin === "https://api.lineml.jp")).toBe(true);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    const friendRequest = fetchImpl.mock.calls.map(([input]) => new URL(String(input)))
      .find((url) => url.pathname.endsWith("/friends"))!;
    expect(friendRequest.searchParams.getAll("display_status[]")).toEqual(["normal", "block", "hide"]);
    expect(JSON.stringify(exported)).not.toContain("SECRET");
  });

  it("rejects a repeated cursor instead of calling a partial export complete", async () => {
    const fetchImpl = api(() => page([{ id: 1, name: "タグ" }], "same-cursor"));
    await expect(finish(source(fetchImpl).extract())).rejects.toThrow("ループ");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects missing pagination metadata", async () => {
    const fetchImpl = api(() => Response.json({ data: [] }));
    await expect(finish(source(fetchImpl).extract())).rejects.toThrow("全件取得を確認できません");
  });

  it("does not migrate group IDs as individual LINE users", async () => {
    const fetchImpl = api((url) => url.pathname.endsWith("/friends")
      ? page([friend(), friend(2, { uid: uid(2).replace(/^U/, "C"), is_line_group: true })]) : undefined);
    const exported = await finish(source(fetchImpl).extract());
    expect(exported.resources.friends.map((item) => item.row.line_friend_id)).toEqual([uid(1)]);
    expect(exported.coverage.friends.status).toBe("partial");
    const messageRequests = fetchImpl.mock.calls.filter(([input]) => new URL(String(input)).pathname.endsWith("/messages"));
    expect(messageRequests).toHaveLength(1);
  });

  it("rejects a missing LINE user ID and duplicate friends", async () => {
    const missingUid = api((url) => url.pathname.endsWith("/friends")
      ? page([friend(1, { uid: null })]) : undefined);
    await expect(finish(source(missingUid).extract())).rejects.toThrow(LstepApiError);
    const duplicates = api((url) => url.pathname.endsWith("/friends")
      ? page([friend(), friend()]) : undefined);
    await expect(finish(source(duplicates).extract())).rejects.toThrow("重複");
  });

  it.each(["U1", `U${"g".repeat(32)}`, `U${"0".repeat(31)}`, `U${"0".repeat(33)}`])(
    "rejects an invalid UID during extraction even after a successful doctor check: %s", async (invalidUid) => {
      const fetchImpl = api((url) => url.pathname.endsWith("/friends")
        ? page([friend(1, { uid: invalidUid })]) : undefined);
      const client = source(fetchImpl);
      await finish(client.doctor());
      await expect(finish(client.extract())).rejects.toThrow("LINEユーザーIDが不正");
    },
  );

  it("splits inclusion IDs into batches of 100 and merges every value", async () => {
    const tags = Array.from({ length: 101 }, (_, index) => ({ id: index + 1, name: `タグ${index + 1}` }));
    const fields = Array.from({ length: 201 }, (_, index) => ({ id: index + 1001, name: `項目${index + 1}`, type: "string" }));
    const batches: Array<{ tagIds: number[]; fieldIds: number[]; path: string }> = [];
    const fetchImpl = api((url) => {
      if (url.pathname.endsWith("/tags")) return page(tags);
      if (url.pathname.endsWith("/friend-infos")) return page(fields);
      if (url.pathname.endsWith("/friends")) {
        const tagIds = url.searchParams.getAll("include_tags[]").map(Number);
        const fieldIds = url.searchParams.getAll("include_friend_infos[]").map(Number);
        batches.push({ tagIds, fieldIds, path: url.pathname });
        const value = friend(1, {
          tags: tagIds.map((id) => ({ id, name: `タグ${id}`, client_secret: "SECRET_TAG" })),
          friend_infos: fieldIds.map((id) => ({ id, name: `項目${id}`, type: "string", value: `値${id}`, api_key: "SECRET_FIELD" })),
        });
        return page([value]);
      }
      return undefined;
    });
    const exported = await finish(source(fetchImpl).extract());
    expect(batches.map((batch) => [batch.tagIds.length, batch.fieldIds.length])).toEqual([[100, 100], [1, 100], [0, 1]]);
    expect(batches.every(batch => batch.path === "/v2/api/friends")).toBe(true);
    expect(exported.resources.friends[0].detail?.tags).toHaveLength(101);
    expect(exported.resources.friends[0].detail?.friend_info).toHaveLength(201);
    expect(exported.coverage.friendInfoValues.status).toBe("complete");
    expect(JSON.stringify(exported)).not.toContain("SECRET");
  });

  it.each(["missing", "duplicate", "unknown", "uid-mismatch", "group-changed", "failed-page"])(
    "rejects an inconsistent additional friend attribute batch: %s", async (fault) => {
      const tags = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, name: `タグ${i + 1}` }));
      const fetchImpl = api(url => {
        if (url.pathname.endsWith("/tags")) return page(tags);
        if (!url.pathname.endsWith("/friends")) return undefined;
        const ids = url.searchParams.getAll("include_tags[]").map(Number);
        const make = (id: number, extra = {}) => friend(id, { tags: ids.map(tagId => ({ id: tagId, name: `タグ${tagId}` })), ...extra });
        if (!ids.includes(101)) return page([make(1), make(2)]);
        if (fault === "missing") return page([make(1)]);
        if (fault === "duplicate") return page([make(1), make(1), make(2)]);
        if (fault === "unknown") return page([make(1), make(3)]);
        if (fault === "uid-mismatch") return page([make(1, { uid: uid(3) }), make(2)]);
        if (fault === "group-changed") return page([make(1, { is_line_group: true }), make(2)]);
        return new Response("SECRET_ERROR", { status: 500 });
      });
      await expect(finish(source(fetchImpl, { maxRetries: 0 }).extract())).rejects.toThrow(LstepApiError);
      expect(fetchImpl.mock.calls.some(([input]) => /\/friends\/\d+$/.test(new URL(String(input)).pathname))).toBe(false);
    },
  );

  it("validates excluded groups in additional attribute batches too", async () => {
    const tags = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, name: `タグ${i + 1}` }));
    const fetchImpl = api(url => {
      if (url.pathname.endsWith("/tags")) return page(tags);
      if (!url.pathname.endsWith("/friends")) return undefined;
      const ids = url.searchParams.getAll("include_tags[]").map(Number);
      const person = friend(1, { tags: ids.map(id => ({ id, name: `タグ${id}` })) });
      return page(ids.includes(101) ? [person] : [person, friend(2, { uid: uid(2).replace(/^U/, "C"), is_line_group: true })]);
    });
    await expect(finish(source(fetchImpl).extract())).rejects.toThrow("取得漏れ");
  });

  it("dispatches interleaved global message pages while preserving every individual's state", async () => {
    const groupUid = uid(3).replace(/^U/, "C");
    const message = (id: number, friendId: number, extra: Record<string, unknown> = {}) => ({
      id, friend_id: friendId, friend_uid: uid(friendId), direction: "inbound", is_unconfirmed: false,
      content: { type: "text", text: `本文${id}` }, sent_at: `2026-10-24T0${id % 10}:00:00Z`, ...extra,
    });
    const fetchImpl = api(url => {
      if (url.pathname.endsWith("/friends")) return page([friend(1), friend(2), friend(3, { uid: groupUid, is_line_group: true }), friend(4)]);
      if (!url.pathname.endsWith("/messages")) return undefined;
      expect(url.searchParams.has("friend_id")).toBe(false);
      expect(url.searchParams.get("sort_order")).toBe("asc");
      return url.searchParams.has("cursor")
        ? page([message(14, 1, { direction: "outbound" }), message(15, 2, { content: { type: "image" }, timeline_text: "画像" }), message(16, 1, { is_unconfirmed: true })])
        : page([message(10, 2), message(11, 1, { direction: "system" }), message(12, 3, { friend_uid: groupUid })], "global-next");
    });
    const exported = await finish(source(fetchImpl).extract());
    const conversations = exported.resources.friends.map(f => f.conversation);
    expect(conversations[0]?.messages.map(m => [m.message_id, m.sender, m.content])).toEqual([[14, "bot", "本文14"], [16, "friend", "本文16"]]);
    expect(conversations[0]).toMatchObject({ confirm_status: "unread", complete: true, last_message_date: "2026-10-24T06:00:00Z" });
    expect(conversations[1]?.messages.map(m => m.content)).toEqual(["本文10", "画像"]);
    expect(conversations[1]).toMatchObject({ confirm_status: "read", complete: false, last_message_date: "2026-10-24T05:00:00Z" });
    expect(conversations[2]).toMatchObject({ messages: [], complete: true });
    expect(conversations[2]?.confirm_status).toBeUndefined();
    expect(exported.coverage.conversations).toMatchObject({ status: "partial", count: 4 });
    expect(exported.coverage.conversations.note).toContain("システム通知1件");
    expect(exported.coverage.conversations.note).toContain("グループの会話1件");
    expect(fetchImpl.mock.calls.filter(([input]) => new URL(String(input)).pathname.endsWith("/messages"))).toHaveLength(2);
  });

  it.each(["unknown-friend", "uid-mismatch", "invalid-direction"])("rejects inconsistent global messages: %s", async fault => {
    const fetchImpl = api(url => {
      if (url.pathname.endsWith("/friends")) return page([friend()]);
      if (url.pathname.endsWith("/messages")) return page([{
        id: 10, friend_id: fault === "unknown-friend" ? 2 : 1,
        friend_uid: fault === "uid-mismatch" ? uid(2) : uid(),
        direction: fault === "invalid-direction" ? "unknown" : "inbound",
        content: { type: "text", text: "本文" }, sent_at: "2026-10-24T01:00:00Z",
      }]);
      return undefined;
    });
    await expect(finish(source(fetchImpl).extract())).rejects.toThrow(LstepApiError);
  });

  it("rejects cyclic global message pagination", async () => {
    const fetchImpl = api(url => {
      if (url.pathname.endsWith("/friends")) return page([friend()]);
      if (url.pathname.endsWith("/messages")) return page([], "same-message-cursor");
      return undefined;
    });
    await expect(finish(source(fetchImpl).extract())).rejects.toThrow("ループ");
  });

  it("honors cancellation during a later global message page", async () => {
    const controller = new AbortController();
    const fetchImpl = api(url => {
      if (url.pathname.endsWith("/friends")) return page([friend()]);
      if (url.pathname.endsWith("/messages")) {
        if (url.searchParams.has("cursor")) { controller.abort(); return page([]); }
        return page([], "next-message");
      }
      return undefined;
    });
    await expect(finish(source(fetchImpl, { signal: controller.signal }).extract())).rejects.toThrow("取得を中止しました");
    expect(fetchImpl.mock.calls.filter(([input]) => new URL(String(input)).pathname.endsWith("/messages"))).toHaveLength(2);
  });

  it("retains 50,001 friends and messages with 102 tags and fields using page-level requests", async () => {
    const total = 50_001;
    const tags = Array.from({ length: 102 }, (_, i) => ({ id: i + 1, name: `タグ${i + 1}` }));
    const fields = Array.from({ length: 102 }, (_, i) => ({ id: i + 1001, name: `項目${i + 1}`, type: "numeric" }));
    const fetchImpl = api(url => {
      if (url.pathname.endsWith("/tags")) return page(tags);
      if (url.pathname.endsWith("/friend-infos")) return page(fields);
      if (!url.pathname.endsWith("/friends") && !url.pathname.endsWith("/messages")) return undefined;
      expect(url.searchParams.get("limit")).toBe("1000");
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const count = Math.min(1000, total - offset);
      const next = offset + count < total ? String(offset + count) : null;
      if (url.pathname.endsWith("/messages")) {
        expect(url.searchParams.has("friend_id")).toBe(false);
        return page(Array.from({ length: count }, (_, i) => {
          const id = offset + i + 1;
          return { id: id + 100_000, friend_id: id, friend_uid: uid(id), direction: "inbound", is_unconfirmed: id % 2 === 0,
            content: { type: "text", text: `会話${id}` }, sent_at: "2026-10-24T01:00:00Z" };
        }), next);
      }
      const tagIds = new Set(url.searchParams.getAll("include_tags[]").map(Number));
      const fieldIds = new Set(url.searchParams.getAll("include_friend_infos[]").map(Number));
      return page(Array.from({ length: count }, (_, i) => {
        const id = offset + i + 1, tagId = (id - 1) % 102 + 1, fieldId = tagId + 1000;
        return { id, uid: uid(id), name: `友だち${id}`, is_line_group: false, is_blocked: false,
          tags: tagIds.has(tagId) ? [{ id: tagId, name: `タグ${tagId}` }] : [],
          friend_infos: fieldIds.has(fieldId) ? [{ id: fieldId, name: `項目${fieldId}`, type: "numeric", value: id - 1 }] : [] };
      }), next);
    });
    const exported = await finish(source(fetchImpl).extract());
    expect(exported.resources.friends).toHaveLength(total);
    expect(exported.coverage.friendTags).toEqual({ status: "complete", count: total });
    expect(exported.coverage.friendInfoValues).toEqual({ status: "complete", count: total });
    expect(exported.coverage.conversations).toMatchObject({ status: "complete", count: total });
    let mismatches = 0;
    for (const [index, f] of exported.resources.friends.entries()) {
      const id = index + 1, tagId = index % 102 + 1;
      if (f.row.lmessage_friend_id !== id || f.row.line_friend_id !== uid(id)
        || f.detail?.tags.length !== 1 || f.detail.tags[0].tag_id !== tagId
        || f.detail.friend_info.length !== 1 || f.detail.friend_info[0].id !== tagId + 1000 || f.detail.friend_info[0].value !== index
        || f.conversation?.messages.length !== 1 || f.conversation.messages[0].message_id !== id + 100_000
        || f.conversation.messages[0].content !== `会話${id}` || f.conversation.confirm_status !== (id % 2 === 0 ? "unread" : "read")) mismatches++;
    }
    expect(mismatches).toBe(0);
    const urls = fetchImpl.mock.calls.map(([input]) => new URL(String(input)));
    expect(urls.filter(url => url.pathname.endsWith("/friends"))).toHaveLength(102);
    expect(urls.filter(url => url.pathname.endsWith("/messages"))).toHaveLength(51);
    expect(urls.some(url => /\/friends\/\d+$/.test(url.pathname))).toBe(false);
    expect(urls).toHaveLength(158);
  }, 60_000);

  it("preserves selection labels and marks unknown value shapes partial", async () => {
    const fetchImpl = api((url) => {
      if (url.pathname.endsWith("/friend-infos")) return page([
        { id: 10, name: "色", type: "select", options: [{ id: 20, value: "赤", token: "SECRET_OPTION" }] },
        { id: 11, name: "未対応", type: "string" },
      ]);
      if (url.pathname.endsWith("/friends")) return page([friend(1, { friend_infos: [
        { id: 10, name: "色", type: "select", value: "20", selected_option: { id: 20, value: "赤", client_secret: "SECRET_SELECTION" } },
        { id: 11, name: "未対応", type: "string", value: { client_secret: "SECRET_UNKNOWN" } },
      ] })]);
      return undefined;
    });
    const exported = await finish(source(fetchImpl).extract());
    expect(exported.resources.friends[0].detail?.friend_info).toEqual([{ id: 10, name: "色", type: "select", value: "赤" }]);
    expect(exported.coverage.friendInfoValues).toMatchObject({ status: "partial", count: 1 });
    expect(exported.resources.fields[0].options).toEqual([{ option_id: 20, label: "赤" }]);
    expect(JSON.stringify(exported)).not.toContain("SECRET");
  });

  it("does not turn a later-page failure into an empty or complete conversation", async () => {
    const fetchImpl = api((url) => {
      if (url.pathname.endsWith("/friends")) return page([friend()]);
      if (url.pathname.endsWith("/messages")) return url.searchParams.has("cursor")
        ? new Response("SECRET_ERROR", { status: 500 })
        : page([{ id: 10, friend_id: 1, friend_uid: uid(), direction: "inbound", content: { type: "text", text: "こんにちは" }, sent_at: "2026-10-24T01:00:00Z" }], "message-next");
      return undefined;
    });
    await expect(finish(source(fetchImpl, { maxRetries: 0 }).extract())).rejects.toMatchObject({ status: 500 });
  });

  it("keeps only known text content and reports other content as partial", async () => {
    const fetchImpl = api((url) => {
      if (url.pathname.endsWith("/friends")) return page([friend()]);
      if (url.pathname.endsWith("/messages")) return page([
        { id: 10, friend_id: 1, friend_uid: uid(), direction: "inbound", content: { type: "text", text: "こんにちは", token: "SECRET_CONTENT" }, sent_at: "2026-10-24T01:00:00Z" },
        { id: 11, friend_id: 1, friend_uid: uid(), direction: "outbound", timeline_text: "画像を送信しました", content: { type: "image", url: "https://example.invalid/SECRET_IMAGE", channel_secret: "SECRET_IMAGE" }, sent_at: "2026-10-24T02:00:00Z" },
      ]);
      return undefined;
    });
    const exported = await finish(source(fetchImpl).extract());
    expect(exported.coverage.conversations).toMatchObject({ status: "partial", count: 2 });
    expect(exported.resources.friends[0].conversation?.complete).toBe(false);
    expect(exported.resources.friends[0].conversation?.messages.map((message) => message.content)).toEqual(["こんにちは", "画像を送信しました"]);
    expect(JSON.stringify(exported)).not.toContain("SECRET");
  });

  it("leaves system notices such as tag changes out of the conversation", async () => {
    const fetchImpl = api((url) => {
      if (url.pathname.endsWith("/friends")) return page([friend()]);
      if (url.pathname.endsWith("/messages")) return page([
        { id: 10, friend_id: 1, friend_uid: uid(), direction: "inbound", content: { type: "text", text: "こんにちは" }, sent_at: "2026-10-24T01:00:00Z" },
        { id: 11, friend_id: 1, friend_uid: uid(), direction: "system", timeline_text: "タグを付与しました", content: null, sent_at: "2026-10-24T02:00:00Z" },
      ]);
      return undefined;
    });
    const exported = await finish(source(fetchImpl).extract());
    expect(exported.resources.friends[0].conversation?.messages.map((message) => message.content)).toEqual(["こんにちは"]);
    expect(exported.resources.friends[0].conversation?.complete).toBe(true);
    expect(exported.coverage.conversations).toMatchObject({ status: "complete", count: 1 });
    expect(exported.coverage.conversations.note).toContain("システム通知1件");
  });

  it("stops without retrying once cancelled, even while waiting for a retry", async () => {
    const controller = new AbortController();
    const fetchImpl = api((url) => {
      if (url.pathname.endsWith("/tags")) {
        controller.abort();
        return new Response("busy", { status: 503 });
      }
      return undefined;
    });
    await expect(finish(source(fetchImpl, { signal: controller.signal }).extract())).rejects.toThrow("取得を中止しました");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not send any request after the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = api();
    await expect(finish(source(fetchImpl, { signal: controller.signal }).doctor())).rejects.toThrow("取得を中止しました");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("marks a conversation unread when an inbound message is unconfirmed", async () => {
    const fetchImpl = api((url) => {
      if (url.pathname.endsWith("/friends")) return page([friend()]);
      if (url.pathname.endsWith("/messages")) return page([
        { id: 10, friend_id: 1, friend_uid: uid(), direction: "inbound", is_unconfirmed: true, content: { type: "text", text: "未読です" }, sent_at: "2026-10-24T01:00:00Z" },
      ]);
      return undefined;
    });
    const exported = await finish(source(fetchImpl).extract());
    expect(exported.resources.friends[0].conversation?.confirm_status).toBe("unread");
  });

  it("exports template metadata without inventing content or scenarios", async () => {
    const fetchImpl = api((url) => url.pathname.endsWith("/templates")
      ? page([{ id: 4, name: "ご案内", type: "text", folder_id: 3, content: { text: "SECRET_UNDOCUMENTED_CONTENT" } }])
      : undefined);
    const exported = await finish(source(fetchImpl).extract());
    expect(exported.resources.templates).toEqual([{ id: 4, name: "ご案内", type: "text", category_id: 3 }]);
    expect(exported.coverage.templates.status).toBe("partial");
    expect(exported.coverage.templateContents.status).toBe("unsupported");
    expect(exported.coverage.scenarios.status).toBe("unsupported");
    expect(exported.resources.forms).toEqual([]);
    expect(JSON.stringify(exported)).not.toContain("SECRET");
  });

  it("keeps traffic source IDs and names without inventing an unavailable code", async () => {
    const fetchImpl = api((url) => url.pathname.endsWith("/touchpoints")
      ? page([{ id: 12, name: "店頭QR", folder_id: 5, client_secret: "SECRET_TOUCHPOINT" }]) : undefined);
    const exported = await finish(source(fetchImpl).extract());
    expect(exported.resources.trafficSources).toEqual([{ id: 12, name: "店頭QR" }]);
    expect(exported.resources.trafficSources[0]).not.toHaveProperty("code");
    expect(exported.coverage.trafficSources.status).toBe("partial");
    expect(JSON.stringify(exported)).not.toContain("SECRET");
  });

  it("reads supplied form IDs and reports anonymous or unavailable answers", async () => {
    const fetchImpl = api((url) => url.pathname.endsWith("/forms/10/answers") ? page([
      { id: 80, friend_id: 1, friend_uid: uid(), answered_at: "2026-10-24T03:00:00Z", time_to_submit_seconds: 5, client_secret: "SECRET_FORM", answers: [
        { id: "q1", title: "名前", type: "text", answered: true, value: "山田", api_key: "SECRET_ANSWER" },
        { id: "q2", title: "希望", type: "choice", answered: true, value: { selected: ["相談"], others: [{ label: "その他", text: "資料", api_key: "SECRET_CHOICE" }], channel_secret: "SECRET_VALUE" } },
        { id: "q3", title: "ファイル", type: "file", answered: true },
      ] },
      { id: 81, friend_id: null, friend_uid: null, answered_at: "2026-10-24T04:00:00Z", answers: [] },
    ]) : undefined);
    const exported = await finish(source(fetchImpl, { formIds: [10] }).extract());
    expect(exported.resources.formResponses["10"]).toHaveLength(1);
    expect(exported.resources.formResponses["10"][0].answers).toHaveLength(2);
    expect(exported.coverage["formResponses:10"]).toMatchObject({ status: "partial", count: 1 });
    expect(exported.coverage.forms.status).toBe("unsupported");
    expect(JSON.stringify(exported)).not.toContain("SECRET");
  });

  it("enforces a minimum 100ms interval even when configured lower", async () => {
    const stamps: number[] = [];
    const fetchImpl = api(() => { stamps.push(Date.now()); return undefined; });
    await finish(source(fetchImpl, { intervalMs: 0 }).extract());
    expect(stamps.length).toBeGreaterThan(4);
    for (let index = 1; index < stamps.length; index += 1) {
      expect(stamps[index] - stamps[index - 1]).toBeGreaterThanOrEqual(100);
    }
  });

  it("does not leak fetch exceptions or redirect credentials", async () => {
    const fetchImpl = api(() => { throw new Error("SECRET_TOKEN https://example.invalid"); });
    let failure: unknown;
    try { await finish(source(fetchImpl, { maxRetries: 0 }).doctor()); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(LstepApiError);
    expect(String(failure)).not.toContain("SECRET");
    expect(JSON.stringify(failure)).not.toContain("SECRET");
    const redirect = api(() => new Response("SECRET_REDIRECT", { status: 307, headers: { Location: "https://untrusted.invalid" } }));
    await expect(finish(source(redirect).doctor())).rejects.toMatchObject({ status: 307 });
    expect(redirect).toHaveBeenCalledTimes(1);
  });
});
