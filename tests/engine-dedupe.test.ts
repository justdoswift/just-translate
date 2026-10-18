import assert from "node:assert/strict";
import test, { afterEach, beforeEach, type TestContext } from "node:test";
import { DEFAULT_SETTINGS, type BatchResult, type Segment } from "../src/shared";
import { TranslationEngine, type TranslationSession } from "../src/background/engine";
import { RequestError } from "../src/background/errors";
import { TranslationState } from "../src/background/state";

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
    value: {
      storage: { local: storageArea(), session: storageArea() },
      permissions: { contains: async () => true },
    },
  });
});
afterEach(() => {
  if (originalChrome) Object.defineProperty(globalThis, "chrome", originalChrome);
  else Reflect.deleteProperty(globalThis, "chrome");
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

interface WireRequest {
  url: string;
  authorization: string | null;
  model: string;
  system: string;
  items: { id: string; text: string }[];
  context: string[];
  signal: AbortSignal;
  respond: (texts: string[]) => void;
  fail: () => void;
}

async function fixture(t: TestContext) {
  const state = new TranslationState();
  await state.initialize(DEFAULT_SETTINGS);
  const engine = new TranslationEngine(state);
  const calls: WireRequest[] = [];
  const sessions: TranslationSession[] = [];
  const pending: Promise<BatchResult>[] = [];
  const callWaiters = new Map<number, Deferred<void>>();
  const lookupWaiters = new Map<number, Deferred<void>>();
  let automaticResponse: ((call: WireRequest) => void) | undefined;
  let lookups = 0;
  const lookup = state.lookup.bind(state);
  const lookupMock = t.mock.method(state, "lookup", async (keys: string[]) => {
    const result = await lookup(keys);
    lookups++;
    lookupWaiters.get(lookups)?.resolve();
    return result;
  });
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(init);
    assert.equal(typeof init?.body, "string");
    const body = JSON.parse(init.body as string);
    const payload = JSON.parse(body.messages[1].content);
    assert.ok(Array.isArray(payload.items));
    const signal = init.signal;
    assert.ok(signal);
    const response = deferred<Response>();
    const abort = () => response.reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    const call: WireRequest = {
      url: String(input),
      authorization: new Headers(init.headers).get("Authorization"),
      model: body.model,
      system: body.messages[0].content,
      items: payload.items,
      context: payload.context,
      signal,
      respond(texts) {
        assert.equal(texts.length, payload.items.length);
        response.resolve(new Response(JSON.stringify({
          choices: [{
            message: { content: JSON.stringify({
              // Reverse provider order to exercise actual ID-based response parsing.
              items: payload.items.map((item: { id: string }, index: number) => ({
                id: item.id,
                text: texts[index],
              })).reverse(),
            }) },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 120, completion_tokens: 80 },
        }), { status: 200 }));
      },
      fail() {
        response.resolve(new Response(JSON.stringify({
          choices: [{ message: { content: '{"items":[]}' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 120, completion_tokens: 80 },
        }), { status: 200 }));
      },
    };
    calls.push(call);
    callWaiters.get(calls.length)?.resolve();
    automaticResponse?.(call);
    if (signal.aborted) abort();
    try {
      return await response.promise;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  });
  t.after(async () => {
    for (const session of sessions) session.controller.abort();
    await Promise.allSettled(pending);
    fetchMock.mock.restore();
    lookupMock.mock.restore();
  });
  return {
    state,
    calls,
    respondAll(texts: string[]) {
      automaticResponse = (call) => call.respond(texts);
      for (const call of calls) call.respond(texts);
    },
    failAll() {
      automaticResponse = (call) => call.fail();
      for (const call of calls) call.fail();
    },
    holdResponses() {
      automaticResponse = undefined;
    },
    session(overrides: Partial<TranslationSession> = {}) {
      const session: TranslationSession = {
        id: `page-${sessions.length}`,
        tabId: sessions.length + 1,
        documentId: `document-${sessions.length}`,
        settings: { ...DEFAULT_SETTINGS, pageTokenLimit: 0 },
        apiKey: "fixture-key-not-a-user-secret",
        fingerprint: "fixture-account-a",
        controller: new AbortController(),
        requests: new Set(),
        ...overrides,
      };
      sessions.push(session);
      return session;
    },
    translate(session: TranslationSession, id: string, segments: Segment[]) {
      const result = engine.translate(session, id, segments);
      pending.push(result);
      void result.catch(() => undefined);
      return result;
    },
    async called(count: number) {
      if (calls.length >= count) return;
      const gate = deferred<void>();
      callWaiters.set(count, gate);
      await gate.promise;
    },
    async nextLookup() {
      const gate = deferred<void>();
      lookupWaiters.set(lookups + 1, gate);
      await gate.promise;
    },
  };
}

function segment(id: string, text = "Subscribe", context = "", revision = 1): Segment {
  return { id, text, context, revision };
}

for (const batch of [false, true]) {
  test(`same-session concurrent identical ${batch ? "ordered batches" : "standalone controls"} share one charge and remap IDs and revisions`, { timeout: 5000 }, async (t) => {
    const f = await fixture(t);
    const page = f.session();
    const first = [segment("original", "Subscribe", "Newsletter", 2)];
    if (batch) first.push(segment("original-detail", "Get weekly news.", "Newsletter", 3));
    const second = first.map((item, index) => ({ ...item, id: `copy-${index}`, revision: index + 8 }));
    const a = f.translate(page, "original-request", first);
    await f.called(1);
    const followerLookup = f.nextLookup();
    const b = f.translate(page, "duplicate-request", second);
    await followerLookup;
    const texts = batch ? ["订阅", "每周获取新闻。"] : ["订阅"];
    f.respondAll(texts);
    const results = await Promise.all([a, b]);
    assert.equal(f.calls.length, 1);
    for (const [index, sources] of [first, second].entries()) {
      assert.deepEqual(results[index]!.translations.map(({ id, revision, text }) => ({ id, revision, text })),
        sources.map((source, item) => ({ id: source.id, revision: source.revision, text: texts[item] })));
    }
    assert.equal(results.reduce((total, result) => total + result.inputTokens, 0), 120);
    assert.equal(results.reduce((total, result) => total + result.outputTokens, 0), 80);
    const { usage } = await f.state.usage();
    assert.equal(usage.requests, 1);
    assert.equal(usage.inputTokens, 120);
    assert.equal(usage.outputTokens, 80);
    assert.equal(usage.uncertainRequests, 0);
    assert.equal(usage.estimatedCostUsd,
      (120 * page.settings.inputPricePerMillion + 80 * page.settings.outputPricePerMillion) / 1_000_000);
    assert.equal(page.requests.size, 2);
  });
}

test("a completed cache hit resolves while both global network slots remain held", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const page = f.session();
  const prime = f.translate(page, "prime", [segment("prime")]);
  await f.called(1);
  f.calls[0]!.respond(["订阅"]);
  await prime;
  const heldA = f.translate(f.session(), "held-a", [segment("a", "First article")]);
  const heldB = f.translate(f.session(), "held-b", [segment("b", "Second article")]);
  await f.called(3);
  const result = await f.translate(page, "cached", [segment("cached-control", "Subscribe", "", 9)]);
  assert.deepEqual(result.translations, [{ id: "cached-control", revision: 9, text: "订阅", cached: true }]);
  assert.equal(result.inputTokens, 0);
  assert.equal(result.outputTokens, 0);
  assert.equal(f.calls.length, 3);
  assert.equal((await f.state.usage()).usage.inputTokens, 120);
  f.calls[1]!.respond(["第一篇文章"]);
  f.calls[2]!.respond(["第二篇文章"]);
  await Promise.all([heldA, heldB]);
  assert.equal((await f.state.usage()).usage.requests, 3);
});

for (const persistentCache of [false, true]) {
  test(`recently reused translations survive eviction after worker restart (persistent=${persistentCache})`, { timeout: 5000 }, async (t) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const f = await fixture(t);
    const settings = { ...DEFAULT_SETTINGS, persistentCache };
    await f.state.configure(settings);
    const page = f.session({ settings });
    f.respondAll(["订阅"]);
    await f.translate(page, "prime", [segment("prime")]);
    const { generation } = await f.state.lookup([]);
    now += 1000;
    await f.state.insert(Array.from({ length: 399 }, (_, index) => ({
      key: (index + 1).toString(16).padStart(64, "0"),
      text: "其他缓存译文",
    })), generation);
    now += 1000;
    await f.translate(page, "reuse", [segment("copy")]);

    const recovered = new TranslationState();
    await recovered.initialize(settings);
    now += 1000;
    await recovered.insert([{ key: "f".repeat(64), text: "新缓存译文" }],
      (await recovered.lookup([])).generation);
    const result = await new TranslationEngine(recovered).translate(
      f.session({ settings }), "after-restart", [segment("new-copy")],
    );
    assert.equal(result.translations[0]!.text, "订阅");
    assert.equal(result.translations[0]!.cached, true);
    assert.equal(f.calls.length, 1, "cache eviction must not bill recently reused text again");
  });
}

test("concurrent identical source text with different context remains isolated", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const page = f.session();
  const finance = f.translate(page, "finance", [segment("finance", "The bank is nearby.", "Financial services")]);
  const river = f.translate(page, "river", [segment("river", "The bank is nearby.", "A river walk")]);
  await f.called(2);
  for (const call of f.calls) call.respond([call.context.includes("Financial services") ? "银行就在附近。" : "河岸就在附近。"]);
  const [a, b] = await Promise.all([finance, river]);
  assert.equal(a.translations[0]!.text, "银行就在附近。");
  assert.equal(b.translations[0]!.text, "河岸就在附近。");
  const cached = await f.translate(page, "finance-cached", [segment("new-finance", "The bank is nearby.", "Financial services")]);
  assert.equal(cached.translations[0]!.text, "银行就在附近。");
  assert.equal(cached.translations[0]!.cached, true);
  assert.equal(f.calls.length, 2);
  assert.equal((await f.state.usage()).usage.inputTokens, 240);
});

test("ordered companion sources remain part of in-flight and completed cache identity", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const page = f.session();
  const financial = [
    segment("finance-before", "She needs to deposit money."),
    segment("finance-bank", "The bank is nearby."),
  ];
  const riverside = [
    segment("river-before", "She follows the river."),
    segment("river-bank", "The bank is nearby."),
  ];
  const a = f.translate(page, "financial-passage", financial);
  const b = f.translate(page, "riverside-passage", riverside);
  await f.called(2);
  for (const call of f.calls) {
    call.respond(call.items[0]!.text === financial[0]!.text
      ? ["她需要存钱。", "银行就在附近。"]
      : ["她沿着河走。", "河岸就在附近。"]);
  }
  const [finance, river] = await Promise.all([a, b]);
  assert.equal(finance.translations[1]!.text, "银行就在附近。");
  assert.equal(river.translations[1]!.text, "河岸就在附近。");
  const cached = await f.translate(page, "financial-cached",
    financial.map((item) => ({ ...item, id: `cached-${item.id}`, revision: 9 })));
  assert.equal(cached.translations[1]!.text, "银行就在附近。");
  assert.ok(cached.translations.every((item) => item.cached));
  assert.equal(f.calls.length, 2);
  assert.equal((await f.state.usage()).usage.inputTokens, 240);
});

