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
 * Pool models that a call naming one model must name differently from the
 * Auto Router on the Gateway's compat endpoint. Anthropic names Opus 5.5
 * `claude-opus-5-5`; the Auto Router's name gets 404 from Anthropic (seen in
 * production on 2026-10-03).
 */
export const GATEWAY_NAMES: Readonly<Record<string, string>> = {
  "anthropic/claude-opus-5.5": "anthropic/claude-opus-5-5",
};

/**
 * Pool models that the compat endpoint does not serve when one is named,
 * though the Auto Router can choose them: Fireworks is not one of that
 * endpoint's providers, and it answers 400 "Invalid provider" (seen in
 * production on 2026-10-04).
 *
 * A call that names one of these goes through the Worker's AI binding, which
 * takes every model of Cloudflare's catalogue under the Auto Router's name.
 * A model of xAI would need the same: while `xai/grok-4.6` was in the pool,
 * the endpoint answered 401 "No credentials presented" for `grok/grok-4.6`,
 * and the binding served it.
 */
export const VIA_AI_BINDING: readonly string[] = [
  "fireworks/glm-5.3-flash",
  "fireworks/glm-5.3",
];

/**
 * Pool models that read a repeated prompt from their cache only when the
 * calls that share it carry the same cache key. With no key, each of six
 * calls with one long prefix was billed at the full price; with one, every
 * call after the first read the prefix and was billed at 19% of it (seen in
 * production on 2026-10-04).
 *
 * OpenAI's models take the same key and read nothing with or without it, and
 * Opus reads nothing on the compat endpoint, so neither is listed.
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
