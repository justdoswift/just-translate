import { extractSource } from "./extraction";
import { readSourceText } from "./source-visibility";

const PROSE = "p,h1,h2,h3,h4,h5,h6";
const HEADING = "h1,h2,h3,h4,h5,h6";
const INTERACTIVE =
  'a,button,[role="link"],[role="button"],[onclick],[tabindex]:not([tabindex="-1"])';
const CONTENT_UNIT =
  'article,li,[role="article"],[role="listitem"],[itemid],[data-article-id],[data-post-id],[data-comment-id]';
const UNIT_NAME =
  /(?:^|[\s_-])(?:card|comment|post|tweet|reply|review|item)(?:$|[\s_-])/i;

function isProse(element: Element, owned: (node: Node) => boolean): boolean {
  const link = element.querySelector("a");
  const text = extractSource(element, owned)?.text;
  if (link && text && extractSource(link, owned)?.text === text)
    return false;
  return (
    element.matches(PROSE) &&
    !element.matches(CONTENT_UNIT) &&
    !UNIT_NAME.test(`${element.id} ${element.getAttribute("class") ?? ""}`) &&
    !element.closest(INTERACTIVE) &&
    !element.querySelector(
      'article,section,li,div,p,blockquote,button,[role="button"],[role="link"]',
    )
  );
}

function sibling(
  element: Element,
  direction: "previousSibling" | "nextSibling",
  owned: (node: Node) => boolean,
): Element | undefined {
  let node = element[direction];
  while (node) {
    if (owned(node) || node.nodeType === Node.COMMENT_NODE) {
      node = node[direction];
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE && !readSourceText(node).trim()) {
      node = node[direction];
      continue;
    }
    return node instanceof Element && isProse(node, owned) ? node : undefined;
  }
  return undefined;
}

/** Direct prose siblings only: wrappers, independent units and headings are hard boundaries. */
export function relatedElements(
  element: Element,
  owned: (node: Node) => boolean,
): Element[] {
  if (!isProse(element, owned)) return [element];
  const before: Element[] = [];
  let cursor = element;
  while (!cursor.matches(HEADING)) {
    const previous = sibling(cursor, "previousSibling", owned);
    if (!previous) break;
    before.push(previous);
    cursor = previous;
  }
  const result = before.reverse();
  result.push(element);
  cursor = element;
  for (;;) {
    const next = sibling(cursor, "nextSibling", owned);
    if (!next || next.matches(HEADING)) break;
    result.push(next);
    cursor = next;
  }
  return result;
}

/** Keep the adjacent edge without cutting a protected token or surrogate pair. */
export function contextExcerpt(
  text: string,
  limit: number,
  end: boolean,
): string {
  if (text.length <= limit) return text;
  let boundary = end ? text.length - limit : limit;
  const tokenStart = text.lastIndexOf("⟦JT_CODE_", boundary - 1);
  const tokenEnd = tokenStart < 0 ? -1 : text.indexOf("⟧", tokenStart);
  if (tokenStart >= 0 && tokenEnd >= boundary)
    boundary = end ? tokenEnd + 1 : tokenStart;
  if (/[\uDC00-\uDFFF]/.test(text[boundary] ?? "")) boundary += end ? 1 : -1;
  return end ? text.slice(boundary) : text.slice(0, boundary);
}
