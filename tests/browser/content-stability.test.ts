import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type BrowserContext } from "playwright";
import { dispatchTranslationCommand, instrumentExtension } from "./extension";

const hostSelector = '[aria-label="Just Translate 译文"]';
const connectionText = "Hello! This is a connection test.";
const translated = (source: string) => `译文：${source}`;

type Mode = "bilingual" | "translation";
interface DomNode {
  nodeName: string;
  nodeValue: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

// Read real, closed translation shadow roots through CDP, not a content-script test hook.
function translationTexts(node: DomNode): string[] {
  if (node.attributes?.includes("parts")) {
    const text = (child: DomNode): string => child.nodeName === "#text"
      ? child.nodeValue
      : (child.children ?? []).map(text).join("");
    return [text(node)];
  }
  return [...(node.children ?? []), ...(node.shadowRoots ?? [])].flatMap(translationTexts);
}

async function eventually(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message);
    await delay(30);
  }
}

async function openFixture(t: TestContext, mode: Mode, body: string, held = false, maxConcurrentRequests?: number) {
  const profile = await mkdtemp(path.join(tmpdir(), "just-translate-content-"));
  const requests: string[][] = [];
  const apiErrors: string[] = [];
  const pending = new Set<() => void>();
  let context: BrowserContext | undefined;
  let rejectPageRequests = false;
  let completedResponses = 0;
  const release = () => {
    held = false;
    for (const resolve of pending) resolve();
    pending.clear();
  };
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Content stability fixture</title><body>${body}</body></html>`);
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(JSON.parse(body).messages.at(-1).content) as {
        items: { id: string; text: string }[];
      };
      const connection = input.items.length === 1 && input.items[0]!.text === connectionText;
      if (!connection) {
        requests.push(input.items.map((item) => item.text));
        response.once("finish", () => { completedResponses++; });
        if (held) await new Promise<void>((resolve) => pending.add(resolve));
        if (rejectPageRequests) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Local fixture rejected translation" } }));
          return;
        }
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          items: input.items.map((item) => ({ id: item.id, text: translated(item.text) })),
        }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      }));
    } catch (error) {
      apiErrors.push(String(error));
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Invalid local fixture request" } }));
    }
  });
  t.after(async () => {
    release();
    try {
      await context?.close();
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
    }
    assert.deepEqual(apiErrors, []);
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
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  await worker.evaluate("globalThis.__justTranslateBrowserTest.ready");
  const id = new URL(worker.url()).host;
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  await manager.evaluate(`chrome.developerPrivate.addHostPermission(${JSON.stringify(id)}, "http://127.0.0.1/*")`);
  await manager.close();
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.locator('input[value="custom"]').check();
  await options.locator("#base-url").fill(base);
  await options.locator("#model").fill("content-stability-regression");
  await options.locator("#api-key").fill("local-content-fixture-key");
  await options.locator(`input[name="displayMode"][value="${mode}"]`).check();
  if (maxConcurrentRequests !== undefined) {
    await options.locator("#max-concurrent-requests").fill(String(maxConcurrentRequests));
  }
  await options.locator("#test-connection").click();
  await options.locator("#test-connection:enabled").waitFor();
  const saved = await options.evaluate(() => chrome.runtime.sendMessage({ type: "settings:get" }));
  assert.equal(saved.value.configured, true);
  assert.equal(saved.value.settings.displayMode, mode);
  if (maxConcurrentRequests !== undefined) {
    assert.equal(saved.value.settings.maxConcurrentRequests, maxConcurrentRequests);
  }
  const page = await context.newPage();
  await page.goto(`${base}/article`);
  const cdp = await context.newCDPSession(page);
  return {
    page,
    worker,
    requests,
    release,
    rejectRequests: () => { rejectPageRequests = true; },
    toggle: () => dispatchTranslationCommand(worker, page),
    async rendered(sources: string[]) {
      const expected = sources.map(translated).sort();
      let actual: string[] = [];
      try {
        await eventually(async () => {
          const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
          actual = translationTexts(root).sort();
          return !(await page.locator(`${hostSelector}[aria-busy="true"]`).count()) &&
            JSON.stringify(actual) === JSON.stringify(expected);
        }, `Expected rendered translations for ${JSON.stringify(sources)}`);
      } catch (error) {
        t.diagnostic(JSON.stringify({
          expected,
          actual,
          requests,
          held,
          pendingResponses: pending.size,
          completedResponses,
          hosts: await page.locator(hostSelector).evaluateAll((nodes) =>
            nodes.map((node) => ({ busy: node.getAttribute("aria-busy"), text: node.textContent }))),
          sessions: await worker.evaluate(() => chrome.storage.session.get("justTranslate.sessions")),
          startupError: await worker.evaluate(() => chrome.storage.session.get("justTranslate.startupError")),
        }));
        throw error;
      }
      assert.equal(await page.locator(hostSelector).count(), sources.length, "one view per readable source");
    },
    async stopped() {
      await page.waitForFunction((selector) => !document.querySelector(selector), hostSelector);
    },
  };
}

for (const mode of ["bilingual", "translation"] as const) {
  test(`${mode}: virtualized feed cards do not become page navigations`, { timeout: 45_000 }, async (t) => {
    const sources = [
      "First independently readable feed card.",
      "Second independently readable feed card.",
      "Third independently readable feed card.",
      "Fourth newly loaded feed card.",
    ];
    const fixture = await openFixture(t, mode, `<main id="feed"><article data-post-id="one"><p>${sources[0]}</p></article><article data-post-id="two"><p>${sources[1]}</p></article></main>`);
    const { page } = fixture;
    await fixture.toggle();
    await fixture.rendered(sources.slice(0, 2));
    await page.locator('[data-post-id="one"]').evaluate((node) => node.remove());
    await fixture.rendered([sources[1]!]);
    // Wait for the mutation scan that would incorrectly adopt the lone card's identity.
    await page.waitForTimeout(450);
    await page.evaluate((source) => {
      const card = document.createElement("article");
      card.dataset.postId = "three";
      const paragraph = document.createElement("p");
      paragraph.textContent = source;
      card.append(paragraph);
      document.getElementById("feed")!.append(card);
    }, sources[2]!);
    await fixture.rendered(sources.slice(1, 3));
    await page.locator('[data-post-id="two"]').evaluate((node) => node.remove());
    await page.waitForTimeout(450);
    await page.evaluate((source) => {
      const card = document.createElement("article");
      card.dataset.postId = "four";
      const paragraph = document.createElement("p");
      paragraph.textContent = source;
      card.append(paragraph);
      document.getElementById("feed")!.append(card);
    }, sources[3]!);
    await fixture.rendered(sources.slice(2));
    assert.deepEqual(fixture.requests.flat().sort(), [...sources].sort(), "feed churn must neither stop the session nor repeat requests");
    assert.ok(fixture.requests.every((items) => items.length === 1), "independent cards must not be batched together");
    await fixture.toggle();
    await fixture.stopped();
    assert.deepEqual(await page.locator("article p").allTextContents(), sources.slice(2));
  });

  test(`${mode}: a single card can grow into an identified feed`, { timeout: 45_000 }, async (t) => {
    const sources = ["An initially solitary feed card.", "A newly loaded second feed card."];
    const fixture = await openFixture(t, mode, `<main id="feed" data-post-id="feed-page"><article data-post-id="first"><p>${sources[0]}</p></article></main>`);
    await fixture.toggle();
    await fixture.rendered(sources.slice(0, 1));
    await fixture.page.evaluate((source) => {
      const card = document.createElement("article");
      card.dataset.postId = "second";
      const paragraph = document.createElement("p");
      paragraph.textContent = source;
      card.append(paragraph);
      document.getElementById("feed")!.append(card);
    }, sources[1]!);
    await fixture.rendered(sources);
    assert.deepEqual(fixture.requests.flat(), sources);
    await fixture.toggle();
    await fixture.stopped();
    assert.deepEqual(await fixture.page.locator("article p").allTextContents(), sources);
  });

  test(`${mode}: nested comments do not hide a real article replacement`, { timeout: 45_000 }, async (t) => {
    const sources = ["The original article remains the navigation boundary.", "A separately readable nested comment."];
    const fixture = await openFixture(t, mode, `<main><article data-article-id="original"><p>${sources[0]}</p><article id="comment"><p>${sources[1]}</p></article></article></main>`);
    await fixture.toggle();
    await fixture.rendered(sources);
    await fixture.page.locator("#comment").evaluate((node) => node.remove());
    await fixture.rendered(sources.slice(0, 1));
    await fixture.page.locator("[data-article-id]").evaluate((node) => {
      node.setAttribute("data-article-id", "replacement");
      node.querySelector("p")!.textContent = "A different article requires a new translation gesture.";
    });
    const snapshot = await fixture.worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      return chrome.tabs.sendMessage(tab!.id!, { type: "page:ping" });
    }, fixture.page.url());
    assert.ok(snapshot.ok && !snapshot.value.active,
      "an article identity change must end the session, not merely remove its current view");
    await fixture.stopped();
    assert.deepEqual(fixture.requests.flat().sort(), [...sources].sort(),
      "replacing the article must stop rather than send the replacement without a gesture");
  });

  test(`${mode}: translated flex labels stay before trailing icons`, { timeout: 45_000 }, async (t) => {
    const source = "Read more";
    const fixture = await openFixture(t, mode, `<button id="control" style="display:inline-flex;align-items:center;justify-content:space-between;width:260px;height:44px;white-space:nowrap">${source}<svg id="icon" width="18" height="18" aria-hidden="true"><path d="M2 9h14M10 3l6 6-6 6" stroke="currentColor" fill="none"/></svg></button>`);
    const { page } = fixture;
    const original = await page.locator("#control").innerHTML();
    await page.evaluate(`window.sourceNode = document.getElementById("control").firstChild;
      window.controlClicks = 0;
      document.getElementById("control").addEventListener("click", () => window.controlClicks++);`);
    const initial = await page.locator("#icon").boundingBox();
    assert.ok(initial);
    await fixture.toggle();
    await fixture.rendered([source]);
    const icon = await page.locator("#icon").boundingBox();
    const label = await page.locator(`#control ${hostSelector}`).boundingBox();
    assert.ok(icon && label);
    assert.ok(label.x + label.width <= icon.x + 1, "the translated label must remain before its trailing icon");
    assert.ok(Math.abs(icon.x - initial.x) <= 1, "translation must not shift the icon into the original label slot");
    assert.equal(await page.locator("#control").evaluate((node) => node.getBoundingClientRect().height), 44);
    await page.locator("#control").click();
    assert.equal(await page.evaluate("window.controlClicks"), 1);
    await fixture.toggle();
    await fixture.stopped();
    assert.equal(await page.locator("#control").innerHTML(), original);
    assert.equal(await page.evaluate("window.sourceNode === document.getElementById('control').firstChild"), true);
  });

  test(`${mode}: constrained recommendation cards keep their layout`, { timeout: 45_000 }, async (t) => {
    const cards = [
      ["Alexander Montgomery writes about science", "Followed by Cameron Wolfe, Marcel Melzig and Kavita Gupta"],
      ["Stephanie Koe", "Followed by Dan"],
      ["Simon Sinek", "Followed by Marcel Melzig"],
    ];
    const paragraph = "An ordinary article paragraph keeps its independent translation row.";
    const fixture = await openFixture(t, mode, `<style>
      body { font-family: Arial, sans-serif; }
      .cards { display: flex; gap: 8px; }
      .card { box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; padding: 12px; justify-content: space-between; align-items: center; width: 176px; min-width: 176px; height: 234px; border: 1px solid; }
      .avatar { width: 100px; height: 100px; flex: 0 0 auto; border-radius: 50%; background: gray; }
      .info { display: flex; flex-direction: column; gap: 4px; flex: 1 1 1px; min-width: 0; align-self: stretch; }
      .name-row { display: flex; gap: 4px; align-items: center; justify-content: center; }
      .name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; line-height: 20px; }
      .badge { width: 12px; height: 12px; flex: 0 0 auto; background: gray; }
      .mutuals { display: flex; gap: 6px; align-items: center; justify-content: center; margin-top: 4px; }
      .summary { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; font-size: 11px; line-height: 13px; text-align: center; }
      .follow { display: flex; align-items: center; justify-content: center; gap: 6px; align-self: stretch; height: 32px; padding: 0 8px; white-space: nowrap; font: 13px/20px Arial; }
    </style><div class="cards">${cards.map(([name, summary]) => `<div class="card">
      <div class="avatar" aria-hidden="true"></div>
      <div class="info"><div class="name-row"><div class="name">${name}</div><span class="badge" aria-hidden="true"></span></div>
      <div class="mutuals"><div class="summary">${summary}</div></div></div>
      <button class="follow">Follow</button>
    </div>`).join("")}</div><p id="paragraph">${paragraph}</p>`, true);
    const { page } = fixture;
    const original = await page.locator(".cards").innerHTML();
    const originalName = await page.locator(".name").first().evaluateHandle((node) => node.firstChild!);
    await page.evaluate(`window.followClicks = 0;
      document.querySelector(".follow").addEventListener("click", () => window.followClicks++);`);
    const geometry = () => page.locator(".card").evaluateAll((nodes) => nodes.map((node) => {
      const name = node.querySelector(".name")!.getBoundingClientRect();
      const summary = node.querySelector(".summary")!.getBoundingClientRect();
      const button = node.querySelector(".follow")!.getBoundingClientRect();
      const badge = node.querySelector(".badge")!.getBoundingClientRect();
      return {
        height: node.getBoundingClientRect().height,
        nameHeight: name.height,
        summaryHeight: summary.height,
        clamp: getComputedStyle(node.querySelector(".summary")!).webkitLineClamp,
        buttonHeight: button.height,
        buttonBottom: button.bottom - node.getBoundingClientRect().bottom,
        badgeOffset: badge.y - name.y,
      };
    }));
    const before = await geometry();
    const assertLayout = async (stage: string) => {
      const after = await geometry();
      after.forEach((card, index) => {
        assert.equal(card.height, before[index]!.height, `${stage}: card height`);
        assert.equal(card.nameHeight, before[index]!.nameHeight, `${stage}: one-line name`);
        assert.equal(card.clamp, "2", `${stage}: preserve native line clamp`);
        assert.ok(card.summaryHeight <= 26, `${stage}: summary must stay within two lines`);
        assert.ok(card.buttonHeight >= before[index]!.buttonHeight - 2, `${stage}: do not squeeze the button`);
        assert.ok(card.buttonBottom <= -1, `${stage}: button must remain inside the card`);
        assert.equal(card.badgeOffset, before[index]!.badgeOffset, `${stage}: badge alignment`);
      });
    };
    await fixture.toggle();
    await page.locator(`.summary ${hostSelector}[aria-busy="true"]`).first().waitFor();
    await assertLayout("loading");
    assert.equal(await originalName.evaluate((node) => node.nodeValue), cards[0]![0],
      "keep the original readable while the translation is pending");
    fixture.release();
    await fixture.rendered([...cards.flatMap(([name, summary]) => [name!, summary!, "Follow"]), paragraph]);
    await assertLayout("translated");
    assert.equal(await originalName.evaluate((node) => node.nodeValue), "",
      "constrained labels replace the source in both display modes");
    assert.equal(await page.locator("#paragraph").evaluate((node) => node.firstChild!.nodeValue),
      mode === "bilingual" ? paragraph : "", "ordinary paragraphs still honor the display mode");
    await page.locator(".follow").first().click();
    assert.equal(await page.evaluate("window.followClicks"), 1);
    await fixture.toggle();
    await fixture.stopped();
    assert.equal(await page.locator(".cards").innerHTML(), original);
    assert.deepEqual(await geometry(), before, "restoring the source must restore the original layout");
    assert.equal(await originalName.evaluate((node) => node === document.querySelector(".name")!.firstChild), true);
    await originalName.dispose();
    // New source labels bypass successful caches and exercise compact error actions.
    await page.locator(".name, .summary, .follow").evaluateAll((nodes) => {
      for (const node of nodes) node.textContent = `Changed ${node.textContent}`;
    });
    const updated = await page.locator(".cards").innerHTML();
    fixture.rejectRequests();
    await fixture.toggle();
    await page.waitForFunction((selector) =>
      document.querySelectorAll(selector).length === 10 &&
      !document.querySelector(`${selector}[aria-busy="true"]`), hostSelector);
    await assertLayout("failed");
    assert.equal(await page.locator(".name").first().textContent(), `Changed ${cards[0]![0]}`,
      "failed labels must retain their original text");
    await fixture.toggle();
    await fixture.stopped();
    assert.equal(await page.locator(".cards").innerHTML(), updated,
      "stopping after a failure must preserve the website's new labels");
  });

  test(`${mode}: changing excluded roles discovers newly readable content`, { timeout: 45_000 }, async (t) => {
    const source = "This panel becomes ordinary readable content.";
    const fixture = await openFixture(t, mode, `<div id="panel" role="navigation"><p>${source}</p></div>`);
    const { page } = fixture;
    await fixture.toggle();
    await page.waitForTimeout(450);
    assert.deepEqual(fixture.requests, [], "navigation content must not be sent");
    await page.locator("#panel").evaluate((node) => node.setAttribute("role", "region"));
    await fixture.rendered([source]);
    assert.deepEqual(fixture.requests.flat(), [source]);
    await page.locator("#panel").evaluate((node) => node.setAttribute("role", "navigation"));
    await eventually(async () => await page.locator(hostSelector).count() === 0, "excluded content must lose its translation");
    assert.equal(await page.locator("#panel p").textContent(), source, "source must be restored before exclusion");
    await fixture.toggle();
    await fixture.stopped();
  });

  test(`${mode}: late responses respect site edits and removed or hidden cards`, { timeout: 45_000 }, async (t) => {
    const sources = [
      "The website may edit this pending paragraph.",
      "The website may remove this pending card.",
      "This queued card becomes hidden before its request.",
      "This queued card is detached before its request.",
    ];
    const replacement = "The website has replaced its pending paragraph.";
    const fixture = await openFixture(t, mode, `<main>${sources.map((source, index) => `<article id="card${index}"><p>${source}</p></article>`).join("")}</main>`, true, 2);
    const { page } = fixture;
    await fixture.toggle();
    await eventually(() => fixture.requests.length === 2, "the two in-flight requests should occupy both content workers");
    assert.deepEqual(fixture.requests.flat(), sources.slice(0, 2));
    await page.evaluate((replacement) => {
      document.querySelector("#card0 p")!.firstChild!.nodeValue = replacement;
      document.getElementById("card1")!.remove();
      document.getElementById("card2")!.hidden = true;
      document.getElementById("card3")!.remove();
    }, replacement);
    await page.waitForTimeout(450);
    fixture.release();
    await fixture.rendered([replacement]);
    assert.deepEqual(fixture.requests.flat().sort(), [...sources.slice(0, 2), replacement].sort(), "hidden and detached queued content must never reach the model");
    // Keep the completed host identity across several mutation debounce windows.
    await page.locator(hostSelector).evaluate((node) => node.setAttribute("data-stable-host", "kept"));
    await page.waitForTimeout(1000);
    assert.equal(await page.locator('[data-stable-host="kept"]').count(), 1, "a completed view must not enter a remove/recreate loop");
    assert.equal(fixture.requests.length, 3);
    await fixture.toggle();
    await fixture.stopped();
    assert.equal(await page.locator("#card0 p").textContent(), replacement, "stop must preserve the site's edit, not resurrect the old source");
    assert.equal(await page.locator("#card2 p").textContent(), sources[2]);
    assert.equal(await page.locator("#card2").isVisible(), false);
    assert.equal(await page.locator("article").count(), 2, "removed site content must not be reinserted");
  });
}
