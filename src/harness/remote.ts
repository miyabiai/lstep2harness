import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalD1 } from "../d1/local.js";
import { expectedPlan, mergeExpectedRows, sameColumn, sqlIdentifier, sqlValue, verifyColumns, type ExpectedPlan, type PlanTarget, type VerificationResult } from "../pipeline.js";
import { quote, type Row } from "../sql/render.js";
import { readJsonFile, writePrivateFile } from "../util.js";
import type { ExistingMessage } from "../mapping/context.js";
import type { HarnessDatabase } from "./database.js";
import { parseSourceDate } from "./time.js";

/**
 * 本番の L Harness（D1）への投入・照合。
 *
 * 手元の試験用DBと違い、本番は動いている L Harness が同時に書き込み、1つのまとまり（トランザクション）で
 * 全部を取り消すこともできない。そこで次の順に守る。
 *  1. 書き込む前に読み出しだけで確かめる（移行先アカウント・表の形・計画後に増えた友だちやタグ・前回の移行記録）
 *  2. 同梱のスキーマで作った手元の SQLite に全 SQL を試し流しし、通らなければ本番に触れない
 *  3. 投入前の D1 Time Travel のしおりを残す（自動では戻さない。戻すと投入中に L Harness が受けた会話も消えるため）
 *  4. SQL は何度流しても同じ結果になる形なので、途中で止まったら同じ apply で続きから流す
 *  5. 全予定行を照合してから、移行記録（lstep2harness_applied）を「完了」にする
 */

/** どの取得結果を移したかを記録する表（L Harness 本体は使わない） */
export const APPLIED_TABLE = "lstep2harness_applied";

const BUNDLED_SCHEMA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "schema", "line-harness-bootstrap.sql");

/** D1 の1文の上限（100KB）より小さく保つ */
const MAX_STATEMENT_BYTES = 90_000;

export interface HarnessAccount {
  id: string;
  name: string;
  isActive: boolean;
  friends: number;
}

export interface HarnessVerifyOptions {
  /** LINE のプロフィール更新で変わる4列を、照合失敗にせず別枠で報告する */
  allowProfileUpdates?: boolean;
  /** 今のつなぎ先（connect）の移行先アカウント。計画のアカウントと違えば止める（connect をやり直した後に古い計画を流さない） */
  lineAccountId?: string;
}

function assertPlanAccount(expected: ExpectedPlan, lineAccountId: string | undefined): void {
  if (lineAccountId && expected.lineAccountId !== lineAccountId) {
    throw new HarnessCheckError("この計画は、今の connect の移行先アカウントとは別のアカウント向けに作ったものです。connect で移行先を変えた後は、計画を作り直してください。本番には書き込んでいません");
  }
}

export interface HarnessVerificationResult extends VerificationResult {
  database: string;
  /** 明示的にプロフィール更新を許容した場合だけ付く。値・行の識別子は含めない */
  profileUpdates?: {
    skippedFields: number;
    changedFields: number;
    changedColumns: Record<string, number>;
  };
}

export interface HarnessApplyResult extends HarnessVerificationResult {
  /** 投入前に戻すための D1 Time Travel のしおり（取れたときだけ） */
  bookmark: string | null;
  /** 前回の途中から再開して流さずに済んだファイル数 */
  resumedChunks: number;
}

export class HarnessCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessCheckError";
  }
}

function inList(values: unknown[]): string {
  return values.map((value) => quote(sqlValue(value as never))).join(",");
}

/** 値の一覧を、1文が長くなりすぎないよう分けて SELECT を作る */
function chunkedSelects(prefix: string, values: string[], suffix = ""): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  let bytes = prefix.length + suffix.length + 10;
  for (const value of values) {
    const size = Buffer.byteLength(value, "utf8") + 1;
    if (current.length && bytes + size > MAX_STATEMENT_BYTES) {
      statements.push(`${prefix}(${current.join(",")})${suffix}`);
      current = [];
      bytes = prefix.length + suffix.length + 10;
    }
    current.push(value);
    bytes += size;
  }
  if (current.length) statements.push(`${prefix}(${current.join(",")})${suffix}`);
  return statements;
}

