import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LstepApiError, LstepApiSource } from "../lstep/api.js";
import type { SourceExport } from "../lstep/export.js";
import type { PlanManifest } from "../mapping/plan.js";
import { createPlan, writeSourceSnapshot, type PlanTarget } from "../pipeline.js";
import type { HarnessDatabase } from "../harness/database.js";
import { HarnessCheckError, inspectHarness, readPlanTarget, type HarnessAccount } from "../harness/remote.js";
import { createLoginBrowserSession, type LoginBrowserSession } from "./browser.js";
import { tutorialMessage } from "../guide.js";

/**
 * Lステップから取り出して、移行計画（SQL・照合の基準・レポート）まで作る。投入はしない。
 * 人がするのは、管理画面から取得する場合の Chrome でのログインだけ。結果は AI がチャットで伝える。
 */

export type CollectRoute = "auto" | "api" | "browser";

export interface CollectOptions {
  route: CollectRoute;
  dataRoot: string;
  /** 移行先: 手元の試験用DB（dbPath）か、本番の L Harness（harness） */
  target: LocalTarget | HarnessTarget;
  /** 取得元の記録用ラベル（接続先の照合には使わない） */
  sourceAccountId?: string;
  apiToken?: string;
  loginTimeoutMs?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface LocalTarget { dbPath: string; lineAccountId: string }
export interface HarnessTarget { harness: HarnessDatabase; key: string; lineAccountId: string }

export interface CollectDependencies {
  createApiSource?: (token: string, accountId: string, signal?: AbortSignal) => { doctor(): Promise<void>; extract(): Promise<SourceExport> };
  createBrowser?: (signal?: AbortSignal) => Promise<LoginBrowserSession>;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface CollectSummary {
  route: "api" | "browser";
  runDirectory: string;
  planDirectory: string;
  report: string;
  partial: boolean;
  counts: Record<string, number>;
  tables: Record<string, number>;
  /** 取得できなかった・一部だけのもの */
  coverage: Array<{ resource: string; status: string; count: number; note?: string }>;
  /** 移せない・一部だけ移すもの */
  issues: Array<{ label: string; source: number; migrated: number; skipped: number; level: string; notes: string[] }>;
  /** 本番の L Harness へ移すときの移行先の今の状態 */
  target?: {
    database: string;
    account: { id: string; name: string; isActive: boolean };
    /** 移行先アカウントに今いる友だちの人数 */
    friendsBefore: number;
    /** 移す友だちのうち、移行先に元からいる人数（上書きせず足す） */
    alreadyThere: number;
    /** 同じ名前で使い回すタグの数 */
    reusedTags: number;
  };
}

export class CollectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectError";
  }
}

