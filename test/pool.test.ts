import { describe, expect, it } from "vitest";
import { readSettings } from "../src/config.ts";
import { entrypoints, POLICIES } from "../src/entrypoints.ts";
import { configHash } from "../src/gateway.ts";
import { loadPolicy } from "../src/policy/policy.ts";
import { AUTO_ROUTER } from "../src/pool.ts";
import { ENV } from "./fixtures.ts";
import { aiBinding } from "./harness.ts";

describe("the deployed Auto Router setup", () => {
  // Benchmark runs check this hash. Change it only when the setup changes on
  // purpose, and record the new hash with the runs that use it.
  it("keeps the config hash benchmark runs expect", async () => {
    expect(await configHash(AUTO_ROUTER)).toBe("7efcbd0ef33da424");
  });
});

describe("the deployed entrypoints", () => {
  // As for the Auto Router: benchmark runs check these hashes. They change
  // when a policy, the way a model is reached, the models that get a
  // session's cache key or the deadline changes.
  it.each([
    ["policy/starter", "f8859daccaa6c877"],
    ["direct/openai/gpt-6-luna", "dd877082304b7be2"],
    ["direct/fireworks/glm-5.3-flash", "873338b98cd92471"],
    ["direct/fireworks/glm-5.3", "856604f0d1e0dfcd"],
    ["direct/openai/gpt-6-sol", "547a492bf62a0c4c"],
    ["direct/anthropic/claude-opus-5.5", "84a95f482d3cfee6"],
  ])("keeps the config hash of %s", async (model, hash) => {
    // The deployed pool has models that are called through the AI binding.
    const settings = await readSettings({
      ...ENV,
      AUTO_ROUTER,
      AI: aiBinding().binding,
    });
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
