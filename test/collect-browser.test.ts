import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import {
  createLoginBrowserSession, type LoginBrowserDriver, type LoginBrowserOptions,
} from "../src/collect/browser.js";

const uid = `U${"a".repeat(32)}`;

function capture() {
  return {
    format: "lstep-browser-v1", account: { id: "account" }, exportedAt: "2026-10-26T00:00:00Z",
    data: {
      friends: [{ id: 12, uid, name: "テスト🌸", tags: [], fields: [], scenarios: [],
        timeline: { complete: true, messages: [] } }],
      tags: [{ id: 1, name: "資料請求済み" }], fields: [], templates: [], scenarios: [], forms: [], formResponses: {},
    },
    coverage: { tags: { status: "complete", count: 1 }, friends: {
      status: "partial", count: 1, note: "指定された管理番号だけを取得。全友だちとの照合は別途必要",
    } },
  };
}

function mockBrowser(settings: {
  ready?: boolean;
  pages?: { friendIds: number[]; nextPages: number[]; paginationObserved: boolean; lastPageObserved?: boolean; currentPage?: number }[];
  tags?: { memberId: number; observed: boolean; definitionIds?: number[]; tags: { id?: number; name: string }[] };
  exported?: unknown;
  hangExport?: boolean;
} = {}) {
  const visited: string[] = [];
  const scripts: string[] = [];
  let page = 0;
  const close = vi.fn(async () => undefined);
  const driver: LoginBrowserDriver = {
    page: {
      goto: async url => { visited.push(url); },
      evaluate: async <Result>(script: string): Promise<Result> => {
        scripts.push(script);
        if (script.includes("ready: location.origin")) return { ready: settings.ready !== false } as Result;
        if (script.includes("const friendIds = new Set")) {
          return (settings.pages?.[Math.min(page++, settings.pages.length - 1)] ?? { friendIds: [12], nextPages: [], paginationObserved: true, lastPageObserved: true }) as Result;
        }
        if (script.includes("#tag_edit #tag_edit_form")) {
          return (settings.tags ?? { memberId: 12, observed: true, definitionIds: [1], tags: [{ id: 1, name: "資料請求済み" }] }) as Result;
        }
        if (script.startsWith("globalThis.LSTEP_EXPORT_OPTIONS")) return undefined as Result;
        if (settings.hangExport) return new Promise<Result>(() => undefined);
        return (settings.exported ?? capture()) as Result;
      },
    }, close,
  };
  return { driver, close, visited, scripts };
}

async function session(settings: Parameters<typeof mockBrowser>[0] = {}, options: LoginBrowserOptions = {}) {
  const browser = mockBrowser(settings);
  const adapter = await createLoginBrowserSession(options, async () => browser.driver);
  return { ...browser, adapter };
}

beforeEach(() => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now += 2000);
});

afterEach(() => vi.restoreAllMocks());

