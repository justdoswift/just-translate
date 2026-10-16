import "./style.css";
import {
  APP_VERSION,
  DEFAULT_SETTINGS,
  LANGUAGES,
  apiOriginPattern,
  normalizeBaseUrl,
  sendMessage,
  type Settings,
  type SettingsView,
  type UsageView,
} from "../../src/shared";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing settings control: ${id}`);
  return found as T;
}

const form = element<HTMLFormElement>("settings-form");
const fields = element<HTMLFieldSetElement>("settings-fields");
const status = element<HTMLParagraphElement>("form-status");
const connectionState = element<HTMLSpanElement>("connection-state");
const saveButton = element<HTMLButtonElement>("save-settings");
const testButton = element<HTMLButtonElement>("test-connection");
const keyInput = element<HTMLInputElement>("api-key");
const baseUrlInput = element<HTMLInputElement>("base-url");
const modelInput = element<HTMLInputElement>("model");
const languageSelect = element<HTMLSelectElement>("target-language");
let loadedSettings: Settings = { ...DEFAULT_SETTINGS };
let keyOrigin = "";
let busy = false;
let initialized = false;

function feedback(
  message: string,
  kind: "neutral" | "success" | "error" = "neutral",
): void {
  status.textContent = message;
  status.dataset.kind = kind;
}

function setConnectionState(
  message: string,
  state: "neutral" | "ready" | "error" = "neutral",
): void {
  connectionState.textContent = message;
  connectionState.dataset.state = state;
}

function populate(view: SettingsView): void {
  loadedSettings = view.settings;
  const provider = form.querySelector<HTMLInputElement>(
    `input[name="provider"][value="${view.settings.provider}"]`,
  );
  if (provider) provider.checked = true;
  baseUrlInput.value = view.settings.baseUrl;
  modelInput.value = view.settings.model;
  keyInput.value = view.apiKey;
  keyInput.type = "password";
  element<HTMLButtonElement>("show-key").textContent = "显示";
  element<HTMLButtonElement>("show-key").setAttribute("aria-pressed", "false");
  languageSelect.value = view.settings.targetLanguage;
  element<HTMLInputElement>("remember-key").checked = view.settings.rememberKey;
  element<HTMLInputElement>("json-mode").checked = view.settings.jsonMode;
  element<HTMLInputElement>("disable-thinking").checked =
    view.settings.disableThinking;
  element<HTMLInputElement>("persistent-cache").checked =
    view.settings.persistentCache;
  element<HTMLInputElement>("cache-days").value = String(
    view.settings.cacheDays,
  );
  element<HTMLInputElement>("monthly-budget").value = String(
    view.settings.monthlyBudgetUsd,
  );
  element<HTMLInputElement>("input-price").value = String(
    view.settings.inputPricePerMillion,
  );
  element<HTMLInputElement>("output-price").value = String(
    view.settings.outputPricePerMillion,
  );
  element<HTMLInputElement>("page-token-limit").value = String(
    view.settings.pageTokenLimit,
  );
  keyOrigin = new URL(view.settings.baseUrl).origin;
  setConnectionState(
    view.configured ? "已配置模型" : "尚未配置",
    view.configured ? "ready" : "neutral",
  );
}

function collectSettings(): Settings {
  const provider = form.querySelector<HTMLInputElement>(
    'input[name="provider"]:checked',
  );
  return {
    ...loadedSettings,
    provider: provider?.value === "custom" ? "custom" : "deepseek",
    baseUrl: normalizeBaseUrl(baseUrlInput.value),
    model: modelInput.value.trim(),
    targetLanguage: languageSelect.value,
    rememberKey: element<HTMLInputElement>("remember-key").checked,
    jsonMode: element<HTMLInputElement>("json-mode").checked,
    disableThinking: element<HTMLInputElement>("disable-thinking").checked,
    persistentCache: element<HTMLInputElement>("persistent-cache").checked,
    cacheDays: element<HTMLInputElement>("cache-days").valueAsNumber,
    monthlyBudgetUsd: element<HTMLInputElement>("monthly-budget").valueAsNumber,
    inputPricePerMillion:
      element<HTMLInputElement>("input-price").valueAsNumber,
    outputPricePerMillion:
      element<HTMLInputElement>("output-price").valueAsNumber,
    pageTokenLimit: element<HTMLInputElement>("page-token-limit").valueAsNumber,
  };
}

async function submitConfiguration(testOnly: boolean): Promise<void> {
  if (busy || !form.reportValidity()) return;
  let settings: Settings;
  try {
    settings = collectSettings();
  } catch (error) {
    baseUrlInput.setCustomValidity(
      error instanceof Error ? error.message : "请检查 API 基础地址。",
    );
    baseUrlInput.reportValidity();
    baseUrlInput.focus();
    return;
  }
  const apiKey = keyInput.value.trim();
  if (!apiKey) {
    keyInput.setCustomValidity("请输入 API Key。");
    keyInput.reportValidity();
    return;
  }
  busy = true;
  fields.disabled = true;
  const activeButton = testOnly ? testButton : saveButton;
  const originalLabel = activeButton.textContent;
  activeButton.textContent = testOnly ? "正在测试…" : "正在保存…";
  feedback(
    testOnly ? "正在翻译固定测试短句，不会读取当前网页。" : "正在保存配置…",
  );
  try {
    // Must originate in this user gesture, not in a background request.
    const granted = await chrome.permissions.request({
      origins: [apiOriginPattern(settings.baseUrl)],
    });
    if (!granted) {
      feedback(
        "未获得模型 API 域名权限。配置尚未保存，请允许访问后重试。",
        "error",
      );
      return;
    }
    if (testOnly) {
      const reply = await sendMessage<{ translation: string }>({
        type: "connection:test",
        settings,
        apiKey,
      });
      if (!reply.ok) {
        setConnectionState("连接失败", "error");
        feedback(reply.error.message, "error");
      } else {
        setConnectionState("连接正常", "ready");
        feedback(
          `测试译文：${reply.value.translation}。修改后的配置仍需保存。`,
          "success",
        );
      }
      await refreshUsage();
    } else {
      const reply = await sendMessage<SettingsView>({
        type: "settings:save",
        settings,
        apiKey,
      });
      if (!reply.ok) {
        feedback(reply.error.message, "error");
        return;
      }
      // Read back the saved state, rather than displaying the outgoing payload as success.
      const persisted = await sendMessage<SettingsView>({
        type: "settings:get",
      });
      if (!persisted.ok) {
        feedback("保存请求已完成，但无法重新读取配置。请刷新后确认。", "error");
        return;
      }
      populate(persisted.value);
      feedback(
        "设置已保存。回到网页，点击工具栏中的 Just Translate 图标即可翻译。",
        "success",
      );
    }
  } catch {
    feedback("无法完成操作。输入内容已保留，请检查扩展权限后重试。", "error");
  } finally {
    busy = false;
    fields.disabled = false;
    activeButton.textContent = originalLabel;
  }
}

async function refreshUsage(): Promise<void> {
  const button = element<HTMLButtonElement>("refresh-usage");
  button.disabled = true;
  try {
    const result = await sendMessage<UsageView>({ type: "usage:get" });
    if (!result.ok) {
      element("usage-note").textContent = result.error.message;
      return;
    }
    const { usage, cacheEntries } = result.value;
    const number = new Intl.NumberFormat("zh-CN");
    element("usage-cost").textContent = `$${usage.estimatedCostUsd.toFixed(4)}`;
    element("usage-tokens").textContent =
      `${number.format(usage.inputTokens)} / ${number.format(usage.outputTokens)}`;
    element("usage-requests").textContent =
      `${number.format(usage.requests)} / ${number.format(usage.cacheHits)}`;
    element("cache-count").textContent =
      `本机缓存 ${number.format(cacheEntries)} 段译文`;
    element("usage-title").textContent = `${usage.month} 用量`;
    const notes = ["费用按配置单价估算，以供应商账单为准。"];
    if (usage.estimatedRequests)
      notes.push(`${usage.estimatedRequests} 次请求的 token 为本地估算。`);
    if (usage.uncertainRequests)
      notes.push(
        `${usage.uncertainRequests} 次请求的计费结果未确认，可能仍有费用。`,
      );
    element("usage-note").textContent = notes.join(" ");
  } finally {
    button.disabled = false;
  }
}

form.addEventListener(
  "invalid",
  (event) => {
    const control = event.target;
    if (control instanceof HTMLElement) {
      const disclosure = control.closest("details");
      if (disclosure) disclosure.open = true;
    }
  },
  true,
);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitConfiguration(false);
});
testButton.addEventListener("click", () => void submitConfiguration(true));
form.addEventListener("input", () => {
  baseUrlInput.setCustomValidity("");
  keyInput.setCustomValidity("");
  if (initialized && !busy) feedback("有未保存的修改。");
});
form
  .querySelectorAll<HTMLInputElement>('input[name="provider"]')
  .forEach((radio) => {
    radio.addEventListener("change", () => {
      const deepseek = radio.value === "deepseek";
      baseUrlInput.value = deepseek ? DEFAULT_SETTINGS.baseUrl : "";
      modelInput.value = deepseek ? DEFAULT_SETTINGS.model : "";
      keyInput.value = "";
      keyOrigin = deepseek ? new URL(DEFAULT_SETTINGS.baseUrl).origin : "";
      element<HTMLInputElement>("json-mode").checked = deepseek;
      element<HTMLInputElement>("disable-thinking").checked = deepseek;
      element<HTMLInputElement>("input-price").value = deepseek
        ? String(DEFAULT_SETTINGS.inputPricePerMillion)
        : "0";
      element<HTMLInputElement>("output-price").value = deepseek
        ? String(DEFAULT_SETTINGS.outputPricePerMillion)
        : "0";
      setConnectionState("尚未测试");
      feedback("已切换服务商。请填写对应密钥；自定义模型请同时填写计费单价。");
    });
  });
baseUrlInput.addEventListener("change", () => {
  try {
    const origin = new URL(normalizeBaseUrl(baseUrlInput.value)).origin;
    if (keyOrigin && keyOrigin !== origin) {
      keyInput.value = "";
      feedback("API 域名已改变。为避免误发密钥，请重新填写该服务的 API Key。");
    }
    keyOrigin = origin;
  } catch {
    // Keep invalid input so the user can correct it; submit surfaces the error.
  }
});
element<HTMLButtonElement>("show-key").addEventListener("click", (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const reveal = keyInput.type === "password";
  keyInput.type = reveal ? "text" : "password";
  button.textContent = reveal ? "隐藏" : "显示";
  button.setAttribute("aria-pressed", String(reveal));
});
element("refresh-usage").addEventListener("click", () => void refreshUsage());
element("clear-cache").addEventListener("click", async () => {
  if (!window.confirm("清除所有会话及本机持久译文缓存？模型配置和密钥会保留。"))
    return;
  const button = element<HTMLButtonElement>("clear-cache");
  button.disabled = true;
  try {
    const reply = await sendMessage<{ cleared: number }>({
      type: "cache:clear",
    });
    if (!reply.ok) {
      element("usage-note").textContent = reply.error.message;
      return;
    }
    await refreshUsage();
    element("usage-note").textContent =
      `已清除 ${reply.value.cleared} 段缓存，模型配置与密钥未改变。`;
  } finally {
    button.disabled = false;
  }
});

for (const language of LANGUAGES) {
  languageSelect.add(new Option(language.label, language.value));
}
element("version").textContent = APP_VERSION;

async function initialize(): Promise<void> {
  const result = await sendMessage<SettingsView>({ type: "settings:get" });
  if (!result.ok) {
    feedback(result.error.message, "error");
    setConnectionState("加载失败", "error");
    return;
  }
  populate(result.value);
  initialized = true;
  fields.disabled = false;
  feedback(
    result.value.configured
      ? "配置已读取。你可以直接回到网页开始翻译。"
      : "填入 API Key，即可连接自己的翻译模型。",
  );
  await refreshUsage();
}

void initialize();
