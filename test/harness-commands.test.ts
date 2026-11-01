import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalD1 } from "../src/d1/local.js";
import { WranglerD1, assertHarnessPlatform, runWrangler, wranglerCommand, wranglerEnv, isTransientD1Error, type WranglerRunner } from "../src/d1/wrangler.js";
import { SqliteHarnessDatabase } from "../src/harness/database.js";
import { HarnessApi } from "../src/harness/api.js";
import { loadConnection, openD1, parseWranglerToml, targetKey } from "../src/harness/connection.js";
import { runConnect } from "../src/commands/connect.js";
import { runEnrich } from "../src/commands/enrich.js";
import { isLstepTrackingUrl, runRichMenu } from "../src/commands/richmenu.js";
import { keptKvBlock, runBridge, syncBridgeTemplate, type CommandRunner } from "../src/commands/bridge.js";

const SCHEMA = fileURLToPath(new URL("../schema/line-harness-bootstrap.sql", import.meta.url));
const TEMPORARIES: string[] = [];

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "lstep-commands-"));
  TEMPORARIES.push(directory);
  return directory;
}

function harnessDb(accounts: Array<[string, string, number]>) {
  const path = join(temporary(), "harness.sqlite");
  const setup = new LocalD1(path);
  setup.loadSchema(SCHEMA);
  for (const [id, name, active] of accounts) {
    setup.db.prepare("INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret,is_active) VALUES (?,?,?,?,?,?)")
      .run(id, `${id}-channel`, name, "secret-token-must-not-be-read", "secret", active);
  }
  setup.close();
  return new SqliteHarnessDatabase(path, "架空の本番D1");
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  for (const directory of TEMPORARIES.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("wrangler 経由の D1", () => {
  it("remote / local の切り替え・読み出し・ファイル投入の引数を組み立てる", async () => {
    const calls: string[][] = [];
    const runner: WranglerRunner = async (args) => {
      calls.push(args);
      if (args.includes("--file") && args.includes("--json")) {
        const file = args[args.indexOf("--file") + 1];
        expect(readFileSync(file, "utf8")).toBe("SELECT 1;\nSELECT 2;\n");
        expect(statSync(file).mode & 0o777).toBe(0o600);
        return { code: 0, stdout: "log line\n[{\"results\":[{\"c\":1}],\"success\":true},{\"results\":[{\"c\":2}]}]", stderr: "" };
      }
      if (args.includes("time-travel")) return { code: 0, stdout: "{\"bookmark\":\"00000000-00000000-00000000-fictional-bookmark\"}", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const remote = new WranglerD1({ databaseName: "line-harness" }, runner);
    expect(await remote.queryMany(["SELECT 1;", "SELECT 2"])).toEqual([[{ c: 1 }], [{ c: 2 }]]);
    await remote.executeFile("/tmp/x.sql");
    expect(await remote.bookmark()).toBe("00000000-00000000-00000000-fictional-bookmark");
    expect(calls[0].slice(0, 5)).toEqual(["d1", "execute", "line-harness", "--remote", "--file"]);
    expect(calls[0].slice(6)).toEqual(["--json", "--yes"]);
    expect(existsSync(calls[0][5])).toBe(false); // 読み出しの SQL（顧客データ）は終わったら消す
    expect(calls[0].join(" ")).not.toContain("SELECT");
    expect(calls[1]).toEqual(["d1", "execute", "line-harness", "--remote", "--file", "/tmp/x.sql", "--yes"]);
    const local = new WranglerD1({ databaseName: "line-harness", remote: false }, runner);
    await local.executeFile("/tmp/y.sql");
    expect(calls.at(-1)).toContain("--local");
    expect(await local.bookmark()).toBeNull();
    expect(remote.label).toBe("D1「line-harness」(remote)");
  });

  it("一時的な失敗は待って再試行し、それ以外はすぐ止める。エラーに SQL の値を出さない", async () => {
    let attempts = 0;
    const flaky: WranglerRunner = async () => (++attempts < 3
      ? { code: 1, stdout: "", stderr: "✘ [ERROR] File could not be uploaded. Please retry." }
      : { code: 0, stdout: "", stderr: "" });
    const waits: number[] = [];
    await new WranglerD1({ databaseName: "db" }, flaky, async (ms) => { waits.push(ms); }).executeFile("a.sql");
    expect(attempts).toBe(3);
    expect(waits).toEqual([5_000, 15_000]);
    const broken: WranglerRunner = async () => ({ code: 1, stdout: "", stderr: "INSERT INTO friends VALUES ('架空花子')\n✘ [ERROR] UNIQUE constraint failed: tags.name" });
    const error = await new WranglerD1({ databaseName: "db" }, broken, async () => {}).executeFile("a.sql").catch((e: Error) => e);
    expect(String(error)).toContain("UNIQUE constraint failed");
    expect(String(error)).not.toContain("架空花子");
    expect(isTransientD1Error("fetch failed")).toBe(true);
    expect(isTransientD1Error("no such table: friends")).toBe(false);
  });

  it("出力の受け取りの切れ目で日本語・絵文字が壊れない（実際の D1 で起きた）", async () => {
    // 「架」の3バイトを2回に分けて書く子プロセス
    const script = "const b=Buffer.from('[{\"results\":[{\"v\":\"架空🍁\"}]}]');process.stdout.write(b.subarray(0,20));setTimeout(()=>process.stdout.write(b.subarray(20)),50)";
    const result = await runWrangler([], { databaseName: "x", command: [process.execPath, "-e", script] });
    expect(JSON.parse(result.stdout)[0].results[0].v).toBe("架空🍁");
  });

  it(".env の空欄の Cloudflare の値は wrangler に渡さない（wrangler login を使う）", () => {
    const env = wranglerEnv({}, { CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: " ", PATH: "/bin" });
    expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(env.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
    expect(wranglerEnv({ CLOUDFLARE_ACCOUNT_ID: "abc" }, { CLOUDFLARE_API_TOKEN: "t" })).toMatchObject({ CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "abc", WRANGLER_SEND_METRICS: "false" });
    // 読み出した顧客データを wrangler 自身のログに残さない
    expect(wranglerEnv({}, { WRANGLER_WRITE_LOGS: "true" }).WRANGLER_WRITE_LOGS).toBe("false");
  });

  it("起動コマンドを差し替えられ、無ければ版を固定した npx を使う", () => {
    expect(wranglerCommand(undefined, "my-wrangler --profile a")).toEqual(["my-wrangler", "--profile", "a"]);
    expect(wranglerCommand("/nonexistent", "")).toEqual(["npx", "--yes", "wrangler@4.150.0"]);
  });
});

describe("connect", () => {
  it("導入フォルダから読み、アカウントが1つならそれを選び、秘密を書かずに保存する", async () => {
    const cwd = temporary();
    const install = join(cwd, "line-harness");
    mkdirSync(join(install, "apps", "worker"), { recursive: true });
    writeFileSync(join(install, ".line-harness-config.json"), JSON.stringify({
      workerUrl: "https://fictional-harness.example.workers.dev", workerName: "fictional-harness",
      d1DatabaseName: "fictional-d1", d1DatabaseId: "00000000-0000-0000-0000-000000000000", accountId: "0123456789abcdef0123456789abcdef", apiKey: "must-not-be-copied",
    }));
    writeFileSync(join(install, "apps", "worker", "wrangler.toml"), "name = \"fictional-harness\"\n");
    const database = harnessDb([["acc-1", "架空の公式アカウント", 1]]);
    const seen: string[] = [];
    const summary = await runConnect({ cwd, env: { HARNESS_API_KEY: "fictional-key" } }, {
      openDatabase: (connection) => { seen.push(connection.d1_database_name); return database; },
      fetchImpl: async (input) => { seen.push(String(input)); return jsonResponse(200, { success: true, data: [{ id: "acc-1", name: "架空の公式アカウント", isActive: true }] }); },
    });
    expect(summary).toMatchObject({ account: { id: "acc-1", name: "架空の公式アカウント", isActive: true, friends: 0 }, apiKey: "ok", missingSecrets: ["LINE_CHANNEL_SECRET"] });
    expect(seen).toEqual(["fictional-d1", "https://fictional-harness.example.workers.dev/api/line-accounts"]);
    const saved = readFileSync(join(cwd, "lstep2harness.config.json"), "utf8");
    expect(saved).not.toContain("must-not-be-copied");
    expect(saved).not.toContain("fictional-key");
    expect(statSync(join(cwd, "lstep2harness.config.json")).mode & 0o777).toBe(0o600);
    expect(loadConnection(cwd)).toMatchObject({
      d1_database_name: "fictional-d1", line_account_id: "acc-1", harness_worker_name: "fictional-harness",
      cloudflare_account_id: "0123456789abcdef0123456789abcdef", harness_worker_dir: join(install, "apps", "worker"),
    });
    expect(() => openD1(loadConnection(cwd), false, { CLOUDFLARE_ACCOUNT_ID: "ffffffffffffffffffffffffffffffff" })).toThrow(/違います/);
    expect(targetKey(loadConnection(cwd))).toBe("d1:0123456789abcdef0123456789abcdef:00000000-0000-0000-0000-000000000000:fictional-d1");
    // .env に空の欄を足す（値は書かない）。2回目は何も足さない
    expect(summary.addedEnvSlots).toEqual(["HARNESS_API_KEY", "LINE_CHANNEL_SECRET", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
    expect(readFileSync(join(cwd, ".env"), "utf8")).toMatch(/^HARNESS_API_KEY=$/m);
    expect(statSync(join(cwd, ".env")).mode & 0o777).toBe(0o600);
    const again = await runConnect({ cwd, env: { HARNESS_API_KEY: "fictional-key" } }, { openDatabase: () => database, fetchImpl: async () => jsonResponse(200, { success: true, data: [{ id: "acc-1", name: "架空の公式アカウント", isActive: true }] }) });
    expect(again.addedEnvSlots).toEqual([]);
  });

  it(".env に既にある値は残し、無い欄だけ足す", async () => {
    const cwd = temporary();
    writeFileSync(join(cwd, ".env"), "LSTEP_API_TOKEN=keep-me\nHARNESS_API_KEY=already");
    const database = harnessDb([["acc-1", "本店", 1]]);
    const summary = await runConnect({ cwd, d1: "fictional-d1", env: {} }, { openDatabase: () => database });
    expect(summary.addedEnvSlots).toEqual(["LINE_CHANNEL_SECRET", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
    const text = readFileSync(join(cwd, ".env"), "utf8");
    expect(text).toContain("LSTEP_API_TOKEN=keep-me\nHARNESS_API_KEY=already\n#");
  });

  it("アカウントが複数なら一覧を出して止まり、--line-account-id で選べる。API キーの誤りを知らせる", async () => {
    const cwd = temporary();
    const database = harnessDb([["acc-1", "本店", 1], ["acc-2", "支店", 0]]);
    const open = { openDatabase: () => database, fetchImpl: async () => jsonResponse(401, { success: false, error: "Unauthorized" }) };
    await expect(runConnect({ cwd, d1: "fictional-d1", env: {} }, open)).rejects.toThrow(/acc-1  本店[\s\S]*acc-2  支店（友だち 0人・停止中）/);
    const summary = await runConnect({ cwd, d1: "fictional-d1", harnessUrl: "https://h.example.workers.dev", lineAccountId: "acc-2", env: { HARNESS_API_KEY: "wrong" } }, open);
    expect(summary).toMatchObject({ account: { id: "acc-2", isActive: false }, apiKey: "rejected" });
    await expect(runConnect({ cwd, d1: "fictional-d1", lineAccountId: "nope", env: {} }, open)).rejects.toThrow(/ありません/);
  });

  it("導入フォルダと違う移行先を指定したら、導入フォルダの ID・アカウント・Worker 名を混ぜない。URL の先に選んだアカウントが無ければ知らせる", async () => {
    const cwd = temporary();
    mkdirSync(join(cwd, "apps", "worker"), { recursive: true });
    writeFileSync(join(cwd, ".line-harness-config.json"), JSON.stringify({
      workerUrl: "https://installed.example.workers.dev", workerName: "installed", d1DatabaseName: "installed-d1",
      d1DatabaseId: "11111111-1111-1111-1111-111111111111", accountId: "0123456789abcdef0123456789abcdef",
    }));
    writeFileSync(join(cwd, "apps", "worker", "wrangler.toml"), "name = \"installed\"\n");
    const database = harnessDb([["acc-1", "本店", 1]]);
    // URL の先の L Harness は別のアカウントしか持っていない
    const other = { openDatabase: () => database, fetchImpl: async () => jsonResponse(200, { success: true, data: [{ id: "someone-else", name: "別", isActive: true }] }) };
    const summary = await runConnect({ cwd, d1: "other-d1", harnessUrl: "https://other.example.workers.dev", env: { HARNESS_API_KEY: "k" } }, other);
    expect(summary.apiKey).toBe("mismatch");
    const saved = loadConnection(cwd);
    expect(saved).toMatchObject({ d1_database_name: "other-d1", harness_url: "https://other.example.workers.dev", harness_worker_name: "other" });
    expect(saved.d1_database_id).toBeUndefined();
    expect(saved.cloudflare_account_id).toBeUndefined();
    expect(saved.harness_worker_dir).toBeUndefined();
    // 同じアカウント ID でも LINE のチャネル ID が違えば別の導入先
    const otherChannel = { openDatabase: () => database, fetchImpl: async () => jsonResponse(200, { success: true, data: [{ id: "acc-1", channelId: "another-channel", name: "本店", isActive: true }] }) };
    expect((await runConnect({ cwd, d1: "other-d1", harnessUrl: "https://other.example.workers.dev", env: { HARNESS_API_KEY: "k" } }, otherChannel)).apiKey).toBe("mismatch");
    // 導入フォルダに Worker の URL が無いまま --harness-url を指定したときも、導入フォルダの値は使わない
    writeFileSync(join(cwd, ".line-harness-config.json"), JSON.stringify({ workerName: "installed", d1DatabaseName: "installed-d1", d1DatabaseId: "11111111-1111-1111-1111-111111111111", accountId: "0123456789abcdef0123456789abcdef" }));
    await runConnect({ cwd, harnessUrl: "https://other.example.workers.dev", env: {} }, { openDatabase: () => database });
    expect(loadConnection(cwd).d1_database_id).toBeUndefined();
    expect(loadConnection(cwd).cloudflare_account_id).toBeUndefined();
    writeFileSync(join(cwd, ".line-harness-config.json"), JSON.stringify({
      workerUrl: "https://installed.example.workers.dev", workerName: "installed", d1DatabaseName: "installed-d1",
      d1DatabaseId: "11111111-1111-1111-1111-111111111111", accountId: "0123456789abcdef0123456789abcdef",
    }));
    // 導入フォルダと同じ移行先なら、導入フォルダの値を使い、アカウントが一致すれば ok
    const same = { openDatabase: () => database, fetchImpl: async () => jsonResponse(200, { success: true, data: [{ id: "acc-1", name: "本店", isActive: true }] }) };
    const matched = await runConnect({ cwd, d1: "installed-d1", harnessUrl: "https://installed.example.workers.dev/", env: { HARNESS_API_KEY: "k" } }, same);
    expect(matched.apiKey).toBe("ok");
    expect(loadConnection(cwd)).toMatchObject({ d1_database_id: "11111111-1111-1111-1111-111111111111", harness_worker_name: "installed", cloudflare_account_id: "0123456789abcdef0123456789abcdef" });
  });

  it("導入フォルダもデータベース名も無ければ案内して止まる", async () => {
    await expect(runConnect({ cwd: temporary(), harnessDir: "/nonexistent-harness", env: {} })).rejects.toThrow(/導入フォルダを読めませんでした/);
    expect(parseWranglerToml("name = \"w\"\n[[d1_databases]]\ndatabase_name = \"db\"\ndatabase_id = \"id\"\n[vars]\nWORKER_PUBLIC_URL = \"https://w.example.workers.dev\"\n"))
      .toEqual({ workerName: "w", d1DatabaseName: "db", d1DatabaseId: "id", workerUrl: "https://w.example.workers.dev" });
    // D1 の設定が複数あるときは最初の1つだけ使い、名前と ID を別の設定から混ぜない。壊れた TOML は読めなかった扱い
    expect(parseWranglerToml("name = \"w\"\n[[d1_databases]]\ndatabase_name = \"first\"\n[[d1_databases]]\ndatabase_name = \"second\"\ndatabase_id = \"second-id\"\n"))
      .toEqual({ workerName: "w", d1DatabaseName: "first" });
    expect(parseWranglerToml("name = \"w\"\nthis is not toml\n")).toEqual({});
  });
});

describe("enrich", () => {
  const connection = { harness_url: "https://h.example.workers.dev/", line_account_id: "acc 1" };

  it("offset 送りで最後まで呼び、件数を足し上げる", async () => {
    const urls: string[] = [];
    const pages = [{ processed: 20, updated: 19, notFound: 1, hasMore: true, nextOffset: 20 }, { processed: 5, updated: 5, hasMore: false }];
    const result = await runEnrich(connection, "key", {
      fetchImpl: async (input, init) => {
        urls.push(String(input));
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer key");
        return jsonResponse(200, { success: true, data: pages.shift() });
      },
    });
    expect(result).toEqual({ step: "enriched", finished: true, updated: 24, notFound: 1, errors: 0 });
    expect(urls[1]).toBe("https://h.example.workers.dev/api/admin/refresh-profiles?offset=20&limit=20&accountId=acc%201");
  });

  it("最初の回が全員エラーなら原因の調べ方を出して止まり、回数上限なら未完了を返す", async () => {
    await expect(runEnrich(connection, "key", { fetchImpl: async () => jsonResponse(200, { processed: 3, updated: 0, otherErrors: 3, hasMore: true }) }))
      .rejects.toThrow(/全員エラー[\s\S]*wrangler tail/);
    const unfinished = await runEnrich(connection, "key", { maxRounds: 2, fetchImpl: async () => jsonResponse(200, { processed: 1, updated: 1, hasMore: true }) });
    expect(unfinished.finished).toBe(false);
    await expect(runEnrich(connection, undefined)).rejects.toThrow(/HARNESS_API_KEY/);
    await expect(runEnrich({ harness_url: "http://h.example.workers.dev", line_account_id: "a" }, "key")).rejects.toThrow(/https/);
    expect(() => new HarnessApi("http://h.example.workers.dev", "key")).toThrow(/https/);
    expect(new HarnessApi("http://127.0.0.1:8787", "key").baseUrl).toBe("http://127.0.0.1:8787");
    // 200 でも JSON でない応答（HTML のページなど）は「0件」と読まずに止める
    const html = new HarnessApi("https://h.example.workers.dev", "key", async () => new Response("<!doctype html><html>login</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    await expect(html.lineAccounts()).rejects.toThrow(/JSON ではありません/);
  });
});

describe("richmenu", () => {
  function api(calls: string[], groupCheckFails = false) {
    return new HarnessApi("https://h.example.workers.dev", "key", async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method} ${url.replace("https://h.example.workers.dev", "")}`);
      if (groupCheckFails && /\/api\/rich-menu-groups\/g1$/.test(url)) return jsonResponse(500, { success: false, error: "temporary" });
      if (url.includes("/external")) {
        return jsonResponse(200, { success: true, data: { lineMenus: [
          { richMenuId: "richmenu-a", name: "メイン", isCurrentDefault: true, adminManaged: false },
          { richMenuId: "richmenu-b", name: "会員用", adminManaged: false },
          { richMenuId: "richmenu-c", name: "取り込み済み", adminManaged: true, adminInfo: { groupId: "g0", groupName: "既存" } },
        ] } });
      }
      if (url.includes("/import")) return url.includes("richmenu-b") ? jsonResponse(500, { success: false, error: "LINE API error" }) : jsonResponse(200, { success: true, data: { id: "g1" } });
      return jsonResponse(200, { success: true, data: { pages: [{ areas: [
        { actionType: "uri", actionData: { uri: "https://lstep.app/abc" } },
        { actionType: "uri", actionData: { uri: "https://example.com/" } },
        { actionType: "message", actionData: {} },
      ] }] } });
    });
  }

  it("下見では取り込まず、未取り込みのメニューだけ一覧にする", async () => {
    const calls: string[] = [];
    const result = await runRichMenu(api(calls), "acc-1", { dryRun: true });
    expect(result.menus.map((menu) => menu.status)).toEqual(["would-import", "would-import", "already"]);
    expect(calls).toEqual(["GET /api/rich-menu-groups/external?accountId=acc-1"]);
  });

  it("取り込み、Lステップ経由のリンクと失敗を知らせる。ID で絞れる", async () => {
    const calls: string[] = [];
    const result = await runRichMenu(api(calls), "acc-1");
    expect(result.menus[0]).toMatchObject({ status: "imported", isDefault: true, note: expect.stringContaining("ボタン 1個") });
    expect(result.menus[1]).toMatchObject({ status: "failed", note: expect.stringContaining("HTTP 500") });
    // 取り込んだ後のリンク確認に失敗したら「0件」ではなく「未確認」として知らせる
    const unverified = await runRichMenu(api([], true), "acc-1");
    expect(unverified.menus[0]).toMatchObject({ status: "imported", note: expect.stringContaining("確認できませんでした") });
    const only = await runRichMenu(api([]), "acc-1", { only: ["richmenu-b"] });
    expect(only.menus[0].status).toBe("skipped");
    expect(isLstepTrackingUrl("https://lstep.app/x")).toBe(true);
    expect(isLstepTrackingUrl("https://example.com/lstep.app")).toBe(false);
  });
});

describe("bridge コマンド", () => {
  const connection = {
    d1_database_name: "fictional-d1", harness_url: "https://fictional-harness.example.workers.dev", harness_worker_name: "fictional-harness",
    cloudflare_account_id: "0123456789abcdef0123456789abcdef", line_account_id: "acc-1",
  };

  it("配備前に L Harness で動いている自動の送信を確かめ、あれば止める", async () => {
    const cwd = temporary();
    const database = harnessDb([["acc-1", "本店", 1]]);
    database.db.prepare("INSERT INTO scenarios (id,name,trigger_type,is_active,line_account_id) VALUES ('s1','動いているシナリオ','friend_add',1,'acc-1')").run();
    const calls: string[][] = [];
    const run: CommandRunner = async (cmd, args) => { calls.push([cmd, ...args]); return ""; };
    await expect(runBridge(connection, { cwd, deploy: true, database, run, env: { LINE_CHANNEL_SECRET: "s" } })).rejects.toThrow(/シナリオ 1・自動応答 0/);
    expect(calls).toEqual([]);
  });

  it("秘密は引数でなく標準入力で渡し、転送先 URL は本人だけが読めるファイルに出す", async () => {
    const cwd = temporary();
    const database = harnessDb([["acc-1", "本店", 1]]);
    const calls: Array<{ args: string[]; input?: string; env?: Record<string, string> }> = [];
    const run: CommandRunner = async (_cmd, args, _cwd, input, env) => { calls.push({ args, input, env }); return ""; };
    const result = await runBridge(connection, {
      cwd, deploy: true, database, run,
      env: { LINE_CHANNEL_SECRET: "fictional-channel-secret", CLOUDFLARE_API_TOKEN: "cf-token", LSTEP2HARNESS_WRANGLER: "" },
      fetchImpl: async () => jsonResponse(200, { result: { subdomain: "fictional-sub" } }),
    });
    expect(result).toMatchObject({ deployed: true, urlComplete: true, activeAutomations: { scenarios: 0, autoReplies: 0, automations: 0 } });
    expect(calls.map((call) => call.args.slice(-3).join(" "))).toEqual(["--yes wrangler@4.150.0 deploy", "secret put LINE_CHANNEL_SECRET", "secret put PATH_TOKEN"]);
    expect(calls.flatMap((call) => call.args).join(" ")).not.toContain("fictional-channel-secret");
    expect(calls[1].input).toBe("fictional-channel-secret");
    expect(calls[2].input).toMatch(/^[A-Za-z0-9]{48}$/);
    expect(calls[0].env).toEqual({ CLOUDFLARE_API_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" });
    const urlFile = readFileSync(result.urlFile, "utf8");
    expect(urlFile).toMatch(new RegExp(`https://lstep2harness-bridge-[0-9a-f]{8}\\.fictional-sub\\.workers\\.dev/lstep/line/${calls[2].input}`));
    expect(statSync(result.urlFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(cwd, ".lstep2harness", "bridge.json")).mode & 0o777).toBe(0o600);
    const toml = readFileSync(join(cwd, "bridge", "wrangler.toml"), "utf8");
    expect(toml).toContain('service = "fictional-harness"');
    expect(toml).toContain('account_id = "0123456789abcdef0123456789abcdef"');
    expect(toml).not.toContain(calls[2].input!);
    // 2回目は同じ受信パスを使う
    const again = await runBridge(connection, { cwd, database, run, env: {} });
    expect(readFileSync(again.urlFile, "utf8")).toContain(calls[2].input!);
  });

  it("wrangler login で配備したときは、deploy の表示から転送先 URL を完成させる", async () => {
    const cwd = temporary();
    const database = harnessDb([["acc-1", "本店", 1]]);
    const named = { ...connection, bridge_worker_name: "my-bridge" };
    const run: CommandRunner = async (_cmd, args) => (args.includes("deploy") ? "Uploaded my-bridge\n  https://my-bridge.fictional-sub2.workers.dev\n" : "");
    const result = await runBridge(named, { cwd, deploy: true, database, run, env: { LINE_CHANNEL_SECRET: "s" } });
    expect(result.urlComplete).toBe(true);
    expect(readFileSync(result.urlFile, "utf8")).toContain("https://my-bridge.fictional-sub2.workers.dev/lstep/line/");
    const notDeployed = await runBridge(connection, { cwd: temporary(), database, env: {} });
    expect(notDeployed.urlComplete).toBe(false);
    expect(readFileSync(notDeployed.urlFile, "utf8")).toContain("置き換えてください");
  });

  it("このリポジトリのフォルダで動かしたときは、同梱の雛形を自分自身へコピーしようとして止まらない", () => {
    const packaged = fileURLToPath(new URL("../bridge", import.meta.url));
    const before = readFileSync(join(packaged, "src", "index.ts"), "utf8");
    expect(() => syncBridgeTemplate(packaged)).not.toThrow();
    expect(() => syncBridgeTemplate(join(packaged, "..", "bridge"))).not.toThrow();
    expect(readFileSync(join(packaged, "src", "index.ts"), "utf8")).toBe(before);
  });

  it("ブリッジの Worker のソースは、ツールを更新したら配備し直すだけで新しくなる", async () => {
    const cwd = temporary();
    const database = harnessDb([["acc-1", "本店", 1]]);
    await runBridge(connection, { cwd, database, env: {} });
    const worker = join(cwd, "bridge", "src", "index.ts");
    writeFileSync(worker, "// 古い版のまま\n");
    await runBridge(connection, { cwd, database, env: {} });
    expect(readFileSync(worker, "utf8")).toBe(readFileSync(new URL("../bridge/src/index.ts", import.meta.url), "utf8"));
  });

  it("重複排除（KV）の設定は TOML として読んで引き継ぐ（空白入りの表記も読み、コメントの見本は拾わず、壊れていれば止める）", () => {
    const base = "name = \"b\"\n[vars]\nX = \"1\"\n";
    expect(keptKvBlock(base)).toBe("");
    expect(keptKvBlock(base + "\n[[ kv_namespaces ]]\nbinding = \"DEDUP\"\nid = \"spaced-kv\"\n")).toContain('id = "spaced-kv"');
    expect(keptKvBlock(base + "# [[kv_namespaces]]\n# binding = \"DEDUP\"\n# id = \"commented-kv\"\n")).toBe("");
    expect(() => keptKvBlock("this is = not toml = at all")).toThrow(/TOML として読めませんでした/);
  });

  it("別の移行先向けに作ったブリッジは配備し直さない。重複排除の設定は引き継ぐ", async () => {
    const cwd = temporary();
    const database = harnessDb([["acc-1", "本店", 1], ["acc-2", "支店", 1]]);
    const first = await runBridge(connection, { cwd, database, env: {} });
    expect(first.deployed).toBe(false);
    const toml = join(cwd, "bridge", "wrangler.toml");
    writeFileSync(toml, readFileSync(toml, "utf8") + "\n[[kv_namespaces]]\nbinding = \"DEDUP\"\nid = \"fictional-kv\"\n");
    await runBridge(connection, { cwd, database, env: {} });
    expect(readFileSync(toml, "utf8")).toContain('id = "fictional-kv"');
    await expect(runBridge({ ...connection, line_account_id: "acc-2" }, { cwd, database, deploy: true, run: async () => "", env: { LINE_CHANNEL_SECRET: "s" } }))
      .rejects.toThrow(/別の移行先/);
    // 別のフォルダのブリッジは別の名前になる
    const other = await runBridge(connection, { cwd: temporary(), database, env: {} });
    expect(readFileSync(other.urlFile, "utf8")).not.toBe(readFileSync(first.urlFile, "utf8"));
  });

  it("漏れた転送 URL は、同じ Worker のままトークンを入れ替えて無効にする", async () => {
    const cwd = temporary();
    const database = harnessDb([["acc-1", "本店", 1]]);
    const calls: Array<{ args: string[]; input?: string }> = [];
    const run: CommandRunner = async (_cmd, args, _cwd, input) => { calls.push({ args, input }); return ""; };
    const env = { LINE_CHANNEL_SECRET: "s" };
    const first = await runBridge(connection, { cwd, deploy: true, database, run, env });
    const before = readFileSync(first.urlFile, "utf8");
    const state = JSON.parse(readFileSync(join(cwd, ".lstep2harness", "bridge.json"), "utf8"));
    await expect(runBridge(connection, { cwd, rotateToken: true, database, run, env })).rejects.toThrow(/--deploy/);
    calls.length = 0;
    const rotated = await runBridge(connection, { cwd, deploy: true, rotateToken: true, database, run, env });
    const after = JSON.parse(readFileSync(join(cwd, ".lstep2harness", "bridge.json"), "utf8"));
    expect(after.worker_name).toBe(state.worker_name);
    expect(after.path_token).not.toBe(state.path_token);
    expect(calls.find((call) => call.args.includes("PATH_TOKEN"))?.input).toBe(after.path_token);
    expect(readFileSync(rotated.urlFile, "utf8")).not.toBe(before);
  });

  it("Windows では本番へつなぐ操作を断る", () => {
    expect(() => assertHarnessPlatform("win32")).toThrow(/WSL/);
    expect(() => assertHarnessPlatform("darwin")).not.toThrow();
  });

  it("チャネルシークレットが無ければ配備しない", async () => {
    const database = harnessDb([["acc-1", "本店", 1]]);
    await expect(runBridge(connection, { cwd: temporary(), deploy: true, database, run: async () => "", env: {} })).rejects.toThrow(/LINE_CHANNEL_SECRET/);
  });
});
