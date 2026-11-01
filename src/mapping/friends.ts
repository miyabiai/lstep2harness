import type { SnapshotStore } from "../snapshot/store.js";
import type { PlanContext } from "./context.js";
import type { SourceConversationIndexEntry, SourceFriendSnapshot } from "../source/types.js";
import { sourceToHarnessJst, parseSourceDate, toHarnessJst } from "../harness/time.js";
import { isEventRecord, messageToLogParts, outgoingSource } from "./messages.js";
import { nextDeliveryAt, restoreProgress } from "./scenario-progress.js";
import { newerTimestamp, quote } from "../sql/render.js";

const LINE_UID_RE = /^U[0-9a-f]{32}$/;

function isBlocked(s: SourceFriendSnapshot): boolean {
  const d = s.detail;
  if (typeof d?.is_blocked === "boolean") return d.is_blocked;
  if (typeof s.row.is_blocked === "boolean") return s.row.is_blocked;
  const bs = s.conversation?.block_status;
  if (bs) return bs !== "normal";
  return false;
}

function followedAt(s: SourceFriendSnapshot): string | null {
  return s.detail?.followed_at ?? s.row.followed_at ?? s.row.added_time ?? null;
}

function blockedAtOf(s: SourceFriendSnapshot): string | null {
  return s.detail?.blocked_at ?? s.row.blocked_at ?? null;
}

export interface FriendMapStats {
  friends: number;
  blocked: number;
  tags: number;
  messages: number;
  chats: number;
  scenarios: number;
  /** 配信中で位置を復元できた人 */
  scenarioRestored: number;
  /** 配信中で位置が分からなかった人 */
  scenarioUnknown: number;
  /** 停止中の人（一時停止で入れる） */
  scenarioStopped: number;
  invalidUid: number;
  /** 会話ではない記録（ステップ配信の開始・停止など）。入れない */
  events: number;
  /** 本文が空の送信記録（移行元の履歴自体に本文が無い）。入れない */
  empty: number;
  /** L Harness が自分で記録済みの同じ会話（並行運用中に届いたもの）。入れない */
  duplicates: number;
}

type EntityReport = ReturnType<PlanContext["report"]>;

