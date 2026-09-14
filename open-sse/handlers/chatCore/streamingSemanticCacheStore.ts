/**
 * chatCore streaming semantic-cache store (Quality Gate v2 / Fase 9 — chatCore god-file
 * decomposition, #3501).
 *
 * Extracted from handleChatCore's onStreamComplete callback: after a 200 streaming response is
 * assembled, store it under its signature so a future temp=0 request can be served from cache.
 * Side-effect only (cache write + debug log), wrapped in fail-open try/catch. Behaviour matches
 * the previous inline block — including the `_streamed` strip, the early skip-on-too-large, and
 * the `Number(...) || 0` token accounting — with ONE deliberate divergence: a reconstructed body
 * carrying tool calls is no longer written (see `hasToolCalls` below). The early return was the
 * last statement of the callback, so returning from this helper is equivalent.
 */
import {
  generateSignature as defaultGenerateSignature,
  setCachedResponse as defaultSetCachedResponse,
  isCacheableForWrite as defaultIsCacheableForWrite,
} from "@/lib/semanticCache";
import { isSmallEnoughForSemanticCache as defaultIsSmallEnough } from "../../utils/estimateSize.ts";

type LoggerLike = { debug?: (...args: unknown[]) => void } | null | undefined;

type CacheBody = {
  messages?: unknown;
  input?: unknown;
  temperature?: number;
  top_p?: number;
  tool_choice?: unknown;
  tools?: unknown;
  response_format?: unknown;
};

export interface StreamingSemanticCacheStoreDeps {
  isCacheableForWrite: typeof defaultIsCacheableForWrite;
  isSmallEnoughForSemanticCache: typeof defaultIsSmallEnough;
  generateSignature: typeof defaultGenerateSignature;
  setCachedResponse: typeof defaultSetCachedResponse;
}

const DEFAULT_DEPS: StreamingSemanticCacheStoreDeps = {
  isCacheableForWrite: defaultIsCacheableForWrite,
  isSmallEnoughForSemanticCache: defaultIsSmallEnough,
  generateSignature: defaultGenerateSignature,
  setCachedResponse: defaultSetCachedResponse,
};

interface StreamingCacheArgs {
  enabled: boolean;
  streamStatus: number;
  streamResponseBody: Record<string, unknown> | null | undefined;
  body: CacheBody;
  headers: unknown;
  model: string;
  apiKeyId?: string;
  streamUsage?: Record<string, unknown> | null;
  log?: LoggerLike;
}

/**
 * True when a reconstructed streaming body carries at least one tool call.
 *
 * Every body reaching this module is a SECOND, independent accumulator's view of the stream,
 * running beside the client's own: `stream.ts` synthesizes it from collected deltas rather than
 * from anything the provider sent whole. The two can disagree, because the collector defaults a
 * missing function name to a placeholder and then only fills an EMPTY one —
 * `streamPayloadCollector.ts:296` seeds the literal `"unknown"`, and the backfill at `:310` tests
 * `!existing.function.name`, so `"unknown"` (truthy) is never replaced and reaches the body. The
 * non-fallback path has the same hazard with an empty name (`stream.ts:867-870`), and `finalize()`
 * substitutes invented `_split0`/`_split1` ids when it splits concatenated arguments.
 *
 * The semantic cache is what makes that dangerous ACROSS requests: a HIT serves the stored body
 * verbatim to a DIFFERENT request, and `jsonToSse.ts:113-115` re-emits `tool_calls` unvalidated. A
 * tool named `"unknown"` is a hard client failure rather than something a client can ignore: it
 * dispatches on the name, and cannot satisfy a call it never declared. Refusing to cache
 * tool-bearing reconstructions closes that defect, the empty-name variant, the `_split` id
 * substitution, and the next reconstruction defect, for every later request.
 *
 * Scope, precisely: this prevents a reconstruction defect from being SERVED TO A DIFFERENT
 * REQUEST. It does NOT stop the same body being retained elsewhere — `chatCore.ts:5497` saves it
 * for idempotency and `src/lib/db/responsesContinuationStore.ts:123` retains Responses output —
 * and neither should get this refusal: their contract is to preserve the original response and
 * history, so refusing there would change what a client gets back on an idempotent replay or a
 * continuation, a different and worse problem than a poisoned cache entry. It also does not fix
 * the underlying accumulator defect at `streamPayloadCollector.ts:296` (or its twin at
 * `sseParser.ts:237`), which still reaches logs and the dashboard — that is separate work.
 *
 * Deliberately keyed on the RESPONSE: a request that merely declares `tools` still caches
 * normally, since a plain text answer to a tool-enabled request is not a reconstruction hazard.
 */
function hasToolCalls(body: Record<string, unknown> | null | undefined): boolean {
  const choices = body?.choices;
  if (!Array.isArray(choices)) return false;
  return choices.some((choice) => {
    const message = (choice as { message?: { tool_calls?: unknown } } | null | undefined)?.message;
    const toolCalls = message?.tool_calls;
    return Array.isArray(toolCalls) && toolCalls.length > 0;
  });
}

function streamTokensSaved(streamUsage: Record<string, unknown> | null | undefined): number {
  const u = streamUsage as Record<string, unknown> | null;
  return (Number(u?.prompt_tokens ?? 0) || 0) + (Number(u?.completion_tokens ?? 0) || 0);
}

function writeStreamingCacheEntry(
  args: StreamingCacheArgs,
  deps: StreamingSemanticCacheStoreDeps
): void {
  try {
    const cleanBody = { ...(args.streamResponseBody as Record<string, unknown>) };
    delete cleanBody._streamed;
    if (!deps.isSmallEnoughForSemanticCache(cleanBody)) return;
    const sig = deps.generateSignature(
      args.model,
      args.body.messages ?? args.body.input,
      args.body.temperature,
      args.body.top_p,
      args.apiKeyId ?? undefined,
      {
        toolChoice: args.body.tool_choice,
        tools: args.body.tools,
        responseFormat: args.body.response_format,
      }
    );
    const tokensSaved = streamTokensSaved(args.streamUsage);
    deps.setCachedResponse(sig, args.model, cleanBody, tokensSaved);
    args.log?.debug?.(
      "CACHE",
      `Stored streaming response for ${args.model} (${tokensSaved} tokens)`
    );
  } catch {
    // Cache write failed — non-critical
  }
}

export function storeStreamingSemanticCacheResponse(
  args: StreamingCacheArgs,
  deps: StreamingSemanticCacheStoreDeps = DEFAULT_DEPS
): void {
  if (
    !args.enabled ||
    args.streamStatus !== 200 ||
    !args.streamResponseBody ||
    !deps.isCacheableForWrite(args.body, args.headers) ||
    hasToolCalls(args.streamResponseBody)
  ) {
    return;
  }
  writeStreamingCacheEntry(args, deps);
}
