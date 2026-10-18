import assert from "node:assert/strict";
import test, { afterEach, beforeEach, type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
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
  rateLimit: (retryAfter: string, body?: ReadableStream<Uint8Array>) => void;
  fail: () => void;
}

async function fixture(t: TestContext, concurrency?: number) {
  const state = new TranslationState();
  await state.initialize(DEFAULT_SETTINGS);
  const engine = new TranslationEngine(state);
  if (concurrency !== undefined) engine.setConcurrency(concurrency);
  const calls: WireRequest[] = [];
  const sessions: TranslationSession[] = [];
  const pending: Promise<BatchResult | null>[] = [];
  const callWaiters = new Map<number, Deferred<void>>();
  const lookupWaiters = new Map<number, Deferred<void>>();
  let automaticResponse: ((call: WireRequest) => void) | undefined;
  let lookups = 0;
  let activeCalls = 0;
  let peakCalls = 0;
  const lookup = state.lookup.bind(state);
  const lookupMock = t.mock.method(state, "lookup", async (keys: string[]) => {
    const result = await lookup(keys);
    lookups++;
    lookupWaiters.get(lookups)?.resolve();
    return result;
  });
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    activeCalls++;
    peakCalls = Math.max(peakCalls, activeCalls);
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
      rateLimit(retryAfter, body) {
        response.resolve(new Response(body ?? "{}", {
          status: 429, headers: { "Retry-After": retryAfter },
        }));
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
      activeCalls--;
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
    engine,
    get peakCalls() { return peakCalls; },
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
    cached(session: TranslationSession, id: string, segments: Segment[]) {
      const result = engine.cached(session, id, segments);
      pending.push(result);
      void result.catch(() => undefined);
      return result;
    },
    async lookedUp(count: number) {
      if (lookups < count) {
        const gate = deferred<void>();
        lookupWaiters.set(count, gate);
        await gate.promise;
      }
      // Let the engine consume the completed lookup and enqueue before asserting no dispatch.
      await nextTurn();
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
  const f = await fixture(t, 2);
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
    await f.cached(page, "reuse", [segment("copy")]);

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

for (const limit of [1, 4, 8]) {
  test(`real provider calls share a global cap of ${limit} across page sessions`, { timeout: 5000 }, async (t) => {
    // Leave four unconfigured to exercise the actual default, not a fixture override.
    const f = await fixture(t, limit === 4 ? undefined : limit);
    const jobs = Array.from({ length: limit + 2 }, (_, index) =>
      f.translate(f.session(), `request-${index}`, [segment(`item-${index}`, `Unique source ${index}`)]));
    await f.called(limit);
    await f.lookedUp(limit * 2 + 2);
    assert.equal(f.calls.length, limit);
    assert.equal(f.peakCalls, limit);
    f.respondAll(["译文"]);
    await Promise.all(jobs);
    assert.equal(f.calls.length, limit + 2);
    assert.equal(f.peakCalls, limit);
    assert.equal((await f.state.usage()).usage.requests, limit + 2);
  });
}

test("raising pumps held work and lowering drains without aborting dispatched calls", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, 1);
  const page = f.session();
  const jobs = Array.from({ length: 8 }, (_, index) =>
    f.translate(page, `request-${index}`, [segment(`item-${index}`, `Unique source ${index}`)]));
  await f.called(1);
  await f.lookedUp(9);
  f.engine.setConcurrency(4);
  await f.called(4);
  f.engine.setConcurrency(1);
  for (const invalid of [0, 9, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => f.engine.setConcurrency(invalid), RequestError);
  assert.ok(f.calls.every((call) => !call.signal.aborted));
  for (const call of f.calls.slice(0, 3)) call.respond(["译文"]);
  await nextTurn();
  assert.equal(f.calls.length, 4, "lowering waits until all excess active work drains");
  f.calls[3]!.respond(["译文"]);
  await f.called(5);
  f.engine.setConcurrency(8);
  await f.called(8);
  assert.ok(f.calls.every((call) => !call.signal.aborted));
  f.respondAll(["译文"]);
  await Promise.all(jobs);
  assert.equal((await f.state.usage()).usage.uncertainRequests, 0);
});

test("a page can queue eight behind busy pages and round-robin still serves another page", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, 8);
  const busy = f.session();
  const waiting = f.session();
  const neighbor = f.session();
  const held = Array.from({ length: 8 }, (_, index) =>
    f.translate(busy, `held-${index}`, [segment(`held-${index}`, `Held source ${index}`)]));
  await f.called(8);
  const queued = Array.from({ length: 8 }, (_, index) =>
    f.translate(waiting, `queued-${index}`, [segment(`queued-${index}`, `Queued source ${index}`)]));
  await f.lookedUp(24);
  await assert.rejects(
    f.translate(waiting, "overflow", [segment("overflow", "Overflow source")]),
    (error: unknown) => error instanceof RequestError && error.detail.code === "rate_limit",
  );
  const other = f.translate(neighbor, "neighbor", [segment("neighbor", "Neighbor source")]);
  await f.lookedUp(26);
  assert.equal(f.calls.length, 8);
  f.calls[0]!.respond(["译文"]);
  await f.called(9);
  assert.match(f.calls[8]!.items[0]!.id, /^queued-/);
  f.calls[1]!.respond(["译文"]);
  await f.called(10);
  assert.equal(f.calls[9]!.items[0]!.id, "neighbor");
  f.respondAll(["译文"]);
  await Promise.all([...held, ...queued, other]);
  assert.equal(f.calls.length, 17);
  assert.equal(f.peakCalls, 8);
});

