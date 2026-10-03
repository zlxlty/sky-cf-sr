/*
 * Many cases here are adapted from vLLM Semantic Router's decision engine tests
 * (src/semantic-router/pkg/decision/*_test.go at commit 590a51c,
 * https://github.com/vllm-project/semantic-router), Copyright 2026 vLLM
 * Semantic Router, licensed under the Apache License, Version 2.0. Each adapted
 * case names the upstream test it comes from.
 */
import { describe, expect, it } from "vitest";
import {
  evaluatePolicy,
  evaluateRules,
  type Decision,
  type Evidence,
  type RuleNode,
  type SignalEvidence,
  type SignalRef,
  type UnknownPolicy,
} from "../../src/policy/rules.ts";

const signal = (type: string, name: string): SignalRef => ({ type, name });
const keyword = (name: string) => signal("keyword", name);
const domain = (name: string) => signal("domain", name);
const classifier = (name: string) => signal("classifier", name);
const and = (...conditions: RuleNode[]): RuleNode => ({
  operator: "AND",
  conditions,
});
const or = (...conditions: RuleNode[]): RuleNode => ({
  operator: "OR",
  conditions,
});
const not = (condition: RuleNode): RuleNode => ({
  operator: "NOT",
  conditions: [condition],
});

const DEFAULT: Decision = { name: "default", priority: 0 };

/** Builds evidence: "matched", "unmatched", or any other text as an unknown reason. */
function evidence(entries: Record<string, string> = {}): Evidence {
  return new Map(
    Object.entries(entries).map(([key, value]): [string, SignalEvidence] => [
      key,
      value === "matched" || value === "unmatched"
        ? { state: value }
        : { state: "unknown", reason: value },
    ]),
  );
}

function selected(decisions: Decision[], given: Evidence) {
  const result = evaluatePolicy({ decisions }, given);
  if (result.outcome !== "selected") {
    throw new Error(`expected a selection, got ${result.outcome}`);
  }
  return result;
}

describe("three-valued rules", () => {
  // Adapted from TestUnknownTruthTable.
  const given = evidence({
    "keyword:present": "matched",
    "classifier:risk": "timeout",
  });
  const truthy = keyword("present");
  const falsy = keyword("missing");
  const unknown = classifier("risk");

  it.each([
    ["NOT unknown", not(unknown), "unknown"],
    ["false AND unknown", and(falsy, unknown), "false"],
    ["true AND unknown", and(truthy, unknown), "unknown"],
    ["true OR unknown", or(truthy, unknown), "true"],
    ["false OR unknown", or(falsy, unknown), "unknown"],
    ["unknown AND false, in that order", and(unknown, falsy), "false"],
    ["unknown OR true, in that order", or(unknown, truthy), "true"],
    ["NOT true", not(truthy), "false"],
    ["NOT false", not(falsy), "true"],
  ] as const)("evaluates %s as %s", (_name, rule, truth) => {
    expect(evaluateRules(rule, given).truth).toBe(truth);
  });

  it("treats a signal with no evidence as not matched", () => {
    // Adapted from TestDecisionEngine_UnsupportedConditionDoesNotMatch.
    expect(evaluateRules(signal("unsupported", "x"), evidence()).truth).toBe(
      "false",
    );
  });

  it("records why evidence was unknown in the trace", () => {
    // Adapted from TestUnknownTraceRecordsErrorAndPolicy.
    const result = evaluateRules(
      and(keyword("present"), classifier("risk")),
      given,
    );
    expect(result.trace).toEqual({
      node: "AND",
      truth: "unknown",
      children: [
        { node: "keyword:present", truth: "true" },
        { node: "classifier:risk", truth: "unknown", reason: "timeout" },
      ],
    });
  });

  it("reports the signals of the OR branch that matched", () => {
    // Adapted from TestUnknownOrTrueMatchesResolvedBranch.
    const result = evaluateRules(
      or(signal("jailbreak", "guard"), keyword("present")),
      evidence({
        "jailbreak:guard": "unavailable",
        "keyword:present": "matched",
      }),
    );
    expect(result).toMatchObject({
      truth: "true",
      matched: ["keyword:present"],
    });
  });

  it("reports every signal of an AND that matched", () => {
    const result = evaluateRules(
      and(keyword("programming"), domain("coding")),
      evidence({
        "keyword:programming": "matched",
        "domain:coding": "matched",
      }),
    );
    expect(result.matched).toEqual(["keyword:programming", "domain:coding"]);
  });
});

