function routerHash(hash: string): string {
  let decoded = hash;
  try {
    decoded = decodeURIComponent(hash);
  } catch {
    /* A malformed ordinary anchor is not a route. */
  }
  if (!/[/?]/.test(decoded) && !decoded.startsWith("#!")) return "";
  if (typeof document !== "undefined") {
    const anchor = decoded.slice(1);
    if (
      document.getElementById(anchor) ||
      Array.from(document.getElementsByName(anchor)).some(
        (element) => element.tagName === "A",
      )
    )
      return "";
  }
  return decoded;
}

export function pageIdentity(href: string): string {
  const url = new URL(href);
  return `${url.origin}${url.pathname}${url.search}${routerHash(url.hash)}`;
}

function articleIdentity(element: Element | null): string {
  if (!element) return "";
  const values = ["itemid", "data-article-id", "data-post-id"].map(
    (attribute) => element.getAttribute(attribute) ?? "",
  );
  return values.some(Boolean) ? JSON.stringify(values) : "";
}


function canonicalIdentity(): string | undefined {
  const href = document.querySelector<HTMLLinkElement>(
    'link[rel="canonical"]',
  )?.href;
  if (!href) return undefined;
  try {
    return pageIdentity(href);
  } catch {
    return undefined;
  }
}

export interface NavigationWatch {
  checkArticle(): void;
  disconnect(): void;
}

/** Native navigation events avoid replacing the site's History API or entering the main world. */
export function observeNavigation(
  end: (reason: string) => void,
): NavigationWatch {
  // Once this document is a feed, removing cards must not promote the last
  // remaining card's identity into a page-navigation identity.
  let feed = false;
  const findArticleRoot = (): Element | null => {
    const main = document.querySelector('main,[role="main"]');
    if (feed) return main;
    const selector = 'article,[role="article"]';
    let sole: Element | null = null;
    for (const article of (main ?? document).querySelectorAll(selector)) {
      const parentArticle = article.parentElement?.closest(selector);
      if (parentArticle && (!main || main.contains(parentArticle))) continue;
      if (sole) {
        feed = true;
        return main;
      }
      sole = article;
    }
    return sole ?? main;
  };
  const locationIdentity = pageIdentity(location.href);
  let articleKey = articleIdentity(findArticleRoot());
  let canonical = canonicalIdentity();
  let ended = false;
  const finish = (reason: string): void => {
    if (ended) return;
    ended = true;
    end(reason);
  };
  const checkLocation = (): void => {
    if (pageIdentity(location.href) !== locationIdentity)
      finish("页面地址已变化，请用翻译快捷键重新翻译。");
  };
  const pagehide = (): void => finish("页面文档已离开。");
  // Chromium exposes Navigation even where an older TypeScript DOM library omits its declaration.
  const navigation = (window as Window & { navigation?: EventTarget })
    .navigation;
  navigation?.addEventListener("currententrychange", checkLocation);
  window.addEventListener("popstate", checkLocation);
  window.addEventListener("hashchange", checkLocation);
  window.addEventListener("pagehide", pagehide);
  return {
    checkArticle() {
      checkLocation();
      if (ended) return;
      const wasFeed = feed;
      const nextKey = articleIdentity(findArticleRoot());
      if (feed !== wasFeed) articleKey = "";
      const nextCanonical = canonicalIdentity();
      // Hydration can replace the whole root without changing the article.
      // Require a changed, explicit identity rather than DOM object identity.
      if (
        (articleKey && nextKey && articleKey !== nextKey) ||
        (canonical && nextCanonical && canonical !== nextCanonical)
      ) {
        finish("正文已切换，请用翻译快捷键重新翻译。");
        return;
      }
      if (nextKey) articleKey = nextKey;
      canonical ??= nextCanonical;
    },
    disconnect() {
      ended = true;
      navigation?.removeEventListener("currententrychange", checkLocation);
      window.removeEventListener("popstate", checkLocation);
      window.removeEventListener("hashchange", checkLocation);
      window.removeEventListener("pagehide", pagehide);
    },
  };
}
