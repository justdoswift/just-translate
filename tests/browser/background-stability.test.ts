import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type BrowserContext } from "playwright";
import { type SettingsView, type SettingsSaveResult, type Reply } from "../../src/shared";
import { dispatchTranslationCommand, instrumentExtension } from "./extension";

test("a failed settings commit preserves the running page and its provider credential", { timeout: 60_000 }, async (t) => {
  const profile = await mkdtemp(path.join(tmpdir(), "just-translate-background-"));
  const credentials: (string | undefined)[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(JSON.parse(body).messages.at(-1).content);
      credentials.push(request.headers.authorization);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          items: input.items.map((item: { id: string; text: string }) => ({
            id: item.id, text: `译文：${item.text}`,
          })),
        }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      }));
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end('<!doctype html><html lang="en"><title>Configuration continuity</title><article><p>A usable configuration must keep this page translated.</p></article></html>');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  let context: BrowserContext | undefined;
  t.after(async () => {
    await context?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  });
  const extension = await instrumentExtension(profile);
  context = await chromium.launchPersistentContext(profile, {
    executablePath: chromium.executablePath(),
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).host;
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(`chrome.developerPrivate.addHostPermission(${JSON.stringify(id)}, "http://127.0.0.1/*")`);
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.locator("#settings-fields:enabled").waitFor();
  await options.locator('input[value="custom"]').check();
  await options.locator("#base-url").fill(base);
  await options.locator("#model").fill("previous-model");
  await options.locator("#api-key").fill("previous-test-key");
  await options.locator("#save-settings").click();
  await options.locator("#save-settings:enabled").waitFor();
  const saved: Reply<SettingsView> = await options.evaluate(() =>
    chrome.runtime.sendMessage({ type: "settings:get" }));
  assert.ok(saved.ok && saved.value.configured, "initial configuration must be saved through a real permission gesture");
  const settings = saved.value.settings;
  const page = await context.newPage();
  await page.goto(`${base}/article`);
  await dispatchTranslationCommand(worker, page);
  await page.locator('[aria-label="Just Translate 译文"][aria-busy="false"]').waitFor();
  await worker.evaluate(`(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = async (items, ...rest) => {
      if (Object.hasOwn(items, "justTranslate.settings")) {
        chrome.storage.local.set = original;
        throw new Error("Injected settings commit failure");
      }
      return original(items, ...rest);
    };
  })()`);
  const failed: Reply<SettingsView> = await options.evaluate((configuration) =>
    chrome.runtime.sendMessage({ type: "settings:save", settings: configuration, apiKey: "replacement-test-key" }),
    { ...settings, model: "replacement-model" });
  assert.equal(failed.ok, false);
  const current: Reply<SettingsView> = await options.evaluate(() => chrome.runtime.sendMessage({ type: "settings:get" }));
  assert.deepEqual(current, saved, "an unsuccessful save must not change the running configuration");
  assert.equal(await page.locator('[aria-label="Just Translate 译文"][aria-busy="false"]').count(), 1,
    "failed persistence must not stop an otherwise usable page session");
  await page.locator("article").evaluate((article) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = "Newly expanded material still uses the previously saved account.";
    article.append(paragraph);
  });
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Just Translate 译文"][aria-busy="false"]').length === 2);
  assert.ok(credentials.length >= 2);
  assert.ok(credentials.every((key) => key === "Bearer previous-test-key"),
    "a failed account change cannot send subsequent page content with the replacement key");
  await dispatchTranslationCommand(worker, page);
  await page.waitForFunction(() => !document.querySelector('[aria-label="Just Translate 译文"]'));
  for (const storageKey of ["justTranslate.cache", "justTranslate.sessions"]) {
    // Keep a session active so settings saves must also persist its removal.
    await dispatchTranslationCommand(worker, page);
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="Just Translate 译文"][aria-busy="false"]').length === 2);
    await worker.evaluate((key) => {
      const original = chrome.storage.session.set.bind(chrome.storage.session);
      chrome.storage.session.set = async (items) => {
        if (Object.hasOwn(items, key)) {
          chrome.storage.session.set = original;
          throw new Error("Injected postcommit cleanup failure");
        }
        return original(items);
      };
    }, storageKey);
    const committed: Reply<SettingsSaveResult> = await options.evaluate((configuration) =>
      chrome.runtime.sendMessage({ type: "settings:save", settings: configuration, apiKey: "committed-test-key" }),
      { ...settings, model: storageKey });
    assert.ok(committed.ok, "postcommit cleanup failure must not misreport a rolled-back configuration");
    assert.ok(committed.value.warning, "a committed save must disclose incomplete cleanup");
    const persisted: Reply<SettingsView> = await options.evaluate(() => chrome.runtime.sendMessage({ type: "settings:get" }));
    assert.ok(persisted.ok);
    assert.equal(persisted.value.settings.model, storageKey);
    assert.equal(persisted.value.apiKey, "committed-test-key");
    await page.waitForFunction(() => !document.querySelector('[aria-label="Just Translate 译文"]'));
  }
  await dispatchTranslationCommand(worker, page);
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Just Translate 译文"][aria-busy="false"]').length === 2);
  await page.bringToFront();
  await worker.evaluate(`(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const command = globalThis.__justTranslateBrowserTest.commandListeners[0];
    const set = chrome.storage.session.set.bind(chrome.storage.session);
    const send = chrome.tabs.sendMessage.bind(chrome.tabs);
    let release, pinged;
    let holding = true;
    const gate = new Promise(resolve => release = resolve);
    const earlyPing = new Promise(resolve => pinged = resolve);
    chrome.storage.session.set = async items => {
      if (Object.hasOwn(items, "justTranslate.sessions")) {
        chrome.storage.session.set = set;
        throw new Error("Injected stop persistence failure");
      }
      return set(items);
    };
    chrome.tabs.sendMessage = async (...args) => {
      if (args[1]?.type === "page:stop" && holding) await gate;
      const reply = await send(...args);
      if (args[1]?.type === "page:ping" && holding) pinged();
      return reply;
    };
    try {
      const off = command("toggle-translation", tab);
      const on = command("toggle-translation", tab);
      await Promise.race([earlyPing, new Promise(resolve => setTimeout(resolve, 250))]);
      holding = false;
      release();
      await Promise.all([off, on]);
    } finally {
      holding = false;
      release();
      chrome.tabs.sendMessage = send;
      chrome.storage.session.set = set;
    }
  })()`);
  const restarted = await worker.evaluate<Reply<{ active: boolean }>>(`(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return chrome.tabs.sendMessage(tab.id, { type: "page:ping" });
  })()`);
  assert.ok(restarted.ok && restarted.value.active,
    "the latest on intent must survive failed stop persistence and a delayed page notification");
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Just Translate 译文"][aria-busy="false"]').length === 2);
  await dispatchTranslationCommand(worker, page);
  await page.waitForFunction(() => !document.querySelector('[aria-label="Just Translate 译文"]'));
  const secondPage = await context.newPage();
  await secondPage.goto(`${base}/second-article`);
  await dispatchTranslationCommand(worker, page);
  await dispatchTranslationCommand(worker, secondPage);
  await secondPage.locator('[aria-label="Just Translate 译文"][aria-busy="false"]').waitFor();
  await worker.evaluate(`(async () => {
    const [secondTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const set = chrome.storage.session.set.bind(chrome.storage.session);
    const send = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.storage.session.set = async items => {
      if (Object.hasOwn(items, "justTranslate.sessions")) {
        chrome.storage.session.set = set;
        throw new Error("Injected multi-page cleanup failure");
      }
      return set(items);
    };
    chrome.tabs.sendMessage = async (...args) => {
      if (args[0] === secondTab.id && args[1]?.type === "page:stop") {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return send(...args);
    };
    globalThis.__justTranslateBrowserTest.restoreSend = () => {
      chrome.tabs.sendMessage = send;
      chrome.storage.session.set = set;
    };
  })()`);
  try {
    const committed: Reply<SettingsSaveResult> = await options.evaluate((configuration) =>
      chrome.runtime.sendMessage({ type: "settings:save", settings: configuration, apiKey: "committed-test-key" }),
      { ...settings, model: "multi-page-cleanup" });
    assert.ok(committed.ok && committed.value.warning);
    await dispatchTranslationCommand(worker, secondPage);
    const secondSnapshot = await worker.evaluate<Reply<{ active: boolean }>>(`(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.tabs.sendMessage(tab.id, { type: "page:ping" });
    })()`);
    assert.ok(secondSnapshot.ok && secondSnapshot.value.active,
      "a settings save must finish stopping every page before a new command can start");
    await secondPage.locator('[aria-label="Just Translate 译文"][aria-busy="false"]').waitFor();
  } finally {
    await worker.evaluate("globalThis.__justTranslateBrowserTest.restoreSend()");
  }
});

