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

test("the recorded DeepSeek text-field translation is accepted by the uniform wire contract", async (t) => {
  const id = "6a68f00a-5a76-482d-9fd2-229f1eab0906:0";
  const source =
    "You felt like school was a waste of time. Maybe you went to college, but you felt like choosing something to study for 4 years was death to your curiosity (I switched majors 5 times I believe... and didn’t graduate after 5 years and tens of thousands in student debt.)";
  const text =
    "你上学时就觉得是在浪费时间。也许你上了大学，但你觉得花4年选一个专业来学，简直是对你好奇心的扼杀（我记得我换了5次专业……而且读了5年还没毕业，还背上了数万美元的学生贷款。）";
  const sources = [{ id, revision: 1, text: source, context: "" }];
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    providerResponse(JSON.stringify({ items: [{ id, text }] })),
  );
  const result = await requestTranslation(
    DEFAULT_SETTINGS,
    "test-key",
    prepareRequest(DEFAULT_SETTINGS, sources),
    new AbortController().signal,
    async () => {},
  );
  assert.deepEqual(result.items, [{ id, translation: text }]);
  assert.equal(result.estimated, false);
  assert.equal(result.inputTokens, 120);
  assert.equal(result.outputTokens, 80);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("valid reordered translations preserve original IDs and each item's repeated code tokens", async (t) => {
  const sources: Segment[] = [
    {
      id: "1ce15101-e676-45b6-a755-43abcf9fbc0d:0",
      revision: 2,
      text: "Keep ⟦JT_CODE_0⟧ unchanged.",
      context: "",
    },
    {
      id: "1ce15101-e676-45b6-a755-43abcf9fbc0d:1",
      revision: 2,
      text: "Compare ⟦JT_CODE_1⟧ with ⟦JT_CODE_1⟧.",
      context: "",
    },
  ];
  const request = prepareRequest(DEFAULT_SETTINGS, sources);
  const input = JSON.parse(JSON.parse(request.body).messages[1].content);
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    providerResponse(
      JSON.stringify({
        items: [
          {
            id: input.items[1].id,
            text: " 比较 ⟦JT_CODE_1⟧ 与 ⟦JT_CODE_1⟧。 ",
          },
          { id: input.items[0].id, text: " 保留 ⟦JT_CODE_0⟧。 " },
        ],
      }),
    ),
  );
  const result = await requestTranslation(
    DEFAULT_SETTINGS,
    "test-key",
    request,
    new AbortController().signal,
    async () => {},
  );
  assert.deepEqual(result, {
    items: [
      {
        id: sources[1]!.id,
        translation: "比较 ⟦JT_CODE_1⟧ 与 ⟦JT_CODE_1⟧。",
      },
      { id: sources[0]!.id, translation: "保留 ⟦JT_CODE_0⟧。" },
    ],
    inputTokens: 120,
    outputTokens: 80,
    estimated: false,
  });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("malformed batches retain usage without retrying", async (t) => {
  const sources: Segment[] = [
    ...segments,
    {
      id: "paragraph-b",
      revision: 3,
      text: "Use ⟦JT_CODE_1⟧ twice: ⟦JT_CODE_1⟧.",
      context: "",
    },
  ];
  const request = prepareRequest(DEFAULT_SETTINGS, sources);
  const input = JSON.parse(JSON.parse(request.body).messages[1].content);
  const first = { id: input.items[0].id, text: "保留 ⟦JT_CODE_0⟧。" };
  const second = {
    id: input.items[1].id,
    text: "使用 ⟦JT_CODE_1⟧ 两次：⟦JT_CODE_1⟧。",
  };
  const malformed = [
    [first],
    [first, first],
    [first, { ...second, id: "unknown-paragraph" }],
    [first, { ...second, id: 1 }],
    [first, { ...second, text: null }],
    [first, { ...second, text: " \n\t " }],
    [first, { ...second, translation: second.text }],
    [first, { id: second.id, translation: second.text }],
    [first, { ...second, text: "使用 ⟦JT_CODE_1⟧。" }],
    [first, { ...second, text: "使用 ⟦JT_CODE_0⟧ 两次：⟦JT_CODE_0⟧。" }],
    [
      { ...first, text: second.text },
      { ...second, text: first.text },
    ],
    [
      { ...first, text: "保留 ⟦JT_CODE_0⟧ 和 ⟦JT_CODE_0⟧。" },
      second,
    ],
  ];
  for (const items of malformed) {
    let dispatches = 0;
    const fetchMock = t.mock.method(globalThis, "fetch", async () =>
      providerResponse(JSON.stringify({ items })),
    );
    await assert.rejects(
      requestTranslation(
        DEFAULT_SETTINGS,
        "test-key",
        request,
        new AbortController().signal,
        async () => {
          dispatches++;
        },
      ),
      (error: unknown) =>
        error instanceof RequestError &&
        error.detail.code === "invalid_response" &&
        error.dispatched === true &&
        error.usage?.inputTokens === 120 &&
        error.usage?.outputTokens === 80 &&
        error.usage?.estimated === false,
    );
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(dispatches, 1);
    fetchMock.mock.restore();
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
