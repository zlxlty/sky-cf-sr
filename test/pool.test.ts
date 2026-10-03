import { describe, expect, it } from "vitest";
import { configHash } from "../src/gateway.ts";
import { AUTO_ROUTER } from "../src/pool.ts";

describe("the deployed Auto Router setup", () => {
  // Benchmark runs check this hash. Change it only when the setup changes on
  // purpose, and record the new hash with the runs that use it.
  it("keeps the config hash benchmark runs expect", async () => {
    expect(await configHash(AUTO_ROUTER)).toBe("7fce7240dfec2bad");
  });
});
