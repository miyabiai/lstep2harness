import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { importBrowserExport } from "../src/lstep/browser.js";

const uid = `U${"a".repeat(32)}`;
const exportedAt = "2026-10-24T10:00:00Z";
const secret = "DO_NOT_EXPORT_ACCOUNT_SECRET";

function capture() {
  return {
    format: "lstep-browser-v1", account: { id: "test-account", label: "移行試験", inner_api_secret: secret },
    exportedAt, user: { secret },
    data: {
      friends: [{
        id: 12, uid, name: "テスト花子🌸", isBlocked: false, createdAt: exportedAt, user: { inner_api_secret: secret },
        tags: [{ id: 1, name: "資料請求済み" }],
        fields: [{ id: 2, name: "業種", value: { value: "相談業", inner_api_secret: secret } }],
        scenarios: [{ id: 3, name: "移行案内", status: "following", started_at: exportedAt }],
        timeline: { complete: true, messages: [{ message_id: 8, sender: "friend", message_type: "text", content: "こんにちは😊", sent_at: exportedAt, user: { secret } }] },
      }],
      tags: [{ id: 1, name: "資料請求済み", user: { secret } }],
      fields: [{ id: 2, title: "業種", type: "TEXT", options: [] }],
      templates: [{ id: 4, name: "日本語テンプレート", type: "text", content: "案内です📩", user: { secret } }],
      scenarios: [{ id: 3, name: "移行案内", steps: [{
        id: 30, order_number: 1, delay_type: "immediate",
        templates: [{ id: 4, type: "text", content: "案内です📩", user: { secret } }],
        actions: [{ id: 5, type: "tag", data: { ids: [1], action: 1, inner_api_secret: secret } }],
      }] }],
      forms: [{ id: 6, name: "移行診断", title: "相談はこちら🌸", pages: [{ page_id: 1, fields: [
        { id: 60, type: "text", title: "お名前", rules: { required: true, inner_api_secret: secret }, settings: {} },
        { id: 61, type: "textarea", title: "相談内容", settings: {} },
        { id: 62, type: "radio", title: "希望", settings: { items: [{ label: "はい😊", value: "yes", secret }], tagIds: [1] } },
        { id: 63, type: "checkbox", title: "複数選択", settings: { multiple: true, items: [{ label: "A", value: "A" }, { label: "B", value: "B" }] } },
        { id: 64, type: "date", title: "相談希望日", settings: { friendInfoIds: [2] } },
        { id: 65, type: "email", title: "メール", settings: {} },
        { id: 66, type: "file", title: "添付", settings: {} },
      ] }] }],
      formResponses: { "6": [{ id: 7, memberId: 12, answeredAt: exportedAt, user: { secret }, answers: [
        { name: "お名前", type: "text", value: "テスト花子🌸" },
        { name: "相談内容", type: "textarea", value: "1行目\n2行目" },
        { name: "複数選択", type: "checkbox", value: ["A", "B"] },
        { name: "相談希望日", type: "date", value: { date: "2026-11-01", time: "10:00", inner_api_secret: secret } },
      ] }] },
    },
    coverage: { friends: { status: "partial", count: 1, note: "指定した友だちのみ" }, conversations: { status: "complete", count: 1 } },
  };
}

