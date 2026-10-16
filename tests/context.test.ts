import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, type Segment } from "../src/shared";
import { prepareRequest } from "../src/background/provider";
import { contextExcerpt } from "../src/content/context";

function segment(id: string, text: string, context = ""): Segment {
  return { id, revision: 1, text, context };
}

function payload(
  segments: Segment[],
  related = segments,
): {
  items: { id: string; text: string }[];
  context: string[];
} {
  const request = prepareRequest(DEFAULT_SETTINGS, segments, related);
  const body = JSON.parse(request.body);
  return JSON.parse(body.messages[1].content);
}

function occurrences(text: string, source: string): number {
  return text.split(source).length - 1;
}

function assertWholeTokens(text: string): void {
  const withoutTokens = text.replace(/⟦JT_CODE_\d+⟧/g, "");
  assert.ok(!withoutTokens.includes("⟦"));
  assert.ok(!withoutTokens.includes("⟧"));
  assert.ok(!withoutTokens.includes("JT_CODE_"));
}

test("related items share one copy of neighboring context", () => {
  const source = "Maya founded the laboratory.";
  const first = segment("first", "She hired two researchers.", source);
  const second = segment("second", "They studied the samples.", source);
  const result = payload([first, second]);
  assert.equal(occurrences(result.context.join(""), source), 1);
});

test("cache hits supply adjacent context without requesting their translation again", () => {
  const distant = segment("distant", "Distant passage is not a neighbor.");
  const before = segment("before", "Maya founded the laboratory.");
  const current = segment("current", "She hired two researchers.");
  const after = segment("after", "They studied the samples.");
  const result = payload([current], [distant, before, current, after]);
  const context = result.context.join("");
  assert.equal(occurrences(context, before.text), 1);
  assert.equal(occurrences(context, after.text), 1);
  assert.ok(!context.includes(distant.text));
  assert.ok(
    result.items.every((item) => item.id !== before.id && item.id !== after.id),
  );
});

test("explicit and sparse cached neighbors share one bounded context budget", () => {
  const explicit = "EXPLICIT ".repeat(130);
  const first = segment("first", "First passage.", explicit);
  const second = segment("second", "Second passage.", explicit);
  const third = segment("third", "Third passage.", explicit);
  const before = segment("before", "PRECEDING ".repeat(240));
  const middle = segment("middle", "MIDDLE ".repeat(340));
  const after = segment("after", "FOLLOWING ".repeat(240));
  const result = payload(
    [first, second, third],
    [before, first, middle, second, after, third],
  );
  const context = result.context.join("");
  assert.ok(context.length <= 1200);
  for (const marker of ["EXPLICIT", "PRECEDING", "MIDDLE", "FOLLOWING"])
    assert.ok(context.includes(marker));
  assert.ok(!context.includes(before.text));
  assert.ok(!context.includes(after.text));
});

test("context excludes requested source and deduplicates shared cache neighbors", () => {
  const first = segment("first", "She hired two researchers.");
  const cached = segment("cached", "The laboratory is in Paris.");
  const last = segment("last", "They studied the samples.");
  const duplicate = segment("duplicate", first.text);
  const result = payload([first, last], [duplicate, first, cached, last]);
  const context = result.context.join("");
  assert.equal(occurrences(context, cached.text), 1);
  assert.ok(!context.includes(first.text));
  assert.ok(!result.items.some((item) => item.id === cached.id));
});

test("structured hints retain their requested-item anchor after cache filtering", () => {
  const source = "The following reference belongs to the second passage.";
  const hints = JSON.stringify([
    { itemIndex: 1, position: "before", text: source },
  ]);
  const cached = segment("cached", "Earlier passage.", hints);
  const current = segment("current", "This is its result.", hints);
  const result = payload([current], [cached, current]);
  const anchored = result.context.find((hint) => hint.includes(source));
  assert.ok(anchored?.includes("[0]"));
  assert.ok(!anchored?.includes("[1]"));
  assert.equal(occurrences(result.context.join(""), source), 1);
});

test("source and provider context clipping leave inline-code tokens whole", () => {
  for (const text of [
    `${"a".repeat(495)}⟦JT_CODE_12⟧${"z".repeat(20)}`,
    `${"a".repeat(20)}⟦JT_CODE_99⟧${"z".repeat(495)}`,
  ]) {
    for (const end of [false, true]) {
      for (const limit of [1, 7, 64, 500]) {
        const excerpt = contextExcerpt(text, limit, end);
        assert.ok(excerpt.length <= limit);
        assertWholeTokens(excerpt);
      }
    }
    const current = segment("current", "Keep its meaning unchanged.");
    const neighbor = segment("neighbor", text);
    for (const related of [
      [neighbor, current],
      [current, neighbor],
    ]) {
      const context = payload([current], related).context.join("");
      assert.ok(context.length <= 1200);
      assertWholeTokens(context);
    }
  }
});
