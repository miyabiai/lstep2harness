import { readFile } from "node:fs/promises";
import { importBrowserExport } from "../lstep/browser.js";
import type { ResourceCoverage, SourceExport } from "../lstep/export.js";

const origin = "https://manager.linestep.net";

export interface LoginBrowserPage {
  goto(url: string): Promise<unknown>;
  evaluate<Result>(script: string): Promise<Result>;
}

export interface LoginBrowserDriver {
  page: LoginBrowserPage;
  close(): Promise<void>;
  /** 利用者がウィンドウを閉じたなど、ブラウザとの接続が切れたときに呼ぶ */
  onDisconnected?(listener: () => void): void;
}

export type LoginBrowserFactory = () => Promise<LoginBrowserDriver>;

export interface LoginBrowserOptions {
  signal?: AbortSignal;
  /** 友だち一覧を読むまでの制限時間。詳細の取得には人数に応じた時間を足す */
  timeoutMs?: number;
  /** 友だち1人あたりに足す制限時間 */
  perFriendTimeoutMs?: number;
}

export interface BrowserStatus {
  state: "login-required" | "ready" | "closed";
}

export interface LoginBrowserSession {
  status(): Promise<BrowserStatus>;
  extract(account: { accountId: string; accountLabel?: string }): Promise<SourceExport>;
  close(): Promise<void>;
}

interface FriendListView {
  friendIds: number[];
  nextPages: number[];
  paginationObserved: boolean;
  lastPageObserved?: boolean;
  currentPage?: number;
}

interface FriendTagsView {
  memberId: number;
  observed: boolean;
  definitionIds?: number[];
  tags: { id?: number; name: string }[];
}

const statusScript = `(() => ({ ready: location.origin === ${JSON.stringify(origin)}
  && (location.pathname === '/' || location.pathname.startsWith('/line/')) && !/login|register|password/.test(location.pathname)
  && Boolean(document.querySelector('meta[name="csrf-token"]'))
  && Array.from(document.querySelectorAll('a[href]')).some(link => {
    try { const url = new URL(link.getAttribute('href'), location.origin);
      return url.origin === location.origin && url.pathname === '/line/show'; } catch { return false; }
  }) }))()`;

const friendListScript = `(() => {
  const friendIds = new Set(); const nextPages = new Set();
  for (const link of document.querySelectorAll('a[href]')) {
    let url; try { url = new URL(link.getAttribute('href'), location.origin); } catch { continue; }
    if (url.origin !== location.origin) continue;
    const match = url.pathname.match(/^\\/line\\/detail\\/([1-9]\\d*)$/);
    if (match && Number.isSafeInteger(Number(match[1]))) friendIds.add(Number(match[1]));
    const page = url.searchParams.get('page');
    if (url.pathname === '/line/show' && /^[1-9]\\d*$/.test(page || '') && Number.isSafeInteger(Number(page))) nextPages.add(Number(page));
  }
  const navigations = document.querySelectorAll('nav[aria-label="Pagination"]');
  let paginationObserved = false; let lastPageObserved = false; let currentPage;
  if (navigations.length === 1) {
    const candidates = [...navigations[0].querySelectorAll('button[aria-label]')]
      .map(button => ({ button, match: (button.getAttribute('aria-label') || '').match(/^次のページ\\(現在: ([1-9]\\d*)\\)$/) }))
      .filter(item => item.match && Number.isSafeInteger(Number(item.match[1])));
    if (candidates.length === 1) {
      const item = candidates[0]; currentPage = Number(item.match[1]);
      paginationObserved = true; lastPageObserved = item.button.disabled === true;
      if (!lastPageObserved) nextPages.add(currentPage + 1);
    }
  }
  return { friendIds: [...friendIds], nextPages: [...nextPages], paginationObserved, lastPageObserved, currentPage };
})()`;