describe("importBrowserExport", () => {
  it("preserves Japanese, emoji, tags, scenario state, conversation, diverse form fields and answers", () => {
    const result = importBrowserExport(capture());
    const friend = result.resources.friends[0];
    expect(result.route).toBe("browser");
    expect(friend.row.line_friend_id).toBe(uid);
    expect(friend.row.line_name).toBe("テスト花子🌸");
    expect(friend.detail?.tags).toEqual([{ tag_id: 1, tag_name: "資料請求済み" }]);
    expect(friend.detail?.friend_info[0].value).toEqual({ value: "相談業" });
    expect(friend.detail?.scenarios[0].status).toBe("following");
    expect(friend.conversation?.messages[0].content).toBe("こんにちは😊");
    expect(result.resources.forms[0].pages[0].fields.map(field => field.type)).toEqual(["text", "textarea", "radio", "checkbox", "date", "email", "file"]);
    expect(JSON.parse(result.resources.forms[0].pages[0].fields[2].settings!)).toMatchObject({ items: [{ label: "はい😊", value: "yes" }], tagIds: [1] });
    expect(result.resources.formResponses["6"][0].line_friend_id).toBe(uid);
    expect(result.resources.formResponses["6"][0].answers[2].value).toEqual(["A", "B"]);
    expect(result.resources.formResponses["6"][0].answers[3].value).toEqual({ date: "2026-11-01", time: "10:00" });
    expect(result.coverage.formBehavior.status).toBe("partial");
    expect(result.coverage.autoReplies.status).toBe("unsupported");
    expect(result.coverage.fields.note).toBe("未取得");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("inner_api_secret");
  });

  it("rejects missing UID rather than matching the display name", () => {
    const input = capture();
    input.data.friends[0].uid = "";
    expect(() => importBrowserExport(input)).toThrow("LINEユーザーIDが無い友だちがいます");
  });

  it("rejects duplicate identities and unrelated formats", () => {
    const input = capture();
    input.data.friends.push({ ...input.data.friends[0], id: 99 });
    expect(() => importBrowserExport(input)).toThrow("重複");
    expect(() => importBrowserExport({ format: "other" })).toThrow("形式が違います");
  });

  it("marks a scenario incomplete when a step's schedule cannot be interpreted, so the target's steps are left alone", () => {
    const raw = capture();
    raw.data.scenarios[0].steps.push({ id: 31, order_number: 2, delay_type: "weird", templates: [{ id: 5, type: "text", content: "二通目" }], actions: [] });
    const result = importBrowserExport(raw);
    expect(result.resources.scenarios[0].incomplete).toBe(true);
    expect(result.resources.scenarios[0].steps).toHaveLength(1);
    expect(importBrowserExport(capture()).resources.scenarios[0].incomplete).toBeUndefined();
  });

  it("downgrades incomplete conversations even when the file claims complete", () => {
    const input = capture();
    input.data.friends[0].timeline.complete = false;
    expect(importBrowserExport(input).coverage.conversations.status).toBe("partial");
  });

  it("excludes unknown form parts and undecodable schedules from migration", () => {
    const input = capture();
    input.data.forms[0].pages[0].fields[0].type = "unknown-widget";
    input.data.scenarios[0].steps[0].delay_type = "unsupported";
    const converted = importBrowserExport(input);
    expect(converted.resources.forms[0].pages[0].fields).toHaveLength(6);
    expect(converted.resources.scenarios[0].steps).toEqual([]);
    expect(converted.coverage.forms.note).toContain("未対応の設問");
    expect(converted.coverage.scenarios.note).toContain("日時を解釈できない");
  });
});

function page(data: unknown[]) {
  return { current_page: 1, last_page: 1, data };
}

function timelinePath(page: number, cursor?: string) {
  return `/api/v1/message/timeline/messages?pattern=memberDetail&takeNum=50&hasCurrentItems=0&page=${page}&viewOptionMode=normal&memberId=12&detail_view_received=1&detail_view_received_trivial=1&detail_view_received_reactioned=1&detail_view_sent=1&detail_view_system=1&cng=cng${cursor ? `&paginateAllCursorId=${encodeURIComponent(cursor)}` : ""}`;
}

