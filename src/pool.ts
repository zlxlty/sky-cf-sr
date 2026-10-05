/**
 * The pool, and how the deployed Worker calls the Auto Router.
 *
 * `cloudflare.config.ts` imports this module, so the Worker's own code must
 * not, and this module must import nothing but types from it. Under `cf dev`,
 * a module that the config imports cannot be loaded into the Worker: the
 * dev server refuses to read it (seen with @cloudflare/vite-plugin
 * 2.0.0-beta on 2026-10-05; `cf build` is not affected). The Worker gets
 * `AUTO_ROUTER` from its binding, and what it knows about each model is in
 * `reach.ts`.
 */

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

/** How the deployed Worker calls the Auto Router; bound as `AUTO_ROUTER` in `cloudflare.config.ts`. */
export const AUTO_ROUTER = {
  allowedModels: POOL,
  poolPinnedOn: "2026-10-03",
  deadlineMs: 600_000,
  // Benchmark prompts are public. Set this to false before sending private
  // sessions through, such as your own code.
  logPayloads: true,
} satisfies AutoRouterPolicy;
