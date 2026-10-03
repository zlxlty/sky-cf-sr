import { describe, expect, it } from "vitest";
import { readSettings } from "../src/config.ts";
import { entrypoints, POLICIES } from "../src/entrypoints.ts";
import { configHash } from "../src/gateway.ts";
import { loadPolicy } from "../src/policy/policy.ts";
import { AUTO_ROUTER } from "../src/pool.ts";
import { ENV } from "./fixtures.ts";

describe("the deployed Auto Router setup", () => {
  // Benchmark runs check this hash. Change it only when the setup changes on
  // purpose, and record the new hash with the runs that use it.
  it("keeps the config hash benchmark runs expect", async () => {
    expect(await configHash(AUTO_ROUTER)).toBe("7fce7240dfec2bad");
  });
});

describe("the deployed entrypoints", () => {
  // As for the Auto Router: benchmark runs check these hashes. They change
  // when a policy, a model's Gateway name or the deadline changes.
  it.each([
    ["policy/starter", "4dd4c1af34e9993d"],
    ["direct/openai/gpt-5.6-luna", "e357df64df187488"],
    ["direct/@cf/google/gemma-4-26b-a4b-it", "401ddaae5b556694"],
    ["direct/@cf/qwen/qwen3.8-27b", "dafab094e3bf319e"],
    ["direct/@cf/moonshotai/kimi-k2.7-code", "7b288bf515cd72c7"],
    ["direct/anthropic/claude-opus-5.5", "ce5090bf6c53a03f"],
    ["direct/openai/gpt-6-sol", "547a492bf62a0c4c"],
  ])("keeps the config hash of %s", async (model, hash) => {
    const settings = await readSettings({ ...ENV, AUTO_ROUTER });
    const entrypoint = await entrypoints().resolve(model, settings);
    expect(entrypoint?.configHash).toBe(hash);
  });
});

describe("the deployed policies", () => {
  // Otherwise the first request to one would fail as misconfigured.
  it.each(Object.keys(POLICIES))(
    "policy/%s is valid for the deployed pool",
    async (name) => {
      await expect(
        loadPolicy(POLICIES[name], AUTO_ROUTER.allowedModels),
      ).resolves.toBeDefined();
    },
  );
});
