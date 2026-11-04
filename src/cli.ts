#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { LstepApiSource } from "./lstep/api.js";
import { importBrowserExport } from "./lstep/browser.js";
import { shellQuote } from "./util.js";
import { TUTORIAL_CHAPTERS, tutorialMessage, tutorialUrl, type TutorialChapter } from "./guide.js";

const program = new Command().name("lstep2harness").version("0.1.1")
  .description("Lステップのデータを L Harness へ移行します。投入は確認のあとだけ行い、移したシナリオ・自動応答・フォームは停止のまま入れます。");

program.command("guide [chapter]")
  .description("人が行う設定・ログインの案内を表示します（ローカルの動画ページ。設定やログインは変更しません）")
  .action((chapter?: string) => {
    if (chapter && !TUTORIAL_CHAPTERS.includes(chapter as TutorialChapter)) {
      throw new Error(`案内の章は次から選んでください: ${TUTORIAL_CHAPTERS.join(", ")}`);
    }
    console.log(tutorialUrl(chapter as TutorialChapter | undefined));
  });

// 起動した場所の .env（LSTEP_API_TOKEN など）を読む。値は表示しない
const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) {
  // トークンが入るファイルなので、ほかの利用者から読めるなら知らせる（勝手に権限は変えない）
  if (process.platform !== "win32" && (statSync(envPath).mode & 0o077) !== 0) {
    console.error("注意: .env がほかの利用者からも読める権限です。`chmod 600 .env` で自分だけにしてください。");
  }
  try { process.loadEnvFile(envPath); }
  catch { console.error("起動した場所の .env を読み取れませんでした。設定を確認してください。"); process.exit(1); }
}

/** --db（手元の試験用DB）か --harness（本番の L Harness）のどちらか1つ */
function targetMode(options: { db?: string; harness?: boolean }): "local" | "harness" {
  if (options.harness && options.db) throw new Error("--db と --harness は同時に指定できません");
  if (options.harness) return "harness";
  if (!options.db) throw new Error("移行先を --db（手元の試験用DB）か --harness（connect で設定した本番の L Harness）で指定してください");
  return "local";
}

async function openHarness(local: boolean) {
  const { loadConnection, openD1, targetKey } = await import("./harness/connection.js");
  const connection = loadConnection();
  return { connection, database: openD1(connection, local), key: targetKey(connection, local) };
}

program.command("connect")
  .description("本番の L Harness へのつなぎ先を確かめて lstep2harness.config.json に保存します（L Harness には書き込みません）")
  .option("--harness-dir <dir>", "create-line-harness で入れたフォルダ（省略時は ~/.line-harness などを探す）")
  .option("--d1 <name>", "L Harness の D1 データベース名（導入フォルダが無いとき）")
  .option("--harness-url <url>", "L Harness の Worker の URL（導入フォルダから読めないとき）")
  .option("--line-account-id <id>", "移行先の L Harness アカウントID（複数あるとき）")
  .option("--d1-local", "wrangler の手元のD1（--local）につなぐ（L Harness を手元で動かして試すとき）", false)
  .action(async options => {
    const { runConnect } = await import("./commands/connect.js");
    const result = await runConnect({
      harnessDir: options.harnessDir, d1: options.d1, harnessUrl: options.harnessUrl,
      lineAccountId: options.lineAccountId, local: options.d1Local,
    });
    console.log(JSON.stringify(result, null, 2));
    if (["missing", "rejected"].includes(result.apiKey)) console.error(tutorialMessage("save-credentials"));
  });

