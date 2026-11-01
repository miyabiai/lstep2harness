/**
 * 行データ → SQLite(D1) の SQL 文字列。
 * - 値は文字列・数値・null・boolean（0/1）・オブジェクト（JSON 文字列化）
 * - 冪等: INSERT ... ON CONFLICT(主キー) DO UPDATE / DO NOTHING を使う
 * - チャンク: wrangler d1 execute --file に渡すサイズに分ける
 */

export type SqlValue = string | number | boolean | null | undefined | Record<string, unknown> | unknown[];

export interface Row {
  table: string;
  values: Record<string, SqlValue>;
  /** 衝突キー（省略時 id） */
  conflict?: string[];
  /** 衝突時に更新する列（省略時: 衝突キー以外の全列。空配列なら DO NOTHING） */
  update?: string[];
  /** 衝突時に更新する条件（既存行を表名で参照できる）。満たさなければ何もしない */
  updateWhere?: string;
  /** 照合する列（省略時: values の全列）。移行先に元からあった行は、上書きしない列を照合しない */
  verify?: string[];
  /** 衝突時の更新を excluded.列 でなく式にする列（例: 既存のメタデータに足す） */
  merge?: Record<string, string>;
  /** JSON として「予定の中身がすべて入っているか」で照合する列（移行先が足した項目は許す） */
  verifyJson?: string[];
  /** 照合に使う値（values と違う列だけ。例: 元からいる友だちのメタデータは、このツールの領域 _lstep だけを照合する） */
  verifyExpected?: Record<string, SqlValue>;
  /** INSERT の代わりに流す文（例: 移行元から消えたステップの削除）。values は表・親の参照用で、行としては照合しない */
  sql?: string;
  /** 流した後の確かめ（読み出し SQL が返す列 c が count であること） */
  check?: { sql: string; count: number };
  /** 同じファイルに入れる組（例: 1シナリオ分の退避→入れ直し→削除）。途中で止まっても半端な状態で残さない */
  group?: string;
}

export function quote(v: SqlValue): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  // SQLite は \u0000 を文字列終端として扱い得るので除く
  return `'${s.replace(/\u0000/g, "").replace(/'/g, "''")}'`;
}

/** 衝突時に、既存の日時より新しいときだけ excluded の日時にする式（移行し直しで既存の行の日時を巻き戻さない） */
export function newerTimestamp(table: string, column = "updated_at"): string {
  return `CASE WHEN ${table}.${column} IS NULL OR substr(excluded.${column},1,23) > substr(${table}.${column},1,23) THEN excluded.${column} ELSE ${table}.${column} END`;
}

export function renderInsert(row: Row): string {
  if (row.sql) return row.sql;
  const cols = Object.keys(row.values);
  const conflict = row.conflict ?? ["id"];
  const updateCols = row.update ?? cols.filter((c) => !conflict.includes(c));
  const vals = cols.map((c) => quote(row.values[c])).join(", ");
  const onConflict =
    updateCols.length === 0
      ? `ON CONFLICT(${conflict.join(", ")}) DO NOTHING`
      : `ON CONFLICT(${conflict.join(", ")}) DO UPDATE SET ${updateCols.map((c) => `${c} = ${row.merge?.[c] ?? `excluded.${c}`}`).join(", ")}${row.updateWhere ? ` WHERE ${row.updateWhere}` : ""}`;
  return `INSERT INTO ${row.table} (${cols.join(", ")}) VALUES (${vals}) ${onConflict};`;
}

export interface SqlChunk {
  name: string;
  statements: string[];
  bytes: number;
}

export interface GroupedStatement { sql: string; group?: string }

/** 文のリストを、文数とバイト数の上限でチャンクに分ける。同じ group の文（続けて並んでいるもの）は同じチャンクに入れる */
export function chunkStatements(statements: Array<string | GroupedStatement>, prefix: string, maxStatements = 400, maxBytes = 900_000): SqlChunk[] {
  const items = statements.map((s) => (typeof s === "string" ? { sql: s } : s));
  const chunks: SqlChunk[] = [];
  let cur: string[] = [];
  let bytes = 0;
  const flush = () => {
    if (cur.length) {
      chunks.push({ name: `${prefix}_${String(chunks.length + 1).padStart(3, "0")}.sql`, statements: cur, bytes });
      cur = [];
      bytes = 0;
    }
  };
  for (let i = 0; i < items.length;) {
    // 同じ group が続く範囲を1つのまとまりとして扱う（group が無ければ1文）
    let j = i + 1;
    if (items[i].group !== undefined) while (j < items.length && items[j].group === items[i].group) j += 1;
    const run = items.slice(i, j);
    const runBytes = run.reduce((total, s) => total + Buffer.byteLength(s.sql, "utf8") + 1, 0);
    if (cur.length && (cur.length + run.length > maxStatements || bytes + runBytes > maxBytes)) flush();
    for (const s of run) {
      cur.push(s.sql);
      bytes += Buffer.byteLength(s.sql, "utf8") + 1;
    }
    i = j;
  }
  flush();
  return chunks;
}
