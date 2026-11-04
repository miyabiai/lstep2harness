import type {
  SourceField, SourceFormAnswer, SourceFormResponse, SourceFriendInfoValue,
  SourceFriendSnapshot, SourceFriendTag, SourceHandlingStatus, SourceMessage,
  SourceTag, SourceTemplateDetail, SourceTrafficSource,
} from "../source/types.js";
import { emptyExport, type SourceExport } from "./export.js";

export const LSTEP_API_BASE = "https://api.lineml.jp/v2/api";

export interface LstepApiSourceOptions {
  token: string;
  accountId: string;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  maxRetries?: number;
  formIds?: number[];
  /** 1回の通信の待ち時間 */
  requestTimeoutMs?: number;
  /** 中止の合図。中止後は再試行せず、待ち時間も打ち切る */
  signal?: AbortSignal;
}

export class LstepApiError extends Error {
  constructor(message: string, public readonly status: number | null = null) {
    super(message);
    this.name = "LstepApiError";
  }
}

type JsonRecord = Record<string, unknown>;
type Query = Record<string, string | number | readonly (string | number)[] | undefined>;

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LstepApiError("API応答の形式が不正です", 200);
  }
  return value as JsonRecord;
}

function identifier(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new LstepApiError("API応答のIDが不正です", 200);
  }
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new LstepApiError("API応答の文字列が不正です", 200);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new LstepApiError("API応答の一覧が不正です", 200);
  return value;
}

function scalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function idAndName(value: unknown): SourceHandlingStatus {
  const item = record(value);
  return { id: identifier(item.id), name: stringValue(item.name) };
}

function fieldDefinition(value: unknown): SourceField {
  const item = record(value);
  const field: SourceField = {
    id: identifier(item.id), title: stringValue(item.name), type: stringValue(item.type),
  };
  if (item.options !== undefined && item.options !== null) {
    field.options = list(item.options).map((value) => {
      const option = record(value);
      return { option_id: identifier(option.id), label: stringValue(option.value) };
    });
  }
  return field;
}

function templateDefinition(value: unknown): SourceTemplateDetail {
  const item = record(value);
  return {
    id: identifier(item.id), name: stringValue(item.name), type: stringValue(item.type),
    ...(item.folder_id == null ? {} : { category_id: identifier(item.folder_id) }),
  };
}

function trafficSource(value: unknown): SourceTrafficSource {
  const item = record(value);
  return { id: identifier(item.id), name: stringValue(item.name) };
}

function inclusionQuery(tagIds: readonly number[], fieldIds: readonly number[]): Query {
  return {
    include_tags: tagIds.length ? tagIds : undefined,
    include_friend_infos: fieldIds.length ? fieldIds : undefined,
  };
}

function mergeUnique<T>(previous: T[], incoming: T[], getId: (item: T) => number): T[] {
  const values = new Map(previous.map((item) => [getId(item), item]));
  for (const item of incoming) values.set(getId(item), item);
  return [...values.values()];
}

export class LstepApiSource {
  #token: string;
  #accountId: string;
  #fetchImpl: typeof fetch;
  #intervalMs: number;
  #maxRetries: number;
  #formIds: number[];
  #requestTimeoutMs: number;
  #signal: AbortSignal | undefined;
  #nextRequestAt = 0;

