import { isReadableElement } from "./extraction";

interface Scrollport {
  element: Element;
  top: number;
  bottom: number;
  left: number;
  right: number;
  depth: number;
  scrollTop: number;
  scrollLeft: number;
  anchor?: Element;
  offset: number;
  inset: number;
  distance: number;
}

interface Context {
  ports: Scrollport[];
  excluded: boolean;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** A snapshot lasts only for this synchronous DOM batch, never across a request. */
export function preserveReadingPosition(
  elements: Iterable<Element>,
  owned: (node: Node) => boolean,
  change: () => void,
): void {
  const root = document.scrollingElement;
  if (!root) {
    change();
    return;
  }
  const viewport: Scrollport = {
    element: root,
    top: 0,
    bottom: document.documentElement.clientHeight,
    left: 0,
    right: document.documentElement.clientWidth,
    depth: 0,
    scrollTop: root.scrollTop,
    scrollLeft: root.scrollLeft,
    offset: 0,
    inset: 0,
    distance: Infinity,
  };
  const ports = new Map<Element, Scrollport>([[root, viewport]]);
  const contexts = new Map<Element, Context>();
  const context = (element: Element | null): Context => {
    if (!element)
      return {
        ports: [viewport],
        excluded: false,
        top: viewport.top,
        bottom: viewport.bottom,
        left: viewport.left,
        right: viewport.right,
      };
    const cached = contexts.get(element);
    if (cached) return cached;
    const parent = context(element.parentElement);
    const style = getComputedStyle(element);
    const result: Context = {
      ports: parent.ports,
      excluded:
        parent.excluded ||
        style.position === "fixed" ||
        style.position === "sticky" ||
        style.visibility !== "visible" ||
        style.display === "none",
      top: parent.top,
      bottom: parent.bottom,
      left: parent.left,
      right: parent.right,
    };
    const clipsY = /^(auto|scroll|overlay|hidden|clip)$/.test(style.overflowY);
    const clipsX = /^(auto|scroll|overlay|hidden|clip)$/.test(style.overflowX);
    if (element !== root && element !== document.body && (clipsY || clipsX)) {
      const rect = element.getBoundingClientRect();
      if (clipsY) {
        result.top = Math.max(parent.top, rect.top + element.clientTop);
        result.bottom = Math.min(
          parent.bottom,
          rect.top + element.clientTop + element.clientHeight,
        );
      }
      if (clipsX) {
        result.left = Math.max(parent.left, rect.left + element.clientLeft);
        result.right = Math.min(
          parent.right,
          rect.left + element.clientLeft + element.clientWidth,
        );
      }
    }
    if (
      element !== root &&
      element !== document.body &&
      /^(auto|scroll|overlay|hidden)$/.test(style.overflowY) &&
      element.clientHeight > 0
    ) {
      const rect = element.getBoundingClientRect();
      const port: Scrollport = {
        element,
        top: rect.top + element.clientTop,
        bottom: rect.top + element.clientTop + element.clientHeight,
        left: rect.left + element.clientLeft,
        right: rect.left + element.clientLeft + element.clientWidth,
        depth: parent.ports.length,
        scrollTop: element.scrollTop,
        scrollLeft: element.scrollLeft,
        offset: 0,
        inset: 0,
        distance: Infinity,
      };
      ports.set(element, port);
      result.ports = [port, ...parent.ports];
    }
    contexts.set(element, result);
    return result;
  };

  // Reuse controller candidates: one layout-read pass per batch, not per rendered paragraph.
  const seen = new Set<Element>();
  for (const element of elements) {
    if (seen.has(element) || !element.isConnected || owned(element)) continue;
    seen.add(element);
    const rect = element.getBoundingClientRect();
    if (
      rect.height <= 0 ||
      rect.width <= 0 ||
      rect.bottom <= 0 ||
      rect.top >= viewport.bottom ||
      rect.right <= 0 ||
      rect.left >= viewport.right
    )
      continue;
    const own = context(element);
    if (own.excluded || !isReadableElement(element, owned)) continue;
    // A block scrolls with its ancestors, not with its own scrollTop.
    const ancestors = context(element.parentElement);
    if (
      rect.bottom <= ancestors.top ||
      rect.top >= ancestors.bottom ||
      rect.right <= ancestors.left ||
      rect.left >= ancestors.right
    )
      continue;
    for (const port of ancestors.ports) {
      const distance = Math.max(0, rect.top - Math.max(viewport.top, port.top));
      if (
        !port.anchor ||
        port.anchor.contains(element) ||
        (!element.contains(port.anchor) && distance < port.distance)
      ) {
        port.anchor = element;
        port.offset = rect.top - ancestors.top;
        port.inset = ancestors.top - port.top;
        port.distance = distance;
      }
    }
  }

  try {
    change();
  } finally {
    // Flush final layout (including native anchoring) before computing the remaining delta.
    // Inner scrollports settle first, so their correction is not repeated on the document.
    for (const port of [...ports.values()].sort((a, b) => b.depth - a.depth)) {
      if (!port.element.isConnected) continue;
      let target: number;
      if (port.scrollTop === 0) {
        target = 0;
      } else if (port.anchor?.isConnected) {
        const rect = port.anchor.getBoundingClientRect();
        if (rect.height <= 0) continue;
        const top =
          port === viewport
            ? 0
            : port.element.getBoundingClientRect().top + port.element.clientTop;
        // Retain the intra-block pixel offset when possible; never anchor beyond a shortened block.
        const line =
          Number.parseFloat(getComputedStyle(port.anchor).lineHeight) || 1;
        const offset = Math.max(port.offset, -Math.max(0, rect.height - line));
        target = port.element.scrollTop + rect.top - top - port.inset - offset;
      } else {
        continue;
      }
      if (
        Math.abs(port.element.scrollTop - target) > 0.5 ||
        port.element.scrollLeft !== port.scrollLeft
      )
        port.element.scrollTo({
          top: target,
          left: port.scrollLeft,
          behavior: "instant",
        });
    }
  }
}
