import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importBrowserExport } from "../src/lstep/browser.js";
import { createPlan, writeSourceSnapshot } from "../src/pipeline.js";
import type { SourceExport } from "../src/lstep/export.js";

const DIRECTORIES: string[] = [];
afterEach(() => { for (const directory of DIRECTORIES.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(): SourceExport {
  return importBrowserExport(JSON.parse(readFileSync(new URL("fixtures/lstep-browser.json", import.meta.url), "utf8")));
}

function plan(source: SourceExport) {
  const directory = mkdtempSync(join(tmpdir(), "lstep-integrity-"));
  DIRECTORIES.push(directory);
  writeSourceSnapshot(source, join(directory, "snapshot"));
  const manifest = createPlan(join(directory, "snapshot"), join(directory, "plan"), "fictional-target");
  const expected = JSON.parse(readFileSync(join(directory, "plan", "expected.json"), "utf8")) as { rows: Array<{ table: string; values: Record<string, unknown> }> };
  return { manifest, rows: expected.rows };
}

describe("migration keeps source content", () => {
  it("does not drop answers when two questions share the same title", () => {
    const source = fixture();
    const form = source.resources.forms[0];
    const fields = form.pages![0].fields!;
    fields[1] = { ...fields[1], title: fields[0].title };
    const response = source.resources.formResponses[String(form.id)][0];
    response.answers[1] = { ...response.answers[1], name: response.answers[0].name };
    const { manifest, rows } = plan(source);
    const submission = rows.find(row => row.table === "form_submissions" && String(row.values.data).includes("_unmatched_answers"));
    expect(submission).toBeDefined();
    const data = JSON.parse(String(submission!.values.data)) as { _unmatched_answers: Array<{ name: string; value: unknown }> };
    expect(data._unmatched_answers.map(answer => answer.value)).toEqual(expect.arrayContaining([response.answers[0].value, response.answers[1].value]));
    expect(manifest.reports.form_submissions.level).toBe("partial");
    expect(manifest.reports.form_submissions.notes.join()).toContain("_unmatched_answers");
  });

  it("keeps placeholder-like text in conversation history as written", () => {
    const source = fixture();
    const conversation = source.resources.friends[0].conversation!;
    conversation.messages[1] = { ...conversation.messages[1], content: "{name}さんへ [NAME] のままで" };
    const { rows } = plan(source);
    const contents = rows.filter(row => row.table === "messages_log").map(row => row.values.content);
    expect(contents).toContain("{name}さんへ [NAME] のままで");
  });
});

describe("migration keeps source content (edge cases)", () => {
  it("does not cross-match answers when an excluded question shares a title with a migrated one", () => {
    const source = fixture();
    const form = source.resources.forms[0];
    const fields = form.pages![1].fields!;
    const file = fields.find(field => field.type === "file")!;
    const text = form.pages![0].fields![0];
    file.title = text.title;
    const response = source.resources.formResponses[String(form.id)][0];
    const fileAnswer = response.answers.find(answer => answer.type === "file")!;
    fileAnswer.name = text.title!;
    const { rows } = plan(source);
    const data = JSON.parse(String(rows.find(row => row.table === "form_submissions")!.values.data)) as Record<string, unknown>;
    expect(Object.values(data)).not.toContain(fileAnswer.value);
    expect((data._unmatched_answers as Array<{ value: unknown }>).map(answer => answer.value)).toContain(fileAnswer.value);
  });

  it("keeps answers for questions titled like object internals or the fallback key", () => {
    const source = fixture();
    const form = source.resources.forms[0];
    form.pages![0].fields![0].title = "__proto__";
    form.pages![0].fields![1].title = "_unmatched_answers";
    const response = source.resources.formResponses[String(form.id)][0];
    response.answers[0].name = "__proto__";
    response.answers[1].name = "_unmatched_answers";
    const { rows } = plan(source);
    const stored = String(rows.find(row => row.table === "form_submissions")!.values.data);
    expect(stored).toContain(JSON.stringify(response.answers[0].value));
    expect(stored).toContain(JSON.stringify(response.answers[1].value));
  });

  it("keeps a friend's JSON-looking text and an image's description text", () => {
    const source = fixture();
    const conversation = source.resources.friends[0].conversation!;
    conversation.messages[1] = { ...conversation.messages[1], content: '{"scenario_name":"自分で書いた文字"}' };
    conversation.messages.push({ message_id: 999, sender: "bot", message_type: "image", content: "画像を送信しました", sent_at: "2026-10-24T03:00:00.000Z" });
    const { rows } = plan(source);
    const contents = rows.filter(row => row.table === "messages_log").map(row => row.values.content);
    expect(contents).toContain('{"scenario_name":"自分で書いた文字"}');
    expect(contents).toContain("[画像] 画像を送信しました");
  });
});

describe("migration keeps source content (excluded questions and folders)", () => {
  it("does not hand a hidden question's answer to a visible question with the same title", () => {
    const raw = JSON.parse(readFileSync(new URL("fixtures/lstep-browser.json", import.meta.url), "utf8"));
    const source = importBrowserExport(raw);
    const form = source.resources.forms[0];
    form.excluded_field_titles = [form.pages![0].fields![0].title!];
    const response = source.resources.formResponses[String(form.id)][0];
    const hiddenAnswer = { ...response.answers[0], value: "非表示の設問への回答" };
    response.answers.unshift(hiddenAnswer);
    const { rows } = plan(source);
    const data = JSON.parse(String(rows.find(row => row.table === "form_submissions")!.values.data)) as Record<string, unknown>;
    expect(Object.values(data)).not.toContain("非表示の設問への回答");
    expect((data._unmatched_answers as Array<{ value: unknown }>).map(answer => answer.value)).toContain("非表示の設問への回答");
  });

  it("keeps sticker and location descriptions as text", () => {
    const source = fixture();
    const conversation = source.resources.friends[0].conversation!;
    conversation.messages.push(
      { message_id: 991, sender: "friend", message_type: "sticker", content: "スタンプを送信しました", sent_at: "2026-10-24T03:00:00.000Z" },
      { message_id: 992, sender: "friend", message_type: "location", content: "架空駅", sent_at: "2026-10-24T03:01:00.000Z" },
    );
    const { rows } = plan(source);
    const contents = rows.filter(row => row.table === "messages_log").map(row => row.values.content);
    expect(contents).toContain("[スタンプ] スタンプを送信しました");
    expect(contents).toContain("[位置情報] 架空駅");
  });

  it("does not change the permissions of the folder that holds the snapshot", async () => {
    const { chmodSync, statSync } = await import("node:fs");
    const parent = mkdtempSync(join(tmpdir(), "lstep-parent-"));
    DIRECTORIES.push(parent);
    chmodSync(parent, 0o755);
    writeSourceSnapshot(fixture(), join(parent, "run-01"));
    expect(statSync(parent).mode & 0o777).toBe(0o755);
    expect(statSync(join(parent, "run-01")).mode & 0o777).toBe(0o700);
  });

  it("does not let an answer slip into a field whose generated name happens to match", () => {
    const source = fixture();
    const form = source.resources.forms[0];
    const visible = form.pages![0].fields![0];
    visible.title = "A ";
    form.excluded_field_titles = ["A"];
    const response = source.resources.formResponses[String(form.id)][0];
    response.answers[0] = { ...response.answers[0], name: "A ", value: "見える設問への回答" };
    response.answers.unshift({ name: "A", type: "text", value: "非表示の設問への回答" });
    const { rows } = plan(source);
    const data = JSON.parse(String(rows.find(row => row.table === "form_submissions")!.values.data)) as Record<string, unknown>;
    expect(Object.values(data)).toContain("見える設問への回答");
    expect(Object.values(data)).not.toContain("非表示の設問への回答");
    expect((data._unmatched_answers as Array<{ value: unknown }>).map(answer => answer.value)).toContain("非表示の設問への回答");
  });

  it("keeps a handling status apart from a normal tag that already uses the same name", () => {
    const source = fixture();
    source.resources.tags.push({ id: 99, name: "対応:未対応" });
    source.resources.handlingStatuses = [{ id: 1, name: "未対応" }];
    const { rows } = plan(source);
    const names = rows.filter(row => row.table === "tags").map(row => String(row.values.name));
    expect(names).toContain("対応:未対応");
    expect(names).toContain("対応:未対応 (2)");
    expect(new Set(names).size).toBe(names.length);
  });

  it("marks an answer in an unknown shape instead of storing it as empty", () => {
    const raw = JSON.parse(readFileSync(new URL("fixtures/lstep-browser.json", import.meta.url), "utf8"));
    const response = Object.values(raw.data.formResponses as Record<string, Array<{ answers: Array<{ value: unknown }> }>>)[0][0];
    response.answers[0].value = { mystery: "形式が分からない値" };
    const source = importBrowserExport(raw);
    expect(Object.values(source.resources.formResponses)[0][0].answers[0].value).toEqual({ unsupported: true });
    expect(source.coverage.formResponses.status).toBe("partial");
    expect(source.coverage.formResponses.note).toContain("形式が未対応の回答1件");
  });
});
