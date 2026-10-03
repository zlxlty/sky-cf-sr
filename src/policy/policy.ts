import { shortHash } from "../hash.ts";
import {
  chooseModel,
  requirementsOf,
  type ModelProfile,
  type Rejection,
  type Requirements,
} from "./eligibility.ts";
import { extractFacts, type Facts } from "./facts.ts";
import {
  evaluatePolicy,
  type Decision,
  type DecisionTrace,
  type Evidence,
  type Ranking,
} from "./rules.ts";
import { compileSignals, type Signals } from "./signals.ts";
import { parsePolicy, type PolicyIssue } from "./validate.ts";

export interface RoutedDecision extends Decision {
  /** Candidate models in order; the first one eligible for the request is chosen. */
  models: readonly string[];
}

/** A complete routing policy, as written in a policy file and checked by `parsePolicy`. */
export interface Policy {
  description?: string;
  signals: Signals;
  /** The models decisions may name, with their capabilities. */
  models: readonly ModelProfile[];
  decisions: readonly RoutedDecision[];
}

export class PolicyError extends Error {
  constructor(readonly issues: PolicyIssue[]) {
    super(
      `The policy is invalid: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
    );
  }
}

/** A validated policy, compiled once and identified by a hash of its content. */
export interface LoadedPolicy {
  policy: Policy;
  version: string;
  catalogue: ReadonlyMap<string, ModelProfile>;
  evidenceFor: (facts: Facts, external?: Evidence) => Evidence;
}

interface Explained {
  policyVersion: string;
  traces: DecisionTrace[];
}

interface Chosen extends Explained {
  decision: string;
  matchedSignals: string[];
  ranking: Ranking;
  requirements: Requirements;
  /** Candidates before the chosen one, or all of them, and why each was passed over. */
  rejected: Rejection[];
}

export type RouteResult =
  | ({ outcome: "routed"; model: string } & Chosen)
  | ({ outcome: "no_eligible_model" } & Chosen)
  | ({ outcome: "unresolved"; decision: string; message: string } & Explained);

/**
 * Validates and compiles a policy. Its catalogue may name only `pool` models:
 * the ones the Auto Router is given, so both routers choose from the same set.
 */
export async function loadPolicy(
  input: unknown,
  pool: readonly string[],
): Promise<LoadedPolicy> {
  const parsed = parsePolicy(input, pool);
  if (!parsed.ok) throw new PolicyError(parsed.issues);
  const policy = parsed.value;
  return {
    policy,
    // The parsed policy has a fixed key order, so equal policies hash equally.
    version: await shortHash(JSON.stringify(policy)),
    catalogue: new Map(policy.models.map((model) => [model.id, model])),
    evidenceFor: compileSignals(policy.signals),
  };
}

/**
 * Routes one request: facts, then evidence, then a decision, then the first
 * eligible model in that decision's list. External evidence, such as a signal
 * model's answers, is passed in; without it external signals are unknown.
 */
export function routeRequest(
  loaded: LoadedPolicy,
  body: Record<string, unknown>,
  external?: Evidence,
): RouteResult {
  const facts = extractFacts(body);
  const result = evaluatePolicy(
    loaded.policy,
    loaded.evidenceFor(facts, external),
  );
  const explained = { policyVersion: loaded.version, traces: result.traces };

  switch (result.outcome) {
    case "unresolved":
      return {
        outcome: "unresolved",
        decision: result.decision,
        message: result.message,
        ...explained,
      };
    case "no_match":
      throw new Error("A validated policy always has a default decision");
    case "selected": {
      const requirements = requirementsOf(facts);
      const { model, rejected } = chooseModel(
        result.decision.models,
        loaded.catalogue,
        requirements,
      );
      const chosen: Chosen = {
        decision: result.decision.name,
        matchedSignals: result.matchedSignals,
        ranking: result.ranking,
        requirements,
        rejected,
        ...explained,
      };
      return model === undefined
        ? { outcome: "no_eligible_model", ...chosen }
        : { outcome: "routed", model, ...chosen };
    }
  }
}
