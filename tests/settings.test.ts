import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DEFAULT_SETTINGS } from "../src/shared";
import { SettingsStore } from "../src/background/settings";

function storageArea(initial: Record<string, unknown>) {
  const values = structuredClone(initial);
  return {
    async setAccessLevel() {},
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
    async remove(key: string) {
      delete values[key];
    },
  };
}

test("upgrading settings keeps the provider, budget and session key while adding display mode", async (t) => {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  t.after(() => {
    if (originalChrome)
      Object.defineProperty(globalThis, "chrome", originalChrome);
    else Reflect.deleteProperty(globalThis, "chrome");
  });
  const { displayMode: _, ...legacy } = {
    ...DEFAULT_SETTINGS,
    provider: "custom" as const,
    baseUrl: "https://model.example/v1",
    model: "saved-provider-model",
    monthlyBudgetUsd: 2,
    targetLanguage: "ja",
  };
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: storageArea({ "justTranslate.settings": legacy }),
        session: storageArea({ "justTranslate.apiKey": "test-session-key" }),
      },
    },
  });
  const store = new SettingsStore();
  await store.initialize();
  assert.deepEqual(store.view(), {
    settings: { ...legacy, displayMode: "bilingual" },
    apiKey: "test-session-key",
    configured: true,
  });
});

function installStorage(t: TestContext, rememberKey: boolean) {
  const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  t.after(() => {
    if (originalChrome) Object.defineProperty(globalThis, "chrome", originalChrome);
    else Reflect.deleteProperty(globalThis, "chrome");
  });
  const settings = {
    ...DEFAULT_SETTINGS,
    provider: "custom" as const,
    baseUrl: "https://previous.example/v1",
    model: "previous-model",
    rememberKey,
  };
  const local = storageArea({
    "justTranslate.settings": settings,
    ...(rememberKey ? { "justTranslate.apiKey": "previous-test-key" } : {}),
  });
  const session = storageArea(
    rememberKey ? {} : { "justTranslate.apiKey": "previous-test-key" },
  );
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { storage: { local, session }, permissions: { contains: async () => true } },
  });
  return { settings, local, session };
}

for (const rememberedBefore of [false, true]) {
  for (const rememberedAfter of [false, true]) {
    test(`failed configuration commit retains its credential across restart (${rememberedBefore} → ${rememberedAfter})`, async (t) => {
      const { settings, local } = installStorage(t, rememberedBefore);
      const store = new SettingsStore();
      await store.initialize();
      const before = store.view();
      const fingerprint = store.fingerprint;
      const fail = t.mock.method(local, "set", async () => {
        throw new Error("local storage unavailable");
      });
      await assert.rejects(store.save({
        ...settings,
        baseUrl: "https://replacement.example/v1",
        model: "replacement-model",
        rememberKey: rememberedAfter,
      }, "replacement-test-key"), /local storage unavailable/);
      assert.deepEqual(store.view(), before, "a failed commit must leave the running configuration unchanged");
      assert.equal(store.fingerprint, fingerprint);
      fail.mock.restore();
      const restarted = new SettingsStore();
      await restarted.initialize();
      assert.deepEqual(restarted.view(), before, "worker recovery must not pair the old provider with the staged new credential");
      assert.equal(restarted.fingerprint, fingerprint);
    });
  }
}

test("failed session staging leaves the committed settings and key untouched", async (t) => {
  const { settings, local, session } = installStorage(t, false);
  const store = new SettingsStore();
  await store.initialize();
  const before = store.view();
  const persisted = await local.get(["justTranslate.settings", "justTranslate.apiKey"]);
  t.mock.method(session, "set", async () => { throw new Error("session storage unavailable"); });
  await assert.rejects(store.save({
    ...settings,
    baseUrl: "https://replacement.example/v1",
  }, "replacement-test-key"), /session storage unavailable/);
  assert.deepEqual(store.view(), before);
  assert.deepEqual(await local.get(["justTranslate.settings", "justTranslate.apiKey"]), persisted);
  const restarted = new SettingsStore();
  await restarted.initialize();
  assert.deepEqual(restarted.view(), before);
});

for (const rememberedAfter of [false, true]) {
  test(`committed settings remain successful when credential cleanup fails (remember=${rememberedAfter})`, async (t) => {
    const { settings, local, session } = installStorage(t, !rememberedAfter);
    const store = new SettingsStore();
    await store.initialize();
    const next = { ...settings, model: "replacement-model", rememberKey: rememberedAfter };
    const set = session.set.bind(session);
    const fault = rememberedAfter
      ? t.mock.method(session, "remove", async () => { throw new Error("cleanup unavailable"); })
      : t.mock.method(session, "set", async (items: Record<string, unknown>) => {
        const committed = await local.get("justTranslate.settings");
        const configuration = committed["justTranslate.settings"];
        if (configuration && typeof configuration === "object" &&
          "model" in configuration && configuration.model === next.model)
          throw new Error("cleanup unavailable");
        await set(items);
      });
    const saved = await store.save(next, "replacement-test-key");
    assert.deepEqual(saved, { settings: next, apiKey: "replacement-test-key", configured: true });
    if (!rememberedAfter)
      assert.equal((await local.get("justTranslate.apiKey"))["justTranslate.apiKey"], "",
        "switching to session-only storage must erase the remembered secret in the commit itself");
    fault.mock.restore();
    const restarted = new SettingsStore();
    await restarted.initialize();
    assert.deepEqual(restarted.view(), saved);
  });
}

test("an empty replacement credential cannot erase a usable configuration", async (t) => {
  const { settings } = installStorage(t, false);
  const store = new SettingsStore();
  await store.initialize();
  const before = store.view();
  await assert.rejects(store.save(settings, "   "), /API Key/);
  assert.deepEqual(store.view(), before);
  const restarted = new SettingsStore();
  await restarted.initialize();
  assert.deepEqual(restarted.view(), before);
});

test("a later failed save cannot replace an already committed session credential", async (t) => {
  const { settings, local } = installStorage(t, false);
  const initial = new SettingsStore();
  await initial.initialize();
  const committed = await initial.save({ ...settings, model: "committed-model" }, "committed-test-key");
  const store = new SettingsStore();
  await store.initialize();
  const failure = t.mock.method(local, "set", async () => { throw new Error("commit unavailable"); });
  await assert.rejects(store.save({ ...settings, model: "uncommitted-model" }, "uncommitted-test-key"), /commit unavailable/);
  assert.deepEqual(store.view(), committed);
  failure.mock.restore();
  const restarted = new SettingsStore();
  await restarted.initialize();
  assert.deepEqual(restarted.view(), committed);
});
