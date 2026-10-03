import { describe, expect, it } from "vitest";
import {
  chooseModel,
  rejectionReasons,
  requirementsOf,
  type ModelProfile,
  type Requirements,
} from "../../src/policy/eligibility.ts";
import { extractFacts } from "../../src/policy/facts.ts";

const NOTHING: Requirements = {
  contextTokens: 10,
  tools: false,
  structuredOutput: false,
  vision: false,
};

const full: ModelProfile = {
  id: "full",
  contextWindow: 1000,
  tools: true,
  structuredOutput: true,
  vision: true,
};
const small: ModelProfile = { id: "small", contextWindow: 100, tools: true };
const catalogue = new Map([full, small].map((m) => [m.id, m]));

describe("requirementsOf", () => {
  it("reads what a request needs from its facts", () => {
    const facts = extractFacts({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: { url: "x" } },
          ],
        },
      ],
      tools: [{ type: "function", function: { name: "f" } }],
      response_format: { type: "json_object" },
    });
    expect(requirementsOf(facts)).toEqual({
      contextTokens: facts.contextTokenEstimate,
      tools: true,
      structuredOutput: true,
      vision: true,
    });
  });
});

describe("rejectionReasons", () => {
  it("accepts a model that can do everything needed", () => {
    expect(
      rejectionReasons(full, { ...NOTHING, tools: true, vision: true }),
    ).toEqual([]);
  });

  it("rejects a model whose window is too small for the estimate", () => {
    expect(rejectionReasons(small, { ...NOTHING, contextTokens: 101 })).toEqual(
      ["the context estimate of 101 tokens exceeds its window of 100"],
    );
  });

  it("accepts an estimate exactly at the window", () => {
    expect(rejectionReasons(small, { ...NOTHING, contextTokens: 100 })).toEqual(
      [],
    );
  });

  it("rejects a model whose support for a needed capability is unknown", () => {
    expect(rejectionReasons(small, { ...NOTHING, vision: true })).toEqual([
      "the request needs image input, and its support is unknown",
    ]);
  });

  it("rejects a model that lacks a needed capability, and lists every reason", () => {
    const noTools: ModelProfile = { id: "x", contextWindow: 5, tools: false };
    expect(
      rejectionReasons(noTools, {
        ...NOTHING,
        tools: true,
        structuredOutput: true,
      }),
    ).toEqual([
      "the context estimate of 10 tokens exceeds its window of 5",
      "the request needs tool calling, which it does not support",
      "the request needs structured output, and its support is unknown",
    ]);
  });

  it("does not hold an unknown capability against a request that does not need it", () => {
    expect(rejectionReasons(small, NOTHING)).toEqual([]);
  });
});

describe("chooseModel", () => {
  it("takes the first eligible candidate, in order", () => {
    expect(chooseModel(["small", "full"], catalogue, NOTHING)).toEqual({
      model: "small",
      rejected: [],
    });
  });

  it("skips ineligible candidates and says why", () => {
    expect(
      chooseModel(["small", "full"], catalogue, { ...NOTHING, vision: true }),
    ).toEqual({
      model: "full",
      rejected: [
        {
          model: "small",
          reasons: [
            "the request needs image input, and its support is unknown",
          ],
        },
      ],
    });
  });

  it("returns no model when no candidate is eligible", () => {
    const result = chooseModel(["small"], catalogue, {
      ...NOTHING,
      contextTokens: 5000,
    });
    expect(result.model).toBeUndefined();
    expect(result.rejected).toHaveLength(1);
  });

  it("rejects a candidate missing from the catalogue", () => {
    expect(chooseModel(["ghost", "small"], catalogue, NOTHING)).toEqual({
      model: "small",
      rejected: [
        {
          model: "ghost",
          reasons: ["it is not in the policy's model catalogue"],
        },
      ],
    });
  });
});