describe("login browser", () => {
  it("opens a dedicated login flow and returns sanitized data without downloads, files or console paste", async () => {
    const browser = await session();
    expect(await browser.adapter.status()).toEqual({ state: "ready" });
    const result = await browser.adapter.extract({ accountId: "account", accountLabel: "移行試験" });
    expect(browser.visited).toEqual([
      "https://manager.linestep.net", "https://manager.linestep.net/line/show?page=1", "https://manager.linestep.net/line/detail/12",
    ]);
    expect(result.resources.friends[0].row.line_friend_id).toBe(uid);
    expect(result.resources.friends[0].detail?.tags).toEqual([{ tag_id: 1, tag_name: "資料請求済み" }]);
    expect(result.coverage.friends).toMatchObject({ status: "complete", count: 1 });
    expect(result.coverage.friendListScope).toMatchObject({ status: "partial", count: 1 });
    expect(result.coverage.friendListScope.note).toContain("標準一覧");
    expect(result.coverage.friendTags).toMatchObject({ status: "complete", count: 1 });
    expect(browser.scripts.find(script => script.startsWith("globalThis.LSTEP_EXPORT_OPTIONS"))).not.toContain('download');
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(await browser.adapter.status()).toEqual({ state: "closed" });
  });

  it("does not start extraction until the person has logged in", async () => {
    const browser = await session({ ready: false });
    expect(await browser.adapter.status()).toEqual({ state: "login-required" });
    await expect(browser.adapter.extract({ accountId: "account" })).rejects.toThrow("ログイン");
    expect(browser.visited).toEqual(["https://manager.linestep.net"]);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("accepts the root dashboard only with CSRF metadata and the same-origin friends navigation", async () => {
    const browser = await session();
    await browser.adapter.status();
    const script = browser.scripts.find(script => script.includes("ready: location.origin"))!;
    const location = { origin: "https://manager.linestep.net", pathname: "/" };
    const document = {
      querySelector: () => ({ content: "synthetic-csrf" }),
      querySelectorAll: () => [{ getAttribute: () => "/line/show" }],
    };
    expect(runInNewContext(script, { location, document, URL })).toEqual({ ready: true });
    location.pathname = "/line/login";
    expect(runInNewContext(script, { location, document, URL })).toEqual({ ready: false });
    location.pathname = "/";
    document.querySelectorAll = () => [];
    expect(runInNewContext(script, { location, document, URL })).toEqual({ ready: false });
    document.querySelectorAll = () => [{ getAttribute: () => "https://other.test/line/show" }];
    expect(runInNewContext(script, { location, document, URL })).toEqual({ ready: false });
    await browser.adapter.close();
  });

  it("collects rendered friend IDs across pages", async () => {
    const browser = await session({ pages: [
      { friendIds: [12], nextPages: [2], paginationObserved: true },
      { friendIds: [13], nextPages: [1], paginationObserved: true, lastPageObserved: true },
    ] });
    await expect(browser.adapter.extract({ accountId: "account" })).rejects.toThrow("切り替わった");
    expect(browser.visited).toContain("https://manager.linestep.net/line/show?page=2");
    expect(browser.visited).toContain("https://manager.linestep.net/line/detail/13");
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("never claims full coverage when the page boundary or total is not verified", async () => {
    const browser = await session({ pages: [{ friendIds: [12], nextPages: [], paginationObserved: false }] });
    const result = await browser.adapter.extract({ accountId: "account" });
    expect(result.coverage.friends.status).toBe("partial");
    expect(result.coverage.friendTags.status).toBe("partial");
  });

  it("does not infer the last page solely from an existing pagination container", async () => {
    const browser = await session({ pages: [{ friendIds: [12], nextPages: [], paginationObserved: true }] });
    const result = await browser.adapter.extract({ accountId: "account" });
    expect(result.coverage.friends.status).toBe("partial");
  });

  it("waits for client-rendered friend links without an extra navigation or manual action", async () => {
    const browser = await session({ pages: [
      { friendIds: [], nextPages: [], paginationObserved: false },
      { friendIds: [12], nextPages: [], paginationObserved: true, lastPageObserved: true, currentPage: 1 },
    ] });
    const result = await browser.adapter.extract({ accountId: "account" });
    expect(result.coverage.friends.status).toBe("complete");
    expect(browser.visited.filter(url => url.includes("/line/show"))).toHaveLength(1);
  });

  it("reports unknown tag DOM as missing, not as a verified empty tag list", async () => {
    const browser = await session({ tags: { memberId: 12, observed: false, tags: [] } });
    const result = await browser.adapter.extract({ accountId: "account" });
    expect(result.coverage.friendTags.status).toBe("partial");
    expect(result.coverage.friendTags.note).toContain("未取得を空欄とは扱いません");
  });

  it("reads checked properties and management IDs from the observed tag form, without opening a tab", async () => {
    const browser = await session();
    await browser.adapter.extract({ accountId: "account" });
    const script = browser.scripts.find(script => script.includes("#tag_edit #tag_edit_form"))!;
    const result = runInNewContext(script, {
      location: { pathname: "/line/detail/12" },
      document: { querySelector: (selector: string) => {
        expect(selector).toBe("#tag_edit #tag_edit_form");
        return { querySelectorAll: (inputSelector: string) => {
          expect(inputSelector).toBe('input[type="checkbox"][name="tags[]"]');
          return [
            { value: "1", checked: true, closest: () => ({ textContent: " 資料請求済み🌸 " }) },
            { value: "2", checked: false, closest: () => ({ textContent: "未選択" }) },
          ];
        } };
      } },
    });
    expect(result).toEqual({ memberId: 12, observed: true, definitionIds: [1, 2], tags: [{ id: 1, name: "資料請求済み🌸" }] });
  });

  it("recognizes the observed rendered pagination buttons and disabled last-page state", async () => {
    const browser = await session();
    await browser.adapter.extract({ accountId: "account" });
    const script = browser.scripts.find(script => script.includes("const friendIds = new Set"))!;
    const nextButton = { disabled: false, getAttribute: () => "次のページ(現在: 2)" };
    const document = {
      querySelectorAll: (selector: string) => selector === "a[href]"
        ? [{ getAttribute: () => "/line/detail/12" }, { getAttribute: () => "https://other.test/line/detail/99" }]
        : [{ querySelectorAll: () => [nextButton] }],
    };
    const next = runInNewContext(script, { document, URL, location: { origin: "https://manager.linestep.net" } });
    expect(next).toEqual({ friendIds: [12], nextPages: [3], paginationObserved: true, lastPageObserved: false, currentPage: 2 });
    nextButton.disabled = true;
    const last = runInNewContext(script, { document, URL, location: { origin: "https://manager.linestep.net" } });
    expect(last).toMatchObject({ nextPages: [], paginationObserved: true, lastPageObserved: true });
  });

  it("keeps unrelated partial-coverage reasons after confirming the complete friend list", async () => {
    const exported = capture() as ReturnType<typeof capture> & { coverage: Record<string, unknown> };
    exported.coverage.friendFields = { status: "partial", count: 0, note: "友だち情報の値が未取得 / 友だち一覧に未取得の可能性があります" };
    exported.coverage.friendScenarios = { status: "partial", count: 0, note: "友だち一覧に未取得の可能性があります" };
    const browser = await session({ exported });
    const result = await browser.adapter.extract({ accountId: "account" });
    expect(result.coverage.friendFields).toMatchObject({ status: "partial", note: "友だち情報の値が未取得" });
    expect(result.coverage.friendScenarios.status).toBe("complete");
  });

  it("retains additional friend warnings instead of overwriting them with a complete DOM-list claim", async () => {
    const exported = capture();
    exported.coverage.friends.note += " / 追加の友だち情報に未取得があります";
    const browser = await session({ exported });
    const result = await browser.adapter.extract({ accountId: "account" });
    expect(result.coverage.friends).toMatchObject({ status: "partial", note: "追加の友だち情報に未取得があります" });
  });

  it("does not claim tag completeness when the rendered tag universe is truncated", async () => {
    const browser = await session({ tags: { memberId: 12, observed: true, definitionIds: [], tags: [] } });
    const result = await browser.adapter.extract({ accountId: "account" });
    expect(result.coverage.friendTags.status).toBe("partial");
  });

  it("recognizes a verified zero-tag assignment without requiring CSV", async () => {
    const browser = await session({ tags: { memberId: 12, observed: true, definitionIds: [1], tags: [] } });
    const result = await browser.adapter.extract({ accountId: "account" });
    expect(result.coverage.friendTags).toMatchObject({ status: "complete", count: 0 });
  });

  it("rejects detail navigation to a different person and closes the browser", async () => {
    const browser = await session({ tags: { memberId: 99, observed: true, tags: [] } });
    await expect(browser.adapter.extract({ accountId: "account" })).rejects.toThrow("切り替わった");
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("does not guess between duplicate tag names", async () => {
    const exported = capture();
    exported.data.tags.push({ id: 2, name: "資料請求済み" });
    const browser = await session({ exported, tags: { memberId: 12, observed: true, definitionIds: [1, 2], tags: [{ name: "資料請求済み" }] } });
    const result = await browser.adapter.extract({ accountId: "account" });
    expect(result.coverage.friendTags.status).toBe("partial");
    expect(result.resources.friends[0].detail?.tags).toEqual([]);
  });

  it("does not require manual CSV when friend discovery is unsupported", async () => {
    const browser = await session({ pages: [{ friendIds: [], nextPages: [], paginationObserved: false }] });
    await expect(browser.adapter.extract({ accountId: "account" })).rejects.toThrow("CSVの操作は不要");
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("stops instead of previewing definitions only when the exporter skips a friend with a missing LINE user ID", async () => {
    const exported = capture();
    exported.data.friends = [];
    const browser = await session({ exported });
    await expect(browser.adapter.extract({ accountId: "account" })).rejects.toThrow("すべて確認できないため取得を中止");
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("stops when a discovered management ID is missing even if a different friend is returned", async () => {
    const exported = capture();
    exported.data.friends[0].id = 99;
    const browser = await session({ exported });
    await expect(browser.adapter.extract({ accountId: "account" })).rejects.toThrow("すべて確認できないため取得を中止");
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a returned friend without a valid LINE user ID", async () => {
    const exported = capture();
    exported.data.friends[0].uid = "";
    const browser = await session({ exported });
    await expect(browser.adapter.extract({ accountId: "account" })).rejects.toThrow("LINEユーザーIDが無い友だちがいます");
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("closes the context on cancellation, including an in-flight browser script", async () => {
    const controller = new AbortController();
    const browser = await session({ hangExport: true }, { signal: controller.signal });
    const extracting = browser.adapter.extract({ accountId: "account" });
    await vi.waitFor(() => expect(browser.scripts.some(script => script.includes('const options = globalThis.LSTEP_EXPORT_OPTIONS'))).toBe(true));
    controller.abort();
    await expect(extracting).rejects.toThrow("中止");
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("closes the context on a bounded extraction timeout", async () => {
    const browser = await session({ hangExport: true }, { timeoutMs: 20, perFriendTimeoutMs: 1 });
    await expect(browser.adapter.extract({ accountId: "account" })).rejects.toThrow("制限時間");
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting when the page navigates during login instead of failing", async () => {
    const browser = mockBrowser();
    let calls = 0;
    const evaluate = browser.driver.page.evaluate;
    browser.driver.page.evaluate = async <Result>(script: string): Promise<Result> => {
      if (script.includes("ready: location.origin") && calls++ === 0) {
        throw new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation");
      }
      return evaluate(script);
    };
    const adapter = await createLoginBrowserSession({}, async () => browser.driver);
    expect(await adapter.status()).toEqual({ state: "login-required" });
    expect(await adapter.status()).toEqual({ state: "ready" });
  });

  it("reports a closed browser after the user closes the window", async () => {
    const browser = mockBrowser();
    let disconnect: () => void = () => {};
    const adapter = await createLoginBrowserSession({}, async () => ({ ...browser.driver, onDisconnected: listener => { disconnect = listener; } }));
    expect(await adapter.status()).toEqual({ state: "ready" });
    disconnect();
    expect(await adapter.status()).toEqual({ state: "closed" });
    await expect(adapter.extract({ accountId: "account" })).rejects.toThrow("中止");
  });

  it("does not keep failing close() after the first close attempt fails", async () => {
    const browser = mockBrowser();
    browser.driver.close = vi.fn(async () => { throw new Error("already gone"); });
    const adapter = await createLoginBrowserSession({}, async () => browser.driver);
    await expect(adapter.close()).resolves.toBeUndefined();
    await expect(adapter.close()).resolves.toBeUndefined();
  });

  it("revalidates the browser allowlist and never returns secret-bearing unknown fields", async () => {
    const exported = { ...capture(), user: { token: "DO_NOT_EXPORT" } };
    const browser = await session({ exported });
    const result = await browser.adapter.extract({ accountId: "account" });
    expect(JSON.stringify(result)).not.toContain("DO_NOT_EXPORT");
  });
});
