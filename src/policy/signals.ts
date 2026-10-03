import { MAX_PROJECTED_CHARS, type Facts } from "./facts.ts";
import { compileKeywordRule, type KeywordOperator } from "./keywords.ts";
import type { Evidence, SignalEvidence } from "./rules.ts";

/**
 * Matches the latest user message against literal keywords. Referenced as
 * `keyword:<name>`. Unknown when the message was too long to search whole and
 * the unsearched rest could change the answer.
 */
export interface KeywordSignal {
  name: string;
  operator: KeywordOperator;
  keywords: readonly string[];
  caseSensitive?: boolean;
}

export type NumericFact =
  | "messageCount"
  | "userMessageCount"
  | "toolResultCount"
  | "imageCount"
  | "contextTokenEstimate";
export type BooleanFact =
  "hasTools" | "requiresToolCall" | "stream" | "latestUserTextTruncated";

/** A threshold or equality on one fact. Referenced as `fact:<name>`. */
export type FactSignal =
  | { name: string; fact: NumericFact; atLeast?: number; atMost?: number }
  | { name: string; fact: BooleanFact; equals: boolean }
  | {
      name: string;
      fact: "responseFormat";
      equals: Facts["responseFormat"];
    };

/**
 * A signal whose evidence comes from outside the policy, such as a signal
 * model's answer. Referenced as `<type>:<name>`. Its evidence can be unknown.
 */
export interface ExternalSignal {
  type: string;
  name: string;
}

export interface Signals {
  keyword?: readonly KeywordSignal[];
  fact?: readonly FactSignal[];
  external?: readonly ExternalSignal[];
}

export const NUMERIC_FACTS: readonly NumericFact[] = [
  "messageCount",
  "userMessageCount",
  "toolResultCount",
  "imageCount",
  "contextTokenEstimate",
];
export const BOOLEAN_FACTS: readonly BooleanFact[] = [
  "hasTools",
  "requiresToolCall",
  "stream",
  "latestUserTextTruncated",
];
export const RESPONSE_FORMATS: readonly Facts["responseFormat"][] = [
  "text",
  "json_object",
  "json_schema",
];
/** Signal types the policy evaluates itself; external signals may not use them. */
export const LOCAL_SIGNAL_TYPES = ["keyword", "fact"];

const MATCHED: SignalEvidence = { state: "matched" };
const UNMATCHED: SignalEvidence = { state: "unmatched" };
const NOT_SUPPLIED: SignalEvidence = {
  state: "unknown",
  reason: "no evidence was supplied for this signal",
};
const CUT: SignalEvidence = {
  state: "unknown",
  reason: `only the first ${MAX_PROJECTED_CHARS} characters of the latest user message were searched, and the rest could change the result`,
};

/**
 * Compiles the declared signals once, and returns a function that produces
 * the evidence for one request. Fact signals are always resolved, and keyword
 * signals unless the message was cut. An external signal takes its evidence
 * from `external`, and is unknown when none was supplied.
 */
export function compileSignals(
  signals: Signals,
): (facts: Facts, external?: Evidence) => Evidence {
  const keywordTests = (signals.keyword ?? []).map((signal) => ({
    key: `keyword:${signal.name}`,
    test: compileKeywordRule(
      signal.operator,
      signal.keywords,
      signal.caseSensitive ?? false,
    ),
  }));

  return (facts, external = new Map()) => {
    const evidence = new Map<string, SignalEvidence>();
    for (const { key, test } of keywordTests) {
      const found = test(facts.latestUserText, facts.latestUserTextTruncated);
      evidence.set(
        key,
        found === undefined ? CUT : found ? MATCHED : UNMATCHED,
      );
    }
    for (const signal of signals.fact ?? []) {
      evidence.set(
        `fact:${signal.name}`,
        factHolds(signal, facts) ? MATCHED : UNMATCHED,
      );
    }
    for (const signal of signals.external ?? []) {
      const key = `${signal.type}:${signal.name}`;
      evidence.set(key, external.get(key) ?? NOT_SUPPLIED);
    }
    return evidence;
  };
}

function factHolds(signal: FactSignal, facts: Facts): boolean {
  if ("equals" in signal) return facts[signal.fact] === signal.equals;
  const value = facts[signal.fact];
  return (
    (signal.atLeast === undefined || value >= signal.atLeast) &&
    (signal.atMost === undefined || value <= signal.atMost)
  );
}