/** 文の一覧を、1回で送れる長さごとにまとめて流す */
async function runSelects(database: HarnessDatabase, statements: string[]): Promise<Array<Array<Record<string, unknown>>>> {
  const results: Array<Array<Record<string, unknown>>> = [];
  let batch: string[] = [];
  let bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    results.push(...await database.queryMany(batch));
    batch = [];
    bytes = 0;
  };
  for (const statement of statements) {
    const size = Buffer.byteLength(statement, "utf8") + 2;
    if (batch.length && bytes + size > database.maxCommandBytes) await flush();
    batch.push(statement);
    bytes += size;
  }
  await flush();
  return results;
}

/** 移行先アカウントがあるか・L Harness の表があるかを、書き込まずに確かめる */
export async function inspectHarness(database: HarnessDatabase, lineAccountId: string): Promise<HarnessAccount> {
  let tables: Array<{ name: string }>;
  try {
    tables = await database.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('line_accounts','friends','tags')");
  } catch (error) {
    throw new HarnessCheckError(`L Harness のデータベースを読めませんでした。wrangler のログイン（同じ Cloudflare アカウント）とデータベース名を確認してください。\n${(error as Error).message}`);
  }
  if (tables.length !== 3) throw new HarnessCheckError("指定のデータベースに L Harness の表（line_accounts・friends・tags）がありません。L Harness の D1 か確認してください");
  const accounts = await database.query<{ id: string; name: string; is_active: number }>(`SELECT id,name,is_active FROM line_accounts WHERE id=${quote(lineAccountId)}`);
  if (accounts.length !== 1) throw new HarnessCheckError("L Harness に指定の移行先アカウントIDがありません。connect の表示でIDを確認してください");
  const [{ c }] = await database.query<{ c: number }>(`SELECT COUNT(*) AS c FROM friends WHERE line_account_id=${quote(lineAccountId)}`);
  return { id: accounts[0].id, name: accounts[0].name, isActive: accounts[0].is_active === 1, friends: Number(c) };
}

/** 計画づくりに要る移行先の今の状態（既存タグ・移行する友だちのうち元からいる人） */
export async function readPlanTarget(database: HarnessDatabase, key: string, lineUserIds: string[]): Promise<PlanTarget> {
  const tags = await database.query<{ id: string; name: string }>("SELECT id,name FROM tags");
  const existingFriends = new Map<string, { id: string; line_account_id: string | null }>();
  const selects = chunkedSelects("SELECT id,line_user_id,line_account_id FROM friends WHERE line_user_id IN ", lineUserIds.map((uid) => quote(uid)));
  for (const rows of await runSelects(database, selects)) {
    for (const row of rows) existingFriends.set(String(row.line_user_id), { id: String(row.id), line_account_id: row.line_account_id === null ? null : String(row.line_account_id) });
  }
  // L Harness が自分で記録した会話（並行運用中にブリッジ経由で届いたものなど）。
  // このツールが入れた行の ID は UUID v5（15文字目が 5）なので、それ以外を読む
  const existingMessages = new Map<string, ExistingMessage[]>();
  const friendIds = [...existingFriends.values()].map((friend) => quote(friend.id));
  const messageSelects = chunkedSelects("SELECT friend_id,direction,content,created_at FROM messages_log WHERE substr(id,15,1)<>'5' AND friend_id IN ", friendIds);
  for (const rows of await runSelects(database, messageSelects)) {
    for (const row of rows) {
      const at = parseSourceDate(String(row.created_at ?? ""));
      if (at === null || typeof row.content !== "string") continue;
      const list = existingMessages.get(String(row.friend_id)) ?? [];
      list.push({ direction: String(row.direction), content: row.content, at });
      existingMessages.set(String(row.friend_id), list);
    }
  }
  const active = await database.query<{ id: string }>("SELECT id FROM scenarios WHERE is_active=1");
  // このツールが前に入れたステップ（ID は UUID v5）。有効なシナリオに残る古いステップを知らせるのに使う
  const existingStepIds = new Map<string, Set<string>>();
  for (const row of await database.query<{ id: string; scenario_id: string }>("SELECT id,scenario_id FROM scenario_steps WHERE substr(id,15,1)='5'")) {
    existingStepIds.set(String(row.scenario_id), (existingStepIds.get(String(row.scenario_id)) ?? new Set()).add(String(row.id)));
  }
  // L Harness 自身が作った未完了の進行状態（ID は UUID v4）。同じ友だち・シナリオの組は UNIQUE なので、その組には入れない
  const existingFriendScenarios = new Set<string>();
  for (const rows of await runSelects(database, chunkedSelects("SELECT friend_id,scenario_id FROM friend_scenarios WHERE substr(id,15,1)<>'5' AND status<>'completed' AND friend_id IN ", friendIds))) {
    for (const row of rows) existingFriendScenarios.add(`${row.friend_id}\u0000${row.scenario_id}`);
  }
  return { key, existingTags: new Map(tags.map((tag) => [tag.name, tag.id])), existingFriends, existingMessages, activeScenarioIds: new Set(active.map((row) => row.id)), existingStepIds, existingFriendScenarios };
}