program.command("migrate")
  .description("Lステップから取り出し、移行計画を作ります（投入は確認後に next のコマンドで行います。ログイン以外は自動）")
  .option("--db <file>", "移行先の試験用DB（init-db で作ったもの）")
  .option("--line-account-id <id>", "試験用DBの移行先アカウントID（--db のとき）")
  .option("--harness", "connect で設定した本番の L Harness へ移す", false)
  .option("--d1-local", "--harness のとき、wrangler の手元のD1（--local）を使う", false)
  .option("--route <route>", "auto（API トークンがあれば api。無ければ止まる）、api、browser、hybrid（公式API＋管理画面の設定。管理画面の利用は了解を得てから）", "auto")
  .option("--yes", "計画を作ったあと、確認なしで投入まで進める", false)
  .option("--allow-partial", "移せないもの・取れないものがあっても、移せる範囲だけ投入する", false)
  .option("--login-timeout <minutes>", "ログインを待つ時間（分）", "15")
  .action(async options => {
    if (!["auto", "api", "browser", "hybrid"].includes(options.route)) throw new Error("取得方法は auto・api・browser・hybrid から選んでください");
    const minutes = Number(options.loginTimeout);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 120) throw new Error("--login-timeout は 1〜120 分で指定してください");
    const mode = targetMode(options);
    if (mode === "local" && !options.lineAccountId) throw new Error("--db のときは --line-account-id も指定してください");
    const harness = mode === "harness" ? await openHarness(options.d1Local) : null;
    const controller = new AbortController();
    const stop = () => {
      if (controller.signal.aborted) process.exit(130);
      console.error("中止しています（Chrome を閉じます）…");
      controller.abort();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const { collectAndPlan } = await import("./collect/run.js");
    const { DATA_ROOT } = await import("./collect/data-root.js");
    const summary = await collectAndPlan({
      route: options.route, dataRoot: DATA_ROOT, apiToken: process.env.LSTEP_API_TOKEN,
      target: harness
        ? { harness: harness.database, key: harness.key, lineAccountId: harness.connection.line_account_id }
        : { dbPath: resolve(options.db), lineAccountId: options.lineAccountId },
      loginTimeoutMs: minutes * 60_000, signal: controller.signal, log: message => console.error(message),
    });
    const destination = harness ? ["--harness", ...(options.d1Local ? ["--d1-local"] : [])] : ["--db", resolve(options.db)];
    const nextArgs = ["apply", "--out", summary.planDirectory, ...destination, ...(summary.partial ? ["--allow-partial"] : [])];
    const applyCommand = ["node", "dist/cli.js", ...nextArgs].map((part, index) => index < 3 || part.startsWith("--") ? part : shellQuote(part)).join(" ");
    if (!options.yes) {
      console.log(JSON.stringify({ step: "planned", ...summary, next: applyCommand, nextArgs }, null, 2));
      console.error("計画を作りました（まだ投入していません）。report.md と上の内容を確認してから、next のコマンドで投入・照合します。");
      return;
    }
    if (summary.partial && !options.allowPartial) {
      console.log(JSON.stringify({ step: "planned", ...summary, next: applyCommand, nextArgs }, null, 2));
      throw new Error("移せないもの・取れないものがあります。内容を確認して、--allow-partial を付けて投入してください");
    }
    if (harness) {
      const { applyHarness } = await import("./harness/remote.js");
      // 取得は終わったので、ここからの Ctrl+C は「今のファイルが終わったら止める」。もう一度押すと直ちに終わる
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      const applying = new AbortController();
      const stopApply = () => {
        if (applying.signal.aborted) process.exit(130);
        console.error("投入を中止します。流している途中のファイルが終わったところで止まります（続きは同じ apply で流せます）。もう一度押すと直ちに終了します…");
        applying.abort();
      };
      process.on("SIGINT", stopApply);
      process.on("SIGTERM", stopApply);
      const result = await applyHarness(summary.planDirectory, harness.database, {
        key: harness.key, lineAccountId: harness.connection.line_account_id, allowPartial: options.allowPartial, log: message => console.error(message),
        replanHint: replanHint(join(summary.runDirectory, "snapshot"), options.d1Local), signal: applying.signal,
      });
      console.log(JSON.stringify({ step: "applied", ...summary, verification: result }, null, 2));
      console.error(tutorialMessage("migration-review"));
      return;
    }
    const { applyLocal } = await import("./pipeline.js");
    const result = applyLocal(summary.planDirectory, resolve(options.db), options.allowPartial);
    console.log(JSON.stringify({ step: "applied", ...summary, verification: result }, null, 2));
  });

