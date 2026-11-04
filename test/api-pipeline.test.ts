import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalD1 } from "../src/d1/local.js";
import { harnessId } from "../src/harness/ids.js";
import { LstepApiSource } from "../src/lstep/api.js";
import { applyLocal, createPlan, verifyLocal, writeSourceSnapshot } from "../src/pipeline.js";

const SCHEMA = fileURLToPath(new URL("../schema/line-harness-bootstrap.sql", import.meta.url));
const ACCOUNT = "fictional-api-target";
const HANAKO_UID = "U11111111111111111111111111111111";
const TARO_UID = "U22222222222222222222222222222222";
const HANAKO_NAME = "架空花子🌸 \"A'\"\n二行目";
const CONSULTATION = "製造業 \"A社\" / 'B店'\n架空県🌾";
const TEMPORARIES: string[] = [];

function response(url: URL, data: unknown[], next: string | null = null): Response {
  return Response.json({
    data, path: url.pathname, per_page: 1000, next_cursor: next,
    next_page_url: next ? `https://api.lineml.jp${url.pathname}?cursor=${next}` : null,
    prev_cursor: null, prev_page_url: null, channel_secret: "UNEXPECTED_SECRET_ENVELOPE",
  });
}

function officialApi() {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe("https://api.lineml.jp");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    switch (url.pathname) {
      case "/v2/api/tags":
        return response(url, [
          { id: 101, name: "資料請求'済み📩", folder_id: 11 },
          { id: 102, name: "回答済み✅", folder_id: null },
        ]);
      case "/v2/api/friend-infos":
        return response(url, [
          { id: 201, name: "相談'内容📩", type: "string", folder_id: 12 },
          { id: 202, name: "好きな色", type: "select", folder_id: 12, options: [
            { id: 501, value: "赤🌸", color: "#FF0000" },
            { id: 502, value: "青🍁", color: "#0000FF" },
          ] },
          { id: 203, name: "ポイント", type: "numeric", folder_id: null },
        ]);
      case "/v2/api/taiou-marks":
        return response(url, [{ id: 301, name: "対応中" }, { id: 302, name: "対応済み" }]);
      case "/v2/api/touchpoints":
        return response(url, [{ id: 801, name: "架空の店頭QR", folder_id: null }]);
      case "/v2/api/templates":
        return response(url, [{ id: 401, name: "本文を取得していない案内", type: "text", folder_id: 13 }]);
      case "/v2/api/friends": {
        if (url.searchParams.get("limit") !== "1") {
          expect(url.searchParams.getAll("include_tags[]")).toEqual(["101", "102"]);
          expect(url.searchParams.getAll("include_friend_infos[]")).toEqual(["201", "202", "203"]);
          expect(url.searchParams.getAll("display_status[]")).toEqual(["normal", "block", "hide"]);
        }
        if (url.searchParams.get("cursor") === "friend-second") return response(url, [{
          id: 1002, uid: TARO_UID, name: "架空太郎🍁", full_name: "太郎", system_name: "管理用の太郎",
          taiou_mark: { id: 302, name: "対応済み" }, taiou_mark_updated_at: "2026-10-23T10:00:00+09:00",
          is_line_group: false, is_blocked: true, display_status: "block",
          created_at: "2026-10-02T12:00:00+09:00", memo: "ブロック中の架空人物",
          tags: [{ id: 101, name: "資料請求'済み📩", attached_at: "2026-10-02T12:05:00+09:00" }],
          friend_infos: [
            { id: 201, name: "相談'内容📩", type: "string", value: "引用符 ' と \" と改行\n確認🍁" },
            { id: 202, name: "好きな色", type: "select", value: "502", selected_option: { id: 502, value: "青🍁", color: "#0000FF" } },
            { id: 203, name: "ポイント", type: "numeric", value: 12345.5 },
          ],
        }]);
        return response(url, [{
          id: 1001, uid: HANAKO_UID, name: HANAKO_NAME, full_name: "花子", system_name: "管理用の花子",
          taiou_mark: { id: 301, name: "対応中" }, taiou_mark_updated_at: "2026-10-23T09:00:00+09:00",
          is_line_group: false, is_blocked: false, display_status: "normal",
          created_at: "2026-10-01T09:00:00+09:00", memo: "架空の相談メモ🌾",
          tags: [
            { id: 101, name: "資料請求'済み📩", attached_at: "2026-10-01T09:05:00+09:00" },
            { id: 102, name: "回答済み✅", attached_at: "2026-10-03T10:00:00+09:00" },
          ],
          friend_infos: [
            { id: 201, name: "相談'内容📩", type: "string", value: CONSULTATION },
            { id: 202, name: "好きな色", type: "select", value: "501", selected_option: { id: 501, value: "赤🌸", color: "#FF0000" } },
            { id: 203, name: "ポイント", type: "numeric", value: 0 },
          ],
          channel_secret: "UNEXPECTED_SECRET_FRIEND",
        }], "friend-second");
      }
      case "/v2/api/messages": {
        expect(url.searchParams.has("friend_id")).toBe(false);
        expect(url.searchParams.get("sort_order")).toBe("asc");
        expect(url.searchParams.get("limit")).toBe("1000");
        if (url.searchParams.get("cursor") === "message-second") return response(url, [
          {
            id: 4002, friend_id: 1001, friend_uid: HANAKO_UID, direction: "outbound",
            timeline_text: "承りました", content: { type: "text", text: "承りました。\"ご相談\"ありがとうございます📩" },
            sent_at: "2026-10-21T01:05:00Z", is_unconfirmed: false,
            staff: { id: 901, name: "架空スタッフ" }, sender_decoration: { display_name: "相談窓口" },
          },
          {
            id: 4003, friend_id: 1002, friend_uid: TARO_UID, direction: "inbound",
            timeline_text: "別の相談です🍁", content: { type: "text", text: "別の相談です🍁" },
            sent_at: "2026-10-22T01:00:00Z", is_unconfirmed: false,
          },
        ]);
        return response(url, [{
          id: 4001, friend_id: 1001, friend_uid: HANAKO_UID, direction: "inbound",
          timeline_text: "こんにちは", content: { type: "text", text: "こんにちは😊\n'A社'について相談です。", api_token: "UNEXPECTED_SECRET_MESSAGE" },
          sent_at: "2026-10-21T01:00:00Z", is_unconfirmed: false,
        }], "message-second");
      }
      case "/v2/api/forms/601/answers":
        return response(url, [{
          id: 7001, friend_id: 1001, friend_uid: HANAKO_UID,
          answered_at: "2026-10-23T10:30:00+09:00", time_to_submit_seconds: 120,
          answers: [
            { id: "bl001", type: "text", title: "相談内容", answered: true, value: CONSULTATION },
            { id: "bl002", type: "choice", title: "希望", answered: true, value: {
              selected: ["資料📩"], others: [{ label: "その他", text: "説明会🌾" }],
            } },
          ],
        }]);
      default:
        throw new Error("結合試験に定義していないAPI呼び出しです");
    }
  });
}

