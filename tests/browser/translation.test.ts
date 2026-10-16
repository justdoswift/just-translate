import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type BrowserContext } from "playwright";

interface DomNode {
  nodeName: string;
  nodeValue: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

// CDP can inspect the extension's closed shadow root without weakening it.
function translatedText(node: DomNode): string[] {
  if (node.attributes?.includes("parts")) {
    const text = (child: DomNode): string =>
      child.nodeName === "#text"
        ? child.nodeValue
        : (child.children ?? []).map(text).join("");
    return [text(node)];
  }
  return [...(node.children ?? []), ...(node.shadowRoots ?? [])].flatMap(
    translatedText,
  );
}

test(
  "saved configuration translates current and newly loaded content, and stopping restores the page",
  { timeout: 60_000 },
  async (t) => {
    const profile = await mkdtemp(path.join(tmpdir(), "just-translate-page-"));
    const requested: string[] = [];
    const connectionText = "Hello! This is a connection test.";
    const modelGate = new EventEmitter();
    let holdFirstPageRequest = true;
    const translations = new Map([
      ["Read this page in your own language.", "用你自己的语言阅读此页面。"],
      [
        "A two-line card hides appended translations.",
        "卡片限制两行时，不应把追加的整段译文裁掉。",
      ],
      [
        "A linked story inside a compact button.",
        "紧凑按钮内的文章标题也需要翻译。",
      ],
      ["Derek Guy", "Derek Guy"],
      [
        "New paragraphs should appear automatically.",
        "新增段落应自动显示译文。",
      ],
    ]);
    const server = createServer(async (request, response) => {
      if (request.method === "POST") {
        if (request.headers.authorization === "Bearer rejected-test-key") {
          response.writeHead(401, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { code: "invalid_api_key" } }));
          return;
        }
        let body = "";
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(JSON.parse(body).messages.at(-1).content);
        const items = input.items.map((item: { id: string; text: string }) => {
          requested.push(item.text);
          return {
            id: item.id,
            translation:
              item.text === connectionText
                ? "你好！这是一次连接测试。"
                : translations.get(item.text),
          };
        });
        if (holdFirstPageRequest && input.items[0]?.text !== connectionText) {
          holdFirstPageRequest = false;
          const released = once(modelGate, "release");
          modelGate.emit("requested");
          await released;
        }
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            choices: [
              {
                message: { content: JSON.stringify({ items }) },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 30 },
          }),
        );
        return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        '<!doctype html><html lang="en"><title>Translation regression</title><div role="button"><p id="original">Read this page in your own language.</p></div><div id="clamped" style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;width:180px;line-height:20px">A two-line card hides appended translations.</div><button id="preview" style="height:20px;overflow:hidden"><div>A linked story inside a compact button.</div></button><div id="same">Derek Guy</div><form><input value="Private form text"></form></html>',
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    let context: BrowserContext | undefined;
    t.after(async () => {
      await context?.close();
      server.closeAllConnections();
      const closed = once(server, "close");
      server.close();
      await closed;
      await rm(profile, { recursive: true, force: true });
    });
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const extension = path.resolve(".output/chrome-mv3");
    context = await chromium.launchPersistentContext(profile, {
      executablePath: chromium.executablePath(),
      headless: true,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        "--enable-unsafe-extension-debugging",
      ],
    });
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    // Grant only the fixture API in this disposable Chrome profile. Native
    // permission dialogs cannot be accepted by a headless page driver.
    const manager = await context.newPage();
    await manager.goto("chrome://extensions");
    await manager.evaluate(
      `chrome.developerPrivate.addHostPermission(${JSON.stringify(id)}, "http://127.0.0.1/*")`,
    );
    await manager.close();
    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await options.locator('input[value="custom"]').check();
    await options.locator("#base-url").fill(base);
    await options.locator("#model").fill("browser-regression");
    await options.locator("#api-key").fill("local-regression-key");
    await options.locator("#test-connection").click();
    await options.locator("#test-connection:enabled").waitFor();
    const saved = await options.evaluate(() =>
      chrome.runtime.sendMessage({ type: "settings:get" }),
    );
    assert.equal(
      saved.value.configured,
      true,
      "successful connection test must save the configuration used by the toolbar",
    );
    assert.equal(saved.value.settings.baseUrl, base);
    const commands = await worker.evaluate(() => chrome.commands.getAll());
    const shortcut = commands.find(
      (command) => command.name === "toggle-translation",
    )?.shortcut;
    assert.equal(shortcut, process.platform === "darwin" ? "⌥Q" : "Alt+Q");
    assert.equal(
      await options.locator("#configure-shortcut").innerText(),
      `翻译快捷键：${shortcut}`,
    );