/** 本番の状態に合わせて計画を作り直すコマンド（同じ取得結果から） */
function replanHint(snapshotDir: string, local: boolean): string {
  const out = `${snapshotDir.replace(/[\\/]snapshot$/, "")}/plan-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
  return `作り直すコマンド: node dist/cli.js plan --snapshot ${shellQuote(snapshotDir)} --out ${shellQuote(out)} --harness${local ? " --d1-local" : ""}（表示された nextArgs で投入）`;
}

program.command("init-db")
  .description("移行の試験用データベースを新しく作ります（L Harness と同じ形・停止中の移行先アカウント1つ）")
  .requiredOption("--db <file>", "新しく作るデータベースのファイル")
  .requiredOption("--line-account-id <id>", "移行先アカウントID（任意の名前でよい）")
  .action(async options => {
    const { createTestDatabase } = await import("./init-db.js");
    createTestDatabase(options.db, options.lineAccountId);
    console.log(`試験用データベースを作りました: ${resolve(options.db)}（移行先アカウントID: ${options.lineAccountId}）`);
  });

program.command("doctor").requiredOption("--account-id <id>", "移行元の識別ラベル")
  .action(async options => {
    await new LstepApiSource({ token: process.env.LSTEP_API_TOKEN ?? "", accountId: options.accountId }).doctor();
    console.log("公式APIの閲覧権限を確認しました（アカウント一致・全件取得の確認は別途必要）。");
  });

program.command("extract").requiredOption("--route <route>", "api または browser（hybrid は migrate --route hybrid を使用）")
  .requiredOption("--account-id <id>", "確認済みの移行元識別ラベル")
  .requiredOption("--output <directory>", "新規スナップショット保存先")
  .option("--file <file>", "画面取得JSON（--route browser のとき必須）")
  .option("--form-ids <ids>", "公式APIで回答を取得するフォームID（カンマ区切り）")
  .action(async options => {
    if (!["api", "browser"].includes(options.route)) throw new Error("extract の --route は api または browser です。hybrid は migrate --route hybrid を使ってください");
    if (options.route === "browser" && !options.file) throw new Error("--route browserには--fileで画面取得JSONを指定してください");
    const source = options.route === "api"
      ? await new LstepApiSource({
        token: process.env.LSTEP_API_TOKEN ?? "", accountId: options.accountId,
        formIds: options.formIds ? String(options.formIds).split(",").map(Number) : [],
      }).extract()
      : importBrowserExport(JSON.parse(readFileSync(options.file, "utf8")));
    if (source.account.id !== options.accountId) throw new Error("画面取得ファイルのアカウントIDが指定と一致しません");
    const { writeSourceSnapshot } = await import("./pipeline.js");
    writeSourceSnapshot(source, options.output);
    console.log(`保存済み: 友だち${source.resources.friends.length}人。取得範囲はcoverage.jsonを確認してください。`);
  });

program.command("plan").requiredOption("--snapshot <directory>")
  .requiredOption("--out <directory>")
  .option("--line-account-id <id>", "手元の試験用DBの移行先アカウントID")
  .option("--harness", "connect で設定した本番の L Harness の今の状態に合わせて作る", false)
  .option("--d1-local", "--harness のとき、wrangler の手元のD1（--local）を使う", false)
  .action(async options => {
    const { createPlan } = await import("./pipeline.js");
    if (options.harness) {
      const { readPlanTarget } = await import("./harness/remote.js");
      const { readJsonFile } = await import("./util.js");
      const harness = await openHarness(options.d1Local);
      const source = readJsonFile<{ resources: { friends: Array<{ row: { line_friend_id: string } }> } }>(join(options.snapshot, "source.json"));
      if (!source) throw new Error("Lステップの取得結果がありません");
      const target = await readPlanTarget(harness.database, harness.key, source.resources.friends.map(friend => friend.row.line_friend_id));
      const manifest = createPlan(options.snapshot, options.out, harness.connection.line_account_id, target);
      const partial = readJsonFile<{ partial?: boolean }>(join(options.out, "expected.json"))?.partial === true;
      const nextArgs = ["apply", "--out", resolve(options.out), "--harness", ...(options.d1Local ? ["--d1-local"] : []), ...(partial ? ["--allow-partial"] : [])];
      console.log(JSON.stringify({ counts: manifest.counts, warnings: manifest.warnings, nextArgs }, null, 2));
      return;
    }
    if (!options.lineAccountId) throw new Error("--line-account-id か --harness を指定してください");
    const manifest = createPlan(options.snapshot, options.out, options.lineAccountId);
    console.log(JSON.stringify({ counts: manifest.counts, warnings: manifest.warnings }, null, 2));
  });

program.command("apply").requiredOption("--out <directory>")
  .option("--db <file>", "手元の試験用DB")
  .option("--harness", "connect で設定した本番の L Harness へ投入する", false)
  .option("--d1-local", "--harness のとき、wrangler の手元のD1（--local）を使う", false)
  .option("--allow-partial", "未対応項目をreport.mdで確認したうえで部分移行する", false)
  .option("--allow-profile-updates", "--harness の照合でプロフィール4項目の更新を許容し、差分を別枠で報告する", false)
  .action(async options => {
    if (targetMode(options) === "harness") {
      const { applyHarness } = await import("./harness/remote.js");
      const harness = await openHarness(options.d1Local);
      const snapshot = join(resolve(options.out), "..", "snapshot");
      const applying = new AbortController();
      const stopApply = () => {
        if (applying.signal.aborted) process.exit(130);
        console.error("投入を中止します。流している途中のファイルが終わったところで止まります（続きは同じ apply で流せます）。もう一度押すと直ちに終了します…");
        applying.abort();
      };
      process.on("SIGINT", stopApply);
      process.on("SIGTERM", stopApply);
      const result = await applyHarness(resolve(options.out), harness.database, {
        key: harness.key, lineAccountId: harness.connection.line_account_id, allowPartial: options.allowPartial, allowProfileUpdates: options.allowProfileUpdates, log: message => console.error(message), signal: applying.signal,
        replanHint: existsSync(snapshot) ? replanHint(snapshot, options.d1Local) : "plan --snapshot <取得結果> --out <新しいフォルダ> --harness で作り直してください",
      });
      console.log(JSON.stringify({ step: "applied", ...result }, null, 2));
      console.error(tutorialMessage("migration-review"));
      return;
    }
    if (options.allowProfileUpdates) throw new Error("--allow-profile-updates は --harness のときだけ使えます");
    const { applyLocal } = await import("./pipeline.js");
    console.log(JSON.stringify(applyLocal(options.out, options.db, options.allowPartial)));
  });

program.command("verify").requiredOption("--out <directory>")
  .option("--db <file>", "手元の試験用DB")
  .option("--harness", "connect で設定した本番の L Harness を照合する", false)
  .option("--d1-local", "--harness のとき、wrangler の手元のD1（--local）を使う", false)
  .option("--allow-profile-updates", "--harness の照合でプロフィール4項目の更新を許容し、差分を別枠で報告する", false)
  .action(async options => {
    if (targetMode(options) === "harness") {
      const { verifyHarness } = await import("./harness/remote.js");
      const harness = await openHarness(options.d1Local);
      console.log(JSON.stringify(await verifyHarness(resolve(options.out), harness.database, { allowProfileUpdates: options.allowProfileUpdates, lineAccountId: harness.connection.line_account_id })));
      return;
    }
    if (options.allowProfileUpdates) throw new Error("--allow-profile-updates は --harness のときだけ使えます");
    const { verifyLocal } = await import("./pipeline.js");
    console.log(JSON.stringify(verifyLocal(options.out, options.db)));
  });

program.command("richmenu")
  .description("LINE に登録済みのリッチメニューを L Harness の管理画面に取り込みます（LINE 上の表示は変わりません）")
  .option("--dry-run", "取り込まずに一覧だけ出す", false)
  .option("--rich-menu-id <ids>", "取り込むメニューのID（カンマ区切り。省略時は未取り込みのもの全部）")
  .action(async options => {
    const { loadConnection } = await import("./harness/connection.js");
    const { HarnessApi } = await import("./harness/api.js");
    const { runRichMenu } = await import("./commands/richmenu.js");
    const connection = loadConnection();
    if (!connection.harness_url) throw new Error("L Harness の URL がつなぎ先にありません。connect を --harness-url 付きでやり直してください");
    const api = new HarnessApi(connection.harness_url, process.env.HARNESS_API_KEY ?? "");
    console.log(JSON.stringify(await runRichMenu(api, connection.line_account_id, {
      dryRun: options.dryRun, only: options.richMenuId ? String(options.richMenuId).split(",").map(id => id.trim()).filter(Boolean) : undefined,
    }), null, 2));
  });

program.command("enrich")
  .description("移した友だちのアイコン・表示名を LINE から取り直します（L Harness の機能を呼ぶだけ）")
  .option("--limit <n>", "1回に取り直す人数", "20")
  .action(async options => {
    const { loadConnection } = await import("./harness/connection.js");
    const { runEnrich } = await import("./commands/enrich.js");
    const result = await runEnrich(loadConnection(), process.env.HARNESS_API_KEY, { limit: Number(options.limit), log: message => console.error(message) });
    console.log(JSON.stringify(result, null, 2));
    if (!result.finished) throw new Error("回数の上限でまだ残りがあります。--limit を増やしてもう一度 enrich を実行してください");
  });

program.command("bridge")
  .description("並行運用ブリッジ（Lステップの Webhook転送 → L Harness）を用意し、--deploy で Cloudflare に配備します")
  .option("--deploy", "Cloudflare に配備して秘密を登録する", false)
  .option("--accept-active", "L Harness で動いている自動の送信があっても配備する", false)
  .option("--rotate-token", "転送先 URL のトークンを作り直す（URL が漏れたとき。--deploy と一緒に）", false)
  .option("--d1-local", "動いている自動の送信の確認に wrangler の手元のD1（--local）を使う", false)
  .action(async options => {
    const { runBridge } = await import("./commands/bridge.js");
    if (options.deploy && options.d1Local) throw new Error("--deploy は本番の D1 で動いている自動の送信を確かめてから行います。--d1-local とは一緒に使えません");
    const harness = await openHarness(options.d1Local);
    console.log(JSON.stringify(await runBridge(harness.connection, {
      deploy: options.deploy, acceptActive: options.acceptActive, rotateToken: options.rotateToken, database: harness.database,
    }), null, 2));
  });

program.parseAsync().catch(error => {
  console.error(error instanceof SyntaxError ? "JSONファイルの形式が不正です（内容は表示しません）"
    : error instanceof Error ? error.message : "処理に失敗しました");
  process.exitCode = 1;
});
