import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { DEFAULT_SETTINGS, type Segment } from "../src/shared";
import { RequestError } from "../src/background/errors";
import { prepareRequest, requestTranslation } from "../src/background/provider";

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
before(() =>
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { permissions: { contains: async () => true } },
  }),
);
after(() => {
  if (originalChrome)
    Object.defineProperty(globalThis, "chrome", originalChrome);
  else Reflect.deleteProperty(globalThis, "chrome");
});
const segments: Segment[] = [
  {
    id: "paragraph-a",
    revision: 2,
    text: "Keep ⟦JT_CODE_0⟧ unchanged.",
    context: "",
  },
];

function providerResponse(content: string, finishReason = "stop"): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 120, completion_tokens: 80 },
    }),
    { status: 200 },
  );
}

test("a valid JSON object cannot silently assign another paragraph or lose protected code", async (t) => {
  const payloads = [
    { items: [{ id: "another-paragraph", translation: "保留 ⟦JT_CODE_0⟧。" }] },
    { items: [{ id: "paragraph-a", translation: "模型删除了代码。" }] },
    { items: [] },
  ];
  for (const payload of payloads) {
    const replacement = t.mock.method(globalThis, "fetch", async () =>
      providerResponse(JSON.stringify(payload)),
    );
    await assert.rejects(
      requestTranslation(
        DEFAULT_SETTINGS,
        "test-key",
        prepareRequest(DEFAULT_SETTINGS, segments),
        new AbortController().signal,
        async () => {},
      ),
      (error: unknown) =>
        error instanceof RequestError &&
        error.detail.code === "invalid_response" &&
        error.usage?.inputTokens === 120,
    );
    replacement.mock.restore();
  }
});

test("truncated responses are rejected but their reported usage is retained", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    providerResponse('{"items":', "length"),
  );
  await assert.rejects(
    requestTranslation(
      DEFAULT_SETTINGS,
      "test-key",
      prepareRequest(DEFAULT_SETTINGS, segments),
      new AbortController().signal,
      async () => {},
    ),
    (error: unknown) =>
      error instanceof RequestError &&
      error.detail.code === "invalid_response" &&
      error.usage?.outputTokens === 80,
  );
});

test("explicit rate limiting has a bounded retry, not an infinite request loop", async (t) => {
  let dispatches = 0;
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("{}", { status: 429, headers: { "Retry-After": "0" } }),
  );
  await assert.rejects(
    requestTranslation(
      DEFAULT_SETTINGS,
      "test-key",
      prepareRequest(DEFAULT_SETTINGS, segments),
      new AbortController().signal,
      async () => {
        dispatches++;
      },
    ),
    (error: unknown) =>
      error instanceof RequestError &&
      error.detail.code === "rate_limit" &&
      !error.detail.uncertain,
  );
  assert.equal(fetchMock.mock.callCount(), 2);
  assert.equal(dispatches, 2);
});

test("ambiguous server failures do not automatically create a second billable request", async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response('{"error":{"message":"private upstream details"}}', {
        status: 502,
      }),
  );
  await assert.rejects(
    requestTranslation(
      DEFAULT_SETTINGS,
      "test-key",
      prepareRequest(DEFAULT_SETTINGS, segments),
      new AbortController().signal,
      async () => {},
    ),
    (error: unknown) =>
      error instanceof RequestError &&
      error.detail.uncertain === true &&
      !error.message.includes("private upstream"),
  );
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("cancellation before dispatch sends nothing to the model", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    providerResponse("{}"),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    requestTranslation(
      DEFAULT_SETTINGS,
      "test-key",
      prepareRequest(DEFAULT_SETTINGS, segments),
      controller.signal,
      async () => {},
    ),
    (error: unknown) =>
      error instanceof RequestError && error.detail.code === "cancelled",
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});
