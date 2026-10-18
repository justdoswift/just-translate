import {
  PROMPT_VERSION,
  type BatchResult,
  type Segment,
  type Settings,
  type Usage,
  type UsageView,
} from "../shared";
import { RequestError, abortError, checkAbort, type TokenUsage } from "./errors";
import { accountFingerprint } from "./settings";

const STATE_KEY = "justTranslate.accounting";
const CACHE_KEY = "justTranslate.cache";
const RESULTS_KEY = "justTranslate.responses";
const CACHE_MAX_ENTRIES = 400;
const CACHE_MAX_BYTES = 2_000_000;
const BUDGET_WAIT_TIMEOUT_MS = 30_000;
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

function budgetWaitTimeout(): RequestError {
  return new RequestError(
    "rate_limit",
    "等待预算预留释放超过 30 秒，请稍后手动重试；此请求尚未发送。",
    true,
  );
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
  private budgetWaiters = new Set<(error?: RequestError) => void>();

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
    signal: AbortSignal,
  ): Promise<void> {
    let deadline: number | undefined;
    for (;;) {
      checkAbort(signal);
      const waiting = await this.exclusive(async () => {
        checkAbort(signal);
        if (deadline !== undefined && Date.now() >= deadline)
          throw budgetWaitTimeout();
        if (this.state.journal.some((entry) => entry.id === id))
          throw new RequestError(
            "interrupted",
            "该请求标识已使用；不会重复发送。请显式重试以创建新请求。",
            true,
          );
        const month = new Date().toISOString().slice(0, 7);
        const usage = this.state.months[month] ?? emptyUsage(month);
        const tokens = inputBound + outputBound;
        const cost =
          (inputBound * settings.inputPricePerMillion +
            outputBound * settings.outputPricePerMillion) /
          1_000_000;
        let reservedCost = 0;
        let reservedPageTokens = 0;
        for (const entry of this.state.journal) {
          if (entry.status !== "reserved" && entry.status !== "sent") continue;
          if (entry.month === month)
            reservedCost +=
              (entry.inputBound * entry.inputRate +
                entry.outputBound * entry.outputRate) /
              1_000_000;
          if (entry.page === page)
            reservedPageTokens += entry.inputBound + entry.outputBound;
        }
        const used = this.state.pages[page] ?? 0;
        const monthlyBlocked =
          tokens > 0 &&
          settings.monthlyBudgetUsd > 0 &&
          usage.estimatedCostUsd + reservedCost + cost > settings.monthlyBudgetUsd;
        const pageBlocked =
          tokens > 0 &&
          settings.pageTokenLimit > 0 &&
          used + tokens > settings.pageTokenLimit;
        if (
          monthlyBlocked &&
          usage.estimatedCostUsd + cost > settings.monthlyBudgetUsd
        )
          throw new RequestError(
            "budget",
            "本月预算不足以安全预留此次请求；请在设置中检查用量或调整预算。",
          );
        if (
          pageBlocked &&
          Math.max(0, used - reservedPageTokens) + tokens > settings.pageTokenLimit
        )
          throw new RequestError(
            "budget",
            "本页 Token 上限不足以预留下一批翻译；已保留现有结果。",
          );
        if (monthlyBlocked || pageBlocked) {
          deadline ??= Date.now() + BUDGET_WAIT_TIMEOUT_MS;
          // Register under the mutex, but await settlement only after releasing it.
          return this.waitForBudget(signal, deadline);
        }
        this.state.pages[page] = used + tokens;
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
      if (!waiting) return;
      await waiting.wait;
    }
  }

  private waitForBudget(
    signal: AbortSignal,
    deadline: number,
  ): { wait: Promise<void> } {
    const wait = new Promise<void>((resolve, reject) => {
      const settle = (error?: RequestError): void => {
        if (!this.budgetWaiters.delete(settle)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve();
      };
      const cancel = (): void => settle(abortError());
      const timer = setTimeout(
        () => settle(budgetWaitTimeout()),
        Math.max(0, deadline - Date.now()),
      );
      this.budgetWaiters.add(settle);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
    return { wait };
  }

  private notifyBudgetWaiters(error?: RequestError): void {
    for (const settle of this.budgetWaiters) settle(error);
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
      await this.settle(entry, result, false, result);
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
      await this.settle(entry, usage, unknown);
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

  private async settle(
    entry: JournalEntry,
    tokens: TokenUsage,
    unknown: boolean,
    result?: BatchResult,
  ): Promise<void> {
    const previousUsage = this.state.months[entry.month];
    const usageSnapshot = previousUsage ? { ...previousUsage } : undefined;
    const previousPage = this.state.pages[entry.page];
    const previousStatus = entry.status;
    const previousResult = entry.result;
    const previousJournal = this.state.journal;
    this.account(entry, tokens, unknown);
    if (result) {
      this.state.months[entry.month]!.cacheHits += result.translations.filter(
        (translation) => translation.cached,
      ).length;
      entry.result = result;
    }
    entry.status = result ? "completed" : unknown ? "unknown" : "failed";
    try {
      await this.persistState();
    } catch (error) {
      // A failed durable write must not expose released capacity to another request.
      this.state.journal = previousJournal;
      if (usageSnapshot) this.state.months[entry.month] = usageSnapshot;
      else delete this.state.months[entry.month];
      if (previousPage !== undefined && Object.hasOwn(this.state.pages, entry.page))
        this.state.pages[entry.page] = previousPage;
      entry.status = previousStatus;
      if (previousResult) entry.result = previousResult;
      else delete entry.result;
      this.notifyBudgetWaiters(
        new RequestError(
          "internal",
          "无法持久保存预算结算；等待中的请求尚未发送，请检查扩展存储后重试。",
          true,
        ),
      );
      throw error;
    }
    this.notifyBudgetWaiters();
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
