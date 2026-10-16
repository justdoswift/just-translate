import assert from "node:assert/strict";
import test from "node:test";
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