    const page = await context.newPage();
    await page.goto(`${base}/article`);
    await page.evaluate(
      "window.originalNode = document.getElementById('original')",
    );
    const originalHeight = await page
      .locator("#clamped")
      .evaluate((node) => node.getBoundingClientRect().height);
    await page.evaluate(
      "window.previewClicks = 0; document.getElementById('preview').addEventListener('click', () => window.previewClicks++)",
    );
    const browser = context.browser();
    assert.ok(browser);
    const rootCdp = await browser.newBrowserCDPSession();
    const pageCdp = await context.newCDPSession(page);
    // Toolbar and named command share one serialized handler. This dispatch
    // tests that handler, not native macOS keyboard event delivery.
    const toggle = async () => {
      await page.bringToFront();
      const { targetInfos } = await rootCdp.send("Target.getTargets", {
        filter: [{ type: "tab", exclude: false }, { exclude: true }],
      });
      const target = targetInfos.find((entry) => entry.url === page.url());
      assert.ok(target);
      await rootCdp.send("Extensions.triggerAction", {
        id,
        targetId: target.targetId,
      });
    };
    const waitForTranslations = async (expected: string[]) => {
      await page.waitForFunction(
        (count) =>
          document.querySelectorAll('[aria-label="Just Translate 译文"]')
            .length === count,
        expected.length,
        { timeout: 10_000 },
      );
      const { root } = await pageCdp.send("DOM.getDocument", {
        depth: -1,
        pierce: true,
      });
      assert.deepEqual(translatedText(root).sort(), [...expected].sort());
    };
    const firstRequest = once(modelGate, "requested");
    await toggle();
    await firstRequest;
    const progress = page.locator('[aria-label="Just Translate 翻译状态"]');
    assert.equal(await progress.isVisible(), true);
    assert.equal(await progress.getAttribute("aria-busy"), "true");
    assert.equal(
      await page.locator('[aria-label="Just Translate 译文"]').count(),
      0,
    );
    modelGate.emit("release");
    await waitForTranslations([...translations.values()].slice(0, 3));
    const unclipped = await page.locator("#clamped").evaluate((node) => {
      const source = node.getBoundingClientRect();
      const translation = node
        .querySelector('[aria-label="Just Translate 译文"]')!
        .getBoundingClientRect();
      return translation.height > 0 && translation.bottom <= source.bottom + 1;
    });
    assert.equal(
      unclipped,
      true,
      "card line clamps must not hide translated text",
    );
    await page.locator("#preview").click();
    assert.equal(await page.evaluate("window.previewClicks"), 1);
    assert.equal(
      await page.locator("#preview [aria-label='Just Translate 译文']").count(),
      0,
    );
    // A website re-render may delete only the injected child. Restore it from
    // the completed task, without another billable request.
    await page
      .locator("#original [aria-label='Just Translate 译文']")
      .evaluate((host) => host.remove());
    await waitForTranslations([...translations.values()].slice(0, 3));
    await page.evaluate(() => {
      const paragraph = document.createElement("p");
      paragraph.textContent = "New paragraphs should appear automatically.";
      document.body.append(paragraph);
    });
    await waitForTranslations(
      [...translations]
        .filter(([source, translation]) => source !== translation)
        .map(([, translation]) => translation),
    );
    assert.equal(
      await page.locator("#same [aria-label='Just Translate 译文']").count(),
      0,
    );
    assert.deepEqual(requested, [connectionText, ...translations.keys()]);
    await toggle();
    await page.waitForFunction(
      () => !document.querySelector('[aria-label="Just Translate 译文"]'),
    );
    assert.equal(await progress.count(), 0);
    assert.equal(
      await page
        .locator("#clamped")
        .evaluate((node) => node.getBoundingClientRect().height),
      originalHeight,
    );
    assert.equal(
      await page.evaluate(
        "window.originalNode === document.getElementById('original')",
      ),
      true,
    );
    assert.equal(
      await page.locator("#original").innerText(),
      "Read this page in your own language.",
    );
    assert.equal(await page.locator("input").inputValue(), "Private form text");
    await page.clock.install();
    await page.evaluate(() => {
      const paragraph = document.createElement("p");
      paragraph.textContent = "Do not send content after translation stops.";
      document.body.append(paragraph);
    });
    // Advance the page's timers without delaying the test in wall-clock time.
    await page.clock.runFor(1000);
    assert.deepEqual(requested, [connectionText, ...translations.keys()]);

    // A failed test must not replace the last working toolbar configuration.
    await options.bringToFront();
    await options.locator("#api-key").fill("rejected-test-key");
    await options.locator("#test-connection").click();
    await options.locator("#test-connection:enabled").waitFor();
    const afterFailure = await options.evaluate(() =>
      chrome.runtime.sendMessage({ type: "settings:get" }),
    );
    assert.equal(afterFailure.value.apiKey, "local-regression-key");
    assert.equal(
      await options.locator("#form-status").getAttribute("data-kind"),
      "error",
    );
    await pageCdp.detach();
    await rootCdp.detach();
  },
);
