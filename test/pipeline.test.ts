import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalD1 } from "../src/d1/local.js";
import { harnessId } from "../src/harness/ids.js";
import { importBrowserExport } from "../src/lstep/browser.js";
import { applyLocal, createPlan, verifyLocal, writeSourceSnapshot } from "../src/pipeline.js";

const FIXTURE = new URL("fixtures/lstep-browser.json", import.meta.url);
const SCHEMA = fileURLToPath(new URL("../schema/line-harness-bootstrap.sql", import.meta.url));
const ACCOUNT = "fictional-target-a";
const OTHER_ACCOUNT = "fictional-target-b";
const HANAKO_UID = "U11111111111111111111111111111111";
const TARO_UID = "U22222222222222222222222222222222";
const HANAKO_NAME = "架空花子🌸 \"A'\"\n二行目";
const CONSULTATION = "製造業 \"A社\" / 'B店'\n架空県🌾";
const TEMPORARIES: string[] = [];

function source() {
  return importBrowserExport(JSON.parse(readFileSync(FIXTURE, "utf8")));
}

function prepare(accounts: string[] = [ACCOUNT]) {
  const directory = mkdtempSync(join(tmpdir(), "lstep-pipeline-"));
  TEMPORARIES.push(directory);
  const snapshotDir = join(directory, "snapshot");
  const outDir = join(directory, "out");
  const dbPath = join(directory, "test.sqlite");
  const exported = source();
  const snapshot = writeSourceSnapshot(exported, snapshotDir);
  const manifest = createPlan(snapshotDir, outDir, ACCOUNT);
  const database = new LocalD1(dbPath);
  try {
    database.loadSchema(SCHEMA);
    for (const account of accounts) {
      database.db.prepare("INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret,is_active) VALUES (?,?,?,?,?,0)")
        .run(account, `${account}-channel`, "架空のローカル試験", "fictional-token", "fictional-secret");
    }
  } finally {
    database.close();
  }
  return { directory, snapshotDir, outDir, dbPath, exported, snapshot, manifest };
}

type Prepared = ReturnType<typeof prepare>;

function inspect<Result>(prepared: Prepared, callback: (database: LocalD1) => Result): Result {
  const database = new LocalD1(prepared.dbPath);
  try { return callback(database); }
  finally { database.close(); }
}

function apply(prepared: Prepared) {
  return applyLocal(prepared.outDir, prepared.dbPath, true);
}