async function runExporter(overrides: Record<string, unknown> = {}, missingUid = false, routeOverrides: Record<string, unknown> = {}, transientFailures: Record<string, number> = {}) {
  const routes: Record<string, unknown> = {
    "/api/tags?page=1": page([{ id: 1, name: "資料請求済み", user: { secret } }]),
    "/api/user-vars?page=1": page([{ id: 2, name: "業種", type: 0, user: { secret } }]),
    "/api/templates?page=1": page([{ id: 4, name: "案内", content_text: "こんにちは🌸", user: { secret } }]),
    "/api/content-groups?page=1": page([{ id: 3, name: "移行案内" }]),
    "/api/content-groups/3": { contents: [{ id: 30, is_initial: true, egg: { simple: "登録ありがとう😊", user: { secret } }, action: { id: 5 } }] },
    "/api/actions/5": { inputs: [{ type: 13, tag_ids: [1], user: { secret } }, { type: 999, secret }] },
    "/api/forms?page=1": page([{ id: 6, name: "移行診断" }]),
    "/api/forms/6": { title: "相談はこちら🌸", user: { secret }, sections: [{ id: 60, blocks: [
      { id: 61, type: "text", title: "業種", friendInfoIds: [2], required: true, user: { secret } },
      { id: 62, type: "checkbox", title: "希望", options: [{ label: "相談", value: "yes", tagIds: [1], secret }] },
      { id: 63, type: "date", title: "希望日" },
      { id: 64, type: "file", title: "添付" },
      { id: 65, type: "unknown-widget", title: "複雑な項目", user: { secret } },
    ] }] },
    "/api/forms/6/answers?page=1": page([{ id: 7, member_id: 12, created_at: exportedAt, user: { secret }, answers: [
      { title: "業種", type: "text", value: "相談業🌸", user: { secret } },
      { title: "希望日", type: "date", value: { date: "2026-11-01", inner_api_secret: secret } },
    ] }]),
    "/api/member/12/data": { id: 12, uid: missingUid ? "" : uid, name: "テスト花子🌸", isBlocked: false, createdAt: exportedAt,
      user: { inner_api_secret: secret, payment: { card: secret } }, tags: [{ id: 1, name: "資料請求済み" }],
      friendInfo: [{ id: 2, name: "業種", value: { value: "相談業", inner_api_secret: secret } }],
    },
    "/api/member/var/12": { values: { "2": "相談業" }, metas: { "2": null }, user: { secret } },
    "/api/v1/members/12/scenario-status": { scenarios: [{ id: 3, name: "移行案内", status: "following" }] },
    [timelinePath(1)]: { messages: [{ id: 8, fromOwner: false, fromSystem: false, contentText: "こんにちは😊", createdAt: exportedAt, user: { secret } }], paginateHasNext: true, paginateAllCursorId: "next-cursor" },
    [timelinePath(2, "next-cursor")]: { messages: [{ id: 9, fromOwner: true, fromSystem: false, contentText: "回答ありがとう", createdAt: exportedAt }], paginateHasNext: false },
  };
  Object.assign(routes, routeOverrides);
  const calls: Array<{ path: string; options: RequestInit }> = [];
  const waits: number[] = [];
  const downloads: string[] = [];
  const warnings: string[] = [];
  class ExportUrl extends URL {
    static createObjectURL() { return "blob:test"; }
    static revokeObjectURL() { return; }
  }
  const context: Record<string, unknown> = {
    location: { origin: "https://manager.linestep.net" },
    LSTEP_EXPORT_OPTIONS: { accountId: "test-account", friendIds: [12], intervalMs: 1, ...overrides },
    document: {
      querySelector: () => ({ content: "csrf-token-value" }),
      createElement: () => ({ click: () => undefined }),
    },
    fetch: async (path: string, options: RequestInit) => {
      calls.push({ path, options });
      if (transientFailures[path]) { transientFailures[path] -= 1; return { ok: false, status: 503 }; }
      if (!(path in routes)) return { ok: false, status: 404 };
      return { ok: true, json: async () => routes[path], text: async () => String(routes[path]) };
    },
    setTimeout: (callback: () => void, milliseconds: number) => { waits.push(milliseconds); callback(); },
    URL: ExportUrl,
    Blob: class { constructor(parts: string[]) { downloads.push(parts.join("")); } },
    DOMParser: class { parseFromString() { return { querySelectorAll: () => [], querySelector: () => null }; } },
    console: { info: () => undefined, warn: (message: string) => warnings.push(message) },
  };
  const source = readFileSync(new URL("../browser/export.js", import.meta.url), "utf8");
  const output = await runInNewContext(source, context);
  return { output, calls, waits, downloads, warnings, context };
}

