import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
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

test("concurrent pages cannot both spend the same remaining budget", async () => {
  const state = new TranslationState();
  const settings = {
    ...DEFAULT_SETTINGS,
    monthlyBudgetUsd: 1,
    inputPricePerMillion: 1,
    outputPricePerMillion: 1,
    pageTokenLimit: 0,
  };
  await state.initialize(settings);
  const attempts = await Promise.allSettled([
    state.reserve("first", "page-one", settings, 600000, 0),
    state.reserve("second", "page-two", settings, 600000, 0),
  ]);
  assert.equal(
    attempts.filter((attempt) => attempt.status === "fulfilled").length,
    1,
  );
  const rejected = attempts.find((attempt) => attempt.status === "rejected");
  assert.ok(
    rejected?.status === "rejected" &&
      rejected.reason instanceof RequestError &&
      rejected.reason.detail.code === "budget",
  );
});

test("worker recovery counts an unknown sent request once without resending it", async () => {
  const state = new TranslationState();
  await state.initialize(DEFAULT_SETTINGS);
  await state.reserve(
    "unknown-request",
    "page-one",
    DEFAULT_SETTINGS,
    1000,
    500,
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
