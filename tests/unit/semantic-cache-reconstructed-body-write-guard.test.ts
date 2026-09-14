// A reconstructed response body must never be written to the semantic cache when it carries tool
// calls. Both cache stores synthesize/reassemble their body from stream deltas rather than from
// anything the provider sent whole, and that second accumulator can disagree with the client's:
// streamPayloadCollector.ts:296 seeds a missing function name with the literal "unknown" and the
// backfill at :310 only replaces an EMPTY name, so "unknown" (truthy) survives; sseParser.ts:237
// has the same defect on the non-streaming reassembly path. A cache HIT serves the stored body
// verbatim (jsonToSse.ts:113-115 re-emits tool_calls unvalidated), so a poisoned name would reach
// a client that has no such tool — a hard failure, not something it can ignore.
//
// Locks: the streaming store refuses a tool-bearing body and still caches plain text (the request
// declaring `tools` is irrelevant — only a tool call in the RESPONSE is refused), and the
// non-streaming store refuses a body reassembled from an upstream event stream.
import test from "node:test";
import assert from "node:assert/strict";

const { storeStreamingSemanticCacheResponse } =
  await import("../../open-sse/handlers/chatCore/streamingSemanticCacheStore.ts");
const { storeSemanticCacheResponse } =
  await import("../../open-sse/handlers/chatCore/semanticCacheStore.ts");

type Stored = { model: string; body: unknown };

function makeStreamingDeps() {
  const stored: Stored[] = [];
  const deps = {
    isCacheableForWrite: () => true,
    isSmallEnoughForSemanticCache: () => true,
    generateSignature: () => "sig",
    setCachedResponse: (_sig: unknown, model: string, body: unknown) =>
      stored.push({ model, body }),
  } as Parameters<typeof storeStreamingSemanticCacheResponse>[1];
  return { deps, stored };
}

function makeNonStreamingDeps() {
  const stored: Stored[] = [];
  const deps = {
    isCacheableForWrite: () => true,
    isSmallEnoughForSemanticCache: () => true,
    generateSignature: () => "sig",
    setCachedResponse: (_sig: unknown, model: string, body: unknown) =>
      stored.push({ model, body }),
  } as Parameters<typeof storeSemanticCacheResponse>[1];
  return { deps, stored };
}

function streamingArgs(
  streamResponseBody: Record<string, unknown>,
  bodyOverrides: Record<string, unknown> = {}
) {
  return {
    enabled: true,
    streamStatus: 200,
    streamResponseBody,
    body: {
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      top_p: 1,
      ...bodyOverrides,
    },
    headers: undefined,
    model: "gpt-x",
    apiKeyId: "key-1",
    streamUsage: { prompt_tokens: 4, completion_tokens: 2 },
    log: undefined,
  } as Parameters<typeof storeStreamingSemanticCacheResponse>[0];
}

function textBody() {
  return {
    choices: [{ message: { role: "assistant", content: "4" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    _streamed: true,
  };
}

function toolCallBody(name: string) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_abc", index: 0, type: "function", function: { name, arguments: "{}" } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    _streamed: true,
  };
}

test("streaming: a reconstructed body with a poisoned tool-call name is NOT cached", () => {
  const { deps, stored } = makeStreamingDeps();
  storeStreamingSemanticCacheResponse(streamingArgs(toolCallBody("unknown")), deps);
  assert.deepEqual(stored, [], "a tool-bearing reconstruction must never reach the cache");
});

test("streaming: a well-named tool call is refused too (the name is not trustworthy here)", () => {
  const { deps, stored } = makeStreamingDeps();
  storeStreamingSemanticCacheResponse(streamingArgs(toolCallBody("edit")), deps);
  assert.deepEqual(stored, [], "the guard keys on the presence of tool calls, not on the name");
});

test("streaming: a plain text response is still cached", () => {
  const { deps, stored } = makeStreamingDeps();
  storeStreamingSemanticCacheResponse(streamingArgs(textBody()), deps);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].model, "gpt-x");
  assert.equal("_streamed" in (stored[0].body as Record<string, unknown>), false);
});

test("streaming: a request declaring tools still caches a text response", () => {
  const { deps, stored } = makeStreamingDeps();
  storeStreamingSemanticCacheResponse(
    streamingArgs(textBody(), {
      tools: [{ type: "function", function: { name: "edit" } }],
      tool_choice: "auto",
    }),
    deps
  );
  assert.equal(stored.length, 1, "only a tool call in the RESPONSE is refused");
});

test("streaming: an empty tool_calls array is not treated as a tool-bearing body", () => {
  const { deps, stored } = makeStreamingDeps();
  const body = {
    choices: [
      { message: { role: "assistant", content: "4", tool_calls: [] }, finish_reason: "stop" },
    ],
    _streamed: true,
  };
  storeStreamingSemanticCacheResponse(streamingArgs(body), deps);
  assert.equal(stored.length, 1);
});

test("streaming: a tool call on a later choice is still refused", () => {
  const { deps, stored } = makeStreamingDeps();
  const body = {
    choices: [
      { message: { role: "assistant", content: "4" }, finish_reason: "stop" },
      toolCallBody("unknown").choices[0],
    ],
    _streamed: true,
  };
  storeStreamingSemanticCacheResponse(streamingArgs(body), deps);
  assert.deepEqual(stored, [], "every choice must be inspected, not just the first");
});

test("non-streaming: a body reassembled from an upstream event stream is NOT cached", () => {
  const { deps, stored } = makeNonStreamingDeps();
  storeSemanticCacheResponse(
    {
      enabled: true,
      body: { messages: [{ role: "user", content: "hi" }], temperature: 0 },
      headers: undefined,
      translatedResponse: toolCallBody("unknown"),
      reconstructedFromEventStream: true,
      model: "gpt-x",
    },
    deps
  );
  assert.deepEqual(stored, [], "an SSE reassembly carries the same accumulator defect");
});

test("non-streaming: a body parsed from real provider JSON is still cached", () => {
  const { deps, stored } = makeNonStreamingDeps();
  storeSemanticCacheResponse(
    {
      enabled: true,
      body: { messages: [{ role: "user", content: "hi" }], temperature: 0 },
      headers: undefined,
      translatedResponse: toolCallBody("edit"),
      reconstructedFromEventStream: false,
      model: "gpt-x",
    },
    deps
  );
  assert.equal(stored.length, 1, "a whole JSON provider body is not a reconstruction");
});
