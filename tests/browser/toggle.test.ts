import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type BrowserContext, type Worker } from "playwright";
import { clickToolbar, instrumentExtension } from "./extension";

for (const mode of ["bilingual", "translation"] as const) {
  test(`${mode}: shortcut intent owns one session and control labels retain layout`, { timeout: 90_000 }, async (t) => {
    const profile = await mkdtemp(path.join(tmpdir(), "just-translate-toggle-"));
    const events = new EventEmitter();
    const requests: string[][] = [];
    const pending: { release: () => void; finished: Promise<void> }[] = [];
    let hold = false;
    const originals = [
      "A translation session must belong to one page.",
      "Starting again must not duplicate the translation.",
    ];
    const server = createServer(async (request, response) => {
      if (request.method === "POST") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(JSON.parse(body).messages.at(-1).content);
        const isPage = input.items[0]?.text !== "Hello! This is a connection test.";
        let finish: (() => void) | undefined;
        if (isPage) {
          requests.push(input.items.map((item: { text: string }) => item.text));
          if (hold) {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            const finished = new Promise<void>((resolve) => { finish = resolve; });
            pending.push({ release, finished });
            events.emit("requested");
            await gate;
          }
        }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            items: input.items.map((item: { id: string; text: string }) => ({
              id: item.id,
              text: item.text === "Upgrade to paid" ? "升级到付费版" : `译文：${item.text}`,
            })),
          }) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 30 },
        }));
        finish?.();
        return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html lang="en"><title>Toggle and control layout</title>
        <div style="white-space:nowrap"><button id="upgrade" style="display:inline-block;height:48px;line-height:48px;padding:0 24px;border:0;border-radius:8px;background:#ff8018;font-size:20px"><span>Upgrade to paid</span></button><button id="neighbor" translate="no" style="height:48px;margin-left:12px">Next</button></div>
        <div id="below" translate="no">Content below the controls.</div>
        <article>${originals.map((text) => `<p>${text}</p>`).join("")}</article></html>`);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    let context: BrowserContext | undefined;
    t.after(async () => {
      for (const gate of pending) gate.release();
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
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--enable-unsafe-extension-debugging"],
    });
    let worker: Worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    const manager = await context.newPage();
    await manager.goto("chrome://extensions");
    await manager.evaluate(`chrome.developerPrivate.addHostPermission(${JSON.stringify(id)}, "http://127.0.0.1/*")`);
    await manager.evaluate("chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})");
    const optionsUrl = `chrome-extension://${id}/options.html`;
    let options = await context.newPage();
    await options.goto(optionsUrl);
    await options.locator('input[value="custom"]').check();
    await options.locator("#base-url").fill(base);
    await options.locator("#model").fill("toggle-regression");
    await options.locator("#api-key").fill("local-toggle-key");
    await options.locator("#remember-key").check();
    await options.locator(`input[name="displayMode"][value="${mode}"]`).check();
    await options.locator("#test-connection").click();
    await options.locator("#test-connection:enabled").waitFor();
    const page = await context.newPage();
    await page.goto(`${base}/article`);
    const browser = context.browser();
    assert.ok(browser);
    const cdp = await browser.newBrowserCDPSession();
    const focusSettings = async () => {
      // A serviceworker target can appear before Chrome can deliver toolbar events.
      await worker.evaluate("globalThis.__justTranslateBrowserTest.ready");
      const existing = context!.pages().find((candidate) => candidate.url() === optionsUrl);
      const opened = existing ? Promise.resolve(existing) : context!.waitForEvent("page");
      await clickToolbar(cdp, id, page);
      options = await opened;
      await options.waitForURL(optionsUrl);
      await options.waitForFunction(async () => {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        return active?.url === location.href;
      });
    };
    const command = async () => {
      await page.bringToFront();
      await worker.evaluate(`(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        await globalThis.__justTranslateBrowserTest.commandListeners[0]("toggle-translation", tab);
      })()`);
    };
    const complete = () => page.waitForFunction(() =>
      document.querySelectorAll('[aria-label="Just Translate 译文"][aria-busy="false"]').length === 3);
    const restored = async () => {
      await page.waitForFunction(() => !document.querySelector('[aria-label="Just Translate 译文"]'));
      assert.deepEqual(await page.locator("article p").allTextContents(), originals);
      assert.equal(await page.locator("#upgrade").innerText(), "Upgrade to paid");
    };
    await focusSettings();
    const initialHeight = await page.locator("#upgrade").evaluate((button) => button.getBoundingClientRect().height);
    const initialBelow = await page.locator("#below").evaluate((node) => node.getBoundingClientRect().top);
    await page.evaluate("window.upgradeClicks = 0; document.getElementById('upgrade').addEventListener('click', () => window.upgradeClicks++)");

    // Delay script injection, request off, then release the old start. The final
    // command promise is a completion barrier, not a timer-based race assertion.
    const interruptedStart = async (restart: boolean) => {
      await page.bringToFront();
      return worker.evaluate(`(async () => {
        const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
        const command = globalThis.__justTranslateBrowserTest.commandListeners[0];
        const inject = chrome.scripting.executeScript.bind(chrome.scripting);
        const send = chrome.tabs.sendMessage.bind(chrome.tabs);
        let release, entered, starts = 0, held = false;
        const gate = new Promise(resolve => release = resolve);
        const waiting = new Promise(resolve => entered = resolve);
        chrome.scripting.executeScript = async (...args) => {
          if (!held) { held = true; entered(); await gate; }
          return inject(...args);
        };
        chrome.tabs.sendMessage = (...args) => {
          if (args[1].type === "page:start") starts++;
          return send(...args);
        };
        try {
          const first = command("toggle-translation", tab);
          await waiting;
          const off = command("toggle-translation", tab);
          const latest = ${restart} ? command("toggle-translation", tab) : Promise.resolve();
          release();
          await Promise.all([first, off, latest]);
          return starts;
        } finally {
          chrome.scripting.executeScript = inject;
          chrome.tabs.sendMessage = send;
        }
      })()`);
    };
    assert.equal(await interruptedStart(false), 0, "cancelled startup must never reach page:start");
    await restored();
    assert.equal(requests.length, 0, "off during startup must not send a model request");
    assert.equal(await interruptedStart(true), 1, "only the latest on intent may start a session");
    await complete();
    assert.deepEqual(await page.locator("article p, #upgrade").evaluateAll((blocks) =>
      blocks.map((block) => block.querySelectorAll('[aria-label="Just Translate 译文"]').length)), [1, 1, 1]);
    assert.equal(await page.locator("#upgrade").evaluate((button) => button.getBoundingClientRect().height), initialHeight);
    assert.equal(await page.locator("#below").evaluate((node) => node.getBoundingClientRect().top), initialBelow,
      "translated controls must not push the following row down");
    const fits = await page.locator('#upgrade [aria-label="Just Translate 译文"]').evaluate((host) => {
      const label = host.getBoundingClientRect();
      const button = host.closest("button")!.getBoundingClientRect();
      return label.top >= button.top && label.bottom <= button.bottom;
    });
    assert.equal(fits, true);
    await page.locator("#upgrade").click();
    assert.equal(await page.evaluate("window.upgradeClicks"), 1);
    const completedRequests = requests.length;
    await command();
    await restored();
    assert.equal(requests.length, completedRequests, "turning off must not start another translation");

    await options.evaluate(() => chrome.runtime.sendMessage({ type: "cache:clear" }));
    hold = true;
    const requested = once(events, "requested");
    await command();
    await requested;
    assert.equal(await page.locator("#upgrade").evaluate((button) => button.getBoundingClientRect().height), initialHeight,
      "inline loading must retain the control height");
    await command();
    await restored();
    hold = false;
    for (const gate of pending) gate.release();
    await Promise.all(pending.map((gate) => gate.finished));
    await page.clock.install();
    await page.clock.runFor(1000);
    await restored();

    await command();
    await complete();
    // Reload the extension without refreshing the page. The next injection must
    // dispose the old context's views and virtual source before creating another.
    const nextWorker = context.waitForEvent("serviceworker");
    await manager.evaluate(`new Promise((resolve, reject) => chrome.developerPrivate.reload(${JSON.stringify(id)}, {failQuietly:true}, error => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(error)))`);
    worker = await nextWorker;
    await focusSettings();
    await command();
    await complete();
    assert.deepEqual(await page.locator("article p, #upgrade").evaluateAll((blocks) =>
      blocks.map((block) => block.querySelectorAll('[aria-label="Just Translate 译文"]').length)), [1, 1, 1],
      "extension replacement must not stack a second view on any source");
    await command();
    await restored();
    assert.equal(await page.locator("#upgrade").evaluate((button) => button.getBoundingClientRect().height), initialHeight);
    await cdp.detach();
  });
}