test("completed cache separates account, target, provider endpoint and model identities", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const variants: Partial<TranslationSession>[] = [
    {},
    { fingerprint: "fixture-account-b", apiKey: "fixture-other-key" },
    { settings: { ...DEFAULT_SETTINGS, targetLanguage: "ja" } },
    { settings: { ...DEFAULT_SETTINGS, provider: "custom", baseUrl: "https://provider.example" } },
    { settings: { ...DEFAULT_SETTINGS, model: "different-model" } },
  ];
  const texts = ["订阅", "订阅此刊", "購読", "订阅资讯", "订阅更新"];
  for (const [index, overrides] of variants.entries()) {
    const page = f.session(overrides);
    const pending = f.translate(page, `identity-${index}`, [segment(`item-${index}`)]);
    await f.called(index + 1);
    f.calls[index]!.respond([texts[index]!]);
    const result = await pending;
    assert.equal(result.translations[0]!.text, texts[index]);
    assert.equal(result.translations[0]!.cached, false);
    const cached = await f.translate(page, `cached-${index}`, [segment(`cached-${index}`)]);
    assert.equal(cached.translations[0]!.text, texts[index]);
    assert.equal(cached.translations[0]!.cached, true);
  }
  assert.equal(f.calls[1]!.authorization, "Bearer fixture-other-key");
  assert.match(f.calls[2]!.system, /\(ja\)/);
  assert.equal(f.calls[3]!.url, "https://provider.example/chat/completions");
  assert.equal(f.calls[4]!.model, "different-model");
  const { usage, cacheEntries } = await f.state.usage();
  assert.equal(f.calls.length, 5);
  assert.equal(usage.requests, 5);
  assert.equal(usage.inputTokens, 600);
  assert.equal(usage.outputTokens, 400);
  assert.equal(cacheEntries, 5);
});

