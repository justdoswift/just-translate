import {
  DEFAULT_SETTINGS,
  LANGUAGES,
  apiOriginPattern,
  normalizeBaseUrl,
  type Settings,
  type SettingsView,
} from "../shared";
import { RequestError } from "./errors";

const SETTINGS_KEY = "justTranslate.settings";
const API_KEY = "justTranslate.apiKey";

export function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== "object")
    throw new RequestError("configuration", "设置格式不正确。");
  const item = value as Record<string, unknown>;
  if (item.provider !== "deepseek" && item.provider !== "custom")
    throw new RequestError("configuration", "请选择支持的服务商。");
  if (typeof item.baseUrl !== "string" || item.baseUrl.length > 2048)
    throw new RequestError("configuration", "API 基础地址不正确。");
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(item.baseUrl);
  } catch {
    throw new RequestError(
      "configuration",
      "API 地址必须是 HTTPS 或本机 HTTP 基础地址，且不能包含凭据、查询参数或 /chat/completions。",
    );
  }
  if (
    typeof item.model !== "string" ||
    !item.model.trim() ||
    item.model.length > 160 ||
    /[\r\n]/.test(item.model)
  )
    throw new RequestError("configuration", "请输入有效的模型名称。");
  if (
    typeof item.targetLanguage !== "string" ||
    !LANGUAGES.some((language) => language.value === item.targetLanguage)
  )
    throw new RequestError("configuration", "请选择支持的目标语言。");
  if (item.displayMode !== "bilingual" && item.displayMode !== "translation")
    throw new RequestError("configuration", "请选择支持的显示模式。");
  for (const field of [
    "jsonMode",
    "disableThinking",
    "rememberKey",
    "persistentCache",
  ] as const) {
    if (typeof item[field] !== "boolean")
      throw new RequestError("configuration", "设置中的开关值不正确。");
  }
  for (const [field, maximum, integer] of [
    ["cacheDays", 365, true],
    ["monthlyBudgetUsd", 1_000_000, false],
    ["pageTokenLimit", 100_000_000, true],
    ["inputPricePerMillion", 100_000, false],
    ["outputPricePerMillion", 100_000, false],
  ] as const) {
    const number = item[field];
    if (
      typeof number !== "number" ||
      !Number.isFinite(number) ||
      number < (field === "cacheDays" ? 1 : 0) ||
      number > maximum ||
      (integer && !Number.isInteger(number))
    ) {
      throw new RequestError(
        "configuration",
        `设置中的 ${field} 超出有效范围。`,
      );
    }
  }
  return {
    provider: item.provider,
    baseUrl,
    model: item.model.trim(),
    targetLanguage: item.targetLanguage,
    displayMode: item.displayMode,
    jsonMode: item.jsonMode as boolean,
    disableThinking: item.disableThinking as boolean,
    rememberKey: item.rememberKey as boolean,
    persistentCache: item.persistentCache as boolean,
    cacheDays: item.cacheDays as number,
    monthlyBudgetUsd: item.monthlyBudgetUsd as number,
    pageTokenLimit: item.pageTokenLimit as number,
    inputPricePerMillion: item.inputPricePerMillion as number,
    outputPricePerMillion: item.outputPricePerMillion as number,
  };
}

export function validateKey(value: unknown, required = true): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\r\n\x00]/.test(value)
  )
    throw new RequestError("configuration", "API Key 格式不正确。");
  const key = value.trim();
  if (required && !key)
    throw new RequestError("configuration", "请先在设置中填写自己的 API Key。");
  return key;
}

export async function requireApiPermission(settings: Settings): Promise<void> {
  if (
    !(await chrome.permissions.contains({
      origins: [apiOriginPattern(settings.baseUrl)],
    }))
  ) {
    throw new RequestError(
      "permission",
      "尚未授权访问 API 服务；请打开设置并重新保存或测试连接。",
    );
  }
}

export class SettingsStore {
  private current: Settings = { ...DEFAULT_SETTINGS };
  private key = "";
  fingerprint = "";

  async initialize(): Promise<void> {
    await Promise.all([
      chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
      chrome.storage.session.setAccessLevel({
        accessLevel: "TRUSTED_CONTEXTS",
      }),
    ]);
    const [local, session] = await Promise.all([
      chrome.storage.local.get([SETTINGS_KEY, API_KEY]),
      chrome.storage.session.get(API_KEY),
    ]);
    if (local[SETTINGS_KEY]) {
      try {
        this.current = validateSettings({
          ...DEFAULT_SETTINGS,
          ...local[SETTINGS_KEY],
        });
      } catch {
        this.current = { ...DEFAULT_SETTINGS };
      }
    }
    const stored = this.current.rememberKey ? local[API_KEY] : session[API_KEY];
    try {
      this.key = validateKey(stored ?? "", false);
    } catch {
      this.key = "";
    }
    this.fingerprint = await accountFingerprint(this.key);
    if (this.current.rememberKey) await chrome.storage.session.remove(API_KEY);
    else await chrome.storage.local.remove(API_KEY);
  }

  view(): SettingsView {
    return {
      settings: { ...this.current },
      apiKey: this.key,
      configured: Boolean(this.key),
    };
  }

  async save(settings: Settings, apiKey: string): Promise<SettingsView> {
    const next = validateSettings(settings);
    const key = validateKey(apiKey, false);
    await requireApiPermission(next);
    const fingerprint = await accountFingerprint(key);
    if (next.rememberKey) {
      await chrome.storage.local.set({ [SETTINGS_KEY]: next, [API_KEY]: key });
      await chrome.storage.session.remove(API_KEY);
    } else {
      await chrome.storage.session.set({ [API_KEY]: key });
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
      await chrome.storage.local.remove(API_KEY);
    }
    this.current = next;
    this.key = key;
    this.fingerprint = fingerprint;
    return this.view();
  }
}

export async function accountFingerprint(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
