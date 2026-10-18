import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type BrowserContext, type Page } from "playwright";
import { dispatchTranslationCommand, instrumentExtension } from "./extension";

const paragraphCount = 60;
const translationSelector = '[aria-label="Just Translate 译文"]';
const connectionText = "Hello! This is a connection test.";
const scenarios = [
  { name: "document-top", paragraph: 0, top: 1100 },
  { name: "article-beginning", paragraph: 0, top: 40 },
  { name: "article-middle", paragraph: 20, top: 40 },
  { name: "manual-scroll", paragraph: 20, top: 40, moveTo: 38 },
  { name: "inside-long-paragraph", paragraph: 20, top: -180 },
  { name: "scrollable-reader", paragraph: 20, top: 40 },
] as const;

type Scenario = (typeof scenarios)[number];

interface Fixture {
  html: string;
  translations: Map<string, string>;
  requestCount: number;
  held: boolean;
  pending: Set<() => void>;
  events: EventEmitter;
  release(): void;
}

interface ReadingPosition {
  top: number;
  bottom: number;
  height: number;
  viewportHeight: number;
  visible: string[];
  windowY: number;
  scrollLeft: number;
}

interface DomNode {
  nodeName: string;
  nodeValue: string;
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

// Inspect the real closed translation shadow roots without exposing a test API.
function renderedText(node: DomNode): string[] {
  if (node.nodeName === "#text") return [node.nodeValue];
  return [...(node.children ?? []), ...(node.shadowRoots ?? [])].flatMap(renderedText);
}

function articleFixture(scenario: Scenario): Fixture {
  const translations = new Map<string, string>();
  const paragraphs = Array.from({ length: paragraphCount }, (_, index) => {
    const source = `Reading scenario ${scenario.name}, passage ${index + 1}. ${
      "The reader follows this long passage while the surrounding article changes. Each sentence supplies ordinary English prose for the local translation fixture. ".repeat(9)
    }`.trim();
    translations.set(source, `第${index + 1}段：读者继续阅读当前段落，译文缩短后也不应跳到文章中间。`);
    return `<p id="p${index}">${source}</p>`;
  }).join("");
  const nested = scenario.name === "scrollable-reader";
  const fixture: Fixture = {
    html: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Reading position fixture</title>
      <style>
        html { scroll-behavior: auto; }
        body { margin: 0; font: 16px/26px Arial, sans-serif; }
        header { height: 1100px; background: #eee; }
        article { width: ${nested ? 900 : 680}px; }
        p { width: 680px; margin: 0 0 64px; }
        footer { height: 800px; }
        ${nested ? "body { min-height: 2000px; padding-top: 80px; } #reader { width: 760px; height: 520px; overflow: auto; border: 2px solid #777; }" : ""}
      </style>
      ${nested ? '<div id="reader">' : ""}
      <header translate="no" aria-label="Nontranslated article header"></header>
      <article>${paragraphs}</article><footer translate="no"></footer>
      ${nested ? "</div>" : ""}</html>`,
    translations,
    requestCount: 0,
    held: true,
    pending: new Set(),
    events: new EventEmitter(),
    release() {
      fixture.held = false;
      for (const resolve of fixture.pending) resolve();
      fixture.pending.clear();
    },
  };
  return fixture;
}

async function settleLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    }));
  });
}

async function alignParagraph(page: Page, paragraph: number, top: number): Promise<void> {
  await page.evaluate(({ paragraph, top }) => {
    const block = document.getElementById(`p${paragraph}`)!;
    const reader = document.getElementById("reader");
    if (reader) {
      const viewportTop = reader.getBoundingClientRect().top + reader.clientTop;
      reader.scrollTop += block.getBoundingClientRect().top - viewportTop - top;
      reader.scrollLeft = 37;
    } else {
      window.scrollBy(0, block.getBoundingClientRect().top - top);
    }
  }, { paragraph, top });
  await settleLayout(page);
}

async function readingPosition(page: Page, paragraph: number): Promise<ReadingPosition> {
  return page.evaluate((paragraph) => {
    const block = document.getElementById(`p${paragraph}`)!;
    const reader = document.getElementById("reader");
    const viewportTop = reader
      ? reader.getBoundingClientRect().top + reader.clientTop
      : 0;
    const viewportHeight = reader ? reader.clientHeight : innerHeight;
    const bounds = block.getBoundingClientRect();
    const visible = [...document.querySelectorAll("article > p")]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.bottom > viewportTop && rect.top < viewportTop + viewportHeight;
      })
      .map((node) => node.id);
    return {
      top: bounds.top - viewportTop,
      bottom: bounds.bottom - viewportTop,
      height: bounds.height,
      viewportHeight,
      visible,
      windowY: window.scrollY,
      scrollLeft: reader ? reader.scrollLeft : window.scrollX,
    };
  }, paragraph);
}

function assertReadingPosition(
  actual: ReadingPosition,
  expected: ReadingPosition,
  paragraph: number,
  phase: string,
): void {
  assert.ok(
    actual.visible.includes(`p${paragraph}`),
    `${phase}: p${paragraph} must remain visible; bounds=${JSON.stringify(actual)}`,
  );
  assert.equal(actual.visible[0], `p${paragraph}`, `${phase}: the first visible paragraph changed`);
  if (expected.top >= 0) {
    assert.ok(
      Math.abs(actual.top - expected.top) <= 2,
      `${phase}: paragraph top moved from ${expected.top} to ${actual.top}`,
    );
  } else {
    assert.ok(
      actual.top <= 2 && actual.bottom > 0,
      `${phase}: a shortened paragraph must still intersect the reading edge, not scroll past its end`,
    );
  }
  assert.equal(actual.scrollLeft, expected.scrollLeft, `${phase}: horizontal scroll changed`);
}

for (const displayMode of ["bilingual", "translation"] as const) {
  test(`${displayMode}: translation preserves semantic reading position`, { timeout: 180_000 }, async (t) => {
    const profile = await mkdtemp(path.join(tmpdir(), "just-translate-reading-"));
    const fixtures = new Map<string, Fixture>();
    const apiErrors: string[] = [];
    let context: BrowserContext | undefined;
    const server = createServer(async (request, response) => {
      try {
        if (request.method !== "POST") {
          const fixture = fixtures.get(request.url ?? "");
          response.writeHead(fixture ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
          response.end(fixture?.html ?? "Not found");
          return;
        }
        let body = "";
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(JSON.parse(body).messages.at(-1).content) as {
          items: { id: string; text: string }[];
        };
        const connection = input.items.length === 1 && input.items[0]!.text === connectionText;
        const fixture = connection ? undefined : [...fixtures.values()].find((candidate) =>
          input.items.every((item) => candidate.translations.has(item.text)),
        );
        if (!connection && !fixture) throw new Error("Unexpected source text reached the local model");
        if (fixture) {
          fixture.requestCount++;
          if (fixture.held) await new Promise<void>((resolve) => {
            fixture.pending.add(resolve);
            fixture.events.emit("held");
          });
        }
        const items = input.items.map((item) => ({
          id: item.id,
          text: connection ? "你好！这是一次连接测试。" : fixture!.translations.get(item.text)!,
        }));
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ items }) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 30 },
        }));
      } catch (error) {
        apiErrors.push(String(error));
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Invalid local fixture request" } }));
      }
    });
    t.after(async () => {
      for (const fixture of fixtures.values()) fixture.release();
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
    context = await chromium.launchPersistentContext(profile, {
      executablePath: chromium.executablePath(),
      headless: true,
      viewport: { width: 1100, height: 720 },
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage();
    await manager.goto("chrome://extensions");
    await manager.evaluate(
      `chrome.developerPrivate.addHostPermission(${JSON.stringify(extensionId)}, "http://127.0.0.1/*")`,
    );
    await manager.close();
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.locator('input[value="custom"]').check();
    await options.locator("#base-url").fill(base);
    await options.locator("#model").fill("local-reading-fixture");
    await options.locator("#api-key").fill("local-fixture-not-a-real-key");
    await options.locator(`input[name="displayMode"][value="${displayMode}"]`).check();
    await options.locator("#test-connection").click();
    await options.locator("#test-connection:enabled").waitFor();
    const saved = await options.evaluate(() => chrome.runtime.sendMessage({ type: "settings:get" }));
    assert.equal(saved.value.configured, true);
    assert.equal(saved.value.settings.displayMode, displayMode);
    await options.close();

    for (const scenario of scenarios) {
      await t.test(scenario.name, async (t) => {
        const fixture = articleFixture(scenario);
        fixtures.set(`/${scenario.name}`, fixture);
        const page = await context!.newPage();
        t.after(async () => {
          fixture.release();
          await page.close();
        });
        await page.goto(`${base}/${scenario.name}`);
        await settleLayout(page);
        const atTop = scenario.name === "document-top";
        if (!atTop) await alignParagraph(page, scenario.paragraph, scenario.top);
        let paragraph: number = scenario.paragraph;
        let before = await readingPosition(page, paragraph);
        assert.ok(before.height > 250, "fixture source paragraphs must be substantially taller than their translations");
        if (atTop) {
          assert.equal(before.windowY, 0);
          assert.ok(before.top > before.viewportHeight, "the untranslated header must put the article below the initial viewport");
        } else {
          assert.ok(Math.abs(before.top - scenario.top) <= 2, "fixture must start at the requested paragraph offset");
        }
        // Keep the exact original elements and text, including their ordering.
        const originalHeight = before.height;
        const originals = await page.evaluateHandle(() =>
          [...document.querySelectorAll("article > p")].map((node) => ({ node, text: node.textContent })),
        );
        const requestHeld = once(fixture.events, "held");
        await dispatchTranslationCommand(worker, page);
        await page.waitForFunction((count) =>
          document.querySelectorAll('[aria-label="Just Translate 译文"][aria-busy="true"]').length === count,
        paragraphCount, { polling: "raf" });
        await requestHeld;
        await settleLayout(page);
        const loading = await readingPosition(page, paragraph);
        if (atTop) assert.equal(loading.windowY, 0, "loading must not scroll the document away from the top");
        else assertReadingPosition(loading, before, paragraph, "loading insertion");

        if ("moveTo" in scenario) {
          // The reader moves after loading has started but before any API result.
          // A session-start snapshot would incorrectly drag them back to p20.
          paragraph = scenario.moveTo;
          const wheelDelta = await page.locator(`#p${paragraph}`).evaluate((node) =>
            node.getBoundingClientRect().top - 40,
          );
          await page.mouse.move(400, 200);
          await page.mouse.wheel(0, wheelDelta);
          await page.waitForFunction((paragraph) =>
            Math.abs(document.getElementById(`p${paragraph}`)!.getBoundingClientRect().top - 40) <= 2,
          paragraph, { polling: "raf" });
          await settleLayout(page);
          before = await readingPosition(page, paragraph);
          assert.equal(before.visible[0], `p${paragraph}`);
        }
        fixture.release();
        await page.waitForFunction((count) => {
          const hosts = [...document.querySelectorAll('[aria-label="Just Translate 译文"]')];
          return hosts.length === count && hosts.every((host) => host.getAttribute("aria-busy") === "false");
        }, paragraphCount, { polling: "raf", timeout: 30_000 });
        await settleLayout(page);
        assert.deepEqual(apiErrors, [], "all requests must use the controlled local model");
        assert.ok(fixture.requestCount > 1, "the fixture must span multiple translation batches");
        const pageCdp = await context!.newCDPSession(page);
        const { root } = await pageCdp.send("DOM.getDocument", { depth: -1, pierce: true });
        const rendered = new Set(renderedText(root));
        await pageCdp.detach();
        for (const text of fixture.translations.values()) {
          assert.ok(rendered.has(text),
            `missing translation: ${text}; errors: ${[...rendered].filter((value) => /失败|上限|预算|错误/.test(value)).join(" | ")}`);
        }
        const translated = await readingPosition(page, paragraph);
        if (atTop) assert.equal(translated.windowY, 0, "completed translations must leave document top at zero");
        else assertReadingPosition(translated, before, paragraph, "all translated batches");
        if (displayMode === "translation") {
          assert.ok(translated.height < originalHeight / 2, "the real translation-only renderer must shorten the source paragraph");
        } else {
          assert.ok(translated.height > originalHeight, "the bilingual renderer must add translation geometry");
        }
        if (scenario.name === "scrollable-reader") {
          assert.equal(translated.windowY, 0, "nested reader translation must not move the outer document");
          assert.equal(translated.scrollLeft, 37, "nested reader horizontal position must survive translation");
        }

        await dispatchTranslationCommand(worker, page);
        await page.waitForFunction((selector) => !document.querySelector(selector), translationSelector, { polling: "raf" });
        await settleLayout(page);
        const restored = await readingPosition(page, paragraph);
        if (atTop) assert.equal(restored.windowY, 0, "restoring originals must leave document top at zero");
        else assertReadingPosition(restored, translated, paragraph, "original restoration");
        if (scenario.name === "scrollable-reader") assert.equal(restored.windowY, 0);
        const originalNodesRestored = await originals.evaluate((originals) => {
          const current = [...document.querySelectorAll("article > p")];
          return current.length === originals.length && originals.every(({ node, text }, index) =>
            node === current[index] && node.textContent === text && node.getBoundingClientRect().height > 250,
          );
        });
        assert.equal(originalNodesRestored, true, "stopping must restore the original paragraph nodes and text");
        await originals.dispose();
      });
    }
  });
}
