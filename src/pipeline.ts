import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_OPTIONS } from "./config.js";
import { LocalD1 } from "./d1/local.js";
import { harnessId } from "./harness/ids.js";
import { toHarnessJst } from "./harness/time.js";
import type { SourceExport } from "./lstep/export.js";
import type { ExistingMessage } from "./mapping/context.js";
import { buildPlan, writePlan, type PlanManifest } from "./mapping/plan.js";
import { SnapshotStore } from "./snapshot/store.js";
import type { Row, SqlValue } from "./sql/render.js";
import { ensurePrivateDir, readJsonFile, writePrivateFile } from "./util.js";

export interface ExpectedPlan {
  version: 1;
  lineAccountId: string;
  sourceAccountId: string;
  sourceDigest: string;
  /** 取得した時刻（本番へ古い取得結果を重ねないために使う） */
  exportedAt?: string;
  /** 本番の L Harness 向けの計画なら、どのデータベース向けか。手元の試験用DB向けなら無い */
  target?: { kind: "harness"; key: string; activeScenarioIds?: string[] };
  partial: boolean;
  rows: Row[];
  chunks: Array<{ file: string; sha256: string }>;
}

/** 本番の L Harness 向けに計画を作るときの、移行先の今の状態 */
export interface PlanTarget {
  /** どのデータベース向けか（apply で取り違えを止める） */
  key: string;
  /** 移行先で有効になっているシナリオ（このツールが前に入れて、L Harness で有効にしたもの） */
  activeScenarioIds?: Set<string>;
  /** 移行先の既存タグ（名前 → id）。同じ名前は作らずに使う */
  existingTags: Map<string, string>;
  /** 移行先に元からいる友だち（LINEユーザーID → id・所属アカウント） */
  existingFriends: Map<string, { id: string; line_account_id: string | null }>;
  /** 元からいる友だちについて L Harness が自分で記録した会話（friends.id ごと）。同じ会話は入れない */
  existingMessages?: Map<string, ExistingMessage[]>;
  /** このツールが前に入れたステップ（scenarios.id → scenario_steps.id）。有効なシナリオに残る古いステップを知らせるのに使う */
  existingStepIds?: Map<string, Set<string>>;
  /** L Harness 自身が作った未完了の進行状態（"friends.id\u0000scenarios.id"）。その組には進行状態を入れない */
  existingFriendScenarios?: Set<string>;
}

export interface VerificationResult {
  checked: number;
  tables: number;
  partial: boolean;
}

/** どの取得結果を移行したかを試験用DBに記録する表（L Harness 本体の表ではない） */
const APPLIED_TABLE = "lstep2harness_applied";

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSource(source: SourceExport): void {
  if (source.schemaVersion !== 1 || source.platform !== "lstep" || !["api", "browser"].includes(source.route)
    || !source.account.id.trim() || !Object.keys(source.coverage).length) {
    throw new Error("Lステップの取得結果または取得範囲が不正です");
  }
  const ids = new Set<number>();
  const uids = new Set<string>();
  for (const friend of source.resources.friends) {
    const { lmessage_friend_id: friendId, line_friend_id: uid } = friend.row;
    if (!Number.isSafeInteger(friendId) || friendId < 1 || !/^U[0-9a-f]{32}$/i.test(uid)
      || ids.has(friendId) || uids.has(uid)) {
      throw new Error("友だちの管理番号またはLINEユーザーIDが不正・重複しています");
    }
    if (friend.detail && (friend.detail.lmessage_friend_id !== friendId || friend.detail.line_friend_id !== uid)) {
      throw new Error("友だち一覧と詳細の識別子が一致しません");
    }
    ids.add(friendId);
    uids.add(uid);
  }
  if (Object.values(source.coverage).some(entry => entry.status === "failed")) {
    throw new Error("取得失敗が残っています。再取得してから保存してください");
  }
}

