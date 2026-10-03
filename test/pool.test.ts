import { describe, expect, it } from "vitest";
import { POLICIES } from "../src/entrypoints.ts";
import { configHash } from "../src/gateway.ts";
import { loadPolicy } from "../src/policy/policy.ts";
import { AUTO_ROUTER } from "../src/pool.ts";

describe("the deployed Auto Router setup", () => {
  // Benchmark runs check this hash. Change it only when the setup changes on
  // purpose, and record the new hash with the runs that use it.
  it("keeps the config hash benchmark runs expect", async () => {
    expect(await configHash(AUTO_ROUTER)).toBe("7fce7240dfec2bad");
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