test("a failed shared operation preserves one charge and allows an explicit retry", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const page = f.session();
  const a = f.translate(page, "failed-a", [segment("a")]);
  await f.called(1);
  const followerLookup = f.nextLookup();
  const b = f.translate(page, "failed-b", [segment("b", "Subscribe", "", 4)]);
  await followerLookup;
  f.failAll();
  const failed = await Promise.allSettled([a, b]);
  for (const result of failed) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.ok(result.reason instanceof RequestError);
      assert.equal(result.reason.detail.code, "invalid_response");
    }
  }
  assert.equal(f.calls.length, 1);
  assert.equal((await f.state.usage()).cacheEntries, 0);
  assert.equal((await f.state.usage()).usage.inputTokens, 120);
  f.holdResponses();
  const retry = f.translate(page, "explicit-retry", [segment("a")]);
  await f.called(2);
  f.calls[1]!.respond(["订阅"]);
  assert.equal((await retry).translations[0]!.text, "订阅");
  const { usage } = await f.state.usage();
  assert.equal(usage.requests, 2);
  assert.equal(usage.inputTokens, 240);
  assert.equal(usage.outputTokens, 160);
});

test("cancelling a shared operation rejects every waiter once and permits a fresh session retry", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const page = f.session();
  const a = f.translate(page, "cancel-first", [segment("first")]);
  await f.called(1);
  const followerLookup = f.nextLookup();
  const b = f.translate(page, "cancel-copy", [segment("copy", "Subscribe", "", 8)]);
  await followerLookup;
  page.controller.abort();
  const outcomes = await Promise.allSettled([a, b]);
  for (const result of outcomes) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.ok(result.reason instanceof RequestError);
      assert.equal(result.reason.detail.code, "cancelled");
    }
  }
  assert.equal(f.calls.length, 1);
  const stopped = await f.state.usage();
  assert.equal(stopped.usage.requests, 1);
  assert.equal(stopped.usage.uncertainRequests, 1);
  assert.equal(stopped.cacheEntries, 0);
  const retry = f.translate(f.session(), "explicit-retry", [segment("fresh")]);
  await f.called(2);
  f.calls[1]!.respond(["订阅"]);
  assert.equal((await retry).translations[0]!.text, "订阅");
  const resumed = await f.state.usage();
  assert.equal(resumed.usage.requests, 2);
  assert.equal(resumed.usage.inputTokens, stopped.usage.inputTokens + 120);
  assert.equal(resumed.usage.outputTokens, stopped.usage.outputTokens + 80);
  assert.equal(resumed.usage.uncertainRequests, 1);
});

