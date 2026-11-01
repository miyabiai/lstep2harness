import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalD1 } from "../src/d1/local.js";
import { SqliteHarnessDatabase } from "../src/harness/database.js";
import { harnessId } from "../src/harness/ids.js";
import { applyHarness, readPlanTarget, verifyHarness } from "../src/harness/remote.js";
import { importBrowserExport } from "../src/lstep/browser.js";
import { createPlan, writeSourceSnapshot } from "../src/pipeline.js";

/**
 * 移行し直し（再移行）で、L Harness 側に元からある・後から変わったものを壊さないこと。
 * 本番の L Harness は移行の合間にも動いている（人が情報を直す・回答が届く・Lステップ側で設定が変わる）。
 */
const FIXTURE = new URL("fixtures/lstep-browser.json", import.meta.url);
const SCHEMA = fileURLToPath(new URL("../schema/line-harness-bootstrap.sql", import.meta.url));
const ACCOUNT = "fictional-live-account";
const KEY = "d1:fictional-harness";
const HANAKO_UID = "U11111111111111111111111111111111";
const TARO_UID = "U22222222222222222222222222222222";
const HANAKO_ID = harnessId("friend", ACCOUNT, 1001);
const TEMPORARIES: string[] = [];

type Fixture = { exportedAt: string; data: Record<string, any> };

function liveHarness() {
  const directory = mkdtempSync(join(tmpdir(), "lstep-remigration-"));
  TEMPORARIES.push(directory);
  const dbPath = join(directory, "harness.sqlite");
  const setup = new LocalD1(dbPath);
  setup.loadSchema(SCHEMA);
  setup.db.prepare("INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret,is_active) VALUES (?,?,?,?,?,1)")
    .run(ACCOUNT, "fictional-channel", "架空の本番アカウント", "fictional-token", "fictional-secret");
  setup.close();
  const database = new SqliteHarnessDatabase(dbPath, "架空の本番D1", 2_000);
  return { directory, database, runs: 0 };
}

type Live = ReturnType<typeof liveHarness>;

function fixture(exportedAt = "2026-10-25T00:00:00.000Z"): Fixture {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
  raw.exportedAt = exportedAt;
  return raw;
}

/** 取得結果を保存して計画を作る（取得ごとに新しいフォルダ） */
async function planFrom(live: Live, raw: Fixture, edit?: (snapshotDir: string) => void) {
  live.runs += 1;
  const snapshotDir = join(live.directory, `run-${live.runs}`, "snapshot");
  writeSourceSnapshot(importBrowserExport(raw), snapshotDir);
  edit?.(snapshotDir);
  const target = await readPlanTarget(live.database, KEY, [HANAKO_UID, TARO_UID]);
  const outDir = join(live.directory, `run-${live.runs}`, "plan");
  const manifest = createPlan(snapshotDir, outDir, ACCOUNT, target);
  return { outDir, manifest };
}

function apply(live: Live, outDir: string) {
  return applyHarness(outDir, live.database, { key: KEY, allowPartial: true });
}

function rows<T = Record<string, unknown>>(live: Live, sql: string, ...params: Array<string | number | null>): T[] {
  return live.database.db.prepare(sql).all(...params) as T[];
}

function metadata(live: Live, friendId: string): Record<string, any> {
  return JSON.parse(rows<{ metadata: string }>(live, "SELECT metadata FROM friends WHERE id=?", friendId)[0].metadata);
}