export function mapFriends(store: SnapshotStore, ctx: PlanContext): FriendMapStats {
  const stats: FriendMapStats = { friends: 0, blocked: 0, tags: 0, messages: 0, chats: 0, scenarios: 0, scenarioRestored: 0, scenarioUnknown: 0, scenarioStopped: 0, invalidUid: 0, events: 0, empty: 0, duplicates: 0 };
  // 会話一覧（確認状態・対応ステータス・最終日時）。friends/<id>.json に無い分をここから補う
  const index = store.readJson<Record<string, SourceConversationIndexEntry>>("conversation_index.json") ?? {};
  const fr = ctx.report("friends", "友だち");
  const tr = ctx.report("friend_tags", "友だちのタグ");
  const mr = ctx.report("messages", "会話履歴");
  const sr = ctx.report("friend_scenarios", "ステップ配信の進行状態");
  const seenUids = new Set<string>();
  const pendingChats: Array<{ friend: FriendInfo; lastAt: string | null }> = [];

  for (const s of store.friends()) {
    fr.source += 1;
    const uid = s.row.line_friend_id ?? s.detail?.line_friend_id ?? "";
    if (!LINE_UID_RE.test(uid)) {
      stats.invalidUid += 1;
      fr.skipped += 1;
      ctx.note("friends", "友だち", "LINE の userId が無い（削除済み等）友だちは移せません");
      continue;
    }
    if (seenUids.has(uid)) {
      fr.skipped += 1;
      ctx.note("friends", "友だち", "同じ LINE userId が複数あったため 1 件にまとめました");
      continue;
    }
    seenUids.add(uid);
    const idx = index[String(s.row.lmessage_friend_id)];
    if (s.conversation && idx) {
      s.conversation.confirm_status = s.conversation.confirm_status ?? idx.confirm_status;
      s.conversation.handling_status = s.conversation.handling_status ?? idx.handling_status;
      s.conversation.last_message_date = s.conversation.last_message_date ?? idx.last_message_date;
    }
    const blocked = isBlocked(s);
    if (blocked && !ctx.options.include_blocked) {
      fr.skipped += 1;
      continue;
    }
    const friend: FriendInfo = {
      snap: s,
      id: ctx.friendId(s.row.lmessage_friend_id),
      followed: sourceToHarnessJst(followedAt(s), ctx.now),
      handling: s.conversation?.handling_status?.name ?? idx?.handling_status?.name ?? null,
    };
    addFriendRow(friend, uid, blocked, ctx);
    stats.friends += 1;
    fr.migrated += 1;
    if (blocked) stats.blocked += 1;
    addFriendTags(friend, ctx, stats, tr);
    const lastAt = addMessages(friend, ctx, stats, mr);
    pendingChats.push({ friend, lastAt });
    addFriendScenarios(friend, ctx, stats, sr);
  }
  // チャットは、このツールが書きうるメモの文（全対応ステータス分）が揃ってから作る
  const statusNames = new Set<string>((store.readJson<Array<{ name: string }>>("handling_statuses.json") ?? []).map((status) => status.name));
  for (const { friend } of pendingChats) if (friend.handling) statusNames.add(friend.handling);
  const toolNotes = [...statusNames].map((name) => quote(`対応ステータス: ${name}`));
  for (const { friend, lastAt } of pendingChats) addChat(friend, lastAt, ctx, stats, toolNotes);
  fr.notes.push("表示名は取得時の値です。アイコン画像とステータスメッセージはこの変換では取り込みません");
  if (stats.blocked) fr.notes.push(`ブロック中 ${stats.blocked}人は「ブロック」状態で入れています`);
  if (sr.source) {
    sr.notes.push("完了の人は「完了」、配信中の人は会話履歴の送信記録から「何通目まで届いたか」を復元し、続きの予定時刻を入れています（シナリオは停止状態なので、L Harness で有効にするまで送られません）。停止中の人は「一時停止」で入れ、送りません");
    if (stats.scenarioRestored) sr.notes.push(`配信中の ${stats.scenarioRestored}人は続きから送れる状態で入れました。有効にした時点で予定時刻を過ぎている分はすぐ送られるので、切り替えの直前にもう一度 extract → plan → apply してから有効にしてください`);
    if (stats.scenarioUnknown) {
      sr.level = "partial";
      sr.notes.push(`配信中の ${stats.scenarioUnknown}人は、取得した会話履歴から位置を判断できないため「一時停止」で入れました。続きが必要な人は履歴と内容を確認してください`);
    }
  }
  mr.notes.push("画像・ファイルは取得元のURLを参照しています。移行元を解約する前に参照先の有効期間を確認してください");
  if (stats.events) mr.notes.push(`ステップ配信の開始・停止などの記録 ${stats.events}件は会話ではないので入れていません`);
  if (stats.duplicates) mr.notes.push(`並行運用中などに L Harness が自分で記録した会話と同じ ${stats.duplicates}件は、二重にならないよう入れていません`);
  if (stats.empty) mr.notes.push(`本文が空の送信記録 ${stats.empty}件は入れていません（取得した履歴に本文がないもの）`);
  return stats;
}

/** 移す友だち 1 人分の共通値 */
interface FriendInfo {
  snap: SourceFriendSnapshot;
  /** L Harness の friends.id */
  id: string;
  /** 友だち追加日時（L Harness JST） */
  followed: string;
  /** 対応ステータス名 */
  handling: string | null;
}

/**
 * オブジェクトの中の値が null の項目を外す（配列の中はそのまま）。
 * 移行し直すときは既存のメタデータに json_patch で足すが、json_patch は null の項目を消すので、
 * 最初から入れないことで、何度流しても同じ中身になるようにする。
 */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, withoutNulls(v)]));
}

