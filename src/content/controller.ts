import {
  LANGUAGES,
  MAX_BATCH_CHARS,
  MAX_BATCH_SEGMENTS,
  sendMessage,
  type AppError,
  type BatchResult,
  type PageMessage,
  type PageProgress,
  type Reply,
  type Segment,
  type Settings,
  type Translation,
} from "../shared";
import {
  BLOCK_SELECTOR,
  extractSource,
  isAlreadyTarget,
  preservesCodeTokens,
  restoreCode,
  splitSource,
  type ExtractedSource,
} from "./extraction";
import { contextExcerpt, relatedElements } from "./context";
import { observeNavigation, type NavigationWatch } from "./navigation";
import { createTranslationView, type TranslationView } from "./renderer";
import { consumeSourceMutation, observeSourceChanges } from "./source-visibility";

interface Task {
  segment: Segment;
  block: Block;
  state: "queued" | "pending" | "translated" | "failed";
  text?: string;
  error?: AppError;
  manual: boolean;
}
interface Block {
  id: string;
  element: Element;
  revision: number;
  source: ExtractedSource;
  tasks: Task[];
  visible: boolean;
  dirty: boolean;
  view?: TranslationView;
}
export interface PageSnapshot {
  active: boolean;
  sessionId?: string;
  progress?: PageProgress;
}
const BLOCKING_ERRORS: Partial<Record<AppError["code"], true>> = {
  configuration: true,
  permission: true,
  authentication: true,
  quota: true,
  budget: true,
};
const INVALID_RESPONSE: AppError = {
  code: "invalid_response",
  message: "返回内容不完整或行内代码占位符发生变化，请手动重试此段。",
  retryable: true,
};
const ATTRIBUTE_FILTER = [
  "class",
  "style",
  "hidden",
  "open",
  "aria-hidden",
  "aria-expanded",
  "contenteditable",
  "lang",
  "translate",
  "inert",
  "itemid",
  "data-article-id",
  "data-post-id",
  "href",
];

class PageSession {
  private active = true;
  private readonly blocks = new Map<Element, Block>();
  private readonly queue = new Set<Task>();
  private readonly owned = new WeakSet<Node>();
  private readonly viewOwners = new WeakMap<Node, Block>();
  private readonly dirty = new Map<
    Element,
    { due: number; subtree: boolean }
  >();
  private readonly waitingRequests = new Set<
    (reply: Reply<BatchResult>) => void
  >();
  private readonly observer: MutationObserver;
  private readonly intersection: IntersectionObserver;
  private readonly navigation: NavigationWatch;
  private scanTimer?: number;
  private progressTimer?: number;
  private pumpTimer?: number;
  private inflight = 0;
  private visibleTurns = 0;
  private blocked?: AppError;
  private lastProgress = "";

