import {
  PROMPT_VERSION,
  type BatchResult,
  type Segment,
  type Settings,
  type Usage,
  type UsageView,
} from "../shared";
import { RequestError, type TokenUsage } from "./errors";
import { accountFingerprint } from "./settings";

const STATE_KEY = "justTranslate.accounting";
const CACHE_KEY = "justTranslate.cache";
const RESULTS_KEY = "justTranslate.responses";
const CACHE_MAX_ENTRIES = 400;
const CACHE_MAX_BYTES = 2_000_000;
interface CacheEntry {
  key: string;
  text: string;
  created: number;
  used: number;
}
interface JournalEntry {
  id: string;
  page: string;
  month: string;
  status: "reserved" | "sent" | "completed" | "failed" | "unknown";
  created: number;
  inputBound: number;
  outputBound: number;
  inputRate: number;
  outputRate: number;
  attempts: number;
  result?: BatchResult;
}
interface StoredState {
  version: 1;
  months: Record<string, Usage>;
  journal: JournalEntry[];
  pages: Record<string, number>;
}

function emptyUsage(month: string): Usage {
  return {
    month,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    cacheHits: 0,
    uncertainRequests: 0,
    estimatedRequests: 0,
  };
}

export async function translationCacheKey(
  settings: Settings,
  fingerprint: string,
  segment: Segment,
): Promise<string> {
  return accountFingerprint(
    JSON.stringify([
      fingerprint,
      settings.provider,
      settings.baseUrl,
      settings.model,
      settings.targetLanguage,
      PROMPT_VERSION,
      settings.jsonMode,
      settings.disableThinking,
      segment.text,
      segment.context,
    ]),
  );
}

