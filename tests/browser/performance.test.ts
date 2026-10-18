import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright";
import type { Reply, SettingsView } from "../../src/shared";
import { dispatchTranslationCommand, instrumentExtension } from "./extension";

interface ModelInput {
  items: { id: string; text: string }[];
  context: string[];
}

interface HeldRequest {
  input: ModelInput;
  released: boolean;
  aborted: boolean;
  release(translation?: string): void;
}

interface DomNode {
  nodeName: string;
  nodeValue: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

const translationSelector = '[aria-label="Just Translate 译文"]';
const connectionText = "Hello! This is a connection test.";
const financialSource = "The financial institution protects customer deposits.";
const riverSource = "The river embankment was reinforced against flooding.";
const repeatedProse = "The bank is secure.";

function findNode(node: DomNode, id: string): DomNode | undefined {
  const attributes = node.attributes ?? [];
  for (let index = 0; index < attributes.length; index += 2) {
    if (attributes[index] === "id" && attributes[index + 1] === id) return node;
  }
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = findNode(child, id);
    if (found) return found;
  }
}

function translatedText(node: DomNode): string[] {
  if (node.attributes?.includes("parts")) {
    const text = (child: DomNode): string => child.nodeName === "#text"
      ? child.nodeValue
      : (child.children ?? []).map(text).join("");
    return [text(node)];
  }
  return [...(node.children ?? []), ...(node.shadowRoots ?? [])].flatMap(translatedText);
}

function modelTranslation(input: ModelInput, text: string): string {
  if (text === "Subscribe") return "订阅";
  if (text === repeatedProse) {
    const surroundings = [...input.context, ...input.items.map((item) => item.text)].join("\n");
    const financial = surroundings.includes(financialSource);
    const river = surroundings.includes(riverSource);
    if (financial === river) return "上下文错误";
    return financial ? "银行很安全。" : "河岸很稳固。";
  }
  return `译文：${text}`;
}

async function waitForHosts(page: Page, ids: string[], busy: boolean): Promise<void> {
  await page.bringToFront();
  await page.waitForFunction(({ ids, busy, selector }) => ids.every((id) =>
    document.getElementById(id)?.querySelector(selector)?.getAttribute("aria-busy") === String(busy),
  ), { ids, busy, selector: translationSelector });
}

async function expectTranslations(page: Page, expected: [string, string][]): Promise<void> {
  await waitForHosts(page, expected.map(([id]) => id), false);
  const cdp = await page.context().newCDPSession(page);
  try {
    // Production roots remain closed; CDP reads the real rendered translation.
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    for (const [id, text] of expected) {
      const node = findNode(root, id);
      assert.ok(node, `missing translated node ${id}`);
      assert.deepEqual(translatedText(node), [text], `visible translation for ${id}`);
      assert.equal(await page.locator(`#${id} ${translationSelector}`).isVisible(), true);
    }
  } finally {
    await cdp.detach();
  }
}

async function appendControls(page: Page, controls: [string, string][]): Promise<void> {
  await page.evaluate((controls) => {
    if (!("originalControls" in window) || !(window.originalControls instanceof Map)) {
      throw new Error("Missing original control registry");
    }
    const originals = window.originalControls;
    for (const [id, label] of controls) {
      const article = document.createElement("article");
      const button = document.createElement("button");
      button.type = "button";
      button.id = id;
      button.textContent = label;
      originals.set(id, button);
      article.append(button);
      document.body.append(article);
    }
  }, controls);
}

async function renderingBoundary(page: Page): Promise<void> {
  await page.bringToFront();
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  ));
}

async function saveSettings(options: Page, outcome: "success" | "error" = "success"): Promise<void> {
  await options.locator("#save-settings").click();
  // Input clears the previous status; wait for this save's terminal result, not
  // an enabled button observed before the asynchronous save has completed.
  await options.locator(`#form-status[data-kind="${outcome}"]:not(:empty)`).waitFor();
  await options.locator("#save-settings:enabled").waitFor();
}