export function writeSourceSnapshot(source: SourceExport, destination: string): SnapshotStore {
  assertSource(source);
  if (existsSync(destination)) throw new Error("保存先が既にあります。取得ごとに新しいフォルダを指定してください");
  // 保存先の親は利用者のフォルダなので権限は変えない。新しく作る保存フォルダ以下だけを実行したユーザー限定にする
  mkdirSync(dirname(resolve(destination)), { recursive: true });
  const temporary = `${resolve(destination)}.tmp-${randomUUID()}`;
  try {
    const store = new SnapshotStore(temporary);
    store.writeJson("source.json", source);
    store.writeJson("coverage.json", source.coverage);
    store.writeJson("meta.json", {
      version: 1, platform: "lstep", route: source.route,
      bot: { id: source.account.id, view_name: source.account.label },
      started_at: source.exportedAt, finished_at: source.exportedAt,
      sources: { api: source.route === "api", mcp: false, browser: source.route === "browser" },
      friend_total: source.resources.friends.length,
      notes: Object.entries(source.coverage).filter(([, entry]) => entry.status !== "complete")
        .map(([name, entry]) => `${name}: ${entry.status} ${entry.note ?? ""}`),
    });
    const resources = source.resources;
    const collections = {
      "tags.json": resources.tags, "fields.json": resources.fields,
      "handling_statuses.json": resources.handlingStatuses,
      "templates.json": resources.templates, "scenarios.json": resources.scenarios,
      "scenario_details.json": resources.scenarios, "forms.json": resources.forms,
      "auto_replies.json": resources.autoReplies, "welcome_messages.json": resources.welcomeMessages,
      "rich_menus.json": resources.richMenus, "traffic_sources.json": resources.trafficSources,
    };
    for (const [file, data] of Object.entries(collections)) store.writeJson(file, data);
    if (source.coverage.templateContents?.status !== "unsupported") {
      store.writeJson("template_details.json", resources.templates);
    }
    store.writeJson("friends/index.json", resources.friends.map(friend => friend.row));
    for (const friend of resources.friends) store.writeFriend(friend);
    for (const [formId, responses] of Object.entries(resources.formResponses)) {
      if (!/^[1-9]\d*$/.test(formId)) throw new Error("フォームの管理番号が不正です");
      store.writeJson(`form_responses/${formId}.json`, responses);
    }
    renameSync(temporary, destination);
    return new SnapshotStore(destination);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

/** 移行先に元からいた友だちの行は、上書きしない列（表示名・追加日など）を照合しない */
function markExistingFriendRows(rows: Row[], existingIds: Set<string>): void {
  for (const row of rows) {
    const friendId = String(row.table === "friends" ? row.values.id : row.values.friend_id ?? "");
    if (!existingIds.has(friendId)) continue;
    const keys = row.conflict ?? ["id"];
    // 追加日は古い方を残すので照合しない。メタデータは L Harness 側で直した項目を残すので、このツールの領域（_lstep）だけを照合する
    if (row.table === "friends") {
      row.verify = [...new Set(["id", ...keys, ...(row.update ?? [])])].filter(column => column !== "first_followed_at");
      const ours = (JSON.parse(String(row.values.metadata)) as { _lstep?: unknown })._lstep;
      row.verifyExpected = { ...row.verifyExpected, metadata: JSON.stringify({ _lstep: ours }) };
    }
    // 元からあったチャット（状態・メモ・最終日時を残す）・タグ付けは、あることだけ照合する
    else if (row.table === "chats") row.verify = [...keys];
    else if (row.table === "friend_tags") row.verify = [...keys];
  }
}

export function createPlan(snapshotDir: string, outDir: string, lineAccountId: string, target?: PlanTarget): PlanManifest {
  if (!lineAccountId.trim()) throw new Error("移行先のLINEアカウントIDを指定してください");
  const sourcePath = join(snapshotDir, "source.json");
  const source = readJsonFile<SourceExport>(sourcePath);
  if (!source) throw new Error("Lステップの取得結果がありません");
  assertSource(source);
  if (existsSync(outDir)) throw new Error("計画の保存先が既にあります。新しいフォルダを指定してください");
  const existingFriendIds = new Map<number, string>();
  for (const friend of source.resources.friends) {
    const existing = target?.existingFriends.get(friend.row.line_friend_id);
    if (!existing) continue;
    if (existing.line_account_id !== lineAccountId) {
      throw new Error("移行する友だちが、L Harness の別のアカウントに登録されています。移行先のアカウントIDを確認してください（個人データは表示しません）");
    }
    existingFriendIds.set(friend.row.lmessage_friend_id, existing.id);
  }
  const store = new SnapshotStore(snapshotDir);
  const { ctx, rowsByTable } = buildPlan(store, {
    lineAccountId, options: { ...DEFAULT_OPTIONS }, now: toHarnessJst(Date.parse(source.exportedAt)),
    existingTags: target?.existingTags, existingFriendIds, existingMessages: target?.existingMessages,
    existingFriendScenarios: target?.existingFriendScenarios,
  });
  markExistingFriendRows(ctx.rows, new Set(existingFriendIds.values()));
  let pausedForActive = 0;
  let keptActiveScenarios = 0;
  const dropped = new Set<Row>();
  for (const row of ctx.rows) {
    // 停止・有効の状態は、移行し直しても変えない（L Harness で有効にしたシナリオ・フォームを止めない）
    if ("is_active" in row.values) {
      const keys = row.conflict ?? ["id"];
      row.update = (row.update ?? Object.keys(row.values).filter(column => !keys.includes(column))).filter(column => column !== "is_active");
      if (target) row.verify = (row.verify ?? Object.keys(row.values)).filter(column => column !== "is_active");
    }
    // L Harness で有効にしたシナリオには、新しく入る人を「一時停止」で入れ（自動では送らない）、
    // シナリオの設定・ステップは足すことも書き換えることもしない（動いている配信を変えないため）
    if (row.table === "scenarios" && target?.activeScenarioIds?.has(String(row.values.id))) {
      row.update = [];
      row.verify = ["id"];
      keptActiveScenarios += 1;
    }
    if (target?.activeScenarioIds?.has(String(row.values.scenario_id))) {
      if (row.table === "friend_scenarios" && row.values.status === "active") {
        row.values = { ...row.values, status: "paused", next_delivery_at: null };
        pausedForActive += 1;
      }
      if (row.table === "scenario_steps") dropped.add(row);
    }
    // 本番では、衝突時に書き換えない列（既存の行の値が残る列）は照合しない（友だちの行は別に扱う。何も書き換えない行＝同じ中身の行は全列照合する）
    if (target && row.update?.length && row.table !== "friends" && !row.sql) {
      const keep = new Set([...(row.conflict ?? ["id"]), ...row.update]);
      row.verify = (row.verify ?? Object.keys(row.values)).filter(column => keep.has(column));
    }
    // 更新日時は既存の行の方が新しければ残すので、本番では照合しない
    if (target && row.merge?.updated_at) row.verify = (row.verify ?? Object.keys(row.values)).filter(column => column !== "updated_at");
    // チャットは L Harness で人が書いたメモ・新しい日時を残すので、本番ではあることだけ照合する
    if (target && row.table === "chats") row.verify = ["friend_id", "line_account_id"];
    // 本番で L Harness 側がシナリオを動かし始めた後は進行状態を上書きしないので、上書きしうる列は照合しない
    if (target && row.updateWhere) row.verify = Object.keys(row.values).filter(column => !(row.update ?? []).includes(column));
  }
  // 有効にしたシナリオは変えないので、Lステップで消したステップが残っていれば知らせる（止めたシナリオは投入時に消える）
  if (target?.existingStepIds && target.activeScenarioIds?.size) {
    const plannedSteps = new Map<string, Set<string>>();
    for (const row of ctx.rows) {
      if (row.table !== "scenario_steps" || row.sql) continue;
      const scenarioId = String(row.values.scenario_id);
      plannedSteps.set(scenarioId, (plannedSteps.get(scenarioId) ?? new Set()).add(String(row.values.id)));
    }
    let staleSteps = 0;
    let staleScenarios = 0;
    for (const scenarioId of target.activeScenarioIds) {
      const planned = plannedSteps.get(scenarioId);
      const existing = target.existingStepIds.get(scenarioId);
      if (!planned || !existing) continue;
      const stale = [...existing].filter(id => !planned.has(id)).length;
      if (stale) {
        staleSteps += stale;
        staleScenarios += 1;
      }
    }
    if (staleSteps) {
      ctx.note("scenarios", "ステップ配信", `L Harness で有効にしているシナリオ ${staleScenarios}件に、Lステップで消したステップ ${staleSteps}件が残っています（有効なシナリオは変えません。L Harness で止めてから移行し直すか、管理画面で消してください）`);
      ctx.report("scenarios", "ステップ配信").level = "partial";
    }
  }
  for (const [resource, coverage] of Object.entries(source.coverage)) {
    if (coverage.status === "complete") continue;
    const report = ctx.report(`source_${resource}`, `取得範囲: ${resource}`);
    report.source = coverage.count;
    report.level = coverage.status === "partial" ? "partial" : "none";
    report.notes.push(coverage.note ?? coverage.status);
    ctx.warnings.push(`${resource}: ${coverage.status}`);
  }
  if (dropped.size) {
    for (let index = ctx.rows.length - 1; index >= 0; index--) if (dropped.has(ctx.rows[index])) ctx.rows.splice(index, 1);
    for (const [table, list] of rowsByTable) rowsByTable.set(table, list.filter(row => !dropped.has(row)));
  }
  if (keptActiveScenarios) {
    ctx.note("scenarios", "ステップ配信", `L Harness で有効にしているシナリオ ${keptActiveScenarios}件は、設定・ステップを変えていません（Lステップ側で変えた分は、L Harness で止めてから移行し直すか、管理画面で直してください）`);
  }
  if (pausedForActive) {
    ctx.note("friend_scenarios", "ステップ配信の進行状態", `L Harness で有効にしているシナリオに新しく入る ${pausedForActive}人は、自動で送られないよう「一時停止」で入れました。有効にしたシナリオのステップの中身は書き換えていません`);
  }
  // 前回このツールで移した人（同じ ID）を除いた、L Harness に元からいた人
  const foreign = [...existingFriendIds].filter(([sourceId, id]) => id !== harnessId("friend", lineAccountId, sourceId)).length;
  if (foreign) {
    ctx.note("friends", "友だち", `L Harness に元からいる ${foreign}人は、表示名・アイコン・L Harness 側の情報を変えず、Lステップの情報・タグ・会話を足します（追加日は Lステップの方が古ければそちらにします）`);
  }
  if (existingFriendIds.size > foreign) {
    ctx.note("friends", "友だち", `前回移した ${existingFriendIds.size - foreign}人は、Lステップの情報・タグ・会話を今回の取得結果に合わせて足します（L Harness 側で変わった表示名・アイコンはそのまま）`);
  }
  const formIds = new Set(source.resources.forms.map(form => String(form.id)));
  const orphanResponses = Object.entries(source.resources.formResponses)
    .filter(([formId]) => !formIds.has(formId)).reduce((total, [, responses]) => total + responses.length, 0);
  if (orphanResponses) {
    const report = ctx.report("retained_responses", "設問未取得のフォーム回答");
    report.source = orphanResponses;
    report.level = "manual";
    report.notes.push("回答はスナップショットに保存済み。フォームの設問がないため移行先へは投入していません。");
  }
  const manifest = writePlan(outDir, ctx, rowsByTable, store);
  const expected: ExpectedPlan = {
    version: 1, lineAccountId, sourceAccountId: source.account.id,
    sourceDigest: hash(readFileSync(sourcePath, "utf8")),
    exportedAt: source.exportedAt,
    ...(target ? { target: { kind: "harness" as const, key: target.key, activeScenarioIds: [...(target.activeScenarioIds ?? [])] } } : {}),
    partial: Object.values(source.coverage).some(coverage => coverage.status !== "complete")
      || Object.values(manifest.reports).some(report => report.level !== "full" || report.skipped > 0),
    rows: ctx.rows,
    chunks: manifest.chunks.map(chunk => ({ file: chunk.file, sha256: hash(readFileSync(join(outDir, chunk.file), "utf8")) })),
  };
  writePrivateFile(join(outDir, "expected.json"), JSON.stringify(expected, null, 2));
  return manifest;
}

export function expectedPlan(outDir: string): ExpectedPlan {
  const expected = readJsonFile<ExpectedPlan>(join(outDir, "expected.json"));
  if (!expected || expected.version !== 1 || !Array.isArray(expected.rows) || !Array.isArray(expected.chunks)) {
    throw new Error("移行計画がありません。先にplanを実行してください");
  }
  for (const chunk of expected.chunks) {
    const path = resolve(outDir, chunk.file);
    if (isAbsolute(chunk.file) || relative(resolve(outDir), path).startsWith("..")
      || hash(readFileSync(path, "utf8")) !== chunk.sha256) {
      throw new Error("移行SQLが計画作成後に変更されています。計画を作り直してください");
    }
  }
  return expected;
}

export function sqlIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error("計画の列名または表名が不正です");
  return `"${value}"`;
}

export function sqlValue(value: SqlValue): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return (typeof value === "string" ? value : JSON.stringify(value)).replace(/\u0000/g, "");
}

