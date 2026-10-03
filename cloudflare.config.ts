import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { POOL } from "./src/pool.ts";

export default defineConfig({
  worker: {
    name: "sky-cf-sr",
    compatibilityDate: "2026-09-30",
    // Lets a caller's disconnect abort the request's signal. Not yet confirmed to
    // cancel a Gateway call that is still waiting for headers; see the README.
    compatibilityFlags: ["enable_request_signal"],
    // Keeps every request's log record in Workers Logs, not only in a live tail.
    observability: { enabled: true, headSamplingRate: 1 },
    entrypoint,
    env: {
      AIG_GATEWAY_URL: bindings.secret(),
      AIG_TOKEN: bindings.secret(),
      CLIENT_TOKEN: bindings.secret(),
      AUTO_ROUTER: bindings.json({
        allowedModels: POOL,
        poolPinnedOn: "2026-10-01",
        deadlineMs: 600_000,
        // Benchmark prompts are public. Set this to false before sending private
        // sessions through, such as your own code.
        logPayloads: true,
      }),
    },
  },
});
