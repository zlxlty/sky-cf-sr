import type { AutoRouterPolicy } from "./config.ts";

/**
 * The models every router in the comparison may choose from. The Auto Router
 * gets them in `cf-aig-allowed-models`, and `loadPolicy` rejects a routing
 * policy that names any other model.
 */
export const POOL = [
  "openai/gpt-5.6-luna",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/qwen/qwen3.8-27b",
  "@cf/moonshotai/kimi-k2.7-code",
  "anthropic/claude-opus-5.5",
  "openai/gpt-6-sol",
];

/**
 * Pool models that a call naming one model must name differently from the
 * Auto Router. Anthropic names Opus 5.5 `claude-opus-5-5`; the Auto Router's
 * name gets 404 from Anthropic (seen in production on 2026-10-03).
 */
export const GATEWAY_NAMES: Readonly<Record<string, string>> = {
  "anthropic/claude-opus-5.5": "anthropic/claude-opus-5-5",
};

/** How the deployed Worker calls the Auto Router; bound as `AUTO_ROUTER` in `cloudflare.config.ts`. */
export const AUTO_ROUTER = {
  allowedModels: POOL,
  poolPinnedOn: "2026-10-01",
  deadlineMs: 600_000,
  // Benchmark prompts are public. Set this to false before sending private
  // sessions through, such as your own code.
  logPayloads: true,
} satisfies AutoRouterPolicy;
