import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { LocalD1 } from "../dist/d1/local.js";
import { writePrivateFile } from "../dist/util.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = process.argv[2];
if (!destination) throw new Error("合成データの試験結果を保存するリポジトリ外フォルダを指定してください");
mkdirSync(resolve(destination), { recursive: true });
const directory = mkdtempSync(join(resolve(destination), "synthetic-smoke-"));
const snapshot = join(directory, "snapshot");
const out = join(directory, "out");
const db = join(directory, "test.sqlite");
const cli = join(root, "dist/cli.js");
const fixture = join(root, "test/fixtures/lstep-browser.json");
const lineAccountId = "fictional-smoke-target";

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || "CLIの実行に失敗しました");
  return result.stdout;
}

run(["extract", "--route", "browser", "--file", fixture, "--account-id", "fictional-lstep-source", "--output", snapshot]);
run(["plan", "--snapshot", snapshot, "--out", out, "--line-account-id", lineAccountId]);
const database = new LocalD1(db);
database.loadSchema(join(root, "schema/line-harness-bootstrap.sql"));
database.db.prepare("INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret,is_active) VALUES (?,?,?,?,?,0)")
  .run(lineAccountId, "fictional-local-channel", "架空データだけのCLI試験", "not-a-live-token", "not-a-live-secret");
database.close();
const first = JSON.parse(run(["apply", "--out", out, "--db", db, "--allow-partial"]));
const second = JSON.parse(run(["apply", "--out", out, "--db", db, "--allow-partial"]));
const verified = JSON.parse(run(["verify", "--out", out, "--db", db]));
assert.equal(first.checked, second.checked);
assert.equal(first.checked, verified.checked);
const inspected = new LocalD1(db);
const counts = {
  friends: inspected.count("friends"), tags: inspected.count("tags"),
  forms: inspected.count("forms"), answers: inspected.count("form_submissions"),
  messages: inspected.count("messages_log"), scenarios: inspected.count("scenarios"),
};
inspected.close();
assert.equal(counts.friends, 2);
assert.equal(counts.forms, 1);
assert.equal(counts.answers, 2);
assert.equal(counts.messages, 5);
const report = {
  testedAt: new Date().toISOString(), syntheticDataOnly: true, liveLstepTested: false,
  commands: ["extract(browser)", "plan", "apply", "apply(repeat)", "verify"],
  ...verified, counts,
  sourceCoverage: JSON.parse(readFileSync(join(snapshot, "coverage.json"), "utf8")),
};
writePrivateFile(join(directory, "verification.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ directory, syntheticDataOnly: true, ...verified, counts }, null, 2));
