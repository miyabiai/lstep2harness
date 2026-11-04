import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalD1 } from "../src/d1/local.js";
import { harnessId } from "../src/harness/ids.js";
import { importBrowserExport } from "../src/lstep/browser.js";
import type { SourceExport } from "../src/lstep/export.js";
import { mergeHybridExport } from "../src/lstep/hybrid.js";
import { applyLocal, createPlan, verifyLocal, writeSourceSnapshot } from "../src/pipeline.js";

const FIXTURE = new URL("fixtures/lstep-browser.json", import.meta.url);
const SCHEMA = fileURLToPath(new URL("../schema/line-harness-bootstrap.sql", import.meta.url));
const ACCOUNT = "fictional-hybrid-target";
const HANAKO_UID = "U11111111111111111111111111111111";
const TARO_UID = "U22222222222222222222222222222222";
const TEMPORARIES: string[] = [];

function rawFixture() {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

function officialCore(): SourceExport {
  const api = importBrowserExport(rawFixture());
  api.route = "api";
  api.resources.templates = api.resources.templates.map(({ id, name, type }) => ({ id, name, type }));
  api.resources.scenarios = [];
  api.resources.forms = [];
  api.resources.formResponses = {};
  api.resources.handlingStatuses = [{ id: 901, name: "対応中" }, { id: 902, name: "対応済み" }];
  for (const [index, friend] of api.resources.friends.entries()) {
    friend.row.system_name = `公式APIの管理名${index}`;
    friend.row.email = `official-${index}@example.invalid`;
    friend.row.phone = `000-0000-000${index}`;
    friend.detail!.system_name = friend.row.system_name;
    friend.detail!.email = friend.row.email;
    friend.detail!.phone = friend.row.phone;
    friend.detail!.scenarios = [];
    friend.conversation!.handling_status = api.resources.handlingStatuses[index];
    friend.conversation!.confirm_status = index ? "read" : "unread";
    friend.conversation!.display_status = index ? "block" : "normal";
  }
  api.coverage.handlingStatuses = { status: "complete", count: 2 };
  api.coverage.friendInfoValues = { status: "complete", count: 9 };
  delete api.coverage.friendFields;
  for (const resource of ["templateContents", "scenarios", "scenarioActions", "friendScenarios", "forms", "formResponses", "formBehavior"]) {
    api.coverage[resource] = { status: "unsupported", count: 0, note: "公式APIでは未取得" };
  }
  return api;
}

function supplement() {
  const raw = rawFixture();
  raw.mode = "supplement";
  raw.identity = { memberId: 1001, visibleFriendIds: [1001, 1002] };
  raw.data.friends = raw.data.friends.map((friend: { id: number; scenarios: unknown[] }) => ({ id: friend.id, scenarios: friend.scenarios }));
  return raw;
}

function prepare(merged = mergeHybridExport(officialCore(), supplement())) {
  const directory = mkdtempSync(join(tmpdir(), "lstep-hybrid-"));
  TEMPORARIES.push(directory);
  const snapshotDir = join(directory, "snapshot");
  const outDir = join(directory, "out");
  const dbPath = join(directory, "test.sqlite");
  const snapshot = writeSourceSnapshot(merged, snapshotDir);
  const manifest = createPlan(snapshotDir, outDir, ACCOUNT);
  const database = new LocalD1(dbPath);
  try {
    database.loadSchema(SCHEMA);
    database.db.prepare("INSERT INTO line_accounts (id,channel_id,name,channel_access_token,channel_secret,is_active) VALUES (?,?,?,?,?,0)")
      .run(ACCOUNT, "fictional-channel", "架空の組み合わせ移行試験", "fictional-token", "fictional-secret");
  } finally { database.close(); }
  return { directory, snapshotDir, outDir, dbPath, snapshot, manifest };
}

afterEach(() => {
  for (const directory of TEMPORARIES.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("hybrid source combination", () => {
  it("retains all official profiles, tags, information values, conversations and handling states", () => {
    const api = officialCore();
    const original = structuredClone(api);
    const raw = supplement();
    // Even if stale browser data is present, it cannot replace official core records.
    raw.data.friends[0].name = "古い画面の表示名";
    raw.data.friends[0].tags = [];
    raw.data.friends[0].fields = [];
    raw.data.friends[0].timeline = { complete: true, messages: [] };
    raw.data.tags = [];
    raw.data.fields = [];
    raw.coverage.friendFields = { status: "failed", count: 0 };
    raw.coverage.conversations = { status: "failed", count: 0 };
    const merged = mergeHybridExport(api, raw);
    expect(merged.route).toBe("hybrid");
    expect(api).toEqual(original);
    expect(merged.resources.tags).toEqual(api.resources.tags);
    expect(merged.resources.fields).toEqual(api.resources.fields);
    expect(merged.resources.handlingStatuses).toEqual(api.resources.handlingStatuses);
    expect(merged.coverage.friendInfoValues).toEqual(api.coverage.friendInfoValues);
    expect(merged.coverage.conversations).toEqual(api.coverage.conversations);
    expect(merged.coverage.friendFields).toBeUndefined();
    for (const [index, friend] of merged.resources.friends.entries()) {
      const originalFriend = api.resources.friends[index];
      expect(friend.row).toEqual(originalFriend.row);
      expect(friend.conversation).toEqual(originalFriend.conversation);
      expect({ ...friend.detail, scenarios: [] }).toEqual(originalFriend.detail);
      expect(friend.detail!.scenarios[0].id).toBe(301);
    }
  });

  it("joins browser form answers to official UIDs using numeric member IDs alone", () => {
    const raw = supplement();
    expect(raw.data.friends.every((friend: Record<string, unknown>) => !("uid" in friend))).toBe(true);
    const merged = mergeHybridExport(officialCore(), raw);
    expect(merged.resources.formResponses["601"].map(response => [response.lmessage_friend_id, response.line_friend_id]))
      .toEqual([[1001, HANAKO_UID], [1002, TARO_UID]]);
    expect(merged.resources.formResponses["601"][0].answers.find(answer => answer.name === "予算")!.value).toBe(0);
  });

  it("keeps more than 1000 official friends when browser state coverage is capped", () => {
    const api = officialCore();
    const prototype = api.resources.friends[0];
    api.resources.friends = Array.from({ length: 1001 }, (_, index) => {
      const friend = structuredClone(prototype);
      const id = 1001 + index;
      const uid = `U${(index + 1).toString(16).padStart(32, "0")}`;
      friend.row.lmessage_friend_id = id;
      friend.row.line_friend_id = uid;
      friend.detail!.lmessage_friend_id = id;
      friend.detail!.line_friend_id = uid;
      friend.conversation!.lmessage_friend_id = id;
      friend.conversation!.line_friend_id = uid;
      return friend;
    });
    api.coverage.friends = { status: "complete", count: 1001 };
    const raw = supplement();
    raw.identity = { memberId: 1001, visibleFriendIds: [1001] };
    raw.data.friends = api.resources.friends.slice(0, 1000).map(friend => ({ id: friend.row.lmessage_friend_id, scenarios: [] }));
    raw.data.formResponses = {};
    raw.coverage.friendScenarios = { status: "complete", count: 0 };
    const merged = mergeHybridExport(api, raw);
    expect(merged.resources.friends).toHaveLength(1001);
    expect(merged.resources.friends.map(friend => friend.row)).toEqual(api.resources.friends.map(friend => friend.row));
    expect(merged.resources.friends[1000]).toEqual(api.resources.friends[1000]);
    expect(merged.coverage.friends).toEqual({ status: "complete", count: 1001 });
    expect(merged.coverage.friendScenarios.status).toBe("partial");
  });

  it.each([
    ["unknown state ID", (raw: ReturnType<typeof supplement>) => { raw.data.friends[0].id = 99999; }],
    ["duplicate state ID", (raw: ReturnType<typeof supplement>) => { raw.data.friends.push(structuredClone(raw.data.friends[0])); }],
    ["conflicting state UID", (raw: ReturnType<typeof supplement>) => { raw.data.friends[0].uid = TARO_UID; }],
    ["different visible account", (raw: ReturnType<typeof supplement>) => { raw.identity = { memberId: 99999, visibleFriendIds: [99999] }; }],
    ["mixed visible account", (raw: ReturnType<typeof supplement>) => { raw.identity.visibleFriendIds.push(99999); }],
    ["duplicate visible ID", (raw: ReturnType<typeof supplement>) => { raw.identity.visibleFriendIds.push(1001); }],
    ["unobserved proof member", (raw: ReturnType<typeof supplement>) => { raw.identity.visibleFriendIds = [1002]; }],
    ["conflicting proof UID", (raw: ReturnType<typeof supplement>) => { raw.identity.uid = TARO_UID; }],
    ["unknown answer member", (raw: ReturnType<typeof supplement>) => { raw.data.formResponses["601"][0].memberId = 99999; }],
    ["duplicate answer ID", (raw: ReturnType<typeof supplement>) => { raw.data.formResponses["601"].push(structuredClone(raw.data.formResponses["601"][0])); }],
    ["conflicting answer UID", (raw: ReturnType<typeof supplement>) => { raw.data.formResponses["601"][0].uid = TARO_UID; }],
    ["duplicate template ID", (raw: ReturnType<typeof supplement>) => { raw.data.templates.push(structuredClone(raw.data.templates[0])); }],
  ])("rejects %s rather than associating data by display name", (_label, mutate) => {
    const raw = supplement();
    mutate(raw);
    expect(() => mergeHybridExport(officialCore(), raw)).toThrow();
  });

  it("keeps failed coverage when normalization excludes unsupported fields, answers or steps", () => {
    const raw = supplement();
    raw.data.forms[0].pages[0].fields[0].type = "unsupported-widget";
    raw.data.scenarios[0].steps[0].delay_type = "unsupported-timing";
    raw.data.formResponses["601"][0].answers[0].value = { unknown_shape: "cannot restore" };
    for (const key of ["forms", "scenarios", "formResponses", "formBehavior", "templates", "friendScenarios"]) {
      raw.coverage[key] = { status: "failed", count: 0, note: "取得が途中で失敗" };
    }
    const merged = mergeHybridExport(officialCore(), raw);
    for (const key of ["forms", "scenarios", "formResponses", "formBehavior", "templates", "templateContents", "friendScenarios"]) {
      expect(merged.coverage[key].status, key).toBe("failed");
    }
    expect(merged.resources.scenarios[0].incomplete).toBe(true);
    expect(() => prepare(merged)).toThrow("取得失敗が残っています");
  });

  it("preserves an official template-body failure instead of promoting it to complete", () => {
    const api = officialCore();
    api.coverage.templateContents = { status: "failed", count: 0, note: "本文の取得失敗" };
    const merged = mergeHybridExport(api, supplement());
    expect(merged.coverage.templateContents.status).toBe("failed");
    expect(() => prepare(merged)).toThrow("取得失敗が残っています");
  });

  it.each([
    ["duplicate official ID", (api: SourceExport) => { api.resources.friends[1].row.lmessage_friend_id = 1001; api.resources.friends[1].detail!.lmessage_friend_id = 1001; }],
    ["duplicate official UID", (api: SourceExport) => { api.resources.friends[1].row.line_friend_id = HANAKO_UID; api.resources.friends[1].detail!.line_friend_id = HANAKO_UID; }],
    ["conflicting detail UID", (api: SourceExport) => { api.resources.friends[0].detail!.line_friend_id = TARO_UID; }],
  ])("refuses %s before combining records", (_label, mutate) => {
    const api = officialCore();
    mutate(api);
    expect(() => mergeHybridExport(api, supplement())).toThrow();
  });

  it("does not erase a failed official resource while adding successful browser settings", () => {
    const api = officialCore();
    api.coverage.templates = { status: "failed", count: 0, note: "公式APIで失敗" };
    api.coverage.friendInfoValues = { status: "failed", count: 0, note: "情報値の取得失敗" };
    const merged = mergeHybridExport(api, supplement());
    expect(merged.coverage.templates.status).toBe("failed");
    expect(merged.coverage.templateContents.status).toBe("failed");
    expect(merged.coverage.friendInfoValues.status).toBe("failed");
  });
});

describe("hybrid snapshot → plan → real L Harness SQLite schema", () => {
  it("saves template bodies and migrates exact steps, questions and answers joined to official friends", () => {
    const api = officialCore();
    const merged = mergeHybridExport(api, supplement());
    expect(api.coverage.templateContents.status).toBe("unsupported");
    expect(merged.coverage.templateContents.status).toBe("complete");
    const prepared = prepare(merged);
    expect(prepared.snapshot.readJson("template_details.json")).toEqual(merged.resources.templates);
    const applied = applyLocal(prepared.outDir, prepared.dbPath, true);
    expect(applied.checked).toBeGreaterThan(0);
    expect(verifyLocal(prepared.outDir, prepared.dbPath)).toEqual(applied);
    const database = new LocalD1(prepared.dbPath);
    try {
      const expectedBodies = merged.resources.templates.map(template => template.content);
      expect(database.all<{ message_content: string }>("SELECT message_content FROM templates ORDER BY name").map(row => row.message_content).sort())
        .toEqual([...expectedBodies].sort());
      expect(database.all("SELECT message_content,offset_days,delivery_time FROM scenario_steps ORDER BY step_order")).toEqual([
        { message_content: expectedBodies[0], offset_days: 0, delivery_time: "00:00" },
        { message_content: expectedBodies[1], offset_days: 1, delivery_time: "09:00" },
      ]);
      const form = database.all<{ id: string; fields: string; is_active: number }>("SELECT id,fields,is_active FROM forms")[0];
      expect(form.id).toBe(harnessId("form", ACCOUNT, 601));
      expect(form.is_active).toBe(0);
      const fields = JSON.parse(form.fields) as Array<{ name: string; type: string; required: boolean; options?: string[] }>;
      expect(fields.map(field => field.type)).toEqual(["text", "textarea", "select", "radio", "checkbox", "date", "email", "tel", "number"]);
      expect(fields[0]).toMatchObject({ name: "お名前", required: true });
      expect(fields[2].options).toEqual(["はじめて🌱", "継続🍀"]);
      const submissions = database.all<{ line_user_id: string; friend_id: string; form_id: string; data: string }>(
        "SELECT f.line_user_id,s.friend_id,s.form_id,s.data FROM form_submissions s JOIN friends f ON f.id=s.friend_id ORDER BY f.line_user_id",
      );
      expect(submissions).toHaveLength(2);
      expect(submissions.map(row => [row.line_user_id, row.friend_id, row.form_id])).toEqual([
        [HANAKO_UID, harnessId("friend", ACCOUNT, 1001), form.id],
        [TARO_UID, harnessId("friend", ACCOUNT, 1002), form.id],
      ]);
      const firstAnswers = JSON.parse(submissions[0].data);
      expect(firstAnswers["相談内容📩"]).toBe("製造業 \"A社\" / 'B店'\n架空県🌾");
      expect(firstAnswers["希望コース"]).toBe("はじめて🌱");
      expect(firstAnswers["予算"]).toBe(0);
      expect(firstAnswers["関心のあること"]).toEqual(["文章✍️", "仕組み⚙️"]);
      expect(database.all("SELECT status,current_step_order,next_delivery_at FROM friend_scenarios WHERE friend_id=?", harnessId("friend", ACCOUNT, 1001)))
        .toEqual([{ status: "paused", current_step_order: -1, next_delivery_at: null }]);
      expect(database.count("scenarios", "is_active<>0")).toBe(0);
      expect(database.all("PRAGMA foreign_key_check")).toEqual([]);
    } finally { database.close(); }
    expect(applyLocal(prepared.outDir, prepared.dbPath, true)).toEqual(applied);
  });
});