/** 計画が使う列が本番の表にあるか（L Harness の版の違いで列が無いと途中で止まるため、先に止める） */
async function checkColumns(database: HarnessDatabase, rows: Row[]): Promise<void> {
  const wanted = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.sql) continue;
    const columns = wanted.get(row.table) ?? new Set<string>();
    for (const column of Object.keys(row.values)) columns.add(column);
    wanted.set(row.table, columns);
  }
  const tables = [...wanted.keys()];
  const results = await runSelects(database, tables.map((table) => `SELECT name FROM pragma_table_info(${quote(table)})`));
  const missing: string[] = [];
  tables.forEach((table, index) => {
    const actual = new Set((results[index] ?? []).map((row) => String(row.name)));
    if (!actual.size) missing.push(table);
    else for (const column of wanted.get(table)!) if (!actual.has(column)) missing.push(`${table}.${column}`);
  });
  if (missing.length) {
    throw new HarnessCheckError(`L Harness の表の形が、このツールの想定と違います（${missing.slice(0, 8).join("、")}）。L Harness を最新版に更新するか、このツールの更新を待ってください。本番には書き込んでいません`);
  }
}

/** 計画を作った後に、本番で友だち・タグが増えていないか（増えていると ID がずれて投入が止まる） */
async function checkDrift(database: HarnessDatabase, expected: ExpectedPlan, replanHint: string): Promise<void> {
  const friends = expected.rows.filter((row) => row.table === "friends");
  const planned = new Map(friends.map((row) => [String(row.values.line_user_id), String(row.values.id)]));
  const selects = chunkedSelects("SELECT id,line_user_id,line_account_id FROM friends WHERE line_user_id IN ", [...planned.keys()].map((uid) => quote(uid)));
  for (const rows of await runSelects(database, selects)) {
    for (const row of rows) {
      if (row.line_account_id !== expected.lineAccountId) {
        throw new HarnessCheckError("移行する友だちが、L Harness の別のアカウントに登録されています。移行先のアカウントIDを確認してください。本番には書き込んでいません");
      }
      if (planned.get(String(row.line_user_id)) !== row.id) {
        throw new HarnessCheckError(`計画を作った後に、L Harness に友だちが増えています（並行運用中の友だち追加など）。今の状態に合わせて計画を作り直してください。本番には書き込んでいません\n${replanHint}`);
      }
    }
  }
  // 計画の後に、移すシナリオが L Harness で有効にされていたら、新しく入る人に送られうるので作り直す
  const plannedScenarios = expected.rows.filter((row) => row.table === "scenarios").map((row) => String(row.values.id));
  // 止めたシナリオのステップは Lステップに揃える（このツールのステップを退避→入れ直し→削除）ので、
  // L Harness の管理画面で手で足したステップ（このツールの ID = UUID v5 でないもの）があると、並びが重なって途中で止まる。先に止める
  const handMade = await runSelects(database, chunkedSelects("SELECT DISTINCT scenario_id FROM scenario_steps WHERE substr(id,15,1)<>'5' AND scenario_id IN (SELECT id FROM scenarios WHERE is_active=0) AND scenario_id IN ", plannedScenarios.map((id) => quote(id))));
  const handMadeScenarios = handMade.reduce((total, rows) => total + rows.length, 0);
  if (handMadeScenarios) {
    throw new HarnessCheckError(`L Harness の管理画面で足したステップがある停止中のシナリオが ${handMadeScenarios}件あります。このツールは停止中のシナリオのステップを Lステップの今の内容に揃えるため、そのままでは入れられません。足したステップを L Harness で消すか、そのシナリオを L Harness で有効にしてから（有効なシナリオは変えません）、もう一度実行してください。本番には書き込んでいません`);
  }
  const knownActive = new Set(expected.target?.activeScenarioIds ?? []);
  for (const rows of await runSelects(database, chunkedSelects("SELECT id FROM scenarios WHERE is_active=1 AND id IN ", plannedScenarios.map((id) => quote(id))))) {
    if (rows.some((row) => !knownActive.has(String(row.id)))) {
      throw new HarnessCheckError(`計画を作った後に、移すシナリオが L Harness で有効にされています。今の状態に合わせて計画を作り直してください。本番には書き込んでいません\n${replanHint}`);
    }
  }
  // 計画の後に、L Harness 自身が同じ友だち・シナリオの進行状態を作っていたら（UNIQUE で止まるので）作り直す
  const plannedPairs = new Set(expected.rows.filter((row) => row.table === "friend_scenarios" && !row.sql).map((row) => `${row.values.friend_id}\u0000${row.values.scenario_id}`));
  if (plannedPairs.size) {
    const friendIds = [...new Set([...plannedPairs].map((pair) => pair.split("\u0000")[0]))].map((id) => quote(id));
    for (const rows of await runSelects(database, chunkedSelects("SELECT friend_id,scenario_id FROM friend_scenarios WHERE substr(id,15,1)<>'5' AND status<>'completed' AND friend_id IN ", friendIds))) {
      if (rows.some((row) => plannedPairs.has(`${row.friend_id}\u0000${row.scenario_id}`))) {
        throw new HarnessCheckError(`計画を作った後に、L Harness がステップ配信の進行状態を作っています（並行運用中の登録など）。今の状態に合わせて計画を作り直してください。本番には書き込んでいません\n${replanHint}`);
      }
    }
  }
  const tags = expected.rows.filter((row) => row.table === "tags");
  const plannedTags = new Map(tags.map((row) => [String(row.values.name), String(row.values.id)]));
  const plannedTagIds = new Set(tags.map((row) => String(row.values.id)));
  const tagSelects = chunkedSelects("SELECT id,name FROM tags WHERE name IN ", [...plannedTags.keys()].map((name) => quote(name)));
  for (const rows of await runSelects(database, tagSelects)) {
    for (const row of rows) {
      // 計画が名前を変える既存タグ（同じ ID を計画が持つ）は、同じ名前の別タグではない
      if (plannedTags.get(String(row.name)) !== row.id && !plannedTagIds.has(String(row.id))) {
        throw new HarnessCheckError(`計画を作った後に、L Harness に同じ名前のタグができています。今の状態に合わせて計画を作り直してください。本番には書き込んでいません\n${replanHint}`);
      }
    }
  }
}

