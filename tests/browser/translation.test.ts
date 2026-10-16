import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
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

for (const displayMode of ["bilingual", "translation"] as const) {
  test(
    `${displayMode}: saved configuration translates new content and stopping restores original nodes`,
    { timeout: 60_000 },
    async (t) => {
      const profile = await mkdtemp(
        path.join(tmpdir(), "just-translate-page-"),
      );
      const requested: string[] = [];
      const connectionText = "Hello! This is a connection test.";
      const modelGate = new EventEmitter();
      let holdPageRequest = true;
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
      let contextHtml: string | undefined;
      const pageRequests: {
        items: { id: string; text: string }[];
        context: string[];
      }[] = [];
      const server = createServer(async (request, response) => {
        if (request.method === "POST") {
          if (request.headers.authorization === "Bearer rejected-test-key") {
            response.writeHead(401, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({ error: { code: "invalid_api_key" } }),
            );
            return;
          }
          let body = "";
          for await (const chunk of request) body += chunk;
          const input = JSON.parse(JSON.parse(body).messages.at(-1).content);
          if (input.items[0]?.text !== connectionText) pageRequests.push(input);
          const items = input.items.map(
            (item: { id: string; text: string }) => {
              requested.push(item.text);
              return {
                id: item.id,
                text:
                  item.text === connectionText
                    ? "你好！这是一次连接测试。"
                    : translations.get(item.text),
              };
            },
          );
          if (holdPageRequest && input.items[0]?.text !== connectionText) {
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
          contextHtml ??
            '<!doctype html><html lang="en"><title>Translation regression</title><div role="button"><p id="original">Read <a id="read-link" href="#read">this page</a> in your own language.</p></div><div id="clamped" style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;width:180px;line-height:20px">A two-line card hides appended translations.</div><button id="preview" style="height:20px;overflow:hidden"><div>A linked story inside a compact button.</div></button><div id="same">Derek Guy</div><form><input value="Private form text"></form></html>',
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
      const extension = await instrumentExtension(profile);
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
      await options
        .locator(`input[name="displayMode"][value="${displayMode}"]`)
        .check();
      await options.locator("#test-connection").click();
      await options.locator("#test-connection:enabled").waitFor();
      const saved = await options.evaluate(() =>
        chrome.runtime.sendMessage({ type: "settings:get" }),
      );
      assert.equal(
        saved.value.configured,
        true,
        "successful connection test must save the configuration used by the command",
      );
      assert.equal(saved.value.settings.baseUrl, base);
      assert.equal(saved.value.settings.displayMode, displayMode);
      await options.reload();
      await options.locator("#settings-fields:enabled").waitFor();
      assert.equal(
        await options
          .locator(`input[name="displayMode"][value="${displayMode}"]`)
          .isChecked(),
        true,
        "saved display mode must survive reloading settings",
      );
      const commands = await worker.evaluate(() => chrome.commands.getAll());
      const shortcut = commands.find(
        (command) => command.name === "toggle-translation",
      )?.shortcut;
      assert.equal(shortcut, process.platform === "darwin" ? "⌥Q" : "Alt+Q");

      const page = await context.newPage();
      await page.goto(`${base}/article`);
      await page.evaluate(
        "window.originalNode = document.getElementById('original')",
      );
      await page.evaluate(
        "window.originalLink = document.getElementById('read-link')",
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
      // Capture and invoke the production named-command listener. No native
      // keyboard injection or physical shortcut coverage is claimed here.
      const toggle = () => dispatchTranslationCommand(worker, page);
      const readsBeforeToolbar = await pageReadCount(worker);
      const requestsBeforeToolbar = requested.length;
      await clickToolbar(rootCdp, id, page);
      await options.waitForFunction(async () => {
        const [active] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        return active?.url === location.href;
      });
      assert.equal(await pageReadCount(worker), readsBeforeToolbar);
      assert.equal(requested.length, requestsBeforeToolbar);
      assert.equal(
        await page.locator('[aria-label="Just Translate 译文"]').count(),
        0,
        "toolbar must only open settings, even with valid configuration",
      );
      const waitForTranslations = async (expected: string[]) => {
        await page.waitForFunction(
          (count) =>
            !document.querySelector(
              '[aria-label="Just Translate 译文"][aria-busy="true"]',
            ) &&
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
      const translationsOnPage = page.locator(
        '[aria-label="Just Translate 译文"]',
      );
      assert.equal(await translationsOnPage.count(), 4);
      for (const host of await translationsOnPage.all()) {
        assert.equal(await host.isVisible(), true);
        assert.equal(await host.getAttribute("aria-busy"), "true");
      }
      const belowOriginal = await page.locator("#original").evaluate((node) => {
        const original = document.createRange();
        original.selectNodeContents(node.firstChild!);
        const loading = node
          .querySelector('[aria-label="Just Translate 译文"]')!
          .getBoundingClientRect();
        return loading.top >= original.getBoundingClientRect().bottom;
      });
      assert.equal(
        belowOriginal,
        true,
        "loading occupies the paragraph's translation slot",
      );
      assert.equal(
        await page.locator('[aria-label="Just Translate 翻译状态"]').count(),
        0,
        "translation must not create a floating progress panel",
      );
      holdPageRequest = false;
      modelGate.emit("release");
      await waitForTranslations([...translations.values()].slice(0, 3));
      assert.equal(
        await page.locator("#read-link").isVisible(),
        displayMode === "bilingual",
      );
      assert.equal(
        await page.evaluate(
          "window.originalLink === document.getElementById('read-link')",
        ),
        true,
        "translation-only display must retain the original link node",
      );
      const unclipped = await page.locator("#clamped").evaluate((node) => {
        const source = node.getBoundingClientRect();
        const translation = node
          .querySelector('[aria-label="Just Translate 译文"]')!
          .getBoundingClientRect();
        return (
          translation.height > 0 && translation.bottom <= source.bottom + 1
        );
      });
      assert.equal(
        unclipped,
        true,
        "card line clamps must not hide translated text",
      );
      await page.locator("#preview").click();
      assert.equal(await page.evaluate("window.previewClicks"), 1);
      const readsWhileActive = await pageReadCount(worker);
      const requestsWhileActive = requested.length;
      const sessionIds = () => worker.evaluate(async () => {
        const stored = await chrome.storage.session.get("justTranslate.sessions");
        const sessions = stored["justTranslate.sessions"];
        if (!Array.isArray(sessions)) throw new Error("Missing active sessions");
        return sessions.map((session: unknown) => {
          if (!session || typeof session !== "object" ||
            !("id" in session) || typeof session.id !== "string")
            throw new Error("Invalid active session");
          return session.id;
        });
      });
      const sessionsWhileActive = await sessionIds();
      assert.equal(sessionsWhileActive.length, 1);
      await clickToolbar(rootCdp, id, page);
      await options.waitForFunction(async () => {
        const [active] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        return active?.url === location.href;
      });
      assert.equal(await pageReadCount(worker), readsWhileActive);
      assert.equal(requested.length, requestsWhileActive);
      assert.deepEqual(
        await sessionIds(),
        sessionsWhileActive,
        "opening settings must preserve the active translation session",
      );
      await page.bringToFront();
      await waitForTranslations([...translations.values()].slice(0, 3));
      if (displayMode === "translation") {
        const translatedButton = page.locator(
          "#preview [aria-label='Just Translate 译文']",
        );
        assert.equal(await translatedButton.isVisible(), true);
        const fits = await translatedButton.evaluate(
          (host) =>
            host.getBoundingClientRect().bottom <=
            host.closest("button")!.getBoundingClientRect().bottom + 1,
        );
        assert.equal(
          fits,
          true,
          "translated-only button labels must remain visible and clickable",
        );
      }
      // A website re-render may delete only the injected child. Restore it from
      // the completed task, without another billable request.
      await page
        .locator("#original [aria-label='Just Translate 译文']")
        .evaluate((host) => host.remove());
      await waitForTranslations([...translations.values()].slice(0, 3));
      if (displayMode === "translation") {
        await page.locator("#clamped").evaluate((node) => {
          node.textContent = "A two-line card hides appended translations.";
        });
        await waitForTranslations([...translations.values()].slice(0, 3));
        const replacementHidden = await page
          .locator("#clamped")
          .evaluate((node) => {
            const range = document.createRange();
            range.selectNodeContents(node.firstChild!);
            return range.getBoundingClientRect().height === 0;
          });
        assert.equal(
          replacementHidden,
          true,
          "same-text website rerenders must hide the replacement source too",
        );
      }
      holdPageRequest = true;
      const dynamicRequest = once(modelGate, "requested");
      await page.evaluate(() => {
        const paragraph = document.createElement("p");
        paragraph.id = "dynamic";
        paragraph.textContent = "New paragraphs should appear automatically.";
        document.body.append(paragraph);
      });
      await dynamicRequest;
      const dynamicLoading = page.locator(
        "#dynamic [aria-label='Just Translate 译文']",
      );
      assert.equal(await dynamicLoading.isVisible(), true);
      assert.equal(await dynamicLoading.getAttribute("aria-busy"), "true");
      assert.equal(
        await page
          .locator("#original [aria-label='Just Translate 译文']")
          .getAttribute("aria-busy"),
        "false",
        "loading new content must not reset completed paragraphs",
      );
      holdPageRequest = false;
      modelGate.emit("release");
      await waitForTranslations(
        [...translations]
          .filter(([source, translation]) => source !== translation)
          .map(([, translation]) => translation),
      );
      assert.equal(
        await page.locator("#same [aria-label='Just Translate 译文']").count(),
        0,
      );
      assert.deepEqual(
        [...requested].sort(),
        [connectionText, ...translations.keys()].sort(),
        "each source is requested once, regardless of viewport scheduling",
      );
      await toggle();
      await page.waitForFunction(
        () => !document.querySelector('[aria-label="Just Translate 译文"]'),
      );
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
      assert.equal(await page.locator("#read-link").isVisible(), true);
      assert.equal(
        await page.evaluate(
          "window.originalLink === document.getElementById('read-link')",
        ),
        true,
      );
      assert.equal(
        await page
          .locator("#preview")
          .evaluate((node) => node.getBoundingClientRect().height),
        20,
      );
      assert.equal(
        await page.locator("input").inputValue(),
        "Private form text",
      );
      await page.clock.install();
      await page.evaluate(() => {
        const paragraph = document.createElement("p");
        paragraph.textContent = "Do not send content after translation stops.";
        document.body.append(paragraph);
      });
      // Advance the page's timers without delaying the test in wall-clock time.
      await page.clock.runFor(1000);
      assert.deepEqual(
        [...requested].sort(),
        [connectionText, ...translations.keys()].sort(),
      );

      // A failed test must not replace the last working command configuration.
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
      if (displayMode === "translation") {
        const groups = [
          [
            "A laboratory in Paris.",
            "Maya founded the laboratory.",
            "She hired two researchers.",
          ],
          ["A cooking lesson in Rome.", "Marco kneaded the dough."],
          ["A mountain travel card.", "The guide climbed the peak."],
          ["A separate ocean travel card.", "The sailor crossed the bay."],
          ["A reader comments about cycling."],
          ["Another reader comments about music."],
        ] as const;
        const groupOf = new Map(
          groups.flatMap((texts, group) =>
            texts.map((text) => [text, group] as const),
          ),
        );
        for (const [text] of groupOf)
          translations.set(text, `译文：${groupOf.get(text)}`);
        contextHtml = `<!doctype html><html lang="en"><title>Related context</title>
        <section id="lab"><h2>${groups[0][0]}</h2><p>${groups[0][1]}</p><p>${groups[0][2]}</p>
          <h2>${groups[1][0]}</h2><p>${groups[1][1]}</p></section>
        <div class="card"><p>${groups[2][0]}</p><p>${groups[2][1]}</p></div>
        <div class="card"><p>${groups[3][0]}</p><p>${groups[3][1]}</p></div>
        <div data-comment-id="one"><p>${groups[4][0]}</p></div>
        <div data-comment-id="two"><p>${groups[5][0]}</p></div></html>`;
        const requestStart = pageRequests.length;
        await page.goto(`${base}/context`);
        await toggle();
        await waitForTranslations(
          [...groupOf].map(([text]) => translations.get(text)!),
        );
        const groupedRequests = pageRequests.slice(requestStart);
        assert.deepEqual(
          groupedRequests
            .map((request) => request.items.map((item) => item.text))
            .sort(),
          [...groups].sort(),
          "related prose stays ordered; headings, cards and comments are separate requests",
        );
        const added = "He baked it in the oven.";
        translations.set(added, "他把面团放进烤箱烘烤。");
        await page.evaluate((text) => {
          const paragraph = document.createElement("p");
          paragraph.id = "context-dynamic";
          paragraph.textContent = text;
          document.getElementById("lab")!.append(paragraph);
        }, added);
        await page.waitForFunction(() =>
          document.querySelector('#context-dynamic [aria-busy="false"]'),
        );
        const request = pageRequests.find((candidate) =>
          candidate.items.some((item) => item.text === added),
        )!;
        assert.ok(request.context.join("").includes(groups[1][1]));
        assert.ok(
          !request.context.join("").includes(groups[0][2]),
          "new prose must not inherit a previous heading section",
        );
        assert.ok(
          groups
            .slice(2)
            .flat()
            .every((text) => !request.context.join("").includes(text)),
        );
        assert.ok(request.context.join("").length <= 1200);
        await toggle();
        await page.waitForFunction(
          () => !document.querySelector('[aria-label="Just Translate 译文"]'),
        );
        assert.equal(await page.locator("#context-dynamic").innerText(), added);

        const clipped = "Clipped inline source must remain stable.";
        const mutable = "The website can replace this original text.";
        const replacement = "The website has replaced its original text.";
        const cleared = "The website can explicitly clear this text.";
        translations.set(clipped, "行内裁剪内容的译文应保持稳定。");
        translations.set(mutable, "网站可以替换这段原文。");
        translations.set(replacement, "网站已经替换了原文。");
        translations.set(cleared, "网站可以清空这段文字。");
        contextHtml = `<!doctype html><html lang="en"><title>Source ownership</title>
          <p id="clip"><span style="display:inline-block;overflow:hidden">${clipped}</span></p>
          <div><p id="mutable">${mutable}</p></div>
          <div><p id="cleared">${cleared}</p></div></html>`;
        await page.goto(`${base}/source-ownership`);
        await page.evaluate(`window.mutableText = document.getElementById("mutable").firstChild;
          window.clearedText = document.getElementById("cleared").firstChild;`);
        await toggle();
        await waitForTranslations([clipped, mutable, cleared].map((text) => translations.get(text)!));
        await page.locator("#clip").evaluate((node) => {
          const host = node.querySelector('[aria-label="Just Translate 译文"]')!;
          host.setAttribute("data-stability-check", "original");
        });
        await page.clock.runFor(2000);
        assert.equal(
          await page.locator('#clip [data-stability-check="original"]').count(),
          1,
          "hidden clipped source must not repeatedly invalidate its translation",
        );
        holdPageRequest = true;
        const replacementRequest = once(modelGate, "requested");
        await page.evaluate((text) => {
          const paragraph = document.getElementById("mutable")!;
          if (!("mutableText" in window) || !(window.mutableText instanceof Text))
            throw new Error("Missing original text reference");
          const source = window.mutableText;
          paragraph.replaceChild(document.createTextNode(text), source);
        }, replacement);
        await replacementRequest;
        holdPageRequest = false;
        modelGate.emit("release");
        await waitForTranslations([clipped, replacement, cleared].map((text) => translations.get(text)!));
        await page.evaluate(() => {
          if (!("clearedText" in window) || !(window.clearedText instanceof Text))
            throw new Error("Missing original text reference");
          const source = window.clearedText;
          if (source.parentNode !== document.getElementById("cleared"))
            throw new Error("Source text was reparented");
          source.data = "";
          document.querySelector("#clip span")!.setAttribute("style", "display:none!important");
        });
        await toggle();
        await page.waitForFunction(
          () => !document.querySelector('[aria-label="Just Translate 译文"]'),
        );
        assert.equal(await page.locator("#clip").textContent(), clipped);
        assert.equal(
          await page.locator("#clip span").isVisible(),
          false,
          "restoring must preserve the website's explicit display:none write",
        );
        assert.equal(await page.locator("#mutable").innerText(), replacement);
        assert.equal(
          await page.locator("#cleared").innerText(),
          "",
          "restoring original must not resurrect text explicitly cleared by the website",
        );

        const boundarySources = [
          "Earlier paragraph before a standalone separator.",
          "Standalone separator text is unrelated.",
          "Earlier paragraph before a separate linked story.",
          "A separate linked story.",
        ];
        for (const [index, text] of boundarySources.entries())
          translations.set(text, `边界演示译文${index}。`);
        const codeSource = "Run ⟦JT_CODE_0⟧ before continuing.";
        translations.set(codeSource, "继续前运行 ⟦JT_CODE_0⟧。");
        contextHtml = `<!doctype html><html lang="en"><title>Hidden context boundaries</title>
          <section id="text-boundary"><p>${boundarySources[0]}</p>${boundarySources[1]}</section>
          <section id="link-boundary"><p>${boundarySources[2]}</p><p><a href="#story"><img alt="">${boundarySources[3]}</a></p></section>
          <div><p id="code-source">Run <code>npm test</code> before continuing.</p></div></html>`;
        await page.goto(`${base}/hidden-boundaries`);
        await toggle();
        await waitForTranslations([
          ...boundarySources.map((text) => translations.get(text)!),
          "继续前运行 npm test。",
        ]);
        const additions = [
          ["text-boundary", "New paragraph after the standalone separator."],
          ["link-boundary", "New paragraph after the separate linked story."],
        ] as const;
        for (const [id, text] of additions) {
          translations.set(text, `新增译文：${id}`);
          await page.evaluate(({ id, text }) => {
            const paragraph = document.createElement("p");
            paragraph.id = `${id}-new`;
            paragraph.textContent = text;
            document.getElementById(id)!.append(paragraph);
          }, { id, text });
          await page.waitForFunction((id) =>
            document.querySelector(`#${id}-new [aria-busy="false"]`), id);
          const request = pageRequests.find((candidate) =>
            candidate.items.some((item) => item.text === text));
          assert.ok(request);
          assert.deepEqual(
            request.context,
            [],
            "hidden source text and linked cards remain hard context boundaries",
          );
        }
        await page.locator("#code-source").evaluate((node) => {
          node.setAttribute("class", "website-refresh");
        });
        await page.clock.runFor(1000);
        await waitForTranslations([
          ...boundarySources.map((text) => translations.get(text)!),
          "继续前运行 npm test。",
          ...additions.map(([, text]) => translations.get(text)!),
        ]);
        await toggle();
        await page.waitForFunction(
          () => !document.querySelector('[aria-label="Just Translate 译文"]'),
        );
        assert.equal(await page.locator("#code-source").innerText(), "Run npm test before continuing.");

        const reused = "The website reuses identical paragraph nodes.";
        translations.set(reused, "网站复用内容相同的段落节点。");
        contextHtml = `<!doctype html><html lang="en"><title>Moved source nodes</title>
          <section><p id="move-first">${reused}</p><p id="move-second">${reused}</p></section></html>`;
        await page.goto(`${base}/moved-source`);
        await toggle();
        await waitForTranslations([translations.get(reused)!, translations.get(reused)!]);
        await page.evaluate(() => {
          const first = document.getElementById("move-first")!;
          const second = document.getElementById("move-second")!;
          const firstText = first.firstChild!;
          const secondText = second.firstChild!;
          first.insertBefore(secondText, firstText);
          second.insertBefore(firstText, second.firstChild);
        });
        await page.clock.runFor(1000);
        assert.deepEqual(
          await page.locator("p").evaluateAll((paragraphs) =>
            paragraphs.map((paragraph) => paragraph.firstChild!.nodeValue)),
          ["", ""],
          "moving original nodes between completed blocks must not reveal either source",
        );
        await toggle();
        await page.waitForFunction(
          () => !document.querySelector('[aria-label="Just Translate 译文"]'),
        );
        assert.deepEqual(await page.locator("p").allTextContents(), [reused, reused]);
      }
      await pageCdp.detach();
      await rootCdp.detach();
    },
  );
}
