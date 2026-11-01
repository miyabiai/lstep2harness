import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalD1 } from "../src/d1/local.js";
import { SqliteHarnessDatabase } from "../src/harness/database.js";
import { harnessId } from "../src/harness/ids.js";
import { APPLIED_TABLE, applyHarness, HarnessCheckError, readPlanTarget, verifyHarness } from "../src/harness/remote.js";
import { importBrowserExport } from "../src/lstep/browser.js";
import { applyLocal, createPlan, writeSourceSnapshot } from "../src/pipeline.js";

const FIXTURE = new URL("fixtures/lstep-browser.json", import.meta.url);
const SCHEMA = fileURLToPath(new URL("../schema/line-harness-bootstrap.sql", import.meta.url));
const ACCOUNT = "fictional-live-account";
const KEY = "d1:fictional-harness";
const HANAKO_UID = "U11111111111111111111111111111111";
const TARO_UID = "U22222222222222222222222222222222";
const TEMPORARIES: string[] = [];

/** 動いている本番の L Harness に見立てた DB（アカウントは稼働中・友だちとタグが元からいる） */
function liveHarness(options: { existingHanako?: boolean; existingTag?: string; dropColumn?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "lstep-harness-"));
  TEMPORARIES.push(directory);
  const dbPath = join(directory, "harness.sqlite");
  const setup = new LocalD1(dbPath);
  setup.loadSchema(SCHEMA);
  setup.db.prepare("INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret,is_active) VALUES (?,?,?,?,?,1)")
    .run(ACCOUNT, "fictional-channel", "架空の本番アカウント", "fictional-token", "fictional-secret");
  setup.db.prepare("INSERT INTO friends (id,line_user_id,display_name,line_account_id) VALUES (?,?,?,?)")
    .run("already-there-1", "U99999999999999999999999999999999", "移行と関係ない人", ACCOUNT);
  if (options.existingHanako) {
    setup.db.prepare("INSERT INTO friends (id,line_user_id,display_name,picture_url,line_account_id) VALUES (?,?,?,?,?)")
      .run("harness-made-hanako", HANAKO_UID, "LINEで最新の名前", "https://example.invalid/icon.png", ACCOUNT);
  }
  if (options.existingTag) setup.db.prepare("INSERT INTO tags (id,name) VALUES (?,?)").run("harness-made-tag", options.existingTag);
  if (options.dropColumn) setup.exec(`ALTER TABLE friends DROP COLUMN ${options.dropColumn}`);
  setup.close();
  const snapshotDir = join(directory, "run", "snapshot");
  writeSourceSnapshot(importBrowserExport(JSON.parse(readFileSync(FIXTURE, "utf8"))), snapshotDir);
  const database = new SqliteHarnessDatabase(dbPath, "架空の本番D1", 2_000);
  return { directory, dbPath, snapshotDir, database };
}

type Live = ReturnType<typeof liveHarness>;

async function plan(live: Live, name = "plan", snapshotDir = live.snapshotDir) {
  const target = await readPlanTarget(live.database, KEY, [HANAKO_UID, TARO_UID]);
  const outDir = join(live.directory, "run", name);
  const manifest = createPlan(snapshotDir, outDir, ACCOUNT, target);
  return { outDir, manifest };
}

function apply(live: Live, outDir: string) {
  return applyHarness(outDir, live.database, { key: KEY, allowPartial: true, replanHint: "作り直すコマンド: plan --harness" });
}

function rows<T = Record<string, unknown>>(live: Live, sql: string, ...params: Array<string | number | null>): T[] {
  return live.database.db.prepare(sql).all(...params) as T[];
}

function appliedTableExists(live: Live): boolean {
  return rows(live, "SELECT name FROM sqlite_master WHERE name=?", APPLIED_TABLE).length === 1;
}