/** 移行先が「init-db で作ったような、停止中で空の試験用アカウント」か、取得の前に確かめる（ログインしてから断らないため）。 */
export function validateTarget(target: LocalTarget): void {
  if (!isAbsolute(target.dbPath) || !existsSync(target.dbPath) || !lstatSync(target.dbPath).isFile()) {
    throw new CollectError("移行先の試験用DBがありません。init-db で作ってください。");
  }
  const database = new DatabaseSync(target.dbPath, { readOnly: true });
  try {
    const account = database.prepare("SELECT is_active FROM line_accounts WHERE id=?").all(target.lineAccountId) as Array<{ is_active: number }>;
    if (account.length !== 1) throw new CollectError("移行先の試験用DBに、指定の移行先アカウントIDがありません。");
    if (account[0].is_active !== 0) throw new CollectError("移行先アカウントが停止中ではありません。init-db で作った試験用DBを使ってください。");
    const friends = database.prepare("SELECT COUNT(*) AS c FROM friends WHERE line_account_id=?").get(target.lineAccountId) as { c: number };
    if (friends.c > 0) throw new CollectError("移行先アカウントには、すでに友だちが入っています。init-db で新しい試験用DBを作ってください。");
  } finally {
    database.close();
  }
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return reject(new CollectError("中止しました。"));
    const onAbort = () => { clearTimeout(timer); reject(new CollectError("中止しました。")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolvePromise(); }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function collectWithApi(options: CollectOptions, dependencies: CollectDependencies, accountId: string): Promise<SourceExport> {
  const factory = dependencies.createApiSource ?? ((token, id, signal) => new LstepApiSource({ token, accountId: id, signal }));
  const api = factory(options.apiToken ?? "", accountId, options.signal);
  try {
    await api.doctor();
  } catch (error) {
    if (error instanceof LstepApiError && [401, 403].includes(error.status ?? 0)) {
      throw new CollectError("LステップAPIの認証または閲覧権限を確認してください（トークンが使えませんでした）。管理画面から取る場合は --route browser で実行してください。");
    }
    throw new CollectError("LステップAPIに接続できませんでした。設定を確認するか、管理画面から取る場合は --route browser で実行してください。");
  }
  options.log?.("LステップAPIで取得しています（ブラウザは開きません）。");
  return api.extract();
}

async function collectWithBrowser(options: CollectOptions, dependencies: CollectDependencies, accountId: string): Promise<SourceExport> {
  const sleep = dependencies.sleep ?? abortableSleep;
  const browser = await (dependencies.createBrowser ?? (signal => createLoginBrowserSession({ signal })))(options.signal);
  try {
    options.log?.("取得専用の Chrome を開きました。その Chrome で Lステップにログインしてください（普段の Chrome とは別です）。ログインを確認したら自動で取得を始めます。");
    options.log?.(tutorialMessage("lstep-login"));
    const deadline = Date.now() + (options.loginTimeoutMs ?? 15 * 60_000);
    for (;;) {
      const status = await browser.status();
      if (status.state === "ready") break;
      if (status.state === "closed") throw new CollectError("取得専用の Chrome が閉じられました。もう一度実行してください。");
      if (Date.now() >= deadline) throw new CollectError("ログインを待つ時間を過ぎました。もう一度実行してください。");
      await sleep(2000, options.signal);
    }
    options.log?.("ログインを確認しました。取得しています（友だちの人数によって数分〜数十分かかります）。");
    return await browser.extract({ accountId });
  } finally {
    await browser.close();
  }
}

function createRunDirectory(dataRoot: string): string {
  const root = resolve(dataRoot);
  const runs = join(root, "runs");
  if (existsSync(runs) && (lstatSync(runs).isSymbolicLink() || !lstatSync(runs).isDirectory())) {
    throw new CollectError("自動保存先を安全に使えません。LSTEP2HARNESS_DATA_DIR を確認してください。");
  }
  mkdirSync(runs, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(runs, "run-"));
  chmodSync(directory, 0o700);
  return directory;
}

function summarize(source: SourceExport, manifest: PlanManifest, route: "api" | "browser", runDirectory: string, planDirectory: string): CollectSummary {
  const resources = source.resources;
  return {
    route, runDirectory, planDirectory, report: join(planDirectory, "report.md"),
    partial: Object.values(source.coverage).some(entry => entry.status !== "complete")
      || Object.values(manifest.reports).some(report => report.level !== "full" || report.skipped > 0),
    counts: {
      friends: resources.friends.length, tags: resources.tags.length, fields: resources.fields.length,
      templates: resources.templates.length, scenarios: resources.scenarios.length, forms: resources.forms.length,
      formResponses: Object.values(resources.formResponses).reduce((total, values) => total + values.length, 0),
      messages: resources.friends.reduce((total, friend) => total + (friend.conversation?.messages.length ?? 0), 0),
    },
    tables: { ...manifest.counts },
    coverage: Object.entries(source.coverage).filter(([, entry]) => entry.status !== "complete")
      .map(([resource, entry]) => ({ resource, status: entry.status, count: entry.count, ...(entry.note ? { note: entry.note.slice(0, 300) } : {}) })),
    issues: Object.entries(manifest.reports).filter(([key, report]) => !key.startsWith("source_") && (report.level !== "full" || report.skipped > 0))
      .map(([, report]) => ({
        label: report.label, source: report.source, migrated: report.migrated, skipped: report.skipped, level: report.level,
        notes: [...new Set(report.notes)].slice(0, 5).map(note => note.slice(0, 300)),
      })),
  };
}

/** 本番の L Harness: 取得の前に、移行先アカウントと表があるかを読み出しだけで確かめる */
async function validateHarnessTarget(target: HarnessTarget): Promise<HarnessAccount> {
  try {
    return await inspectHarness(target.harness, target.lineAccountId);
  } catch (error) {
    if (error instanceof HarnessCheckError) throw new CollectError(error.message);
    throw error;
  }
}

export async function collectAndPlan(options: CollectOptions, dependencies: CollectDependencies = {}): Promise<CollectSummary> {
  const target = options.target;
  const account = "harness" in target ? await validateHarnessTarget(target) : (validateTarget(target), null);
  const accountId = options.sourceAccountId?.trim() || "lstep";
  const hasToken = Boolean(options.apiToken?.trim());
  if (options.route === "api" && !hasToken) throw new CollectError("LSTEP_API_TOKEN が設定されていません。管理画面から取る場合は --route browser で実行してください。");
  if (options.route === "auto" && !hasToken) {
    throw new CollectError("LSTEP_API_TOKEN が無いので公式 API では取得できません。管理画面から取得する場合は、提供元が公開していない画面内部の読み取り口を使うこと（Lステップの利用規約を確認のうえ自己責任で使うこと）を利用者に伝え、了解を得てから --route browser を付けて実行してください。");
  }
  const route: "api" | "browser" = options.route === "browser" ? "browser" : "api";
  if (route === "browser") {
    options.log?.("管理画面からの取得は、提供元が公開していない画面内部の読み取り口を 1.1 秒以上の間隔で読みます（読み取りだけ）。Lステップの利用規約を確認のうえ、ご自身の責任で使ってください。公式 API（API 連携オプション）がある場合は LSTEP_API_TOKEN を設定すると、そちらを使います。");
  }
  const source = route === "api"
    ? await collectWithApi(options, dependencies, accountId)
    : await collectWithBrowser(options, dependencies, accountId);
  if (options.signal?.aborted) throw new CollectError("中止しました。");
  const runDirectory = createRunDirectory(options.dataRoot);
  const snapshotDirectory = join(runDirectory, "snapshot");
  const planDirectory = join(runDirectory, "plan");
  writeSourceSnapshot(source, snapshotDirectory);
  let planTarget: PlanTarget | undefined;
  if ("harness" in target) {
    options.log?.("L Harness の今のタグと友だちを確かめています（書き込みません）。");
    planTarget = await readPlanTarget(target.harness, target.key, source.resources.friends.map(friend => friend.row.line_friend_id));
  }
  const manifest = createPlan(snapshotDirectory, planDirectory, target.lineAccountId, planTarget);
  const summary = summarize(source, manifest, route, runDirectory, planDirectory);
  if ("harness" in target && account && planTarget) {
    const tagNames = new Set(source.resources.tags.map(tag => tag.name));
    summary.target = {
      database: target.harness.label,
      account: { id: account.id, name: account.name, isActive: account.isActive },
      friendsBefore: account.friends,
      alreadyThere: planTarget.existingFriends.size,
      reusedTags: [...planTarget.existingTags.keys()].filter(name => tagNames.has(name)).length,
    };
  }
  return summary;
}
