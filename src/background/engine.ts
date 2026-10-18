import {
  DEFAULT_SETTINGS,
  MAX_BATCH_CHARS,
  MAX_BATCH_SEGMENTS,
  MAX_CONCURRENT_REQUESTS,
  MAX_SEGMENT_CHARS,
  type BatchResult,
  type Segment,
  type Settings,
} from "../shared";
import { RequestError, checkAbort, errorDetail } from "./errors";
import { prepareRequest, requestTranslation, type ReleaseAttempt } from "./provider";
import { requireApiPermission } from "./settings";
import { TranslationState, translationCacheKey } from "./state";

export interface TranslationSession {
  id: string;
  tabId: number;
  documentId: string;
  settings: Settings;
  apiKey: string;
  fingerprint: string;
  controller: AbortController;
  requests: Set<string>;
  persist?: () => Promise<void>;
}
interface QueueTask {
  signal: AbortSignal;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cancel: () => void;
  timer?: ReturnType<typeof setTimeout>;
  expired: boolean;
}
interface AttemptWaiter {
  signal: AbortSignal;
  resolve: (release: ReleaseAttempt) => void;
  reject: (error: unknown) => void;
  cancel: () => void;
}

export function validateSegments(value: unknown): Segment[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_BATCH_SEGMENTS
  )
    throw new RequestError("configuration", "翻译批次大小不正确。");
  const seen = new Set<string>();
  const segments: Segment[] = [];
  let length = 0;
  for (const candidate of value as unknown[]) {
    if (!candidate || typeof candidate !== "object")
      throw new RequestError("configuration", "翻译段落格式不正确。");
    const segment = candidate as Record<string, unknown>;
    if (
      typeof segment.id !== "string" ||
      !segment.id ||
      segment.id.length > 160 ||
      seen.has(segment.id) ||
      typeof segment.revision !== "number" ||
      !Number.isSafeInteger(segment.revision) ||
      segment.revision < 0 ||
      typeof segment.text !== "string" ||
      !segment.text.trim() ||
      segment.text.length > MAX_SEGMENT_CHARS ||
      typeof segment.context !== "string" ||
      segment.context.length > 1200
    )
      throw new RequestError("configuration", "翻译段落内容或标识不正确。");
    seen.add(segment.id);
    length += segment.text.length;
    segments.push({
      id: segment.id,
      revision: segment.revision,
      text: segment.text,
      context: segment.context,
    });
  }
  if (length > MAX_BATCH_CHARS)
    throw new RequestError("configuration", "翻译批次文本超过长度上限。");
  return segments;
}

export class TranslationEngine {
  private queues = new Map<string, QueueTask[]>();
  private turns: string[] = [];
  private running = 0;
  private queued = 0;
  private concurrency = DEFAULT_SETTINGS.maxConcurrentRequests;
  private effectiveConcurrency = this.concurrency;
  private recoverySuccesses = 0;
  private cooldownUntil = 0;
  private cooldownTimer?: ReturnType<typeof setTimeout>;
  private throttleGeneration = 0;
  private activeAttempts = 0;
  private attempts: AttemptWaiter[] = [];
  private activeSegments = new Map<string, Set<string>>();
  private pendingBatches = new Map<string, Promise<BatchResult>>();
  private tests = new Set<AbortController>();

  constructor(readonly state: TranslationState) {}

