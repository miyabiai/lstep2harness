import { emptyExport, type SourceExport } from "./export.js";
import type {
  SourceAction, SourceFormDetail, SourceFormField, SourceFormResponse, SourceFriendSnapshot,
  SourceMessage, SourceScenarioDetail, SourceTemplateDetail,
} from "../source/types.js";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number | undefined {
  if (value === "" || value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function identifier(value: unknown, label: string): number {
  const parsed = number(value);
  if (parsed === undefined || parsed < 1) throw new Error(`${label}: 有効な管理番号がありません`);
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function answerValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (value === null || ["string", "boolean", "number"].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(item => answerValue(item, depth + 1));
  const result: JsonObject = {};
  const source = object(value);
  for (const key of ["value", "values", "date", "time", "label", "text", "url", "fileName", "selected", "others"]) {
    if (key in source) result[key] = answerValue(source[key], depth + 1);
  }
  // 中身はあるのに知っている形がひとつも無い値は、空の値として「取得済み」にせず、未対応と分かる印を付ける
  if (!Object.keys(result).length && Object.keys(source).length) return { unsupported: true };
  return result;
}

function actions(value: unknown): SourceAction[] {
  return array(value).map(object).flatMap(action => {
    if (action.type !== "tag") return [];
    const data = object(action.data);
    return [{
      id: number(action.id), type: "tag", data: {
        ids: array(data.ids).map(number).filter((value): value is number => value !== undefined),
        action: number(data.action) ?? 1,
      },
    }];
  });
}

function template(value: unknown): SourceTemplateDetail {
  const source = object(value);
  return {
    id: identifier(source.id, "テンプレート"), name: string(source.name),
    type: string(source.type) || "unsupported", content: string(source.content),
    updated_at: optionalString(source.updated_at),
  };
}

function scenario(value: unknown): SourceScenarioDetail {
  const source = object(value);
  return {
    id: identifier(source.id, "シナリオ"), name: string(source.name),
    created_at: optionalString(source.created_at),
    ...(source.incomplete === true ? { incomplete: true } : {}),
    steps: array(source.steps).map((value, index) => {
      const step = object(value);
      return {
        id: identifier(step.id, "シナリオのステップ"), name: optionalString(step.name),
        order_number: number(step.order_number) ?? index + 1,
        delay_type: string(step.delay_type) || "unsupported",
        start_day: number(step.start_day), start_time: optionalString(step.start_time),
        delay_minutes: number(step.delay_minutes), actions: actions(step.actions),
        templates: array(step.templates).map(template),
      };
    }),
  };
}

function formField(value: unknown, index: number): SourceFormField {
  const source = object(value);
  let settings: JsonObject = {};
  if (typeof source.settings === "string") {
    try { settings = object(JSON.parse(source.settings)); } catch { settings = {}; }
  } else settings = object(source.settings);
  const items = array(settings.items).map(object).map(item => ({
    label: string(item.label), value: string(item.value),
    tagIds: array(item.tagIds).map(number).filter(value => value !== undefined),
    friendInfoIds: array(item.friendInfoIds).map(number).filter(value => value !== undefined),
    initialState: optionalString(item.initialState),
    initialStateTagIds: array(item.initialStateTagIds).map(number).filter(value => value !== undefined),
    useAsOther: item.useAsOther === true, useLimit: item.useLimit === true,
    destSection: optionalString(item.destSection), actionId: number(item.actionId),
  }));
  let rules = object(source.rules);
  if (typeof source.rules === "string") {
    try { rules = object(JSON.parse(source.rules)); } catch { rules = {}; }
  }
  return {
    id: identifier(source.id, "フォームの設問"), type: string(source.type) || "unsupported",
    name: optionalString(source.name), title: optionalString(source.title),
    label: optionalString(source.label), help: optionalString(source.help),
    position: number(source.position) ?? index,
    placeholder: optionalString(source.placeholder), rules: JSON.stringify({ required: rules.required === true }),
    settings: JSON.stringify({
      items, multiple: settings.multiple === true,
      friendInfoIds: array(settings.friendInfoIds).map(number).filter(value => value !== undefined),
      tagIds: array(settings.tagIds).map(number).filter(value => value !== undefined),
      sourceId: optionalString(settings.sourceId ?? source.sourceId), sourceSectionId: optionalString(settings.sourceSectionId),
      inputType: optionalString(settings.inputType), sourceType: optionalString(settings.sourceType),
      actionType: optionalString(settings.actionType), targetList: array(settings.targetList).filter(value => typeof value === "string"),
      hidden: settings.hidden === true, useInputRule: settings.useInputRule === true, inputRule: optionalString(settings.inputRule),
      useInitialValue: settings.useInitialValue === true, initialValue: optionalString(settings.initialValue),
    }),
  };
}

function form(value: unknown): SourceFormDetail {
  const source = object(value);
  return {
    id: identifier(source.id, "フォーム"), name: string(source.name),
    title: optionalString(source.title), description: optionalString(source.description),
    count_user_reply: number(source.count_user_reply), created_at: optionalString(source.created_at),
    actions_on_reply: actions(source.actions_on_reply),
    ...(source.incomplete === true ? { incomplete: true } : {}),
    pages: array(source.pages).map((value, index) => {
      const page = object(value);
      return {
        page_id: number(page.page_id) ?? index + 1,
        fields: array(page.fields).map(formField),
      };
    }),
  };
}

function message(value: unknown): SourceMessage {
  const source = object(value);
  return {
    message_id: number(source.message_id), sender: source.sender === "friend" ? "friend" : "bot",
    message_type: string(source.message_type) || "unsupported", content: string(source.content),
    sent_at: string(source.sent_at),
  };
}

function friend(value: unknown, exportedAt: string): SourceFriendSnapshot {
  const source = object(value);
  const friendId = identifier(source.id, "友だち");
  const uid = string(source.uid);
  if (!/^U[0-9a-f]{32}$/i.test(uid)) {
    throw new Error("LINEユーザーIDが無い友だちがいます。表示名での照合は行いません（個人データは表示しません）");
  }
  const timeline = object(source.timeline);
  const row = {
    lmessage_friend_id: friendId, line_friend_id: uid, line_name: string(source.name),
    is_blocked: typeof source.isBlocked === "boolean" ? source.isBlocked : null,
    followed_at: optionalString(source.createdAt),
  };
  return {
    row,
    detail: {
      ...row,
      tags: array(source.tags).map(object).map(tag => ({
        tag_id: identifier(tag.id, "友だちタグ"), tag_name: optionalString(tag.name),
      })),
      friend_info: array(source.fields).map(object).map(field => ({
        id: identifier(field.id, "友だち情報"), name: optionalString(field.name), value: answerValue(field.value),
      })),
      scenarios: array(source.scenarios).map(object).map(state => ({
        id: identifier(state.id, "購読シナリオ"), name: optionalString(state.name),
        status: string(state.status) || "unknown", started_at: optionalString(state.started_at),
      })),
    },
    conversation: source.timeline ? {
      lmessage_friend_id: friendId, line_friend_id: uid,
      complete: timeline.complete === true, messages: array(timeline.messages).map(message),
    } : null,
    fetched_at: exportedAt,
  };
}

export function importBrowserExport(input: unknown): SourceExport {
  const source = object(input);
  if (source.format !== "lstep-browser-v1") throw new Error("Lステップ画面取得ファイルの形式が違います");
  const account = object(source.account);
  const accountId = string(account.id).trim();
  if (!accountId) throw new Error("取得元アカウントの管理番号が必要です");
  const result = emptyExport("browser", accountId);
  result.account.label = optionalString(account.label);
  if (typeof source.exportedAt !== "string" || !Number.isFinite(Date.parse(source.exportedAt))) {
    throw new Error("取得日時がありません");
  }
  result.exportedAt = source.exportedAt;
  const data = object(source.data);
  if (data.idMappings !== undefined) {
    result.idMappings = { formFields: {}, formSections: {} };
    const mappings = object(data.idMappings);
    for (const kind of ["formFields", "formSections"] as const) {
      const seen = new Map<string, string>();
      for (const [original, normalized] of Object.entries(object(mappings[kind]))) {
        if (!/^[1-9]\d*\/[A-Za-z0-9_-]{1,128}$/.test(original)
          || typeof normalized !== "number" || !Number.isSafeInteger(normalized) || normalized < 1) {
          throw new Error("フォーム部品の識別子対応表が不正です");
        }
        const form = original.split("/")[0];
        const key = `${form}/${normalized}`;
        if (seen.has(key) && seen.get(key) !== original) throw new Error("フォーム部品の識別子対応表に衝突があります");
        seen.set(key, original);
        result.idMappings[kind][original] = normalized;
      }
    }
  }
  result.resources.friends = array(data.friends).map(value => friend(value, result.exportedAt));
  const friendIds = new Set<number>();
  const lineIds = new Set<string>();
  for (const item of result.resources.friends) {
    if (friendIds.has(item.row.lmessage_friend_id) || lineIds.has(item.row.line_friend_id)) {
      throw new Error("友だちの管理番号またはLINEユーザーIDが重複しています");
    }
    friendIds.add(item.row.lmessage_friend_id);
    lineIds.add(item.row.line_friend_id);
  }
  result.resources.tags = array(data.tags).map(object).map(tag => ({
    id: identifier(tag.id, "タグ"), name: string(tag.name), friend_count: number(tag.friend_count),
  }));
  result.resources.fields = array(data.fields).map(object).map(field => ({
    id: identifier(field.id, "友だち情報欄"), title: string(field.title), type: string(field.type) || "unsupported",
    options: array(field.options).map(object).map(option => ({ label: string(option.label) })),
  }));
  result.resources.templates = array(data.templates).map(template);
  result.resources.scenarios = array(data.scenarios).map(scenario);
  result.resources.forms = array(data.forms).map(form);
  for (const definition of result.resources.forms) {
    const seenIds = new Set<number>();
    for (const page of definition.pages) {
      for (const field of page.fields) {
        if (seenIds.has(field.id)) throw new Error("同じフォーム内に設問の識別子が重複しています");
        seenIds.add(field.id);
        const settings = object(JSON.parse(field.settings ?? "{}"));
        if (typeof settings.sourceId === "string" && result.idMappings?.formFields[`${definition.id}/${settings.sourceId}`] !== field.id) {
          throw new Error("フォームの設問と識別子対応表が一致しません");
        }
        if (typeof settings.sourceSectionId === "string" && settings.sourceSectionId
          && result.idMappings?.formSections[`${definition.id}/${settings.sourceSectionId}`] !== page.page_id) {
          throw new Error("フォームのセクションと識別子対応表が一致しません");
        }
      }
    }
  }
  let skippedFields = 0;
  let skippedSteps = 0;
  const supportedFields = new Set([
    "text", "textarea", "email", "tel", "number", "select", "radio", "checkbox", "date", "heading", "description", "image", "file",
  ]);
  for (const definition of result.resources.forms) {
    for (const page of definition.pages) {
      page.fields = page.fields.filter(field => {
        if (supportedFields.has(field.type) && object(JSON.parse(field.settings ?? "{}")).hidden !== true) return true;
        if (!supportedFields.has(field.type)) definition.unsupported_fields = true;
        skippedFields += 1;
        if (field.title) (definition.excluded_field_titles ??= []).push(field.title);
        return false;
      });
    }
  }
  for (const definition of result.resources.scenarios) {
    definition.steps = definition.steps.filter(step => {
      if (step.delay_type === "immediate") return true;
      if (step.delay_type === "date_based" && step.start_day !== undefined && step.start_day !== null
        && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(step.start_time ?? "")) return true;
      skippedSteps += 1;
      // 解釈できないステップがあるシナリオは「取得不完全」として、移行先のステップを変えない（欠けたまま入れると前に入れたステップが消える）
      definition.incomplete = true;
      return false;
    });
  }
  const uidById = new Map(result.resources.friends.map(item => [item.row.lmessage_friend_id, item.row.line_friend_id]));
  for (const [formId, values] of Object.entries(object(data.formResponses))) {
    identifier(formId, "回答フォーム");
    result.resources.formResponses[formId] = array(values).map(value => {
      const response = object(value);
      const friendId = identifier(response.memberId, "フォーム回答の友だち");
      const converted: SourceFormResponse = {
        id: identifier(response.id, "フォーム回答"), lmessage_friend_id: friendId,
        line_friend_id: uidById.get(friendId), answered_at: string(response.answeredAt),
        answers: array(response.answers).map(object).map(answer => ({
          name: string(answer.name), type: string(answer.type), value: answerValue(answer.value),
        })),
      };
      return converted;
    });
  }
  const unsupportedAnswers = Object.values(result.resources.formResponses).flat()
    .reduce((total, response) => total + response.answers.filter(answer => (answer.value as { unsupported?: boolean } | null)?.unsupported === true).length, 0);
  const coverage = object(source.coverage);
  const required = [
    "friends", "friendTags", "friendFields", "friendScenarios", "conversations", "systemEvents", "tags", "fields",
    "templates", "scenarios", "scenarioActions", "forms", "formResponses", "formBehavior",
    "handlingStatuses", "autoReplies", "welcomeMessages", "richMenus", "trafficSources",
  ];
  for (const key of required) {
    const entry = object(coverage[key]);
    const status = entry.status;
    result.coverage[key] = {
      status: status === "complete" || status === "partial" || status === "unsupported" || status === "failed" ? status : "unsupported",
      count: number(entry.count) ?? 0,
      note: optionalString(entry.note) ?? (status ? undefined : "未取得"),
    };
  }
  for (const key of ["handlingStatuses", "autoReplies", "welcomeMessages", "richMenus", "trafficSources"]) {
    result.coverage[key] = { status: "unsupported", count: 0, note: "この画面取得版では未対応" };
  }
  result.coverage.formBehavior = {
    status: "partial", count: result.resources.forms.length,
    note: "設問ごとのタグ付与・友だち情報保存先は設定に記録。条件分岐・複雑な部品・送信後動作の再現は要確認",
  };
  if (!result.resources.friends.length) result.coverage.friends = {
    status: "partial", count: 0,
    note: result.coverage.friends.note?.includes("取得は0人") ? result.coverage.friends.note
      : [result.coverage.friends.note, "友だちの取得は0人です。友だち一覧の読み取りからやり直してください"].filter(Boolean).join(" / "),
  };
  if (unsupportedAnswers) result.coverage.formResponses = {
    status: "partial", count: result.coverage.formResponses.count,
    note: [result.coverage.formResponses.note, `形式が未対応の回答${unsupportedAnswers}件は値を取り込めていません（unsupported の印を残しています）`].filter(Boolean).join(" / "),
  };
  if (skippedFields) result.coverage.forms = {
    status: "partial", count: result.resources.forms.length,
    note: `${skippedFields}件の未対応の設問を移行対象から除外しました（定義は移行先にも取得記録にも残りません）`,
  };
  if (skippedSteps) result.coverage.scenarios = {
    status: "partial", count: result.resources.scenarios.length,
    note: `${skippedSteps}件の配信日時を解釈できないステップを移行対象から除外しました（定義は移行先にも取得記録にも残りません）`,
  };
  if (result.resources.friends.some(item => !item.conversation?.complete)) {
    result.coverage.conversations.status = "partial";
    result.coverage.conversations.note = "未取得または全件取得を確認できない会話があります";
  }
  return result;
}
