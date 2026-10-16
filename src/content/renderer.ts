import { sendMessage, type AppError, type PageProgress } from "../shared";

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

export interface ProgressView {
  host: HTMLSpanElement;
  update(progress: PageProgress): void;
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
  const button = element.closest("button");
  const restoredStyles: {
    property: string;
    value: string;
    priority: string;
  }[] = [];
  if (!button && element instanceof HTMLElement) {
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
  // Compact interactive previews must keep their click target and fixed size.
  // Render their translation beside the control, not inside its clipped label.
  if (button) button.after(host);
  else element.append(host);
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

export function createProgressView(
  onStop: () => void,
  register: (node: Node) => void,
): ProgressView {
  const host = document.createElement("span");
  register(host);
  host.lang = "zh-CN";
  host.dir = "ltr";
  host.setAttribute("translate", "no");
  host.setAttribute("role", "region");
  host.setAttribute("aria-label", "Just Translate 翻译状态");
  host.setAttribute("aria-busy", "true");
  const hostStyles: Record<string, string> = {
    all: "initial",
    display: "block",
    position: "fixed",
    inset: "auto",
    right: "max(12px, env(safe-area-inset-right))",
    bottom: "max(12px, env(safe-area-inset-bottom))",
    width: "min(380px, calc(100vw - 24px))",
    "max-height": "calc(100vh - 24px)",
    overflow: "auto",
    "z-index": "2147483647",
    "color-scheme": "light",
    direction: "ltr",
    "text-align": "left",
  };
  for (const [property, value] of Object.entries(hostStyles)) {
    host.style.setProperty(property, value, "important");
  }
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    *, *::before, *::after { box-sizing: border-box; }
    .panel {
      display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px;
      padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 12px;
      background: #fff; color: #111827; box-shadow: 0 4px 20px #0002;
      font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      text-align: left; letter-spacing: normal; white-space: normal;
    }
    .details { flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; }
    .heading { display: flex; align-items: center; gap: 8px; font-weight: 600; }
    .indicator {
      flex: 0 0 14px; width: 14px; height: 14px; border: 2px solid #d1d5db;
      border-top-color: #1d4ed8; border-radius: 50%;
      animation: translate-progress-spin .8s linear infinite;
    }
    .panel[data-phase="waiting"] .indicator {
      animation: none; border-color: #15803d; background: #dcfce7;
    }
    .panel[data-phase="partial"] .indicator,
    .panel[data-phase="blocked"] .indicator {
      animation: none; border-color: #b91c1c; background: #fee2e2;
    }
    .counts { display: block; margin-top: 2px; color: #4b5563; font-size: 13px; }
    .error { display: block; margin-top: 3px; color: #b91c1c; font-size: 13px; }
    .error[hidden] { display: none; }
    button {
      appearance: none; flex: 0 1 auto; min-height: 44px; max-width: 100%;
      padding: 8px 12px; border: 1px solid #9ca3af; border-radius: 8px;
      background: #fff; color: #111827; font: inherit; cursor: pointer;
      overflow-wrap: anywhere;
    }
    button:hover { background: #f3f4f6; }
    button:active { background: #e5e7eb; }
    button:focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
    @keyframes translate-progress-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .indicator { animation: none; } }
  `;
  const panel = document.createElement("span");
  panel.className = "panel";
  panel.dataset.phase = "running";
  const details = document.createElement("span");
  details.className = "details";
  const heading = document.createElement("span");
  heading.className = "heading";
  const indicator = document.createElement("span");
  indicator.className = "indicator";
  indicator.setAttribute("aria-hidden", "true");
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  status.textContent = "正在翻译";
  const counts = document.createElement("span");
  counts.className = "counts";
  counts.textContent = "正在读取页面…";
  const error = document.createElement("span");
  error.className = "error";
  error.hidden = true;
  const stop = document.createElement("button");
  stop.type = "button";
  stop.textContent = "恢复原文";
  stop.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onStop();
  });
  heading.append(indicator, status);
  details.append(heading, counts, error);
  panel.append(details, stop);
  shadow.append(style, panel);
  document.documentElement.append(host);

  return {
    host,
    update(progress) {
      if (progress.phase === "off") {
        host.remove();
        return;
      }
      panel.dataset.phase = progress.phase;
      host.setAttribute("aria-busy", String(progress.phase === "running"));
      const label =
        progress.phase === "running"
          ? "正在翻译"
          : progress.phase === "waiting"
            ? "翻译完成"
            : progress.phase === "partial"
              ? "部分翻译失败"
              : "翻译失败";
      // Announce phase changes, not every completed segment.
      if (status.textContent !== label) status.textContent = label;
      const countText = `已完成 ${progress.translated} · 待处理 ${progress.pending}${progress.failed > 0 ? ` · 失败 ${progress.failed}` : ""}`;
      if (counts.textContent !== countText) counts.textContent = countText;
      const failed =
        progress.phase === "partial" || progress.phase === "blocked";
      const message = failed ? (progress.message?.trim() ?? "") : "";
      const shortMessage =
        message.length > 96 ? `${message.slice(0, 95)}…` : message;
      if (error.textContent !== shortMessage) error.textContent = shortMessage;
      error.hidden = !message;
      error.title = message;
    },
    remove() {
      host.remove();
    },
  };
}