  constructor(
    readonly id: string,
    private readonly language: string,
    private readonly displayMode: Settings["displayMode"],
    private readonly ended: (session: PageSession) => void,
  ) {
    this.observer = new MutationObserver((records) => this.mutations(records));
    this.intersection = new IntersectionObserver(
      (entries) => {
        if (!this.active) return;
        for (const entry of entries) {
          const block = this.blocks.get(entry.target);
          if (block) block.visible = entry.isIntersecting;
        }
        this.schedulePump();
      },
      { rootMargin: "250px" },
    );
    this.navigation = observeNavigation((reason) => this.stop(reason));
    // Observe before the initial scan so hydration and lazy insertion cannot fall through a gap.
    this.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRIBUTE_FILTER,
    });
    observeSourceChanges(true);
    document.addEventListener("toggle", this.toggle, true);
    this.scheduleScan(document.body ?? document.documentElement, true);
    this.publish(true);
  }

  snapshot(): PageSnapshot {
    return {
      active: this.active,
      sessionId: this.id,
      progress: this.progress(),
    };
  }

  stop(reason: string): void {
    if (!this.active) return;
    for (const record of this.observer.takeRecords()) consumeSourceMutation(record);
    observeSourceChanges(false);
    this.active = false;
    this.observer.disconnect();
    this.intersection.disconnect();
    this.navigation.disconnect();
    document.removeEventListener("toggle", this.toggle, true);
    window.clearTimeout(this.scanTimer);
    window.clearTimeout(this.progressTimer);
    window.clearTimeout(this.pumpTimer);
    for (const finish of this.waitingRequests)
      finish({
        ok: false,
        error: { code: "cancelled", message: "翻译已停止。", retryable: false },
      });
    for (const block of this.blocks.values()) block.view?.remove();
    this.blocks.clear();
    this.queue.clear();
    this.dirty.clear();
    void sendMessage<void>({
      type: "page:progress",
      progress: {
        sessionId: this.id,
        phase: "off",
        translated: 0,
        pending: 0,
        failed: 0,
      },
    });
    void sendMessage<void>({ type: "page:end", sessionId: this.id, reason });
    this.ended(this);
  }

  private readonly isOwned = (node: Node): boolean => this.owned.has(node);
  private readonly toggle = (event: Event): void => {
    if (event.target instanceof Element && !this.isOwned(event.target))
      this.scheduleScan(event.target, true);
  };

  private mutations(records: MutationRecord[]): void {
    if (!this.active) return;
    let changed = false;
    for (const record of records) {
      if (consumeSourceMutation(record)) continue;
      if (record.type === "childList") {
        for (const removed of record.removedNodes) {
          const block = this.viewOwners.get(removed);
          if (
            block?.view?.host === removed &&
            !removed.isConnected &&
            block.element.isConnected
          ) {
            this.scheduleScan(block.element, false);
            changed = true;
          }
        }
      }
      if (this.isOwned(record.target)) continue;
      if (
        record.type === "childList" &&
        [...record.addedNodes, ...record.removedNodes].every(this.isOwned)
      )
        continue;
      changed = true;
      const element =
        record.target instanceof Element
          ? record.target
          : record.target.parentElement;
      if (!element) continue;
      if (record.type === "attributes") {
        this.scheduleScan(element, true);
        const owner = element.parentElement?.closest(BLOCK_SELECTOR);
        if (owner) this.scheduleScan(owner, false);
      } else {
        const owner = element.closest(BLOCK_SELECTOR);
        if (owner) this.scheduleScan(owner, false);
        if (record.type === "childList") {
          for (const added of record.addedNodes)
            if (added instanceof Element && !this.isOwned(added))
              this.scheduleScan(added, true);
          for (const removed of record.removedNodes) {
            if (!(removed instanceof Element) || this.isOwned(removed))
              continue;
            const block = this.blocks.get(removed);
            if (block && !removed.isConnected) this.release(block);
            for (const child of removed.querySelectorAll(BLOCK_SELECTOR)) {
              const nested = this.blocks.get(child);
              if (nested && !child.isConnected) this.release(nested);
            }
            for (const root of this.dirty.keys())
              if (!root.isConnected) this.dirty.delete(root);
          }
        }
      }
    }
    if (changed) {
      this.navigation.checkArticle();
      this.publish();
    }
  }

  private scheduleScan(element: Element, subtree: boolean): void {
    if (!this.active || this.isOwned(element) || !element.isConnected) return;
    const existing = this.dirty.get(element);
    this.dirty.set(element, {
      due: performance.now() + 300,
      subtree: subtree || !!existing?.subtree,
    });
    const block = this.blocks.get(element);
    if (block) block.dirty = true;
    if (subtree)
      for (const child of element.querySelectorAll(BLOCK_SELECTOR)) {
        const nested = this.blocks.get(child);
        if (nested) nested.dirty = true;
      }
    this.armScan();
  }

  private armScan(): void {
    window.clearTimeout(this.scanTimer);
    let earliest = Infinity;
    for (const entry of this.dirty.values())
      earliest = Math.min(earliest, entry.due);
    if (Number.isFinite(earliest))
      this.scanTimer = window.setTimeout(
        () => this.scan(),
        Math.max(0, earliest - performance.now()),
      );
  }

  private scan(): void {
    if (!this.active) return;
    this.navigation.checkArticle();
    if (!this.active) return;
    const now = performance.now();
    const candidates = new Set<Element>();
    for (const [root, entry] of this.dirty) {
      if (!root.isConnected) {
        this.dirty.delete(root);
        continue;
      }
      if (entry.due > now) continue;
      this.dirty.delete(root);
      if (root.matches(BLOCK_SELECTOR)) candidates.add(root);
      if (entry.subtree)
        for (const candidate of root.querySelectorAll(BLOCK_SELECTOR))
          candidates.add(candidate);
    }
    for (const element of candidates) {
      let deferred = false;
      for (const [root, entry] of this.dirty)
        if (root === element || (entry.subtree && root.contains(element))) {
          deferred = true;
          break;
        }
      if (!deferred) this.refresh(element);
    }
    this.armScan();
    this.schedulePump();
    this.publish();
  }

  private refresh(element: Element): void {
    const previous = this.blocks.get(element);
    previous?.view?.reveal();
    const source = extractSource(element, this.isOwned);
    const declared = element.closest("[lang]")?.getAttribute("lang") ?? "";
    if (!source || isAlreadyTarget(source.text, this.language, declared)) {
      if (previous) this.release(previous);
      return;
    }
    if (previous?.source.signature === source.signature) {
      previous.source = source;
      previous.dirty = false;
      this.render(previous);
      return;
    }
    const rect = element.getBoundingClientRect();
    const block: Block = previous ?? {
      id: crypto.randomUUID(),
      element,
      revision: 0,
      source,
      tasks: [],
      dirty: false,
      visible: rect.bottom >= -250 && rect.top <= innerHeight + 250,
    };
    const oldTasks = block.tasks;
    const oldCodes = block.source.codes;
    block.view?.remove();
    block.view = undefined;
    block.source = source;
    block.revision += 1;
    block.dirty = false;
    block.tasks = splitSource(source.text).map((text, index): Task => {
      const existing = oldTasks[index];
      // Editing one part of a long paragraph must not repeat successful, unchanged requests.
      if (
        existing?.segment.text === text &&
        restoreCode(text, oldCodes) === restoreCode(text, source.codes)
      )
        return existing;
      return {
        block,
        segment: {
          id: `${block.id}:${index}`,
          revision: block.revision,
          text,
          context: "",
        },
        state: this.blocked ? "failed" : "queued",
        error: this.blocked,
        manual: false,
      };
    });
    for (const task of oldTasks)
      if (!block.tasks.includes(task)) this.queue.delete(task);
    this.blocks.set(element, block);
    if (!previous) this.intersection.observe(element);
    for (const task of block.tasks)
      if (task.state === "queued") this.queue.add(task);
    this.render(block);
  }

  private release(block: Block): void {
    for (const task of block.tasks) this.queue.delete(task);
    block.view?.remove();
    block.view = undefined;
    this.intersection.unobserve(block.element);
    this.blocks.delete(block.element);
    this.dirty.delete(block.element);
  }

  private current(task: Task): boolean {
    return (
      this.active &&
      task.block.element.isConnected &&
      this.blocks.get(task.block.element) === task.block &&
      task.block.tasks.includes(task)
    );
  }

  private schedulePump(): void {
    if (!this.active || this.pumpTimer !== undefined) return;
    this.pumpTimer = window.setTimeout(() => {
      this.pumpTimer = undefined;
      this.pump();
    }, 0);
  }

  private nextTask(): Task | undefined {
    let oldest: Task | undefined;
    let visible: Task | undefined;
    for (const task of this.queue) {
      if (!this.current(task)) {
        this.queue.delete(task);
        continue;
      }
      if (task.block.dirty || (this.blocked && !task.manual)) continue;
      oldest ??= task;
      if (task.block.visible) {
        visible = task;
        break;
      }
    }
    // Every fourth choice is FIFO, so offscreen loaded content cannot starve.
    if (oldest && (this.visibleTurns >= 3 || !visible)) {
      this.visibleTurns = 0;
      return oldest;
    }
    if (visible) {
      this.visibleTurns += 1;
      return visible;
    }
    return oldest;
  }

  private relatedTasks(seed: Task): Task[] {
    const elements = relatedElements(seed.block.element, this.isOwned);
    const index = elements.indexOf(seed.block.element);
    let start = index;
    let end = index;
    const usable = (element: Element): boolean => {
      const block = this.blocks.get(element);
      return !!block && !block.dirty && block.element.isConnected;
    };
    while (start > 0 && usable(elements[start - 1]!)) start -= 1;
    while (end + 1 < elements.length && usable(elements[end + 1]!)) end += 1;
    return elements
      .slice(start, end + 1)
      .flatMap((element) => this.blocks.get(element)?.tasks ?? []);
  }

  private batch(seed: Task): Task[] {
    const related = this.relatedTasks(seed);
    const eligible = related.filter(
      (task) => this.queue.has(task) && (!this.blocked || task.manual),
    );
    const index = eligible.indexOf(seed);
    let start = index;
    let end = index;
    let chars = seed.segment.text.length;
    // Keep the priority seed, then include its nearest queued neighbors in document order.
    while (
      start > 0 &&
      end - start + 1 < MAX_BATCH_SEGMENTS &&
      chars + eligible[start - 1]!.segment.text.length <= MAX_BATCH_CHARS
    ) {
      start -= 1;
      chars += eligible[start]!.segment.text.length;
    }
    while (
      end + 1 < eligible.length &&
      end - start + 1 < MAX_BATCH_SEGMENTS &&
      chars + eligible[end + 1]!.segment.text.length <= MAX_BATCH_CHARS
    ) {
      end += 1;
      chars += eligible[end]!.segment.text.length;
    }
    const tasks = eligible.slice(start, end + 1);
    const selected = new Set(tasks);
    const sources = new Set(tasks.map((task) => task.segment.text));
    const neighbors: { itemIndex: number; position: string; text: string }[] =
      [];
    const seen = new Set<string>();
    for (const [itemIndex, task] of tasks.entries()) {
      const offset = related.indexOf(task);
      for (const direction of [-1, 1]) {
        const neighbor = related[offset + direction];
        if (
          !neighbor ||
          selected.has(neighbor) ||
          sources.has(neighbor.segment.text) ||
          seen.has(neighbor.segment.text)
        )
          continue;
        seen.add(neighbor.segment.text);
        neighbors.push({
          itemIndex,
          position: direction < 0 ? "before" : "after",
          text: neighbor.segment.text,
        });
      }
    }
    // One bounded shared hint; the provider emits identical context only once.
    const entryBudget = Math.floor(1198 / Math.max(1, neighbors.length)) - 1;
    const hints = neighbors.map((neighbor) => {
      const overhead = JSON.stringify({ ...neighbor, text: "" }).length;
      let limit = Math.min(500, entryBudget - overhead);
      for (;;) {
        const text = contextExcerpt(
          neighbor.text,
          limit,
          neighbor.position === "before",
        );
        const hint = { ...neighbor, text };
        if (JSON.stringify(hint).length <= entryBudget) return hint;
        limit = Math.max(1, Math.floor(limit / 2));
      }
    });
    const context = hints.length ? JSON.stringify(hints) : "";
    for (const task of tasks) task.segment = { ...task.segment, context };
    return tasks;
  }

  private pump(): void {
    if (!this.active) return;
    while (this.inflight < 2) {
      const seed = this.nextTask();
      if (!seed) break;
      const tasks = this.batch(seed);
      for (const task of tasks) {
        this.queue.delete(task);
        task.state = "pending";
      }
      this.inflight += 1;
      void this.translate(tasks);
    }
    this.publish();
  }

  private request(tasks: Task[]): Promise<Reply<BatchResult>> {
    // Chrome 120 predates Promise.withResolvers(); the executor keeps the declared browser floor.
    return new Promise((resolve) => {
      let settled = false;
      const finish = (reply: Reply<BatchResult>): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        this.waitingRequests.delete(finish);
        resolve(reply);
      };
      const timeout = window.setTimeout(
        () =>
          finish({
            ok: false,
            error: {
              code: "interrupted",
              message: "等待后台结果超时；请求不会自动重发。",
              retryable: true,
              uncertain: true,
            },
          }),
        100_000,
      );
      this.waitingRequests.add(finish);
      void sendMessage<BatchResult>({
        type: "page:translate",
        sessionId: this.id,
        requestId: crypto.randomUUID(),
        segments: tasks.map((task) => task.segment),
      }).then(finish);
    });
  }

  private async translate(tasks: Task[]): Promise<void> {
    const reply = await this.request(tasks);
    this.inflight -= 1;
    if (!this.active) return;
    if (!tasks.some((task) => this.current(task))) {
      this.schedulePump();
      this.publish();
      return;
    }
    if (
      !reply.ok &&
      (reply.error.code === "stale" || reply.error.code === "cancelled")
    ) {
      this.stop("翻译会话已失效，请点击工具栏重新开始。");
      return;
    }
    const translations = new Map<string, Translation>();
    let invalid = false;
    if (reply.ok) {
      if (!reply.value || !Array.isArray(reply.value.translations))
        invalid = true;
      else
        for (const item of reply.value.translations) {
          if (
            !item ||
            typeof item.id !== "string" ||
            !Number.isSafeInteger(item.revision) ||
            typeof item.text !== "string" ||
            !item.text.trim() ||
            translations.has(item.id)
          ) {
            invalid = true;
            break;
          }
          translations.set(item.id, item);
        }
    }
    const changed = new Set<Block>();
    const checkedSources = new Map<Block, string | undefined>();
    let manualSucceeded = false;
    for (const task of tasks) {
      if (!this.current(task)) continue;
      const block = task.block;
      // Hold results while changed text settles; a temporary edit may revert to this exact source.
      if (!checkedSources.has(block))
        checkedSources.set(
          block,
          extractSource(block.element, this.isOwned)?.signature,
        );
      if (checkedSources.get(block) !== block.source.signature) {
        block.view?.remove();
        block.view = undefined;
        this.scheduleScan(block.element, false);
      }
      const result = translations.get(task.segment.id);
      const text =
        result &&
        result.revision === task.segment.revision &&
        preservesCodeTokens(task.segment.text, result.text)
          ? restoreCode(result.text, block.source.codes)
          : undefined;
      if (reply.ok && !invalid && text !== undefined) {
        task.state = "translated";
        task.text = text;
        task.error = undefined;
        manualSucceeded ||= task.manual;
      } else {
        task.state = "failed";
        task.error = reply.ok ? INVALID_RESPONSE : reply.error;
      }
      changed.add(block);
    }
    if (!reply.ok && BLOCKING_ERRORS[reply.error.code]) {
      this.blocked = reply.error;
      for (const task of this.queue) {
        if (task.manual) continue;
        this.queue.delete(task);
        task.state = "failed";
        task.error = reply.error;
        changed.add(task.block);
      }
    } else if (manualSucceeded) this.blocked = undefined;
    for (const block of changed) this.render(block);
    this.schedulePump();
    this.publish();
  }

  private render(block: Block): void {
    if (!this.active || block.dirty || !block.element.isConnected) return;
    const hasChangedText = block.tasks.some(
      (task) =>
        task.state === "translated" &&
        task.text !== restoreCode(task.segment.text, block.source.codes),
    );
    const parts = block.tasks.map((task) => ({
      id: task.segment.id,
      text:
        !(this.displayMode === "translation" && hasChangedText) &&
        task.text === restoreCode(task.segment.text, block.source.codes)
          ? undefined
          : task.text,
      error: task.error,
      pending: task.state === "queued" || task.state === "pending",
    }));
    if (
      !parts.some(
        (part) => part.text !== undefined || part.error || part.pending,
      )
    ) {
      block.view?.remove();
      block.view = undefined;
      return;
    }
    if (!block.view?.host.isConnected) {
      block.view?.remove();
      block.view = createTranslationView(
        block.element,
        this.language,
        (node) => {
          this.owned.add(node);
          this.viewOwners.set(node, block);
        },
        this.displayMode,
        () => block.source.nodes,
      );
    }
    block.view.update(parts, (id) => {
      const task = block.tasks.find((candidate) => candidate.segment.id === id);
      if (
        !task ||
        !this.current(task) ||
        task.state !== "failed" ||
        block.dirty
      )
        return;
      if (
        extractSource(block.element, this.isOwned)?.signature !==
        block.source.signature
      ) {
        block.view?.remove();
        block.view = undefined;
        this.scheduleScan(block.element, false);
        return;
      }
      task.state = "queued";
      task.error = undefined;
      task.manual = true;
      this.queue.add(task);
      this.render(block);
      this.schedulePump();
      this.publish();
    });
  }

  private progress(): PageProgress {
    let translated = 0;
    let pending = 0;
    let failed = 0;
    for (const block of this.blocks.values())
      for (const task of block.tasks) {
        if (task.state === "translated") translated += 1;
        else if (task.state === "failed") failed += 1;
        else pending += 1;
      }
    const phase = !this.active
      ? "off"
      : pending > 0 || this.dirty.size > 0
        ? "running"
        : this.blocked
          ? "blocked"
          : failed > 0
            ? "partial"
            : "waiting";
    return {
      sessionId: this.id,
      phase,
      translated,
      pending,
      failed,
      message:
        this.blocked?.message ??
        (failed
          ? `有 ${failed} 段未完成，可在原文下方手动重试。`
          : phase === "waiting"
            ? "已处理当前内容，等待页面新增或展开正文。"
            : undefined),
    };
  }

  private publish(immediate = false): void {
    if (!this.active || (!immediate && this.progressTimer !== undefined))
      return;
    const publish = (): void => {
      this.progressTimer = undefined;
      if (!this.active) return;
      const progress = this.progress();
      const fingerprint = JSON.stringify(progress);
      if (fingerprint === this.lastProgress) return;
      this.lastProgress = fingerprint;
      void sendMessage<void>({ type: "page:progress", progress });
    };
    if (immediate) publish();
    else this.progressTimer = window.setTimeout(publish, 100);
  }
}

