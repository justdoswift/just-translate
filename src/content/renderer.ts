import { sendMessage, type AppError, type DisplayMode } from "../shared";
import { createSourceVisibility } from "./source-visibility";

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

const expandedButtons = new WeakMap<
  HTMLButtonElement,
  {
    readers: number;
    restore: () => void;
  }
>();

function expandButton(button: HTMLButtonElement): () => void {
  let entry = expandedButtons.get(button);
  if (!entry) {
    const values = ([
      ["height", "auto"],
      ["max-height", "none"],
      ["overflow", "visible"],
      ["-webkit-line-clamp", "unset"],
      ["line-clamp", "unset"],
    ] as const).map(([property, expanded]) => {
      const value = button.style.getPropertyValue(property);
      const priority = button.style.getPropertyPriority(property);
      button.style.setProperty(property, expanded, "important");
      return { property, expanded, value, priority };
    });
    entry = {
      readers: 0,
      restore() {
        for (const { property, expanded, value, priority } of values) {
          if (
            button.style.getPropertyValue(property) !== expanded ||
            button.style.getPropertyPriority(property) !== "important"
          )
            continue;
          if (value) button.style.setProperty(property, value, priority);
          else button.style.removeProperty(property);
        }
      },
    };
    expandedButtons.set(button, entry);
  }
  entry.readers += 1;
  return () => {
    if (--entry.readers === 0) {
      entry.restore();
      expandedButtons.delete(button);
    }
  };
}

/** Preserve original nodes so stopping restores links, controls and site updates. */
export function createTranslationView(
  element: Element,
  language: string,
  register: (node: Node) => void,
  displayMode: DisplayMode,
  readSourceNodes: () => readonly Node[],
): TranslationView {
  const host = document.createElement("span");
  register(host);
  host.lang = language;
  host.setAttribute("translate", "no");
  host.setAttribute("aria-label", "Just Translate 译文");
  host.style.setProperty("display", "block", "important");
  host.style.setProperty("font", "inherit", "important");
  host.style.setProperty("color", "inherit", "important");
  host.style.setProperty("margin-block", "0.45em 0.15em", "important");
  host.style.setProperty("white-space", "normal", "important");
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
  `;
  const content = document.createElement("span");
  content.className = "parts";
  shadow.append(style, content);
  const source = createSourceVisibility(readSourceNodes);
  const button = element.closest("button");
  const restoreButton =
    button && displayMode === "translation" ? expandButton(button) : undefined;
  const restoredStyles: {
    property: string;
    value: string;
    priority: string;
  }[] = [];
  if (
    (!button || displayMode === "translation") &&
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
  // Translation-only labels stay inside their original clickable control.
  if (button && displayMode === "bilingual") button.after(host);
  else element.append(host);
  return {
    host,
    update(parts, retry) {
      if (
        displayMode === "translation" &&
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
          label.textContent = `此段翻译失败：${part.error.message}${part.error.uncertain ? " 请求结果未确认；重试可能重复计费。" : ""}`;
          const actions = document.createElement("span");
          actions.className = "actions";
          const retryButton = document.createElement("button");
          retryButton.type = "button";
          retryButton.textContent = "重试此段";
          retryButton.setAttribute("aria-label", "仅重试这一段失败的翻译");
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
            settings.textContent = "打开设置";
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
      restoreButton?.();
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