/** friends.metadata（友だち情報・移行元の元データ _lstep）を作る */
function friendMetadata(f: FriendInfo, ctx: PlanContext): Record<string, unknown> {
  const s = f.snap;
  const detail = s.detail;
  const friendInfo: Record<string, { title: string; value: unknown }> = {};
  const top: Record<string, unknown> = {};
  for (const fi of detail?.friend_info ?? []) {
    const title = (fi.title ?? fi.name ?? ctx.fieldTitles.get(fi.id) ?? `field_${fi.id}`).trim();
    if (fi.value === null || fi.value === undefined || fi.value === "") continue;
    friendInfo[String(fi.id)] = { title, value: fi.value };
    if (ctx.options.friend_info_top_level && !(title in top)) top[title] = fi.value;
  }
  // 友だち情報の標準項目: -1=システム表示名、-2=電話番号、-3=メールアドレス
  const systemName = detail?.system_name ?? s.row.system_name ?? friendInfo["-1"]?.value ?? null;
  const email = detail?.email ?? s.row.email ?? (friendInfo["-3"]?.value as string | undefined) ?? null;
  const phone = detail?.phone ?? s.row.phone ?? (friendInfo["-2"]?.value as string | undefined) ?? null;
  const handling = f.handling;
  // 最上位に置く項目。_lstep.top にも同じものを残し、移行し直すときに「このツールが入れたまま（L Harness で直していない）項目」だけを書き換える
  const topLevel: Record<string, unknown> = {
    ...top,
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(systemName ? { system_name: systemName } : {}),
    ...(handling ? { handling_status: handling } : {}),
  };
  return {
    ...topLevel,
    _lstep: {
      top: topLevel,
      // このツールがチャットのメモに書く文（移行し直すとき、前に書いた文そのものだけを書き換えるための控え）
      chat_note: handling ? `対応ステータス: ${handling}` : null,
      friend_id: s.row.lmessage_friend_id,
      system_name: systemName,
      handling_status: handling,
      confirm_status: s.conversation?.confirm_status ?? null,
      followed_at: followedAt(s),
      blocked_at: blockedAtOf(s),
      friend_info: friendInfo,
      scenarios: (detail?.scenarios ?? []).map((sc) => ({ id: sc.scenario_id ?? sc.id, name: sc.scenario_name ?? sc.name, status: sc.status, started_at: sc.started_at ?? null, ended_at: sc.ended_at ?? null })),
      memo: detail?.memo ?? [],
      purchase_history: detail?.purchase_history ?? [],
      migrated_at: ctx.now,
    },
  };
}

/**
 * 既存のメタデータへの足し方（SQL）。最上位の項目ごとに次の値にする。
 * - L Harness 側に元からあった項目、前にこのツールが入れた後に L Harness で直した項目
 *   （今の値が _lstep.top に残した「入れた値」と違う）→ L Harness 側の値のまま（型も null もそのまま）
 * - このツールが入れたままの項目 → Lステップの新しい値
 * - Lステップにだけある項目 → 足す。Lステップで消した項目は消さない（足すだけ）
 * - _lstep はこのツールの領域なので、丸ごと最新にする
 * json_patch は使わない（true が 1 になる・null の項目が消える・入れ子を混ぜる、を避けるため）
 */
const EXISTING_METADATA = "CASE WHEN json_valid(friends.metadata) THEN CASE WHEN json_type(friends.metadata) = 'object' THEN friends.metadata ELSE '{}' END ELSE '{}' END";
/** json_each の1項目を、型を保った JSON の文字に戻す（json() で JSON と印を付けるのは外側の json_group_object の所。副問い合わせを通ると印が消えるため） */
const jsonOf = (alias: string): string =>
  `CASE ${alias}.type WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN 'null' WHEN 'object' THEN ${alias}.value WHEN 'array' THEN ${alias}.value ELSE json_quote(${alias}.value) END`;
const NEW_TOP = "json_extract(excluded.metadata, '$._lstep.top')";
const OLD_TOP = `json_extract(${EXISTING_METADATA}, '$._lstep.top')`;
/**
 * 新しい _lstep.top（このツールが入れた最上位の項目の控え）。今回入れる項目に加えて、前に入れたまま L Harness で直していない項目
 * （Lステップで値を空にした項目など）も「このツールのもの」として残す。残さないと、空にして入れ直した項目が二度と更新されない
 */
