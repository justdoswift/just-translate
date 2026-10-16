import { sendMessage, type AppError, type DisplayMode } from "../shared";
import { createSourceVisibility, readSourceText } from "./source-visibility";

export interface RenderedPart {
  id: string;
  text?: string;
  error?: AppError;
  pending?: boolean;
}

export interface TranslationView {
  host: HTMLSpanElement;
  update(parts: readonly RenderedPart[], retry: (id: string) => void): void;
  reveal(): void;
  remove(): void;
}

const SETTINGS_ERRORS: Partial<Record<AppError["code"], true>> = {
  configuration: true,
  permission: true,
  authentication: true,
  budget: true,
  quota: true,
};

function controlLabel(element: Element, nodes: readonly Node[]): Element {
  let label: Element | undefined;
  for (const node of nodes) {
    if (!readSourceText(node).trim()) continue;
    const parent = node instanceof Element ? node : node.parentElement;
    if (!parent) continue;
    if (!label) label = parent;
    while (label !== element && !label.contains(parent))
      label = label.parentElement ?? element;
  }
  return label ?? element;
}

/** Preserve original nodes so stopping restores links, controls and site updates. */
export function createTranslationView(
  element: Element,
  language: string,
  register: (node: Node) => void,
  displayMode: DisplayMode,
  readSourceNodes: () => readonly Node[],
): TranslationView {
  const inlineControl = !!element.closest("button") ||
    (!element.matches("p,h1,h2,h3,h4,h5,h6,blockquote,li,article,main,section") &&
      !!element.closest('a,[role="button"],[role="link"]'));
  const host = document.createElement("span");
  register(host);
  host.lang = language;
  host.setAttribute("translate", "no");
  host.setAttribute("aria-label", "Just Translate 译文");
  host.style.setProperty("display", inlineControl ? "inline" : "block", "important");
  host.style.setProperty("font", "inherit", "important");
  host.style.setProperty("color", "inherit", "important");
  host.style.setProperty("margin-block", inlineControl ? "0" : "0.45em 0.15em", "important");
  host.style.setProperty("white-space", inlineControl ? "inherit" : "normal", "important");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { text-align: inherit; direction: inherit; }
    .parts { display: block; font: inherit; color: inherit; line-height: inherit; overflow-wrap: anywhere; }
    .part { display: block; white-space: pre-wrap; }
    .part + .part { margin-block-start: .3em; }
    .loading { display: flex; align-items: center; min-height: 1.4em; }
    .loading::before {
      content: ""; width: 14px; height: 14px; box-sizing: border-box;
      border: 2px solid currentColor; border-inline-end-color: transparent;
      border-radius: 50%; animation: translate-spin .8s linear infinite;
    }
    @keyframes translate-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .loading::before { animation: none; } }
    .error { display: block; font-size: max(.8em, 13px); line-height: 1.5; font-weight: normal; }
    .actions { display: inline-flex; flex-wrap: wrap; gap: 8px; margin-inline-start: 8px; vertical-align: middle; }
    button { appearance: auto; cursor: pointer; font: inherit; color: inherit; background: transparent; border: 1px solid currentColor; border-radius: 4px; padding: 6px 10px; min-height: 44px; }
    button:hover { text-decoration: underline; }
    button:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
    button:disabled { cursor: wait; opacity: .7; }
    ${inlineControl ? `
      .parts, .part { display: inline; white-space: inherit; overflow-wrap: normal; }
      .part + .part { margin: 0; }
      .loading { display: inline-flex; min-height: 0; vertical-align: middle; margin-inline-start: .25em; }
      .error { display: inline; font: inherit; }
      .actions { gap: .25em; margin-inline-start: .25em; vertical-align: baseline; }
      button { min-height: 0; padding: 0 .25em; line-height: inherit; }
    ` : ""}
  `;
  const content = document.createElement("span");
  content.className = "parts";
  shadow.append(style, content);
  const source = createSourceVisibility(readSourceNodes);
  const restoredStyles: {
    property: string;
    value: string;
    priority: string;
  }[] = [];
  if (
    !inlineControl &&
    element instanceof HTMLElement
  ) {
    const computed = getComputedStyle(element);
    for (const property of ["-webkit-line-clamp", "line-clamp"]) {
      if (!(parseInt(computed.getPropertyValue(property), 10) > 0)) continue;
      restoredStyles.push({
        property,
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      });
      element.style.setProperty(property, "unset", "important");
    }
  }
  // Controls replace their label in its original layout slot, including bilingual mode.
  // Paragraphs keep the independent translation row below their source.
  (inlineControl ? controlLabel(element, readSourceNodes()) : element).append(host);
  return {
    host,
    update(parts, retry) {
      if (
        (displayMode === "translation" || inlineControl) &&
        parts.length > 0 &&
        parts.every(
          (part) => part.text !== undefined && !part.pending && !part.error,
        )
      )
        source.hide();
      else source.restore();
      host.setAttribute(
        "aria-busy",
        String(parts.some((part) => part.pending)),
      );
      const focusedId = shadow.activeElement
        ?.closest("[data-segment]")
        ?.getAttribute("data-segment");
      const rows: HTMLSpanElement[] = [];
      for (const part of parts) {
        if (part.text === undefined && !part.error && !part.pending) continue;
        const row = document.createElement("span");
        row.className = "part";
        row.dataset.segment = part.id;
        if (part.text !== undefined) row.textContent = part.text;
        if (part.pending) {
          row.lang = "zh-CN";
          row.classList.add("loading");
          row.setAttribute("aria-label", "正在翻译");
          row.setAttribute("role", "status");
        }
        if (part.error) {
          row.classList.add("error");
          row.lang = "zh-CN";
          const label = document.createElement("span");
          const errorMessage = `此段翻译失败：${part.error.message}${part.error.uncertain ? " 请求结果未确认；重试可能重复计费。" : ""}`;
          label.textContent = inlineControl ? "翻译失败" : errorMessage;
          if (inlineControl) row.title = errorMessage;
          const actions = document.createElement("span");
          actions.className = "actions";
          const retryButton = document.createElement("button");
          retryButton.type = "button";
          retryButton.textContent = inlineControl ? "重试" : "重试此段";
          retryButton.setAttribute("aria-label", inlineControl ? `${errorMessage} 重试翻译` : "仅重试这一段失败的翻译");
          retryButton.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (retryButton.disabled) return;
            retryButton.disabled = true;
            retryButton.textContent = "正在重试…";
            retry(part.id);
          });
          actions.append(retryButton);
          if (SETTINGS_ERRORS[part.error.code]) {
            const settings = document.createElement("button");
            settings.type = "button";
            settings.textContent = inlineControl ? "设置" : "打开设置";
            settings.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              if (settings.disabled) return;
              settings.disabled = true;
              void sendMessage<void>({ type: "options:open" }).then((reply) => {
                if (!host.isConnected) return;
                settings.disabled = false;
                if (!reply.ok)
                  label.textContent = `无法打开设置：${reply.error.message}`;
              });
            });
            actions.append(settings);
          }
          row.append(label, actions);
        }
        rows.push(row);
      }
      content.replaceChildren(...rows);
      if (focusedId) {
        const row = rows.find(
          (candidate) => candidate.dataset.segment === focusedId,
        );
        if (row) {
          const target =
            row.querySelector<HTMLButtonElement>("button:not(:disabled)") ??
            row;
          if (target === row) row.tabIndex = -1;
          target.focus({ preventScroll: true });
        }
      }
    },
    reveal: () => source.restore(),
    remove() {
      source.restore();
      host.remove();
      if (element instanceof HTMLElement) {
        for (const { property, value, priority } of restoredStyles) {
          // Do not overwrite a later inline style change made by the website.
          if (
            element.style.getPropertyValue(property) !== "unset" ||
            element.style.getPropertyPriority(property) !== "important"
          )
            continue;
          if (value) element.style.setProperty(property, value, priority);
          else element.style.removeProperty(property);
        }
      }
    },
  };
}
