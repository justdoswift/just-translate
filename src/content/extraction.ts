import { MAX_SEGMENT_CHARS } from "../shared";

export const BLOCK_SELECTOR =
  "p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,dd,dt,figcaption,caption,article,main,section,div";
const EXCLUDED_SELECTOR =
  'nav,button,form,input,textarea,select,option,pre,script,style,noscript,template,svg,math,iframe,canvas,video,audio,[role="navigation"],[role="menu"],[role="menubar"],[role="toolbar"],[role="button"],[role="textbox"],[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate';
const CODE_TOKEN = /⟦JT_CODE_\d+⟧/g;
const BLOCK_DISPLAYS: Record<string, true> = {
  block: true,
  "flow-root": true,
  flex: true,
  grid: true,
  table: true,
  "table-row": true,
  "table-cell": true,
  "list-item": true,
};

export interface ExtractedSource {
  text: string;
  signature: string;
  codes: string[];
}

export function isReadableElement(
  element: Element,
  owned: (node: Node) => boolean,
): boolean {
  if (
    document.designMode === "on" ||
    !element.isConnected ||
    owned(element) ||
    element.closest(EXCLUDED_SELECTOR)
  )
    return false;
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    if (
      current.hasAttribute("hidden") ||
      current.hasAttribute("inert") ||
      current.getAttribute("aria-hidden") === "true"
    )
      return false;
    const style = getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.contentVisibility === "hidden" ||
      style.opacity === "0"
    )
      return false;
    const clipsY = style.overflowY === "hidden" || style.overflowY === "clip";
    const clipsX = style.overflowX === "hidden" || style.overflowX === "clip";
    if (clipsX || clipsY) {
      const bounds = current.getBoundingClientRect();
      if (
        (clipsY && (bounds.height === 0 || style.maxHeight === "0px")) ||
        (clipsX && (bounds.width === 0 || style.maxWidth === "0px"))
      )
        return false;
    }
    if (current instanceof HTMLDetailsElement && !current.open) {
      const summary = Array.from(current.children).find(
        (child) => child.tagName === "SUMMARY",
      );
      if (!summary || (element !== summary && !summary.contains(element)))
        return false;
    }
  }
  return true;
}

/** Read inline content only; child semantic blocks are collected independently. */
export function extractSource(
  element: Element,
  owned: (node: Node) => boolean,
): ExtractedSource | undefined {
  if (!isReadableElement(element, owned)) return undefined;
  const codes: string[] = [];
  const pieces: string[] = [];
  const protect = (text: string): string => {
    const token = `⟦JT_CODE_${codes.length}⟧`;
    codes.push(text);
    return token;
  };
  const visit = (node: Node): void => {
    if (owned(node)) return;
    if (node.nodeType === Node.TEXT_NODE) {
      pieces.push(
        (node.nodeValue ?? "").replace(CODE_TOKEN, (literal) =>
          protect(literal),
        ),
      );
      return;
    }
    if (
      !(node instanceof Element) ||
      node.matches(EXCLUDED_SELECTOR) ||
      !isReadableElement(node, owned)
    )
      return;
    if (
      node.tagName === "CODE" ||
      node.tagName === "KBD" ||
      node.tagName === "SAMP"
    ) {
      pieces.push(protect(node.textContent ?? ""));
      return;
    }
    if (node.tagName === "BR") {
      pieces.push("\n");
      return;
    }
    if (node.matches(BLOCK_SELECTOR)) {
      pieces.push("\n");
      return;
    }
    const blockBoundary = BLOCK_DISPLAYS[getComputedStyle(node).display];
    if (blockBoundary) pieces.push("\n");
    for (const child of node.childNodes) visit(child);
    if (blockBoundary) pieces.push("\n");
  };
  for (const child of element.childNodes) visit(child);
  const text = pieces
    .join("")
    .replace(/[\t\r\f \u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!/\p{L}/u.test(text.replace(CODE_TOKEN, ""))) return undefined;
  return { text, codes, signature: JSON.stringify([text, codes]) };
}

/** A declared language plus a matching script is stronger evidence than short-word guessing. */
export function isAlreadyTarget(
  text: string,
  target: string,
  declaredLanguage: string,
): boolean {
  const letters = text.replace(CODE_TOKEN, "").match(/\p{L}/gu) ?? [];
  if (letters.length < 8) return false;
  const base = target.split("-")[0];
  const declared = declaredLanguage.toLowerCase();
  const declaredBase = declared.split("-")[0];
  const count = (pattern: RegExp): number =>
    letters.filter((letter) => pattern.test(letter)).length;
  if (base === "ja")
    return (
      count(/[\p{Script=Hiragana}\p{Script=Katakana}]/u) >= 6 &&
      count(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u) /
        letters.length >
        0.8
    );
  if (base === "ko") return count(/\p{Script=Hangul}/u) / letters.length > 0.8;
  if (base === "zh") {
    const variant =
      target === "zh-TW"
        ? /^(zh-tw|zh-hk|zh-hant)(-|$)/
        : /^(zh-cn|zh-sg|zh-hans)(-|$)/;
    return (
      variant.test(declared) && count(/\p{Script=Han}/u) / letters.length > 0.8
    );
  }
  return (
    declaredBase === base &&
    letters.length >= 20 &&
    count(/\p{Script=Latin}/u) / letters.length > 0.95
  );
}

/** Prefer sentence, then word boundaries; never divide an opaque inline-code token. */
export function splitSource(text: string, limit = MAX_SEGMENT_CHARS): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    let boundary = 0;
    for (const match of window.matchAll(
      /[.!?。！？](?:[”’"')\]]*)(?:\s+|(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]))|\n+/gu,
    )) {
      boundary = (match.index ?? 0) + match[0].length;
    }
    if (boundary < limit / 3)
      boundary = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"));
    if (boundary < limit / 3) boundary = limit;
    const tokenStart = remaining.lastIndexOf("⟦JT_CODE_", boundary - 1);
    if (tokenStart >= 0) {
      const tokenEnd = remaining.indexOf("⟧", tokenStart);
      if (tokenEnd >= boundary) boundary = tokenStart;
    }
    // Surrogate pairs must survive even when one sentence has no whitespace.
    if (boundary > 0 && /[\uD800-\uDBFF]/.test(remaining[boundary - 1] ?? ""))
      boundary -= 1;
    if (boundary === 0) boundary = Math.min(limit, remaining.length);
    const part = remaining.slice(0, boundary).trim();
    if (part) chunks.push(part);
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function restoreCode(
  text: string,
  codes: readonly string[],
): string | undefined {
  let invalid = false;
  const restored = text.replace(CODE_TOKEN, (token) => {
    const index = Number(token.slice("⟦JT_CODE_".length, -1));
    const value = codes[index];
    if (value === undefined) invalid = true;
    return value ?? "";
  });
  return invalid ? undefined : restored;
}

export function preservesCodeTokens(
  source: string,
  translated: string,
): boolean {
  const tokens = (text: string): string =>
    (text.match(CODE_TOKEN) ?? []).sort().join("\n");
  return tokens(source) === tokens(translated);
}
