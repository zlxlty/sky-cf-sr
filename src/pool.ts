import type { AutoRouterPolicy } from "./config.ts";

/**
 * The models every router in the comparison may choose from. The Auto Router
 * gets them in `cf-aig-allowed-models`, and `loadPolicy` rejects a routing
 * policy that names any other model.
 */
export const POOL = [
  "openai/gpt-6-luna",
  "fireworks/glm-5.3-flash",
  "fireworks/glm-5.3",
  "openai/gpt-6-sol",
  "anthropic/claude-opus-5.5",
];

/**
 * Pool models that a call naming one model reaches through the Worker's AI
 * binding, not through the Gateway's compat endpoint. The binding takes every
 * model of Cloudflare's catalogue under the Auto Router's name. There are two
 * reasons, both seen in production on 2026-10-04:
 *
 * - The endpoint does not serve the Fireworks models when one is named,
 *   though the Auto Router can choose them: Fireworks is not one of its
 *   providers, and it answers 400 "Invalid provider". A model of xAI would
 *   need the same: while `xai/grok-4.6` was in the pool, the endpoint
 *   answered 401 "No credentials presented" for it, and the binding served it.
 * - The endpoint serves Opus, but never from Anthropic's prompt cache: it
 *   takes a cache marker and ignores it, and every call is billed at the full
 *   price. Through the binding, a call that reads the cache is billed at 6%.
 */
export const VIA_AI_BINDING: readonly string[] = [
  "fireworks/glm-5.3-flash",
  "fireworks/glm-5.3",
  "anthropic/claude-opus-5.5",
];

/**
 * Models that the binding takes and answers in Anthropic's own Messages
 * format, not in OpenAI's. A call to one is translated both ways; see
 * `src/anthropic.ts`.
 */
export const ANTHROPIC_FORMAT: readonly string[] = [
  "anthropic/claude-opus-5.5",
];

/**
 * Pool models that get a session's cache key. The key is for calls whose
 * prompts start alike and end differently, such as several questions about
 * one long document. In production on 2026-10-04, with no key GLM 5.3 read
 * such a start from its cache on 1 of 10 later calls, and GLM 5.3 Flash on
 * none; with a key GLM 5.3 read it on every call after the first, billed at
 * 19% of the full price, and Flash read about two thirds of it.
 *
 * A conversation that only grows does not need the key: on 2026-10-05,
 * GLM 5.3 read one from its cache on most later calls, with a key and with
 * none.
 *
 * OpenAI's models are not listed, because the key changes nothing for them:
 * they read a conversation that grows with no key, and prompts that only
 * start alike not at all, with a key or without. Opus takes no key: its
 * cache needs a marker in the request, which the translation to Anthropic's
 * format adds.
 */
export const CACHE_KEY_MODELS: readonly string[] = [
  "fireworks/glm-5.3-flash",
  "fireworks/glm-5.3",
];

/** How the deployed Worker calls the Auto Router; bound as `AUTO_ROUTER` in `cloudflare.config.ts`. */
export const AUTO_ROUTER = {
  allowedModels: POOL,
  poolPinnedOn: "2026-10-03",
  deadlineMs: 600_000,
  // Benchmark prompts are public. Set this to false before sending private
  // sessions through, such as your own code.
  logPayloads: true,
} satisfies AutoRouterPolicy;
