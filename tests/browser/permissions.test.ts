import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type BrowserContext } from "playwright";

import {
  clickToolbar,
  dispatchTranslationCommand,
  instrumentExtension,
  pageReadCount,
} from "./extension";
// Exercise Chrome's permission boundary, not just the source manifest fields.
test(
  "toolbar opens settings without page access; only the command reports missing configuration",
  { timeout: 60_000 },
  async (t) => {
    const profile = await mkdtemp(
      path.join(tmpdir(), "just-translate-permissions-"),
    );
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        "<!doctype html><title>Permission boundary</title><p id='private'>Read only after a user gesture.</p>",
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    let context: BrowserContext | undefined;
    t.after(async () => {
      await context?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    });
    if (!address || typeof address === "string")
      throw new Error("No local server address");
    const extensionPath = await instrumentExtension(profile);
    context = await chromium.launchPersistentContext(profile, {
      executablePath: chromium.executablePath(),
      headless: true,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--enable-unsafe-extension-debugging",
      ],
    });
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/article`);
    await page.bringToFront();
    const tabId = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id === undefined) throw new Error("No active tab");
      return tab.id;
    });
    // A string keeps Node's TS loader helpers out of the function Chrome injects.
    const readTab = (id: number) =>
      worker.evaluate<string>(
        `chrome.scripting.executeScript({
      target: { tabId: ${id} },
      func: () => document.getElementById("private")?.textContent
    }).then(results => results[0]?.result)`,
      );
    await assert.rejects(readTab(tabId), /permission|Cannot access/i);

    const browser = context.browser();
    assert.ok(browser);
    const cdp = await browser.newBrowserCDPSession();
    const readsBeforeClick = await pageReadCount(worker);
    await clickToolbar(cdp, extensionId, page);
    const optionsUrl = `chrome-extension://${extensionId}/options.html`;
    const options =
      context.pages().find((candidate) => candidate.url() === optionsUrl) ??
      (await context.waitForEvent("page"));
    await options.waitForURL(optionsUrl);
    await options.locator("#settings-fields:enabled").waitFor();
    assert.equal(await options.locator("#startup-error").isVisible(), false);
    assert.equal(
      await pageReadCount(worker),
      readsBeforeClick,
      "opening settings must not inject content scripts or message the page",
    );
    assert.equal(
      await worker.evaluate(async () =>
        (await chrome.storage.session.get("justTranslate.startupError"))[
          "justTranslate.startupError"
        ]),
      undefined,
      "a toolbar click must not create a translation startup error",
    );
    await clickToolbar(cdp, extensionId, page);
    await options.waitForFunction(async () => {
      const [active] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      return active?.url === location.href;
    });
    assert.equal(
      context.pages().filter((candidate) => candidate.url() === optionsUrl).length,
      1,
      "repeated toolbar clicks reuse the settings tab",
    );
    assert.equal(await pageReadCount(worker), readsBeforeClick);
    assert.equal(await options.locator("#startup-error").isVisible(), false);
    assert.equal(await readTab(tabId), "Read only after a user gesture.");

    // Invoke the captured production command listener, not a physical shortcut.
    // The preceding toolbar gesture supplies Chrome's activeTab permission.
    await dispatchTranslationCommand(worker, page);
    await options.locator("#startup-error:not([hidden])").waitFor();
    assert.match(
      await options.locator("#startup-error-message").innerText(),
      /API Key/,
    );

    // The gesture grants only this document, not every site or tab.
    const other = await context.newPage();
    await other.goto(`http://127.0.0.1:${address.port}/another`);
    await other.bringToFront();
    const otherId = await worker.evaluate(
      async () =>
        (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id,
    );
    assert.ok(otherId !== undefined);
    await assert.rejects(readTab(otherId), /permission|Cannot access/i);
    await cdp.detach();
  },
);