  setConcurrency(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONCURRENT_REQUESTS)
      throw new RequestError("configuration", "并发请求数必须是 1 到 8 的整数。");
    const throttled = this.effectiveConcurrency < this.concurrency ||
      this.cooldownUntil > Date.now();
    this.concurrency = limit;
    this.effectiveConcurrency = throttled
      ? Math.min(this.effectiveConcurrency, limit)
      : limit;
    this.recoverySuccesses = 0;
    this.pump();
  }

  resetThrottle(): void {
    this.throttleGeneration++;
    this.effectiveConcurrency = this.concurrency;
    this.recoverySuccesses = 0;
    this.cooldownUntil = 0;
    clearTimeout(this.cooldownTimer);
    this.cooldownTimer = undefined;
    this.pump();
  }

  async cached(
    session: TranslationSession,
    requestId: unknown,
    values: unknown,
  ): Promise<BatchResult | null> {
    checkAbort(session.controller.signal);
    if (typeof requestId !== "string" || !requestId || requestId.length > 160)
      throw new RequestError("configuration", "请求标识不正确。");
    const segments = validateSegments(values);
    await requireApiPermission(session.settings);
    const cached = await this.state.lookup(await this.cacheKeys(session, segments));
    checkAbort(session.controller.signal);
    // A probe never joins a flight, reserves tokens, or spends a request ID on a miss.
    if (!cached.values.every((text) => text !== undefined)) return null;
    const release = this.claimRequest(session, requestId, segments);
    try {
      await session.persist?.();
      return await this.completeReuse(
        session, requestId, segments, cached.values, cached.generation,
      );
    } finally {
      release();
    }
  }

  async translate(
    session: TranslationSession,
    requestId: unknown,
    values: unknown,
  ): Promise<BatchResult> {
    const segments = validateSegments(values);
    const release = this.claimRequest(session, requestId, segments);
    return this.translateBatch(session, requestId as string, segments).finally(release);
  }

  private claimRequest(
    session: TranslationSession,
    requestId: unknown,
    segments: Segment[],
  ): () => void {
    checkAbort(session.controller.signal);
    if (typeof requestId !== "string" || !requestId || requestId.length > 160)
      throw new RequestError("configuration", "请求标识不正确。");
    if (session.requests.has(requestId))
      throw new RequestError(
        "interrupted",
        "该请求已经提交；为避免重复计费，不会再次发送。请使用新的请求标识显式重试。",
        true,
      );
    if (session.requests.size >= 20_000)
      throw new RequestError(
        "budget",
        "当前会话请求过多，请停止后重新开始翻译。",
      );
    const identities = segments.map(
      (segment) => `${segment.id}:${segment.revision}`,
    );
    const active = this.activeSegments.get(session.id) ?? new Set<string>();
    if (identities.some((identity) => active.has(identity)))
      throw new RequestError(
        "interrupted",
        "这些段落已有请求正在处理，不会重复发送。",
        true,
      );
    for (const identity of identities) active.add(identity);
    this.activeSegments.set(session.id, active);
    session.requests.add(requestId);
    return () => {
      for (const identity of identities) active.delete(identity);
      if (!active.size) this.activeSegments.delete(session.id);
    };
  }

  private cacheKeys(
    session: TranslationSession,
    segments: Segment[],
  ): Promise<string[]> {
    // Ordered companion sources affect meaning; ephemeral DOM IDs do not.
    const contextIdentity = JSON.stringify([
      segments.map((segment) => segment.text),
      [...new Set(segments.map((segment) => segment.context))],
    ]);
    return Promise.all(
      segments.map((segment) =>
        translationCacheKey(session.settings, session.fingerprint, {
          ...segment,
          context: contextIdentity,
        }),
      ),
    );
  }

  private async translateBatch(
    session: TranslationSession,
    requestId: string,
    segments: Segment[],
  ): Promise<BatchResult> {
    await requireApiPermission(session.settings);
    await session.persist?.();
    checkAbort(session.controller.signal);
    const keys = await this.cacheKeys(session, segments);
    const cached = await this.state.lookup(keys);
    checkAbort(session.controller.signal);
    if (cached.values.every((text) => text !== undefined))
      return this.completeReuse(
        session, requestId, segments, cached.values, cached.generation,
      );

    // A flight belongs to one cancellation owner and one cache generation.
    const flightKey = JSON.stringify([session.id, cached.generation, keys]);
    const pending = this.pendingBatches.get(flightKey);
    if (pending) {
      const result = await pending;
      return this.completeReuse(
        session,
        requestId,
        segments,
        result.translations.map((translation) => translation.text),
      );
    }
    const operation = this.runBatch(session, requestId, segments, keys).finally(
      () => this.pendingBatches.delete(flightKey),
    );
    this.pendingBatches.set(flightKey, operation);
    return operation;
  }

  private async completeReuse(
    session: TranslationSession,
    requestId: string,
    segments: Segment[],
    texts: string[],
    cacheGeneration?: number,
  ): Promise<BatchResult> {
    checkAbort(session.controller.signal);
    const journalId = `${session.id}:${requestId}`;
    await this.state.reserve(
      journalId,
      session.id,
      session.settings,
      0,
      0,
      session.controller.signal,
    );
    try {
      checkAbort(session.controller.signal);
      const result: BatchResult = {
        translations: segments.map((segment, index) => ({
          id: segment.id,
          revision: segment.revision,
          text: texts[index]!,
          cached: true,
        })),
        inputTokens: 0,
        outputTokens: 0,
        estimated: false,
      };
      await this.state.complete(journalId, result);
      checkAbort(session.controller.signal);
      if (cacheGeneration !== undefined) {
        await this.state.insert([], cacheGeneration);
        checkAbort(session.controller.signal);
      }
      return result;
    } catch (error) {
      const failure =
        error instanceof RequestError
          ? error
          : new RequestError("internal", "无法持久保存复用结果，请检查扩展存储。", true);
      await this.state.fail(journalId, failure);
      throw failure;
    }
  }

  private runBatch(
    session: TranslationSession,
    requestId: string,
    segments: Segment[],
    keys: string[],
  ): Promise<BatchResult> {
    const throttleGeneration = this.throttleGeneration;
    return this.enqueue(session.id, session.controller.signal, async () => {
      checkAbort(session.controller.signal);
      // A preceding queued request may have populated the cache in the meantime.
      const cached = await this.state.lookup(keys);
      const missing = segments.filter(
        (_segment, index) => cached.values[index] === undefined,
      );
      const prepared = missing.length
        ? prepareRequest(session.settings, missing, segments)
        : undefined;
      const journalId = `${session.id}:${requestId}`;
      checkAbort(session.controller.signal);
      await this.state.reserve(
        journalId,
        session.id,
        session.settings,
        prepared?.inputBound ?? 0,
        prepared?.outputBound ?? 0,
        session.controller.signal,
      );
      try {
        checkAbort(session.controller.signal);
        const response = prepared
          ? await requestTranslation(
              session.settings,
              session.apiKey,
              prepared,
              session.controller.signal,
              async () => {
                checkAbort(session.controller.signal);
                await this.state.dispatch(journalId);
              },
              (delay) => this.rateLimited(delay, session.controller.signal, throttleGeneration),
              (signal) => this.acquireAttempt(signal),
            )
          : undefined;
        if (response) this.providerSucceeded(session.controller.signal, throttleGeneration);
        const byId = new Map(
          response?.items.map((item) => [item.id, item.translation]),
        );
        const translations = segments.map((segment, index) => {
          const text = cached.values[index] ?? byId.get(segment.id);
          if (text === undefined)
            throw new RequestError(
              "invalid_response",
              "翻译响应缺少段落。",
              true,
            );
          return {
            id: segment.id,
            revision: segment.revision,
            text,
            cached: cached.values[index] !== undefined,
          };
        });
        const result: BatchResult = {
          translations,
          inputTokens: response?.inputTokens ?? 0,
          outputTokens: response?.outputTokens ?? 0,
          estimated: response?.estimated ?? false,
        };
        // Accounting and completed response are durable before either caching or delivery.
        await this.state.complete(journalId, result);
        checkAbort(session.controller.signal);
        await this.state.insert(
          translations.flatMap((translation, index) => {
            const key = keys[index];
            return !translation.cached && key
              ? [{ key, text: translation.text }]
              : [];
          }),
          cached.generation,
        );
        checkAbort(session.controller.signal);
        return result;
      } catch (error) {
        const failure =
          error instanceof RequestError
            ? error
            : new RequestError(
                "internal",
                "无法持久保存请求结果；已停止交付，请检查扩展存储。",
                true,
                true,
              );
        await this.state.fail(journalId, failure);
        throw failure;
      }
    });
  }

  async test(
    settings: Settings,
    apiKey: string,
  ): Promise<{ translation: string }> {
    const id = `test-${crypto.randomUUID()}`;
    const controller = new AbortController();
    this.tests.add(controller);
    const throttleGeneration = this.throttleGeneration;
    try {
      return await this.enqueue(
        "connection-tests",
        controller.signal,
        async () => {
          const prepared = prepareRequest(settings, [
            {
              id: "connection-test",
              revision: 0,
              text: "Hello! This is a connection test.",
              context: "A fixed non-sensitive API connectivity test.",
            },
          ]);
          await this.state.reserve(
            id,
            id,
            settings,
            prepared.inputBound,
            prepared.outputBound,
            controller.signal,
          );
          try {
            const response = await requestTranslation(
              settings,
              apiKey,
              prepared,
              controller.signal,
              async () => {
                checkAbort(controller.signal);
                await this.state.dispatch(id);
              },
              (delay) => this.rateLimited(delay, controller.signal, throttleGeneration),
              (signal) => this.acquireAttempt(signal),
            );
            this.providerSucceeded(controller.signal, throttleGeneration);
            const translation = response.items[0]?.translation;
            if (!translation)
              throw new RequestError(
                "invalid_response",
                "连接测试未返回翻译。",
              );
            await this.state.complete(id, {
              translations: [
                {
                  id: "connection-test",
                  revision: 0,
                  text: translation,
                  cached: false,
                },
              ],
              inputTokens: response.inputTokens,
              outputTokens: response.outputTokens,
              estimated: response.estimated,
            });
            checkAbort(controller.signal);
            return { translation };
          } catch (error) {
            const failure =
              error instanceof RequestError
                ? error
                : new RequestError(
                    "internal",
                    "无法持久保存连接测试结果。",
                    true,
                    true,
                  );
            await this.state.fail(id, failure);
            throw failure;
          }
        },
      );
    } finally {
      this.tests.delete(controller);
      this.state.releasePage(id);
    }
  }

  cancelTests(): void {
    for (const controller of this.tests) controller.abort();
  }

  private acquireAttempt(signal: AbortSignal): Promise<ReleaseAttempt> {
    checkAbort(signal);
    // At most eight logical jobs can reach this gate. Retry waiters do not
    // compete with those jobs for logical slots, so lowering cannot deadlock.
    return new Promise((resolve, reject) => {
      const waiter: AttemptWaiter = {
        signal,
        resolve,
        reject,
        cancel: () => {
          signal.removeEventListener("abort", waiter.cancel);
          const index = this.attempts.indexOf(waiter);
          if (index < 0) return;
          this.attempts.splice(index, 1);
          reject(new RequestError("cancelled", "翻译已停止。"));
          this.pump();
        },
      };
      this.attempts.push(waiter);
      signal.addEventListener("abort", waiter.cancel, { once: true });
      this.pump();
    });
  }

  private enqueue<T>(
    key: string,
    signal: AbortSignal,
    run: () => Promise<T>,
  ): Promise<T> {
    if (signal.aborted)
      return Promise.reject(new RequestError("cancelled", "翻译已停止。"));
    if (this.queued >= 64 || (this.queues.get(key)?.length ?? 0) >= MAX_CONCURRENT_REQUESTS)
      return Promise.reject(
        new RequestError(
          "rate_limit",
          "等待中的翻译请求过多，请稍后重试。",
          true,
        ),
      );
    return new Promise<T>((resolve, reject) => {
      const task: QueueTask = {
        signal,
        run,
        resolve: (value) => resolve(value as T),
        reject,
        expired: false,
        cancel: () => {
          clearTimeout(task.timer);
          signal.removeEventListener("abort", task.cancel);
          const queue = this.queues.get(key);
          const index = queue?.indexOf(task) ?? -1;
          if (queue && index >= 0) {
            queue.splice(index, 1);
            this.queued--;
            if (!queue.length) {
              this.queues.delete(key);
              this.turns = this.turns.filter((turn) => turn !== key);
            }
            reject(
              task.expired
                ? new RequestError(
                    "rate_limit",
                    "排队超过 30 秒，请稍后手动重试；此请求尚未发送。",
                    true,
                  )
                : new RequestError("cancelled", "翻译已停止。"),
            );
            this.pump();
          }
        },
      };
      let queue = this.queues.get(key);
      if (!queue) {
        queue = [];
        this.queues.set(key, queue);
        this.turns.push(key);
      }
      queue.push(task);
      this.queued++;
      // The 30-second queue deadline includes provider cooldown; expired work was never sent.
      task.timer = setTimeout(() => {
        task.expired = true;
        task.cancel();
      }, 30_000);
      signal.addEventListener("abort", task.cancel, { once: true });
      this.pump();
    });
  }

  private rateLimited(delay: number, signal: AbortSignal, generation: number): void {
    if (signal.aborted || generation !== this.throttleGeneration) return;
    this.effectiveConcurrency = Math.max(1, Math.floor(this.effectiveConcurrency / 2));
    this.recoverySuccesses = 0;
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delay);
    clearTimeout(this.cooldownTimer);
    this.cooldownTimer = undefined;
    this.pump();
  }

  private providerSucceeded(signal: AbortSignal, generation: number): void {
    if (signal.aborted || generation !== this.throttleGeneration) return;
    if (Date.now() < this.cooldownUntil ||
      this.effectiveConcurrency >= this.concurrency) return;
    // Only actual successful provider responses recover capacity, one slot at a time.
    if (++this.recoverySuccesses < Math.max(2, this.effectiveConcurrency)) return;
    this.recoverySuccesses = 0;
    this.effectiveConcurrency++;
    this.pump();
  }

  private pump(): void {
    if (!this.turns.length && !this.attempts.length) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = undefined;
      return;
    }
    const remaining = this.cooldownUntil - Date.now();
    if (remaining > 0) {
      this.cooldownTimer ??= setTimeout(() => {
        this.cooldownTimer = undefined;
        this.pump();
      }, Math.min(remaining, 2_147_483_647));
      return;
    }
    clearTimeout(this.cooldownTimer);
    this.cooldownTimer = undefined;
    while (this.activeAttempts < this.effectiveConcurrency && this.attempts.length) {
      const waiter = this.attempts.shift()!;
      waiter.signal.removeEventListener("abort", waiter.cancel);
      if (waiter.signal.aborted) {
        waiter.reject(new RequestError("cancelled", "翻译已停止。"));
        continue;
      }
      this.activeAttempts++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.activeAttempts--;
        this.pump();
      });
    }
    while (this.running < this.effectiveConcurrency && this.turns.length) {
      const key = this.turns.shift();
      if (key === undefined) break;
      const queue = this.queues.get(key);
      const task = queue?.shift();
      if (!queue?.length) this.queues.delete(key);
      else this.turns.push(key);
      if (!task) continue;
      this.queued--;
      clearTimeout(task.timer);
      task.signal.removeEventListener("abort", task.cancel);
      if (task.signal.aborted) {
        task.reject(new RequestError("cancelled", "翻译已停止。"));
        continue;
      }
      this.running++;
      void task
        .run()
        .then(task.resolve, (error: unknown) => {
          const detail = errorDetail(error);
          task.reject(
            error instanceof RequestError
              ? error
              : new RequestError(
                  detail.code,
                  detail.message,
                  detail.retryable,
                  detail.uncertain,
                ),
          );
        })
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}