/** 同じ行（衝突キーが同じ）への重ね書きをまとめ、最後に入る値にする。INSERT でない文（削除など）は行として数えない */
export function mergeExpectedRows(rows: Row[]): Row[] {
  const merged = new Map<string, Row>();
  for (const row of rows) {
    if (row.sql) continue;
    const keys = row.conflict ?? ["id"];
    const key = JSON.stringify([row.table, ...keys.map(column => row.values[column])]);
    const previous = merged.get(key);
    if (!previous) merged.set(key, { ...row, values: { ...row.values } });
    else for (const column of row.update ?? Object.keys(row.values)) previous.values[column] = row.values[column];
  }
  return [...merged.values()];
}

/** 照合する列 */
export function verifyColumns(row: Row): string[] {
  return row.verify ?? Object.keys(row.values);
}

/** expected の中身がすべて actual に入っているか（オブジェクトは中まで。null は「無い」と同じ扱い。json_patch は null の項目を消すため） */
function containsJson(expected: unknown, actual: unknown): boolean {
  if (expected === null) return actual === null || actual === undefined;
  if (typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) => containsJson(value, (actual as Record<string, unknown>)[key]));
  }
  return JSON.stringify(expected) === JSON.stringify(actual);
}

/** 1つの列が予定どおりか */
export function sameColumn(row: Row, column: string, actual: unknown): boolean {
  const expected = sqlValue(row.verifyExpected && column in row.verifyExpected ? row.verifyExpected[column] : row.values[column]);
  if (!row.verifyJson?.includes(column)) return actual === expected;
  if (typeof expected !== "string" || typeof actual !== "string") return actual === expected;
  try { return containsJson(JSON.parse(expected), JSON.parse(actual)); }
  catch { return false; }
}

