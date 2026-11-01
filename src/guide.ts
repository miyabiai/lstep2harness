import { fileURLToPath, pathToFileURL } from "node:url";

export const TUTORIAL_CHAPTERS = [
  "line-messaging-api", "line-login", "liff", "cloudflare-account", "cloudflare-r2",
  "cloudflare-api-token", "save-credentials", "lstep-login", "migration-review",
] as const;

export type TutorialChapter = typeof TUTORIAL_CHAPTERS[number];

/** リポジトリ同梱の案内。ネットワーク接続やブラウザ起動は行わない。 */
export function tutorialUrl(chapter?: TutorialChapter): string {
  const page = fileURLToPath(new URL("../docs/tutorials/index.html", import.meta.url));
  return `${pathToFileURL(page).href}${chapter ? `#${chapter}` : ""}`;
}

export function tutorialMessage(chapter: TutorialChapter): string {
  return `操作の案内（実画面の動画・手順）: ${tutorialUrl(chapter)}`;
}
