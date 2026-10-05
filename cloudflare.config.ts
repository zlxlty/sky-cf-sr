import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
import { AUTO_ROUTER } from "./src/pool.ts";

export default defineConfig({
  worker: {
    name: "sky-cf-sr",
    compatibilityDate: "2026-09-30",
    // Lets a caller's disconnect abort the request's signal. What that does to a
    // Gateway call still waiting for headers differs deployed and under
    // `cf dev`; see the README.
    compatibilityFlags: ["enable_request_signal"],
    // Keeps every request's log record in Workers Logs, not only in a live tail.
    observability: { enabled: true, headSamplingRate: 1 },
    entrypoint,
    env: {
      AIG_GATEWAY_URL: bindings.secret(),
      AIG_TOKEN: bindings.secret(),
      CLIENT_TOKEN: bindings.secret(),
      AUTO_ROUTER: bindings.json(AUTO_ROUTER),
      // Calls pool models that the Gateway's compat endpoint does not serve when
      // named; see VIA_AI_BINDING in src/reach.ts. It has no local stand-in.
      AI: bindings.ai({ dev: { remote: true } }),
    },
  },
});