const OWNED_TOP = `(SELECT json_group_object(k, json(v)) FROM (`
  + `SELECT nt.key AS k, ${jsonOf("nt")} AS v FROM json_each(${NEW_TOP}) AS nt`
  + ` UNION ALL SELECT ot.key, ${jsonOf("ot")} FROM json_each(${OLD_TOP}) AS ot JOIN json_each(${EXISTING_METADATA}) AS e ON e.key = ot.key AND e.type = ot.type AND e.value IS ot.value`
  + ` WHERE ot.key NOT IN (SELECT key FROM json_each(${NEW_TOP}))))`;
/** 新しい _lstep。前回書いたチャットのメモ（chat_note）が今回と違うときだけ、控え（chat_note_prev）として残す（同じなら何も足さず、同じ計画を流し直しても中身が変わらない） */
const OLD_CHAT_NOTE = `json_extract(${EXISTING_METADATA}, '$._lstep.chat_note')`;
const LSTEP_MERGED = `CASE WHEN ${OLD_CHAT_NOTE} IS NULL OR ${OLD_CHAT_NOTE} IS json_extract(excluded.metadata, '$._lstep.chat_note')`
  + ` THEN json_set(json(x.value), '$.top', json(${OWNED_TOP}))`
  + ` ELSE json_set(json(x.value), '$.top', json(${OWNED_TOP}), '$.chat_note_prev', ${OLD_CHAT_NOTE}) END`;
const METADATA_MERGE = `(SELECT json_group_object(k, json(v)) FROM (`
  + `SELECT e.key AS k, CASE WHEN x.key IS NOT NULL AND e.key = '_lstep' THEN ${LSTEP_MERGED}`
  + ` WHEN x.key IS NOT NULL AND t.key IS NOT NULL AND e.type = t.type AND e.value IS t.value THEN ${jsonOf("x")} ELSE ${jsonOf("e")} END AS v`
  + ` FROM json_each(${EXISTING_METADATA}) AS e`
  + ` LEFT JOIN json_each(excluded.metadata) AS x ON x.key = e.key`
  + ` LEFT JOIN json_each(json_extract(${EXISTING_METADATA}, '$._lstep.top')) AS t ON t.key = e.key`
  + ` UNION ALL SELECT x.key, ${jsonOf("x")} FROM json_each(excluded.metadata) AS x WHERE x.key NOT IN (SELECT key FROM json_each(${EXISTING_METADATA}))`
  + `))`;

function addFriendRow(f: FriendInfo, uid: string, blocked: boolean, ctx: PlanContext): void {
  const s = f.snap;
  const displayName = (s.detail?.line_name ?? s.row.line_name ?? "").trim() || null;
  ctx.add({
    table: "friends",
    values: {
      id: f.id,
      line_user_id: uid,
      display_name: displayName,
      picture_url: null,
      status_message: null,
      is_following: blocked ? 0 : 1,
      user_id: null,
      line_account_id: ctx.lineAccountId,
      metadata: JSON.stringify(withoutNulls(friendMetadata(f, ctx))),
      first_followed_at: f.followed,
      current_follow_started_at: blocked ? null : f.followed,
      last_followed_at: f.followed,
      last_unfollowed_at: blocked ? sourceToHarnessJst(blockedAtOf(s), ctx.now) : null,
      unfollow_count: blocked ? 1 : 0,
      created_at: f.followed,
      updated_at: ctx.now,
    },
    conflict: ["line_user_id"],
    // 既に L Harness にいる友だち（並行運用で先に登録済み・前に移した人）は、表示名・アイコンを壊さず、
    // メタデータは L Harness 側の項目を残して Lステップの項目を足し、追加日は古い方にする
    update: ["metadata", "line_account_id", "updated_at", "first_followed_at"],
    merge: {
      metadata: METADATA_MERGE,
      updated_at: newerTimestamp("friends"),
      first_followed_at: "CASE WHEN friends.first_followed_at IS NULL OR substr(excluded.first_followed_at,1,23) < substr(friends.first_followed_at,1,23) THEN excluded.first_followed_at ELSE friends.first_followed_at END",
    },
    verifyJson: ["metadata"],
  });
}