test("cache-only misses never wait on flights, spend request IDs or reserve usage", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, 1);
  let persisted = 0;
  const page = f.session({ persist: async () => { persisted++; } });
  for (let index = 0; index < 3; index++)
    assert.equal(await f.cached(page, "probe", [segment("missing")]), null);
  assert.equal(page.requests.size, 0);
  assert.equal(persisted, 0);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.state.usage()).usage.requests, 0);
  // Even an exhausted request-ID budget cannot turn a cache miss into billable work.
  for (let index = 0; index < 20_000; index++) page.requests.add(`old-${index}`);
  assert.equal(await f.cached(page, "probe", [segment("missing")]), null);
  assert.equal(page.requests.size, 20_000);
  page.requests.clear();
  const original = f.translate(page, "probe", [segment("original")]);
  await f.called(1);
  assert.equal(await f.cached(page, "pending-copy", [segment("copy")]), null);
  assert.equal(page.requests.has("pending-copy"), false);
  assert.equal(f.calls.length, 1);
  f.calls[0]!.respond(["订阅"]);
  await original;
  const reused = await f.cached(page, "pending-copy", [segment("copy", "Subscribe", "", 8)]);
  assert.deepEqual(reused?.translations, [{ id: "copy", revision: 8, text: "订阅", cached: true }]);
  assert.equal(persisted, 2);
  assert.equal(page.requests.size, 2);
  assert.equal((await f.state.usage()).usage.requests, 1);
});

test("cache-only full hits bypass all occupied slots while exact ordered account/context identity is preserved", { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const page = f.session();
  const sources = [segment("first", "The bank is nearby.", "Finance"), segment("second", "Deposit money.", "Finance")];
  const prime = f.translate(page, "prime", sources);
  await f.called(1);
  f.calls[0]!.respond(["银行就在附近。", "存钱。"]);
  await prime;
  const held = Array.from({ length: 4 }, (_, index) =>
    f.translate(f.session(), `held-${index}`, [segment(`held-${index}`, `Held source ${index}`)]));
  await f.called(5);
  const copies = sources.map((item) => ({ ...item, id: `copy-${item.id}`, revision: 9 }));
  const hit = await f.cached(page, "cached", copies);
  assert.deepEqual(hit, {
    translations: [
      { id: "copy-first", revision: 9, text: "银行就在附近。", cached: true },
      { id: "copy-second", revision: 9, text: "存钱。", cached: true },
    ],
    inputTokens: 0, outputTokens: 0, estimated: false,
  });
  assert.equal(await f.cached(page, "miss", [...copies].reverse()), null);
  assert.equal(await f.cached(page, "miss", copies.map((item) => ({ ...item, context: "River" }))), null);
  assert.equal(await f.cached(page, "miss", [copies[0]!]), null);
  assert.equal(await f.cached(f.session({ fingerprint: "other-account" }), "miss", copies), null);
  page.settings = { ...page.settings, maxConcurrentRequests: 8 };
  assert.ok(await f.cached(page, "new-limit", copies), "concurrency is not part of cache identity");
  assert.equal(f.calls.length, 5);
  assert.equal((await f.state.usage()).usage.inputTokens, 120);
  for (const call of f.calls.slice(1)) call.respond(["译文"]);
  await Promise.all(held);
});

