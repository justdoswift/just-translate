import {
  MAX_BATCH_CHARS,
  MAX_BATCH_SEGMENTS,
  MAX_SEGMENT_CHARS,
  type BatchResult,
  type Segment,
  type Settings,
} from "../shared";
import { RequestError, checkAbort, errorDetail } from "./errors";
import { prepareRequest, requestTranslation } from "./provider";
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
  private activeSegments = new Map<string, Set<string>>();
  private tests = new Set<AbortController>();

  constructor(readonly state: TranslationState) {}

  async translate(
    session: TranslationSession,
    requestId: unknown,
    values: unknown,
  ): Promise<BatchResult> {
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
    const segments = validateSegments(values);
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
    return this.enqueue(session.id, session.controller.signal, async () => {
      checkAbort(session.controller.signal);
      await requireApiPermission(session.settings);
      await session.persist?.();
      // Ordered companion sources affect meaning even when no explicit hint is needed.
      // Exclude ephemeral DOM IDs, but invalidate cache entries when any source changes.
      const contextIdentity = JSON.stringify([
        segments.map((segment) => segment.text),
        [...new Set(segments.map((segment) => segment.context))],
      ]);
      const keys = await Promise.all(
        segments.map((segment) =>
          translationCacheKey(session.settings, session.fingerprint, {
            ...segment,
            context: contextIdentity,
          }),
        ),
      );
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
            )
          : undefined;
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
    }).finally(() => {
      for (const identity of identities) active.delete(identity);
      if (!active.size) this.activeSegments.delete(session.id);
    });
  }

  async test(
    settings: Settings,
    apiKey: string,
  ): Promise<{ translation: string }> {
    const id = `test-${crypto.randomUUID()}`;
    const controller = new AbortController();
    this.tests.add(controller);
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
            );
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

  private enqueue<T>(
    key: string,
    signal: AbortSignal,
    run: () => Promise<T>,
  ): Promise<T> {
    if (signal.aborted)
      return Promise.reject(new RequestError("cancelled", "翻译已停止。"));
    if (this.queued >= 64 || (this.queues.get(key)?.length ?? 0) >= 4)
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
      task.timer = setTimeout(() => {
        task.expired = true;
        task.cancel();
      }, 30_000);
      signal.addEventListener("abort", task.cancel, { once: true });
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < 2 && this.turns.length) {
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
