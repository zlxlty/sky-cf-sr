/**
 * The routing policy's rule engine: decisions whose rules combine signal
 * evidence with AND, OR and NOT, where evidence can be unknown.
 *
 * The semantics follow vLLM Semantic Router's decision engine (Apache-2.0,
 * https://github.com/vllm-project/semantic-router, commit 590a51c) for the
 * subset this Worker supports: the priority strategy only, unknown as a third
 * truth value, an `onUnknown` policy on each decision, and a catch-all default.
 */

/** A leaf: a reference to one signal, such as the keyword rule `keyword:code_terms`. */
export interface SignalRef {
  type: string;
  name: string;
}

/** AND and OR take one condition or more, and NOT exactly one. */
export type Combination =
  | { operator: "AND" | "OR"; conditions: readonly [RuleNode, ...RuleNode[]] }
  | { operator: "NOT"; conditions: readonly [RuleNode] };

export type RuleNode = SignalRef | Combination;

/** What a decision means when its rules cannot be resolved because evidence is unknown. */
export type UnknownPolicy = "no_match" | "match" | "fail_request";

export interface Decision {
  /** Identifies the decision in traces and logs; it never affects the order. */
  name: string;
  /** For people. It does not affect routing, but it is part of the policy version. */
  description?: string;
  /** Higher wins, as upstream. Unique among decisions that have rules. */
  priority: number;
  /** Omitted for the one default decision, which matches every request. */
  rules?: RuleNode;
  /**
   * What unknown evidence means for this decision. The validator requires it
   * when the rules use a signal that can be unknown.
   */
  onUnknown?: UnknownPolicy;
}

/** The decisions to choose between. The full policy, with signals and models, is in `policy.ts`. */
export interface RuleSet<D extends Decision = Decision> {
  decisions: readonly D[];
}

export type Truth = "true" | "false" | "unknown";

export type SignalEvidence =
  | { state: "matched" }
  | { state: "unmatched" }
  | { state: "unknown"; reason: string };

/** Evidence keyed by `type:name`. A signal with no entry did not match. */
export type Evidence = ReadonlyMap<string, SignalEvidence>;

/** How one rule node evaluated, for explaining a decision. */
export interface TraceNode {
  /** `type:name` for a signal, or the operator. */
  node: string;
  truth: Truth;
  /** Why a signal's evidence was unknown. */
  reason?: string;
  children?: TraceNode[];
}

export interface DecisionTrace {
  decision: string;
  /** The rules' value before `onUnknown` was applied. */
  truth: Truth;
  appliedPolicy?: UnknownPolicy;
  matched: boolean;
  /** Absent for the default decision, which has no rules. */
  root?: TraceNode;
}

export interface Ranking {
  /**
   * "only_match": no other decision with rules matched. "priority": it beat
   * `runnerUp` on priority. "default": nothing else matched.
   */
  reason: "only_match" | "priority" | "default";
  runnerUp?: string;
}

export type PolicyResult<D extends Decision = Decision> =
  | {
      outcome: "selected";
      decision: D;
      /** The signals that made the decision match, or `on_unknown:match`. */
      matchedSignals: string[];
      ranking: Ranking;
      traces: DecisionTrace[];
    }
  | {
      /** A decision could not be resolved, so the request must fail. */
      outcome: "unresolved";
      decision: string;
      message: string;
      traces: DecisionTrace[];
    }
  | { outcome: "no_match"; traces: DecisionTrace[] };

export function signalKey(signal: SignalRef): string {
  return `${signal.type}:${signal.name}`;
}

export function isSignal(node: RuleNode): node is SignalRef {
  return !("operator" in node);
}

interface NodeResult {
  truth: Truth;
  matched: string[];
  trace: TraceNode;
}

/**
 * Evaluates one rule tree with Kleene's three-valued logic: a false child
 * decides an AND and a true child decides an OR, whatever else is unknown.
 * Every child is evaluated, so the trace is complete.
 */
