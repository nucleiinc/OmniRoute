import test from "node:test";
import assert from "node:assert/strict";

import { createSSEStream } from "../../open-sse/utils/stream.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

/**
 * Regression: cursor tool calls never reached the call log.
 *
 * CursorExecutor already emits OpenAI-shaped chunks, so its response translator
 * is a pure passthrough registered with a `null` state initializer
 * (open-sse/translator/response/cursor-to-openai.ts). Nothing ever populates
 * `state.toolCalls`, which the translate branch of flush() used as its only
 * tool-call source when synthesizing the call-log responseBody. A tool-calling
 * turn was therefore persisted as `finish_reason: "stop"` with no tool_calls,
 * even though the client received the tool calls over the wire.
 *
 * Measured impact before the fix: 0 of 542 streamed cursor responses logged a
 * tool call over two days, against ~94% for every other provider, which made
 * cursor impossible to debug from call logs and produced a false "cursor cannot
 * call tools" reading.
 */

type ReconstructedBody = {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{
        id: string | null;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
};

async function runCursorStream(chunks: Record<string, unknown>[]) {
  let responseBody: unknown;
  const transform = createSSEStream({
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.CURSOR,
    model: "composer-2.5",
    onComplete: (result) => {
      responseBody = result.responseBody;
    },
  }) as TransformStream<Uint8Array, Uint8Array>;

  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const encoder = new TextEncoder();
  const drain = (async () => {
    while (!(await reader.read()).done) {}
  })();

  for (const chunk of chunks) {
    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  }
  await writer.write(encoder.encode("data: [DONE]\n\n"));
  await writer.close();
  await drain;

  return responseBody as ReconstructedBody;
}

function cursorChunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: "chatcmpl-keepalive",
    object: "chat.completion.chunk",
    created: 1789314609,
    model: "composer-2.5",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

test("cursor streamed tool calls reach the reconstructed call-log body", async () => {
  const body = await runCursorStream([
    cursorChunk({ role: "assistant", content: "" }),
    cursorChunk({ content: "Fixing hit testing: switching to .position() and Button." }),
    cursorChunk({
      tool_calls: [
        {
          index: 0,
          id: "call_mtzzopmx",
          type: "function",
          function: { name: "edit", arguments: "" },
        },
      ],
    }),
    cursorChunk({
      tool_calls: [{ index: 0, function: { arguments: '{"path":"/tmp/PitchReference.swift"}' } }],
    }),
    cursorChunk({}, "tool_calls"),
  ]);

  const choice = body.choices[0];
  assert.equal(choice.finish_reason, "tool_calls", "logged finish_reason must not be 'stop'");
  assert.ok(choice.message.tool_calls, "logged message must carry tool_calls");
  assert.equal(choice.message.tool_calls?.length, 1);
  assert.equal(choice.message.tool_calls?.[0].function.name, "edit");
  assert.equal(
    choice.message.tool_calls?.[0].function.arguments,
    '{"path":"/tmp/PitchReference.swift"}',
    "fragmented argument deltas must be joined in the log"
  );
  assert.equal(choice.message.tool_calls?.[0].id, "call_mtzzopmx");
});

test("cursor parallel tool calls are all logged, in index order", async () => {
  const body = await runCursorStream([
    cursorChunk({ role: "assistant", content: "" }),
    cursorChunk({
      tool_calls: [
        { index: 0, id: "call_a", type: "function", function: { name: "read", arguments: "{}" } },
      ],
    }),
    cursorChunk({
      tool_calls: [
        { index: 1, id: "call_b", type: "function", function: { name: "grep", arguments: "{}" } },
      ],
    }),
    cursorChunk({}, "tool_calls"),
  ]);

  const names = body.choices[0].message.tool_calls?.map((tc) => tc.function.name);
  assert.deepEqual(names, ["read", "grep"]);
  assert.equal(body.choices[0].finish_reason, "tool_calls");
});

test("a genuine text-only cursor turn still logs finish_reason stop", async () => {
  const body = await runCursorStream([
    cursorChunk({ role: "assistant", content: "" }),
    cursorChunk({ content: "The keys already respond to clicks; nothing to change." }),
    cursorChunk({}, "stop"),
  ]);

  const choice = body.choices[0];
  assert.equal(choice.finish_reason, "stop", "no tool call means the log must still say stop");
  assert.equal(choice.message.tool_calls, undefined, "must not invent tool_calls");
  assert.match(String(choice.message.content), /already respond to clicks/);
});
