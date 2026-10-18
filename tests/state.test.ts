import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { DEFAULT_SETTINGS } from "../src/shared";
import { RequestError } from "../src/background/errors";
import { TranslationState, translationCacheKey } from "../src/background/state";

let originalChrome: PropertyDescriptor | undefined;

function storageArea() {
  const values: Record<string, unknown> = {};
  return {
    async get(keys: string | string[]) {
      return Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys])
          .filter((key) => key in values)
          .map((key) => [key, structuredClone(values[key])]),
      );
    },
    async set(items: Record<string, unknown>) {
      Object.assign(values, structuredClone(items));
    },
    async remove(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
}

beforeEach(() => {
  originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { storage: { local: storageArea(), session: storageArea() } },
  });
});
afterEach(() => {
  if (originalChrome)
    Object.defineProperty(globalThis, "chrome", originalChrome);
  else Reflect.deleteProperty(globalThis, "chrome");
});

const budgetSettings = {
  ...DEFAULT_SETTINGS,
  monthlyBudgetUsd: 1,
  inputPricePerMillion: 1000,
  outputPricePerMillion: 1000,
  pageTokenLimit: 1000,
};

async function accounting() {
  const saved = await chrome.storage.local.get("justTranslate.accounting");
  return saved["justTranslate.accounting"] as {
    pages: Record<string, number>;
    journal: { id: string; status: string }[];
  };
}

function track(promise: Promise<void>) {
  const outcome = { settled: false };
  void promise.then(
    () => { outcome.settled = true; },
    () => { outcome.settled = true; },
  );
  return outcome;
}

test("concurrent pages preserve the total guard while waiting, then reject a truly exhausted budget", async (t) => {
  const state = new TranslationState();
  const settings = { ...budgetSettings, pageTokenLimit: 0 };
  const controller = new AbortController();
  t.after(() => controller.abort());
  await state.initialize(settings);
  const first = state.reserve("first", "page-one", settings, 400, 200, controller.signal);
  const second = state.reserve("second", "page-two", settings, 400, 200, controller.signal);
  const outcome = track(second);
  const rejected = assert.rejects(second, (error: unknown) =>
    error instanceof RequestError && error.detail.code === "budget");
  await first;
  await nextTurn();
  assert.equal(outcome.settled, false, "unsettled bounds block admission rather than reject it");
  assert.deepEqual((await accounting()).pages, { "page-one": 600 });
  assert.deepEqual((await accounting()).journal.map((entry) => entry.id), ["first"]);
  assert.equal((await state.usage()).usage.requests, 0, "waiting creates no paid attempt");
  await state.dispatch("first");
  await state.complete("first", {
    translations: [], inputTokens: 400, outputTokens: 200, estimated: false,
  });
  await rejected;
  assert.equal((await state.usage()).usage.estimatedCostUsd, 0.6);
  assert.equal((await state.usage()).usage.requests, 1);
  assert.deepEqual((await accounting()).journal.map((entry) => entry.id), ["first"]);
});

test("same-page upper bounds wait until actual settlement admits the next request", async (t) => {
  const state = new TranslationState();
  const settings = { ...budgetSettings, monthlyBudgetUsd: 0 };
  const controller = new AbortController();
  t.after(() => controller.abort());
  await state.initialize(settings);
  await state.reserve("first", "page", settings, 400, 200, controller.signal);
  await state.dispatch("first");
  const second = state.reserve("second", "page", settings, 300, 300, controller.signal);
  const outcome = track(second);
  await nextTurn();
  assert.equal(outcome.settled, false);
  assert.equal((await accounting()).pages.page, 600);
  await state.complete("first", {
    translations: [], inputTokens: 100, outputTokens: 100, estimated: false,
  });
  await second;
  assert.equal((await accounting()).pages.page, 800, "actual tokens replace both reserved bounds");
  assert.equal((await state.usage()).usage.requests, 1, "admission is not dispatch");
  await state.dispatch("second");
  assert.equal((await state.usage()).usage.requests, 2);
});

test("monthly reservations on another page unblock after a known unsent failure", async (t) => {
  const state = new TranslationState();
  const settings = { ...budgetSettings, pageTokenLimit: 0 };
  const controller = new AbortController();
  t.after(() => controller.abort());
  await state.initialize(settings);
  await state.reserve("first", "page-one", settings, 400, 200, controller.signal);
  const second = state.reserve("second", "page-two", settings, 400, 200, controller.signal);
  const outcome = track(second);
  await nextTurn();
  assert.equal(outcome.settled, false, "the monthly guard includes other pages' reservations");
  await state.fail("first", new RequestError("cancelled", "Stopped before dispatch"));
  await second;
  assert.deepEqual((await accounting()).pages, { "page-one": 0, "page-two": 600 });
  assert.equal((await state.usage()).usage.requests, 0);
  assert.equal((await state.usage()).usage.estimatedCostUsd, 0);
});