describe("choosing a decision", () => {
  const coding = (operator: "AND" | "OR"): Decision => ({
    name: "coding-task",
    priority: 10,
    rules: { operator, conditions: [keyword("programming"), domain("coding")] },
  });

  // Adapted from TestDecisionEngine_EvaluateDecisions.
  it.each([
    [
      "all AND conditions match",
      "AND",
      { "keyword:programming": "matched", "domain:coding": "matched" },
      "coding-task",
    ],
    [
      "partial AND conditions do not match",
      "AND",
      { "keyword:programming": "matched" },
      "default",
    ],
    [
      "one OR condition matches",
      "OR",
      { "keyword:programming": "matched" },
      "coding-task",
    ],
  ] as const)("%s", (_name, operator, given, winner) => {
    const result = selected([coding(operator), DEFAULT], evidence(given));
    expect(result.decision.name).toBe(winner);
  });

  it("chooses the highest priority among matches", () => {
    const result = selected(
      [
        { name: "low-priority-task", priority: 10, rules: keyword("urgent") },
        { name: "high-priority-task", priority: 20, rules: keyword("urgent") },
        DEFAULT,
      ],
      evidence({ "keyword:urgent": "matched" }),
    );
    expect(result.decision.name).toBe("high-priority-task");
    expect(result.ranking).toEqual({
      reason: "priority",
      runnerUp: "low-priority-task",
    });
  });

  describe("NOT", () => {
    // Adapted from TestDecisionEngine_EvaluateDecisionsWithNOTOperator.
    const excludeCoding: Decision = {
      name: "exclude-coding",
      priority: 10,
      rules: not(or(keyword("programming"), domain("coding"))),
    };

    it.each([
      ["no nested condition matches", {}, "exclude-coding"],
      [
        "one nested condition matches",
        { "keyword:programming": "matched" },
        "default",
      ],
      [
        "all nested conditions match",
        { "keyword:programming": "matched", "domain:coding": "matched" },
        "default",
      ],
    ] as const)("when %s", (_name, given, winner) => {
      expect(
        selected([excludeCoding, DEFAULT], evidence(given)).decision.name,
      ).toBe(winner);
    });

    it("lets priority decide between matching NOT decisions", () => {
      const result = selected(
        [
          {
            name: "not-medical-low",
            priority: 5,
            rules: not(domain("medical")),
          },
          {
            name: "not-medical-high",
            priority: 20,
            rules: not(domain("medical")),
          },
          DEFAULT,
        ],
        evidence(),
      );
      expect(result.decision.name).toBe("not-medical-high");
    });
  });

  it("ranks the default after a real match, however high its priority", () => {
    // Adapted from TestCatchAllRanksLastUnderEitherStrategy.
    const result = selected(
      [
        { name: "catch_all", priority: 500 },
        { name: "real_match", priority: 100, rules: domain("law") },
      ],
      evidence({ "domain:law": "matched" }),
    );
    expect(result.decision.name).toBe("real_match");
    expect(result.ranking).toEqual({ reason: "only_match" });
  });

  it("falls back to the default when nothing else matches", () => {
    // Adapted from TestDecisionEngine_OmittedRulesActsAsCatchAll.
    const result = selected(
      [{ name: "law", priority: 10, rules: domain("law") }, DEFAULT],
      evidence(),
    );
    expect(result.decision.name).toBe("default");
    expect(result.ranking).toEqual({ reason: "default" });
    expect(result.matchedSignals).toEqual([]);
  });

  it("lets priority decide however much evidence each decision has", () => {
    // Adapted from TestMultiEvidenceDecisionRanksByPriority.
    const result = selected(
      [
        {
          name: "two_leaf",
          priority: 100,
          rules: and(signal("embedding", "a"), signal("embedding", "b")),
        },
        {
          name: "three_leaf",
          priority: 200,
          rules: and(
            signal("embedding", "a"),
            signal("embedding", "b"),
            domain("law"),
          ),
        },
        DEFAULT,
      ],
      evidence({
        "embedding:a": "matched",
        "embedding:b": "matched",
        "domain:law": "matched",
      }),
    );
    expect(result.decision.name).toBe("three_leaf");
  });

  it("does not depend on the order decisions are listed in", () => {
    const decisions: Decision[] = [
      { name: "a", priority: 1, rules: keyword("x") },
      { name: "b", priority: 2, rules: keyword("x") },
      DEFAULT,
    ];
    const given = evidence({ "keyword:x": "matched" });
    expect(selected(decisions, given).decision.name).toBe("b");
    expect(selected([...decisions].reverse(), given).decision.name).toBe("b");
  });

  it("answers no_match when there is no default and nothing matched", () => {
    expect(
      evaluatePolicy(
        { decisions: [{ name: "law", priority: 1, rules: domain("law") }] },
        evidence(),
      ).outcome,
    ).toBe("no_match");
  });
});