async function finish<T>(operation: Promise<T>): Promise<T> {
  const settled = operation.then(
    value => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const result = await settled;
  if (!result.ok) throw result.error;
  return result.value;
}

async function prepare() {
  const directory = mkdtempSync(join(tmpdir(), "lstep-api-pipeline-"));
  TEMPORARIES.push(directory);
  const fetchImpl = officialApi();
  const client = new LstepApiSource({
    token: "fictional-source-api-token", accountId: "fictional-source-account", fetchImpl,
    intervalMs: 100, maxRetries: 0, formIds: [601],
  });
  await finish(client.doctor());
  const exported = await finish(client.extract());
  const snapshotDir = join(directory, "snapshot");
  const outDir = join(directory, "out");
  const dbPath = join(directory, "test.sqlite");
  const snapshot = writeSourceSnapshot(exported, snapshotDir);
  const manifest = createPlan(snapshotDir, outDir, ACCOUNT);
  const database = new LocalD1(dbPath);
  try {
    database.loadSchema(SCHEMA);
    database.db.prepare("INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret,is_active) VALUES (?,?,?,?,?,0)")
      .run(ACCOUNT, "fictional-api-channel", "API結合試験用の架空アカウント", "fictional-token", "fictional-secret");
  } finally { database.close(); }
  return { directory, fetchImpl, exported, snapshot, snapshotDir, outDir, dbPath, manifest };
}

type Prepared = Awaited<ReturnType<typeof prepare>>;

function inspect<Result>(prepared: Prepared, callback: (database: LocalD1) => Result): Result {
  const database = new LocalD1(prepared.dbPath);
  try { return callback(database); }
  finally { database.close(); }
}

function apply(prepared: Prepared) {
  return applyLocal(prepared.outDir, prepared.dbPath, true);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T01:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  for (const directory of TEMPORARIES.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("official API mock → source snapshot → plan → real L Harness SQLite schema → verification", () => {
  it("migrates identities, tags, string/select/numeric values, handling marks and blocked state", async () => {
    const prepared = await prepare();
    expect(prepared.snapshot.friendCount()).toBe(2);
    expect(prepared.snapshot.readFriend(1001)?.detail?.friend_info).toEqual([
      { id: 201, name: "相談'内容📩", type: "string", value: CONSULTATION },
      { id: 202, name: "好きな色", type: "select", value: "赤🌸" },
      { id: 203, name: "ポイント", type: "numeric", value: 0 },
    ]);
    expect(prepared.snapshot.readJson("fields.json")).toEqual([
      { id: 201, title: "相談'内容📩", type: "string" },
      { id: 202, title: "好きな色", type: "select", options: [{ option_id: 501, label: "赤🌸" }, { option_id: 502, label: "青🍁" }] },
      { id: 203, title: "ポイント", type: "numeric" },
    ]);
    const applied = apply(prepared);
    expect(applied.checked).toBeGreaterThan(0);
    expect(applied.partial).toBe(true);
    inspect(prepared, database => {
      const friends = database.all<{ id: string; line_user_id: string; display_name: string; is_following: number; metadata: string }>(
        "SELECT id,line_user_id,display_name,is_following,metadata FROM friends ORDER BY line_user_id",
      );
      expect(friends).toHaveLength(2);
      expect(friends[0]).toMatchObject({
        id: harnessId("friend", ACCOUNT, 1001), line_user_id: HANAKO_UID, display_name: HANAKO_NAME, is_following: 1,
      });
      expect(friends[1]).toMatchObject({
        id: harnessId("friend", ACCOUNT, 1002), line_user_id: TARO_UID, display_name: "架空太郎🍁", is_following: 0,
      });
      const hanako = JSON.parse(friends[0].metadata);
      const taro = JSON.parse(friends[1].metadata);
      expect(hanako["相談'内容📩"]).toBe(CONSULTATION);
      expect(hanako["好きな色"]).toBe("赤🌸");
      expect(hanako["ポイント"]).toBe(0);
      expect(taro["好きな色"]).toBe("青🍁");
      expect(taro["ポイント"]).toBe(12345.5);
      expect(hanako.handling_status).toBe("対応中");
      expect(taro.handling_status).toBe("対応済み");
      expect(hanako._lstep.friend_info["201"]).toEqual({ title: "相談'内容📩", value: CONSULTATION });
      expect(hanako._lstep.friend_info["203"]).toEqual({ title: "ポイント", value: 0 });
      expect(hanako._lme).toBeUndefined();
      const tags = database.all<{ line_user_id: string; name: string }>(
        "SELECT f.line_user_id,t.name FROM friend_tags ft JOIN tags t ON t.id=ft.tag_id JOIN friends f ON f.id=ft.friend_id ORDER BY f.line_user_id,t.name",
      );
      expect(tags.filter(tag => tag.line_user_id === HANAKO_UID).map(tag => tag.name).sort())
        .toEqual(["資料請求'済み📩", "回答済み✅", "対応:対応中"].sort());
      expect(tags.filter(tag => tag.line_user_id === TARO_UID).map(tag => tag.name).sort())
        .toEqual(["資料請求'済み📩", "対応:対応済み"].sort());
      expect(database.all<{ notes: string }>("SELECT c.notes FROM chats c JOIN friends f ON f.id=c.friend_id WHERE f.line_user_id=?", HANAKO_UID))
        .toEqual([{ notes: "対応ステータス: 対応中" }]);
      expect(database.all("PRAGMA foreign_key_check")).toEqual([]);
    });
    expect(verifyLocal(prepared.outDir, prepared.dbPath)).toEqual(applied);
    const stored = readFileSync(join(prepared.snapshotDir, "source.json"), "utf8");
    expect(stored).not.toContain("UNEXPECTED_SECRET");
    expect(stored).not.toContain("fictional-source-api-token");
  });

  it("migrates both message directions and every global page to the correct friends with exact text", async () => {
    const prepared = await prepare();
    apply(prepared);
    inspect(prepared, database => {
      expect(database.all<{ line_user_id: string; direction: string; content: string }>(
        "SELECT f.line_user_id,m.direction,m.content FROM messages_log m JOIN friends f ON f.id=m.friend_id ORDER BY f.line_user_id,m.created_at",
      )).toEqual([
        { line_user_id: HANAKO_UID, direction: "incoming", content: "こんにちは😊\n'A社'について相談です。" },
        { line_user_id: HANAKO_UID, direction: "outgoing", content: "承りました。\"ご相談\"ありがとうございます📩" },
        { line_user_id: TARO_UID, direction: "incoming", content: "別の相談です🍁" },
      ]);
      expect(database.count("messages_log")).toBe(3);
    });
    const messageRequests = prepared.fetchImpl.mock.calls.map(([input]) => new URL(String(input)))
      .filter(url => url.pathname.endsWith("/messages"));
    expect(messageRequests).toHaveLength(2);
    expect(messageRequests.every(url => !url.searchParams.has("friend_id"))).toBe(true);
    expect(messageRequests.map(url => url.searchParams.get("cursor"))).toEqual([null, "message-second"]);
    expect(verifyLocal(prepared.outDir, prepared.dbPath).partial).toBe(true);
  });

  it("retains form answers and route names without inventing missing forms, templates, scenarios or routes", async () => {
    const prepared = await prepare();
    apply(prepared);
    expect(prepared.snapshot.readJson("form_responses/601.json")).toEqual([{
      id: 7001, lmessage_friend_id: 1001, line_friend_id: HANAKO_UID,
      answered_at: "2026-10-23T10:30:00+09:00", duration: "120", answers: [
        { name: "相談内容", type: "text", value: CONSULTATION },
        { name: "希望", type: "choice", value: { selected: ["資料📩"], others: [{ label: "その他", text: "説明会🌾" }] } },
      ],
    }]);
    expect(prepared.snapshot.readJson("traffic_sources.json")).toEqual([{ id: 801, name: "架空の店頭QR" }]);
    expect(prepared.snapshot.readJson("templates.json")).toEqual([{ id: 401, name: "本文を取得していない案内", type: "text", category_id: 13 }]);
    expect(prepared.snapshot.readJson("template_details.json")).toBeNull();
    expect(prepared.snapshot.readJson("forms.json")).toEqual([]);
    expect(prepared.snapshot.readJson("scenarios.json")).toEqual([]);
    expect(prepared.manifest.reports.retained_responses).toMatchObject({ source: 1, level: "manual", migrated: 0 });
    expect(prepared.manifest.reports.templates).toMatchObject({ source: 1, level: "none", migrated: 0 });
    expect(prepared.manifest.reports.traffic_sources).toMatchObject({ source: 1, skipped: 1, level: "partial", migrated: 0 });
    const report = readFileSync(join(prepared.outDir, "report.md"), "utf8");
    expect(report).toContain("設問未取得のフォーム回答");
    expect(report).toContain("フォームの設問がないため移行先へは投入していません");
    expect(report).toContain("流入経路のコード未取得");
    inspect(prepared, database => {
      for (const table of ["templates", "message_templates", "forms", "form_submissions", "scenarios", "scenario_steps", "friend_scenarios", "entry_routes"]) {
        expect(database.count(table), table).toBe(0);
      }
      expect(database.all("SELECT id FROM auto_replies WHERE line_account_id=?", ACCOUNT)).toEqual([]);
    });
    expect(verifyLocal(prepared.outDir, prepared.dbPath).checked).toBeGreaterThan(0);
  });

  it("requires allowPartial before making any migration writes", async () => {
    const prepared = await prepare();
    expect(() => applyLocal(prepared.outDir, prepared.dbPath)).toThrow("--allow-partial");
    inspect(prepared, database => {
      expect(database.count("friends")).toBe(0);
      expect(database.count("tags")).toBe(0);
      expect(database.count("messages_log")).toBe(0);
      expect(database.all("SELECT id FROM line_accounts")).toEqual([{ id: ACCOUNT }]);
    });
    const applied = apply(prepared);
    expect(applied.partial).toBe(true);
    expect(verifyLocal(prepared.outDir, prepared.dbPath)).toEqual(applied);
  });
});
