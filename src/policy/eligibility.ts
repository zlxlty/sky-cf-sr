import type { Facts } from "./facts.ts";

/** What one model can do, from a public catalogue. A capability left out is unknown. */
export interface ModelProfile {
  id: string;
  /** In tokens. */
  contextWindow: number;
  tools?: boolean;
  /** JSON mode and JSON-schema responses. */
  structuredOutput?: boolean;
  vision?: boolean;
  /** Where the figures came from, and when. */
  source?: string;
}

/** What a request needs from a model, read from its facts. */
export interface Requirements {
  /** The context estimate; see `Facts.contextTokenEstimate`. */
  contextTokens: number;
  tools: boolean;
  structuredOutput: boolean;
  vision: boolean;
}

export interface Rejection {
  model: string;
  reasons: string[];
}

type Capability = "tools" | "structuredOutput" | "vision";

const CAPABILITY_NAMES: Record<Capability, string> = {
  tools: "tool calling",
  structuredOutput: "structured output",
  vision: "image input",
};

export function requirementsOf(facts: Facts): Requirements {
  return {
    contextTokens: facts.contextTokenEstimate,
    // Sending tool definitions to a model without tool support fails, whether
    // or not a call is forced.
    tools: facts.hasTools,
    structuredOutput: facts.responseFormat !== "text",
    vision: facts.imageCount > 0,
  };
}

/** Why a model cannot serve a request; empty when it can. Unknown support counts against it. */
export function rejectionReasons(
  model: ModelProfile,
  needs: Requirements,
): string[] {
  const reasons: string[] = [];
  if (needs.contextTokens > model.contextWindow) {
    reasons.push(
      `the context estimate of ${needs.contextTokens} tokens exceeds its window of ${model.contextWindow}`,
    );
  }
  for (const capability of Object.keys(CAPABILITY_NAMES) as Capability[]) {
    if (!needs[capability]) continue;
    const name = CAPABILITY_NAMES[capability];
    if (model[capability] === false) {
      reasons.push(`the request needs ${name}, which it does not support`);
    } else if (model[capability] === undefined) {
      reasons.push(`the request needs ${name}, and its support is unknown`);
    }
  }
  return reasons;
}

/**
 * Picks the first candidate that can serve the request. Candidates after it
 * are not considered. With none eligible, `model` is undefined: the caller must
 * fail the request rather than route it anywhere else.
 */
export function chooseModel(
  candidates: readonly string[],
  catalogue: ReadonlyMap<string, ModelProfile>,
  needs: Requirements,
): { model: string | undefined; rejected: Rejection[] } {
  const rejected: Rejection[] = [];
  for (const id of candidates) {
    const profile = catalogue.get(id);
    const reasons = profile
      ? rejectionReasons(profile, needs)
      : ["it is not in the policy's model catalogue"];
    if (reasons.length === 0) return { model: id, rejected };
    rejected.push({ model: id, reasons });
  }
  return { model: undefined, rejected };
}