describe("unknown evidence and onUnknown", () => {
  const risky = (onUnknown?: UnknownPolicy): Decision => ({
    name: "route",
    priority: 10,
    rules: classifier("risk"),
    ...(onUnknown && { onUnknown }),
  });
  const timeout = evidence({ "classifier:risk": "timeout" });

  // Adapted from TestOnUnknownPolicies, with a default decision added because
  // this engine requires one.
  it("matches the decision under onUnknown: match", () => {
    const result = selected([risky("match"), DEFAULT], timeout);
    expect(result.decision.name).toBe("route");
    expect(result.matchedSignals).toEqual(["on_unknown:match"]);
    expect(result.traces[0]).toMatchObject({
      truth: "unknown",
      appliedPolicy: "match",
      matched: true,
    });
  });

  it("skips the decision under onUnknown: no_match", () => {
    const result = selected([risky("no_match"), DEFAULT], timeout);
    expect(result.decision.name).toBe("default");
    expect(result.traces[0]).toMatchObject({
      truth: "unknown",
      appliedPolicy: "no_match",
      matched: false,
    });
  });

  it("fails the request under onUnknown: fail_request", () => {
    const result = evaluatePolicy(
      { decisions: [risky("fail_request"), DEFAULT] },
      timeout,
    );
    expect(result).toMatchObject({ outcome: "unresolved", decision: "route" });
  });

  it("fails the request when unknown evidence meets a decision without onUnknown", () => {
    // Upstream keeps a legacy behaviour here; this engine refuses to guess.
    const result = evaluatePolicy({ decisions: [risky(), DEFAULT] }, timeout);
    expect(result.outcome).toBe("unresolved");
    if (result.outcome === "unresolved") {
      expect(result.message).toContain("no onUnknown policy");
    }
  });

  it("applies no policy when the rules resolve despite unknown evidence", () => {
    const decision: Decision = {
      name: "route",
      priority: 10,
      rules: or(classifier("risk"), keyword("present")),
      onUnknown: "fail_request",
    };
    const result = selected(
      [decision, DEFAULT],
      evidence({ "classifier:risk": "timeout", "keyword:present": "matched" }),
    );
    expect(result.decision.name).toBe("route");
    expect(result.traces[0]).not.toHaveProperty("appliedPolicy");
  });

  it("evaluates every decision before failing", () => {
    // Adapted from TestFailRequestEvaluatesAllDecisions.
    const result = evaluatePolicy(
      {
        decisions: [
          {
            name: "guarded",
            priority: 1,
            rules: classifier("risk"),
            onUnknown: "fail_request",
          },
          { name: "route", priority: 2, rules: keyword("present") },
          DEFAULT,
        ],
      },
      evidence({ "classifier:risk": "timeout", "keyword:present": "matched" }),
    );
    expect(result.outcome).toBe("unresolved");
    expect(result.traces.map((t) => [t.decision, t.matched])).toEqual([
      ["guarded", false],
      ["route", true],
      ["default", true],
    ]);
  });

  it.each(["guarded first", "good first"])(
    "fails even when a higher-priority decision matched (%s)",
    (order) => {
      // Adapted from TestFailRequestOverridesHigherPriorityMatch.
      const guarded: Decision = {
        name: "guarded",
        priority: 1,
        rules: classifier("risk"),
        onUnknown: "fail_request",
      };
      const good: Decision = {
        name: "good",
        priority: 100,
        rules: keyword("present"),
      };
      const decisions =
        order === "guarded first"
          ? [guarded, good, DEFAULT]
          : [good, guarded, DEFAULT];
      const result = evaluatePolicy(
        { decisions },
        evidence({
          "classifier:risk": "timeout",
          "keyword:present": "matched",
        }),
      );
      expect(result).toMatchObject({
        outcome: "unresolved",
        decision: "guarded",
      });
    },
  );

  it("explains an unresolved decision", () => {
    // Adapted from TestDecisionUnresolvedErrorDescribesUnknownEvidence.
    const result = evaluatePolicy(
      {
        decisions: [
          {
            name: "guarded",
            priority: 1,
            rules: signal("user_feedback", "wrong_answer"),
            onUnknown: "fail_request",
          },
          DEFAULT,
        ],
      },
      evidence({ "user_feedback:wrong_answer": "user_feedback_uncertain" }),
    );
    if (result.outcome !== "unresolved") throw new Error(result.outcome);
    for (const text of [
      'Decision "guarded"',
      "unknown or unavailable",
      "onUnknown",
    ]) {
      expect(result.message).toContain(text);
    }
    expect(result.traces[0]?.root).toEqual({
      node: "user_feedback:wrong_answer",
      truth: "unknown",
      reason: "user_feedback_uncertain",
    });
  });

  it("reports the first unresolved decision in the policy's order", () => {
    const failing = (name: string, priority: number): Decision => ({
      name,
      priority,
      rules: classifier("risk"),
      onUnknown: "fail_request",
    });
    const result = evaluatePolicy(
      { decisions: [failing("first", 1), failing("second", 2), DEFAULT] },
      timeout,
    );
    expect(result).toMatchObject({ outcome: "unresolved", decision: "first" });
  });
});
