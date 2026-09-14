/**
 * chatCore semantic-cache store (Quality Gate v2 / Fase 9 — chatCore god-file decomposition,
 * #3501).
 *
 * Extracted from handleChatCore's non-streaming success path (Phase 9.1): when semantic caching is
 * enabled and the request/response are cacheable, store the translated response under its signature
 * so a later temp=0 request can be served from cache. Side-effect only (cache write + debug log);
 * no early-return, no outer-variable reassignment. Behaviour matches the previous
 * inline block, including the `prompt + completion || 0` token-saved precedence — with ONE
 * deliberate divergence: a response reassembled from an upstream event stream is no longer
 * written (see `reconstructedFromEventStream` below).
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

type UsageLike = { prompt_tokens?: number; completion_tokens?: number } | null | undefined;

export interface SemanticCacheStoreDeps {
  isCacheableForWrite: typeof defaultIsCacheableForWrite;
  isSmallEnoughForSemanticCache: typeof defaultIsSmallEnough;
  generateSignature: typeof defaultGenerateSignature;
  setCachedResponse: typeof defaultSetCachedResponse;
}

const DEFAULT_DEPS: SemanticCacheStoreDeps = {
  isCacheableForWrite: defaultIsCacheableForWrite,
  isSmallEnoughForSemanticCache: defaultIsSmallEnough,
  generateSignature: defaultGenerateSignature,
  setCachedResponse: defaultSetCachedResponse,
};

export function storeSemanticCacheResponse(
  args: {
    enabled: boolean;
    body: CacheBody;
    headers: unknown;
    translatedResponse: unknown;
    /**
     * True when `translatedResponse` was REASSEMBLED from an upstream event stream rather than
     * parsed from a whole JSON body — `looksLikeSSE` at the call site, set when a provider
     * answers a non-streaming request with `text/event-stream`/NDJSON
     * (`nonStreamingResponseParse.ts:74-119`). Such a body is a reconstruction and carries the
     * same accumulator defect the streaming store guards against: `sseParser.ts:237` seeds a
     * missing tool-call name with the literal `"unknown"` and the backfill at `:244` only
     * replaces a falsy name, so `"unknown"` survives into the cached body and is served verbatim
     * on a later HIT.
     *
     * Guarded on the RECONSTRUCTION rather than on tool-call shape (the streaming store's
     * narrowing) on purpose: `translatedResponse` is already in the CLIENT's format, so a
     * shape-keyed check would have to recognize OpenAI `choices[].message.tool_calls`, Claude
     * `content[].type === "tool_use"`, Gemini `functionCall` parts and Responses `function_call`
     * items, and would silently pass anything it failed to recognize. A body parsed from real
     * provider JSON (the overwhelmingly common path) is not a reconstruction and still caches.
     */
    reconstructedFromEventStream?: boolean;
    model: string;
    apiKeyId?: string;
    usage?: UsageLike;
    log?: LoggerLike;
  },
  deps: SemanticCacheStoreDeps = DEFAULT_DEPS
): void {
  if (
    !args.enabled ||
    args.reconstructedFromEventStream === true ||
    !deps.isCacheableForWrite(args.body, args.headers) ||
    !deps.isSmallEnoughForSemanticCache(args.translatedResponse)
  ) {
    return;
  }
  const signature = deps.generateSignature(
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
  const tokensSaved = args.usage?.prompt_tokens + args.usage?.completion_tokens || 0;
  deps.setCachedResponse(signature, args.model, args.translatedResponse, tokensSaved);
  args.log?.debug?.("CACHE", `Stored response for ${args.model} (${tokensSaved} tokens)`);
}
