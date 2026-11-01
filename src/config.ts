/** 変換時の扱い。今の版では固定値で、利用者が変える入口はない。 */
export interface MigrationOptions {
  /** 対応マークをタグとしても付ける */
  handling_status_as_tag: boolean;
  /** 友だち情報を metadata の最上位にも置く */
  friend_info_top_level: boolean;
  /** 同名のタグが移行先にあれば作らずに使う */
  reuse_existing_tags: boolean;
  /** ブロック中の友だちも移す */
  include_blocked: boolean;
}

export const DEFAULT_OPTIONS: MigrationOptions = {
  handling_status_as_tag: true,
  friend_info_top_level: true,
  reuse_existing_tags: true,
  include_blocked: true,
};
