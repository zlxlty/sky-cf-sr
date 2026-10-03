import { describe, expect, it } from "vitest";
import { ConfigError, readSettings } from "../src/config.ts";
import { ENV } from "./fixtures.ts";

const POLICY = ENV.AUTO_ROUTER;

async function hashWith(policy: Partial<typeof POLICY>): Promise<string> {
  const settings = await readSettings({
    ...ENV,
    AUTO_ROUTER: { ...POLICY, ...policy },
  });
  return settings.configHash;
}

describe("readSettings", () => {
  it("derives the Chat Completions URL and keeps the policy", async () => {
    expect(await readSettings(ENV)).toMatchObject({
      chatCompletionsUrl:
        "https://gateway.ai.cloudflare.com/v1/account/gateway/compat/chat/completions",
      gatewayToken: "gateway-token",
      clientToken: "client-token",
      ...POLICY,
      configHash: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });

  it("accepts a trailing slash and a local stand-in over plain HTTP", async () => {
    const settings = await readSettings({
      ...ENV,
      AIG_GATEWAY_URL: "http://127.0.0.1:8799/v1/a/g/",
    });
    expect(settings.chatCompletionsUrl).toBe(
      "http://127.0.0.1:8799/v1/a/g/compat/chat/completions",
    );
  });

  it.each([
    ["AIG_GATEWAY_URL", { AIG_GATEWAY_URL: undefined }],
    ["AIG_GATEWAY_URL", { AIG_GATEWAY_URL: "not a url" }],
    [
      "AIG_GATEWAY_URL",
      { AIG_GATEWAY_URL: "http://gateway.ai.cloudflare.com/v1/a/g" },
    ],
    [
      "AIG_GATEWAY_URL",
      { AIG_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/a/g?x=1" },
    ],
    [
      "AIG_GATEWAY_URL",
      { AIG_GATEWAY_URL: "https://gateway.ai.cloudflare.com/v1/a/g#x" },
    ],
    [
      "AIG_GATEWAY_URL",
      { AIG_GATEWAY_URL: "https://user:pw@gateway.ai.cloudflare.com/v1/a/g" },
    ],
    ["AIG_TOKEN", { AIG_TOKEN: "  " }],
    ["CLIENT_TOKEN", { CLIENT_TOKEN: 42 }],
    ["CLIENT_TOKEN", { CLIENT_TOKEN: "has!bang" }],
    ["AUTO_ROUTER", { AUTO_ROUTER: undefined }],
    [
      "AUTO_ROUTER.allowedModels",
      { AUTO_ROUTER: { ...POLICY, allowedModels: [] } },
    ],
    [
      "AUTO_ROUTER.allowedModels",
      { AUTO_ROUTER: { ...POLICY, allowedModels: "openai/gpt-6-sol" } },
    ],
    [
      "AUTO_ROUTER.allowedModels",
      {
        AUTO_ROUTER: {
          ...POLICY,
          allowedModels: ["openai/gpt-6-sol,anthropic/*"],
        },
      },
    ],
    [
      "AUTO_ROUTER.poolPinnedOn",
      { AUTO_ROUTER: { ...POLICY, poolPinnedOn: "October" } },
    ],
    ["AUTO_ROUTER.deadlineMs", { AUTO_ROUTER: { ...POLICY, deadlineMs: 0 } }],
    ["AUTO_ROUTER.deadlineMs", { AUTO_ROUTER: { ...POLICY, deadlineMs: 1.5 } }],
    [
      "AUTO_ROUTER.logPayloads",
      { AUTO_ROUTER: { ...POLICY, logPayloads: "yes" } },
    ],
  ])("names %s when it is missing or malformed", async (name, override) => {
    const settings = readSettings({ ...ENV, ...override });
    await expect(settings).rejects.toThrow(ConfigError);
    await expect(settings).rejects.toThrow(name);
  });
});

describe("the config hash", () => {
  it("is the same for the same policy", async () => {
    expect(await hashWith({})).toBe(await hashWith({}));
  });

  it.each([
    ["the pool", { allowedModels: ["openai/gpt-5.6-luna"] }],
    [
      "the pool's order",
      { allowedModels: [...POLICY.allowedModels].reverse() },
    ],
    ["the pin date", { poolPinnedOn: "2026-11-01" }],
    ["the deadline", { deadlineMs: 30_000 }],
  ])("changes with %s", async (_name, change) => {
    expect(await hashWith(change)).not.toBe(await hashWith({}));
  });

  it("ignores payload logging, which cannot change a result", async () => {
    expect(await hashWith({ logPayloads: false })).toBe(await hashWith({}));
  });
});