test("429 Retry-After cools all queued dispatch then recovers concurrency one slot at a time", { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 0, 1) });
  const f = await fixture(t);
  const busy = f.session();
  const waiting = f.session();
  const held = Array.from({ length: 4 }, (_, index) =>
    f.translate(busy, `held-${index}`, [segment(`held-${index}`, `Held source ${index}`)]));
  await f.called(4);
  const queued = Array.from({ length: 8 }, (_, index) =>
    f.translate(waiting, `queued-${index}`, [segment(`queued-${index}`, `Queued source ${index}`)]));
  await f.lookedUp(16);
  f.calls[0]!.rateLimit("2");
  for (const call of f.calls.slice(1, 4)) call.respond(["译文"]);
  await nextTurn();
  assert.equal(f.calls.length, 4);
  t.mock.timers.tick(1999);
  await nextTurn();
  assert.equal(f.calls.length, 4);
  t.mock.timers.tick(1);
  await f.called(6);
  await nextTurn();
  assert.equal(f.calls.length, 6, "one bounded retry plus one new call fill the reduced cap of two");
  for (const call of f.calls.slice(4, 6)) call.respond(["译文"]);
  await f.called(9);
  await nextTurn();
  assert.equal(f.calls.length, 9, "two successes recover only one slot");
  for (const call of f.calls.slice(6, 9)) call.respond(["译文"]);
  await f.called(13);
  assert.equal(f.calls.length, 13, "three more successes restore the configured cap of four");
  f.respondAll(["译文"]);
  await Promise.all([...held, ...queued]);
  assert.equal((await f.state.usage()).usage.requests, 13);
  assert.equal((await f.state.usage()).usage.inputTokens, 12 * 120);
  assert.equal((await f.state.usage()).usage.uncertainRequests, 0);
});

test("long provider cooldown keeps unsent queue deadlines and cancellation cannot revive work", { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 0, 1) });
  const f = await fixture(t, 1);
  const busy = f.session();
  const waiting = f.session();
  const cancelled = f.session();
  const first = f.translate(busy, "limited", [segment("limited", "Limited source")]);
  await f.called(1);
  const queued = f.translate(waiting, "expires", [segment("expires", "Queued source")]);
  const stopped = f.translate(cancelled, "stopped", [segment("stopped", "Cancelled source")]);
  await f.lookedUp(4);
  f.calls[0]!.rateLimit("60");
  await assert.rejects(first, (error: unknown) => error instanceof RequestError &&
    error.detail.code === "rate_limit" && !error.detail.uncertain);
  cancelled.controller.abort();
  await assert.rejects(stopped, (error: unknown) => error instanceof RequestError &&
    error.detail.code === "cancelled");
  t.mock.timers.tick(30_000);
  await assert.rejects(queued, (error: unknown) => error instanceof RequestError &&
    error.detail.code === "rate_limit" && /尚未发送/.test(error.detail.message) &&
    !error.dispatched && !error.detail.uncertain);
  t.mock.timers.tick(60_000);
  await nextTurn();
  assert.equal(f.calls.length, 1);
  assert.equal((await f.state.usage()).usage.requests, 1);
  assert.equal((await f.state.usage()).usage.inputTokens, 0);
});

test("held 429 retries obey a lowered cap instead of borrowing logical job slots", { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 0, 1) });
  const f = await fixture(t);
  const page = f.session();
  const jobs = Array.from({ length: 4 }, (_, index) =>
    f.translate(page, `limited-${index}`, [segment(`limited-${index}`, `Limited source ${index}`)]));
  await f.called(4);
  for (const call of f.calls) call.rateLimit("2");
  await nextTurn();
  f.engine.setConcurrency(1);
  t.mock.timers.tick(2000);
  for (let count = 5; count <= 8; count++) {
    await f.called(count);
    await nextTurn();
    assert.equal(f.calls.length, count, "only one new HTTP attempt may be active");
    f.calls[count - 1]!.respond(["译文"]);
  }
  await Promise.all(jobs);
  assert.equal(f.calls.length, 8, "each request retries at most once");
  assert.equal((await f.state.usage()).usage.inputTokens, 4 * 120);
  assert.equal((await f.state.usage()).usage.uncertainRequests, 0);
});

