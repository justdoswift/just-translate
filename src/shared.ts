export const APP_VERSION = "0.2.0";
export const STARTUP_ERROR_KEY = "justTranslate.startupError";
export const PROMPT_VERSION = "2";
export const MAX_BATCH_SEGMENTS = 8;
export const MAX_BATCH_CHARS = 5500;
export const MAX_SEGMENT_CHARS = 2400;
export const LANGUAGES = [
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
] as const;

export type DisplayMode = "bilingual" | "translation";

export interface Settings {
  provider: "deepseek" | "custom";
  baseUrl: string;
  model: string;
  targetLanguage: string;
  displayMode: DisplayMode;
  jsonMode: boolean;
  disableThinking: boolean;
  rememberKey: boolean;
  persistentCache: boolean;
  cacheDays: number;
  monthlyBudgetUsd: number;
  pageTokenLimit: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  targetLanguage: "zh-CN",
  displayMode: "bilingual",
  jsonMode: true,
  disableThinking: true,
  rememberKey: false,
  persistentCache: false,
  cacheDays: 7,
  monthlyBudgetUsd: 5,
  pageTokenLimit: 50000,
  inputPricePerMillion: 0.3,
  outputPricePerMillion: 1.2,
};

export type ErrorCode =
  | "configuration"
  | "permission"
  | "authentication"
  | "quota"
  | "rate_limit"
  | "network"
  | "timeout"
  | "invalid_response"
  | "budget"
  | "stale"
  | "cancelled"
  | "interrupted"
  | "unsupported"
  | "internal";
export interface AppError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  uncertain?: boolean;
}
export type Reply<T> = { ok: true; value: T } | { ok: false; error: AppError };
export interface SettingsView {
  settings: Settings;
  apiKey: string;
  configured: boolean;
}
export interface Segment {
  id: string;
  revision: number;
  text: string;
  context: string;
}
export interface Translation {
  id: string;
  revision: number;
  text: string;
  cached: boolean;
}
export interface BatchResult {
  translations: Translation[];
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}
export type PagePhase = "running" | "waiting" | "partial" | "blocked" | "off";
export interface PageProgress {
  sessionId: string;
  phase: PagePhase;
  translated: number;
  pending: number;
  failed: number;
  message?: string;
}
export interface Usage {
  month: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  cacheHits: number;
  uncertainRequests: number;
  estimatedRequests: number;
}
export interface UsageView {
  usage: Usage;
  cacheEntries: number;
}

export type BackgroundMessage =
  | { type: "settings:get" }
  | { type: "settings:save"; settings: Settings; apiKey: string }
  | { type: "connection:test"; settings: Settings; apiKey: string }
  | { type: "usage:get" }
  | { type: "cache:clear" }
  | {
      type: "page:translate";
      sessionId: string;
      requestId: string;
      segments: Segment[];
    }
  | { type: "page:progress"; progress: PageProgress }
  | { type: "page:end"; sessionId: string; reason: string }
  | { type: "options:open" };

export type PageMessage =
  | {
      type: "page:start";
      sessionId: string;
      targetLanguage: string;
      displayMode: DisplayMode;
    }
  | { type: "page:stop"; sessionId?: string; reason?: string }
  | { type: "page:ping" };

export async function sendMessage<T>(
  message: BackgroundMessage,
): Promise<Reply<T>> {
  try {
    const reply: unknown = await chrome.runtime.sendMessage(message);
    if (reply && typeof reply === "object" && "ok" in reply)
      return reply as Reply<T>;
    return {
      ok: false,
      error: {
        code: "interrupted",
        message: "扩展后台暂时不可用，请重试。",
        retryable: true,
        uncertain: true,
      },
    };
  } catch {
    return {
      ok: false,
      error: {
        code: "interrupted",
        message: "后台连接已中断；尚未确认的请求不会自动重发。",
        retryable: true,
        uncertain: true,
      },
    };
  }
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("API 地址必须使用 HTTPS；本机服务可使用 HTTP。");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("API 地址不能包含账号、密码、查询参数或锚点。");
  if (/\/chat\/completions\/?$/.test(url.pathname))
    throw new Error("请填写基础地址，不要包含 /chat/completions。");
  return url.href.replace(/\/+$/, "");
}

export function apiOriginPattern(baseUrl: string): string {
  const url = new URL(normalizeBaseUrl(baseUrl));
  return `${url.protocol}//${url.hostname}/*`;
}

export function languageLabel(code: string): string {
  return LANGUAGES.find((language) => language.value === code)?.label ?? code;
}
