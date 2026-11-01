import type { SnapshotStore } from "../snapshot/store.js";
import type { PlanContext } from "./context.js";
import type { SourceFormDetail, SourceFormField, SourceFormResponse } from "../source/types.js";
import { sourceToHarnessJst } from "../harness/time.js";
import { htmlToText } from "./text.js";
import { firstMappedTagId, tagIdsFromActions, textFromActions } from "./masters.js";
import { newerTimestamp, quote } from "../sql/render.js";

/**
 * 移行元のフォーム → L Harness forms.fields（JSON 配列）
 * L Harness の type: text / email / tel / number / textarea / select / radio / checkbox / date
 */
interface HarnessField {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  options?: string[];
  placeholder?: string;
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function convertFormField(f: SourceFormField, usedNames: Set<string>): { field: HarnessField | null; skippedReason?: string } {
  let type = (f.type ?? "").toLowerCase();
  const title = (f.title ?? f.label ?? "").trim();
  const label = (f.label ?? "").trim();
  const settingsPeek = parseJson<{ type?: string }>(f.settings ?? null, {});
  if (type === "text_new") {
    // 移行元の text_new は 2 用途ある:
    //  - 「テキスト」ブロック（説明文。label が「テキスト」）→ 入力欄ではない
    //  - 「よく使われる項目」（名前・メールアドレス・電話番号・生年月日・国内住所・性別）→ 入力欄
    if (label === "テキスト" || title === "テキスト" || (!label && !title)) {
      return { field: null, skippedReason: "説明文（入力欄ではない）" };
    }
    const st = (settingsPeek.type ?? "").toLowerCase();
    type = st === "email" ? "email" : st === "tel" || /電話/.test(label) ? "tel" : /生年月日|誕生日/.test(label) ? "date" : /性別/.test(label) ? "select" : "text";
    if (type === "select" && !f.settings?.includes("items")) {
      // 性別は選択肢が settings に無いことがあるので固定の候補にする
      f = { ...f, settings: JSON.stringify({ type: "select", items: [{ label: "男性", value: "男性" }, { label: "女性", value: "女性" }, { label: "その他", value: "その他" }] }) };
    }
  }
  if (type === "html" || type === "heading" || type === "description") {
    return { field: null, skippedReason: "説明文（入力欄ではない）" };
  }
  if (type.includes("file") || type.includes("image")) {
    return { field: null, skippedReason: "ファイル添付（L Harness のフォームに無い）" };
  }
  const rules = parseJson<{ required?: boolean }>(f.rules, {});
  const settings = parseJson<{ type?: string; items?: Array<{ label?: string; value?: string }>; multiple?: boolean }>(f.settings ?? null, {});
  let name = title || `field_${f.id}`;
  if (usedNames.has(name)) {
    let i = 2;
    while (usedNames.has(`${name}_${i}`)) i++;
    name = `${name}_${i}`;
  }
  usedNames.add(name);
  const base: Omit<HarnessField, "type"> = { name, label: title || name, required: Boolean(rules.required) };
  if (f.placeholder) base.placeholder = f.placeholder;
  const options = (settings.items ?? []).map((it) => (it.label ?? it.value ?? "").trim()).filter(Boolean);
  if (type.startsWith("select") || type === "radio" || type === "checkbox" || type === "dropdown") {
    if (!options.length) return { field: null, skippedReason: "選択肢が取得できていない項目" };
    if (type === "checkbox" || settings.multiple) return { field: { ...base, type: "checkbox", options } };
    if (type === "radio") return { field: { ...base, type: "radio", options } };
    return { field: { ...base, type: "select", options } };
  }
  if (type.startsWith("date")) return { field: { ...base, type: "date" } };
  if (type === "email") return { field: { ...base, type: "email" } };
  if (type === "tel" || type === "phone") return { field: { ...base, type: "tel" } };
  if (type === "number" || type === "point") return { field: { ...base, type: "number" } };
  if (type === "textarea" || type === "text_area") return { field: { ...base, type: "textarea" } };
  if (type === "text" || type === "input" || type === "string") return { field: { ...base, type: "text" } };
  return { field: null, skippedReason: "未対応の入力項目" };
}

function answerValue(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as { date?: string; time?: string; value?: unknown };
    if (o.date) {
      const d = o.date.replace(/\//g, "-");
      return o.time ? `${d} ${o.time}` : d;
    }
    if ("value" in o) return o.value;
    return JSON.stringify(v);
  }
  return v ?? "";
}

export function mapForms(store: SnapshotStore, ctx: PlanContext): void {
  const forms = store.readJson<SourceFormDetail[]>("forms.json");
  const r = ctx.report("forms", "フォーム");
  const rr = ctx.report("form_submissions", "フォーム回答");
  if (!forms) {
    r.level = "none";
    r.notes.push("取得データにフォーム定義がありません");
    return;
  }
  r.source = forms.length;
  for (const form of forms) {
    if (form.incomplete) {
      // 設問を取れなかったフォームは、移行先に作らず・変えない（「設問なし」として入れると、前に入れた設問を消してしまう）。回答もその回に入れない
      r.skipped += 1;
      r.level = "partial";
      ctx.note("forms", "フォーム", "設問を取得できなかったフォームは移していません（移行先に前から入っていれば、そのまま変えていません）。取得し直してください");
      const held = store.readJson<SourceFormResponse[]>(`form_responses/${form.id}.json`) ?? [];
      rr.source += held.length;
      rr.skipped += held.length;
      if (held.length) ctx.note("form_submissions", "フォーム回答", "設問を取得できなかったフォームの回答は、取得結果に保存するだけで移していません");
      continue;
    }
    const { fields, skipped, nameByTitle } = convertFormFields(form);
    // 取れていない・解釈できない設問があるフォームは、移行先に前からあれば設問を書き換えない（欠けた設問で上書きして消さないため）。新しく作るときは取れた設問だけで作る
    const guarded = Boolean(form.unsupported_fields) || skipped.some((reason) => /選択肢が取得できていない|未対応の入力項目/.test(reason));
    const formId = ctx.id("form", form.id);
    ctx.formIds.set(form.id, formId);
    const tagIds = tagIdsFromActions(form.actions_on_reply);
    const thanks = textFromActions(form.actions_on_reply);
    const name = form.title?.trim() || form.name;
    ctx.add({
      table: "forms",
      values: {
        id: formId,
        name,
        description: [form.name !== form.title ? `（Lステップ管理名: ${form.name}）` : "", htmlToText(form.description)].filter(Boolean).join("\n") || null,
        fields: JSON.stringify(fields),
        on_submit_tag_id: firstMappedTagId(ctx, tagIds),
        on_submit_scenario_id: null,
        on_submit_message_type: thanks ? "text" : null,
        on_submit_message_content: thanks,
        save_to_metadata: 1,
        is_active: 0,
        submit_count: 0,
        created_at: sourceToHarnessJst(form.created_at, ctx.now),
        updated_at: ctx.now,
      },
      update: ["name", "description", ...(guarded ? [] : ["fields"]), "on_submit_tag_id", "on_submit_message_type", "on_submit_message_content", "is_active", "updated_at"],
      merge: { updated_at: newerTimestamp("forms") },
      // 回答数は投入の後に数え直す（L Harness が受けた回答も含む）ので、値では照合しない
      verify: ["id", "name", "description", ...(guarded ? [] : ["fields"]), "on_submit_tag_id", "on_submit_scenario_id", "on_submit_message_type", "on_submit_message_content", "save_to_metadata", "is_active", "created_at", "updated_at"],
    });
    if (guarded) ctx.note("forms", "フォーム", "取れていない・未対応の設問があるフォームは、移行先に前からあれば設問を書き換えていません（取れた設問だけで新しく作るときを除く）");
    r.migrated += 1;
    for (const s of new Set(skipped)) ctx.note("forms", "フォーム", `移せない項目があります: ${s}`);
    if (skipped.length) r.level = "partial";
    if (form.actions_on_open?.length) ctx.note("forms", "フォーム", "「開封時」のアクションは L Harness に無いため移していません");
    if (tagIds.length > 1) {
      ctx.note("forms", "フォーム", "回答時に複数タグを付ける設定は最初のタグだけ移しました");
      r.level = "partial";
    }

    const responses = store.readJson<SourceFormResponse[]>(`form_responses/${form.id}.json`) ?? [];
    rr.source += responses.length;
    const submitCount = addFormSubmissions(form.id, formId, responses, nameByTitle, ctx);
    rr.migrated += submitCount;
    // 回答数は、回答を入れた後に移行先の実際の行数で数え直す（移行し直しで、L Harness が受けた回答の分を減らさない）
    ctx.add({
      table: "form_submissions",
      values: { form_id: formId },
      sql: `UPDATE forms SET submit_count = (SELECT COUNT(*) FROM form_submissions WHERE form_submissions.form_id = ${quote(formId)}) WHERE id = ${quote(formId)};`,
    });
  }
  if (r.migrated) r.notes.push("回答はL Harnessの「回答一覧」に入ります。添付ファイルは移行元のURLを回答データに残しています");
}

/** フォームの全ページの項目を位置順に変換する。nameByTitle は移行元の回答の name（=タイトル）→ L Harness の name */
function convertFormFields(form: SourceFormDetail): { fields: HarnessField[]; skipped: string[]; nameByTitle: Map<string, string | null> } {
  const usedNames = new Set<string>();
  const fields: HarnessField[] = [];
  const skipped: string[] = [];
  // 回答は設問のタイトルでしか対応付けられない。同じタイトルの設問が複数あるもの（移さない設問も含めて数える）は null（対応付け不可）にする
  const nameByTitle = new Map<string, string | null>();
  const titleCounts = new Map<string, number>();
  for (const page of form.pages ?? []) for (const f of page.fields ?? []) if (f.title) titleCounts.set(f.title, (titleCounts.get(f.title) ?? 0) + 1);
  for (const title of form.excluded_field_titles ?? []) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  for (const [title, count] of titleCounts) if (count > 1) nameByTitle.set(title, null);
  for (const page of form.pages ?? []) {
    for (const f of [...(page.fields ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
      const { field, skippedReason } = convertFormField(f, usedNames);
      if (!field) {
        if (skippedReason) skipped.push(skippedReason);
        continue;
      }
      fields.push(field);
      if (f.title) nameByTitle.set(f.title, (titleCounts.get(f.title) ?? 0) > 1 ? null : field.name);
    }
  }
  return { fields, skipped, nameByTitle };
}

/** 設問に対応付けられない回答の退避欄 */
const UNMATCHED_KEY = "_unmatched_answers";

/** 回答 → form_submissions。入れた件数を返す */
function addFormSubmissions(sourceFormId: number, formId: string, responses: SourceFormResponse[], nameByTitle: Map<string, string | null>, ctx: PlanContext): number {
  let count = 0;
  for (const resp of responses) {
    // __proto__ のような設問名でも普通の項目として残せるよう、継承のない入れ物を使う
    const data: Record<string, unknown> = Object.create(null);
    // 移した設問に1対1で対応する回答だけを通常の欄に入れる。それ以外（移さない設問・同じタイトルの設問・
    // 同じ回答内での重複）は、名前が偶然ほかの欄と重なっても入り込まないよう、すべて退避欄に残す
    const unmatched: Array<{ name: string; value: unknown }> = [];
    for (const a of resp.answers ?? []) {
      const key = nameByTitle.get(a.name);
      if (!key || key === UNMATCHED_KEY || Object.hasOwn(data, key)) {
        unmatched.push({ name: a.name, value: answerValue(a.value) });
        continue;
      }
      data[key] = answerValue(a.value);
    }
    if (unmatched.length) {
      data[UNMATCHED_KEY] = unmatched;
      ctx.note("form_submissions", "フォーム回答", "移していない設問や同じ名前の設問への回答は、設問に対応付けずに回答データの _unmatched_answers に残しています");
      ctx.report("form_submissions", "フォーム回答").level = "partial";
    }
    const friendId = ctx.friendIds.has(resp.lmessage_friend_id) ? ctx.friendId(resp.lmessage_friend_id) : null;
    if (!friendId) {
      ctx.note("form_submissions", "フォーム回答", "友だち一覧に無い人（削除済み等）の回答は友だちに紐づけず保存しました");
    }
    ctx.add({
      table: "form_submissions",
      values: {
        id: ctx.id("form_submission", sourceFormId, resp.id),
        form_id: formId,
        friend_id: friendId,
        data: JSON.stringify(data),
        created_at: sourceToHarnessJst(resp.answered_at, ctx.now),
      },
      update: ["data", "friend_id"],
    });
    count += 1;
  }
  return count;
}