afterEach(() => {
  for (const directory of TEMPORARIES.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("本番の L Harness への投入（D1 と同じ入口の SQLite で確認）", () => {
  it("稼働中で友だちがいるアカウントに投入し、全予定行を少しずつ読み出して照合する", async () => {
    const live = liveHarness();
    const { outDir } = await plan(live);
    const result = await apply(live, outDir);
    expect(result.checked).toBeGreaterThan(20);
    expect(result.database).toBe("架空の本番D1");
    expect(result.resumedChunks).toBe(0);
    // 移行と関係ない元からの友だちは残る
    expect(rows(live, "SELECT id FROM friends WHERE id='already-there-1'")).toHaveLength(1);
    expect(rows(live, "SELECT COUNT(*) AS c FROM friends")[0]).toEqual({ c: 3 });
    // 移したシナリオ・フォームは停止のまま、アカウントは稼働のまま
    expect(rows(live, "SELECT DISTINCT is_active FROM scenarios WHERE line_account_id=?", ACCOUNT)).toEqual([{ is_active: 0 }]);
    expect(rows(live, "SELECT is_active FROM line_accounts")).toEqual([{ is_active: 1 }]);
    expect(rows(live, `SELECT status FROM ${APPLIED_TABLE}`)).toEqual([{ status: "applied" }]);
    expect(statSync(join(outDir, "apply-state.json")).mode & 0o777).toBe(0o600);
    // 同じ計画の再投入は内容を変えず、全部「流し済み」として飛ばす
    const before = rows(live, "SELECT * FROM messages_log ORDER BY id");
    const again = await apply(live, outDir);
    expect(again.resumedChunks).toBeGreaterThan(0);
    expect(rows(live, "SELECT * FROM messages_log ORDER BY id")).toEqual(before);
  });

  it("元からいる友だちは同じ ID を使い、表示名・アイコンを変えずにタグ・会話・情報を足す", async () => {
    const live = liveHarness({ existingHanako: true, existingTag: "回答済み✅" });
    const { outDir, manifest } = await plan(live);
    expect(manifest.reports.friends.notes.join("\n")).toContain("元からいる 1人");
    await apply(live, outDir);
    const hanako = rows<{ id: string; display_name: string; picture_url: string; metadata: string }>(live, "SELECT id,display_name,picture_url,metadata FROM friends WHERE line_user_id=?", HANAKO_UID)[0];
    expect(hanako.id).toBe("harness-made-hanako");
    expect(hanako.display_name).toBe("LINEで最新の名前");
    expect(hanako.picture_url).toBe("https://example.invalid/icon.png");
    expect(JSON.parse(hanako.metadata)._lstep.friend_id).toBe(1001);
    const tags = rows<{ id: string }>(live, "SELECT tag_id AS id FROM friend_tags WHERE friend_id='harness-made-hanako'").map((row) => row.id);
    expect(tags).toContain("harness-made-tag");
    expect(rows(live, "SELECT COUNT(*) AS c FROM tags WHERE name='回答済み✅'")[0]).toEqual({ c: 1 });
    expect(rows(live, "SELECT COUNT(*) AS c FROM messages_log WHERE friend_id='harness-made-hanako'")[0]).toEqual({ c: 3 });
    expect(rows(live, "PRAGMA foreign_key_check")).toEqual([]);
  });

  it("並行運用中に L Harness が自分で記録した会話は、二重に入れない（ほかの会話の ID は変えない）", async () => {
    const live = liveHarness({ existingHanako: true });
    // ブリッジ経由で L Harness が記録した、Lステップの履歴にもある会話（ID は L Harness が作る UUID v4）
    live.database.db.prepare("INSERT INTO messages_log (id,friend_id,direction,message_type,content,created_at) VALUES (?,?,?,?,?,?)")
      .run("0b6c1d2e-3f40-4a5b-8c7d-9e0f1a2b3c4d", "harness-made-hanako", "incoming", "text", "こんにちは😊\n'A社'について相談です。", "2026-10-24T09:03:00.000");
    const { outDir, manifest } = await plan(live);
    expect(manifest.reports.messages.notes.join("\n")).toContain("同じ 1件");
    await apply(live, outDir);
    const contents = rows<{ content: string; id: string }>(live, "SELECT id,content FROM messages_log WHERE friend_id='harness-made-hanako' ORDER BY created_at");
    expect(contents.filter((row) => row.content.startsWith("こんにちは"))).toHaveLength(1);
    expect(contents).toHaveLength(3);
    // 飛ばした会話の後ろの会話も、飛ばさなかったときと同じ ID になる
    const plain = liveHarness({ existingHanako: true });
    const { outDir: plainOut } = await plan(plain);
    await apply(plain, plainOut);
    const plainIds = rows<{ id: string }>(plain, "SELECT id FROM messages_log WHERE friend_id='harness-made-hanako'").map((row) => row.id);
    for (const row of contents.filter((row) => !row.content.startsWith("こんにちは"))) expect(plainIds).toContain(row.id);
  });

  it("元からいる友だちの L Harness 側のメタデータ・登録日時を消さず、追加日は古い方にする", async () => {
    const live = liveHarness({ existingHanako: true });
    live.database.db.prepare("UPDATE friends SET metadata=?, created_at=?, first_followed_at=? WHERE id='harness-made-hanako'")
      .run(JSON.stringify({ harness_only: "残す", score_note: { a: 1 } }), "2026-10-26T10:00:00.000+09:00", "2026-10-26T10:00:00.000+09:00");
    const { outDir } = await plan(live);
    await apply(live, outDir);
    const hanako = rows<{ metadata: string; created_at: string; first_followed_at: string }>(live, "SELECT metadata,created_at,first_followed_at FROM friends WHERE id='harness-made-hanako'")[0];
    const metadata = JSON.parse(hanako.metadata);
    expect(metadata.harness_only).toBe("残す");
    expect(metadata.score_note).toEqual({ a: 1 });
    expect(metadata._lstep.friend_id).toBe(1001);
    expect(hanako.created_at).toBe("2026-10-26T10:00:00.000+09:00");
    expect(hanako.first_followed_at).toBe("2026-10-24T09:00:00.000+09:00");
    // 再投入でも消えず、照合も通る
    await expect(apply(live, outDir)).resolves.toMatchObject({ partial: true });
    expect(JSON.parse(rows<{ metadata: string }>(live, "SELECT metadata FROM friends WHERE id='harness-made-hanako'")[0].metadata).harness_only).toBe("残す");
  });

  it("元からある L Harness のチャットのメモ・未読を残し、最終日時を古くしない", async () => {
    const live = liveHarness({ existingHanako: true });
    live.database.db.prepare("INSERT INTO chats (id,friend_id,status,notes,last_message_at,line_account_id) VALUES (?,?,?,?,?,?)")
      .run("harness-made-chat", "harness-made-hanako", "unread", "L Harness で書いたメモ", "2026-10-27T12:00:00.000+09:00", ACCOUNT);
    const { outDir } = await plan(live);
    await apply(live, outDir);
    await apply(live, outDir);
    expect(rows(live, "SELECT id,status,notes,last_message_at FROM chats WHERE friend_id='harness-made-hanako'")).toEqual([
      { id: "harness-made-chat", status: "unread", notes: "L Harness で書いたメモ", last_message_at: "2026-10-27T12:00:00.000+09:00" },
    ]);
    // このツールが作ったチャットでも、L Harness で人が書いたメモ・付けた未読は移行し直しても残す
    const taroId = harnessId("friend", ACCOUNT, 1002);
    live.database.db.prepare("UPDATE chats SET notes='移行後に書いたメモ', status='unread' WHERE friend_id=?").run(taroId);
    await apply(live, outDir);
    expect(rows(live, "SELECT notes,status FROM chats WHERE friend_id=?", taroId)).toEqual([{ notes: "移行後に書いたメモ", status: "unread" }]);
  });

  it("移行し直しても、L Harness で有効にしたシナリオを止めず、進行も上書きしない。Lステップで止めた人は一時停止にする", async () => {
    const live = liveHarness();
    const first = await plan(live, "plan-1");
    await apply(live, first.outDir);
    const scenarioId = rows<{ id: string }>(live, "SELECT id FROM scenarios WHERE line_account_id=?", ACCOUNT)[0].id;
    live.database.db.prepare("UPDATE scenarios SET is_active=1 WHERE id=?").run(scenarioId);
    live.database.db.prepare("UPDATE friend_scenarios SET current_step_order=77, status='active' WHERE friend_id=?").run(harnessId("friend", ACCOUNT, 1001));
    // 次の取得では、太郎（完了）はそのまま、花子は Lステップで止めた
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
    fixture.exportedAt = "2026-10-26T00:00:00.000Z";
    fixture.data.friends[0].scenarios[0].status = "stopped";
    const snapshot = join(live.directory, "second", "snapshot");
    writeSourceSnapshot(importBrowserExport(fixture), snapshot);
    const second = await plan(live, "plan-2", snapshot);
    await apply(live, second.outDir);
    expect(rows(live, "SELECT is_active FROM scenarios WHERE id=?", scenarioId)).toEqual([{ is_active: 1 }]);
    // 有効にした後は進行を上書きしない（一時停止にもしない）
    expect(rows(live, "SELECT current_step_order,status FROM friend_scenarios WHERE friend_id=?", harnessId("friend", ACCOUNT, 1001))).toEqual([{ current_step_order: 77, status: "active" }]);
    // 停止中のシナリオなら、止めた人は一時停止になる
    live.database.db.prepare("UPDATE scenarios SET is_active=0 WHERE id=?").run(scenarioId);
    const third = await plan(live, "plan-3", snapshot);
    await apply(live, third.outDir);
    expect(rows(live, "SELECT status,next_delivery_at FROM friend_scenarios WHERE friend_id=?", harnessId("friend", ACCOUNT, 1001))).toEqual([{ status: "paused", next_delivery_at: null }]);
  });

  it("L Harness で有効にしたシナリオに新しく入る人は一時停止で入れ、ステップの中身も書き換えない", async () => {
    const live = liveHarness();
    // 最初は太郎だけ移す（花子はまだ Lステップに居ない）
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const onlyTaro = { ...fixture, data: { ...fixture.data, friends: fixture.data.friends.filter((f: { id: number }) => f.id === 1002) } };
    const firstSnapshot = join(live.directory, "first", "snapshot");
    writeSourceSnapshot(importBrowserExport(onlyTaro), firstSnapshot);
    const first = await plan(live, "plan-1", firstSnapshot);
    await apply(live, first.outDir);
    const scenarioId = rows<{ id: string }>(live, "SELECT id FROM scenarios WHERE line_account_id=?", ACCOUNT)[0].id;
    live.database.db.prepare("UPDATE scenarios SET is_active=1 WHERE id=?").run(scenarioId);
    live.database.db.prepare("UPDATE scenario_steps SET message_content='L Harness で直した本文' WHERE scenario_id=?").run(scenarioId);
    // 花子の会話履歴に「1通目を送った」記録を足して、配信中（続きから送る）として入る状態にする
    const friendFile = join(live.snapshotDir, "friends", "1001.json");
    const friend = JSON.parse(readFileSync(friendFile, "utf8"));
    friend.conversation.messages.push({
      message_id: 499, sender: "bot", message_type: "scenario", sent_at: "2026-10-24T00:00:30.000Z",
      source: { type: "scenario", name: "二段階の案内📩" },
      content: [{ type: "text", content: "ご登録ありがとうございます🌸\n\"移行テスト\"のご案内です。" }],
    });
    writeFileSync(friendFile, JSON.stringify(friend));
    const second = await plan(live, "plan-2");
    expect(second.manifest.reports.friend_scenarios.notes.join("\n")).toContain("有効にしているシナリオに新しく入る 1人");
    await apply(live, second.outDir);
    expect(rows(live, "SELECT status,next_delivery_at FROM friend_scenarios WHERE friend_id=?", harnessId("friend", ACCOUNT, 1001))).toEqual([{ status: "paused", next_delivery_at: null }]);
    expect(rows(live, "SELECT DISTINCT message_content FROM scenario_steps WHERE scenario_id=?", scenarioId)).toEqual([{ message_content: "L Harness で直した本文" }]);
  });

  it("L Harness で有効にしたシナリオには、Lステップで足したステップ・変えた配信方式を入れない", async () => {
    const live = liveHarness();
    const first = await plan(live, "plan-1");
    await apply(live, first.outDir);
    const scenarioId = rows<{ id: string }>(live, "SELECT id FROM scenarios WHERE line_account_id=?", ACCOUNT)[0].id;
    live.database.db.prepare("UPDATE scenarios SET is_active=1 WHERE id=?").run(scenarioId);
    const before = rows(live, "SELECT * FROM scenario_steps WHERE scenario_id=? ORDER BY step_order", scenarioId);
    const beforeScenario = rows(live, "SELECT name,delivery_mode,is_active FROM scenarios WHERE id=?", scenarioId);
    // Lステップ側でステップを1つ足し、全部を「すぐ送る」に変えた
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
    fixture.exportedAt = "2026-10-26T00:00:00.000Z";
    const scenario = fixture.data.scenarios[0];
    scenario.steps = [...scenario.steps.map((step: Record<string, unknown>) => ({ ...step, delay_type: "immediate" })),
      { id: 3003, order_number: 3, delay_type: "immediate", templates: [{ id: 503, type: "text", content: "足したステップ" }], actions: [] }];
    const snapshot = join(live.directory, "second", "snapshot");
    writeSourceSnapshot(importBrowserExport(fixture), snapshot);
    const second = await plan(live, "plan-2", snapshot);
    expect(second.manifest.reports.scenarios.notes.join("\n")).toContain("有効にしているシナリオ 1件");
    await apply(live, second.outDir);
    expect(rows(live, "SELECT * FROM scenario_steps WHERE scenario_id=? ORDER BY step_order", scenarioId)).toEqual(before);
    expect(rows(live, "SELECT name,delivery_mode,is_active FROM scenarios WHERE id=?", scenarioId)).toEqual(beforeScenario);
  });

  it("計画の後にシナリオが有効にされたら、本番に書かずに作り直しを案内する", async () => {
    const live = liveHarness();
    const first = await plan(live, "plan-1");
    await apply(live, first.outDir);
    const second = await plan(live, "plan-2");
    live.database.db.prepare("UPDATE scenarios SET is_active=1 WHERE line_account_id=?").run(ACCOUNT);
    live.database.executed.length = 0;
    await expect(apply(live, second.outDir)).rejects.toThrow(/シナリオが L Harness で有効にされています/);
    expect(live.database.executed).toEqual([]);
  });

  it("計画の後に友だちが増えていたら、本番に書かずに作り直しを案内する", async () => {
    const live = liveHarness();
    const { outDir } = await plan(live);
    live.database.db.prepare("INSERT INTO friends (id,line_user_id,line_account_id) VALUES (?,?,?)").run("joined-meanwhile", TARO_UID, ACCOUNT);
    await expect(apply(live, outDir)).rejects.toThrow(/計画を作った後に、L Harness に友だちが増えています[\s\S]*plan --harness/);
    expect(appliedTableExists(live)).toBe(false);
    expect(live.database.executed).toEqual([]);
    // 作り直した計画なら入る
    const replanned = await plan(live, "plan-2");
    await expect(apply(live, replanned.outDir)).resolves.toMatchObject({ partial: true });
    expect(rows(live, "SELECT id FROM friends WHERE line_user_id=?", TARO_UID)).toEqual([{ id: "joined-meanwhile" }]);
  });

  it("計画の後に同じ名前のタグができていたら止める", async () => {
    const live = liveHarness();
    const { outDir } = await plan(live);
    live.database.db.prepare("INSERT INTO tags (id,name) VALUES ('made-meanwhile','回答済み✅')").run();
    await expect(apply(live, outDir)).rejects.toThrow(/同じ名前のタグ/);
    expect(live.database.executed).toEqual([]);
  });

  it("移す友だちが別のアカウントにいるときは計画の段階で止める", async () => {
    const live = liveHarness();
    live.database.db.prepare("INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret) VALUES ('other','other-channel','別','t','s')").run();
    live.database.db.prepare("INSERT INTO friends (id,line_user_id,line_account_id) VALUES ('elsewhere',?, 'other')").run(HANAKO_UID);
    await expect(plan(live)).rejects.toThrow(/別のアカウント/);
  });

  it("投入前の状態のしおりは、やり直しても最初のものを残す", async () => {
    const live = liveHarness();
    const { outDir } = await plan(live);
    let n = 0;
    live.database.bookmark = async () => `bookmark-${++n}`;
    expect((await apply(live, outDir)).bookmark).toBe("bookmark-1");
    expect((await apply(live, outDir)).bookmark).toBe("bookmark-1");
    const lines = readFileSync(join(outDir, "bookmark.txt"), "utf8").trim().split("\n");
    expect(lines.map((line) => line.split(" ")[0])).toEqual(["bookmark-1", "bookmark-2"]);
  });

  it("途中で止まっても、同じ apply で続きから流して照合まで終える", async () => {
    const live = liveHarness();
    const { outDir } = await plan(live);
    live.database.failAt = 4; // 移行記録の1本＋SQL 2本を流したあと
    await expect(apply(live, outDir)).rejects.toThrow("試験用の失敗");
    expect(rows(live, `SELECT status FROM ${APPLIED_TABLE}`)).toEqual([{ status: "failed" }]);
    live.database.failAt = undefined;
    live.database.executed.length = 0;
    const result = await apply(live, outDir);
    expect(result.resumedChunks).toBe(2);
    expect(rows(live, `SELECT status FROM ${APPLIED_TABLE}`)).toEqual([{ status: "applied" }]);
  });

  it("投入後に中身が変わっていれば照合で見つける（個人データは出さない）", async () => {
    const live = liveHarness();
    const { outDir } = await plan(live);
    await apply(live, outDir);
    live.database.db.prepare("UPDATE messages_log SET content='書き換え' WHERE id=(SELECT id FROM messages_log LIMIT 1)").run();
    const error = await verifyHarness(outDir, live.database).catch((e: Error) => e);
    expect(String(error)).toContain("内容の照合に失敗しました: messages_log");
    expect(String(error)).not.toContain("架空花子");
  });

  it("プロフィール更新後は明示したときだけ4列を別枠にし、再投入しても更新値や他のデータを変えない", async () => {
    const live = liveHarness();
    const { outDir } = await plan(live);
    const first = await apply(live, outDir);
    expect(first).not.toHaveProperty("profileUpdates");
    const expectedBefore = readFileSync(join(outDir, "expected.json"), "utf8");
    // L Harness の refresh-profiles と同じ4列を更新する（実際のLINEには接続しない）
    live.database.db.prepare("UPDATE friends SET display_name=?,picture_url=?,status_message=?,updated_at=? WHERE line_user_id=?")
      .run("LINEで更新した名前", "https://example.invalid/refreshed.png", "更新後の状態", "2026-10-30T00:00:00.000Z", HANAKO_UID);
    const strictError = await verifyHarness(outDir, live.database).catch((error: Error) => error);
    // 更新日時は既存の方が新しければ残す列なので照合しない
    expect(String(strictError)).toMatch(/friends.*display_name.*picture_url.*status_message/);
    expect(String(strictError)).not.toContain("LINEで更新した名前");
    expect(String(strictError)).not.toContain("refreshed.png");

    const dataTables = rows<{ name: string }>(live, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>? ORDER BY name", APPLIED_TABLE)
      .map(({ name }) => name);
    const dataSnapshot = () => Object.fromEntries(dataTables.map((table) => [table, rows(live, `SELECT * FROM "${table}" ORDER BY rowid`)]));
    const before = dataSnapshot();
    const profileUpdates = {
      skippedFields: 6, // 今回新規に移した2人 × 3列（更新日時はもともと照合しない）。元からいる別の友だちは対象外
      changedFields: 3,
      changedColumns: { display_name: 1, picture_url: 1, status_message: 1 },
    };
    await expect(verifyHarness(outDir, live.database, { allowProfileUpdates: true })).resolves.toMatchObject({ checked: first.checked, profileUpdates });
    expect(dataSnapshot()).toEqual(before);
    live.database.executed.length = 0;
    const resumed = await applyHarness(outDir, live.database, { key: KEY, allowPartial: true, allowProfileUpdates: true });
    expect(resumed).toMatchObject({ checked: first.checked, profileUpdates });
    expect(resumed.resumedChunks).toBeGreaterThan(0);
    expect(live.database.executed.every((file) => !file.includes(`${join(outDir, "sql")}/`))).toBe(true);
    expect(dataSnapshot()).toEqual(before);
    expect(readFileSync(join(outDir, "expected.json"), "utf8")).toBe(expectedBefore);
    expect(rows(live, `SELECT status FROM ${APPLIED_TABLE}`)).toEqual([{ status: "applied" }]);
  });

  it.each([
    { column: "metadata", table: "friends", sql: "UPDATE friends SET metadata='{}' WHERE line_user_id=?", parameter: HANAKO_UID },
    { column: "line_user_id", table: "friends", sql: "UPDATE friends SET line_user_id='corrupted-uid-must-not-be-printed' WHERE line_user_id=?", parameter: HANAKO_UID },
    { column: "content", table: "messages_log", sql: "UPDATE messages_log SET content='sensitive-message-must-not-be-printed' WHERE friend_id=?", parameter: harnessId("friend", ACCOUNT, 1001) },
  ])("プロフィール更新を許容しても $table の $column の改変は照合失敗になる", async ({ column, table, sql, parameter }) => {
    const live = liveHarness();
    const { outDir } = await plan(live);
    await apply(live, outDir);
    live.database.db.prepare("UPDATE friends SET picture_url='https://example.invalid/refreshed.png' WHERE line_user_id=?").run(HANAKO_UID);
    await expect(verifyHarness(outDir, live.database, { allowProfileUpdates: true })).resolves.toHaveProperty("profileUpdates.changedFields", 1);
    live.database.db.prepare(sql).run(parameter);
    const error = await verifyHarness(outDir, live.database, { allowProfileUpdates: true }).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(`内容の照合に失敗しました: ${table}`);
    expect(String(error)).toContain(`${column === "line_user_id" ? "照合キー列" : "不一致の列"}: ${column}`);
    expect(String(error)).not.toContain("must-not-be-printed");
    expect(String(error)).not.toContain(HANAKO_UID);
  });

  it("古い取得結果で新しい移行を上書きしない", async () => {
    const live = liveHarness();
    const newer = await plan(live, "plan-newer");
    await apply(live, newer.outDir);
    // 取得時刻だけ古い取得結果
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
    fixture.exportedAt = "2026-10-01T00:00:00.000Z";
    const olderSnapshot = join(live.directory, "older", "snapshot");
    writeSourceSnapshot(importBrowserExport(fixture), olderSnapshot);
    const older = await plan(live, "plan-older", olderSnapshot);
    await expect(apply(live, older.outDir)).rejects.toThrow(/新しい取得結果をすでに入れています/);
  });

  it("L Harness の表の形が違えば、書き込む前に止める", async () => {
    const live = liveHarness({ dropColumn: "status_message" });
    const { outDir } = await plan(live);
    await expect(apply(live, outDir)).rejects.toThrow(/friends\.status_message/);
    expect(appliedTableExists(live)).toBe(false);
  });

  it("移行先アカウントが無ければ止める", async () => {
    const live = liveHarness();
    const { outDir } = await plan(live);
    live.database.db.exec("PRAGMA foreign_keys=OFF");
    live.database.db.prepare("UPDATE line_accounts SET id='renamed'").run();
    await expect(apply(live, outDir)).rejects.toBeInstanceOf(HarnessCheckError);
    expect(live.database.executed).toEqual([]);
  });

  it("試験用DB向けの計画と本番向けの計画を取り違えない", async () => {
    const live = liveHarness();
    const localPlan = join(live.directory, "run", "local-plan");
    createPlan(live.snapshotDir, localPlan, ACCOUNT);
    await expect(apply(live, localPlan)).rejects.toThrow(/手元の試験用DB向け/);
    const { outDir } = await plan(live);
    expect(() => applyLocal(outDir, live.dbPath, true)).toThrow(/本番の L Harness 向け/);
    await expect(applyHarness(outDir, live.database, { key: "d1:another", allowPartial: true })).rejects.toThrow(/別のデータベース向け/);
    await expect(applyHarness(outDir, live.database, { key: KEY })).rejects.toThrow(/--allow-partial/);
    expect(existsSync(join(outDir, "apply-state.json"))).toBe(false);
  });

  it("前回このツールで移した友だちは『元からいる人』と数えない", async () => {
    const live = liveHarness();
    const first = await plan(live, "plan-1");
    await apply(live, first.outDir);
    const second = await plan(live, "plan-2");
    const notes = second.manifest.reports.friends.notes.join("\n");
    expect(notes).toContain("前回移した 2人");
    expect(notes).not.toContain("元からいる");
    await expect(apply(live, second.outDir)).resolves.toMatchObject({ checked: expect.any(Number) });
    expect(rows(live, "SELECT id FROM friends WHERE line_user_id=?", HANAKO_UID)).toEqual([{ id: harnessId("friend", ACCOUNT, 1001) }]);
  });
});