async function observeDispatches(worker: Worker) {
  await worker.evaluate(`(() => {
    const original = globalThis.fetch.bind(globalThis);
    const changed = new EventTarget();
    const ledger = globalThis.__justTranslatePerformanceDispatches = {
      started: 0,
      active: 0,
      async waitFor(count) {
        while (ledger.started < count) {
          const { promise, resolve } = Promise.withResolvers();
          changed.addEventListener("change", resolve, { once: true });
          await promise;
        }
      }
    };
    globalThis.fetch = (...args) => {
      if (args[1]?.method !== "POST") return original(...args);
      ledger.started++;
      ledger.active++;
      changed.dispatchEvent(new Event("change"));
      return original(...args).finally(() => { ledger.active--; });
    };
  })()`);
  return {
    waitFor: (count: number): Promise<void> =>
      worker.evaluate(`globalThis.__justTranslatePerformanceDispatches.waitFor(${count})`),
    snapshot: (): Promise<{ started: number; active: number }> =>
      worker.evaluate(`(() => {
        const { started, active } = globalThis.__justTranslatePerformanceDispatches;
        return { started, active };
      })()`),
  };
}

async function fixture(t: TestContext, documents: Record<string, string> = {}) {
  const profile = await mkdtemp(path.join(tmpdir(), "just-translate-performance-"));
  const requests: HeldRequest[] = [];
  const changed = new EventEmitter();
  let releaseFuture = false;
  let context: BrowserContext | undefined;
  let stage = "starting fixture";
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html lang="en"><head><title>Translation performance</title>
        <style>p { margin: 0; font: 12px/16px sans-serif; } article { margin: 4px; }</style>
        </head><body>${documents[request.url ?? ""] ?? ""}</body></html>`);
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const input: ModelInput = JSON.parse(JSON.parse(body).messages.at(-1).content);
    assert.equal(request.headers.authorization, "Bearer dummy-performance-key");
    let translationOverride: string | undefined;
    if (input.items[0]?.text !== connectionText) {
      let resolve!: () => void;
      const gate = new Promise<void>((done) => { resolve = done; });
      const held: HeldRequest = {
        input,
        released: false,
        aborted: false,
        release(translation?: string) {
          if (held.released) return;
          held.released = true;
          translationOverride = translation;
          resolve();
        },
      };
      response.on("close", () => {
        if (!response.writableEnded) held.aborted = true;
        changed.emit("change");
      });
      requests.push(held);
      if (releaseFuture) held.release();
      changed.emit("change");
      await gate;
    }
    if (response.destroyed) return;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: { content: JSON.stringify({ items: input.items.map((item) => ({
          id: item.id, text: translationOverride ?? modelTranslation(input, item.text),
        })) }) },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }));
  });
  t.after(async () => {
    t.diagnostic(`Last stage: ${stage}; HTTP requests: ${JSON.stringify(requests.map((request) => ({
      texts: request.input.items.map((item) => item.text),
      released: request.released,
      aborted: request.aborted,
    })))}`);
    releaseFuture = true;
    for (const request of requests) request.release();
    try {
      await context?.close();
    } finally {
      server.closeAllConnections();
      if (server.listening) {
        const closed = once(server, "close");
        server.close();
        await closed;
      }
      await rm(profile, { recursive: true, force: true });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const extension = await instrumentExtension(profile);
  stage = "launching Chromium";
  context = await chromium.launchPersistentContext(profile, {
    executablePath: chromium.executablePath(),
    headless: true,
    viewport: { width: 1280, height: 1000 },
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--enable-unsafe-extension-debugging",
    ],
  });
  const browserContext = context;
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(`chrome.developerPrivate.addHostPermission(${JSON.stringify(extensionId)}, "http://127.0.0.1/*")`);
  await manager.close();
  const options = await context.newPage();
  stage = "saving fixture settings";
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await options.locator("#settings-fields:enabled").waitFor();
  await options.locator('input[value="custom"]').check();
  await options.locator("#base-url").fill(base);
  await options.locator("#model").fill("performance-browser-fixture");
  await options.locator("#api-key").fill("dummy-performance-key");
  await options.locator('input[name="displayMode"][value="translation"]').check();
  await options.locator("#max-concurrent-requests").fill("4");
  await saveSettings(options);

  const settings = async () => {
    const result: Reply<SettingsView> = await options.evaluate(() =>
      chrome.runtime.sendMessage({ type: "settings:get" }));
    assert.ok(result.ok && result.value.configured);
    return result.value;
  };
  assert.equal((await settings()).settings.maxConcurrentRequests, 4);
  stage = "fixture ready";
  return {
    requests,
    options,
    worker,
    settings,
    stage(next: string) { stage = next; },
    async setLimit(limit: number) {
      await options.bringToFront();
      await options.locator("#max-concurrent-requests").fill(String(limit));
      await saveSettings(options);
      assert.equal((await settings()).settings.maxConcurrentRequests, limit);
    },
    async page(route = "/empty") {
      const page = await browserContext.newPage();
      await page.goto(`${base}${route}`);
      await page.evaluate(() => Object.assign(window, { originalControls: new Map() }));
      return page;
    },
    // This invokes the registered handler, not native Option+Q keyboard delivery.
    toggle: (page: Page) => dispatchTranslationCommand(worker, page),
    async waitForRequests(count: number) {
      while (requests.length < count) await once(changed, "change");
    },
    releaseAll() {
      releaseFuture = true;
      for (const request of requests) request.release();
    },
  };
}

// Awaited subtests deliberately use serial, disposable Chromium profiles.
test("translation performance under real browser scheduling", { timeout: 240_000, concurrency: false }, async (t) => {
  await t.test("global capacity changes preserve held work and failed saves preserve capacity", { timeout: 60_000 }, async (t) => {
    const f = await fixture(t);
    // Isolate HTTP scheduling capacity from temporary worst-case token reservations.
    await f.options.locator("#data-title").click();
    await f.options.locator("#page-token-limit").fill("100000");
    await saveSettings(f.options);
    assert.equal((await f.settings()).settings.pageTokenLimit, 100000);
    const dispatches = await observeDispatches(f.worker);
    const first = await f.page("/first");
    const second = await f.page("/second");
    const firstControls: [string, string][] = [
      ["first-alpha", "Action alpha"], ["first-beta", "Action beta"], ["first-gamma", "Action gamma"],
    ];
    const secondControls: [string, string][] = [
      ["second-delta", "Action delta"], ["second-epsilon", "Action epsilon"], ["second-zeta", "Action zeta"],
    ];
    await appendControls(first, firstControls);
    await appendControls(second, secondControls);
    await f.toggle(first);
    f.stage("waiting for three first-page requests");
    await f.waitForRequests(3);
    await f.toggle(second);
    f.stage("waiting for the fourth shared request");
    await f.waitForRequests(4);
    await waitForHosts(first, firstControls.map(([id]) => id), true);
    await waitForHosts(second, secondControls.map(([id]) => id), true);
    await renderingBoundary(second);
    assert.equal(f.requests.length, 4, "two pages share the configured four global slots");
    assert.equal(f.requests.filter((request) => !request.released).length, 4);
    assert.ok(f.requests.every((request) => request.input.items.length === 1));
    assert.deepEqual(await dispatches.snapshot(), { started: 4, active: 4 });

    f.stage("saving capacity one with four requests held");
    await f.setLimit(1);
    await waitForHosts(first, firstControls.map(([id]) => id), true);
    await waitForHosts(second, secondControls.map(([id]) => id), true);
    assert.ok(f.requests.every((request) => !request.aborted), "lowering does not abort held calls");
    f.stage("draining first-page requests under capacity one");
    for (const request of f.requests.slice(0, 3)) {
      const label = request.input.items[0]!.text;
      const control = firstControls.find(([, text]) => text === label)!;
      request.release();
      await expectTranslations(first, [[control[0], `译文：${label}`]]);
      assert.equal(f.requests.length, 4, "no queued dispatch while active work is at or above one");
    }
    const fourth = f.requests[3]!;
    f.stage("releasing the last original slot to admit one queued request");
    fourth.release();
    const fourthControl = secondControls.find(([, text]) => text === fourth.input.items[0]!.text)!;
    await expectTranslations(second, [[fourthControl[0], `译文：${fourthControl[1]}`]]);
    await f.waitForRequests(5);
    assert.equal(f.requests.length, 5, "one queued request starts only after active work falls below one");

    f.stage("saving capacity eight");
    await f.setLimit(8);
    await f.waitForRequests(6);
    const extra: [string, string][] = Array.from({ length: 7 }, (_, index) =>
      [`extra-${index}`, `Additional action ${index}`]);
    await appendControls(second, extra);
    await waitForHosts(second, extra.map(([id]) => id), true);
    f.stage("waiting for eight extension fetch dispatch slots");
    // This fixture serves HTTP/1.1: Chromium's per-origin socket ceiling may
    // hold fetches before the server receives them. The disposable worker ledger
    // measures extension dispatch capacity, not eight simultaneous HTTP sockets.
    await dispatches.waitFor(12);
    await renderingBoundary(second);
    assert.deepEqual(await dispatches.snapshot(), { started: 12, active: 8 },
      "raising admits eight model fetches, including browser-transport-queued fetches");
    assert.ok(f.requests.every((request) => !request.aborted));
    f.stage("reloading options and rejecting a capacity save");
    await f.options.bringToFront();
    await f.options.reload();
    await f.options.locator("#settings-fields:enabled").waitFor();
    assert.equal(await f.options.locator("#max-concurrent-requests").inputValue(), "8");
    const beforeFailure = await f.settings();
    await f.worker.evaluate(`(() => {
      const original = chrome.storage.local.set.bind(chrome.storage.local);
      chrome.storage.local.set = async (items, ...rest) => {
        if (Object.hasOwn(items, "justTranslate.settings")) {
          chrome.storage.local.set = original;
          throw new Error("Injected settings commit failure");
        }
        return original(items, ...rest);
      };
    })()`);
    await f.options.locator("#max-concurrent-requests").fill("1");
    await saveSettings(f.options, "error");
    assert.equal(await f.options.locator("#form-status").getAttribute("data-kind"), "error");
    assert.deepEqual(await f.settings(), beforeFailure, "failed persistence retains the saved limit");
    f.stage("releasing one slot after failed save");
    f.requests[4]!.release();
    await dispatches.waitFor(13);
    assert.deepEqual(await dispatches.snapshot(), { started: 13, active: 8 },
      "failed save retains eight extension dispatch slots");
    assert.ok(f.requests.every((request) => !request.aborted));
    f.stage("releasing all model responses");
    f.releaseAll();
    await expectTranslations(first, firstControls.map(([id, text]) => [id, `译文：${text}`]));
    await expectTranslations(second, [...secondControls, ...extra].map(([id, text]) => [id, `译文：${text}`]));
    assert.equal(f.requests.length, 13, "capacity changes never resubmit paid work");
    assert.deepEqual(await dispatches.snapshot(), { started: 13, active: 0 },
      "all dispatched fetches finish without duplicate paid work");
    f.stage("restoring original controls");
    for (const [page, controls] of [[first, firstControls], [second, [...secondControls, ...extra]]] as const) {
      await f.toggle(page);
      await page.waitForFunction((selector) => !document.querySelector(selector), translationSelector);
      for (const [id, label] of controls) {
        assert.equal(await page.locator(`#${id}`).innerText(), label);
        assert.equal(await page.evaluate((id) => {
          if (!("originalControls" in window) || !(window.originalControls instanceof Map)) {
            throw new Error("Missing original control registry");
          }
          return window.originalControls.get(id) === document.getElementById(id);
        }, id), true, "restoration preserves original node ownership");
      }
    }
    f.stage("complete");
  });

  await t.test("cached and pending labels bypass saturated page slots without extra API work", { timeout: 60_000 }, async (t) => {
    const f = await fixture(t);
    const page = await f.page();
    await appendControls(page, [["prime", "Subscribe"]]);
    await f.toggle(page);
    await f.waitForRequests(1);
    f.requests[0]!.release();
    await expectTranslations(page, [["prime", "订阅"]]);
    const controls: [string, string][] = [
      ["held-alpha", "Held alpha"], ["held-beta", "Held beta"],
      ["held-gamma", "Held gamma"], ["held-delta", "Held delta"],
    ];
    await appendControls(page, controls);
    await f.waitForRequests(5);
    await waitForHosts(page, controls.map(([id]) => id), true);
    assert.equal(f.requests.filter((request) => !request.released).length, 4);
    await appendControls(page, [["pending-copy", "Held alpha"], ["cached-copy", "Subscribe"]]);
    await waitForHosts(page, ["pending-copy"], true);
    await expectTranslations(page, [["cached-copy", "订阅"]]);
    assert.equal(f.requests.length, 5, "cached label renders while every network slot remains held");
    assert.equal(f.requests.filter((request) => !request.released).length, 4, "pending copy must not starve the cached label");
    const alpha = f.requests.find((request) => request.input.items.some((item) => item.text === "Held alpha"))!;
    alpha.release();
    await expectTranslations(page, [["held-alpha", "译文：Held alpha"], ["pending-copy", "译文：Held alpha"]]);
    assert.equal(f.requests.length, 5, "late in-flight duplicate shares the existing result");
    assert.equal(f.requests.filter((request) => request.input.items.some((item) => item.text === "Held alpha")).length, 1);
    // Cancel with three paid requests still held, then deliver their late responses.
    await f.toggle(page);
    await page.waitForFunction((selector) => !document.querySelector(selector), translationSelector);
    for (const [id, label] of [...controls, ["prime", "Subscribe"], ["pending-copy", "Held alpha"], ["cached-copy", "Subscribe"]]) {
      assert.equal(await page.locator(`#${id}`).innerText(), label);
    }
    f.releaseAll();
    await appendControls(page, [["after-stop", "Subscribe"]]);
    await renderingBoundary(page);
    assert.equal(await page.locator(translationSelector).count(), 0, "cancelled sessions do not resurrect translations");
    assert.equal(f.requests.length, 5, "cancelled work is not retried");
  });

  await t.test("clearing cache separates pending label generations without cancelling subscribers", { timeout: 60_000 }, async (t) => {
    const f = await fixture(t);
    const page = await f.page();
    const oldIds = ["before-clear", "before-clear-copy"];
    await appendControls(page, oldIds.map((id) => [id, "Subscribe"]));
    await f.toggle(page);
    f.stage("holding the pre-clear Subscribe flight");
    await f.waitForRequests(1);
    await waitForHosts(page, oldIds, true);
    assert.equal(f.requests.length, 1, "original subscribers share one model request");

    f.stage("clearing cache from trusted options while the old flight is pending");
    const cleared: Reply<{ cleared: number }> = await f.options.evaluate(() =>
      chrome.runtime.sendMessage({ type: "cache:clear" }));
    assert.ok(cleared.ok, "trusted cache clearing succeeds");
    await waitForHosts(page, oldIds, true);
    assert.equal(f.requests[0]!.aborted, false, "cache clearing does not cancel existing subscribers");

    await appendControls(page, [["after-clear", "Subscribe"]]);
    f.stage("waiting for a separate post-clear Subscribe request");
    await f.waitForRequests(2);
    await waitForHosts(page, ["after-clear"], true);
    assert.equal(f.requests.length, 2, "a post-clear label cannot reuse the pre-clear flight");
    assert.ok(f.requests.every((request) =>
      request.input.items.length === 1 && request.input.items[0]!.text === "Subscribe"));
    assert.ok(f.requests.every((request) => !request.released && !request.aborted));

    f.stage("finishing the new generation before the old response");
    f.requests[1]!.release("订阅（新）");
    await expectTranslations(page, [["after-clear", "订阅（新）"]]);
    await waitForHosts(page, oldIds, true);
    f.requests[0]!.release("订阅（旧）");
    await expectTranslations(page, [
      ...oldIds.map((id): [string, string] => [id, "订阅（旧）"]),
      ["after-clear", "订阅（新）"],
    ]);
    assert.ok(f.requests.every((request) => !request.aborted),
      "old and new subscribers finish their own generation");

    f.stage("reusing only the new generation's cached result");
    await appendControls(page, [["cached-after-clear", "Subscribe"]]);
    await expectTranslations(page, [["cached-after-clear", "订阅（新）"]]);
    assert.equal(f.requests.length, 2, "late cache reuse adds no third model request");
    await f.toggle(page);
    await page.waitForFunction((selector) => !document.querySelector(selector), translationSelector);
    for (const id of [...oldIds, "after-clear", "cached-after-clear"]) {
      assert.equal(await page.locator(`#${id}`).innerText(), "Subscribe");
    }
    f.stage("complete");
  });

  await t.test("first-screen prose starts small, keeps neighbor context and finishes in larger batches", { timeout: 60_000 }, async (t) => {
    const financial = [financialSource, repeatedProse, ...Array.from({ length: 10 }, (_, index) =>
      `Financial neighboring detail ${index}: ${financialSource} Customers review account statements and discuss their savings with an adviser.`)];
    const river = [riverSource, repeatedProse];
    const prose = (id: string, texts: string[]) => `<article id="${id}">${texts.map((text, index) =>
      `<p id="${id}-${index}">${text}</p>`).join("")}</article>`;
    const f = await fixture(t, { "/prose": prose("financial", financial) + prose("river", river) });
    await f.setLimit(1);
    const page = await f.page("/prose");
    await f.toggle(page);
    await f.waitForRequests(1);
    const first = f.requests[0]!.input;
    assert.ok(first.items.length > 0 && first.items.length <= 2, "first visible request contains at most two segments");
    assert.ok(first.items.length === 1 || first.items.reduce((sum, item) => sum + item.text.length, 0) <= 1600,
      "first request has bounded text, except an indivisible long segment");
    assert.ok(financial.some((text) =>
      !first.items.some((item) => item.text === text) && first.context.some((hint) => hint.includes(text))),
    "small first batch retains an adjacent contextual hint");
    assert.equal(first.context.some((hint) => hint.includes(riverSource)), false);
    f.requests[0]!.release();
    await expectTranslations(page, first.items.map((item): [string, string] => {
      const index = financial.indexOf(item.text);
      assert.notEqual(index, -1, "the first visible request belongs to the first article");
      return [`financial-${index}`, modelTranslation(first, item.text)];
    }));
    await f.waitForRequests(2);
    f.releaseAll();
    const expected: [string, string][] = [
      ...financial.map((text, index): [string, string] => [
        `financial-${index}`, text === repeatedProse ? "银行很安全。" : `译文：${text}`,
      ]),
      ...river.map((text, index): [string, string] => [
        `river-${index}`, text === repeatedProse ? "河岸很稳固。" : `译文：${text}`,
      ]),
    ];
    await expectTranslations(page, expected);
    assert.ok(f.requests.slice(1).some((request) => request.input.items.length > 2), "remaining prose uses normal larger batches");
    assert.equal(f.requests.flatMap((request) => request.input.items).length, financial.length + river.length,
      "all paragraphs translate exactly once");
    for (const { input } of f.requests) {
      const surroundings = [...input.context, ...input.items.map((item) => item.text)].join("\n");
      assert.equal(surroundings.includes(financialSource) && surroundings.includes(riverSource), false,
        "batch optimization must not cross financial/river context boundaries");
    }
    await f.toggle(page);
    await page.waitForFunction((selector) => !document.querySelector(selector), translationSelector);
    for (const [prefix, texts] of [["financial", financial], ["river", river]] as const) {
      for (const [index, text] of texts.entries()) {
        assert.equal(await page.locator(`#${prefix}-${index}`).innerText(), text);
      }
    }
  });
});