test("cancelled budget waiters never reserve, dispatch, or accrue uncertain charges", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 0, 1) });
  const state = new TranslationState();
  const settings = { ...budgetSettings, monthlyBudgetUsd: 0 };
  const signal = new AbortController().signal;
  const controller = new AbortController();
  await state.initialize(settings);
  await state.reserve("first", "page", settings, 600, 0, signal);
  const waiting = state.reserve("cancelled", "page", settings, 600, 0, controller.signal);
  const outcome = track(waiting);
  const rejected = assert.rejects(waiting, (error: unknown) =>
    error instanceof RequestError && error.detail.code === "cancelled" &&
    !error.dispatched && !error.detail.uncertain);
  await nextTurn();
  assert.equal(outcome.settled, false);
  controller.abort();
  await rejected;
  await state.fail("first", new RequestError("cancelled", "Stopped before dispatch"));
  t.mock.timers.tick(30_000);
  await nextTurn();
  assert.deepEqual((await accounting()).journal.map((entry) => entry.id), ["first"]);
  assert.equal((await accounting()).pages.page, 0);
  assert.equal((await state.usage()).usage.requests, 0);
  assert.equal((await state.usage()).usage.uncertainRequests, 0);
});

test("budget wait uses one thirty-second deadline even when settlements wake it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 0, 1) });
  const state = new TranslationState();
  const settings = { ...budgetSettings, monthlyBudgetUsd: 0 };
  const controller = new AbortController();
  t.after(() => controller.abort());
  await state.initialize(settings);
  await state.reserve("first", "page", settings, 700, 0, controller.signal);
  await state.reserve("small", "page", settings, 300, 0, controller.signal);
  const waiting = state.reserve("timed-out", "page", settings, 500, 0, controller.signal);
  const outcome = track(waiting);
  const rejected = assert.rejects(waiting, (error: unknown) =>
    error instanceof RequestError && error.detail.code === "rate_limit" &&
    error.detail.retryable && /尚未发送/.test(error.detail.message) &&
    !error.dispatched && !error.detail.uncertain);
  await nextTurn();
  t.mock.timers.tick(10_000);
  await state.fail("small", new RequestError("cancelled", "Stopped before dispatch"));
  await nextTurn();
  assert.equal(outcome.settled, false, "a partial release still cannot fit this request");
  t.mock.timers.tick(19_999);
  await nextTurn();
  assert.equal(outcome.settled, false);
  t.mock.timers.tick(1);
  await rejected;
  await state.fail("first", new RequestError("cancelled", "Stopped before dispatch"));
  await nextTurn();
  assert.ok((await accounting()).journal.every((entry) => entry.id !== "timed-out"));
  assert.equal((await state.usage()).usage.requests, 0);
  assert.equal((await state.usage()).usage.uncertainRequests, 0);
});

test("zero-token cache work is admitted when both real budgets are exhausted", async () => {
  const state = new TranslationState();
  const signal = new AbortController().signal;
  await state.initialize(budgetSettings);
  await state.reserve("paid", "page", budgetSettings, 500, 500, signal);
  await state.dispatch("paid");
  await state.complete("paid", {
    translations: [], inputTokens: 500, outputTokens: 500, estimated: false,
  });
  await state.reserve("cached", "page", budgetSettings, 0, 0, signal);
  await state.complete("cached", {
    translations: [{ id: "cached", revision: 1, text: "缓存译文", cached: true }],
    inputTokens: 0, outputTokens: 0, estimated: false,
  });
  const { usage } = await state.usage();
  assert.equal(usage.requests, 1);
  assert.equal(usage.estimatedCostUsd, 1);
  assert.equal(usage.cacheHits, 1);
  assert.equal((await accounting()).pages.page, 1000);
});

for (const constraint of ["page", "month"] as const) {
  test(`an oversized request fails immediately under the ${constraint} guard despite unsettled work`, async (t) => {
    const state = new TranslationState();
    const settings = {
      ...budgetSettings,
      monthlyBudgetUsd: constraint === "month" ? 1 : 0,
      pageTokenLimit: constraint === "page" ? 1000 : 0,
    };
    const controller = new AbortController();
    t.after(() => controller.abort());
    await state.initialize(settings);
    await state.reserve("first", "page", settings, 100, 0, controller.signal);
    const oversized = state.reserve("oversized", "page", settings, 1000, 1, controller.signal);
    const outcome = track(oversized);
    const rejected = assert.rejects(oversized, (error: unknown) =>
      error instanceof RequestError && error.detail.code === "budget");
    await nextTurn();
    assert.equal(outcome.settled, true, "settlement cannot make this request fit");
    await rejected;
    assert.deepEqual((await accounting()).journal.map((entry) => entry.id), ["first"]);
    assert.equal((await state.usage()).usage.requests, 0);
  });
}