interface AppliedRecord { source_digest: string; exported_at: string | null; status: string }

async function appliedRecord(database: HarnessDatabase, lineAccountId: string): Promise<AppliedRecord | null> {
  const table = await database.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='${APPLIED_TABLE}'`);
  if (!table.length) return null;
  const rows = await database.query<AppliedRecord>(`SELECT source_digest,exported_at,status FROM ${APPLIED_TABLE} WHERE line_account_id=${quote(lineAccountId)}`);
  return rows[0] ?? null;
}

async function writeAppliedRecord(database: HarnessDatabase, outDir: string, expected: ExpectedPlan, status: "applying" | "applied" | "failed"): Promise<void> {
  const file = join(outDir, `applied-${status}.sql`);
  writePrivateFile(file, [
    `CREATE TABLE IF NOT EXISTS ${APPLIED_TABLE} (line_account_id TEXT PRIMARY KEY, source_digest TEXT NOT NULL, exported_at TEXT, status TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    `INSERT INTO ${APPLIED_TABLE} (line_account_id,source_digest,exported_at,status,updated_at) VALUES (${quote(expected.lineAccountId)},${quote(expected.sourceDigest)},${quote(expected.exportedAt ?? null)},${quote(status)},${quote(new Date().toISOString())}) ON CONFLICT(line_account_id) DO UPDATE SET source_digest=excluded.source_digest,exported_at=excluded.exported_at,status=excluded.status,updated_at=excluded.updated_at;`,
  ].join("\n") + "\n");
  await database.executeFile(file);
}

