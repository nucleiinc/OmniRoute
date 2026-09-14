import test from "node:test";
import assert from "node:assert/strict";
import {
  newStreamCtx,
  noteSuppressedUpstreamError,
  processFrame,
  type StreamCtx,
} from "../../open-sse/executors/cursor.ts";
import { classifyCursorError } from "../../open-sse/executors/cursor/cursorErrors.ts";
import { sanitizeErrorMessage } from "../../open-sse/utils/error.ts";

/**
 * Observability regression: cursor's three "swallow the upstream error because
 * text already streamed" branches logged nothing at all.
 *
 * open-sse/executors/cursor.ts discards an already-classified upstream error
 * whenever `ctx.totalText.length > 0` — in processFrame's JSON error envelope
 * branch, and in execute()'s two benign-cancel branches (streaming and
 * buffered). finalizeSseStream then finds `midStreamError` null and emits an
 * ordinary `stop`, so a rate limit or a resource limit arriving mid-turn was
 * indistinguishable from the model simply finishing. None of the three branches
 * carried a debugLog, so even CURSOR_DEBUG=1 printed nothing, and the call log
 * recorded a clean 200.
 *
 * These tests pin the diagnostic, NOT a behaviour change. The termination
 * contract asserted by tests/unit/cursor-streaming.test.ts ("no error overlay
 * when text already streamed") must stay exactly as it was; the assertions
 * below re-check it alongside the new record so a future edit cannot turn this
 * observability hook into an emission change.
 */

// AgentServerMessage { interaction_update (1): { text_delta (1): { text (1): str } } }
// Mirrors the wire-format helpers in cursor-streaming.test.ts.
function v(n: number): Buffer {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

function tag(field: number, wireType: number): Buffer {
  return v((field << 3) | wireType);
}

function lenPrefixed(field: number, payload: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), v(payload.length), payload]);
}

function buildTextDeltaPayload(text: string): Buffer {
  const tdu = lenPrefixed(1, Buffer.from(text, "utf8"));
  const iu = lenPrefixed(1, tdu);
  return lenPrefixed(1, iu);
}

function buildJsonErrorPayload(message = "rate limited", code = "resource_exhausted"): Buffer {
  return Buffer.from(JSON.stringify({ error: { message, code } }), "utf8");
}

/** Run `fn` with console.warn captured, returning every warning it emitted. */
function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test("a fresh StreamCtx records no suppressed errors", () => {
  const ctx = newStreamCtx("composer-2.5", () => {});
  assert.deepEqual(ctx.suppressedErrors, []);
});

test("JSON error after text is recorded on ctx with diagnostic detail", () => {
  const ctx = newStreamCtx("composer-2.5", () => {});
  const warnings = captureWarnings(() => {
    processFrame(
      buildTextDeltaPayload("Fixing hit testing: switching to .position()."),
      ctx,
      new Set()
    );
    processFrame(buildJsonErrorPayload(), ctx, new Set());
  });

  assert.equal(ctx.suppressedErrors.length, 1, "the discarded error must be recorded");
  const entry = ctx.suppressedErrors[0];
  assert.equal(entry.stage, "json_error_frame");
  assert.equal(entry.endReason, "server_end", "records the endReason actually being set");
  assert.equal(
    entry.emittedTextLength,
    "Fixing hit testing: switching to .position().".length,
    "records how much text had already been emitted — the reason it was dropped"
  );
  assert.equal(entry.emittedToolCalls, 0);
  assert.equal(typeof entry.status, "number");
  assert.ok(entry.status >= 400, `expected a client-visible failure status, got ${entry.status}`);
  // classifyCursorError rewrites resource_exhausted into a secret-safe phrase;
  // the recorded message must be that classified form, never the raw payload.
  assert.match(entry.message, /rate limit/i);
  assert.doesNotMatch(entry.message, /resource_exhausted/);

  assert.equal(warnings.length, 1, "the swallow must warn without CURSOR_DEBUG");
  assert.match(warnings[0], /\[CURSOR\] upstream error suppressed/);
  assert.match(warnings[0], /stage=json_error_frame/);
  assert.match(warnings[0], /emittedTextChars=45/);
});