/** タグ（＋対応ステータスのタグ）→ friend_tags */
function addFriendTags(f: FriendInfo, ctx: PlanContext, stats: FriendMapStats, tr: EntityReport): void {
  const tags = f.snap.detail?.tags ?? [];
  tr.source += tags.length;
  for (const t of tags) {
    const tagId = ctx.tagIds.get(t.tag_id);
    if (!tagId) {
      ctx.note("friend_tags", "友だちのタグ", "タグ一覧に無いタグ（削除済み）は飛ばしました");
      continue;
    }
    ctx.add({
      table: "friend_tags",
      values: { friend_id: f.id, tag_id: tagId, assigned_at: sourceToHarnessJst(t.added_at, f.followed) },
      conflict: ["friend_id", "tag_id"],
      update: [],
    });
    stats.tags += 1;
    tr.migrated += 1;
  }
  // 対応ステータスのタグは「今のステータス」だけにする（変わったら前のステータスのタグを外す。普通のタグは外さない）
  const currentStatusTag = f.handling ? ctx.handlingStatusTagIds.get(f.handling) : undefined;
  // 今の定義のタグに加えて、前にこのツールが入れた対応ステータスのタグ（名前が「対応:」で始まり、ID がこのツールの UUID v5 のもの。
  // 移行元で定義が消えたステータスの分）も外す対象にする。人が作った同名のタグ（UUID v4）は外さない
  const toolStatusTags = [...ctx.existingTags].filter(([name, id]) => name.startsWith("対応:") && id[14] === "5").map(([, id]) => id);
  const staleStatusTags = [...new Set([...ctx.handlingStatusTagIds.values(), ...toolStatusTags])].filter((id) => id !== currentStatusTag);
  if (staleStatusTags.length) {
    ctx.add({ table: "friend_tags", values: { friend_id: f.id }, sql: `DELETE FROM friend_tags WHERE friend_id = ${quote(f.id)} AND tag_id IN (${staleStatusTags.map(quote).join(",")});` });
  }
  if (currentStatusTag) {
    ctx.add({
      table: "friend_tags",
      values: { friend_id: f.id, tag_id: currentStatusTag, assigned_at: ctx.now },
      conflict: ["friend_id", "tag_id"],
      update: [],
    });
  }
}

/** 会話履歴 → messages_log。最後のメッセージ日時（無ければ null）を返す */
function addMessages(f: FriendInfo, ctx: PlanContext, stats: FriendMapStats, mr: EntityReport): string | null {
  const s = f.snap;
  const msgs = s.conversation?.messages ?? [];
  let lastAt: string | null = null;
  // 会話の ID は「移行元のメッセージ ID（無ければ時刻）・メッセージ内の何個目か・本文・同じ組の何番目か」で決める。
  // 取得し直して古い会話が増えたり、飛ばす会話があったり、同じ ID の会話の順が入れ替わったりしても、
  // ほかの会話の ID が変わらないようにする（通し番号は使わない）
  const seen = new Map<string, number>();
  for (const m of msgs) {
    if (isEventRecord(m)) {
      stats.events += 1;
      continue;
    }
    const key = String(m.message_id ?? m.sent_at ?? "");
    const at = parseSourceDate(m.sent_at);
    const createdAt = at === null ? f.followed : toHarnessJst(at);
    const parts = messageToLogParts(m);
    if (!parts.length) {
      stats.empty += 1;
      continue;
    }
    const incoming = m.sender === "friend";
    for (const [index, part] of parts.entries()) {
      const same = `${key}\u0000${index}\u0000${part.content}`;
      const nth = seen.get(same) ?? 0;
      seen.set(same, nth + 1);
      if (alreadyLogged(ctx, f.id, incoming ? "incoming" : "outgoing", part.content, at ?? parseSourceDate(createdAt) ?? 0)) {
        stats.duplicates += 1;
        continue;
      }
      ctx.add({
        table: "messages_log",
        values: {
          id: ctx.id("message", s.row.lmessage_friend_id, key, index, part.content, nth),
          friend_id: f.id,
          direction: incoming ? "incoming" : "outgoing",
          message_type: part.message_type,
          content: part.content,
          broadcast_id: null,
          scenario_step_id: null,
          template_id_at_send: null,
          delivery_type: null,
          source: incoming ? "user" : outgoingSource(m),
          line_account_id: ctx.lineAccountId,
          created_at: createdAt,
        },
        update: [],
      });
      stats.messages += 1;
      mr.migrated += 1;
    }
    if (parts.length && (!lastAt || createdAt > lastAt)) lastAt = createdAt;
  }
  mr.source += msgs.length;
  if (s.conversation && !s.conversation.complete) ctx.note("messages", "会話履歴", "取得した会話履歴は一部です。全履歴の移行完了として扱わないでください");
  return lastAt;
}

