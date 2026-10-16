import { defineBackground } from "wxt/utils/define-background";
import {
  STARTUP_ERROR_KEY,
  type BackgroundMessage,
  type PageMessage,
  type PageProgress,
  type Reply,
} from "../src/shared";
import { RequestError, errorDetail } from "../src/background/errors";
import {
  TranslationEngine,
  type TranslationSession,
} from "../src/background/engine";
import {
  SettingsStore,
  accountFingerprint,
  requireApiPermission,
  validateKey,
  validateSettings,
} from "../src/background/settings";
import { TranslationState } from "../src/background/state";

interface PageSnapshot {
  active: boolean;
  sessionId?: string;
  progress?: PageProgress;
}
interface StoredSession {
  id: string;
  tabId: number;
  documentId: string;
  fingerprint: string;
  configurationId: string;
  requests: string[];
}
interface ToggleIntent {
  enabled?: boolean;
  toggles: number;
  generation: number;
}
const SESSIONS_KEY = "justTranslate.sessions";

export default defineBackground(() => {
  const settings = new SettingsStore();
  const state = new TranslationState();
  const engine = new TranslationEngine(state);
  const sessions = new Map<number, TranslationSession>();
  const documents = new Map<number, string>();
  const generations = new Map<number, number>();
  const actions = new Map<number, Promise<void>>();
  const intents = new Map<number, ToggleIntent>();
  const configurationIds = new Map<string, string>();
  let metadataWrites: Promise<unknown> = Promise.resolve();
  let configuration: Promise<unknown> = Promise.resolve();
  let configurationEpoch = 0;
  let restored = false;
  const ready = settings.initialize().then(async () => {
    await state.initialize(settings.view().settings);
    await restoreSessions();
    restored = true;
  });
  // Listener registration stays synchronous; a failed initialization is surfaced by each operation.
  void ready.catch(() => undefined);

  function persistSessions(): Promise<void> {
    const operation = metadataWrites.then(async () => {
      // Take the snapshot inside the serial writer, not before it: a queued save
      // can never resurrect an identity that stop() has already invalidated.
      const records: StoredSession[] = [...sessions.values()].map(
        (session) => ({
          id: session.id,
          tabId: session.tabId,
          documentId: session.documentId,
          fingerprint: session.fingerprint,
          configurationId: configurationIds.get(session.id) ?? "",
          requests: [...session.requests],
        }),
      );
      if (
        new TextEncoder().encode(JSON.stringify(records)).byteLength > 1_000_000
      ) {
        throw new RequestError(
          "budget",
          "活动翻译会话记录已达安全上限，请停止不再使用的页面后重试。",
        );
      }
      await chrome.storage.session.set({ [SESSIONS_KEY]: records });
    });
    metadataWrites = operation.catch(() => undefined);
    return operation;
  }

  async function restoreSessions(): Promise<void> {
    const stored = await chrome.storage.session.get(SESSIONS_KEY);
    const records: unknown = stored[SESSIONS_KEY];
    const view = settings.view();
    const configurationId = await accountFingerprint(
      JSON.stringify(view.settings),
    );
    let permitted = false;
    if (view.apiKey) {
      try {
        await requireApiPermission(view.settings);
        permitted = true;
      } catch {
        /* Revoked access cannot resume a page. */
      }
    }
    if (Array.isArray(records) && permitted) {
      await Promise.all(
        (records as unknown[]).map(async (candidate) => {
          if (!candidate || typeof candidate !== "object") return;
          const record = candidate as Partial<StoredSession>;
          if (
            typeof record.id !== "string" ||
            !record.id ||
            record.id.length > 160 ||
            typeof record.tabId !== "number" ||
            !Number.isSafeInteger(record.tabId) ||
            record.tabId < 0 ||
            typeof record.documentId !== "string" ||
            !record.documentId ||
            record.fingerprint !== settings.fingerprint ||
            record.configurationId !== configurationId ||
            !Array.isArray(record.requests) ||
            record.requests.length > 20_000 ||
            !record.requests.every(
              (request) =>
                typeof request === "string" &&
                request.length > 0 &&
                request.length <= 160,
            ) ||
            generations.has(record.tabId)
          )
            return;
          try {
            const reply = (await chrome.tabs.sendMessage(
              record.tabId,
              { type: "page:ping" } satisfies PageMessage,
              { documentId: record.documentId },
            )) as Reply<PageSnapshot>;
            if (
              !reply?.ok ||
              !reply.value.active ||
              reply.value.sessionId !== record.id ||
              generations.has(record.tabId)
            )
              return;
            const session: TranslationSession = {
              id: record.id,
              tabId: record.tabId,
              documentId: record.documentId,
              settings: view.settings,
              apiKey: view.apiKey,
              fingerprint: settings.fingerprint,
              controller: new AbortController(),
              requests: new Set(record.requests),
              persist: persistSessions,
            };
            sessions.set(record.tabId, session);
            documents.set(record.tabId, record.documentId);
            configurationIds.set(record.id, configurationId);
          } catch {
            /* Closed, replaced, or inactive documents are deliberately not restored. */
          }
        }),
      );
    }
    await persistSessions();
    await state.retainPages(
      new Set([...sessions.values()].map((session) => session.id)),
    );
  }

  async function badge(
    tabId: number,
    phase: PageProgress["phase"],
    message?: string,
  ): Promise<void> {
    const styles = {
      running: {
        text: "译",
        color: "#2563eb",
        title: "正在翻译；快捷键停止并恢复原文；点击打开设置",
      },
      waiting: {
        text: "✓",
        color: "#15803d",
        title: "已翻译；滚动或展开后自动补译；快捷键恢复原文；点击打开设置",
      },
      partial: {
        text: "!",
        color: "#b45309",
        title: "部分段落翻译失败；可在页面上重试；点击打开设置",
      },
      blocked: {
        text: "!",
        color: "#b91c1c",
        title: "翻译已暂停；点击打开设置，检查配置或用量",
      },
      off: { text: "", color: "#64748b", title: "打开 Just Translate 设置" },
    } as const;
    const style = styles[phase];
    try {
      await Promise.all([
        chrome.action.setBadgeText({ tabId, text: style.text }),
        chrome.action.setBadgeBackgroundColor({ tabId, color: style.color }),
        chrome.action.setTitle({
          tabId,
          title: message ? `${style.title}：${message}` : style.title,
        }),
      ]);
    } catch {
      /* A closed tab has no badge to update. */
    }
  }

  async function stop(
    tabId: number,
    reason: string,
    notify = true,
    intent?: ToggleIntent,
  ): Promise<void> {
    if (intents.get(tabId) !== intent) intents.delete(tabId);
    const session = sessions.get(tabId);
    // Invalidate identity before aborting fetches or posting page:stop.
    sessions.delete(tabId);
    if (session) configurationIds.delete(session.id);
    session?.controller.abort();
    if (session) state.releasePage(session.id);
    const persisted = persistSessions();
    await badge(tabId, "off");
    if (notify && session) {
      try {
        await chrome.tabs.sendMessage(
          tabId,
          {
            type: "page:stop",
            sessionId: session.id,
            reason,
          } satisfies PageMessage,
          { documentId: session.documentId },
        );
      } catch {
        /* Navigation can destroy the former document before restoration. */
      }
    }
    await persisted;
  }

  function liveSession(
    sender: chrome.runtime.MessageSender,
    sessionId: unknown,
  ): TranslationSession {
    const tabId = sender.tab?.id;
    const session = tabId === undefined ? undefined : sessions.get(tabId);
    if (
      sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      !sender.documentId ||
      !session ||
      session.controller.signal.aborted ||
      session.id !== sessionId ||
      sender.documentId !== session.documentId
    ) {
      throw new RequestError(
        "stale",
        "当前页面翻译会话已失效，请用翻译快捷键停止后重新开始。",
      );
    }
    return session;
  }

  function trustedOptions(sender: chrome.runtime.MessageSender): boolean {
    if (
      sender.id !== chrome.runtime.id ||
      !sender.url ||
      (sender.frameId !== undefined && sender.frameId !== 0)
    )
      return false;
    try {
      const actual = new URL(sender.url);
      const expected = new URL(chrome.runtime.getURL("options.html"));
      return (
        actual.protocol === "chrome-extension:" &&
        actual.host === expected.host &&
        actual.pathname === expected.pathname
      );
    } catch {
      return false;
    }
  }

  function currentIntent(tabId: number, intent: ToggleIntent): boolean {
    return (
      intents.get(tabId) === intent &&
      intent.generation === (generations.get(tabId) ?? 0)
    );
  }

  async function start(tabId: number, intent: ToggleIntent): Promise<void> {
    const epoch = configurationEpoch;
    const current = () =>
      currentIntent(tabId, intent) && epoch === configurationEpoch;
    const tab = await chrome.tabs.get(tabId);
    if (!current()) return;
    if (!tab.url || !/^https?:\/\//i.test(tab.url))
      throw new RequestError(
        "unsupported",
        "此页面不允许注入翻译脚本；请在普通 HTTP/HTTPS 网页使用。",
      );
    let snapshot: Reply<PageSnapshot> | undefined;
    try {
      snapshot = (await chrome.tabs.sendMessage(
        tabId,
        { type: "page:ping" } satisfies PageMessage,
        { frameId: 0 },
      )) as Reply<PageSnapshot>;
    } catch {
      /* Script is injected only after the named translation command. */
    }
    if (!current()) return;
    if (snapshot?.ok && snapshot.value.active) {
      await chrome.tabs.sendMessage(
        tabId,
        {
          type: "page:stop",
          reason: "后台会话已结束，已恢复原文。",
        } satisfies PageMessage,
        { frameId: 0 },
      );
      if (!current()) return;
      await badge(tabId, "off");
      return;
    }
    const view = settings.view();
    validateKey(view.apiKey);
    await requireApiPermission(view.settings);
    if (!current()) return;
    const injection = snapshot?.ok
      ? await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          func: () => true,
        })
      : await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          files: ["content-scripts/content.js"],
        });
    const documentId = injection.find(
      (result) => result.frameId === 0,
    )?.documentId;
    if (!current()) return;
    if (!documentId)
      throw new RequestError("stale", "页面或设置已变化，请再次使用翻译快捷键。");
    const configurationId = await accountFingerprint(
      JSON.stringify(view.settings),
    );
    if (!current()) return;
    const session: TranslationSession = {
      id: crypto.randomUUID(),
      tabId,
      documentId,
      settings: view.settings,
      apiKey: view.apiKey,
      fingerprint: settings.fingerprint,
      controller: new AbortController(),
      requests: new Set(),
      persist: persistSessions,
    };
    documents.set(tabId, documentId);
    sessions.set(tabId, session);
    configurationIds.set(session.id, configurationId);
    try {
      await persistSessions();
      if (!current() || sessions.get(tabId) !== session) return;
      const reply = (await chrome.tabs.sendMessage(
        tabId,
        {
          type: "page:start",
          sessionId: session.id,
          targetLanguage: view.settings.targetLanguage,
          displayMode: view.settings.displayMode,
        } satisfies PageMessage,
        { documentId },
      )) as Reply<PageSnapshot>;
      if (!current() || sessions.get(tabId) !== session) return;
      if (!reply?.ok)
        throw new RequestError(
          "internal",
          "页面翻译脚本未能启动；请刷新页面后重试。",
          true,
        );
      await badge(tabId, "running");
      if (!current() || sessions.get(tabId) !== session) return;
      await chrome.storage.session.remove(STARTUP_ERROR_KEY);
    } catch (error) {
      if (!current() || sessions.get(tabId) !== session) return;
      await stop(tabId, "页面脚本未能启动。", true, intent);
      if (current()) throw error;
    }
  }

  async function handle(
    message: BackgroundMessage,
    sender: chrome.runtime.MessageSender,
  ): Promise<unknown> {
    await ready;
    if (message.type === "page:translate") {
      const session = liveSession(sender, message.sessionId);
      const result = await engine.translate(
        session,
        message.requestId,
        message.segments,
      );
      liveSession(sender, message.sessionId);
      return result;
    }
    if (message.type === "page:progress") {
      const progress = message.progress;
      if (!progress || typeof progress !== "object")
        throw new RequestError("configuration", "页面状态格式不正确。");
      const session = liveSession(sender, progress.sessionId);
      if (
        !["running", "waiting", "partial", "blocked", "off"].includes(
          progress.phase,
        ) ||
        ![progress.translated, progress.pending, progress.failed].every(
          (value) =>
            Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000,
        ) ||
        (progress.message !== undefined &&
          (typeof progress.message !== "string" ||
            progress.message.length > 300))
      )
        throw new RequestError("configuration", "页面进度格式不正确。");
      await badge(session.tabId, progress.phase, progress.message);
      return {};
    }
    if (message.type === "page:end") {
      const session = liveSession(sender, message.sessionId);
      await stop(session.tabId, "页面翻译已结束。");
      return {};
    }
    if (message.type === "options:open") {
      if (!trustedOptions(sender)) {
        const tabId = sender.tab?.id;
        if (
          sender.id !== chrome.runtime.id ||
          sender.frameId !== 0 ||
          !sender.documentId ||
          tabId === undefined ||
          documents.get(tabId) !== sender.documentId
        )
          throw new RequestError("permission", "该页面无权打开扩展设置。");
      }
      await chrome.runtime.openOptionsPage();
      return {};
    }
    if (!trustedOptions(sender))
      throw new RequestError("permission", "此操作仅允许在扩展设置页面执行。");
    if (message.type === "settings:get") {
      await configuration;
      return settings.view();
    }
    if (message.type === "settings:save") {
      const next = validateSettings(message.settings);
      const key = validateKey(message.apiKey, false);
      const operation = configuration.then(async () => {
        await requireApiPermission(next);
        configurationEpoch++;
        intents.clear();
        engine.cancelTests();
        await Promise.all(
          [...sessions.keys()].map((tabId) =>
            stop(tabId, "设置已更改，请重新开始翻译。"),
          ),
        );
        const result = await settings.save(next, key);
        await state.configure(next);
        await chrome.storage.session.remove(STARTUP_ERROR_KEY);
        return result;
      });
      configuration = operation.catch(() => undefined);
      return operation;
    }
    if (message.type === "connection:test") {
      const next = validateSettings(message.settings);
      const key = validateKey(message.apiKey);
      await requireApiPermission(next);
      return engine.test(next, key);
    }
    if (message.type === "usage:get") return state.usage();
    if (message.type === "cache:clear") return state.clearCache();
    throw new RequestError("unsupported", "不支持的扩展消息。");
  }

  chrome.runtime.onMessage.addListener(
    (value: unknown, sender, sendResponse) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("type" in value) ||
        typeof value.type !== "string"
      )
        return false;
      void handle(value as BackgroundMessage, sender).then(
        (result) =>
          sendResponse({ ok: true, value: result } satisfies Reply<unknown>),
        (error: unknown) =>
          sendResponse({
            ok: false,
            error: errorDetail(error),
          } satisfies Reply<unknown>),
      );
      return true;
    },
  );

  async function reportStartupError(
    error: unknown,
    tabId?: number,
    current: () => boolean = () => true,
  ): Promise<void> {
    if (!current()) return;
    const detail = errorDetail(error);
    if (detail.code === "internal" && error instanceof Error) {
      // Startup errors come from Chrome APIs, not model responses. Keep
      // their diagnostic reason, but do not store the current page URL.
      detail.message = `无法启动翻译：${error.message.replace(/(?:https?|chrome-extension):\/\/\S+/g, "[页面地址]").slice(0, 250)}`;
    }
    if (tabId !== undefined) await badge(tabId, "blocked", detail.message);
    if (!current()) return;
    try {
      await chrome.storage.session.set({ [STARTUP_ERROR_KEY]: detail });
    } catch {
      // The toolbar title remains available if session storage fails.
    }
    if (!current()) return;
    try {
      await chrome.runtime.openOptionsPage();
    } catch {
      // A closing browser may no longer be able to open a settings tab.
    }
  }

  function toggleTranslation(tab?: chrome.tabs.Tab): Promise<void> {
    if (!tab) {
      return chrome.tabs
        .query({ active: true, currentWindow: true })
        .then(([activeTab]) => {
          if (activeTab) return toggleTranslation(activeTab);
        })
        .catch((error: unknown) => reportStartupError(error));
    }
    if (tab.id === undefined) return Promise.resolve();
    const tabId = tab.id;
    const previousIntent = intents.get(tabId);
    // Before restoration completes, preserve keypress parity instead of guessing
    // whether the persisted page is on. Afterwards sessions own settled state.
    const enabled = previousIntent
      ? (previousIntent.enabled ??
        (sessions.has(tabId) !== (previousIntent.toggles % 2 === 1)))
      : sessions.has(tabId);
    const intent: ToggleIntent = {
      enabled: restored ? !enabled : undefined,
      toggles: (previousIntent?.toggles ?? 0) + 1,
      generation: generations.get(tabId) ?? 0,
    };
    intents.set(tabId, intent);
    // Off invalidates identity immediately, not after a pending page:start reply.
    const stopping = intent.enabled === false
      ? stop(tabId, "已停止翻译，原文保持不变。", true, intent)
      : undefined;
    // Attach rejection handling now even while an earlier start is still pending.
    const stopped = stopping?.then(
      () => undefined,
      (error: unknown) => ({ error }),
    );
    const previous = actions.get(tabId) ?? Promise.resolve();
    const action = previous
      .then(async () => {
        // Even superseded off commands remain a barrier before the next start.
        const failure = await stopped;
        if (failure && currentIntent(tabId, intent)) throw failure.error;
        await ready;
        if (!currentIntent(tabId, intent)) return;
        await configuration;
        if (!currentIntent(tabId, intent)) return;
        intent.enabled ??=
          sessions.has(tabId) !== (intent.toggles % 2 === 1);
        if (!stopped && !intent.enabled) {
          await stop(tabId, "已停止翻译，原文保持不变。", true, intent);
        }
        if (!currentIntent(tabId, intent)) return;
        if (intent.enabled) await start(tabId, intent);
      })
      .catch((error: unknown) => {
        if (!currentIntent(tabId, intent)) return;
        intent.enabled = false;
        return reportStartupError(
          error,
          tabId,
          () => currentIntent(tabId, intent),
        );
      });
    actions.set(tabId, action);
    void action.finally(() => {
      if (actions.get(tabId) === action) actions.delete(tabId);
      if (intents.get(tabId) === intent) intents.delete(tabId);
    });
    return action;
  }

  chrome.action.onClicked.addListener(() => {
    void chrome.runtime.openOptionsPage().catch(() => {
      // A closing browser may no longer be able to open a settings tab.
    });
  });
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === "toggle-translation") return toggleTranslation(tab);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    // A start that has not acquired a document must not migrate to a new page.
    // Settled sessions still use the document-bound ping below for anchor loads.
    if (
      changeInfo.status === "loading" &&
      intents.has(tabId) &&
      !sessions.has(tabId)
    ) {
      generations.set(tabId, (generations.get(tabId) ?? 0) + 1);
      intents.delete(tabId);
    }
    // Chrome can report "loading" for a same-document anchor. Only a failed
    // document-bound ping proves this session no longer owns the current page.
    // Content pagehide handles immediate cancellation on real navigation.
    if (changeInfo.status !== "complete") return;
    void ready
      .then(async () => {
        const session = sessions.get(tabId);
        if (!session) return;
        try {
          const reply = (await chrome.tabs.sendMessage(
            tabId,
            { type: "page:ping" } satisfies PageMessage,
            { documentId: session.documentId },
          )) as Reply<PageSnapshot>;
          if (
            reply?.ok &&
            reply.value.active &&
            reply.value.sessionId === session.id
          )
            return;
        } catch {
          /* A replaced document no longer has a receiver. */
        }
        if (sessions.get(tabId) !== session) return;
        generations.set(tabId, (generations.get(tabId) ?? 0) + 1);
        documents.delete(tabId);
        await stop(tabId, "页面已导航，翻译会话已结束。");
      })
      .catch(() => undefined);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    generations.set(tabId, (generations.get(tabId) ?? 0) + 1);
    documents.delete(tabId);
    void ready
      .then(() => stop(tabId, "标签页已关闭。", false))
      .catch(() => undefined)
      .finally(() => {
        // Keep the tombstone through startup restoration and outstanding commands.
        const action = actions.get(tabId);
        if (action) void action.finally(() => generations.delete(tabId));
        else generations.delete(tabId);
      });
  });
  chrome.permissions.onRemoved.addListener(() => {
    void ready
      .then(async () => {
        for (const session of sessions.values()) {
          try {
            await requireApiPermission(session.settings);
          } catch {
            await stop(session.tabId, "API 访问权限已撤销。");
          }
        }
      })
      .catch(() => undefined);
  });
});