function verifyDatabase(expected: ExpectedPlan, database: LocalD1): VerificationResult {
  const merged = mergeExpectedRows(expected.rows);
  for (const row of merged) {
    const keys = row.conflict ?? ["id"];
    const columns = verifyColumns(row);
    const actual = database.all(`SELECT ${columns.map(sqlIdentifier).join(",")} FROM ${sqlIdentifier(row.table)} WHERE ${keys.map(column => `${sqlIdentifier(column)} IS ?`).join(" AND ")}`,
      ...keys.map(column => sqlValue(row.values[column])));
    if (actual.length !== 1 || columns.some(column => !sameColumn(row, column, actual[0][column]))) {
      throw new Error(`内容の照合に失敗しました: ${row.table}（個人データは表示しません）`);
    }
  }
  for (const row of expected.rows) {
    if (row.check && Number(database.all<{ c: number }>(row.check.sql)[0]?.c) !== row.check.count) {
      throw new Error(`内容の照合に失敗しました: ${row.table}（消すはずの行が残っています）`);
    }
  }
  if (database.all("PRAGMA foreign_key_check").length) throw new Error("移行先の関連付けに不整合があります");
  return { checked: merged.length, tables: new Set(expected.rows.map(row => row.table)).size, partial: expected.partial };
}