afterEach(() => {
  for (const directory of TEMPORARIES.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("移行し直しで L Harness 側の変更を壊さない", () => {
  it("同じ名前の友だち情報は、L Harness で書き換えていれば残し、書き換えていなければ Lステップの新しい値にする", async () => {
    const live = liveHarness();
    // 元からいる花子に、L Harness 側で同じ名前の情報と、L Harness だけの情報（型いろいろ・null・引用符入りの名前）がある
    const harnessSide = { "相談'内容📩": "L Harness で直した", harness_only: "残す", flag: true, off: false, nothing: null, ratio: 1.5, 'a"b.c': "h", list: [1, "x", null], nested: { a: true, b: [] } };
    live.database.db.prepare("INSERT INTO friends (id,line_user_id,display_name,line_account_id,metadata) VALUES (?,?,?,?,?)")
      .run("harness-made-hanako", HANAKO_UID, "LINEで最新の名前", ACCOUNT, JSON.stringify({ ...harnessSide, _lstep: { friend_info: { "999": { title: "古い版の項目", value: "消える" } } } }));
    const first = await planFrom(live, fixture());
    await apply(live, first.outDir);
    let hanako = metadata(live, "harness-made-hanako");
    for (const [key, value] of Object.entries(harnessSide)) expect(hanako[key]).toEqual(value);
    expect(hanako["ポイント"]).toBe(0);
    expect(hanako["同意確認"]).toBe(false);
    expect(hanako._lstep.friend_info["201"].value).toBe("製造業 \"A社\" / 'B店'\n架空県🌾");
    expect(hanako._lstep.friend_info["999"]).toBeUndefined();

    // Lステップ側で値が変わった（L Harness で直した項目はそのまま、直していない項目は新しい値になる）
    const changed = fixture("2026-10-26T00:00:00.000Z");
    changed.data.friends[0].fields[0].value = "Lステップで直した";
    changed.data.friends[0].fields[1].value = 10;
    const second = await planFrom(live, changed);
    await apply(live, second.outDir);
    hanako = metadata(live, "harness-made-hanako");
    for (const [key, value] of Object.entries(harnessSide)) expect(hanako[key]).toEqual(value);
    expect(hanako["ポイント"]).toBe(10);
    expect(hanako._lstep.friend_info["201"].value).toBe("Lステップで直した");

    // このツールで入れた値を L Harness で直した後は、同じ計画を流し直しても戻らず、照合も通る
    live.database.db.prepare("UPDATE friends SET metadata=json_set(metadata,'$.ポイント',99) WHERE id='harness-made-hanako'").run();
    await expect(verifyHarness(second.outDir, live.database)).resolves.toMatchObject({ checked: expect.any(Number) });
    const taroBefore = metadata(live, harnessId("friend", ACCOUNT, 1002));
    await apply(live, second.outDir);
    expect(metadata(live, "harness-made-hanako")["ポイント"]).toBe(99);
    expect(metadata(live, harnessId("friend", ACCOUNT, 1002))).toEqual(taroBefore);
    // このツールが前に作った友だちでも同じ（L Harness で書き換えた値は残す。false → 0 のように型だけ変えた場合も）
    live.database.db.prepare("UPDATE friends SET metadata=json_set(metadata,'$.ポイント',7) WHERE id=?").run(harnessId("friend", ACCOUNT, 1002));
    live.database.db.prepare("UPDATE friends SET metadata=json_set(metadata,'$.同意確認',0) WHERE id='harness-made-hanako'").run();
    const third = await planFrom(live, fixture("2026-10-27T00:00:00.000Z"));
    await apply(live, third.outDir);
    expect(metadata(live, harnessId("friend", ACCOUNT, 1002))["ポイント"]).toBe(7);
    expect(metadata(live, "harness-made-hanako")["同意確認"]).toBe(0);
  });

  it("チャットのメモは、このツールが書いた文そのものだけを書き換え、人が書き足した文は残す", async () => {
    const live = liveHarness();
    const withStatus = (name: string) => (snapshotDir: string) => {
      writeFileSync(join(snapshotDir, "handling_statuses.json"), JSON.stringify([{ id: 1, name: "未対応" }, { id: 2, name: "対応済み" }]));
      const file = join(snapshotDir, "friends", "1001.json");
      const friend = JSON.parse(readFileSync(file, "utf8"));
      friend.conversation.handling_status = { id: name === "未対応" ? 1 : 2, name };
      writeFileSync(file, JSON.stringify(friend));
    };
    const first = await planFrom(live, fixture(), withStatus("未対応"));
    await apply(live, first.outDir);
    expect(rows(live, "SELECT notes FROM chats WHERE friend_id=?", HANAKO_ID)).toEqual([{ notes: "対応ステータス: 未対応" }]);
    // 人がメモを書き足した → 対応ステータスが変わっても、書き足したメモごと残す
    live.database.db.prepare("UPDATE chats SET notes=? WHERE friend_id=?").run("対応ステータス: 未対応\n電話で話した", HANAKO_ID);
    const second = await planFrom(live, fixture("2026-10-26T00:00:00.000Z"), withStatus("対応済み"));
    await apply(live, second.outDir);
    expect(rows(live, "SELECT notes FROM chats WHERE friend_id=?", HANAKO_ID)).toEqual([{ notes: "対応ステータス: 未対応\n電話で話した" }]);
    // ツールが書いた文のままなら、新しい対応ステータスに書き換わる
    live.database.db.prepare("UPDATE chats SET notes=? WHERE friend_id=?").run("対応ステータス: 未対応", HANAKO_ID);
    const third = await planFrom(live, fixture("2026-10-27T00:00:00.000Z"), withStatus("対応済み"));
    await apply(live, third.outDir);
    expect(rows(live, "SELECT notes FROM chats WHERE friend_id=?", HANAKO_ID)).toEqual([{ notes: "対応ステータス: 対応済み" }]);
  });

  it("取得し直して古い会話が先頭に増えても、前に入れた会話の ID は変わらず二重にならない", async () => {
    const live = liveHarness();
    const first = await planFrom(live, fixture());
    await apply(live, first.outDir);
    const before = rows<{ id: string }>(live, "SELECT id FROM messages_log WHERE friend_id=? ORDER BY id", HANAKO_ID).map((row) => row.id);
    expect(before).toHaveLength(3);
    const longer = fixture("2026-10-26T00:00:00.000Z");
    longer.data.friends[0].timeline.messages.unshift({ message_id: 400, sender: "friend", message_type: "text", content: "もっと前の会話", sent_at: "2026-10-23T00:00:00.000Z" });
    const second = await planFrom(live, longer);
    await apply(live, second.outDir);
    const after = rows<{ id: string; content: string }>(live, "SELECT id,content FROM messages_log WHERE friend_id=? ORDER BY id", HANAKO_ID);
    expect(after).toHaveLength(4);
    for (const id of before) expect(after.map((row) => row.id)).toContain(id);
    expect(after.map((row) => row.content)).toContain("もっと前の会話");
  });

  it("停止中のシナリオは、Lステップで消した・間に足したステップを移行先にも反映し、有効なシナリオには触れず知らせる", async () => {
    const live = liveHarness();
    const first = await planFrom(live, fixture());
    await apply(live, first.outDir);
    const scenarioId = harnessId("scenario", ACCOUNT, 301);
    const steps = () => rows<{ step_order: number; message_content: string }>(live, "SELECT step_order,message_content FROM scenario_steps WHERE scenario_id=? ORDER BY step_order", scenarioId);
    expect(steps()).toHaveLength(2);
    // 1通目を消した
    const removed = fixture("2026-10-26T00:00:00.000Z");
    removed.data.scenarios[0].steps = removed.data.scenarios[0].steps.slice(1);
    const second = await planFrom(live, removed);
    await apply(live, second.outDir);
    expect(steps()).toEqual([{ step_order: 1, message_content: "翌日の確認です📩\n回答をお願いします。" }]);
    // 間にステップを足した（step_order の重なりで止まらない）
    const inserted = fixture("2026-10-27T00:00:00.000Z");
    const [s1, s2] = inserted.data.scenarios[0].steps;
    inserted.data.scenarios[0].steps = [s1, { id: 3003, order_number: 2, delay_type: "immediate", templates: [{ id: 503, type: "text", content: "間に足したステップ" }], actions: [] }, { ...s2, order_number: 3 }];
    const third = await planFrom(live, inserted);
    await apply(live, third.outDir);
    expect(steps().map((row) => row.message_content)).toEqual([s1.templates[0].content, "間に足したステップ", s2.templates[0].content]);
    expect(steps().map((row) => row.step_order)).toEqual([1, 2, 3]);
    expect(rows(live, "PRAGMA foreign_key_check")).toEqual([]);
    // 有効にしたシナリオは変えず、消したステップが残っていることを知らせる
    live.database.db.prepare("UPDATE scenarios SET is_active=1 WHERE id=?").run(scenarioId);
    const activeBefore = steps();
    const removedAgain = fixture("2026-10-28T00:00:00.000Z");
    removedAgain.data.scenarios[0].steps = removedAgain.data.scenarios[0].steps.slice(1);
    const fourth = await planFrom(live, removedAgain);
    expect(fourth.manifest.reports.scenarios.notes.join("\n")).toMatch(/有効にしているシナリオ.*消したステップ/);
    await apply(live, fourth.outDir);
    expect(steps()).toEqual(activeBefore);
  });

  it("中身を取れなかったシナリオ・フォームは「空」として入れず、移行先に前から入っているものを変えない", async () => {
    const live = liveHarness();
    const first = await planFrom(live, fixture());
    await apply(live, first.outDir);
    const scenarioId = harnessId("scenario", ACCOUNT, 301);
    const formId = harnessId("form", ACCOUNT, 601);
    const stepsBefore = rows(live, "SELECT * FROM scenario_steps WHERE scenario_id=? ORDER BY step_order", scenarioId);
    const formBefore = rows(live, "SELECT * FROM forms WHERE id=?", formId);
    const answersBefore = rows(live, "SELECT COUNT(*) AS c FROM form_submissions WHERE form_id=?", formId);
    expect(stepsBefore).toHaveLength(2);
    expect(JSON.parse(String(formBefore[0].fields))).not.toEqual([]);
    // 取得し直したら、シナリオ詳細とフォーム詳細が取れなかった（画面取得が失敗して中身が空のまま）
    const failed = fixture("2026-10-26T00:00:00.000Z");
    failed.data.scenarios[0] = { ...failed.data.scenarios[0], steps: [], incomplete: true };
    failed.data.forms[0] = { ...failed.data.forms[0], pages: [], incomplete: true };
    const second = await planFrom(live, failed);
    expect(second.manifest.reports.scenarios.notes.join("\n")).toContain("中身を取得できなかったシナリオ");
    expect(second.manifest.reports.forms.notes.join("\n")).toContain("設問を取得できなかったフォーム");
    expect(second.manifest.reports.scenarios.level).toBe("partial");
    await apply(live, second.outDir);
    expect(rows(live, "SELECT * FROM scenario_steps WHERE scenario_id=? ORDER BY step_order", scenarioId)).toEqual(stepsBefore);
    expect(rows(live, "SELECT * FROM forms WHERE id=?", formId)).toEqual(formBefore);
    expect(rows(live, "SELECT COUNT(*) AS c FROM form_submissions WHERE form_id=?", formId)).toEqual(answersBefore);
  });

  it("L Harness の管理画面で手で足したステップがある停止中のシナリオは、本番に書く前に止めて案内する", async () => {
    const live = liveHarness();
    const first = await planFrom(live, fixture());
    await apply(live, first.outDir);
    const scenarioId = harnessId("scenario", ACCOUNT, 301);
    live.database.db.prepare("INSERT INTO scenario_steps (id,scenario_id,step_order,delay_minutes,message_type,message_content) VALUES (?,?,?,?,?,?)")
      .run("7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", scenarioId, 3, 0, "text", "L Harness で足したステップ");
    const grown = fixture("2026-10-26T00:00:00.000Z");
    grown.data.scenarios[0].steps.push({ id: 3003, order_number: 3, delay_type: "immediate", templates: [{ id: 503, type: "text", content: "Lステップで足した3通目" }], actions: [] });
    const second = await planFrom(live, grown);
    live.database.executed.length = 0;
    await expect(apply(live, second.outDir)).rejects.toThrow(/管理画面で足したステップがある停止中のシナリオが 1件/);
    expect(live.database.executed).toEqual([]);
    // 有効にしたシナリオなら触らないので、そのまま入る
    live.database.db.prepare("UPDATE scenarios SET is_active=1 WHERE id=?").run(scenarioId);
    const third = await planFrom(live, fixture("2026-10-27T00:00:00.000Z"));
    await expect(apply(live, third.outDir)).resolves.toMatchObject({ checked: expect.any(Number) });
    expect(rows(live, "SELECT COUNT(*) AS c FROM scenario_steps WHERE scenario_id=?", scenarioId)[0]).toEqual({ c: 3 });
  });

  it("移行し直しで、既存の友だち・チャット・シナリオの更新日時を巻き戻さない", async () => {
    const live = liveHarness();
    live.database.db.prepare("INSERT INTO friends (id,line_user_id,display_name,line_account_id,updated_at) VALUES (?,?,?,?,?)")
      .run("harness-made-hanako", HANAKO_UID, "LINEで最新の名前", ACCOUNT, "2026-11-01T12:00:00.000+09:00");
    live.database.db.prepare("INSERT INTO chats (id,friend_id,status,line_account_id,updated_at) VALUES (?,?,?,?,?)")
      .run("harness-made-chat", "harness-made-hanako", "resolved", ACCOUNT, "2026-11-01T12:00:00.000+09:00");
    const first = await planFrom(live, fixture());
    await apply(live, first.outDir);
    expect(rows(live, "SELECT updated_at FROM friends WHERE id='harness-made-hanako'")).toEqual([{ updated_at: "2026-11-01T12:00:00.000+09:00" }]);
    expect(rows(live, "SELECT updated_at FROM chats WHERE id='harness-made-chat'")).toEqual([{ updated_at: "2026-11-01T12:00:00.000+09:00" }]);
    // このツールが作った行を L Harness で後から直した（更新日時が進んだ）後に、同じ取得結果で移行し直しても戻らない
    const taroId = harnessId("friend", ACCOUNT, 1002);
    const scenarioId = harnessId("scenario", ACCOUNT, 301);
    const taroFirst = rows<{ updated_at: string }>(live, "SELECT updated_at FROM friends WHERE id=?", taroId)[0].updated_at;
    live.database.db.prepare("UPDATE scenarios SET updated_at='2026-11-02T00:00:00.000+09:00' WHERE id=?").run(scenarioId);
    const second = await planFrom(live, fixture("2026-10-26T00:00:00.000Z"));
    await apply(live, second.outDir);
    expect(rows(live, "SELECT updated_at FROM friends WHERE id='harness-made-hanako'")).toEqual([{ updated_at: "2026-11-01T12:00:00.000+09:00" }]);
    expect(rows(live, "SELECT updated_at FROM scenarios WHERE id=?", scenarioId)).toEqual([{ updated_at: "2026-11-02T00:00:00.000+09:00" }]);
    // 新しい取得結果なら、このツールが入れた行の更新日時は進む
    expect(rows<{ updated_at: string }>(live, "SELECT updated_at FROM friends WHERE id=?", taroId)[0].updated_at > taroFirst).toBe(true);
  });

  it("Lステップで登録し直した人（開始日時が変わる）も移行し直せる。L Harness 自身が作った進行状態がある組は触らない", async () => {
    const live = liveHarness();
    const first = await planFrom(live, fixture());
    await apply(live, first.outDir);
    const scenarioId = harnessId("scenario", ACCOUNT, 301);
    const taroId = harnessId("friend", ACCOUNT, 1002);
    // 花子は Lステップで登録し直した（開始日時が変わった）。太郎は L Harness 自身がシナリオに入れている（UUID v4・配信中）
    live.database.db.prepare("DELETE FROM friend_scenarios WHERE friend_id=?").run(taroId);
    live.database.db.prepare("INSERT INTO friend_scenarios (id,friend_id,scenario_id,current_step_order,status,started_at) VALUES (?,?,?,?,?,?)")
      .run("2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f", taroId, scenarioId, 5, "active", "2026-11-01T00:00:00.000+09:00");
    const changed = fixture("2026-10-26T00:00:00.000Z");
    changed.data.friends[0].scenarios[0].started_at = "2026-10-25T12:00:00.000Z";
    const second = await planFrom(live, changed);
    expect(second.manifest.reports.friend_scenarios.notes.join("\n")).toContain("L Harness 側で登録済みの進行状態がある人");
    await expect(apply(live, second.outDir)).resolves.toMatchObject({ checked: expect.any(Number) });
    expect(rows(live, "SELECT started_at FROM friend_scenarios WHERE friend_id=?", HANAKO_ID)).toEqual([{ started_at: "2026-10-25T21:00:00.000+09:00" }]);
    expect(rows(live, "SELECT id,current_step_order,status FROM friend_scenarios WHERE friend_id=?", taroId))
      .toEqual([{ id: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f", current_step_order: 5, status: "active" }]);
    // 計画の後に L Harness が進行状態を作ったら、本番に書く前に作り直しを案内する
    const third = await planFrom(live, fixture("2026-10-27T00:00:00.000Z"));
    live.database.db.prepare("DELETE FROM friend_scenarios WHERE friend_id=?").run(HANAKO_ID);
    live.database.db.prepare("INSERT INTO friend_scenarios (id,friend_id,scenario_id,current_step_order,status) VALUES (?,?,?,?,?)")
      .run("3c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f", HANAKO_ID, scenarioId, 1, "active");
    live.database.executed.length = 0;
    await expect(apply(live, third.outDir)).rejects.toThrow(/進行状態を作っています/);
    expect(live.database.executed).toEqual([]);
  });

  it("対応ステータスが変わったら、前のステータスのタグを外し、ツールが書いたメモだけ書き換える", async () => {
    const live = liveHarness();
    const withStatus = (name: string) => (snapshotDir: string) => {
      writeFileSync(join(snapshotDir, "handling_statuses.json"), JSON.stringify([{ id: 1, name: "未対応" }, { id: 2, name: "対応済み" }]));
      const file = join(snapshotDir, "friends", "1001.json");
      const friend = JSON.parse(readFileSync(file, "utf8"));
      friend.conversation.handling_status = { id: name === "未対応" ? 1 : 2, name };
      writeFileSync(file, JSON.stringify(friend));
    };
    const first = await planFrom(live, fixture(), withStatus("未対応"));
    await apply(live, first.outDir);
    const statusTags = () => rows<{ name: string }>(live, "SELECT t.name FROM friend_tags ft JOIN tags t ON t.id=ft.tag_id WHERE ft.friend_id=? AND t.name LIKE '対応:%' ORDER BY t.name", HANAKO_ID).map((row) => row.name);
    expect(statusTags()).toEqual(["対応:未対応"]);
    const second = await planFrom(live, fixture("2026-10-26T00:00:00.000Z"), withStatus("対応済み"));
    await apply(live, second.outDir);
    expect(statusTags()).toEqual(["対応:対応済み"]);
    // 普通のタグは外さない
    expect(rows(live, "SELECT COUNT(*) AS c FROM friend_tags WHERE friend_id=?", HANAKO_ID)[0]).toEqual({ c: 3 });
    // Lステップで対応ステータスを改名しても、前回このツールが書いた文そのものなら書き換わる
    const renamed = (snapshotDir: string) => {
      writeFileSync(join(snapshotDir, "handling_statuses.json"), JSON.stringify([{ id: 1, name: "未対応" }, { id: 2, name: "対応済み（改名）" }]));
      const file = join(snapshotDir, "friends", "1001.json");
      const friend = JSON.parse(readFileSync(file, "utf8"));
      friend.conversation.handling_status = { id: 2, name: "対応済み（改名）" };
      writeFileSync(file, JSON.stringify(friend));
    };
    const third = await planFrom(live, fixture("2026-10-27T00:00:00.000Z"), renamed);
    await apply(live, third.outDir);
    expect(rows(live, "SELECT notes FROM chats WHERE friend_id=?", HANAKO_ID)).toEqual([{ notes: "対応ステータス: 対応済み（改名）" }]);
    // 同じ行に人が付け足したメモは残す
    live.database.db.prepare("UPDATE chats SET notes='対応ステータス: 対応済み（改名） 電話済み' WHERE friend_id=?").run(HANAKO_ID);
    const fourth = await planFrom(live, fixture("2026-10-28T00:00:00.000Z"), withStatus("未対応"));
    await apply(live, fourth.outDir);
    expect(rows(live, "SELECT notes FROM chats WHERE friend_id=?", HANAKO_ID)).toEqual([{ notes: "対応ステータス: 対応済み（改名） 電話済み" }]);
  });

  it("Lステップで友だち情報を空にしてから入れ直した値は、このツールの項目として更新される", async () => {
    const live = liveHarness();
    const first = await planFrom(live, fixture());
    await apply(live, first.outDir);
    const hanakoId = harnessId("friend", ACCOUNT, 1001);
    const cleared = fixture("2026-10-26T00:00:00.000Z");
    cleared.data.friends[0].fields[0].value = "";
    const second = await planFrom(live, cleared);
    await apply(live, second.outDir);
    expect(metadata(live, hanakoId)["相談'内容📩"]).toBe("製造業 \"A社\" / 'B店'\n架空県🌾"); // 足すだけで消さない
    const reentered = fixture("2026-10-27T00:00:00.000Z");
    reentered.data.friends[0].fields[0].value = "入れ直した値";
    const third = await planFrom(live, reentered);
    await apply(live, third.outDir);
    expect(metadata(live, hanakoId)["相談'内容📩"]).toBe("入れ直した値");
  });

  it("同じ回でタグを改名し、元の名前で別のタグを作っても、別のタグとして入る", async () => {
    const live = liveHarness();
    const first = await planFrom(live, fixture());
    await apply(live, first.outDir);
    const swapped = fixture("2026-10-26T00:00:00.000Z");
    const oldName = swapped.data.tags[0].name;
    swapped.data.tags[0].name = `${oldName}（改名）`;
    swapped.data.tags.push({ id: 104, name: oldName, friend_count: 1 });
    swapped.data.friends[1].tags.push({ id: 104, name: oldName });
    const second = await planFrom(live, swapped);
    await expect(apply(live, second.outDir)).resolves.toMatchObject({ checked: expect.any(Number) });
    expect(rows(live, "SELECT name FROM tags WHERE id=?", harnessId("tag", ACCOUNT, 101))).toEqual([{ name: `${oldName}（改名）` }]);
    expect(rows(live, "SELECT name FROM tags WHERE id=?", harnessId("tag", ACCOUNT, 104))).toEqual([{ name: oldName }]);
    const taroTags = rows<{ name: string }>(live, "SELECT t.name FROM friend_tags ft JOIN tags t ON t.id=ft.tag_id WHERE ft.friend_id=?", harnessId("friend", ACCOUNT, 1002)).map((row) => row.name);
    expect(taroTags).toContain(oldName);
  });

  it("作成日時の無い取得結果でも、移行先で直した設定があっても、移行し直しの照合が通る", async () => {
    const live = liveHarness();
    const first = await planFrom(live, fixture());
    await apply(live, first.outDir);
    const formId = harnessId("form", ACCOUNT, 601);
    live.database.db.prepare("UPDATE forms SET save_to_metadata=0 WHERE id=?").run(formId);
    const later = fixture("2026-10-26T00:00:00.000Z");
    delete later.data.scenarios[0].created_at;
    delete later.data.forms[0].created_at;
    const second = await planFrom(live, later);
    await expect(apply(live, second.outDir)).resolves.toMatchObject({ checked: expect.any(Number) });
    expect(rows(live, "SELECT save_to_metadata FROM forms WHERE id=?", formId)).toEqual([{ save_to_metadata: 0 }]);
  });

  it("未対応の設問があるフォームは、移行先に前からあれば設問を書き換えない", async () => {
    const live = liveHarness();
    const first = await planFrom(live, fixture());
    await apply(live, first.outDir);
    const formId = harnessId("form", ACCOUNT, 601);
    const before = rows<{ fields: string }>(live, "SELECT fields FROM forms WHERE id=?", formId)[0].fields;
    // 取得し直したら、選択式の設問の選択肢が取れなかった（設問が欠ける）
    const broken = fixture("2026-10-26T00:00:00.000Z");
    const select = broken.data.forms[0].pages[0].fields.find((field: { type: string }) => field.type === "select");
    select.settings = {};
    const second = await planFrom(live, broken);
    expect(second.manifest.reports.forms.notes.join("\n")).toContain("設問を書き換えていません");
    await apply(live, second.outDir);
    expect(rows<{ fields: string }>(live, "SELECT fields FROM forms WHERE id=?", formId)[0].fields).toBe(before);
  });

  it("connect で移行先アカウントを変えた後は、前のアカウント向けの計画を流さない。中止の合図が来たら次のファイルの前で止まる", async () => {
    const live = liveHarness();
    const { outDir } = await planFrom(live, fixture());
    live.database.executed.length = 0;
    await expect(applyHarness(outDir, live.database, { key: KEY, allowPartial: true, lineAccountId: "another-account" })).rejects.toThrow(/別のアカウント向け/);
    expect(live.database.executed).toEqual([]);
    await expect(verifyHarness(outDir, live.database, { lineAccountId: "another-account" })).rejects.toThrow(/別のアカウント向け/);
    const aborted = new AbortController();
    aborted.abort();
    await expect(applyHarness(outDir, live.database, { key: KEY, allowPartial: true, lineAccountId: ACCOUNT, signal: aborted.signal })).rejects.toThrow(/中止しました/);
    expect(rows(live, "SELECT COUNT(*) AS c FROM friends")[0]).toEqual({ c: 0 });
    // 中止後は同じ apply で続きから流せる
    await expect(applyHarness(outDir, live.database, { key: KEY, allowPartial: true, lineAccountId: ACCOUNT })).resolves.toMatchObject({ checked: expect.any(Number) });
  });

  it("L Harness に「対応:◯◯」という名前の普通のタグがあっても、対応ステータスのタグと混ぜず、普通のタグ付けを外さない", async () => {
    const live = liveHarness();
    live.database.db.prepare("INSERT INTO friends (id,line_user_id,display_name,line_account_id) VALUES (?,?,?,?)").run("harness-made-hanako", HANAKO_UID, "花子", ACCOUNT);
    live.database.db.prepare("INSERT INTO tags (id,name) VALUES ('human-made-tag','対応:未対応')").run();
    live.database.db.prepare("INSERT INTO friend_tags (friend_id,tag_id) VALUES ('harness-made-hanako','human-made-tag')").run();
    const withStatus = (name: string) => (snapshotDir: string) => {
      writeFileSync(join(snapshotDir, "handling_statuses.json"), JSON.stringify([{ id: 1, name: "未対応" }, { id: 2, name: "対応済み" }]));
      const file = join(snapshotDir, "friends", "1001.json");
      const friend = JSON.parse(readFileSync(file, "utf8"));
      friend.conversation.handling_status = { id: name === "未対応" ? 1 : 2, name };
      writeFileSync(file, JSON.stringify(friend));
    };
    const first = await planFrom(live, fixture(), withStatus("対応済み"));
    await apply(live, first.outDir);
    const second = await planFrom(live, fixture("2026-10-26T00:00:00.000Z"), withStatus("対応済み"));
    await apply(live, second.outDir);
    expect(rows(live, "SELECT COUNT(*) AS c FROM friend_tags WHERE friend_id='harness-made-hanako' AND tag_id='human-made-tag'")[0]).toEqual({ c: 1 });
    const names = rows<{ name: string }>(live, "SELECT name FROM tags WHERE name LIKE '対応:%' ORDER BY name").map((row) => row.name);
    expect(names).toEqual(["対応:対応済み", "対応:未対応", "対応:未対応 (2)"]);
  });

  it("既存のタグの名前を入れ替えても（A→B・B→C）、名前の重なりで止まらない", async () => {
    const live = liveHarness();
    const first = await planFrom(live, fixture());
    await apply(live, first.outDir);
    const swapped = fixture("2026-10-26T00:00:00.000Z");
    const [a, b] = swapped.data.tags;
    const nameA = a.name;
    a.name = b.name;
    b.name = "新しい名前";
    const second = await planFrom(live, swapped);
    await expect(apply(live, second.outDir)).resolves.toMatchObject({ checked: expect.any(Number) });
    expect(rows(live, "SELECT name FROM tags WHERE id=?", harnessId("tag", ACCOUNT, 101))).toEqual([{ name: a.name }]);
    expect(rows(live, "SELECT name FROM tags WHERE id=?", harnessId("tag", ACCOUNT, 102))).toEqual([{ name: "新しい名前" }]);
    expect(rows(live, "SELECT COUNT(*) AS c FROM tags WHERE name=?", nameA)[0]).toEqual({ c: 0 });
    expect(rows(live, "SELECT COUNT(*) AS c FROM tags WHERE name LIKE 'lstep2harness-renaming-%'")[0]).toEqual({ c: 0 });
  });

  it("移行元で定義が消えた対応ステータスのタグも、移行し直すと友だちから外れる", async () => {
    const live = liveHarness();
    const withStatuses = (statuses: Array<{ id: number; name: string }>, current: { id: number; name: string }) => (snapshotDir: string) => {
      writeFileSync(join(snapshotDir, "handling_statuses.json"), JSON.stringify(statuses));
      const file = join(snapshotDir, "friends", "1001.json");
      const friend = JSON.parse(readFileSync(file, "utf8"));
      friend.conversation.handling_status = current;
      writeFileSync(file, JSON.stringify(friend));
    };
    const first = await planFrom(live, fixture(), withStatuses([{ id: 1, name: "未対応" }, { id: 2, name: "対応済み" }], { id: 1, name: "未対応" }));
    await apply(live, first.outDir);
    const statusTags = () => rows<{ name: string }>(live, "SELECT t.name FROM friend_tags ft JOIN tags t ON t.id=ft.tag_id WHERE ft.friend_id=? AND t.name LIKE '対応:%' ORDER BY t.name", HANAKO_ID).map((row) => row.name);
    expect(statusTags()).toEqual(["対応:未対応"]);
    // Lステップで「未対応」の定義を消し、花子は「対応済み」になった
    const second = await planFrom(live, fixture("2026-10-26T00:00:00.000Z"), withStatuses([{ id: 2, name: "対応済み" }], { id: 2, name: "対応済み" }));
    await apply(live, second.outDir);
    expect(statusTags()).toEqual(["対応:対応済み"]);
  });

  it("Lステップでタグ名を変えて移行し直すと、名前だけ変わり照合も通る", async () => {
    const live = liveHarness();
    const first = await planFrom(live, fixture());
    await apply(live, first.outDir);
    const renamed = fixture("2026-10-26T00:00:00.000Z");
    renamed.data.tags[0].name = "資料請求'済み📩（改名）";
    const second = await planFrom(live, renamed);
    await expect(apply(live, second.outDir)).resolves.toMatchObject({ checked: expect.any(Number) });
    expect(rows(live, "SELECT name FROM tags WHERE id=?", harnessId("tag", ACCOUNT, 101))).toEqual([{ name: "資料請求'済み📩（改名）" }]);
  });

  it("同じメッセージ ID の会話の順が取得のたびに入れ替わっても、二重にならず照合が通る", async () => {
    const live = liveHarness();
    const raw = fixture();
    const messages = raw.data.friends[0].timeline.messages;
    messages[1] = { ...messages[1], message_id: 777 };
    messages[2] = { ...messages[2], message_id: 777 };
    const first = await planFrom(live, raw);
    await apply(live, first.outDir);
    const before = rows<{ id: string }>(live, "SELECT id FROM messages_log WHERE friend_id=? ORDER BY id", HANAKO_ID).map((row) => row.id);
    const swapped = fixture("2026-10-26T00:00:00.000Z");
    const list = swapped.data.friends[0].timeline.messages;
    [list[1], list[2]] = [{ ...list[2], message_id: 777 }, { ...list[1], message_id: 777 }];
    const second = await planFrom(live, swapped);
    await expect(apply(live, second.outDir)).resolves.toMatchObject({ checked: expect.any(Number) });
    expect(rows<{ id: string }>(live, "SELECT id FROM messages_log WHERE friend_id=? ORDER BY id", HANAKO_ID).map((row) => row.id)).toEqual(before);
  });

  it("フォームの回答数は、L Harness が受けた回答を数え直し、移行し直しで減らさない", async () => {
    const live = liveHarness();
    const first = await planFrom(live, fixture());
    await apply(live, first.outDir);
    const formId = harnessId("form", ACCOUNT, 601);
    const count = () => rows<{ submit_count: number }>(live, "SELECT submit_count FROM forms WHERE id=?", formId)[0].submit_count;
    const planned = count();
    expect(planned).toBe(rows<{ c: number }>(live, "SELECT COUNT(*) AS c FROM form_submissions WHERE form_id=?", formId)[0].c);
    // L Harness が自分で受けた回答（ID は L Harness が作る UUID v4）
    live.database.db.prepare("INSERT INTO form_submissions (id,form_id,friend_id,data,created_at) VALUES (?,?,?,?,?)")
      .run("4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f", formId, HANAKO_ID, JSON.stringify({ "お名前": "L Harness で受けた回答" }), "2026-10-26T00:00:00.000+09:00");
    live.database.db.prepare("UPDATE forms SET submit_count=submit_count+1 WHERE id=?").run(formId);
    await expect(apply(live, first.outDir)).resolves.toMatchObject({ checked: expect.any(Number) });
    expect(count()).toBe(planned + 1);
    const second = await planFrom(live, fixture("2026-10-26T00:00:00.000Z"));
    await apply(live, second.outDir);
    expect(count()).toBe(planned + 1);
    expect(rows(live, "SELECT COUNT(*) AS c FROM form_submissions WHERE form_id=?", formId)[0]).toEqual({ c: planned + 1 });
  });
});
