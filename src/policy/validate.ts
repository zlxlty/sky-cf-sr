import type { Decision, Policy, RuleNode, UnknownPolicy } from "./rules.ts";

/** One problem in a policy, located by a path such as `decisions[1].rules.conditions[0]`. */
export interface PolicyIssue {
  path: string;
  message: string;
}

export type Parsed<T> =
  { ok: true; value: T } | { ok: false; issues: PolicyIssue[] };

const NAME_PATTERN = /^[A-Za-z0-9][\w.-]{0,63}$/;
const UNKNOWN_POLICIES: readonly UnknownPolicy[] = [
  "no_match",
  "match",
  "fail_request",
];
// Upstream fields with no equivalent here get a specific message, since a generic
// "not a known field" would not say what to write instead.
const LEGACY_RULE_FIELDS: Record<string, string> = {
  on_unknown:
    "belongs on the decision, as onUnknown, not inside its rules; it applies to the whole rule tree",
  onUnknown:
    "belongs on the decision, not inside its rules; it applies to the whole rule tree",
  on_error:
    "is not supported, because it treats a failure as false even under NOT; use the decision's onUnknown",
};
// Bounds on a decision's rule tree, so evaluation cost stays small and predictable.
const MAX_RULE_DEPTH = 16;
const MAX_RULE_NODES = 256;

/**
 * Checks a policy and returns it typed, or every problem found. Fields the
 * schema does not define are rejected rather than ignored.
 */
export function parsePolicy(input: unknown): Parsed<Policy> {
  const issues: PolicyIssue[] = [];
  const policy = readPolicy(input, issues);
  return issues.length === 0 && policy
    ? { ok: true, value: policy }
    : { ok: false, issues };
}

function readPolicy(input: unknown, issues: PolicyIssue[]): Policy | undefined {
  const fields = readObject(input, "policy", ["decisions"], issues);
  if (!fields) return undefined;
  if (!Array.isArray(fields.decisions) || fields.decisions.length === 0) {
    issues.push({
      path: "decisions",
      message: "must be a non-empty list of decisions",
    });
    return undefined;
  }
  const decisions = fields.decisions.map((value, i) =>
    readDecision(value, `decisions[${i}]`, issues),
  );
  checkDecisionSet(decisions, issues);
  return decisions.every((d) => d !== undefined)
    ? { decisions: decisions as Decision[] }
    : undefined;
}

function readDecision(
  value: unknown,
  path: string,
  issues: PolicyIssue[],
): Decision | undefined {
  const fields = readObject(
    value,
    path,
    ["name", "description", "priority", "rules", "onUnknown"],
    issues,
  );
  if (!fields) return undefined;
  const before = issues.length;

  if (typeof fields.name !== "string" || !NAME_PATTERN.test(fields.name)) {
    issues.push({
      path: `${path}.name`,
      message:
        "must be 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit",
    });
  }
  if (
    fields.description !== undefined &&
    typeof fields.description !== "string"
  ) {
    issues.push({ path: `${path}.description`, message: "must be text" });
  }
  if (!Number.isSafeInteger(fields.priority)) {
    issues.push({
      path: `${path}.priority`,
      message: "must be a whole number",
    });
  }
  const rules =
    fields.rules === undefined
      ? undefined
      : readRule(fields.rules, `${path}.rules`, 1, { nodes: 0 }, issues);
  const onUnknown = fields.onUnknown;
  if (
    onUnknown !== undefined &&
    !UNKNOWN_POLICIES.includes(onUnknown as UnknownPolicy)
  ) {
    issues.push({
      path: `${path}.onUnknown`,
      message: `must be one of ${UNKNOWN_POLICIES.join(", ")}`,
    });
  }
  if (fields.rules === undefined && onUnknown !== undefined) {
    issues.push({
      path: `${path}.onUnknown`,
      message:
        "does not apply to the default decision, which has no rules and so cannot be unknown",
    });
  }

  if (issues.length > before) return undefined;
  return {
    name: fields.name as string,
    priority: fields.priority as number,
    ...(rules && { rules }),
    ...(onUnknown !== undefined && { onUnknown: onUnknown as UnknownPolicy }),
  };
}