export function applyLocal(outDir: string, dbPath: string, allowPartial = false): VerificationResult {
  const expected = expectedPlan(outDir);
  if (expected.target) throw new Error("この計画は本番の L Harness 向けです。手元の試験用DBには使えません（--db ではなく --harness で投入してください）");
  if (expected.partial && !allowPartial) throw new Error("一部未取得・未対応があります。report.mdを確認し、--allow-partialで明示してください");
  // 試験用DBは init-db で作る。ここでスキーマを流し込むと、断った移行でも DB に変更が残るため受け付けない
  if (!existsSync(dbPath)) throw new Error("移行先DBがありません。init-db で試験用DBを作ってください");
  mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const database = new LocalD1(dbPath);
  try {
    chmodSync(dbPath, 0o600);
    database.exec("PRAGMA foreign_keys=ON");
    const account = database.all<{ is_active: number }>("SELECT is_active FROM line_accounts WHERE id=?", expected.lineAccountId);
    if (account.length !== 1) throw new Error("移行先DBに指定のLINEアカウントがありません。実際のIDを確認してください");
    if (account[0].is_active !== 0) {
      throw new Error("移行先アカウントが停止中ではありません（is_active=0 ではない）。試験用には init-db で作ったDBか、停止したアカウントを使ってください");
    }
    // 同じDBに取り直した結果を重ねると、消えたタグや並びの変わった会話が残って照合がずれる。
    // 同じ計画の再投入だけ認め、それ以外は新しい試験用DBを使ってもらう
    database.exec(`CREATE TABLE IF NOT EXISTS ${APPLIED_TABLE} (line_account_id TEXT PRIMARY KEY, source_digest TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    const applied = database.all<{ source_digest: string }>(`SELECT source_digest FROM ${APPLIED_TABLE} WHERE line_account_id=?`, expected.lineAccountId);
    const friendCount = database.all<{ c: number }>("SELECT COUNT(*) AS c FROM friends WHERE line_account_id=?", expected.lineAccountId)[0].c;
    if ((applied.length || friendCount > 0) && applied[0]?.source_digest !== expected.sourceDigest) {
      throw new Error("この移行先アカウントには、すでに別の取得結果か友だちが入っています。取り直した結果は init-db で作った新しい試験用DBに移行してください");
    }
    for (const row of expected.rows.filter(row => row.table === "friends")) {
      const existing = database.all("SELECT id,line_account_id FROM friends WHERE line_user_id=?", sqlValue(row.values.line_user_id));
      if (existing.some(friend => friend.id !== row.values.id || friend.line_account_id !== expected.lineAccountId)) {
        throw new Error("移行先に別の管理番号の同一友だちがいます。統合確認が必要です");
      }
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const chunk of expected.chunks) database.exec(readFileSync(join(outDir, chunk.file), "utf8"));
      const result = verifyDatabase(expected, database);
      database.db.prepare(`INSERT INTO ${APPLIED_TABLE} (line_account_id,source_digest,applied_at) VALUES (?,?,?) ON CONFLICT(line_account_id) DO UPDATE SET applied_at=excluded.applied_at`)
        .run(expected.lineAccountId, expected.sourceDigest, new Date().toISOString());
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

export function verifyLocal(outDir: string, dbPath: string): VerificationResult {
  const expected = expectedPlan(outDir);
  if (!existsSync(dbPath)) throw new Error("移行先DBがありません");
  const database = new LocalD1(dbPath);
  try { return verifyDatabase(expected, database); }
  finally { database.close(); }
}