test("cancelling one session neither cancels another session nor poisons a later retry", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const stopped = f.session();
  const survivor = f.session();
  const a = f.translate(stopped, "cancelled", [segment("a")]);
  await f.called(1);
  const b = f.translate(survivor, "independent", [segment("b")]);
  await f.called(2);
  stopped.controller.abort();
  await assert.rejects(a, (error: unknown) => error instanceof RequestError && error.detail.code === "cancelled");
  assert.equal(f.calls[0]!.signal.aborted, true);
  assert.equal(f.calls[1]!.signal.aborted, false);
  assert.equal((await f.state.usage()).cacheEntries, 0);
  f.calls[1]!.respond(["订阅"]);
  assert.equal((await b).translations[0]!.text, "订阅");
  await f.state.clearCache();
  const retry = f.translate(f.session(), "explicit-retry", [segment("retry")]);
  await f.called(3);
  f.calls[2]!.respond(["重新订阅"]);
  assert.equal((await retry).translations[0]!.text, "重新订阅");
  const { usage } = await f.state.usage();
  assert.equal(usage.requests, 3);
  assert.equal(usage.uncertainRequests, 1);
  assert.equal((await f.state.usage()).cacheEntries, 1);
});

test("clearing cache while pending separates generations and prevents stale cache repopulation", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const page = f.session();
  const old = f.translate(page, "old-generation", [segment("old")]);
  await f.called(1);
  await f.state.clearCache();
  const fresh = f.translate(page, "new-generation", [segment("new", "Subscribe", "", 5)]);
  await f.called(2);
  f.calls[1]!.respond(["新订阅译文"]);
  assert.equal((await fresh).translations[0]!.text, "新订阅译文");
  f.calls[0]!.respond(["旧订阅译文"]);
  assert.equal((await old).translations[0]!.text, "旧订阅译文");
  const cached = await f.translate(page, "after-both", [segment("after", "Subscribe", "", 7)]);
  assert.deepEqual(cached.translations, [{ id: "after", revision: 7, text: "新订阅译文", cached: true }]);
  assert.equal(f.calls.length, 2);
  const { usage, cacheEntries } = await f.state.usage();
  assert.equal(cacheEntries, 1);
  assert.equal(usage.requests, 2);
  assert.equal(usage.inputTokens, 240);
  assert.equal(usage.outputTokens, 160);
});
