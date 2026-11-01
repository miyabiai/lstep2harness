import type { HarnessApi } from "../harness/api.js";

/**
 * Lステップで作って LINE に登録済みのリッチメニューを、L Harness の管理画面に取り込む。
 *
 * 作り直さずに L Harness 標準の取り込み API（POST /api/rich-menu-groups/import）で「管理対象」にするだけ。
 * LINE 上のメニュー・画像・誰に表示しているか（個別の紐づけ）は一切変わらない。
 * Lステップからはリッチメニューの中身を取得していないので、LINE に登録されているメニューのうち
 * まだ L Harness の管理対象でないものを対象にする（--rich-menu-id で絞れる）。
 */
export interface LineMenu {
  richMenuId: string;
  name: string;
  chatBarText?: string;
  size?: { width: number; height: number };
  areasCount?: number;
  isCurrentDefault?: boolean;
  adminManaged?: boolean;
  adminInfo?: { groupId: string; groupName: string } | null;
}

export interface RichMenuResult {
  step: "richmenu";
  dryRun: boolean;
  /** LINE 上のメニューの数 */
  onLine: number;
  menus: Array<{ name: string; richMenuId: string; isDefault: boolean; status: "imported" | "would-import" | "already" | "failed" | "skipped"; note?: string }>;
}

/** Lステップのクリック計測などを通るリンク（Lステップ解約後に開けなくなる） */
export function isLstepTrackingUrl(uri: string): boolean {
  try {
    return /(^|\.)(lstep\.app|linestep\.jp|lineml\.jp|lstep\.jp)$/i.test(new URL(uri).hostname);
  } catch {
    return false;
  }
}

export async function runRichMenu(api: HarnessApi, lineAccountId: string, options: { dryRun?: boolean; only?: string[] } = {}): Promise<RichMenuResult> {
  const account = encodeURIComponent(lineAccountId);
  const ext = await api.request<{ lineMenus?: LineMenu[] }>("GET", `/api/rich-menu-groups/external?accountId=${account}`);
  if (!Array.isArray(ext.lineMenus)) throw new Error("L Harness のリッチメニュー一覧の応答の形が想定と違います（lineMenus がありません）。L Harness の版を確認してください。0件とは扱いません");
  const lineMenus = ext.lineMenus;
  const only = new Set(options.only ?? []);
  const result: RichMenuResult = { step: "richmenu", dryRun: Boolean(options.dryRun), onLine: lineMenus.length, menus: [] };
  for (const menu of lineMenus) {
    const base = { name: menu.name, richMenuId: menu.richMenuId, isDefault: Boolean(menu.isCurrentDefault) };
    if (only.size && !only.has(menu.richMenuId)) {
      result.menus.push({ ...base, status: "skipped" });
      continue;
    }
    if (menu.adminManaged) {
      result.menus.push({ ...base, status: "already", note: menu.adminInfo?.groupName });
      continue;
    }
    if (options.dryRun) {
      result.menus.push({ ...base, status: "would-import" });
      continue;
    }
    try {
      const group = await api.request<{ id: string }>("POST", `/api/rich-menu-groups/import?accountId=${account}&richMenuId=${encodeURIComponent(menu.richMenuId)}`);
      const tracking = await trackingButtons(api, group.id);
      result.menus.push({
        ...base, status: "imported",
        ...(tracking === null
          ? { note: "取り込んだ後のボタンのリンク先を確認できませんでした。Lステップを解約する前に、L Harness の管理画面でリンク先が Lステップ経由になっていないか確認してください" }
          : tracking ? { note: `ボタン ${tracking}個のリンクが Lステップ経由です。Lステップ解約後に開けなくなるので、切り替え時に L Harness の管理画面で元のリンク先に差し替えてください` } : {}),
      });
    } catch (error) {
      result.menus.push({ ...base, status: "failed", note: (error as Error).message });
    }
  }
  return result;
}

/** 取り込んだメニューのボタンのうち、Lステップ経由のリンクの数（確認できなければ null＝未確認） */
async function trackingButtons(api: HarnessApi, groupId: string): Promise<number | null> {
  try {
    const group = await api.request<{ pages?: Array<{ areas?: Array<{ actionType: string; actionData?: { uri?: string } }> }> }>("GET", `/api/rich-menu-groups/${encodeURIComponent(groupId)}`);
    return (group.pages ?? []).flatMap((page) => page.areas ?? [])
      .filter((area) => area.actionType === "uri" && isLstepTrackingUrl(area.actionData?.uri ?? "")).length;
  } catch {
    return null;
  }
}
