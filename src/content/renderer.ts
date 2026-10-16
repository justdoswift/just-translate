import { sendMessage, type AppError } from "../shared";

export interface RenderedPart {
  id: string;
  text?: string;
  error?: AppError;
  pending?: boolean;
}

export interface TranslationView {
  host: HTMLSpanElement;
  update(parts: readonly RenderedPart[], retry: (id: string) => void): void;
  remove(): void;
}

const SETTINGS_ERRORS: Partial<Record<AppError["code"], true>> = {
  configuration: true,
  permission: true,
  authentication: true,
  budget: true,
  quota: true,
};

/** The only light-DOM addition is a phrasing-content host, valid in paragraphs, lists and cells. */
export function createTranslationView(
  element: Element,
  language: string,
  register: (node: Node) => void,
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
  element.append(host);
  return {
    host,
    update(parts, retry) {
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
          row.classList.add("error");
          row.textContent = "正在重试此段…";
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
    remove() {
      host.remove();
    },
  };
}