test("startup keeps endpoint and credential together across a concurrent settings commit", { timeout: 60_000 }, async (t) => {
  const profile = await mkdtemp(path.join(tmpdir(), "just-translate-startup-"));
  const requests: { url: string | undefined; authorization: string | undefined }[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(JSON.parse(body).messages.at(-1).content);
      requests.push({ url: request.url, authorization: request.headers.authorization });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          items: input.items.map((item: { id: string; text: string }) => ({
            id: item.id, text: `译文：${item.text}`,
          })),
        }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      }));
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end('<!doctype html><html lang="en"><article><p>Provider credentials must stay with their original endpoint.</p></article></html>');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  let context: BrowserContext | undefined;
  t.after(async () => {
    await context?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  });
  const extension = await instrumentExtension(profile);
  context = await chromium.launchPersistentContext(profile, {
    executablePath: chromium.executablePath(),
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).host;
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(`chrome.developerPrivate.addHostPermission(${JSON.stringify(id)}, "http://127.0.0.1/*")`);
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.locator("#settings-fields:enabled").waitFor();
  await options.locator('input[value="custom"]').check();
  await options.locator("#base-url").fill(`${base}/previous`);
  await options.locator("#model").fill("test-model");
  await options.locator("#api-key").fill("previous-test-key");
  await options.locator("#save-settings").click();
  await options.locator("#save-settings:enabled").waitFor();
  const saved: Reply<SettingsView> = await options.evaluate(() =>
    chrome.runtime.sendMessage({ type: "settings:get" }));
  assert.ok(saved.ok && saved.value.configured);
  const page = await context.newPage();
  await page.goto(`${base}/article`);
  await page.bringToFront();
  await worker.evaluate(`(() => {
    const harness = globalThis.__justTranslateBrowserTest;
    const execute = chrome.scripting.executeScript.bind(chrome.scripting);
    const set = chrome.storage.session.set.bind(chrome.storage.session);
    let injected, committed, releaseInjection, releaseCleanup;
    harness.injected = new Promise(resolve => injected = resolve);
    harness.committed = new Promise(resolve => committed = resolve);
    const injectionGate = new Promise(resolve => releaseInjection = resolve);
    const cleanupGate = new Promise(resolve => releaseCleanup = resolve);
    chrome.scripting.executeScript = async (...args) => {
      const result = await execute(...args);
      injected();
      await injectionGate;
      return result;
    };
    chrome.storage.session.set = async items => {
      const keys = items["justTranslate.apiKey"];
      if (keys && Object.keys(keys).length === 1 &&
          Object.values(keys)[0] === "replacement-test-key") {
        committed();
        await cleanupGate;
      }
      return set(items);
    };
    harness.releaseInjection = releaseInjection;
    harness.releaseCleanup = releaseCleanup;
    harness.restoreStartupRace = () => {
      releaseInjection();
      releaseCleanup();
      chrome.scripting.executeScript = execute;
      chrome.storage.session.set = set;
    };
  })()`);
  let save: Promise<Reply<SettingsSaveResult>> | undefined;
  try {
    await worker.evaluate(`(async () => {
      const harness = globalThis.__justTranslateBrowserTest;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      harness.startup = harness.commandListeners[0]("toggle-translation", tab);
      await harness.injected;
    })()`);
    save = options.evaluate((configuration) =>
      chrome.runtime.sendMessage({
        type: "settings:save", settings: configuration, apiKey: "replacement-test-key",
      }), { ...saved.value.settings, baseUrl: `${base}/replacement` });
    await worker.evaluate("globalThis.__justTranslateBrowserTest.committed");
    await worker.evaluate(`(async () => {
      const harness = globalThis.__justTranslateBrowserTest;
      harness.releaseInjection();
      await harness.startup;
    })()`);
    await page.locator('[aria-label="Just Translate 译文"][aria-busy="false"]').waitFor();
    assert.deepEqual(requests, [{
      url: "/previous/chat/completions", authorization: "Bearer previous-test-key",
    }], "a startup snapshot must never pair the replacement endpoint with the previous credential");
    await worker.evaluate("globalThis.__justTranslateBrowserTest.releaseCleanup()");
    assert.ok((await save).ok);
    await page.waitForFunction(() => !document.querySelector('[aria-label="Just Translate 译文"]'));
    await dispatchTranslationCommand(worker, page);
    await page.locator('[aria-label="Just Translate 译文"][aria-busy="false"]').waitFor();
    assert.deepEqual(requests[1], {
      url: "/replacement/chat/completions", authorization: "Bearer replacement-test-key",
    });
  } finally {
    await worker.evaluate("globalThis.__justTranslateBrowserTest.restoreStartupRace()");
    await save;
  }
});