test("recording the discard does not change the termination contract", () => {
  const ctx = newStreamCtx("composer-2.5", () => {});
  captureWarnings(() => {
    processFrame(buildTextDeltaPayload("partial"), ctx, new Set());
    processFrame(buildJsonErrorPayload(), ctx, new Set());
  });

  // Identical to the assertions in cursor-streaming.test.ts — the diagnostic
  // must not promote the error or disturb the streamed text.
  assert.equal(ctx.endReason, "server_end");
  assert.equal(ctx.midStreamError, null, "no error overlay when text already streamed");
  assert.equal(ctx.totalText, "partial");
});

test("JSON error before any text is surfaced, not suppressed", () => {
  const ctx = newStreamCtx("composer-2.5", () => {});
  const warnings = captureWarnings(() => {
    processFrame(buildJsonErrorPayload(), ctx, new Set());
  });

  assert.ok(ctx.midStreamError, "with no text emitted the error reaches the client");
  assert.equal(ctx.endReason, "server_end");
  assert.deepEqual(ctx.suppressedErrors, [], "a surfaced error is not a suppressed one");
  assert.deepEqual(warnings, [], "nothing was swallowed, so nothing to warn about");
});

// Obviously fake, and never asserted on positively in the recorded output — the
// assertions below check for the redaction marker and for the token's ABSENCE.
const FAKE_TOKEN = "sk-NOT-A-REAL-TOKEN-0000000000";

for (const { label, raw, redacted } of [
  {
    label: "Authorization: Bearer",
    raw: `upstream rejected: Authorization: Bearer ${FAKE_TOKEN}`,
    redacted: "Authorization: [REDACTED]",
  },
  {
    label: "api_key= assignment",
    raw: `upstream rejected: api_key=${FAKE_TOKEN}`,
    redacted: "api_key=[REDACTED]",
  },
]) {
  test(`a credential in an upstream error (${label}) is redacted before it is recorded`, () => {
    // Guard the guard: classifyCursorError alone passes the credential through
    // verbatim, so without sanitizeErrorMessage in noteSuppressedUpstreamError
    // the secret reaches the record, the console interceptor's disk log, and the
    // authenticated console-log API. If this assertion ever fails, the upstream
    // sanitizer changed and the test below stopped proving anything.
    assert.ok(
      classifyCursorError(raw).message.includes(FAKE_TOKEN),
      "classifyCursorError is expected NOT to strip ordinary credentials"
    );

    const ctx = newStreamCtx("composer-2.5", () => {});
    const warnings = captureWarnings(() => {
      processFrame(buildTextDeltaPayload("narration"), ctx, new Set());
      processFrame(buildJsonErrorPayload(raw, "unavailable"), ctx, new Set());
    });

    assert.equal(ctx.suppressedErrors.length, 1, "the discard must still be recorded");
    const recorded = ctx.suppressedErrors[0].message;
    assert.ok(!recorded.includes(FAKE_TOKEN), `credential leaked into the record: ${recorded}`);
    assert.ok(recorded.includes(redacted), `expected ${redacted} in the record, got: ${recorded}`);

    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes(FAKE_TOKEN), "credential leaked into the warning");
    assert.ok(warnings[0].includes(redacted), "the warning must carry the redacted form");
  });
}