describe("in-browser read-only exporter", () => {
  it("returns only allowlisted data without saving a file and follows all conversation pages", async () => {
    const { output, calls, waits, downloads } = await runExporter();
    expect(calls.every(call => call.options.method === "GET")).toBe(true);
    expect(calls.every(call => call.path.startsWith("/api/"))).toBe(true);
    expect(calls.find(call => call.path === "/api/member/12/data")).toBeDefined();
    expect(calls.some(call => call.path.includes("source="))).toBe(false);
    expect(calls.every(call => call.options.credentials === "same-origin" && call.options.redirect === "error")).toBe(true);
    expect(waits.some(wait => wait >= 1000)).toBe(true);
    // 取得結果はファイルに保存せず、呼び出し元へ返すだけ
    expect(downloads).toHaveLength(0);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("inner_api_secret");
    expect(serialized).not.toContain("csrf-token-value");
    expect(output.coverage.scenarioActions.status).toBe("partial");
    expect(output.coverage.forms.status).toBe("partial");
    expect(output.coverage.formBehavior.status).toBe("partial");
    const converted = importBrowserExport(output);
    expect(converted.resources.friends[0].conversation?.messages).toHaveLength(2);
    expect(converted.resources.friends[0].conversation?.complete).toBe(true);
    expect(converted.resources.formResponses["6"][0].answers[0].value).toBe("相談業🌸");
    expect(converted.resources.scenarios[0].steps[0].actions?.[0].data).toEqual({ ids: [1], action: 1 });
  });

  it("retries a temporary server error instead of dropping the friend", async () => {
    const { output, calls } = await runExporter({ download: false }, false, {}, { "/api/member/12/data": 2 });
    expect(calls.filter(call => call.path === "/api/member/12/data")).toHaveLength(3);
    expect(output.data.friends).toHaveLength(1);
  });

  it("gives up after repeated server errors and reports the friend as missing", async () => {
    const { output, calls } = await runExporter({ download: false }, false, {}, { "/api/member/12/data": 3 });
    expect(calls.filter(call => call.path === "/api/member/12/data")).toHaveLength(3);
    expect(output.data.friends).toEqual([]);
    expect(output.coverage.friends.status).toBe("partial");
  });

  it("excludes members without UID and records partial coverage", async () => {
    const { output } = await runExporter({ download: false }, true);
    expect(output.data.friends).toEqual([]);
    expect(output.coverage.friends.status).toBe("partial");
    expect(output.coverage.friends.note).toContain("LINEユーザーIDが未取得");
    expect(output.coverage.conversations.status).toBe("partial");
  });

  it("rejects URL injection through member IDs", async () => {
    await expect(runExporter({ friendIds: ["12/data?source=evil"] })).rejects.toThrow("管理番号だけ");
  });

  it("records pagination caps instead of claiming complete history", async () => {
    const { output } = await runExporter({ maxPages: 1, download: false });
    expect(output.data.friends[0].timeline.complete).toBe(false);
    expect(output.coverage.conversations.status).toBe("partial");
  });

  it("keeps selected/others answer values and marks unknown answer shapes as unsupported instead of emptying them", async () => {
    const { output } = await runExporter({ download: false }, false, {
      "/api/forms/6/answers?page=1": page([{ id: 7, member_id: 12, created_at: exportedAt, answers: [
        { title: "希望", type: "checkbox", value: { selected: ["相談", "資料"], others: "その他の希望" } },
        { title: "謎", type: "widget", value: { mystery: "知らない形" } },
      ] }]),
    });
    const [kept, unknown] = output.data.formResponses["6"][0].answers;
    expect(kept.value).toEqual({ selected: ["相談", "資料"], others: "その他の希望" });
    expect(unknown.value).toEqual({ unsupported: true });
    const imported = importBrowserExport(output);
    expect(imported.resources.formResponses["6"][0].answers[1].value).toEqual({ unsupported: true });
    expect(imported.coverage.formResponses.status).toBe("partial");
  });

  it("marks scenarios and forms incomplete when their structure cannot be read, instead of exporting them as empty", async () => {
    const { output } = await runExporter({ download: false }, false, {
      "/api/content-groups/3": { contents: [{ is_initial: true, egg: { simple: "管理番号が無いステップ" } }, { id: 30, is_initial: true, egg: { simple: "登録ありがとう😊" }, action: { id: 5 } }] },
      "/api/forms/6": { title: "相談はこちら🌸", sections: [{ id: 60, blocks: "broken" }] },
    });
    expect(output.data.scenarios[0].incomplete).toBe(true);
    expect(output.data.scenarios[0].steps).toHaveLength(1);
    expect(output.data.forms[0].incomplete).toBe(true);
    // アクションの詳細が取れなかったときも、到達時のタグが抜けたまま入れないよう取得不完全にする
    const failedAction = await runExporter({ download: false }, false, {}, { "/api/actions/5": 99 });
    expect(failedAction.output.data.scenarios[0].incomplete).toBe(true);
    // 普通に取れたときは印が付かない
    const normal = await runExporter({ download: false });
    expect(normal.output.data.scenarios[0].incomplete).toBeUndefined();
    expect(normal.output.data.forms[0].incomplete).toBeUndefined();
  });

  it("normalizes native string form IDs, TipTap titles, native enum values and nested scenarios", async () => {
    const routes = {
      "/api/tags?page=1": page([{ id: 1, name: "資料請求済み", member_count: 3 }]),
      "/api/user-vars?page=1": page([
        { id: 2, name: "業種", type: 0 }, { id: 20, name: "長文", type: 2 }, { id: 21, name: "選択肢", type: 20 },
        { id: 22, name: "年月日", type: 30 }, { id: 23, name: "日時", type: 35 },
      ]),
      "/api/forms/6": {
        name: "移行診断", user: { secret }, sections: [
          { id: "header", type: "section", name: "共通ヘッダ", blocks: [] },
          { id: "sc_test_native", type: "section", blocks: [
            { id: "bl_test_single", type: "input", inputType: "SINGLE", title: { type: "doc", content: [
              { type: "paragraph", content: [{ type: "text", text: "業種🌸" }, { type: "hardBreak" }, { type: "text", text: "入力" }] },
            ], user: { secret } }, friendInfoIds: [2], required: true, hidden: false },
            { id: "bl_test_radio", type: "selection", inputType: "RADIO", title: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "個別相談？" }] }] },
              items: [{ name: "希望する", valueFriend: "希望", valueTagIds: [1], user: { secret } }, { name: "今はしない", valueFriend: "", valueTagIds: [], destSection: "next" }], actionType: "ADD_TAG", friendInfoIds: [] },
            { id: "bl_unknown", type: "unknown-native-widget", title: "未知の部品", user: { secret } },
          ] },
        ], options: { pageTitle: "入力フォーム🌸", thanksText: "ありがとう", formAction: null },
      },
      "/api/content-groups/3": { content_group: { id: 3, name: "移行案内", contents: [
        { id: 30, step: 0, time: "00:00:00", is_initial: 1, egg: { id: 4, form_type: 8, is_template: 1, simple: "直後の本文🌸", user: { secret } } },
        { id: 31, step: 1, time: "10:30:00", is_initial: 0, egg: { id: 31, form_type: 8, is_template: 0, simple: "翌日の本文" } },
      ] } },
      "/api/member/12/data": { id: 12, uid, name: "テスト🌸", isBlocked: 0, createdAt: exportedAt, user: { secret } },
    };
    const first = await runExporter({ download: false }, false, routes);
    const second = await runExporter({ download: false }, false, routes);
    expect(first.output.data.idMappings).toEqual(second.output.data.idMappings);
    const mappings = first.output.data.idMappings;
    expect(Number.isSafeInteger(mappings.formFields["6/bl_test_single"])).toBe(true);
    expect(first.output.data.forms[0].pages[1].fields[0].title).toBe("業種🌸\n入力");
    expect(first.output.data.forms[0].pages[1].fields[1].settings.items[0]).toMatchObject({ label: "希望する", value: "希望", tagIds: [1] });
    const result = importBrowserExport(first.output);
    expect(result.idMappings).toEqual(mappings);
    expect(result.resources.forms[0].pages[1].fields.map(field => field.type)).toEqual(["text", "radio"]);
    expect(JSON.parse(result.resources.forms[0].pages[1].fields[0].settings!)).toMatchObject({ sourceId: "bl_test_single", sourceSectionId: "sc_test_native", friendInfoIds: [2], inputType: "SINGLE" });
    expect(result.resources.scenarios[0].steps).toHaveLength(2);
    expect(result.resources.scenarios[0].steps[0].templates[0].content).toBe("直後の本文🌸");
    expect(result.resources.scenarios[0].steps[1]).toMatchObject({ delay_type: "date_based", start_day: 1, start_time: "10:30:00" });
    expect(result.resources.fields.map(field => field.type)).toEqual(["TEXT", "TEXTAREA", "SELECT", "DATE", "DATETIME"]);
    expect(result.resources.tags[0].friend_count).toBe(3);
    expect(result.resources.friends[0].row.is_blocked).toBe(false);
    expect(result.coverage.friendTags.status).toBe("partial");
    expect(result.coverage.friendFields.status).toBe("partial");
    expect(result.coverage.forms.status).toBe("partial");
    expect(JSON.stringify(result)).not.toContain(secret);
    const corrupted = structuredClone(first.output);
    corrupted.data.idMappings.formFields["6/bl_test_single"] += 1;
    expect(() => importBrowserExport(corrupted)).toThrow("識別子対応表が一致しません");
  });

  it("gets native member values and excludes system events from conversation using the observed query", async () => {
    const { output, calls } = await runExporter({ download: false }, false, {
      "/api/member/var/12": { values: { "2": "日本語🌸\n2行目,\"引用\"" }, metas: { "2": null }, user: { secret } },
      "/api/v1/members/12/scenario-status": { reading_scenario: null, next_scenario: null, previous_scenario: null, past_scenarios: [] },
      [timelinePath(1)]: {
        messages: [
          { id: 100, fromOwner: true, fromSystem: true, contentText: "タグを編集しました", time: exportedAt, user: { secret } },
          { id: 101, fromOwner: false, fromSystem: true, contentText: "システム通知", time: exportedAt },
          { id: 102, fromOwner: false, fromSystem: false, contentText: "こんにちは🌸\n2行目", time: exportedAt },
          { id: 103, fromOwner: true, fromSystem: false, contentText: "返信です", time: exportedAt },
        ], paginateHasNext: false, futureMessages: [], sendingMessages: [],
      },
    });
    expect(calls.some(call => call.path === "/api/member/var/12")).toBe(true);
    expect(calls.some(call => call.path === timelinePath(1))).toBe(true);
    expect(output.data.friends[0].fields[0].value).toBe("日本語🌸\n2行目,\"引用\"");
    expect(output.data.friends[0].timeline.messages.map((message: { sender: string }) => message.sender)).toEqual(["friend", "bot"]);
    expect(output.data.friends[0].timeline.messages[0].sent_at).toBe(exportedAt);
    expect(output.data.friends[0].timeline.complete).toBe(true);
    expect(output.coverage.systemEvents.count).toBe(2);
    expect(output.coverage.friendScenarios.note).not.toContain("購読状況の構造");
    expect(importBrowserExport(output).coverage.systemEvents.count).toBe(2);
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(JSON.stringify(output)).not.toContain("タグを編集しました");
  });

  it("does not silently interpret unknown sender flags, nonempty native subscriptions or unknown field IDs", async () => {
    const { output } = await runExporter({ download: false }, false, {
      "/api/member/var/12": { values: { "2": "相談業", "9999": secret, "2e0": secret } },
      "/api/v1/members/12/scenario-status": { reading_scenario: { id: 3 }, next_scenario: null, previous_scenario: null, past_scenarios: [] },
      [timelinePath(1)]: { messages: [{ id: 100, fromOwner: true, contentText: "判定不能", time: exportedAt }], paginateHasNext: false },
    });
    expect(output.data.friends[0].timeline.messages).toEqual([]);
    expect(output.data.friends[0].timeline.complete).toBe(false);
    expect(output.coverage.conversations.status).toBe("partial");
    expect(output.coverage.friendFields.note).toContain("定義が未取得");
    expect(output.coverage.friendScenarios.note).toContain("空ではない購読状況");
    expect(JSON.stringify(output)).not.toContain(secret);
  });

  it("supports MULTI, CHECKBOX, DROPDOWN and all 47 prefectures without losing labels", async () => {
    const title = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    const { output } = await runExporter({ download: false }, false, {
      "/api/forms/6": { name: "総合アンケート🌸", sections: [{ id: "sc_test", blocks: [
        { id: "bl_multi", type: "input", inputType: "MULTI", title: title("相談内容（改行）"), friendInfoIds: [2] },
        { id: "bl_checkbox", type: "selection", inputType: "CHECKBOX", title: title("複数選択"), items: [{ name: "資料A,日本語", valueFriend: "", valueTagIds: [] }, { name: '資料B "引用"', valueFriend: "", valueTagIds: [] }] },
        { id: "bl_dropdown", type: "selection", inputType: "DROPDOWN", title: title("時期"), items: [{ name: "今月🌸", valueFriend: "", valueTagIds: [] }] },
        { id: "bl_prefecture", type: "prefecture", title: title("お住まい"), friendInfoIds: [] },
      ] }] },
    });
    const result = importBrowserExport(output);
    const fields = result.resources.forms[0].pages[0].fields;
    expect(fields.map(field => field.type)).toEqual(["textarea", "checkbox", "select", "select"]);
    expect(fields[0].title).toBe("相談内容（改行）");
    expect(JSON.parse(fields[1].settings!).items.map((item: { label: string }) => item.label)).toEqual(["資料A,日本語", '資料B "引用"']);
    const prefectures = JSON.parse(fields[3].settings!).items.map((item: { label: string }) => item.label);
    expect(prefectures).toHaveLength(47);
    expect(new Set(prefectures).size).toBe(47);
    expect(prefectures).toContain("新潟県");
    expect(prefectures[0]).toBe("北海道");
    expect(prefectures[46]).toBe("沖縄県");
  });

  it("warns clearly when SPA HTML has no friend links and retains settings for recovery", async () => {
    const { output, warnings } = await runExporter({ download: false, friendIds: undefined }, false, {
      "/line/show?page=1": "<div id=app></div>",
    });
    expect(output.data.friends).toEqual([]);
    expect(output.coverage.friends.status).toBe("partial");
    expect(output.coverage.friends.note).toContain("友だちの管理番号を取得できませんでした");
    expect(output.coverage.friends.note).toContain("取得は0人");
    expect(warnings.join(" ")).toContain("取得は0人");
    expect(output.data.forms).toHaveLength(1);
    const imported = importBrowserExport(output);
    expect(imported.coverage.friends.status).toBe("partial");
    expect(imported.coverage.friends.note?.match(/取得は0人/g)).toHaveLength(1);
  });
});