const friendTagsScript = `(() => {
  const match = location.pathname.match(/^\\/line\\/detail\\/([1-9]\\d*)$/);
  const result = { memberId: match ? Number(match[1]) : 0, observed: false, definitionIds: [], tags: [] };
  const form = document.querySelector('#tag_edit #tag_edit_form');
  if (!form) return result;
  const inputs = [...form.querySelectorAll('input[type="checkbox"][name="tags[]"]')];
  for (const input of inputs) {
    const value = input.value;
    if (!/^[1-9]\\d*$/.test(value) || !Number.isSafeInteger(Number(value))) return result;
    const label = input.closest('label');
    if (!label) return result;
    result.definitionIds.push(Number(value));
    if (input.checked) result.tags.push({ id: Number(value), name: (label.textContent || '').trim() });
  }
  result.observed = true;
  return result;
})()`;

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? Math.min(value!, maximum) : fallback;
}

function stoppedError(): Error {
  return new Error("画面からの取得を中止しました");
}

function isNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Execution context was destroyed|because of a navigation|Cannot find context with specified id|frame was detached/i.test(message);
}

function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export async function launchLoginBrowser(): Promise<LoginBrowserDriver> {
  const moduleName = "playwright-core";
  let playwright;
  try { playwright = await import(moduleName); }
  catch { throw new Error("画面から取得するためのブラウザが未準備です。セットアップを実行してください"); }
  let browser;
  try { browser = await playwright.chromium.launch({ channel: "chrome", headless: false }); }
  catch { throw new Error("取得用ブラウザを起動できませんでした。ブラウザのセットアップを確認してください"); }
  try {
    const context = await browser.newContext({ acceptDownloads: false, permissions: [], serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(30_000);
    return { page, close: () => browser.close(), onDisconnected: listener => { browser.on("disconnected", listener); } };
  } catch {
    await browser.close();
    throw new Error("取得用ブラウザを準備できませんでした");
  }
}

export async function createLoginBrowserSession(
  options: LoginBrowserOptions = {},
  factory: LoginBrowserFactory = launchLoginBrowser,
): Promise<LoginBrowserSession> {
  const driver = await factory();
  let closed = false;
  let closing: Promise<void> | undefined;
  let extracting = false;
  let lastNavigation = 0;
  const timeoutMs = bounded(options.timeoutMs, 15 * 60_000, 60 * 60_000);
  const maxPages = 100;
  const maxFriends = 1000;
  const intervalMs = 1100;
  // 詳細画面への移動と、export.js が1人ごとに読む数画面ぶん（各1.1秒以上の間隔）に余裕を持たせる
  const perFriendTimeoutMs = bounded(options.perFriendTimeoutMs, intervalMs * 6 + 3_000, 60_000);
  const close = async (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    options.signal?.removeEventListener("abort", onAbort);
    // 閉じる処理の失敗は覚えない（次の close() まで失敗させない）
    closing = driver.close().catch(() => undefined);
    return closing;
  };
  driver.onDisconnected?.(() => { closed = true; });
  const onAbort = (): void => { void close().catch(() => undefined); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const ensureOpen = (): void => {
    if (closed || options.signal?.aborted) throw stoppedError();
  };
  const execute = async <Result>(operation: () => Promise<Result>, limit = timeoutMs, signal?: AbortSignal): Promise<Result> => {
    ensureOpen();
    if (signal?.aborted) throw stoppedError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void close().catch(() => undefined);
        reject(new Error("画面からの取得が制限時間を超えました。もう一度開始してください"));
      }, limit);
      stop = () => {
        void close().catch(() => undefined);
        reject(stoppedError());
      };
      options.signal?.addEventListener("abort", stop, { once: true });
      signal?.addEventListener("abort", stop, { once: true });
    });
    try { return await Promise.race([operation(), cancelled]); }
    finally {
      clearTimeout(timer);
      if (stop) {
        options.signal?.removeEventListener("abort", stop);
        signal?.removeEventListener("abort", stop);
      }
    }
  };
  const navigate = async (path: string): Promise<void> => {
    if (!/^\/line\/(?:show(?:\?page=[1-9]\d*)?|detail\/[1-9]\d*)$/.test(path)) throw new Error("取得先の画面を確認できません");
    ensureOpen();
    await new Promise(resolve => setTimeout(resolve, Math.max(0, intervalMs - (Date.now() - lastNavigation))));
    ensureOpen();
    lastNavigation = Date.now();
    await driver.page.goto(`${origin}${path}`);
  };
  const rendered = async <Result>(script: string, ready: (view: Result) => boolean): Promise<Result> => {
    const until = Date.now() + 10_000;
    let view: Result | undefined;
    do {
      ensureOpen();
      try {
        view = await driver.page.evaluate<Result>(script);
        if (ready(view)) return view;
      } catch (error) {
        // 画面の読み込み中（移動の直後）は読めないことがあるので、少し待って読み直す
        if (!isNavigationError(error)) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < until);
    if (view === undefined) throw new Error("画面を読み込めませんでした。もう一度実行してください");
    return view;
  };
  const status = async (): Promise<BrowserStatus> => {
    if (closed) return { state: "closed" };
    try {
      const view = await execute(() => driver.page.evaluate<{ ready: boolean }>(statusScript), 30_000);
      return { state: view.ready === true ? "ready" : "login-required" };
    } catch (error) {
      if (closed || options.signal?.aborted) return { state: "closed" };
      // ログインの途中はページが切り替わるので、その瞬間の確認は失敗する。まだログイン中として扱い、次の確認を待つ
      if (isNavigationError(error)) return { state: "login-required" };
      throw error;
    }
  };
  try {
    await execute(() => driver.page.goto(origin), 30_000);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    status,
    close,
    extract: async account => {
      if (!account.accountId.trim()) throw new Error("取得元アカウントの管理番号が必要です");
      if (extracting) throw new Error("画面からの取得はすでに実行中です");
      extracting = true;
      try {
        const { memberIds, complete: listed } = await execute(async () => {
          if ((await status()).state !== "ready") throw new Error("取得用ブラウザでLステップにログインしてください");
          const memberIds = new Set<number>();
          const visitedPages = new Set<number>();
          const pendingPages = [1];
          let complete = false;
          while (pendingPages.length && visitedPages.size < maxPages && memberIds.size < maxFriends) {
            const page = pendingPages.shift()!;
            if (visitedPages.has(page)) continue;
            visitedPages.add(page);
            await navigate(`/line/show?page=${page}`);
            const view = await rendered<FriendListView>(friendListScript, value => Array.isArray(value.friendIds)
              && value.friendIds.length > 0 && (value.currentPage === undefined || value.currentPage === page));
            if (!Array.isArray(view.friendIds) || !Array.isArray(view.nextPages)) throw new Error("友だち一覧の画面を確認できませんでした");
            if (view.currentPage !== undefined && view.currentPage !== page) throw new Error("友だち一覧のページが切り替わらなかったため取得を止めました");
            for (const memberId of view.friendIds) {
              if (!validId(memberId)) throw new Error("友だちの管理番号を確認できませんでした");
              memberIds.add(memberId);
            }
            for (const next of view.nextPages) {
              if (validId(next) && !visitedPages.has(next) && !pendingPages.includes(next)) pendingPages.push(next);
            }
            complete = view.paginationObserved === true && view.lastPageObserved === true && pendingPages.length === 0;
          }
          if (!memberIds.size) throw new Error("画面から友だちを確認できませんでした。CSVの操作は不要です。画面構成の対応が必要です");
          return { memberIds, complete: complete && !pendingPages.length && memberIds.size <= maxFriends };
        });
        const discovered = [...memberIds].slice(0, maxFriends);
        // 一覧の制限時間だけでは、数百人の詳細を読む前に打ち切られるため、人数ぶんの時間を足す
        return await execute(async () => {
          const complete = listed;
          const tagViews = new Map<number, FriendTagsView>();
          for (const memberId of discovered) {
            await navigate(`/line/detail/${memberId}`);
            const view = await rendered<FriendTagsView>(friendTagsScript, value => value.memberId === memberId && value.observed === true);
            if (view.memberId !== memberId) throw new Error("友だちの画面が切り替わったため取得を止めました");
            tagViews.set(memberId, view);
          }
          const script = await readFile(new URL("../../browser/export.js", import.meta.url), "utf8");
          const exportOptions = { accountId: account.accountId.trim(), accountLabel: account.accountLabel,
            friendIds: discovered, maxPages, maxFriends, intervalMs };
          await driver.page.evaluate(`globalThis.LSTEP_EXPORT_OPTIONS = ${JSON.stringify(exportOptions)}; globalThis.LSTEP_EXPORT_CANCEL = false; globalThis.LSTEP_LAST_EXPORT = undefined;`);
          const captured = await driver.page.evaluate<unknown>(script);
          const source = importBrowserExport(captured);
          const discoveredIds = new Set(discovered);
          if (source.resources.friends.length !== discoveredIds.size
            || source.resources.friends.some(friend => !discoveredIds.has(friend.row.lmessage_friend_id))) {
            throw new Error("友だちのLINEユーザーIDまたは管理番号をすべて確認できないため取得を中止しました。友だち一覧からやり直してください");
          }
          const friendNotes = (source.coverage.friends.note ?? "").split(" / ")
            .filter(note => note && note !== "指定された管理番号だけを取得。全友だちとの照合は別途必要");
          if (!complete) friendNotes.push("画面に表示された友だちを取得。全件数またはページ末尾を確認できないため要確認");
          source.coverage.friends = {
            status: complete && !friendNotes.length ? "complete" : "partial",
            count: source.resources.friends.length,
            note: friendNotes.length ? [...new Set(friendNotes)].join(" / ") : undefined,
          };
          source.coverage.friendListScope = {
            status: "partial", count: source.resources.friends.length,
            note: "標準一覧に表示された友だちを取得。非表示・ブロック済み・絞り込みで除外された友だちを含むアカウント全体の範囲は未確認",
          };
          if (source.coverage.friends.status === "complete") {
            for (const key of ["friendFields", "friendScenarios", "conversations"]) {
              const entry = source.coverage[key];
              if (!entry?.note) continue;
              const notes = entry.note.split(" / ").filter(note => note !== "友だち一覧に未取得の可能性があります");
              entry.note = notes.length ? notes.join(" / ") : undefined;
              if (entry.status === "partial" && !entry.note) entry.status = "complete";
            }
          }
          const tagCoverage: ResourceCoverage = { status: source.coverage.friends.status === "complete" ? "complete" : "partial", count: 0 };
          const definitionIds = new Set(source.resources.tags.map(tag => tag.id));
          const uniqueDefinitions = definitionIds.size === source.resources.tags.length;
          for (const friend of source.resources.friends) {
            const view = tagViews.get(friend.row.lmessage_friend_id);
            if (!view?.observed || !Array.isArray(view.tags) || !Array.isArray(view.definitionIds) || !friend.detail
              || view.definitionIds.some(tagId => !validId(tagId))
              || new Set(view.definitionIds).size !== view.definitionIds.length
              || !uniqueDefinitions || definitionIds.size !== view.definitionIds.length
              || !view.definitionIds.every(tagId => definitionIds.has(tagId))) {
              tagCoverage.status = "partial";
              tagCoverage.note = "画面からタグの付与状況を確認できない友だちがあります。未取得を空欄とは扱いません";
              continue;
            }
            const tags = new Map<number, { tag_id: number; tag_name: string }>();
            let verified = true;
            for (const tag of view.tags) {
              if (!validId(tag.id) || !view.definitionIds.includes(tag.id)) { verified = false; break; }
              const matches = source.resources.tags.filter(definition => definition.id === tag.id && definition.name === tag.name);
              if (matches.length !== 1) { verified = false; break; }
              tags.set(matches[0].id, { tag_id: matches[0].id, tag_name: matches[0].name });
            }
            if (!verified) {
              tagCoverage.status = "partial";
              tagCoverage.note = "タグ名の重複または画面と定義の不一致があるため付与状況を確定できません";
              continue;
            }
            friend.detail.tags = [...tags.values()];
            tagCoverage.count += tags.size;
          }
          if (source.coverage.tags.status !== "complete") {
            tagCoverage.status = "partial";
            tagCoverage.note = "タグ定義の全件取得を確認できないため付与状況の全件照合は要確認";
          }
          source.coverage.friendTags = tagCoverage;
          return source;
        }, timeoutMs + discovered.length * perFriendTimeoutMs);
      } finally {
        await close();
      }
    },
  };
}
