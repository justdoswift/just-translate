import assert from "node:assert/strict";
import test from "node:test";
import { observeNavigation } from "../src/content/navigation";

function pageFixture() {
  const location = { href: "https://example.test/article" };
  const events = new EventTarget();
  const navigation = new EventTarget();
  let attributes: Record<string, string> = {};
  let root = { getAttribute: (name: string) => attributes[name] ?? null };
  const document = {
    querySelector: () => null,
    querySelectorAll: () => ({ length: 1, item: () => root }),
    getElementById: () => null,
    getElementsByName: () => [],
  };
  const originals = ["window", "document", "location"].map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  Object.defineProperties(globalThis, {
    window: {
      configurable: true,
      value: Object.assign(events, { navigation }),
    },
    document: { configurable: true, value: document },
    location: { configurable: true, value: location },
  });
  return {
    location,
    events,
    navigation,
    replaceRoot(nextAttributes: Record<string, string> = {}) {
      attributes = nextAttributes;
      root = { getAttribute: (name: string) => attributes[name] ?? null };
    },
    restore() {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test("ordinary anchors preserve a session, while a real SPA route ends it once", (t) => {
  const page = pageFixture();
  const reasons: string[] = [];
  const watch = observeNavigation((reason) => reasons.push(reason));
  t.after(() => {
    watch.disconnect();
    page.restore();
  });
  page.location.href += "#below";
  page.navigation.dispatchEvent(new Event("currententrychange"));
  page.events.dispatchEvent(new Event("hashchange"));
  assert.deepEqual(reasons, []);
  page.location.href = "https://example.test/another-article";
  page.navigation.dispatchEvent(new Event("currententrychange"));
  page.events.dispatchEvent(new Event("popstate"));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0]!, /页面地址已变化/);
});

test("hydration root replacement continues, but changed explicit article identity ends the session", (t) => {
  const page = pageFixture();
  const reasons: string[] = [];
  const watch = observeNavigation((reason) => reasons.push(reason));
  t.after(() => {
    watch.disconnect();
    page.restore();
  });
  page.replaceRoot();
  watch.checkArticle();
  assert.deepEqual(reasons, []);
  page.replaceRoot({ "data-article-id": "first" });
  watch.checkArticle();
  page.replaceRoot({ "data-article-id": "first" });
  watch.checkArticle();
  assert.deepEqual(reasons, []);
  page.replaceRoot({ "data-article-id": "second" });
  watch.checkArticle();
  assert.equal(reasons.length, 1);
  assert.match(reasons[0]!, /正文已切换/);
});

test("leaving a document ends its session, and a disconnected watcher cannot cancel another session", (t) => {
  const page = pageFixture();
  t.after(page.restore);
  const reasons: string[] = [];
  const watch = observeNavigation((reason) => reasons.push(reason));
  page.events.dispatchEvent(new Event("pagehide"));
  assert.deepEqual(reasons, ["页面文档已离开。"]);
  watch.disconnect();
  page.events.dispatchEvent(new Event("pagehide"));
  assert.equal(reasons.length, 1);
});
