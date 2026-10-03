import { describe, expect, it } from "vitest";
import { parsePolicy, type PolicyIssue } from "../../src/policy/validate.ts";

const MODELS = [{ id: "m1", contextWindow: 100000 }];
const DEFAULT = { name: "default", priority: 0, models: ["m1"] };
const CODING = {
  name: "coding",
  priority: 10,
  models: ["m1"],
  onUnknown: "no_match",
  rules: {
    operator: "OR",
    conditions: [
      { type: "keyword", name: "code_terms" },
      { type: "fact", name: "long_prompt" },
    ],
  },
};
const SIGNALS = {
  keyword: [
    { name: "code_terms", operator: "OR", keywords: ["python", "C++"] },
    { name: "x", operator: "OR", keywords: ["x"] },
  ],
  fact: [{ name: "long_prompt", fact: "contextTokenEstimate", atLeast: 8000 }],
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
      signals: SIGNALS,
      models: MODELS,
      decisions: [
        { ...CODING, description: "Coding requests", onUnknown: "no_match" },
        DEFAULT,
      ],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        signals: SIGNALS,
        models: MODELS,
        decisions: [
          { ...CODING, description: "Coding requests", onUnknown: "no_match" },
          DEFAULT,
        ],
      },
    });
  });

  it("does not change its input", () => {
    const input = {
      signals: SIGNALS,
      models: MODELS,
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
    ["no decisions", { decisions: [] }, "decisions", "1 to 100 decisions"],
    [
      "more than 100 decisions",
      {
        decisions: Array.from({ length: 101 }, (_, i) => ({
          ...DEFAULT,
          name: `d${i}`,
        })),
      },
      "decisions",
      "1 to 100 decisions",
    ],
    [
      "an unknown top-level field",
      {
        signals: SIGNALS,
        models: MODELS,
        decisions: [DEFAULT],
        strategy: "confidence",
      },
      "policy.strategy",
      "not a known field",
    ],
    [
      "a bad decision name",
      {
        signals: SIGNALS,
        models: MODELS,
        decisions: [{ ...CODING, name: "has space" }, DEFAULT],
      },
      "decisions[0].name",
      "letters, digits",
    ],
    [
      "a fractional priority",
      {
        signals: SIGNALS,
        models: MODELS,
        decisions: [{ ...CODING, priority: 1.5 }, DEFAULT],
      },
      "decisions[0].priority",
      "whole number",
    ],
    [
      "an unknown onUnknown value",
      {
        signals: SIGNALS,
        models: MODELS,
        decisions: [{ ...CODING, onUnknown: "ignore" }, DEFAULT],
      },
      "decisions[0].onUnknown",
      "must be one of",
    ],
    [
      "onUnknown on the default",
      {
        signals: SIGNALS,
        models: MODELS,
        decisions: [{ ...DEFAULT, onUnknown: "match" }],
      },
      "decisions[0].onUnknown",
      "does not apply to the default",
    ],
    [
      "an unknown decision field",
      {
        signals: SIGNALS,
        models: MODELS,
        decisions: [{ ...CODING, tier: 1 }, DEFAULT],
      },
      "decisions[0].tier",
      "not a known field",
    ],
    [
      "an unknown operator",
      {
        signals: SIGNALS,
        models: MODELS,
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
        signals: SIGNALS,
        models: MODELS,
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
        signals: SIGNALS,
        models: MODELS,
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
      {
        signals: SIGNALS,
        models: MODELS,
        decisions: [{ ...CODING, rules: { type: "keyword" } }, DEFAULT],
      },
      "decisions[0].rules.name",
      "letters, digits",
    ],
    [
      "a signal with an extra field",
      {
        signals: SIGNALS,
        models: MODELS,
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
        signals: SIGNALS,
        models: MODELS,
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
        signals: SIGNALS,
        models: MODELS,
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
        issuesOf({
          signals: SIGNALS,
          models: MODELS,
          decisions: [CODING, { ...CODING, priority: 20 }, DEFAULT],
        }),
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
        parsePolicy({
          signals: SIGNALS,
          models: MODELS,
          decisions: [CODING, { ...DEFAULT, priority: 10 }],
        }).ok,
      ).toBe(true);
    });

    it("requires a default", () => {
      expect(
        issuesOf({ signals: SIGNALS, models: MODELS, decisions: [CODING] }),
      ).toContainEqual({
        path: "decisions",
        message: expect.stringContaining("exactly one default"),
      });
    });

    it("rejects a second default", () => {
      expect(
        issuesOf({
          signals: SIGNALS,
          models: MODELS,
          decisions: [DEFAULT, { name: "other", priority: 1, models: ["m1"] }],
        }),
      ).toContainEqual({
        path: "decisions[1]",
        message: expect.stringContaining("second default"),
      });
    });
  });

  describe("bounds on the rules", () => {
    it("accepts rules 16 levels deep", () => {
      expect(
        parsePolicy({
          signals: SIGNALS,
          models: MODELS,
          decisions: [{ ...CODING, rules: nested(15) }, DEFAULT],
        }).ok,
      ).toBe(true);
    });

    it("rejects rules nested deeper than 16 levels", () => {
      expect(
        issuesOf({
          signals: SIGNALS,
          models: MODELS,
          decisions: [{ ...CODING, rules: nested(16) }, DEFAULT],
        }),
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

  it.each(["constructor", "toString", "__proto__"])(
    "explains an unknown field named %s in words",
    (key) => {
      const input: unknown = JSON.parse(
        `{"models":[{"id":"m1","contextWindow":1}],"decisions":[{"name":"default","priority":0,"models":["m1"]}],"${key}":1}`,
      );
      expect(issuesOf(input)).toEqual([
        {
          path: `policy.${key}`,
          message: expect.stringMatching(/^is not a known field/),
        },
      ]);
    },
  );

  it("still checks an object's other fields when it has an unknown one", () => {
    expect(
      issuesOf({
        signals: SIGNALS,
        models: MODELS,
        decisions: [
          { ...CODING, name: "bad name", priority: 1.5, tier: 1 },
          DEFAULT,
        ],
      }).map((issue) => issue.path),
    ).toEqual([
      "decisions[0].tier",
      "decisions[0].name",
      "decisions[0].priority",
    ]);
  });

  it("reports every problem at once", () => {
    expect(
      issuesOf({
        signals: SIGNALS,
        models: MODELS,
        decisions: [
          { ...CODING, name: "bad name", priority: "high" },
          { name: "x", priority: 1, models: ["m1"] },
          { name: "y", priority: 2, models: ["m1"] },
        ],
      }).map((issue) => issue.path),
    ).toEqual(["decisions[0].name", "decisions[0].priority", "decisions[2]"]);
  });
});

describe("signal declarations", () => {
  const withSignals = (signals: unknown, ...decisions: unknown[]) => ({
    signals,
    models: MODELS,
    decisions: [...decisions, DEFAULT],
  });
  const uses = (type: string, name: string, onUnknown?: string) => ({
    name: "route",
    priority: 1,
    models: ["m1"],
    rules: { type, name },
    ...(onUnknown && { onUnknown }),
  });
  const code = SIGNALS.keyword[0]!;

  it("accepts keyword, fact and external signals", () => {
    const signals = {
      ...SIGNALS,
      fact: [
        ...SIGNALS.fact,
        { name: "tools", fact: "hasTools", equals: true },
        { name: "json", fact: "responseFormat", equals: "json_schema" },
      ],
      external: [{ type: "clef", name: "hard" }],
    };
    expect(
      parsePolicy(withSignals(signals, uses("clef", "hard", "no_match"))),
    ).toMatchObject({ ok: true, value: { signals } });
  });

  it.each([
    [
      "an undeclared signal",
      withSignals(SIGNALS, uses("keyword", "missing")),
      "decisions[0].rules",
      "keyword:missing, which is not declared",
    ],
    [
      "an external signal without onUnknown",
      withSignals(
        { external: [{ type: "clef", name: "hard" }] },
        uses("clef", "hard"),
      ),
      "decisions[0].onUnknown",
      "clef:hard, whose evidence can be unknown",
    ],
    [
      "a keyword signal without onUnknown",
      withSignals(SIGNALS, uses("keyword", "code_terms")),
      "decisions[0].onUnknown",
      "keyword:code_terms, whose evidence can be unknown",
    ],
    [
      "a keyword longer than 200 characters",
      withSignals({ keyword: [{ ...code, keywords: ["😀".repeat(201)] }] }),
      "signals.keyword[0].keywords[0]",
      "1 to 200 characters",
    ],
    [
      "a repeated signal",
      withSignals({ keyword: [code, code] }),
      "signals.keyword[1]",
      "declares keyword:code_terms again",
    ],
    [
      "an external signal using a local type",
      withSignals({ external: [{ type: "keyword", name: "x" }] }),
      "signals.external[0].type",
      "reserved",
    ],
    [
      "a keyword rule with a method",
      withSignals({ keyword: [{ ...code, method: "bm25" }] }),
      "signals.keyword[0].method",
      "matched literally",
    ],
    [
      "a keyword rule with fuzzy matching",
      withSignals({ keyword: [{ ...code, fuzzy_match: true }] }),
      "signals.keyword[0].fuzzy_match",
      "fuzzy matching",
    ],
    [
      "upstream's case_sensitive spelling",
      withSignals({ keyword: [{ ...code, case_sensitive: true }] }),
      "signals.keyword[0].case_sensitive",
      "caseSensitive",
    ],
    [
      "an unknown keyword operator",
      withSignals({ keyword: [{ ...code, operator: "NAND" }] }),
      "signals.keyword[0].operator",
      "AND, OR or NOR",
    ],
    [
      "no keywords",
      withSignals({ keyword: [{ ...code, keywords: [] }] }),
      "signals.keyword[0].keywords",
      "1 to 200",
    ],
    [
      "a blank keyword",
      withSignals({ keyword: [{ ...code, keywords: [" "] }] }),
      "signals.keyword[0].keywords[0]",
      "not only spaces",
    ],
    [
      "an unknown fact",
      withSignals({ fact: [{ name: "f", fact: "temperature", atLeast: 1 }] }),
      "signals.fact[0].fact",
      "must be one of",
    ],
    [
      "a numeric fact without bounds",
      withSignals({ fact: [{ name: "f", fact: "messageCount" }] }),
      "signals.fact[0]",
      "needs atLeast, atMost or both",
    ],
    [
      "bounds the wrong way round",
      withSignals({
        fact: [{ name: "f", fact: "messageCount", atLeast: 5, atMost: 2 }],
      }),
      "signals.fact[0].atMost",
      "not be less than atLeast",
    ],
    [
      "equals on a numeric fact",
      withSignals({
        fact: [{ name: "f", fact: "messageCount", atLeast: 1, equals: 2 }],
      }),
      "signals.fact[0].equals",
      "use atLeast or atMost",
    ],
    [
      "a boolean fact compared to text",
      withSignals({ fact: [{ name: "f", fact: "hasTools", equals: "yes" }] }),
      "signals.fact[0].equals",
      "true or false",
    ],
    [
      "bounds on a boolean fact",
      withSignals({
        fact: [{ name: "f", fact: "stream", equals: true, atLeast: 1 }],
      }),
      "signals.fact[0].atLeast",
      "use equals",
    ],
    [
      "an unknown response format",
      withSignals({
        fact: [{ name: "f", fact: "responseFormat", equals: "xml" }],
      }),
      "signals.fact[0].equals",
      "text, json_object, json_schema",
    ],
  ])("rejects %s", (_name, input, path, message) => {
    expect(issuesOf(input)).toContainEqual({
      path,
      message: expect.stringContaining(message),
    });
  });

  it("counts a keyword's length in characters, not UTF-16 units", () => {
    expect(
      parsePolicy(
        withSignals({ keyword: [{ ...code, keywords: ["😀".repeat(200)] }] }),
      ).ok,
    ).toBe(true);
  });

  it("requires onUnknown when an external signal is anywhere in the rules", () => {
    const decision = {
      name: "route",
      priority: 1,
      models: ["m1"],
      rules: {
        operator: "OR",
        conditions: [
          { type: "keyword", name: "x" },
          { operator: "NOT", conditions: [{ type: "clef", name: "hard" }] },
        ],
      },
    };
    const signals = { ...SIGNALS, external: [{ type: "clef", name: "hard" }] };
    expect(issuesOf(withSignals(signals, decision))).toContainEqual(
      expect.objectContaining({ path: "decisions[0].onUnknown" }),
    );
  });
});

describe("the model catalogue and candidates", () => {
  const policyWith = (models: unknown, decisions: unknown[] = [DEFAULT]) => ({
    models,
    decisions,
  });

  it("keeps known capabilities and leaves unknown ones out", () => {
    const models = [
      {
        id: "@cf/qwen/qwen3.8-27b",
        contextWindow: 262144,
        tools: true,
        source: "catalogue",
      },
      { id: "m1", contextWindow: 100000 },
    ];
    expect(parsePolicy(policyWith(models))).toMatchObject({
      ok: true,
      value: { models },
    });
  });

  it.each([
    ["no catalogue", { decisions: [DEFAULT] }, "models", "non-empty list"],
    ["an empty catalogue", policyWith([]), "models", "non-empty list"],
    [
      "a bad model ID",
      policyWith([{ id: "has space", contextWindow: 1 }]),
      "models[0].id",
      "model ID",
    ],
    [
      "a missing context window",
      policyWith([{ id: "m1" }]),
      "models[0].contextWindow",
      "positive whole number",
    ],
    [
      "a fractional context window",
      policyWith([{ id: "m1", contextWindow: 1.5 }]),
      "models[0].contextWindow",
      "positive whole number",
    ],
    [
      "a capability that is not a boolean",
      policyWith([{ id: "m1", contextWindow: 1, tools: "yes" }]),
      "models[0].tools",
      "left out when unknown",
    ],
    [
      "a repeated model",
      policyWith([
        { id: "m1", contextWindow: 1 },
        { id: "m1", contextWindow: 2 },
      ]),
      "models[1].id",
      "repeats the model of models[0]",
    ],
    [
      "an unknown model field",
      policyWith([{ id: "m1", contextWindow: 1, price: 3 }]),
      "models[0].price",
      "not a known field",
    ],
    [
      "a decision without candidates",
      policyWith(MODELS, [{ name: "default", priority: 0 }]),
      "decisions[0].models",
      "1 to 10",
    ],
    [
      "too many candidates",
      policyWith(MODELS, [
        { ...DEFAULT, models: Array.from({ length: 11 }, () => "m1") },
      ]),
      "decisions[0].models",
      "1 to 10",
    ],
    [
      "a repeated candidate",
      policyWith(
        [
          { id: "m1", contextWindow: 1 },
          { id: "m2", contextWindow: 1 },
        ],
        [{ ...DEFAULT, models: ["m1", "m2", "m1"] }],
      ),
      "decisions[0].models[2]",
      "already a candidate",
    ],
    [
      "a candidate outside the catalogue",
      policyWith(MODELS, [{ ...DEFAULT, models: ["m1", "m9"] }]),
      "decisions[0].models[1]",
      "not in the models list",
    ],
    [
      "a candidate outside a catalogue that has other problems",
      policyWith(
        [{ id: "m1", contextWindow: 0 }],
        [{ ...DEFAULT, models: ["zzz"] }],
      ),
      "decisions[0].models[0]",
      "names zzz, which is not in the models list",
    ],
    [
      "a candidate outside the catalogue in a decision with other problems",
      policyWith(MODELS, [{ ...DEFAULT, priority: 1.5, models: ["zzz"] }]),
      "decisions[0].models[0]",
      "names zzz, which is not in the models list",
    ],
    [
      "a context window of 0",
      policyWith([{ id: "m1", contextWindow: 0 }]),
      "models[0].contextWindow",
      "positive whole number",
    ],
    [
      "a candidate that is not text",
      policyWith(MODELS, [{ ...DEFAULT, models: [7] }]),
      "decisions[0].models[0]",
      "must be a model ID",
    ],
    [
      "a source that is not text",
      policyWith([{ id: "m1", contextWindow: 1, source: 3 }]),
      "models[0].source",
      "must be text",
    ],
  ])("rejects %s", (_name, input, path, message) => {
    expect(issuesOf(input)).toContainEqual({
      path,
      message: expect.stringContaining(message),
    });
  });
});

describe("the pool", () => {
  const policy = {
    models: [
      { id: "m1", contextWindow: 1 },
      { id: "m2", contextWindow: 1 },
    ],
    decisions: [{ ...DEFAULT, models: ["m1"] }],
  };

  it("accepts a catalogue inside the pool", () => {
    expect(parsePolicy(policy, ["m1", "m2", "m3"]).ok).toBe(true);
  });

  it("rejects a catalogue model outside the pool", () => {
    const result = parsePolicy(policy, ["m1"]);
    expect(result.ok ? [] : result.issues).toEqual([
      {
        path: "models[1].id",
        message: "names m2, which is not in the pool every router chooses from",
      },
    ]);
  });
});
