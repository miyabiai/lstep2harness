import { importBrowserExport } from "./browser.js";
import type { ResourceCoverage, SourceExport } from "./export.js";

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const validId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** 公式APIの識別子と本体を保持し、同じアカウントから読んだ不足設定だけを補う。 */
export function mergeHybridExport(api: SourceExport, input: unknown): SourceExport {
  if (api.route !== "api") throw new Error("組み合わせ取得には公式APIの取得結果が必要です");
  const friends = new Map(api.resources.friends.map(friend => [friend.row.lmessage_friend_id, friend]));
  const uids = new Set<string>();
  for (const friend of api.resources.friends) {
    const { lmessage_friend_id: id, line_friend_id: uid } = friend.row;
    if (!validId(id) || !/^U[0-9a-f]{32}$/i.test(uid) || uids.has(uid)
      || friend.detail && (friend.detail.lmessage_friend_id !== id || friend.detail.line_friend_id !== uid)) {
      throw new Error("公式APIの友だちの識別子が不正・重複しています");
    }
    uids.add(uid);
  }
  if (!friends.size || friends.size !== api.resources.friends.length) throw new Error("公式APIの友だちの管理番号が空または重複しています");
  const raw = object(input);
  const data = object(raw.data);
  const identity = object(raw.identity);
  const visible = array(identity.visibleFriendIds);
  if (raw.format !== "lstep-browser-v1" || raw.mode !== "supplement"
    || object(raw.account).id !== api.account.id || !validId(identity.memberId)
    || !visible.length || new Set(visible).size !== visible.length
    || visible.some(id => !validId(id) || !friends.has(id)) || !visible.includes(identity.memberId)) {
    throw new Error("公式APIと管理画面が同じアカウントであることを確認できません");
  }
  const checkUid = (source: JsonObject, id: number): void => {
    if (source.uid !== undefined && source.uid !== null && source.uid !== ""
      && source.uid !== friends.get(id)!.row.line_friend_id) {
      throw new Error("公式APIと管理画面のLINEユーザーIDが一致しません");
    }
  };
  checkUid(identity, identity.memberId);
  const states = new Map<number, JsonObject>();
  for (const value of array(data.friends)) {
    const source = object(value);
    if (!validId(source.id) || !friends.has(source.id) || states.has(source.id) || !Array.isArray(source.scenarios)) {
      throw new Error("管理画面の友だちの管理番号が不正・重複または公式APIと不一致です");
    }
    checkUid(source, source.id);
    states.set(source.id, source);
  }
  for (const key of ["templates", "scenarios", "forms"] as const) {
    const seen = new Set<number>();
    for (const value of array(data[key])) {
      const id = object(value).id;
      if (!validId(id) || seen.has(id)) throw new Error("管理画面の設定の管理番号が不正または重複しています");
      seen.add(id);
    }
  }
  for (const values of Object.values(object(data.formResponses))) {
    const seen = new Set<number>();
    for (const value of array(values)) {
      const response = object(value);
      if (!validId(response.id) || seen.has(response.id) || !validId(response.memberId) || !friends.has(response.memberId)) {
        throw new Error("フォーム回答の管理番号が不正・重複または公式APIの友だちと不一致です");
      }
      checkUid(response, response.memberId);
      seen.add(response.id);
    }
  }
  // UIDはNode内でのみ加える。画面から届いた名前・タグ・情報値・会話は採用しない。
  const browser = importBrowserExport({
    ...raw, data: { ...data, friends: api.resources.friends.map(friend => ({
      id: friend.row.lmessage_friend_id, uid: friend.row.line_friend_id,
      scenarios: states.get(friend.row.lmessage_friend_id)?.scenarios ?? [],
    })) },
  });
  const rawCoverage = object(raw.coverage);
  const resourceCoverage = (key: string): ResourceCoverage => {
    const normalized = browser.coverage[key] ?? { status: "unsupported", count: 0, note: "未取得" };
    const original = object(rawCoverage[key]);
    // 正規化中に未対応の要素を除外しても、取得失敗を「一部成功」に変えない。
    if (original.status === "failed" || original.status === "partial" || original.status === "unsupported") {
      return { ...normalized, status: original.status,
        note: [typeof original.note === "string" ? original.note : undefined, normalized.note].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(" / ") || undefined };
    }
    return { ...normalized };
  };
  const coverage = { ...api.coverage };
  for (const key of ["templates", "scenarios", "scenarioActions", "forms", "formResponses", "formBehavior", "friendScenarios"]) {
    const supplemental = resourceCoverage(key);
    coverage[key] = api.coverage[key]?.status === "failed" ? { ...api.coverage[key] } : supplemental;
  }
  if (states.size !== friends.size && coverage.friendScenarios.status === "complete") {
    coverage.friendScenarios = { ...coverage.friendScenarios, status: "partial", note: "購読状況を補完できない友だちがあります。公式APIの友だちは全員保持しています" };
  }
  const templates = [...browser.resources.templates];
  const templateIds = new Set(templates.map(value => value.id));
  for (const value of api.resources.templates) if (!templateIds.has(value.id)) {
    templates.push(value);
    if (coverage.templates.status === "complete") coverage.templates = { ...coverage.templates, status: "partial", note: "公式APIの一覧にあるテンプレートの本文が未取得です" };
  }
  coverage.templateContents = api.coverage.templateContents?.status === "failed"
    ? { ...api.coverage.templateContents } : { ...coverage.templates };
  const formResponses = { ...api.resources.formResponses };
  for (const [formId, values] of Object.entries(browser.resources.formResponses)) {
    const existing = new Map((formResponses[formId] ?? []).map(response => [response.id, response]));
    for (const value of values) {
      const previous = existing.get(value.id);
      if (previous && previous.lmessage_friend_id !== value.lmessage_friend_id) throw new Error("公式APIと管理画面のフォーム回答の友だちが一致しません");
      // 公式APIで既に取れた回答は保ち、画面側から不足分だけ足す。
      if (!previous) existing.set(value.id, value);
    }
    formResponses[formId] = [...existing.values()];
  }
  return {
    ...api, route: "hybrid", exportedAt: browser.exportedAt,
    idMappings: browser.idMappings ?? api.idMappings,
    resources: {
      ...api.resources, templates, scenarios: browser.resources.scenarios, forms: browser.resources.forms, formResponses,
      friends: api.resources.friends.map((friend, index) => states.has(friend.row.lmessage_friend_id) ? {
        ...friend, detail: { ...(friend.detail ?? browser.resources.friends[index].detail!), scenarios: browser.resources.friends[index].detail!.scenarios },
      } : friend),
    },
    coverage,
  };
}