export class TranslationState {
  private state: StoredState = {
    version: 1,
    months: {},
    journal: [],
    pages: {},
  };
  private cache = new Map<string, CacheEntry>();
  private serial: Promise<unknown> = Promise.resolve();
  private persistent = false;
  private cacheDays = 7;
  private cacheGeneration = 0;

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.serial.then(operation, operation);
    this.serial = pending.catch(() => undefined);
    return pending;
  }

  async initialize(settings: Settings): Promise<void> {
    this.persistent = settings.persistentCache;
    this.cacheDays = settings.cacheDays;
    const [local, session] = await Promise.all([
      chrome.storage.local.get([STATE_KEY, CACHE_KEY]),
      chrome.storage.session.get([CACHE_KEY, RESULTS_KEY]),
    ]);
    const saved: unknown = local[STATE_KEY];
    if (
      saved &&
      typeof saved === "object" &&
      "version" in saved &&
      saved.version === 1 &&
      "months" in saved &&
      saved.months &&
      typeof saved.months === "object" &&
      "journal" in saved &&
      Array.isArray(saved.journal)
    ) {
      this.state = saved as StoredState;
      this.state.pages ??= {};
    }
    const storedCache: unknown = this.persistent
      ? local[CACHE_KEY]
      : session[CACHE_KEY];
    if (Array.isArray(storedCache)) {
      for (const item of storedCache as unknown[]) {
        if (!item || typeof item !== "object") continue;
        const entry = item as Partial<CacheEntry>;
        if (
          typeof entry.key === "string" &&
          /^[a-f0-9]{64}$/.test(entry.key) &&
          typeof entry.text === "string" &&
          entry.text.length <= 32_000 &&
          typeof entry.created === "number" &&
          typeof entry.used === "number"
        )
          this.cache.set(entry.key, entry as CacheEntry);
      }
    }
    const responses = session[RESULTS_KEY] as
      Record<string, BatchResult> | undefined;
    // Results are session-scoped even when durable accounting outlives the browser.
    for (const entry of this.state.journal) {
      const result = responses?.[entry.id];
      if (result && Array.isArray(result.translations)) entry.result = result;
      if (entry.status === "sent") {
        if (entry.result) {
          this.account(entry, entry.result, false);
          (this.state.months[entry.month] ??= emptyUsage(
            entry.month,
          )).cacheHits += entry.result.translations.filter(
            (translation) => translation.cached,
          ).length;
          entry.status = "completed";
        } else {
          // Never replay a dispatched request after worker termination.
          this.account(
            entry,
            {
              inputTokens: entry.inputBound,
              outputTokens: entry.outputBound,
              estimated: true,
            },
            true,
          );
          entry.status = "unknown";
        }
      } else if (entry.status === "reserved") {
        this.account(
          entry,
          { inputTokens: 0, outputTokens: 0, estimated: false },
          false,
        );
        entry.status = "failed";
      }
    }
    this.pruneCache();
    await this.persistState();
    await this.persistCache();
    await (
      this.persistent ? chrome.storage.session : chrome.storage.local
    ).remove(CACHE_KEY);
  }

  async configure(settings: Settings): Promise<void> {
    await this.exclusive(async () => {
      this.persistent = settings.persistentCache;
      this.cacheDays = settings.cacheDays;
      this.pruneCache();
      await this.persistCache();
      await (
        this.persistent ? chrome.storage.session : chrome.storage.local
      ).remove(CACHE_KEY);
    });
  }

  async lookup(
    keys: string[],
  ): Promise<{ values: (string | undefined)[]; generation: number }> {
    return this.exclusive(async () => {
      this.pruneCache();
      const now = Date.now();
      const values = keys.map((key) => {
        const entry = this.cache.get(key);
        if (entry) entry.used = now;
        return entry?.text;
      });
      return { values, generation: this.cacheGeneration };
    });
  }

  async insert(
    entries: { key: string; text: string }[],
    generation: number,
  ): Promise<void> {
    await this.exclusive(async () => {
      if (generation !== this.cacheGeneration) return;
      const now = Date.now();
      for (const entry of entries)
        this.cache.set(entry.key, { ...entry, created: now, used: now });
      this.pruneCache();
      await this.persistCache();
    });
  }

  async clearCache(): Promise<{ cleared: number }> {
    return this.exclusive(async () => {
      const cleared = this.cache.size;
      this.cache.clear();
      this.cacheGeneration++;
      // Completed response journals also contain translated text and must not survive a cache clear.
      for (const entry of this.state.journal) delete entry.result;
      await Promise.all([
        chrome.storage.local.remove(CACHE_KEY),
        chrome.storage.session.remove(CACHE_KEY),
        this.persistState(),
      ]);
      return { cleared };
    });
  }

  async usage(): Promise<UsageView> {
    return this.exclusive(async () => {
      this.pruneCache();
      const month = new Date().toISOString().slice(0, 7);
      return {
        usage: { ...(this.state.months[month] ?? emptyUsage(month)) },
        cacheEntries: this.cache.size,
      };
    });
  }

  async reserve(
    id: string,
    page: string,
    settings: Settings,
    inputBound: number,
    outputBound: number,
  ): Promise<void> {
    await this.exclusive(async () => {
      if (this.state.journal.some((entry) => entry.id === id))
        throw new RequestError(
          "interrupted",
          "该请求标识已使用；不会重复发送。请显式重试以创建新请求。",
          true,
        );
      const month = new Date().toISOString().slice(0, 7);
      const usage = this.state.months[month] ?? emptyUsage(month);
      const cost =
        (inputBound * settings.inputPricePerMillion +
          outputBound * settings.outputPricePerMillion) /
        1_000_000;
      const reservedCost = this.state.journal.reduce(
        (sum, entry) =>
          sum +
          (entry.month === month &&
          (entry.status === "reserved" || entry.status === "sent")
            ? (entry.inputBound * entry.inputRate +
                entry.outputBound * entry.outputRate) /
              1_000_000
            : 0),
        0,
      );
      if (
        inputBound + outputBound > 0 &&
        settings.monthlyBudgetUsd > 0 &&
        usage.estimatedCostUsd + reservedCost + cost > settings.monthlyBudgetUsd
      ) {
        throw new RequestError(
          "budget",
          "本月预算不足以安全预留此次请求；请在设置中检查用量或调整预算。",
        );
      }
      const used = this.state.pages[page] ?? 0;
      if (
        inputBound + outputBound > 0 &&
        settings.pageTokenLimit > 0 &&
        used + inputBound + outputBound > settings.pageTokenLimit
      )
        throw new RequestError(
          "budget",
          "本页 Token 上限不足以预留下一批翻译；已保留现有结果。",
        );
      this.state.pages[page] = used + inputBound + outputBound;
      this.state.journal.push({
        id,
        page,
        month,
        status: "reserved",
        created: Date.now(),
        inputBound,
        outputBound,
        inputRate: settings.inputPricePerMillion,
        outputRate: settings.outputPricePerMillion,
        attempts: 0,
      });
      await this.persistState();
    });
  }

  async dispatch(id: string): Promise<void> {
    await this.exclusive(async () => {
      const entry = this.state.journal.find((record) => record.id === id);
      if (!entry || (entry.status !== "reserved" && entry.status !== "sent"))
        throw new RequestError("interrupted", "请求日志不可用，已阻止发送。");
      entry.status = "sent";
      entry.attempts++;
      const usage = (this.state.months[entry.month] ??= emptyUsage(
        entry.month,
      ));
      usage.requests++;
      await this.persistState();
    });
  }

  async complete(id: string, result: BatchResult): Promise<void> {
    await this.exclusive(async () => {
      const entry = this.state.journal.find((record) => record.id === id);
      if (!entry || (entry.status !== "reserved" && entry.status !== "sent"))
        throw new RequestError(
          "interrupted",
          "无法确认请求记录，未交付翻译。",
          true,
          true,
        );
      this.account(entry, result, false);
      (this.state.months[entry.month] ??= emptyUsage(entry.month)).cacheHits +=
        result.translations.filter((translation) => translation.cached).length;
      entry.status = "completed";
      entry.result = result;
      await this.persistState();
    });
  }

  async fail(id: string, error: RequestError): Promise<void> {
    await this.exclusive(async () => {
      const entry = this.state.journal.find((record) => record.id === id);
      if (!entry || (entry.status !== "reserved" && entry.status !== "sent"))
        return;
      const unknown = Boolean(error.detail.uncertain && entry.attempts > 0);
      const usage =
        error.usage ??
        (unknown
          ? {
              inputTokens: entry.inputBound,
              outputTokens: entry.outputBound,
              estimated: true,
            }
          : { inputTokens: 0, outputTokens: 0, estimated: false });
      this.account(entry, usage, unknown);
      entry.status = unknown ? "unknown" : "failed";
      await this.persistState();
    });
  }

  releasePage(page: string): void {
    delete this.state.pages[page];
  }

  async retainPages(active: Set<string>): Promise<void> {
    await this.exclusive(async () => {
      for (const page of Object.keys(this.state.pages))
        if (!active.has(page)) delete this.state.pages[page];
      await this.persistState();
    });
  }

  private account(
    entry: JournalEntry,
    tokens: TokenUsage,
    unknown: boolean,
  ): void {
    const usage = (this.state.months[entry.month] ??= emptyUsage(entry.month));
    usage.inputTokens += tokens.inputTokens;
    usage.outputTokens += tokens.outputTokens;
    usage.estimatedCostUsd +=
      (tokens.inputTokens * entry.inputRate +
        tokens.outputTokens * entry.outputRate) /
      1_000_000;
    if (tokens.estimated) usage.estimatedRequests++;
    if (unknown) usage.uncertainRequests++;
    if (Object.hasOwn(this.state.pages, entry.page)) {
      this.state.pages[entry.page] = Math.max(
        0,
        (this.state.pages[entry.page] ?? 0) -
          entry.inputBound -
          entry.outputBound +
          tokens.inputTokens +
          tokens.outputTokens,
      );
    }
  }

  private pruneCache(): void {
    const oldest = Date.now() - this.cacheDays * 86_400_000;
    let bytes = 0;
    const entries = [...this.cache.values()].sort((a, b) => b.used - a.used);
    this.cache.clear();
    for (const entry of entries) {
      const size = (entry.key.length + entry.text.length) * 2 + 128;
      if (
        entry.created < oldest ||
        this.cache.size >= CACHE_MAX_ENTRIES ||
        bytes + size > CACHE_MAX_BYTES
      )
        continue;
      this.cache.set(entry.key, entry);
      bytes += size;
    }
  }

  private async persistCache(): Promise<void> {
    await (this.persistent ? chrome.storage.local : chrome.storage.session).set(
      { [CACHE_KEY]: [...this.cache.values()] },
    );
  }

  private async persistState(): Promise<void> {
    const active: JournalEntry[] = [];
    const finished: JournalEntry[] = [];
    let bytes = 0;
    for (const entry of [...this.state.journal].reverse()) {
      if (entry.status === "reserved" || entry.status === "sent")
        active.push(entry);
      else {
        const size = JSON.stringify(entry).length * 2;
        if (finished.length < 128 && bytes + size < 2_000_000) {
          finished.push(entry);
          bytes += size;
        }
      }
    }
    this.state.journal = [...finished.reverse(), ...active.reverse()];
    const months = Object.keys(this.state.months).sort().reverse();
    for (const month of months.slice(24)) delete this.state.months[month];
    const responses: Record<string, BatchResult> = {};
    const journal = this.state.journal.map(({ result, ...entry }) => {
      if (result) responses[entry.id] = result;
      return entry;
    });
    // Store response first: recovery can reconcile a crash between these two writes.
    await chrome.storage.session.set({ [RESULTS_KEY]: responses });
    await chrome.storage.local.set({ [STATE_KEY]: { ...this.state, journal } });
  }
}