function readRule(
  value: unknown,
  path: string,
  depth: number,
  counter: { nodes: number },
  issues: PolicyIssue[],
): RuleNode | undefined {
  counter.nodes += 1;
  if (counter.nodes === MAX_RULE_NODES + 1) {
    issues.push({
      path,
      message: `the rules have more than ${MAX_RULE_NODES} nodes`,
    });
  }
  if (depth > MAX_RULE_DEPTH) {
    issues.push({
      path,
      message: `the rules are nested more than ${MAX_RULE_DEPTH} levels deep`,
    });
    return undefined;
  }
  if (isObject(value) && "operator" in value) {
    const fields = readObject(
      value,
      path,
      ["operator", "conditions"],
      issues,
      LEGACY_RULE_FIELDS,
    );
    if (!fields) return undefined;
    const { operator, conditions } = fields;
    if (operator !== "AND" && operator !== "OR" && operator !== "NOT") {
      issues.push({
        path: `${path}.operator`,
        message: "must be AND, OR or NOT",
      });
      return undefined;
    }
    if (!Array.isArray(conditions)) {
      issues.push({
        path: `${path}.conditions`,
        message: "must be a list of rules",
      });
      return undefined;
    }
    if (operator === "NOT" && conditions.length !== 1) {
      issues.push({
        path: `${path}.conditions`,
        message: "NOT takes exactly one condition",
      });
      return undefined;
    }
    if (conditions.length === 0) {
      issues.push({
        path: `${path}.conditions`,
        message: `${operator} needs at least one condition; a decision that matches everything is written without rules`,
      });
      return undefined;
    }
    const children = conditions.map((child, i) =>
      readRule(child, `${path}.conditions[${i}]`, depth + 1, counter, issues),
    );
    return children.every((c) => c !== undefined)
      ? { operator, conditions: children as RuleNode[] }
      : undefined;
  }

  const fields = readObject(
    value,
    path,
    ["type", "name"],
    issues,
    LEGACY_RULE_FIELDS,
  );
  if (!fields) return undefined;
  let valid = true;
  for (const key of ["type", "name"] as const) {
    const text = fields[key];
    if (typeof text !== "string" || !NAME_PATTERN.test(text)) {
      issues.push({
        path: `${path}.${key}`,
        message:
          "must be 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit",
      });
      valid = false;
    }
  }
  return valid
    ? { type: fields.type as string, name: fields.name as string }
    : undefined;
}

function checkDecisionSet(
  decisions: (Decision | undefined)[],
  issues: PolicyIssue[],
): void {
  const names = new Map<string, number>();
  const priorities = new Map<number, number>();
  const defaults: number[] = [];
  decisions.forEach((decision, i) => {
    if (!decision) return;
    const seen = names.get(decision.name);
    if (seen !== undefined) {
      issues.push({
        path: `decisions[${i}].name`,
        message: `repeats the name of decisions[${seen}]`,
      });
    } else {
      names.set(decision.name, i);
    }
    if (decision.rules === undefined) {
      defaults.push(i);
      return;
    }
    const samePriority = priorities.get(decision.priority);
    if (samePriority !== undefined) {
      issues.push({
        path: `decisions[${i}].priority`,
        message: `equals the priority of decisions[${samePriority}]; priorities must be unique so the order never depends on names`,
      });
    } else {
      priorities.set(decision.priority, i);
    }
  });
  if (defaults.length === 0 && decisions.every((d) => d !== undefined)) {
    issues.push({
      path: "decisions",
      message:
        "needs exactly one default decision, written without rules, so every request has a route",
    });
  }
  for (const i of defaults.slice(1)) {
    issues.push({
      path: `decisions[${i}]`,
      message: `is a second default decision; decisions[${defaults[0]}] is already the default`,
    });
  }
}

function readObject(
  value: unknown,
  path: string,
  allowed: readonly string[],
  issues: PolicyIssue[],
  explained: Record<string, string> = {},
): Record<string, unknown> | undefined {
  if (!isObject(value)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  let valid = true;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push({
        path: `${path}.${key}`,
        message:
          explained[key] ??
          `is not a known field; expected ${allowed.join(", ")}`,
      });
      valid = false;
    }
  }
  return valid ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