// A URL can smuggle a credential in more shapes than sanitizeErrorMessage
// enumerates, so noteSuppressedUpstreamError drops whole URLs before sanitizing.
// Every value below is obviously fake and none is asserted on positively.
for (const { label, raw, secret, defeatsSanitizerAlone } of [
  {
    label: "query-string credential",
    raw: "upstream call failed: https://api.example.invalid/v1/agent?auth=FAKEQUERYSECRET111",
    secret: "FAKEQUERYSECRET111",
    defeatsSanitizerAlone: true,
  },
  {
    label: "percent-encoded JWT in the path",
    raw: "upstream call failed: https://api.example.invalid/v1/eyJhbGciOiJIUzI1NiJ9%2EFAKEPCTJWT555%2EFAKESIG666/run",
    secret: "FAKEPCTJWT555",
    defeatsSanitizerAlone: true,
  },
  {
    label: "opaque session-token path segment",
    raw: "upstream call failed: https://api.example.invalid/session/FAKESESSIONSEG444/stream",
    secret: "FAKESESSIONSEG444",
    defeatsSanitizerAlone: true,
  },
]) {
  test(`a URL-embedded credential (${label}) is stripped before it is recorded`, () => {
    // Guard the guard: these three shapes are exactly the ones sanitizeErrorMessage
    // does NOT catch, which is why the whole URL has to go. If this stops being
    // true the sanitizer improved and this case no longer proves what it claims.
    assert.equal(
      sanitizeErrorMessage(classifyCursorError(raw).message).includes(secret),
      defeatsSanitizerAlone,
      "sanitizeErrorMessage alone is expected to leave this shape intact"
    );

    const ctx = newStreamCtx("composer-2.5", () => {});
    const warnings = captureWarnings(() => {
      processFrame(buildTextDeltaPayload("narration"), ctx, new Set());
      processFrame(buildJsonErrorPayload(raw, "unavailable"), ctx, new Set());
    });

    const recorded = ctx.suppressedErrors[0].message;
    assert.ok(!recorded.includes(secret), `credential leaked into the record: ${recorded}`);
    assert.ok(!recorded.includes("api.example.invalid"), `host survived: ${recorded}`);
    assert.ok(recorded.includes("[URL REDACTED]"), `expected the URL marker, got: ${recorded}`);
    // The surrounding prose — the part with diagnostic value — must survive.
    assert.match(recorded, /upstream call failed/);

    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes(secret), "credential leaked into the warning");
    assert.ok(warnings[0].includes("[URL REDACTED]"), "the warning must carry the marker");
  });
}

test("URL stripping stays bounded on a pathological URL", () => {
  // AGENTS.md → PII learnings: patterns over variable-length untrusted input must
  // not backtrack catastrophically. A single quantifier over a negated class is
  // linear; this pins that a 50k-character URL is collapsed rather than scanned
  // into a hang.
  const ctx = newStreamCtx("composer-2.5", () => {});
  captureWarnings(() => {
    processFrame(buildTextDeltaPayload("narration"), ctx, new Set());
    processFrame(
      buildJsonErrorPayload(`https://${"a".repeat(50_000)}`, "unavailable"),
      ctx,
      new Set()
    );
  });

  const recorded = ctx.suppressedErrors[0].message;
  assert.ok(recorded.includes("[URL REDACTED]"));
  assert.ok(recorded.length < 200, `expected the URL to collapse, got ${recorded.length} chars`);
});

test("each discard site records its own stage", () => {
  // execute()'s two benign-cancel branches call the same helper as processFrame
  // but need a live http2 stream to reach, so drive the helper directly to pin
  // the per-site stage tags and the shared record shape.
  const stages: Array<StreamCtx["suppressedErrors"][number]["stage"]> = [
    "json_error_frame",
    "benign_cancel_stream",
    "benign_cancel_buffered",
  ];

  for (const stage of stages) {
    const ctx = newStreamCtx("composer-2.5", () => {});
    ctx.totalText = "narration";
    ctx.endReason = "server_end";
    const warnings = captureWarnings(() => {
      noteSuppressedUpstreamError(ctx, stage, { message: "Cursor upstream failed", status: 502 });
    });

    assert.equal(ctx.suppressedErrors.length, 1);
    assert.equal(ctx.suppressedErrors[0].stage, stage);
    assert.equal(ctx.suppressedErrors[0].status, 502);
    assert.equal(ctx.suppressedErrors[0].emittedTextLength, "narration".length);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(`stage=${stage}`));
  }
});
