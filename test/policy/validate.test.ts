import { describe, expect, it } from "vitest";
import { parsePolicy, type PolicyIssue } from "../../src/policy/validate.ts";

const DEFAULT = { name: "default", priority: 0 };
const CODING = {
  name: "coding",
  priority: 10,
  rules: {
    operator: "OR",
    conditions: [
      { type: "keyword", name: "code_terms" },
      { type: "domain", name: "coding" },
    ],
  },
};

function issuesOf(input: unknown): PolicyIssue[] {
  const result = parsePolicy(input);
  if (result.ok) throw new Error("expected the policy to be rejected");
  return result.issues;
}

/** Nests a signal inside `depth` levels of NOT. */
function nested(depth: number): unknown {
  let node: unknown = { type: "keyword", name: "x" };
  for (let i = 0; i < depth; i++)
    node = { operator: "NOT", conditions: [node] };
  return node;
}

describe("parsePolicy", () => {
  it("accepts a valid policy and returns it typed", () => {
    const result = parsePolicy({
      decisions: [
        { ...CODING, description: "Coding requests", onUnknown: "no_match" },
        DEFAULT,
      ],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        decisions: [{ ...CODING, onUnknown: "no_match" }, DEFAULT],
      },
    });
  });

  it("does not change its input", () => {
    const input = {
      decisions: [
        {
          name: "a",
          priority: 1,
          rules: { type: "keyword", name: "x", on_error: "match" },
        },
        DEFAULT,
      ],
    };
    const copy = structuredClone(input);
    parsePolicy(input);
    expect(input).toEqual(copy);
  });

  it.each([
    ["a policy that is not an object", [], "policy", "must be an object"],
    ["no decisions", { decisions: [] }, "decisions", "non-empty list"],
    [
      "an unknown top-level field",
      { decisions: [DEFAULT], strategy: "confidence" },
      "policy.strategy",
      "not a known field",
    ],
    [
      "a bad decision name",
      { decisions: [{ ...CODING, name: "has space" }, DEFAULT] },
      "decisions[0].name",
      "letters, digits",
    ],
    [
      "a fractional priority",
      { decisions: [{ ...CODING, priority: 1.5 }, DEFAULT] },
      "decisions[0].priority",
      "whole number",
    ],
    [
      "an unknown onUnknown value",
      { decisions: [{ ...CODING, onUnknown: "ignore" }, DEFAULT] },
      "decisions[0].onUnknown",
      "must be one of",
    ],
    [
      "onUnknown on the default",
      { decisions: [{ ...DEFAULT, onUnknown: "match" }] },
      "decisions[0].onUnknown",
      "does not apply to the default",
    ],
    [
      "an unknown decision field",
      { decisions: [{ ...CODING, tier: 1 }, DEFAULT] },
      "decisions[0].tier",
      "not a known field",
    ],
    [
      "an unknown operator",
      {
        decisions: [
          { ...CODING, rules: { operator: "XOR", conditions: [] } },
          DEFAULT,
        ],
      },
      "decisions[0].rules.operator",
      "AND, OR or NOT",
    ],
    [
      "NOT with two conditions",
      {
        decisions: [
          {
            ...CODING,
            rules: {
              operator: "NOT",
              conditions: [
                { type: "a", name: "b" },
                { type: "a", name: "c" },
              ],
            },
          },
          DEFAULT,
        ],
      },
      "decisions[0].rules.conditions",
      "exactly one",
    ],
    [
      "an empty AND",
      {
        decisions: [
          { ...CODING, rules: { operator: "AND", conditions: [] } },
          DEFAULT,
        ],
      },
      "decisions[0].rules.conditions",
      "written without rules",
    ],
    [
      "a signal without a name",
      { decisions: [{ ...CODING, rules: { type: "keyword" } }, DEFAULT] },
      "decisions[0].rules.name",
      "letters, digits",
    ],
    [
      "a signal with an extra field",
      {
        decisions: [
          { ...CODING, rules: { type: "keyword", name: "x", label: "y" } },
          DEFAULT,
        ],
      },
      "decisions[0].rules.label",
      "not a known field",
    ],
    [
      "on_unknown inside the rules",
      {
        decisions: [
          {
            ...CODING,
            rules: { type: "keyword", name: "x", on_unknown: "match" },
          },
          DEFAULT,
        ],
      },
      "decisions[0].rules.on_unknown",
      "belongs on the decision",
    ],
    [
      "on_error inside the rules",
      {
        decisions: [
          {
            ...CODING,
            rules: {
              operator: "OR",
              conditions: [{ type: "keyword", name: "x", on_error: "match" }],
            },
          },
          DEFAULT,
        ],
      },
      "decisions[0].rules.conditions[0].on_error",
      "not supported",
    ],
  ])("rejects %s", (_name, input, path, message) => {
    expect(issuesOf(input)).toContainEqual({
      path,
      message: expect.stringContaining(message),
    });
  });

  describe("the set of decisions", () => {
    it("rejects a repeated name", () => {
      expect(
        issuesOf({ decisions: [CODING, { ...CODING, priority: 20 }, DEFAULT] }),
      ).toContainEqual({
        path: "decisions[1].name",
        message: expect.stringContaining("repeats the name of decisions[0]"),
      });
    });

    it("rejects a repeated priority", () => {
      expect(
        issuesOf({
          decisions: [CODING, { ...CODING, name: "other" }, DEFAULT],
        }),
      ).toContainEqual({
        path: "decisions[1].priority",
        message: expect.stringContaining("equals the priority of decisions[0]"),
      });
    });

    it("lets the default share a priority, since it always ranks last", () => {
      expect(
        parsePolicy({ decisions: [CODING, { ...DEFAULT, priority: 10 }] }).ok,
      ).toBe(true);
    });

    it("requires a default", () => {
      expect(issuesOf({ decisions: [CODING] })).toContainEqual({
        path: "decisions",
        message: expect.stringContaining("exactly one default"),
      });
    });

    it("rejects a second default", () => {
      expect(
        issuesOf({ decisions: [DEFAULT, { name: "other", priority: 1 }] }),
      ).toContainEqual({
        path: "decisions[1]",
        message: expect.stringContaining("second default"),
      });
    });
  });

  describe("bounds on the rules", () => {
    it("accepts rules 16 levels deep", () => {
      expect(
        parsePolicy({ decisions: [{ ...CODING, rules: nested(15) }, DEFAULT] })
          .ok,
      ).toBe(true);
    });

    it("rejects rules nested deeper than 16 levels", () => {
      expect(
        issuesOf({ decisions: [{ ...CODING, rules: nested(16) }, DEFAULT] }),
      ).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("more than 16 levels"),
        }),
      );
    });

    it("rejects rules with more than 256 nodes", () => {
      const conditions = Array.from({ length: 256 }, (_, i) => ({
        type: "keyword",
        name: `k${i}`,
      }));
      expect(
        issuesOf({
          decisions: [
            { ...CODING, rules: { operator: "OR", conditions } },
            DEFAULT,
          ],
        }),
      ).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("more than 256 nodes"),
        }),
      );
    });
  });

  it("reports every problem at once", () => {
    expect(
      issuesOf({
        decisions: [
          { ...CODING, name: "bad name", priority: "high" },
          { name: "x", priority: 1 },
          { name: "y", priority: 2 },
        ],
      }).map((issue) => issue.path),
    ).toEqual(["decisions[0].name", "decisions[0].priority", "decisions[2]"]);
  });
});
