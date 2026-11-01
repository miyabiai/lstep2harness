import { isHttpUrl } from "../util.js";

/** API キーを送ってよい URL か（https、または手元で動かす L Harness の http://localhost・127.0.0.1） */
export function isSafeHarnessUrl(value: string): boolean {
  if (!isHttpUrl(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * L Harness（line-harness-oss）の管理 API。Bearer API キー。
 * 使うのは読み取りと、リッチメニューの取り込み・プロフィールの取り直しなど既存の口だけ。
 * 友だち・会話の投入は API に口が無いので D1 へ直接書く（harness/remote.ts）。
 */
export class HarnessApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HarnessApiError";
  }
}

export interface HarnessLineAccount {
  id: string;
  channelId: string;
  name: string;
  isActive: boolean;
}

export class HarnessApi {
  readonly baseUrl: string;

  constructor(baseUrl: string, private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {
    if (!isSafeHarnessUrl(baseUrl)) throw new Error("L Harness の URL は https://… で指定してください（API キーを送るため）");
    if (!apiKey) throw new Error("HARNESS_API_KEY（.env）が空です");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async request<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json: { success?: boolean; data?: T; error?: string } & Record<string, unknown> = {};
    try {
      json = (await res.json()) as typeof json;
    } catch {
      /* 本文なし */
    }
    if (!res.ok || json.success === false) {
      // API の返す文は短く切る（L Harness の版によって詳細が入ることがあるため）
      const reason = typeof json.error === "string" ? `: ${json.error.slice(0, 200)}` : "";
      throw new HarnessApiError(`L Harness API ${method} ${path.split("?")[0]} が失敗しました (HTTP ${res.status}${reason})`, res.status);
    }
    return (json.data ?? json) as T;
  }

  async lineAccounts(): Promise<HarnessLineAccount[]> {
    const data = await this.request<HarnessLineAccount[] | { items: HarnessLineAccount[] }>("GET", "/api/line-accounts");
    return Array.isArray(data) ? data : (data?.items ?? []);
  }
}