for (const settlement of ["complete", "fail"] as const) {
  test(`failed ${settlement} persistence cannot dispatch a budget waiter`, async (t) => {
    const state = new TranslationState();
    const settings = { ...budgetSettings, monthlyBudgetUsd: 0 };
    const controller = new AbortController();
    t.after(() => controller.abort());
    await state.initialize(settings);
    await state.reserve("first", "page", settings, 600, 0, controller.signal);
    await state.dispatch("first");
    const waiting = state.reserve("waiting", "page", settings, 600, 0, controller.signal)
      .then(() => state.dispatch("waiting"));
    const outcome = track(waiting);
    const rejected = assert.rejects(waiting, (error: unknown) =>
      error instanceof RequestError && error.detail.code === "internal" &&
      error.detail.retryable && /尚未发送/.test(error.detail.message) &&
      !error.dispatched && !error.detail.uncertain);
    await nextTurn();
    assert.equal(outcome.settled, false);
    const failure = new Error("Injected accounting commit failure");
    const storage = t.mock.method(chrome.storage.local, "set", async () => { throw failure; });
    await assert.rejects(settlement === "complete"
      ? state.complete("first", {
        translations: [], inputTokens: 100, outputTokens: 0, estimated: false,
      })
      : state.fail("first", new RequestError("cancelled", "Known unbilled failure")),
    (error: unknown) => error === failure);
    await rejected;
    storage.mock.restore();
    await nextTurn();
    assert.deepEqual((await accounting()).journal.map(({ id, status }) => ({ id, status })),
      [{ id: "first", status: "sent" }]);
    assert.equal((await accounting()).pages.page, 600);
    const { usage } = await state.usage();
    assert.equal(usage.requests, 1, "failed durable settlement never authorizes another dispatch");
    assert.equal(usage.inputTokens, 0, "failed settlement is not applied in memory");
    assert.equal(usage.uncertainRequests, 0);
  });
}

test("worker recovery counts an unknown sent request once without resending it", async () => {
  const state = new TranslationState();
  await state.initialize(DEFAULT_SETTINGS);
  await state.reserve(
    "unknown-request",
    "page-one",
    DEFAULT_SETTINGS,
    1000,
    500,
    new AbortController().signal,
  );
  await state.dispatch("unknown-request");
  const recovered = new TranslationState();
  await recovered.initialize(DEFAULT_SETTINGS);
  const first = await recovered.usage();
  assert.equal(first.usage.requests, 1);
  assert.equal(first.usage.uncertainRequests, 1);
  assert.equal(first.usage.inputTokens, 1000);
  const recoveredAgain = new TranslationState();
  await recoveredAgain.initialize(DEFAULT_SETTINGS);
  assert.deepEqual((await recoveredAgain.usage()).usage, first.usage);
  await assert.rejects(
    recoveredAgain.reserve(
      "unknown-request",
      "page-one",
      DEFAULT_SETTINGS,
      1000,
      500,
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof RequestError && error.detail.code === "interrupted",
  );
});

test("clearing cache prevents an older pending result from repopulating it", async () => {
  const state = new TranslationState();
  await state.initialize(DEFAULT_SETTINGS);
  const key = "a".repeat(64);
  const before = await state.lookup([key]);
  await state.clearCache();
  await state.insert([{ key, text: "旧请求的译文" }], before.generation);
  assert.equal((await state.lookup([key])).values[0], undefined);
  const current = await state.lookup([key]);
  await state.insert([{ key, text: "清理后的新译文" }], current.generation);
  assert.equal((await state.lookup([key])).values[0], "清理后的新译文");
});

test("cache identity separates target language, context, provider and account", async () => {
  const segment = {
    id: "one",
    revision: 1,
    text: "The bank is nearby.",
    context: "Financial services",
  };
  const keys = await Promise.all([
    translationCacheKey(DEFAULT_SETTINGS, "account-a", segment),
    translationCacheKey(
      { ...DEFAULT_SETTINGS, targetLanguage: "ja" },
      "account-a",
      segment,
    ),
    translationCacheKey(DEFAULT_SETTINGS, "account-a", {
      ...segment,
      context: "A river walk",
    }),
    translationCacheKey(
      { ...DEFAULT_SETTINGS, baseUrl: "https://another-provider.example" },
      "account-a",
      segment,
    ),
    translationCacheKey(DEFAULT_SETTINGS, "account-b", segment),
  ]);
  assert.equal(new Set(keys).size, 5);
});