/** エラー文から SQL の値（顧客データ）を伏せる */
function redact(message: string): string {
  return message.split("\n")[0].replace(/'(?:[^']|'')*'/g, "'…'").replace(/near "[^"]*"/g, 'near "…"').slice(0, 300);
}

/** 同梱のスキーマで作った手元の SQLite に全 SQL を試し流しする（本番に触れる前に構文・制約の誤りを見つける） */
function trialRun(outDir: string, expected: ExpectedPlan, schemaPath = BUNDLED_SCHEMA): void {
  if (!existsSync(schemaPath)) throw new HarnessCheckError("同梱の L Harness スキーマが見つかりません。npm ci をやり直してください");
  const database = new LocalD1();
  try {
    database.loadSchema(schemaPath);
    database.exec("PRAGMA foreign_keys=ON");
    database.db.prepare("INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret,is_active) VALUES (?,?,?,?,?,0)")
      .run(expected.lineAccountId, "trial-run", "trial-run", "trial-run", "trial-run");
    // 計画が参照する既存の行（元からいる友だち・使い回すタグ）を仮に置く
    const plannedTags = new Set(expected.rows.filter((row) => row.table === "tags").map((row) => String(row.values.id)));
    const referencedTags = new Set<string>();
    for (const row of expected.rows) {
      for (const column of ["tag_id", "trigger_tag_id"]) {
        const value = row.values[column];
        if (typeof value === "string" && !plannedTags.has(value)) referencedTags.add(value);
      }
    }
    for (const id of referencedTags) database.db.prepare("INSERT OR IGNORE INTO tags (id,name) VALUES (?,?)").run(id, `existing-${id}`);
    for (const row of expected.rows.filter((row) => row.table === "friends" && row.verify)) {
      database.db.prepare("INSERT INTO friends (id,line_user_id,line_account_id) VALUES (?,?,?)")
        .run(String(row.values.id), String(row.values.line_user_id), expected.lineAccountId);
    }
    database.exec("BEGIN");
    for (const chunk of expected.chunks) {
      try {
        database.exec(readFileSync(join(outDir, chunk.file), "utf8"));
      } catch (error) {
        throw new HarnessCheckError(`投入前の試し流しで失敗しました（${chunk.file}: ${redact((error as Error).message)}）。本番には書き込んでいません`);
      }
    }
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
}

const PROFILE_UPDATE_COLUMNS = new Set(["display_name", "picture_url", "status_message", "updated_at"]);

/** 全予定行を、表・キーごとにまとめて読み出して照合する */
export async function verifyHarness(outDir: string, database: HarnessDatabase, options: HarnessVerifyOptions = {}): Promise<HarnessVerificationResult> {
  const expected = expectedPlan(outDir);
  assertPlanAccount(expected, options.lineAccountId);
  const merged = mergeExpectedRows(expected.rows);
  const profileUpdates = { skippedFields: 0, changedFields: 0, changedColumns: {} as Record<string, number> };
  const groups = new Map<string, Row[]>();
  for (const row of merged) {
    const key = JSON.stringify([row.table, row.conflict ?? ["id"]]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const rows of groups.values()) {
    const { table } = rows[0];
    const keys = rows[0].conflict ?? ["id"];
    const columns = [...new Set([...keys, ...rows.flatMap(verifyColumns)])];
    const select = `SELECT ${columns.map(sqlIdentifier).join(",")} FROM ${sqlIdentifier(table)} WHERE `;
    const keyTuple = (row: Row) => keys.map((column) => quote(sqlValue(row.values[column])));
    const statements = keys.length === 1
      ? chunkedSelects(`${select}${sqlIdentifier(keys[0])} IN `, rows.map((row) => keyTuple(row)[0]))
      : chunkedSelects(`${select}(${keys.map(sqlIdentifier).join(",")}) IN `, rows.map((row) => `(${keyTuple(row).join(",")})`))
        .map((statement) => statement.replace(/ IN \(/, " IN (VALUES "));
    const found = new Map<string, Array<Record<string, unknown>>>();
    for (const result of await runSelects(database, statements)) {
      for (const actual of result) {
        const id = JSON.stringify(keys.map((column) => actual[column]));
        found.set(id, [...(found.get(id) ?? []), actual]);
      }
    }
    for (const row of rows) {
      const actual = found.get(JSON.stringify(keys.map((column) => sqlValue(row.values[column]))));
      if (actual?.length !== 1) {
        throw new Error(`内容の照合に失敗しました: ${table}（予定に一致する行が1行ではありません。照合キー列: ${keys.join("、")}。個人データは表示しません）`);
      }
      const different: string[] = [];
      for (const column of verifyColumns(row)) {
        const matches = sameColumn(row, column, actual[0][column]);
        if (options.allowProfileUpdates && table === "friends" && PROFILE_UPDATE_COLUMNS.has(column)) {
          profileUpdates.skippedFields += 1;
          if (!matches) {
            profileUpdates.changedFields += 1;
            profileUpdates.changedColumns[column] = (profileUpdates.changedColumns[column] ?? 0) + 1;
          }
        } else if (!matches) different.push(column);
      }
      if (different.length) throw new Error(`内容の照合に失敗しました: ${table}（不一致の列: ${different.join("、")}。個人データは表示しません）`);
    }
  }
  // 消す文（移行元から消えたステップなど）は、消えたことを確かめる
  const checks = expected.rows.filter((row) => row.check);
  const counts = await runSelects(database, checks.map((row) => row.check!.sql));
  checks.forEach((row, index) => {
    if (Number(counts[index]?.[0]?.c) !== row.check!.count) throw new Error(`内容の照合に失敗しました: ${row.table}（消すはずの行が残っています）`);
  });
  return {
    checked: merged.length, tables: new Set(expected.rows.map((row) => row.table)).size, partial: expected.partial, database: database.label,
    ...(options.allowProfileUpdates ? { profileUpdates } : {}),
  };
}

interface ApplyState { key: string; done: string[] }

export interface HarnessApplyOptions extends HarnessVerifyOptions {
  /** どのデータベース向けか（計画の target.key と一致すること） */
  key: string;
  allowPartial?: boolean;
  /** 計画の作り直しを案内する文（コマンドなど） */
  replanHint?: string;
  log?: (message: string) => void;
  schemaPath?: string;
  /** 中止の合図（Ctrl+C）。流している最中のファイルが終わったところで止める（続きは同じ apply で） */
  signal?: AbortSignal;
}

export async function applyHarness(outDir: string, database: HarnessDatabase, options: HarnessApplyOptions): Promise<HarnessApplyResult> {
  const log = options.log ?? (() => {});
  const expected = expectedPlan(outDir);
  if (!expected.target) throw new HarnessCheckError("この計画は手元の試験用DB向けです。本番の L Harness には、--harness を付けて作り直した計画で投入してください");
  if (expected.target.key !== options.key) throw new HarnessCheckError("この計画は別のデータベース向けに作ったものです。投入先を確認するか、計画を作り直してください");
  assertPlanAccount(expected, options.lineAccountId);
  if (expected.partial && !options.allowPartial) throw new HarnessCheckError("一部未取得・未対応があります。report.mdを確認し、--allow-partialで明示してください");
  const replanHint = options.replanHint ?? "";

  log(`${database.label} を確認しています（まだ書き込みません）…`);
  await inspectHarness(database, expected.lineAccountId);
  await checkColumns(database, expected.rows);
  await checkDrift(database, expected, replanHint);
  const record = await appliedRecord(database, expected.lineAccountId);
  if (record && record.source_digest !== expected.sourceDigest && record.exported_at && expected.exportedAt && record.exported_at > expected.exportedAt) {
    throw new HarnessCheckError("この移行先には、これより新しい取得結果をすでに入れています。古い取得結果で上書きしないよう止めました。新しく取得し直してください");
  }
  log("同梱のスキーマで試し流ししています…");
  trialRun(outDir, expected, options.schemaPath);

  // 投入前の状態のしおり。やり直しでも最初の1つ（最初の投入の前）を残し、後のものは下に足す
  const bookmarkPath = join(outDir, "bookmark.txt");
  const earlier = existsSync(bookmarkPath) ? readFileSync(bookmarkPath, "utf8").split("\n").filter(Boolean) : [];
  const current = await database.bookmark();
  if (current) writePrivateFile(bookmarkPath, [...earlier, `${current}  # ${new Date().toISOString()} の apply の前`].join("\n") + "\n");
  const bookmark = earlier[0]?.split(/\s/)[0] ?? current;
  const statePath = join(outDir, "apply-state.json");
  const saved = readJsonFile<ApplyState>(statePath);
  const state: ApplyState = saved?.key === options.key ? saved : { key: options.key, done: [] };
  let resumedChunks = 0;
  try {
    await writeAppliedRecord(database, outDir, expected, "applying");
    for (const [index, chunk] of expected.chunks.entries()) {
      const mark = `${chunk.file}:${chunk.sha256}`;
      if (state.done.includes(mark)) {
        resumedChunks += 1;
        continue;
      }
      if (options.signal?.aborted) throw new Error("中止しました。流し終えたファイルは記録してあるので、続きは同じ apply をもう一度実行してください");
      log(`  [${index + 1}/${expected.chunks.length}] ${chunk.file}`);
      await database.executeFile(join(outDir, chunk.file));
      state.done.push(mark);
      writePrivateFile(statePath, JSON.stringify(state, null, 2));
    }
    log("全予定行を照合しています…");
    const result = await verifyHarness(outDir, database, { allowProfileUpdates: options.allowProfileUpdates });
    await writeAppliedRecord(database, outDir, expected, "applied");
    return { ...result, bookmark, resumedChunks };
  } catch (error) {
    await writeAppliedRecord(database, outDir, expected, "failed").catch(() => {});
    const restore = bookmark ? `\n投入前の状態のしおり: ${bookmark}（自動では戻していません。戻すと投入中に L Harness が受けた会話も消えます。まずは同じ apply をもう一度実行すると、続きから流し直します）` : "";
    throw new Error(`${(error as Error).message}${restore}`);
  }
}