export function evaluateRules(node: RuleNode, evidence: Evidence): NodeResult {
  if (isSignal(node)) {
    const key = signalKey(node);
    const found = evidence.get(key);
    if (found?.state === "matched") {
      return {
        truth: "true",
        matched: [key],
        trace: { node: key, truth: "true" },
      };
    }
    if (found?.state === "unknown") {
      return {
        truth: "unknown",
        matched: [],
        trace: { node: key, truth: "unknown", reason: found.reason },
      };
    }
    return {
      truth: "false",
      matched: [],
      trace: { node: key, truth: "false" },
    };
  }

  const children = node.conditions.map((child) =>
    evaluateRules(child, evidence),
  );
  const truths = children.map((child) => child.truth);
  let truth: Truth;
  let matched: string[] = [];
  switch (node.operator) {
    case "AND":
      truth = truths.includes("false")
        ? "false"
        : truths.includes("unknown")
          ? "unknown"
          : "true";
      if (truth === "true")
        matched = children.flatMap((child) => child.matched);
      break;
    case "OR": {
      const first = children.find((child) => child.truth === "true");
      truth = first ? "true" : truths.includes("unknown") ? "unknown" : "false";
      if (first) matched = first.matched;
      break;
    }
    case "NOT":
      truth =
        truths[0] === "true"
          ? "false"
          : truths[0] === "false"
            ? "true"
            : "unknown";
      break;
  }
  return {
    truth,
    matched,
    trace: {
      node: node.operator,
      truth,
      children: children.map((c) => c.trace),
    },
  };
}

interface Match<D extends Decision = Decision> {
  decision: D;
  matchedSignals: string[];
}

/**
 * Evaluates every decision, then picks one. A decision whose unknown evidence
 * must fail the request does so even when another decision matched, so every
 * decision is evaluated before anything is chosen. Among matches the default
 * ranks last, then higher priority wins.
 */
export function evaluatePolicy<D extends Decision>(
  policy: RuleSet<D>,
  evidence: Evidence,
): PolicyResult<D> {
  const traces: DecisionTrace[] = [];
  const matches: Match<D>[] = [];
  let failure: { decision: string; message: string } | undefined;

  for (const decision of policy.decisions) {
    if (decision.rules === undefined) {
      traces.push({ decision: decision.name, truth: "true", matched: true });
      matches.push({ decision, matchedSignals: [] });
      continue;
    }
    const result = evaluateRules(decision.rules, evidence);
    let matched = result.truth === "true";
    let matchedSignals = result.matched;
    const appliedPolicy =
      result.truth === "unknown" ? decision.onUnknown : undefined;
    if (result.truth === "unknown") {
      if (appliedPolicy === "match") {
        matched = true;
        matchedSignals = ["on_unknown:match"];
      } else if (appliedPolicy !== "no_match") {
        failure ??= {
          decision: decision.name,
          message: unresolvedMessage(decision.name, appliedPolicy),
        };
      }
    }
    traces.push({
      decision: decision.name,
      truth: result.truth,
      ...(result.truth === "unknown" && { appliedPolicy }),
      matched,
      root: result.trace,
    });
    if (matched) matches.push({ decision, matchedSignals });
  }

  if (failure) return { outcome: "unresolved", ...failure, traces };
  if (matches.length === 0) return { outcome: "no_match", traces };

  matches.sort(compareMatches);
  const [winner, runnerUp] = matches as [Match<D>, Match<D> | undefined];
  return {
    outcome: "selected",
    decision: winner.decision,
    matchedSignals: winner.matchedSignals,
    ranking: rankingOf(winner, runnerUp),
    traces,
  };
}

function compareMatches(left: Match, right: Match): number {
  const leftDefault = left.decision.rules === undefined;
  const rightDefault = right.decision.rules === undefined;
  if (leftDefault !== rightDefault) return leftDefault ? 1 : -1;
  if (left.decision.priority !== right.decision.priority) {
    return right.decision.priority - left.decision.priority;
  }
  return left.decision.name < right.decision.name ? -1 : 1;
}

function rankingOf(winner: Match, runnerUp: Match | undefined): Ranking {
  if (winner.decision.rules === undefined) return { reason: "default" };
  if (runnerUp === undefined || runnerUp.decision.rules === undefined) {
    return { reason: "only_match" };
  }
  return { reason: "priority", runnerUp: runnerUp.decision.name };
}

function unresolvedMessage(
  decision: string,
  policy: UnknownPolicy | undefined,
): string {
  const because =
    policy === undefined
      ? "it has no onUnknown policy"
      : "its onUnknown policy is fail_request";
  return `Decision "${decision}" could not be resolved because required signal evidence is unknown or unavailable, and ${because}.`;
}
