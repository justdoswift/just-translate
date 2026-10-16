import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type BrowserContext } from "playwright";

// Exercise Chrome's permission boundary, not just the source manifest fields.
test(
  "a fresh install cannot read a website before a toolbar gesture, and startup failures are visible",
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
    const extensionPath = path.resolve(".output/chrome-mv3");
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
    const targets = await cdp.send("Target.getTargets", {
      filter: [{ type: "tab", exclude: false }, { exclude: true }],
    });
    const target = targets.targetInfos.find(
      (candidate) => candidate.url === page.url(),
    );
    assert.ok(target);
    await cdp.send("Extensions.triggerAction", {
      id: extensionId,
      targetId: target.targetId,
    });
    const optionsUrl = `chrome-extension://${extensionId}/options.html`;
    const options =
      context.pages().find((candidate) => candidate.url() === optionsUrl) ??
      (await context.waitForEvent("page"));
    await options.waitForURL(optionsUrl);
    await options.locator("#startup-error:not([hidden])").waitFor();
    assert.match(
      await options.locator("#startup-error-message").innerText(),
      /API Key/,
    );
    assert.equal(await readTab(tabId), "Read only after a user gesture.");

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