/** 同じ会話を L Harness が自分で記録済みか（同じ向き・本文で、時刻の差が10分以内）。見つけた記録は1回だけ使う */
const SAME_MESSAGE_WINDOW_MS = 10 * 60 * 1000;
function alreadyLogged(ctx: PlanContext, friendId: string, direction: string, content: string, at: number): boolean {
  const list = ctx.existingMessages.get(friendId);
  if (!list?.length) return false;
  const index = list.findIndex((m) => m.direction === direction && m.content === content && Math.abs(m.at - at) <= SAME_MESSAGE_WINDOW_MS);
  if (index < 0) return false;
  list.splice(index, 1);
  return true;
}

/** chats（1 友だち 1 行。無いと「未対応」扱いになるので履歴がある人は必ず作る） */
function addChat(f: FriendInfo, lastAt: string | null, ctx: PlanContext, stats: FriendMapStats, toolNotes: string[]): void {
  const conv = f.snap.conversation;
  if (!conv) return;
  const confirm = (conv?.confirm_status ?? "").toString().toLowerCase();
  const unread = confirm === "unread";
  if (!confirm) {
    ctx.note("chats", "チャットの確認状態", "確認状態を取得できなかった友だちのチャットは「対応済み」で作りました。未読のまま残すべき会話がないか確認してください");
    ctx.report("chats", "チャットの確認状態").level = "partial";
  }
  ctx.add({
    table: "chats",
    values: {
      id: ctx.id("chat", f.snap.row.lmessage_friend_id),
      friend_id: f.id,
      operator_id: null,
      status: unread ? "unread" : "resolved",
      notes: f.handling ? `対応ステータス: ${f.handling}` : null,
      last_message_at: lastAt ?? sourceToHarnessJst(conv?.last_message_date, f.followed),
      line_account_id: ctx.lineAccountId,
      created_at: f.followed,
      updated_at: ctx.now,
    },
    conflict: ["friend_id"],
    // 既にあるチャットは、対応状態（未読・対応済み）を L Harness 側のまま残し、メモは人が書いたものを残し、最終日時を古くしない。
    // 取得元の対応状態を入れるのは新しく作るときだけ
    update: ["notes", "last_message_at", "updated_at"],
    merge: {
      // メモは、このツールが書いた「対応ステータス: …」そのものだけ書き換え、L Harness で人が書いた・書き足したメモは残す
      // 書き換えるのは、今ある対応ステータス名の文そのもの、または前回この友だちに書いた文そのもの（friends.metadata の _lstep.chat_note_prev）だけ。
      // 人が書いた・書き足した・同じ行に付け足したメモは残す
      notes: `CASE WHEN chats.notes IS NULL${toolNotes.length ? ` OR chats.notes IN (${toolNotes.join(",")})` : ""} OR chats.notes IS (SELECT json_extract(f.metadata, '$._lstep.chat_note_prev') FROM friends AS f WHERE f.id = chats.friend_id) THEN excluded.notes ELSE chats.notes END`,
      updated_at: newerTimestamp("chats"),
      last_message_at: "CASE WHEN chats.last_message_at IS NULL OR substr(excluded.last_message_at,1,23) > substr(chats.last_message_at,1,23) THEN excluded.last_message_at ELSE chats.last_message_at END",
    },
  });
  stats.chats += 1;
}