  constructor(options: LstepApiSourceOptions) {
    if (!options.token.trim() || /[\r\n]/.test(options.token)) {
      throw new LstepApiError("LステップのAPIトークンを指定してください");
    }
    if (!options.accountId.trim()) throw new LstepApiError("移行元のアカウントIDを指定してください");
    const intervalMs = options.intervalMs ?? 125;
    const maxRetries = options.maxRetries ?? 2;
    if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new LstepApiError("取得間隔が不正です");
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
      throw new LstepApiError("再試行回数は0〜5回で指定してください");
    }
    this.#token = options.token;
    this.#accountId = options.accountId;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#intervalMs = Math.max(100, intervalMs);
    this.#maxRetries = maxRetries;
    this.#formIds = [...new Set((options.formIds ?? []).map((id) => {
      if (!Number.isSafeInteger(id) || id < 1) throw new LstepApiError("フォームIDは正の整数で指定してください");
      return id;
    }))];
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#signal = options.signal;
  }

  async doctor(): Promise<void> {
    const body = await this.#get("/friends", { limit: 1 });
    list(body.data);
  }

  async extract(): Promise<SourceExport> {
    const exported = emptyExport("api", this.#accountId);
    const resources = exported.resources;
    resources.tags = await this.#pages<SourceTag>("/tags", idAndName);
    exported.coverage.tags = { status: "complete", count: resources.tags.length };
    resources.fields = await this.#pages("/friend-infos", fieldDefinition);
    exported.coverage.fields = { status: "complete", count: resources.fields.length };
    resources.handlingStatuses = await this.#pages("/taiou-marks", idAndName, {}, 100);
    exported.coverage.handlingStatuses = { status: "complete", count: resources.handlingStatuses.length };
    resources.trafficSources = await this.#pages("/touchpoints", trafficSource);
    exported.coverage.trafficSources = {
      status: "partial", count: resources.trafficSources.length,
      note: "流入経路のIDと名前のみ。URL・動作・友だち別の通過履歴は含みません。",
    };
    resources.templates = await this.#pages("/templates", templateDefinition);
    exported.coverage.templates = {
      status: "partial", count: resources.templates.length,
      note: "公式APIは一覧のみ。テンプレート本文は取得できません。",
    };
    exported.coverage.templateContents = { status: "unsupported", count: 0, note: "公式APIの取得対象外です。" };

    const tagIds = resources.tags.map((tag) => tag.id);
    const fieldIds = resources.fields.map((field) => field.id);
    const friendIdentities = new Map<number, { uid: string; group: boolean }>();
    let skippedGroups = 0;
    let unsupportedValues = 0;
    resources.friends = await this.#pages("/friends", (value) => {
      const item = record(value);
      const id = identifier(item.id);
      const uid = stringValue(item.uid);
      if (friendIdentities.has(id)) throw new LstepApiError("API応答の友だちが重複しています。取得をやり直してください", 200);
      const group = item.is_line_group === true || uid.startsWith("C");
      if (!group && !/^U[0-9a-f]{32}$/i.test(uid)) throw new LstepApiError("API応答のLINEユーザーIDが不正です", 200);
      friendIdentities.set(id, { uid, group });
      if (group) {
        skippedGroups += 1;
        return null;
      }
      const name = item.name == null ? null : stringValue(item.name);
      const snapshot: SourceFriendSnapshot = {
        row: {
          lmessage_friend_id: id, line_friend_id: uid, line_name: name,
          system_name: optionalString(item.system_name),
          is_blocked: typeof item.is_blocked === "boolean" ? item.is_blocked : undefined,
          followed_at: optionalString(item.created_at),
        },
        detail: {
          lmessage_friend_id: id, line_friend_id: uid, line_name: name,
          system_name: optionalString(item.system_name),
          is_blocked: typeof item.is_blocked === "boolean" ? item.is_blocked : undefined,
          followed_at: optionalString(item.created_at),
          memo: typeof item.memo === "string" ? [item.memo] : undefined,
          tags: [], friend_info: [], scenarios: [],
        },
        conversation: {
          lmessage_friend_id: id, line_friend_id: uid,
          handling_status: item.taiou_mark == null ? null : idAndName(item.taiou_mark),
          display_status: optionalString(item.display_status), messages: [], complete: false,
        },
        fetched_at: new Date().toISOString(),
      };
      unsupportedValues += this.#appendFriendValues(snapshot, item, tagIds.slice(0, 100), fieldIds.slice(0, 100));
      return snapshot;
    }, {
      ...inclusionQuery(tagIds.slice(0, 100), fieldIds.slice(0, 100)),
      display_status: ["normal", "block", "hide"], sort_order: "asc",
    })
      .then((friends) => friends.filter((friend): friend is SourceFriendSnapshot => friend !== null));

    const friendsById = new Map<number, SourceFriendSnapshot>();
    const uids = new Set<string>();
    for (const friend of resources.friends) {
      if (uids.has(friend.row.line_friend_id)) {
        throw new LstepApiError("API応答の友だちが重複しています。取得をやり直してください", 200);
      }
      friendsById.set(friend.row.lmessage_friend_id, friend);
      uids.add(friend.row.line_friend_id);
    }
    // 追加属性も一覧をまとめて読む。1人ずつの詳細GETにすると友だち数に比例してAPI枠を消費する。
    for (let offset = 100; offset < Math.max(tagIds.length, fieldIds.length); offset += 100) {
      const tagBatch = tagIds.slice(offset, offset + 100);
      const fieldBatch = fieldIds.slice(offset, offset + 100);
      const seen = new Set<number>();
      await this.#visitPages("/friends", (value) => {
        const item = record(value);
        const id = identifier(item.id);
        const uid = stringValue(item.uid);
        const original = friendIdentities.get(id);
        if (!original || original.uid !== uid || original.group !== (item.is_line_group === true || uid.startsWith("C"))) {
          throw new LstepApiError("友だちの追加属性と一覧のIDが一致しません", 200);
        }
        if (seen.has(id)) throw new LstepApiError("追加属性の友だちが重複しています", 200);
        seen.add(id);
        const friend = friendsById.get(id);
        if (friend) unsupportedValues += this.#appendFriendValues(friend, item, tagBatch, fieldBatch);
      }, {
        ...inclusionQuery(tagBatch, fieldBatch),
        display_status: ["normal", "block", "hide"], sort_order: "asc",
      });
      if (seen.size !== friendIdentities.size) {
        throw new LstepApiError("友だちの追加属性に取得漏れがあります。再取得してください", 200);
      }
    }
    exported.coverage.friends = {
      status: skippedGroups ? "partial" : "complete", count: resources.friends.length,
      ...(skippedGroups ? { note: `グループ${skippedGroups}件は個人の移行対象から除外しました。` } : {}),
    };
    exported.coverage.friendInfoValues = {
      status: unsupportedValues ? "partial" : "complete",
      count: resources.friends.reduce((total, friend) => total + (friend.detail?.friend_info.length ?? 0), 0),
      ...(unsupportedValues ? { note: `未対応の値${unsupportedValues}件は取得できませんでした。` } : {}),
    };
    exported.coverage.friendTags = {
      status: "complete", count: resources.friends.reduce((total, friend) => total + (friend.detail?.tags.length ?? 0), 0),
    };

    let incompleteConversations = 0;
    let messageCount = 0;
    let systemNotices = 0;
    let skippedGroupMessages = 0;
    const conversationStates = new Map<number, { incomplete: boolean; unconfirmed: boolean; unconfirmedSeen: boolean }>();
    // 全体の会話をページ単位で振り分け、全メッセージの中間配列をもう1つ作らない。
    await this.#visitPages("/messages", (value) => {
      const item = record(value);
      const friendId = identifier(item.friend_id);
      const identity = friendIdentities.get(friendId);
      if (!identity) throw new LstepApiError("友だち一覧にない会話があります。欠落を避けるため再取得してください", 200);
      if (item.friend_uid != null && stringValue(item.friend_uid) !== identity.uid) {
        throw new LstepApiError("会話と友だちのIDが一致しません", 200);
      }
      if (identity.group) { skippedGroupMessages += 1; return; }
      const friend = friendsById.get(friendId)!;
      let state = conversationStates.get(friendId);
      if (!state) {
        state = { incomplete: false, unconfirmed: false, unconfirmedSeen: false };
        conversationStates.set(friendId, state);
      }
      if (typeof item.is_unconfirmed === "boolean") {
        state.unconfirmedSeen = true;
        if (item.is_unconfirmed && item.direction === "inbound") state.unconfirmed = true;
      }
      const direction = stringValue(item.direction);
      if (!["inbound", "outbound", "system"].includes(direction)) {
        throw new LstepApiError("API応答のメッセージ方向が不正です", 200);
      }
      // タグ付与などのシステム通知は顧客との会話ではないので移さない（画面取得と同じ扱い）
      if (direction === "system") {
        systemNotices += 1;
        return;
      }
      const content = item.content == null ? {} : record(item.content);
      const text = content.type === "text" ? optionalString(content.text) : undefined;
      if (text === undefined) state.incomplete = true;
      const timelineText = optionalString(item.timeline_text);
      if (text === undefined && timelineText === undefined) return;
      friend.conversation!.messages.push({
        message_id: identifier(item.id), sender: direction === "inbound" ? "friend" : "bot",
        message_type: optionalString(content.type) ?? direction,
        content: text ?? timelineText,
        sent_at: stringValue(item.sent_at),
        source: { direction, content_available: text !== undefined },
      } satisfies SourceMessage);
      messageCount += 1;
    }, { sort_order: "asc" });
    for (const friend of resources.friends) {
      const state = conversationStates.get(friend.row.lmessage_friend_id);
      const conversation = friend.conversation!;
      // 未確認（is_unconfirmed）の受信が1件でもあれば未読。項目が無ければ確認状態は不明のまま
      if (state?.unconfirmedSeen) conversation.confirm_status = state.unconfirmed ? "unread" : "read";
      conversation.complete = !state?.incomplete;
      conversation.last_message_date = conversation.messages.at(-1)?.sent_at;
      if (state?.incomplete) incompleteConversations += 1;
    }
    exported.coverage.conversations = {
      status: incompleteConversations ? "partial" : "complete", count: messageCount,
      note: "公式APIが返す履歴の全ページを取得。テキスト以外は表示用テキストのみの場合があります。"
        + (systemNotices ? `システム通知${systemNotices}件は会話から除外しました。` : "")
        + (skippedGroupMessages ? `グループの会話${skippedGroupMessages}件は対象外です。` : ""),
    };

    let formResponseCount = 0;
    let incompleteAnswers = 0;
    for (const formId of this.#formIds) {
      let omitted = 0;
      const responses = await this.#pages(`/forms/${formId}/answers`, (value) => {
        const item = record(value);
        if (item.friend_id == null) {
          omitted += 1;
          return null;
        }
        const answers: SourceFormAnswer[] = [];
        for (const value of list(item.answers)) {
          const answer = record(value);
          const type = stringValue(answer.type);
          const name = stringValue(answer.title);
          if (scalar(answer.value)) {
            answers.push({ name, type, value: answer.value });
          } else if (type === "choice" && answer.value != null) {
            const choice = record(answer.value);
            answers.push({
              name, type,
              value: {
                selected: list(choice.selected).map(stringValue),
                others: list(choice.others).map((value) => {
                  const other = record(value);
                  return { label: stringValue(other.label), text: stringValue(other.text) };
                }),
              },
            });
          } else {
            omitted += 1;
          }
        }
        return {
          id: identifier(item.id), lmessage_friend_id: identifier(item.friend_id),
          line_friend_id: optionalString(item.friend_uid), answers,
          answered_at: stringValue(item.answered_at),
          ...(typeof item.time_to_submit_seconds === "number" ? { duration: String(item.time_to_submit_seconds) } : {}),
        } satisfies SourceFormResponse;
      });
      resources.formResponses[String(formId)] = responses.filter((response): response is NonNullable<typeof response> => response !== null);
      const count = resources.formResponses[String(formId)].length;
      formResponseCount += count;
      incompleteAnswers += omitted;
      exported.coverage[`formResponses:${formId}`] = {
        status: omitted ? "partial" : "complete", count,
        ...(omitted ? { note: `匿名回答・未対応の回答値${omitted}件を除外しました。` } : {}),
      };
    }
    exported.coverage.formResponses = {
      status: this.#formIds.length ? "partial" : "unsupported", count: formResponseCount,
      note: this.#formIds.length
        ? `指定されたフォームのみ取得。フォーム全体の一覧は取得できません。未対応${incompleteAnswers}件。`
        : "フォームIDが未指定です。公式APIにフォーム一覧の取得機能はありません。",
    };
    for (const resource of ["scenarios", "forms", "autoReplies", "welcomeMessages", "richMenus"]) {
      exported.coverage[resource] = { status: "unsupported", count: 0, note: "この取得経路では取得できません。" };
    }
    exported.coverage.friendTouchpoints = {
      status: "unsupported", count: 0,
      note: "公式APIには取得機能がありますが、この保存形式は友だち別の通過履歴に未対応です。",
    };
    return exported;
  }

  #appendFriendValues(friend: SourceFriendSnapshot, item: JsonRecord, tagIds: number[], fieldIds: number[]): number {
    const tags = tagIds.length ? list(item.tags).map((value) => {
      const tag = record(value);
      const id = identifier(tag.id);
      if (!tagIds.includes(id)) throw new LstepApiError("未指定のタグがAPI応答に含まれています", 200);
      return {
        tag_id: id, tag_name: stringValue(tag.name), added_at: optionalString(tag.attached_at),
      } satisfies SourceFriendTag;
    }) : [];
    let omitted = 0;
    const values: SourceFriendInfoValue[] = [];
    if (fieldIds.length) {
      for (const value of list(item.friend_infos)) {
        const field = record(value);
        const id = identifier(field.id);
        if (!fieldIds.includes(id)) throw new LstepApiError("未指定の友だち情報がAPI応答に含まれています", 200);
        const selected = field.type === "select" && field.selected_option != null ? record(field.selected_option) : null;
        const selectedValue = selected ? stringValue(selected.value) : field.value;
        if (!scalar(selectedValue)) {
          omitted += 1;
          continue;
        }
        values.push({ id, name: stringValue(field.name), type: stringValue(field.type), value: selectedValue });
      }
    }
    friend.detail!.tags = mergeUnique(friend.detail!.tags, tags, (tag) => tag.tag_id);
    friend.detail!.friend_info = mergeUnique(friend.detail!.friend_info, values, (field) => field.id);
    return omitted;
  }

  async #pages<T>(path: string, mapper: (value: unknown) => T, query: Query = {}, limit = 1000): Promise<T[]> {
    const items: T[] = [];
    await this.#visitPages(path, value => { items.push(mapper(value)); }, query, limit);
    return items;
  }

  async #visitPages(path: string, visit: (value: unknown) => void, query: Query = {}, limit = 1000): Promise<void> {
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100_000; page += 1) {
      const body = await this.#get(path, { ...query, limit, cursor });
      for (const value of list(body.data)) {
        this.#throwIfCancelled();
        visit(value);
      }
      this.#throwIfCancelled();
      if (body.next_cursor === null) return;
      if (typeof body.next_cursor !== "string" || !body.next_cursor) {
        throw new LstepApiError("API応答の次ページ情報が不正です。全件取得を確認できません", 200);
      }
      if (seenCursors.has(body.next_cursor)) throw new LstepApiError("APIのページ送りがループしています", 200);
      seenCursors.add(body.next_cursor);
      cursor = body.next_cursor;
    }
    throw new LstepApiError("API取得のページ数が上限を超えました", 200);
  }

  async #get(path: string, query: Query = {}): Promise<JsonRecord> {
    const url = new URL(LSTEP_API_BASE + path);
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        for (const id of value) url.searchParams.append(`${key}[]`, String(id));
      } else if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      this.#throwIfCancelled();
      const scheduledAt = Math.max(Date.now(), this.#nextRequestAt);
      this.#nextRequestAt = scheduledAt + this.#intervalMs;
      if (scheduledAt > Date.now()) await this.#sleep(scheduledAt - Date.now());
      let response: Response | null = null;
      try {
        response = await this.#fetchImpl(url, {
          method: "GET", redirect: "manual",
          signal: this.#signal ? AbortSignal.any([this.#signal, AbortSignal.timeout(this.#requestTimeoutMs)])
            : AbortSignal.timeout(this.#requestTimeoutMs),
          headers: { Authorization: `Bearer ${this.#token}`, Accept: "application/json" },
        });
      } catch {
        this.#throwIfCancelled();
        if (attempt === this.#maxRetries) throw new LstepApiError("LステップAPIとの通信に失敗しました");
      }
      if (response?.status === 200) {
        let body: unknown;
        try { body = await response.json(); }
        catch { throw new LstepApiError("API応答を読み取れませんでした", 200); }
        return record(body);
      }
      const status = response?.status ?? null;
      const retryAfter = response?.headers.get("Retry-After") ?? null;
      if (response?.body) await response.body.cancel().catch(() => undefined);
      if (status === 401 || status === 403) throw new LstepApiError("APIの認証または閲覧権限を確認してください", status);
      if (status === 429) {
        let delayMs = 1000 * 2 ** attempt;
        if (retryAfter !== null) {
          delayMs = /^\d+(?:\.\d+)?$/.test(retryAfter)
            ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
          if (!Number.isFinite(delayMs)) throw new LstepApiError("APIの再開時刻を読み取れませんでした", 429);
          if (delayMs > 60_000) throw new LstepApiError("APIの利用上限に達しました。次回の利用可能時刻まで取得を停止します", 429);
        }
        if (attempt === this.#maxRetries) throw new LstepApiError("APIの呼び出し制限で取得を停止しました", 429);
        await this.#sleep(Math.max(100, delayMs));
      } else if (status === null || status >= 500) {
        if (attempt === this.#maxRetries) throw new LstepApiError("LステップAPIの取得に失敗しました", status);
        await this.#sleep(500 * 2 ** attempt);
      } else {
        throw new LstepApiError(`APIの取得に失敗しました（HTTP ${status}）`, status);
      }
    }
    throw new LstepApiError("LステップAPIの取得に失敗しました");
  }

  #throwIfCancelled(): void {
    if (this.#signal?.aborted) throw new LstepApiError("取得を中止しました");
  }

  #sleep(milliseconds: number): Promise<void> {
    const signal = this.#signal;
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new LstepApiError("取得を中止しました"));
      const onAbort = () => { clearTimeout(timer); reject(new LstepApiError("取得を中止しました")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
