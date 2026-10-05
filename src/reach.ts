/**
 * How a call that names one pool model reaches it: through the AI binding or
 * not, in which format, and with a session's cache key or not. The pool
 * itself is in `pool.ts`.
 */

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
 * Pool models that the binding takes and answers in OpenAI's Responses
 * format, for a call with tools at an effort other than "none". Seen in
 * production on 2026-10-05: in the Chat Completions format these models
 * refuse a tool together with a reasoning effort ("Function tools with
 * reasoning_effort are not supported ... To use function tools, use
 * /v1/responses or set reasoning_effort to 'none'"), on the compat endpoint
 * and through the binding alike, and a call with tools that sets no effort is
 * refused too. In the Responses format the binding serves a call with tools
 * at every effort, and the effort is applied.
 *
 * Only the calls that the endpoint refuses go this way. A call with no tools,
 * and a call with tools at the effort "none", stay on the endpoint, so no
 * call that the endpoint serves changes. A call that goes this way is
 * translated both ways; see `src/responses.ts`.
 *
 * On this path a conversation that grows is read from the cache by the next
 * call at the same effort, and what is read is billed at about a tenth of
 * the full price. A call at another effort read nothing from it, and the
 * call after that, at the first effort again, read the cache again: seen
 * once, in four calls, on 2026-10-05.
 */
export const RESPONSES_FORMAT_WITH_TOOLS: readonly string[] = [
  "openai/gpt-6-luna",
  "openai/gpt-6-sol",
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