/** ステップ配信の進行状態 → friend_scenarios（停止中の人は入れない） */
function addFriendScenarios(f: FriendInfo, ctx: PlanContext, stats: FriendMapStats, sr: EntityReport): void {
  const s = f.snap;
  for (const sc of s.detail?.scenarios ?? []) {
    sr.source += 1;
    const sourceScenarioId = sc.scenario_id ?? sc.id;
    const scenarioId = sourceScenarioId !== undefined ? ctx.scenarioIds.get(sourceScenarioId) : undefined;
    if (sourceScenarioId === undefined || !scenarioId) {
      sr.skipped += 1;
      ctx.note("friend_scenarios", "ステップ配信の進行状態", "取得データにステップ配信の中身がないものは進行状態を作っていません");
      continue;
    }
    if (ctx.existingFriendScenarios.has(`${f.id}\u0000${scenarioId}`)) {
      // L Harness 自身が作った進行状態（UUID v4・未完了）がある組は、L Harness 側の進行をそのまま残す
      sr.skipped += 1;
      ctx.note("friend_scenarios", "ステップ配信の進行状態", "L Harness 側で登録済みの進行状態がある人は、その進行をそのまま残しました（Lステップの進行状態は入れていません）");
      continue;
    }
    const startedMs = parseSourceDate(sc.started_at);
    // 停止中の人は「一時停止」で入れる（前回の移行で配信中として入れた人も、ここで止まる）
    const progress: FriendScenarioProgress = sc.status === "following" ? followingProgress(sourceScenarioId, startedMs, f, ctx)
      : sc.status === "completed" ? { status: "completed", currentOrder: 9999, nextAt: null }
      : { status: "paused", currentOrder: -1, nextAt: null };
    if (sc.status !== "completed" && sc.status !== "following") stats.scenarioStopped += 1;
    if (progress.status === "active") stats.scenarioRestored += 1;
    if (progress.status === "paused" && sc.status === "following") stats.scenarioUnknown += 1;
    ctx.add({
      table: "friend_scenarios",
      values: {
        id: ctx.id("friend_scenario", s.row.lmessage_friend_id, sourceScenarioId),
        friend_id: f.id,
        scenario_id: scenarioId,
        current_step_order: progress.currentOrder,
        status: progress.status,
        started_at: sourceToHarnessJst(sc.started_at, f.followed),
        next_delivery_at: progress.nextAt,
        updated_at: ctx.now,
      },
      update: ["status", "current_step_order", "next_delivery_at", "started_at", "updated_at"],
      merge: { updated_at: newerTimestamp("friend_scenarios") },
      // L Harness でシナリオを動かし始めた後は、L Harness 側の進行を上書きしない
      updateWhere: "(SELECT is_active FROM scenarios WHERE scenarios.id = friend_scenarios.scenario_id) = 0",
    });
    stats.scenarios += 1;
    sr.migrated += 1;
  }
}

interface FriendScenarioProgress {
  status: "completed" | "active" | "paused";
  currentOrder: number;
  nextAt: string | null;
}

/** 配信中の人: 会話履歴の送信記録から「何通目まで届いたか」を復元する */
function followingProgress(sourceScenarioId: number, startedMs: number | null, f: FriendInfo, ctx: PlanContext): FriendScenarioProgress {
  const info = ctx.scenarioSteps.get(sourceScenarioId);
  const progress = info && info.steps.length ? restoreProgress(info, f.snap.conversation?.messages ?? [], startedMs) : null;
  if (!info || !progress) {
    // 履歴が開始時点まで残っていない: 位置が分からないので一時停止で残す（L Harness では自動では再開しない）
    return { status: "paused", currentOrder: -1, nextAt: null };
  }
  const next = info.steps[progress.lastIndex + 1];
  if (!next) return { status: "completed", currentOrder: 9999, nextAt: null };
  return {
    status: "active",
    currentOrder: progress.lastIndex >= 0 ? info.steps[progress.lastIndex].lastOrder : -1,
    nextAt: toHarnessJst(nextDeliveryAt(info, next, startedMs ?? Date.parse(ctx.now), progress.lastAt)),
  };
}
