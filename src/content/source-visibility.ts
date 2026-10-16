interface TextSource {
  original: string;
}

const hiddenTexts = new WeakMap<Text, TextSource>();
let observing = false;
let ownChanges = new WeakMap<Node, number>();

export function observeSourceChanges(active: boolean): void {
  observing = active;
  if (!active) ownChanges = new WeakMap();
}

function change(node: Text, text: string): void {
  if (observing && node.isConnected)
    ownChanges.set(node, (ownChanges.get(node) ?? 0) + 1);
  node.data = text;
}

/** Filter our writes without ignoring later website edits to the same text. */
export function consumeSourceMutation(record: MutationRecord): boolean {
  if (record.type !== "characterData" || !(record.target instanceof Text))
    return false;
  const count = ownChanges.get(record.target) ?? 0;
  if (count > 0) {
    if (count === 1) ownChanges.delete(record.target);
    else ownChanges.set(record.target, count - 1);
    return true;
  }
  hiddenTexts.delete(record.target);
  return false;
}

function* textNodes(node: Node): Generator<Text> {
  if (node instanceof Text) {
    yield node;
    return;
  }
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let child: Node | null;
  while ((child = walker.nextNode())) yield child as Text;
}

export function readSourceText(node: Node): string {
  if (node instanceof Text)
    return node.data === "" ? (hiddenTexts.get(node)?.original ?? "") : node.data;
  let text = "";
  for (const child of textNodes(node)) text += readSourceText(child);
  return text;
}

/** Our blank text can collapse an inline box without making its source invalid. */
export function containsHiddenSource(element: Element): boolean {
  for (const node of textNodes(element))
    if (hiddenTexts.has(node)) return true;
  return false;
}

/** Keep node identity, parentage, element styles and website accessibility intact. */
export function createSourceVisibility(readNodes: () => readonly Node[]) {
  const texts = new Map<Text, TextSource>();
  const restoreText = (node: Text, state: TextSource): void => {
    if (hiddenTexts.get(node) === state) {
      hiddenTexts.delete(node);
      if (node.data === "") change(node, state.original);
    }
    texts.delete(node);
  };
  return {
    hide(): void {
      const nodes = new Set<Text>();
      for (const source of readNodes())
        for (const node of textNodes(source)) nodes.add(node);
      for (const [node, state] of texts)
        if (!nodes.has(node)) restoreText(node, state);
      for (const node of nodes) {
        if (texts.has(node) && hiddenTexts.get(node) === texts.get(node)) continue;
        const original = readSourceText(node);
        if (original === "") continue;
        // A website may move a hidden node from another translated block.
        // A new owner token prevents that old view from restoring it later.
        const state = { original };
        texts.set(node, state);
        hiddenTexts.set(node, state);
        if (node.data !== "") change(node, "");
      }
    },
    restore(): void {
      for (const [node, state] of texts) restoreText(node, state);
    },
  };
}