afterEach(() => {
  for (const directory of TEMPORARIES.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("browser import → snapshot → plan → SQLite → verify", () => {
  it("preserves the imported records in the snapshot and reports partial coverage", () => {
    const prepared = prepare();
    expect(prepared.snapshot.friendCount()).toBe(2);
    expect(prepared.snapshot.readFriend(1001)?.row).toMatchObject({
      line_friend_id: HANAKO_UID, line_name: HANAKO_NAME, is_blocked: false,
    });
    expect(prepared.snapshot.readFriend(1002)?.detail?.is_blocked).toBe(true);
    expect(prepared.snapshot.readJson("forms.json")).toEqual(prepared.exported.resources.forms);
    expect(prepared.snapshot.readJson("form_responses/601.json")).toEqual(prepared.exported.resources.formResponses["601"]);
    expect(prepared.snapshot.readJson("coverage.json")).toEqual(prepared.exported.coverage);
    expect(prepared.manifest.reports.source_formBehavior.level).toBe("partial");
    expect(prepared.manifest.reports.source_autoReplies.level).toBe("none");
    expect(prepared.manifest.warnings).toContain("formBehavior: partial");
    expect(prepared.manifest.warnings).toContain("autoReplies: unsupported");
    expect(readFileSync(join(prepared.outDir, "report.md"), "utf8")).toContain("formBehavior");
  });

  it("migrates exact identities, names, tags, information values and blocked state", () => {
    const prepared = prepare();
    expect(apply(prepared).checked).toBeGreaterThan(0);
    inspect(prepared, database => {
      const friends = database.all<{ id: string; line_user_id: string; display_name: string; is_following: number; metadata: string }>(
        "SELECT id,line_user_id,display_name,is_following,metadata FROM friends ORDER BY line_user_id",
      );
      expect(friends).toHaveLength(2);
      expect(friends[0]).toMatchObject({
        id: harnessId("friend", ACCOUNT, 1001), line_user_id: HANAKO_UID,
        display_name: HANAKO_NAME, is_following: 1,
      });
      expect(friends[1]).toMatchObject({
        id: harnessId("friend", ACCOUNT, 1002), line_user_id: TARO_UID,
        display_name: "架空太郎🍁", is_following: 0,
      });
      const metadata = JSON.parse(friends[0].metadata);
      expect(metadata["相談'内容📩"]).toBe(CONSULTATION);
      expect(metadata["ポイント"]).toBe(0);
      expect(metadata["生年月日"]).toBe("1990-01-02");
      expect(metadata["好きな季節"]).toEqual(["春🌸", "秋🍁"]);
      expect(metadata["同意確認"]).toBe(false);
      expect(metadata._lstep.friend_id).toBe(1001);
      expect(metadata._lstep.friend_info["201"]).toEqual({ title: "相談'内容📩", value: CONSULTATION });
      expect(metadata._lstep.scenarios[0].status).toBe("following");
      expect(metadata._lme).toBeUndefined();
      const tags = database.all<{ name: string }>(
        "SELECT t.name FROM friend_tags ft JOIN tags t ON t.id=ft.tag_id JOIN friends f ON f.id=ft.friend_id WHERE f.line_user_id=?",
        HANAKO_UID,
      );
      expect(tags.map(tag => tag.name).sort()).toEqual(["資料請求'済み📩", "回答済み✅"].sort());
      expect(database.count("friend_tags")).toBe(3);
      expect(database.all("PRAGMA foreign_key_check")).toEqual([]);
    });
    expect(verifyLocal(prepared.outDir, prepared.dbPath).checked).toBeGreaterThan(0);
  });

  it("retains form field types, required flags and all selection options", () => {
    const prepared = prepare();
    apply(prepared);
    inspect(prepared, database => {
      const form = database.all<{ name: string; fields: string; submit_count: number; is_active: number }>(
        "SELECT name,fields,submit_count,is_active FROM forms",
      )[0];
      expect(form.name).toBe("お試し相談🌸 \"移行'確認\"");
      expect(form.submit_count).toBe(2);
      expect(form.is_active).toBe(0);
      const fields = JSON.parse(form.fields) as Array<{ name: string; type: string; required: boolean; options?: string[]; placeholder?: string }>;
      expect(fields.map(field => field.type)).toEqual(["text", "textarea", "select", "radio", "checkbox", "date", "email", "tel", "number"]);
      expect(fields[0]).toMatchObject({ name: "お名前", required: true, placeholder: "架空花子" });
      expect(fields[1].required).toBe(false);
      expect(fields[2]).toMatchObject({ required: true, options: ["はじめて🌱", "継続🍀"] });
      expect(fields[3].options).toEqual(["メール📧", "LINE"]);
      expect(fields[4].options).toEqual(["文章✍️", "動画🎥", "仕組み⚙️"]);
      expect(fields[6].required).toBe(true);
      expect(fields.some(field => field.name === "参考資料")).toBe(false);
    });
    expect(prepared.manifest.reports.forms.notes.join("\n")).toContain("ファイル添付");
  });

  it("retains every answer including arrays, dates, zero, quotes, newlines and attachment URLs", () => {
    const prepared = prepare();
    apply(prepared);
    inspect(prepared, database => {
      const submissions = database.all<{ line_user_id: string; data: string; friend_id: string }>(
        "SELECT f.line_user_id,s.data,s.friend_id FROM form_submissions s JOIN friends f ON f.id=s.friend_id ORDER BY f.line_user_id",
      );
      expect(submissions).toHaveLength(2);
      expect(submissions[0].friend_id).toBe(harnessId("friend", ACCOUNT, 1001));
      expect(JSON.parse(submissions[0].data)).toEqual({
        お名前: HANAKO_NAME, "相談内容📩": CONSULTATION, 希望コース: "はじめて🌱",
        連絡方法: "メール📧", 関心のあること: ["文章✍️", "仕組み⚙️"],
        相談希望日: "2026-11-01 10:30", メールアドレス: "hanako@example.invalid",
        電話番号: "000-0000-0000", 予算: 0,
        // 添付の設問は L Harness に移さないので、回答（URL）は設問に結び付けずに退避欄へ残す
        _unmatched_answers: [{ name: "参考資料", value: "https://example.invalid/fictional-attachment.pdf" }],
      });
      expect(submissions[1].friend_id).toBe(harnessId("friend", ACCOUNT, 1002));
      expect(JSON.parse(submissions[1].data)).toEqual({
        お名前: "架空太郎🍁", "相談内容📩": "引用符 ' と \" と改行\n確認🍁", 希望コース: "継続🍀",
        連絡方法: "LINE", 関心のあること: [], 相談希望日: "2026-11-02",
        メールアドレス: "taro@example.invalid", 電話番号: "", 予算: 12000,
        _unmatched_answers: [{ name: "参考資料", value: "" }],
      });
    });
  });

  it("retains both scenario steps and both conversation directions with automations stopped", () => {
    const prepared = prepare();
    apply(prepared);
    inspect(prepared, database => {
      const scenarios = database.all<{ id: string; name: string; is_active: number; trigger_type: string }>(
        "SELECT id,name,is_active,trigger_type FROM scenarios WHERE line_account_id=?", ACCOUNT,
      );
      expect(scenarios).toEqual([{ id: harnessId("scenario", ACCOUNT, 301), name: "二段階の案内📩", is_active: 0, trigger_type: "manual" }]);
      const steps = database.all<{ message_content: string; offset_days: number | null; delivery_time: string | null }>(
        "SELECT message_content,offset_days,delivery_time FROM scenario_steps ORDER BY step_order",
      );
      expect(steps).toHaveLength(2);
      expect(steps[0].message_content).toBe("ご登録ありがとうございます🌸\n\"移行テスト\"のご案内です。");
      expect(steps[1]).toMatchObject({ message_content: "翌日の確認です📩\n回答をお願いします。", offset_days: 1, delivery_time: "09:00" });
      expect(database.count("friend_scenarios")).toBe(2);
      expect(database.count("friend_scenarios", "status='completed'")).toBe(1);
      const messages = database.all<{ direction: string; content: string }>(
        "SELECT m.direction,m.content FROM messages_log m JOIN friends f ON f.id=m.friend_id WHERE f.line_user_id=? ORDER BY m.created_at", HANAKO_UID,
      );
      expect(messages).toEqual([
        { direction: "outgoing", content: "ご登録ありがとうございます🌸\n\"移行テスト\"のご案内です。" },
        { direction: "incoming", content: "こんにちは😊\n'A社'について相談です。" },
        { direction: "outgoing", content: "承りました。\"ご相談\"ありがとうございます📩" },
      ]);
      expect(database.count("messages_log")).toBe(5);
      expect(database.count("forms", "is_active<>0")).toBe(0);
      expect(database.count("auto_replies", `line_account_id='${ACCOUNT}' AND is_active<>0`)).toBe(0);
      expect(database.count("booking_reminders")).toBe(0);
    });
  });

  it("is idempotent and verifies exact values after repeated application", () => {
    const prepared = prepare();
    const first = apply(prepared);
    const initial = inspect(prepared, database => ({
      friends: database.all("SELECT * FROM friends ORDER BY id"),
      submissions: database.all("SELECT * FROM form_submissions ORDER BY id"),
      messages: database.all("SELECT * FROM messages_log ORDER BY id"),
      tags: database.all("SELECT * FROM friend_tags ORDER BY friend_id,tag_id"),
    }));
    expect(apply(prepared)).toEqual(first);
    expect(inspect(prepared, database => ({
      friends: database.all("SELECT * FROM friends ORDER BY id"),
      submissions: database.all("SELECT * FROM form_submissions ORDER BY id"),
      messages: database.all("SELECT * FROM messages_log ORDER BY id"),
      tags: database.all("SELECT * FROM friend_tags ORDER BY friend_id,tag_id"),
    }))).toEqual(initial);
    expect(verifyLocal(prepared.outDir, prepared.dbPath)).toEqual(first);
  });

  it("requires explicit partial-data approval before making writes", () => {
    const prepared = prepare();
    expect(() => applyLocal(prepared.outDir, prepared.dbPath)).toThrow("--allow-partial");
    expect(inspect(prepared, database => database.count("friends"))).toBe(0);
    expect(apply(prepared).partial).toBe(true);
    expect(verifyLocal(prepared.outDir, prepared.dbPath).partial).toBe(true);
  });

  it("requires an existing destination account and never creates it automatically", () => {
    const prepared = prepare([OTHER_ACCOUNT]);
    expect(() => apply(prepared)).toThrow("LINEアカウントがありません");
    inspect(prepared, database => {
      expect(database.all("SELECT id FROM line_accounts")).toEqual([{ id: OTHER_ACCOUNT }]);
      expect(database.count("friends")).toBe(0);
      expect(database.count("forms")).toBe(0);
    });
  });

  it.each([ACCOUNT, OTHER_ACCOUNT])("rejects an existing UID under another friend ID in account %s before writing", account => {
    const prepared = prepare([ACCOUNT, OTHER_ACCOUNT]);
    inspect(prepared, database => {
      database.db.prepare("INSERT INTO friends (id,line_user_id,display_name,line_account_id,metadata) VALUES (?,?,?,?,?)")
        .run("preexisting-friend", HANAKO_UID, "先に登録した架空人物", account, '{"preserved":true}');
    });
    expect(() => apply(prepared)).toThrow(/同一友だち|すでに別の取得結果か友だち/);
    inspect(prepared, database => {
      expect(database.all("SELECT id,line_account_id,metadata FROM friends")).toEqual([
        { id: "preexisting-friend", line_account_id: account, metadata: '{"preserved":true}' },
      ]);
      expect(database.count("forms")).toBe(0);
      expect(database.count("friend_tags")).toBe(0);
    });
  });

  it("uses distinct deterministic IDs for different destination accounts", () => {
    const prepared = prepare();
    const otherOut = join(prepared.directory, "other-account-plan");
    createPlan(prepared.snapshotDir, otherOut, OTHER_ACCOUNT);
    const first = JSON.parse(readFileSync(join(prepared.outDir, "expected.json"), "utf8"));
    const second = JSON.parse(readFileSync(join(otherOut, "expected.json"), "utf8"));
    const firstIds = first.rows.filter((row: { values: { id?: string } }) => row.values.id).map((row: { values: { id: string } }) => row.values.id);
    const secondIds = new Set(second.rows.filter((row: { values: { id?: string } }) => row.values.id).map((row: { values: { id: string } }) => row.values.id));
    expect(firstIds.length).toBeGreaterThan(10);
    expect(firstIds.some((id: string) => secondIds.has(id))).toBe(false);
    expect(harnessId("friend", ACCOUNT, 1001)).not.toBe(harnessId("friend", OTHER_ACCOUNT, 1001));
  });

  it("detects edited SQL before applying any migration records", () => {
    const prepared = prepare();
    const sqlFile = join(prepared.outDir, prepared.manifest.chunks[0].file);
    writeFileSync(sqlFile, `${readFileSync(sqlFile, "utf8")}\n`);
    expect(() => apply(prepared)).toThrow("移行SQLが計画作成後に変更");
    expect(inspect(prepared, database => database.count("friends"))).toBe(0);
  });

  it("detects a changed answer even when row counts still match", () => {
    const prepared = prepare();
    apply(prepared);
    inspect(prepared, database => {
      database.db.prepare("UPDATE form_submissions SET data=? WHERE id=?")
        .run('{"お名前":"変更された回答"}', harnessId("form_submission", ACCOUNT, 601, 7001));
      expect(database.count("form_submissions")).toBe(2);
    });
    expect(() => verifyLocal(prepared.outDir, prepared.dbPath)).toThrow("内容の照合に失敗");
  });

  it("rolls back all migration records when a destination uniqueness constraint fails", () => {
    const prepared = prepare();
    inspect(prepared, database => {
      database.db.prepare("INSERT INTO tags (id,name) VALUES (?,?)").run("preexisting-tag", "資料請求'済み📩");
    });
    expect(() => apply(prepared)).toThrow(/UNIQUE|unique/);
    inspect(prepared, database => {
      expect(database.count("friends")).toBe(0);
      expect(database.count("forms")).toBe(0);
      expect(database.all("SELECT id,name FROM tags")).toEqual([{ id: "preexisting-tag", name: "資料請求'済み📩" }]);
    });
  });

  it("refuses to layer a re-extracted result onto a database that already holds another one", () => {
    const prepared = prepare();
    apply(prepared);
    expect(apply(prepared).checked).toBeGreaterThan(0);
    const changed = source();
    changed.exportedAt = "2026-10-26T00:00:00.000Z";
    changed.resources.tags = changed.resources.tags.slice(1);
    const secondSnapshot = join(prepared.directory, "snapshot-2");
    const secondPlan = join(prepared.directory, "out-2");
    writeSourceSnapshot(changed, secondSnapshot);
    createPlan(secondSnapshot, secondPlan, ACCOUNT);
    expect(() => applyLocal(secondPlan, prepared.dbPath, true)).toThrow("新しい試験用DB");
  });

  it("refuses an active target account", () => {
    const prepared = prepare();
    inspect(prepared, database => database.exec(`UPDATE line_accounts SET is_active=1 WHERE id='${ACCOUNT}'`));
    expect(() => apply(prepared)).toThrow("停止中ではありません");
    inspect(prepared, database => expect(database.count("friends")).toBe(0));
  });
});
