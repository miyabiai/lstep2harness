import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalD1 } from "../src/d1/local.js";
import { collectAndPlan, type CollectDependencies, type CollectOptions } from "../src/collect/run.js";
import type { LoginBrowserSession } from "../src/collect/browser.js";
import { createTestDatabase } from "../src/init-db.js";
import { LstepApiError } from "../src/lstep/api.js";
import { importBrowserExport } from "../src/lstep/browser.js";
import { applyLocal } from "../src/pipeline.js";

const DIRECTORIES: string[] = [];
afterEach(() => { for (const directory of DIRECTORIES.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function source(route: "api" | "browser" = "browser") {
  const exported = importBrowserExport(JSON.parse(readFileSync(new URL("fixtures/lstep-browser.json", import.meta.url), "utf8")));
  exported.route = route;
  return exported;
}

function prepare(overrides: Partial<CollectOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "lstep-collect-"));
  DIRECTORIES.push(directory);
  const dbPath = join(directory, "test.sqlite");
  createTestDatabase(dbPath, "trial");
  const options: CollectOptions = { route: "browser", dataRoot: join(directory, "data"), target: { dbPath, lineAccountId: "trial" }, ...overrides };
  return { directory, dbPath, options };
}

function fakeBrowser(states: Array<"login-required" | "ready" | "closed">): LoginBrowserSession & { close: ReturnType<typeof vi.fn>; extract: ReturnType<typeof vi.fn> } {
  let index = 0;
  return {
    status: vi.fn(async () => ({ state: states[Math.min(index++, states.length - 1)] })),
    extract: vi.fn(async ({ accountId }: { accountId: string }) => { const exported = source(); exported.account.id = accountId; return exported; }),
    close: vi.fn(async () => {}),
  };
}

const noWait: CollectDependencies["sleep"] = async () => {};

describe("collectAndPlan", () => {
  it("refuses to open the browser unless the browser route is chosen explicitly", async () => {
    const { options } = prepare({ route: "auto" });
    const createBrowser = vi.fn();
    await expect(collectAndPlan(options, { createBrowser, sleep: noWait })).rejects.toThrow("--route browser");
    expect(createBrowser).not.toHaveBeenCalled();
  });

  it("waits for the person to log in, then collects and writes a plan without applying it", async () => {
    const { options, dbPath } = prepare({ route: "browser" });
    const browser = fakeBrowser(["login-required", "login-required", "ready"]);
    const messages: string[] = [];
    const summary = await collectAndPlan({ ...options, log: message => messages.push(message) }, { createBrowser: async () => browser, sleep: noWait });
    expect(summary.route).toBe("browser");
    expect(browser.status).toHaveBeenCalledTimes(3);
    expect(browser.extract).toHaveBeenCalledWith({ accountId: "lstep" });
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(messages.join()).toContain("ログインしてください");
    expect(existsSync(summary.report)).toBe(true);
    expect(statSync(summary.runDirectory).mode & 0o777).toBe(0o700);
    expect(summary.counts.friends).toBe(2);
    expect(summary.coverage.every(entry => entry.status !== "complete")).toBe(true);
    const database = new LocalD1(dbPath);
    try { expect(database.count("friends")).toBe(0); } finally { database.close(); }
    expect(applyLocal(summary.planDirectory, dbPath, true).checked).toBeGreaterThan(0);
  });

  it("does not leak names, LINE user IDs or answers into the summary", async () => {
    const { options } = prepare();
    const summary = await collectAndPlan(options, { createBrowser: async () => fakeBrowser(["ready"]), sleep: noWait });
    const serialized = JSON.stringify(summary);
    for (const sensitive of ["架空花子", "U11111111111111111111111111111111", "製造業", "hanako@example.invalid"]) expect(serialized).not.toContain(sensitive);
  });

  it("stops when the login window is closed and closes the browser", async () => {
    const { options } = prepare();
    const browser = fakeBrowser(["login-required", "closed"]);
    await expect(collectAndPlan(options, { createBrowser: async () => browser, sleep: noWait })).rejects.toThrow("閉じられました");
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.extract).not.toHaveBeenCalled();
  });

  it("gives up after the login timeout", async () => {
    const { options } = prepare({ loginTimeoutMs: 0 });
    const browser = fakeBrowser(["login-required"]);
    await expect(collectAndPlan(options, { createBrowser: async () => browser, sleep: noWait })).rejects.toThrow("時間を過ぎました");
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("stops while waiting for login when cancelled", async () => {
    const controller = new AbortController();
    const { options } = prepare({ signal: controller.signal });
    const browser = fakeBrowser(["login-required"]);
    const sleep: CollectDependencies["sleep"] = async (_, signal) => { controller.abort(); if (signal?.aborted) throw new Error("中止しました。"); };
    await expect(collectAndPlan(options, { createBrowser: async () => browser, sleep })).rejects.toThrow("中止");
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("uses the API when a token works, without opening a browser", async () => {
    const { options } = prepare({ route: "auto", apiToken: "fictional-token" });
    const api = { doctor: vi.fn(async () => {}), extract: vi.fn(async () => source("api")) };
    const createBrowser = vi.fn();
    const summary = await collectAndPlan(options, { createApiSource: () => api, createBrowser, sleep: noWait });
    expect(summary.route).toBe("api");
    expect(createBrowser).not.toHaveBeenCalled();
  });

  it("does not silently switch to the browser when the configured API fails", async () => {
    const { options } = prepare({ route: "auto", apiToken: "fictional-token" });
    const api = { doctor: vi.fn(async () => { throw new LstepApiError("denied", 401); }), extract: vi.fn() };
    const createBrowser = vi.fn();
    await expect(collectAndPlan(options, { createApiSource: () => api, createBrowser, sleep: noWait })).rejects.toThrow("--route browser");
    expect(createBrowser).not.toHaveBeenCalled();
    expect(api.extract).not.toHaveBeenCalled();
  });

  it("refuses the API route without a token", async () => {
    const { options } = prepare({ route: "api" });
    await expect(collectAndPlan(options, { createBrowser: vi.fn(), sleep: noWait })).rejects.toThrow("LSTEP_API_TOKEN");
  });

  it("requires an API token before starting the hybrid route", async () => {
    const { options } = prepare({ route: "hybrid" });
    const createApiSource = vi.fn();
    const createBrowser = vi.fn();
    await expect(collectAndPlan(options, { createApiSource, createBrowser, sleep: noWait })).rejects.toThrow("LSTEP_API_TOKEN");
    expect(createApiSource).not.toHaveBeenCalled();
    expect(createBrowser).not.toHaveBeenCalled();
  });

  it("does not open a hybrid browser if official API authentication or extraction fails", async () => {
    for (const failure of ["doctor", "extract"] as const) {
      const { options } = prepare({ route: "hybrid", apiToken: "fictional-token" });
      const api = {
        doctor: vi.fn(async () => { if (failure === "doctor") throw new LstepApiError("denied", 403); }),
        extract: vi.fn(async () => { throw new Error("API extraction failed"); }),
      };
      const createBrowser = vi.fn();
      await expect(collectAndPlan(options, { createApiSource: () => api, createBrowser, sleep: noWait })).rejects.toThrow();
      expect(createBrowser).not.toHaveBeenCalled();
      if (failure === "doctor") expect(api.extract).not.toHaveBeenCalled();
    }
  });

  it("passes only official numeric friend IDs to supplementation after collecting the API, and closes on failure", async () => {
    const { options } = prepare({ route: "hybrid", apiToken: "fictional-secret-token" });
    const calls: string[] = [];
    const apiSource = source("api");
    const api = {
      doctor: vi.fn(async () => { calls.push("doctor"); }),
      extract: vi.fn(async () => { calls.push("api-extract"); return apiSource; }),
    };
    const browser = fakeBrowser(["login-required", "ready"]);
    const supplement = vi.fn(async () => { calls.push("supplement"); throw new Error("supplement failed"); });
    browser.supplement = supplement;
    const createBrowser = vi.fn(async () => { calls.push("browser"); return browser; });
    await expect(collectAndPlan(options, { createApiSource: () => api, createBrowser, sleep: noWait })).rejects.toThrow("supplement failed");
    expect(calls).toEqual(["doctor", "api-extract", "browser", "supplement"]);
    expect(supplement).toHaveBeenCalledWith({ accountId: "lstep" }, [1001, 1002]);
    const argumentsPassed = JSON.stringify(supplement.mock.calls);
    expect(argumentsPassed).not.toContain(options.apiToken);
    for (const friend of apiSource.resources.friends) expect(argumentsPassed).not.toContain(friend.row.line_friend_id);
    expect(browser.extract).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(existsSync(options.dataRoot)).toBe(false);
  });

  it("creates a hybrid plan with both sources recorded after successful supplementation", async () => {
    const { options } = prepare({ route: "hybrid", apiToken: "fictional-token" });
    const apiSource = source("api");
    apiSource.account.id = "lstep";
    const raw = JSON.parse(readFileSync(new URL("fixtures/lstep-browser.json", import.meta.url), "utf8"));
    raw.mode = "supplement";
    raw.account.id = "lstep";
    raw.identity = { memberId: 1001, visibleFriendIds: [1001, 1002] };
    raw.data.friends = raw.data.friends.map((friend: { id: number; scenarios: unknown[] }) => ({ id: friend.id, scenarios: friend.scenarios }));
    const browser = fakeBrowser(["ready"]);
    browser.supplement = vi.fn(async () => raw);
    const summary = await collectAndPlan(options, {
      createApiSource: () => ({ doctor: async () => {}, extract: async () => apiSource }),
      createBrowser: async () => browser, sleep: noWait,
    });
    expect(summary.route).toBe("hybrid");
    expect(summary.counts.friends).toBe(2);
    expect(summary.counts.templates).toBe(2);
    const snapshot = join(summary.runDirectory, "snapshot");
    expect(JSON.parse(readFileSync(join(snapshot, "source.json"), "utf8")).route).toBe("hybrid");
    expect(JSON.parse(readFileSync(join(snapshot, "meta.json"), "utf8")).sources).toEqual({ api: true, browser: true, mcp: false });
    expect(browser.extract).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("stops when a browser cannot supplement instead of falling back to its full export", async () => {
    const { options } = prepare({ route: "hybrid", apiToken: "fictional-token" });
    const browser = fakeBrowser(["ready"]);
    await expect(collectAndPlan(options, {
      createApiSource: () => ({ doctor: async () => {}, extract: async () => source("api") }),
      createBrowser: async () => browser, sleep: noWait,
    })).rejects.toThrow("設定補完に対応していません");
    expect(browser.extract).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("checks the target before opening a browser", async () => {
    const { options, dbPath } = prepare();
    const database = new LocalD1(dbPath);
    try { database.exec("UPDATE line_accounts SET is_active=1"); } finally { database.close(); }
    const createBrowser = vi.fn();
    await expect(collectAndPlan(options, { createBrowser, sleep: noWait })).rejects.toThrow("停止中ではありません");
    expect(createBrowser).not.toHaveBeenCalled();
    await expect(collectAndPlan({ ...options, target: { ...options.target, dbPath: join(options.dataRoot, "missing.sqlite") } }, { createBrowser, sleep: noWait }))
      .rejects.toThrow("init-db");
  });

  it("keeps every run in its own folder", async () => {
    const { options, directory } = prepare();
    await collectAndPlan(options, { createBrowser: async () => fakeBrowser(["ready"]), sleep: noWait });
    await collectAndPlan(options, { createBrowser: async () => fakeBrowser(["ready"]), sleep: noWait });
    expect(readdirSync(join(directory, "data", "runs"))).toHaveLength(2);
  });
});

describe("data folder setting", () => {
  it("treats an empty LSTEP2HARNESS_DATA_DIR from the example .env as not set", async () => {
    const previous = process.env.LSTEP2HARNESS_DATA_DIR;
    process.env.LSTEP2HARNESS_DATA_DIR = "";
    try {
      vi.resetModules();
      const { DATA_ROOT } = await import("../src/collect/data-root.js");
      expect(DATA_ROOT.endsWith("lstep2harness")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.LSTEP2HARNESS_DATA_DIR;
      else process.env.LSTEP2HARNESS_DATA_DIR = previous;
      vi.resetModules();
    }
  });
});

describe("summary shown in the chat", () => {
  it("does not copy template text fragments into the summary", async () => {
    const { options } = prepare();
    const exported = source();
    exported.resources.templates.push({ id: 999, name: "架空の案内", type: "text", content: "ご連絡は [TEL_09012345678] まで" } as never);
    exported.resources.templates.push({ id: 998, name: "移せない案内", type: "unknown-kind" } as never);
    const browser = fakeBrowser(["ready"]);
    browser.extract.mockResolvedValue(exported);
    const summary = await collectAndPlan(options, { createBrowser: async () => browser, sleep: noWait });
    expect(JSON.stringify(summary)).not.toContain("09012345678");
    // 差し込みタグの注意が出る経路を通ったことを、手元のレポートで確かめる
    expect(readFileSync(summary.report, "utf8")).toContain("差し込みタグ");
    expect(readFileSync(summary.report, "utf8")).not.toContain("09012345678");
  });

  it("lists forms with questions that cannot be migrated even when there are no answers", async () => {
    const { options } = prepare();
    const exported = source();
    exported.resources.formResponses = {};
    const field = exported.resources.forms[0].pages![0].fields![0];
    field.type = "friend_info_file";
    const browser = fakeBrowser(["ready"]);
    browser.extract.mockResolvedValue(exported);
    const summary = await collectAndPlan(options, { createBrowser: async () => browser, sleep: noWait });
    expect(summary.issues.some(issue => issue.label === "フォーム")).toBe(true);
  });
});

describe("summary lists partial tag migration", () => {
  it("reports forms that add several tags on reply, since only the first one is migrated", async () => {
    const { options } = prepare();
    const exported = source();
    exported.resources.tags.push({ id: 991, name: "追加タグ1" }, { id: 992, name: "追加タグ2" });
    exported.resources.forms[0].actions_on_reply = [{ type: "tag", data: { ids: [991, 992], action: 1 } }] as never;
    const browser = fakeBrowser(["ready"]);
    browser.extract.mockResolvedValue(exported);
    const summary = await collectAndPlan(options, { createBrowser: async () => browser, sleep: noWait });
    expect(summary.issues.find(issue => issue.label === "フォーム")?.notes.join()).toContain("最初のタグだけ");
  });
});

describe("shellQuote", () => {
  it("keeps $() and backquotes from being expanded", async () => {
    const { shellQuote } = await import("../src/util.js");
    const { execFileSync } = await import("node:child_process");
    const value = "/tmp/a $(echo hacked) `echo hacked` it's";
    expect(execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" })).toBe(value);
  });
});

describe("collectAndPlan（本番の L Harness へ）", () => {
  it("書き込まずに移行先を確かめ、今の状態に合わせた計画と要約を作る", async () => {
    const { SqliteHarnessDatabase } = await import("../src/harness/database.js");
    const { applyHarness } = await import("../src/harness/remote.js");
    const directory = mkdtempSync(join(tmpdir(), "lstep-collect-harness-"));
    DIRECTORIES.push(directory);
    const dbPath = join(directory, "harness.sqlite");
    const setup = new LocalD1(dbPath);
    setup.loadSchema(new URL("../schema/line-harness-bootstrap.sql", import.meta.url).pathname);
    setup.db.prepare("INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret,is_active) VALUES ('live','c','架空の本番',  't','s',1)").run();
    setup.db.prepare("INSERT INTO friends (id,line_user_id,line_account_id) VALUES ('h1','U11111111111111111111111111111111','live')").run();
    setup.db.prepare("INSERT INTO tags (id,name) VALUES ('t1','回答済み✅')").run();
    setup.close();
    const harness = new SqliteHarnessDatabase(dbPath, "架空の本番D1");
    const summary = await collectAndPlan(
      { route: "browser", dataRoot: join(directory, "data"), target: { harness, key: "d1:x", lineAccountId: "live" } },
      { createBrowser: async () => fakeBrowser(["ready"]), sleep: noWait },
    );
    expect(summary.target).toEqual({
      database: "架空の本番D1", account: { id: "live", name: "架空の本番", isActive: true },
      friendsBefore: 1, alreadyThere: 1, reusedTags: 1,
    });
    expect(harness.executed).toEqual([]);
    expect(JSON.stringify(summary)).not.toContain("U11111111111111111111111111111111");
    await expect(applyHarness(summary.planDirectory, harness, { key: "d1:x", allowPartial: true })).resolves.toMatchObject({ partial: true });
  });

  it("移行先アカウントが無ければ、ログインの前に止める", async () => {
    const { SqliteHarnessDatabase } = await import("../src/harness/database.js");
    const directory = mkdtempSync(join(tmpdir(), "lstep-collect-harness-"));
    DIRECTORIES.push(directory);
    const setup = new LocalD1(join(directory, "h.sqlite"));
    setup.loadSchema(new URL("../schema/line-harness-bootstrap.sql", import.meta.url).pathname);
    setup.close();
    const createBrowser = vi.fn();
    await expect(collectAndPlan(
      { route: "browser", dataRoot: join(directory, "data"), target: { harness: new SqliteHarnessDatabase(join(directory, "h.sqlite")), key: "d1:x", lineAccountId: "missing" } },
      { createBrowser, sleep: noWait },
    )).rejects.toThrow(/移行先アカウントID/);
    expect(createBrowser).not.toHaveBeenCalled();
  });
});
