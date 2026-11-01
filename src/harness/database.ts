import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * 本番の L Harness のデータベース（D1）への入口。実物は wrangler 経由（d1/wrangler.ts）、
 * 試験では同じ形の SQLite で置き換えられるよう、使う操作だけに絞る。
 */
export interface HarnessDatabase {
  /** 表示用の名前（例: D1「line-harness」(remote)） */
  readonly label: string;
  /** 1回に送る読み出し SQL の長さの目安 */
  readonly maxCommandBytes: number;
  /** 文をまとめて流し、文ごとの結果の行を返す（読み出し用） */
  queryMany(statements: string[]): Promise<Array<Array<Record<string, unknown>>>>;
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  /** SQL ファイルを1つ流す */
  executeFile(file: string): Promise<void>;
  /** 投入前の状態に戻すための D1 Time Travel のしおり（取れなければ null） */
  bookmark(): Promise<string | null>;
}

/** 試験用: 手元の SQLite を D1 と同じ入口で使う */
export class SqliteHarnessDatabase implements HarnessDatabase {
  readonly db: DatabaseSync;
  readonly maxCommandBytes: number;
  /** 流したファイル（試験で中断や再開を確かめる用） */
  readonly executed: string[] = [];
  /** 指定した回数目の executeFile で失敗させる（試験用） */
  failAt?: number;
  private calls = 0;

  constructor(path: string, readonly label = "試験用 SQLite", maxCommandBytes = 4_000) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys=ON");
    this.maxCommandBytes = maxCommandBytes;
  }

  async queryMany(statements: string[]): Promise<Array<Array<Record<string, unknown>>>> {
    return statements.map((sql) => this.db.prepare(sql).all() as Array<Record<string, unknown>>);
  }

  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    return (await this.queryMany([sql]))[0] as T[];
  }

  async executeFile(file: string): Promise<void> {
    this.calls += 1;
    if (this.calls === this.failAt) throw new Error("試験用の失敗");
    // D1 の --file と同じく、1ファイルは1つのまとまりで流れる
    this.db.exec("BEGIN");
    try {
      this.db.exec(readFileSync(file, "utf8"));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.executed.push(file);
  }

  async bookmark(): Promise<string | null> {
    return null;
  }

  close(): void {
    this.db.close();
  }
}
