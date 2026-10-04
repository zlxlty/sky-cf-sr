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
  "xai/grok-4.6",
  "openai/gpt-6-sol",
  "anthropic/claude-opus-5.5",
];

/**
 * Pool models that a call naming one model must name differently from the
 * Auto Router.
 * - Anthropic names Opus 5.5 `claude-opus-5-5`; the Auto Router's name gets
 *   404 from Anthropic (seen in production on 2026-10-03).
 * - The compat endpoint's provider name for xAI is `grok`, by AI Gateway's
 *   documentation. Not yet seen in production.
 *
 * The two Fireworks models have no entry: Fireworks is not among the compat
 * endpoint's documented providers, so the name it wants, if it serves them at
 * all, is not known until a call is made.
 */
export const GATEWAY_NAMES: Readonly<Record<string, string>> = {
  "anthropic/claude-opus-5.5": "anthropic/claude-opus-5-5",
  "xai/grok-4.6": "grok/grok-4.6",
};

/** How the deployed Worker calls the Auto Router; bound as `AUTO_ROUTER` in `cloudflare.config.ts`. */
export const AUTO_ROUTER = {
  allowedModels: POOL,
  poolPinnedOn: "2026-10-03",
  deadlineMs: 600_000,
  // Benchmark prompts are public. Set this to false before sending private
  // sessions through, such as your own code.
  logPayloads: true,
} satisfies AutoRouterPolicy;