function isPageMessage(value: unknown): value is PageMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  if (value.type === "page:ping") return true;
  if (value.type === "page:stop")
    return (
      (!("sessionId" in value) || typeof value.sessionId === "string") &&
      (!("reason" in value) || typeof value.reason === "string")
    );
  return (
    value.type === "page:start" &&
    "sessionId" in value &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    value.sessionId.length <= 160 &&
    "targetLanguage" in value &&
    typeof value.targetLanguage === "string" &&
    LANGUAGES.some((language) => language.value === value.targetLanguage) &&
    "displayMode" in value &&
    (value.displayMode === "bilingual" || value.displayMode === "translation")
  );
}

export function installContentController(): void {
  let session: PageSession | undefined;
  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab ||
      !isPageMessage(message)
    )
      return false;
    if (message.type === "page:start" && session?.id !== message.sessionId) {
      session?.stop("已开始新的翻译会话。");
      session = new PageSession(
        message.sessionId,
        message.targetLanguage,
        message.displayMode,
        (ended) => {
          if (session === ended) session = undefined;
        },
      );
    } else if (
      message.type === "page:stop" &&
      (!message.sessionId || message.sessionId === session?.id)
    ) {
      session?.stop(message.reason ?? "用户停止翻译。");
    }
    const reply: Reply<PageSnapshot> = {
      ok: true,
      value: session?.snapshot() ?? { active: false },
    };
    respond(reply);
    return false;
  });
}
