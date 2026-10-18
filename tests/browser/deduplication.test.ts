import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type BrowserContext } from "playwright";
import {
  dispatchTranslationCommand,
  instrumentExtension,
} from "./extension";

interface ModelInput {
  items: { id: string; text: string }[];
  context: string[];
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

// Read the real closed shadow root via CDP, without changing production access.
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

function modelTranslation(input: ModelInput, text: string): string {
  switch (text) {
    case connectionText:
      return "你好！这是一次连接测试。";
    case "Subscribe":
      return "订阅";
    case "Follow":
      return "关注";
    case financialSource:
      return "这家金融机构保护客户存款。";
    case riverSource:
      return "河堤已加固以抵御洪水。";
    case repeatedProse: {
      const surroundings = [...input.context, ...input.items.map((item) => item.text)];
      const financial = surroundings.some((text) => text.includes(financialSource));
      const river = surroundings.some((text) => text.includes(riverSource));
      // Mixed or missing context produces visible failure, never a source echo.
      if (financial === river) return "上下文错误";
      return financial ? "银行很安全。" : "河岸很稳固。";
    }
    default:
      return "意外的待译文本";
  }
}

for (const displayMode of ["bilingual", "translation"] as const) {
  for (const sourceMutation of ["none", "remove", "edit"] as const) {
    test(
      `${displayMode}: repeated controls share pending and cached work (${sourceMutation} source)`,
      { timeout: 60_000 },
      async (t) => {
        const profile = await mkdtemp(path.join(tmpdir(), "just-translate-dedupe-"));
        const pageRequests: ModelInput[] = [];
        const gate = new EventEmitter();
        let releaseSubscribe!: () => void;
        const subscribeResponse = new Promise<void>((resolve) => {
          releaseSubscribe = resolve;
        });
        const cards = Array.from({ length: 6 }, (_, index) =>
          `<article class="card"><h2 translate="no">Independent story ${index}</h2><button type="button" id="subscribe-${index}">Subscribe</button></article>`,
        ).join("");
        const server = createServer(async (request, response) => {
          if (request.method === "POST") {
            let body = "";
            for await (const chunk of request) body += chunk;
            const input: ModelInput = JSON.parse(JSON.parse(body).messages.at(-1).content);
            const isConnection = input.items[0]?.text === connectionText;
            if (!isConnection) pageRequests.push(input);
            if (input.items.some((item) => item.text === "Subscribe")) {
              gate.emit("subscribe-requested");
              await subscribeResponse;
            }
            if (response.destroyed) return;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({
              choices: [{
                message: {
                  content: JSON.stringify({
                    items: input.items.map((item) => ({
                      id: item.id,
                      text: modelTranslation(input, item.text),
                    })),
                  }),
                },
                finish_reason: "stop",
              }],
              usage: { prompt_tokens: 100, completion_tokens: 20 },
            }));
            return;
          }
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(request.url === "/contexts"
            ? `<!doctype html><html lang="en"><title>Separate prose contexts</title><body>
                <article id="financial"><p id="financial-intro">${financialSource}</p><p id="financial-bank">${repeatedProse}</p></article>
                <article id="river"><p id="river-intro">${riverSource}</p><p id="river-bank">${repeatedProse}</p></article>
              </body></html>`
            : `<!doctype html><html lang="en"><title>Independent subscription cards</title><body>${cards}</body></html>`);
        });
        let context: BrowserContext | undefined;
        t.after(async () => {
          // Resolve every held handler even when an assertion or browser launch fails.
          releaseSubscribe();
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
          ignoreDefaultArgs: ["--disable-extensions"],
          args: [
            `--disable-extensions-except=${extension}`,
            `--load-extension=${extension}`,
            "--enable-unsafe-extension-debugging",
          ],
        });
        const worker = context.serviceWorkers()[0] ??
          (await context.waitForEvent("serviceworker"));
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
        await options.locator("#model").fill("deduplication-browser-fixture");
        await options.locator("#api-key").fill("dummy-deduplication-key");
        await options.locator(`input[name="displayMode"][value="${displayMode}"]`).check();
        await options.locator("#test-connection").click();
        await options.locator("#test-connection:enabled").waitFor();
        const saved = await options.evaluate(() =>
          chrome.runtime.sendMessage({ type: "settings:get" }),
        );
        assert.equal(saved.value.configured, true);
        assert.equal(saved.value.settings.displayMode, displayMode);
        await options.close();

        const page = await context.newPage();
        await page.goto(`${base}/cards`);
        await page.evaluate(() => {
          const originals = new Map<string, Element>();
          const clicks: string[] = [];
          for (const button of document.querySelectorAll("button")) {
            originals.set(button.id, button);
            button.addEventListener("click", () => clicks.push(button.id));
          }
          Object.assign(window, { originalControls: originals, controlClicks: clicks });
        });
        const cdp = await context.newCDPSession(page);
        // Invokes the registered production command; does not claim native Option+Q.
        const toggle = () => dispatchTranslationCommand(worker, page);
        const waitForHosts = async (ids: string[], busy: boolean) => {
          await page.waitForFunction(({ ids, busy, selector }) =>
            ids.every((id) => {
              const host = document.getElementById(id)?.querySelector(selector);
              return host?.getAttribute("aria-busy") === String(busy);
            }), { ids, busy, selector: translationSelector });
        };
        const expectTranslations = async (expected: [string, string][]) => {
          await waitForHosts(expected.map(([id]) => id), false);
          const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
          for (const [id, text] of expected) {
            const node = findNode(root, id);
            assert.ok(node, `missing translated control or paragraph ${id}`);
            assert.deepEqual(translatedText(node), [text], `visible translation for ${id}`);
            assert.equal(await page.locator(`#${id} ${translationSelector}`).isVisible(), true);
          }
        };
        const appendControls = async (ids: string[]) => {
          await page.evaluate((ids) => {
            for (const id of ids) {
              const article = document.createElement("article");
              article.className = "card";
              const heading = document.createElement("h2");
              heading.setAttribute("translate", "no");
              heading.textContent = `Independent story ${id}`;
              const button = document.createElement("button");
              button.type = "button";
              button.id = id;
              button.textContent = "Subscribe";
              article.append(heading, button);
              document.body.append(article);
            }
          }, ids);
        };
        const originalIds = Array.from({ length: 6 }, (_, index) => `subscribe-${index}`);
        const firstRequest = once(gate, "subscribe-requested");
        await toggle();
        await firstRequest;
        await waitForHosts(originalIds, true);
        assert.equal(pageRequests.length, 1, "six independent controls issue one request");
        assert.ok(pageRequests[0]);
        assert.deepEqual(pageRequests[0].items.map((item) => item.text), ["Subscribe"]);
        assert.deepEqual(pageRequests[0].context, [], "unrelated cards must not supply each other's context");

        const pendingIds = ["pending-first", "pending-second"];
        await appendControls(pendingIds);
        await waitForHosts(pendingIds, true);
        if (sourceMutation === "remove") {
          await page.locator("#subscribe-0").evaluate((button) => button.closest("article")!.remove());
        } else if (sourceMutation === "edit") {
          await page.locator("#subscribe-0").evaluate((button) => {
            button.textContent = "Follow";
          });
          await page.waitForFunction((selector) =>
            document.getElementById("subscribe-0")?.querySelector(selector) !== null,
          translationSelector);
        }
        releaseSubscribe();
        const survivingIds = sourceMutation === "none" ? originalIds : originalIds.slice(1);
        const expected: [string, string][] = [...survivingIds, ...pendingIds].map((id) => [id, "订阅"]);
        if (sourceMutation === "edit") expected.unshift(["subscribe-0", "关注"]);
        await expectTranslations(expected);
        assert.equal(
          pageRequests.filter((input) => input.items.some((item) => item.text === "Subscribe")).length,
          1,
          "late duplicates and source invalidation must not restart shared work",
        );
        assert.deepEqual(
          pageRequests.flatMap((input) => input.items.map((item) => item.text)).sort(),
          sourceMutation === "edit" ? ["Follow", "Subscribe"] : ["Subscribe"],
          "billable items are unique, including the website's genuinely edited label",
        );
        if (sourceMutation === "remove") {
          assert.equal(await page.locator("#subscribe-0").count(), 0);
        }

        const requestsAfterCompletion = pageRequests.length;
        const cachedIds = ["cached-first", "cached-second"];
        await appendControls(cachedIds);
        expected.push(...cachedIds.map((id): [string, string] => [id, "订阅"]));
        await expectTranslations(expected);
        assert.equal(pageRequests.length, requestsAfterCompletion, "completed duplicates use cache, not the model");
        await page.locator("#subscribe-1").click();
        assert.deepEqual(await page.evaluate("window.controlClicks"), ["subscribe-1"]);
        assert.equal(await page.evaluate(
          "window.originalControls.get('subscribe-1') === document.getElementById('subscribe-1')",
        ), true, "translation preserves the original clickable control");

        await toggle();
        await page.waitForFunction((selector) => !document.querySelector(selector), translationSelector);
        for (const [id] of expected) {
          assert.equal(await page.locator(`#${id}`).innerText(), id === "subscribe-0" && sourceMutation === "edit" ? "Follow" : "Subscribe");
        }
        await page.locator("#subscribe-1").click();
        assert.deepEqual(await page.evaluate("window.controlClicks"), ["subscribe-1", "subscribe-1"]);
        await appendControls(["after-stop"]);
        // Cross a rendering boundary so the new DOM mutation is delivered,
        // without replacing the clock used by the following context scenario.
        await page.evaluate(() => new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ));
        assert.equal(await page.locator(translationSelector).count(), 0);
        assert.equal(pageRequests.length, requestsAfterCompletion, "stopped translation must not process new controls");

        if (sourceMutation === "none") {
          const contextStart = pageRequests.length;
          await page.goto(`${base}/contexts`);
          await toggle();
          const proseExpected: [string, string][] = [
            ["financial-intro", "这家金融机构保护客户存款。"],
            ["financial-bank", "银行很安全。"],
            ["river-intro", "河堤已加固以抵御洪水。"],
            ["river-bank", "河岸很稳固。"],
          ];
          await expectTranslations(proseExpected);
          const contextualRequests = pageRequests.slice(contextStart);
          assert.equal(contextualRequests.length, 2, "independent articles remain separate contextual requests");
          assert.deepEqual(
            contextualRequests.map((input) => input.items.map((item) => item.text)).sort(),
            [[financialSource, repeatedProse], [riverSource, repeatedProse]].sort(),
            "identical prose stays in its own ordered article group",
          );
          await page.evaluate((text) => {
            for (const id of ["financial", "river"]) {
              const paragraph = document.createElement("p");
              paragraph.id = `${id}-added`;
              paragraph.textContent = text;
              document.getElementById(id)!.append(paragraph);
            }
          }, repeatedProse);
          proseExpected.push(["financial-added", "银行很安全。"], ["river-added", "河岸很稳固。"]);
          await expectTranslations(proseExpected);
          const addedRequests = pageRequests.slice(contextStart + 2);
          assert.equal(addedRequests.length, 2, "equal new prose with different context cannot share a request or cache entry");
          for (const source of [financialSource, riverSource]) {
            const input = addedRequests.find((input) => input.context.some((hint) => hint.includes(source)));
            assert.ok(input, `missing isolated context: ${source}`);
            assert.deepEqual(input.items.map((item) => item.text), [repeatedProse]);
            const unrelated = source === financialSource ? riverSource : financialSource;
            assert.equal(input.context.some((hint) => hint.includes(unrelated)), false, "context must not cross article boundaries");
          }
          await toggle();
          await page.waitForFunction((selector) => !document.querySelector(selector), translationSelector);
          for (const id of ["financial-bank", "river-bank", "financial-added", "river-added"]) {
            assert.equal(await page.locator(`#${id}`).innerText(), repeatedProse);
          }
        }
        await cdp.detach();
      },
    );
  }
}
