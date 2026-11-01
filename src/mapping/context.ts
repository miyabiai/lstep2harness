import type { Row } from "../sql/render.js";
import type { MigrationOptions } from "../config.js";
import { harnessId, type IdKind } from "../harness/ids.js";
import { nowJst } from "../harness/time.js";

/** L Harness が自分で記録した会話（並行運用中にブリッジ経由で届いたものなど） */
export interface ExistingMessage {
  direction: string;
  content: string;
  /** epoch ms */
  at: number;
}

/** 移行対象ごとの集計。レポートに出す。 */
export interface EntityReport {
  label: string;
  /** 取り出し元の件数 */
  source: number;
  /** L Harness に入れる行数（複数テーブルに分かれる場合は主たる表） */
  migrated: number;
  /** 取り込めなかった件数 */
  skipped: number;
  /** 判定: full / partial / none / manual */
  level: "full" | "partial" | "none" | "manual";
  notes: string[];
}

/** 移したステップ（L Harness に行を作ったものだけ）。進行状態の復元に使う */
export interface MigratedStep {
  sourceStepId: number;
  orderNumber: number;
  /** このステップの最後の行の step_order（「ここまで送った」ときの current_step_order） */
  lastOrder: number;
  /** 送られる中身（照合用） */
  parts: Array<{ message_type: string; message_content: string }>;
  timing: { delay_minutes: number; offset_days: number | null; offset_minutes: number | null; delivery_time: string | null };
}

export interface ScenarioStepsInfo {
  name: string;
  deliveryMode: "absolute_time" | "relative";
  steps: MigratedStep[];
}

export class PlanContext {
  readonly rows: Row[] = [];
  readonly reports = new Map<string, EntityReport>();
  readonly warnings: string[] = [];
  readonly now: string;
  readonly options: MigrationOptions;
  /** 移行元 tag_id → L Harness tags.id */
  readonly tagIds = new Map<number, string>();
  /** 移行元 scenario_id → L Harness scenarios.id */
  readonly scenarioIds = new Map<number, string>();
  /** 移行元 scenario_id → 移したステップの並び（進行状態の復元に使う） */
  readonly scenarioSteps = new Map<number, ScenarioStepsInfo>();
  /** 移行元 template_id → L Harness templates.id（group は先頭の子） */
  readonly templateIds = new Map<number, string>();
  /** 移行元 lmessage_friend_id → L Harness friends.id */
  readonly friendIds = new Map<number, string>();
  /** 移行元 form_id → L Harness forms.id */
  readonly formIds = new Map<number, string>();
  /** 移行元友だち情報 field_id → タイトル */
  readonly fieldTitles = new Map<number, string>();
  /** 対応ステータス名 → tags.id（オプション有効時） */
  readonly handlingStatusTagIds = new Map<string, string>();
  /** 既存の L Harness タグ（名前 → id） */
  readonly existingTags: Map<string, string>;
  /** L Harness が自分で記録した会話（friends.id → 向き・本文・時刻）。同じ会話を二重に入れないために使う */
  readonly existingMessages = new Map<string, ExistingMessage[]>();
  /** L Harness 自身が作った未完了の進行状態（"friends.id\u0000scenarios.id"）。その組には進行状態を入れない */
  readonly existingFriendScenarios = new Set<string>();

  constructor(
    readonly lineAccountId: string,
    options: MigrationOptions,
    existingTags: Map<string, string> = new Map(),
    now = nowJst(),
  ) {
    if (!lineAccountId.trim()) throw new Error("移行先のLINEアカウントIDが必要です");
    this.options = { ...options };
    this.existingTags = existingTags;
    this.now = now;
  }

  add(row: Row): void {
    this.rows.push(row);
  }

  report(key: string, label: string): EntityReport {
    let r = this.reports.get(key);
    if (!r) {
      r = { label, source: 0, migrated: 0, skipped: 0, level: "full", notes: [] };
      this.reports.set(key, r);
    }
    return r;
  }

  note(key: string, label: string, note: string): void {
    const r = this.report(key, label);
    if (!r.notes.includes(note)) r.notes.push(note);
  }

  friendId(sourceFriendId: number): string {
    let id = this.friendIds.get(sourceFriendId);
    if (!id) {
      id = this.id("friend", sourceFriendId);
      this.friendIds.set(sourceFriendId, id);
    }
    return id;
  }

  id(kind: IdKind, ...parts: Array<string | number>): string {
    return harnessId(kind, this.lineAccountId, ...parts);
  }
}
