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

function findArticleRoot(): Element | null {
  const main = document.querySelector('main,[role="main"]');
  const articles = (main ?? document).querySelectorAll(
    'article,[role="article"]',
  );
  // A feed's many article cards are not independent page navigations.
  return articles.length === 1 ? articles.item(0) : main;
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
      finish("页面地址已变化，请点击工具栏重新翻译。");
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
      const nextKey = articleIdentity(findArticleRoot());
      const nextCanonical = canonicalIdentity();
      // Hydration can replace the whole root without changing the article.
      // Require a changed, explicit identity rather than DOM object identity.
      if (
        (articleKey && nextKey && articleKey !== nextKey) ||
        (canonical && nextCanonical && canonical !== nextCanonical)
      ) {
        finish("正文已切换，请点击工具栏重新翻译。");
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