test("a later Retry-After extends the cooldown for retries already waiting to resume", { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 0, 1) });
  const f = await fixture(t, 2);
  const jobs = [
    f.translate(f.session(), "short", [segment("short", "Short backoff")]),
    f.translate(f.session(), "long", [segment("long", "Longer backoff")]),
  ];
  await f.called(2);
  f.calls[0]!.rateLimit("1");
  await nextTurn();
  t.mock.timers.tick(500);
  f.calls[1]!.rateLimit("3");
  await nextTurn();
  t.mock.timers.tick(500);
  await nextTurn();
  assert.equal(f.calls.length, 2, "the first private retry timer cannot bypass shared cooldown");
  t.mock.timers.tick(2499);
  await nextTurn();
  assert.equal(f.calls.length, 2);
  t.mock.timers.tick(1);
  await f.called(3);
  await nextTurn();
  assert.equal(f.calls.length, 3);
  f.calls[2]!.respond(["译文"]);
  await f.called(4);
  f.calls[3]!.respond(["译文"]);
  await Promise.all(jobs);
  assert.equal((await f.state.usage()).usage.requests, 4);
});

test("aborting a retry admission waiter removes it without dispatch or an uncertain charge", { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 0, 1) });
  const f = await fixture(t, 2);
  const firstPage = f.session();
  const secondPage = f.session();
  const first = f.translate(firstPage, "first", [segment("first", "First source")]);
  await f.called(1);
  const second = f.translate(secondPage, "second", [segment("second", "Second source")]);
  await f.called(2);
  f.calls[0]!.rateLimit("1");
  await nextTurn();
  f.calls[1]!.rateLimit("2");
  await nextTurn();
  t.mock.timers.tick(1000);
  await nextTurn();
  assert.equal(f.calls.length, 2);
  firstPage.controller.abort();
  await assert.rejects(first, (error: unknown) => error instanceof RequestError &&
    error.detail.code === "cancelled" && !error.detail.uncertain);
  t.mock.timers.tick(1000);
  await f.called(3);
  assert.equal(f.calls[2]!.items[0]!.id, "second");
  f.calls[2]!.respond(["译文"]);
  await second;
  t.mock.timers.tick(30_000);
  await nextTurn();
  assert.equal(f.calls.length, 3);
  assert.equal((await f.state.usage()).usage.uncertainRequests, 0);
});

test("resetting provider throttle after cancellation clears old cooldown and ignores late old responses", { timeout: 5000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 0, 1) });
  const f = await fixture(t);
  const old = f.session();
  const limited = f.translate(old, "limited", [segment("limited", "Old source")]);
  await f.called(1);
  const late = f.translate(old, "late", [segment("late", "Late old response")]);
  await f.called(2);
  f.calls[0]!.rateLimit("120");
  await assert.rejects(limited, (error: unknown) => error instanceof RequestError &&
    error.detail.code === "rate_limit");
  let finishBody!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      finishBody = () => {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      };
    },
  });
  f.calls[1]!.rateLimit("300", body);
  await nextTurn();
  old.controller.abort();
  f.engine.setConcurrency(4);
  f.engine.resetThrottle();
  const fresh = f.session({
    apiKey: "fixture-new-account",
    fingerprint: "fixture-new-account-fingerprint",
    settings: { ...DEFAULT_SETTINGS, baseUrl: "https://fresh-provider.example", pageTokenLimit: 0 },
  });
  const jobs = Array.from({ length: 4 }, (_, index) =>
    f.translate(fresh, `fresh-${index}`, [segment(`fresh-${index}`, `Fresh source ${index}`)]));
  await f.called(5);
  finishBody();
  await assert.rejects(late, (error: unknown) => error instanceof RequestError &&
    error.detail.code === "cancelled" && !error.detail.uncertain);
  await f.called(6);
  for (const call of f.calls.slice(2)) {
    assert.equal(call.url, "https://fresh-provider.example/chat/completions");
    assert.equal(call.authorization, "Bearer fixture-new-account");
    call.respond(["译文"]);
  }
  await Promise.all(jobs);
  t.mock.timers.tick(300_000);
  await nextTurn();
  assert.equal(f.calls.length, 6);
  assert.equal((await f.state.usage()).usage.inputTokens, 4 * 120);
});
