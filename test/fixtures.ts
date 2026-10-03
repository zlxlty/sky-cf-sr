/** Valid bindings for tests; each test overrides what it needs. */
export const ENV = {
  AIG_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/account/gateway",
  AIG_TOKEN: "gateway-token",
  CLIENT_TOKEN: "client-token",
  AUTO_ROUTER: {
    allowedModels: ["openai/gpt-5.6-luna", "anthropic/claude-opus-5.5"],
    poolPinnedOn: "2026-10-01",
    deadlineMs: 60_000,
    logPayloads: true,
  },
};
