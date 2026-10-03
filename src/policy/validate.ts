import type { ModelProfile } from "./eligibility.ts";
import type { Policy, RoutedDecision } from "./policy.ts";
import {
  isSignal,
  signalKey,
  type Decision,
  type RuleNode,
  type UnknownPolicy,
} from "./rules.ts";
import {
  BOOLEAN_FACTS,
  LOCAL_SIGNAL_TYPES,
  NUMERIC_FACTS,
  RESPONSE_FORMATS,
  type ExternalSignal,
  type FactSignal,
  type KeywordSignal,
  type Signals,
} from "./signals.ts";

/** One problem in a policy, located by a path such as `decisions[1].rules.conditions[0]`. */
export interface PolicyIssue {
  path: string;
  message: string;
}

export type Parsed<T> =
  { ok: true; value: T } | { ok: false; issues: PolicyIssue[] };

// Names leave out ":", so a signal key such as "keyword:code_terms" splits one way only.
const NAME_PATTERN = /^[A-Za-z0-9][\w.-]{0,63}$/;
// A model ID as AI Gateway names it, such as "@cf/qwen/qwen3.8-27b".
const MODEL_ID_PATTERN = /^[\w@./:-]{1,128}$/;
const MAX_CANDIDATES = 10;
const MAX_DECISIONS = 100;
const UNKNOWN_POLICIES: readonly UnknownPolicy[] = [
  "no_match",
  "match",
  "fail_request",
];
// Upstream fields with no equivalent here get a specific message, since a generic
// "not a known field" would not say what to write instead. Upstream writes the
// unknown policy as `on_unknown` at the root of the rules; here it is only the
// decision's `onUnknown`.
const LEGACY_RULE_FIELDS: Record<string, string> = {
  on_unknown:
    "belongs on the decision, as onUnknown, not inside its rules; it applies to the whole rule tree",
  onUnknown:
    "belongs on the decision, not inside its rules; it applies to the whole rule tree",
  on_error:
    "is not supported, because it treats a failure as false even under NOT; use the decision's onUnknown",
};
// Upstream keyword-rule fields with no equivalent here.
const UNSUPPORTED_KEYWORD_FIELDS: Record<string, string> = {
  method:
    "is not supported; keywords are matched literally, and regex, BM25 and n-gram matching are not available",
  fuzzy_match: "is not supported; fuzzy matching is not available",
  fuzzy_threshold: "is not supported; fuzzy matching is not available",
  bm25_threshold: "is not supported; BM25 matching is not available",
  ngram_threshold: "is not supported; n-gram matching is not available",
  ngram_arity: "is not supported; n-gram matching is not available",
  case_sensitive: "is written caseSensitive here",
};
const MAX_KEYWORDS = 200;
const MAX_KEYWORD_LENGTH = 200;
// Bounds on each decision's rule tree; with MAX_DECISIONS, they keep evaluation
// cost small and predictable.
const MAX_RULE_DEPTH = 16;
const MAX_RULE_NODES = 256;

/**
 * Checks a policy and returns it typed, or every problem found. Fields the
 * schema does not define are rejected rather than ignored. With a `pool`, the
 * model catalogue may name only models in it.
 */
export function parsePolicy(
  input: unknown,
  pool?: readonly string[],
): Parsed<Policy> {
  const issues: PolicyIssue[] = [];
  const policy = readPolicy(input, pool, issues);
  return issues.length === 0 && policy
    ? { ok: true, value: policy }
    : { ok: false, issues };
}

function readPolicy(
  input: unknown,
  pool: readonly string[] | undefined,
  issues: PolicyIssue[],
): Policy | undefined {
  const fields = readObject(
    input,
    "policy",
    ["description", "signals", "models", "decisions"],
    issues,
  );
  if (!fields) return undefined;
  if (
    fields.description !== undefined &&
    typeof fields.description !== "string"
  ) {
    issues.push({ path: "description", message: "must be text" });
  }
  const signals =
    fields.signals === undefined
      ? {}
      : readSignals(fields.signals, "signals", issues);
  const models = readModels(fields.models, "models", issues);
  if (pool) checkPool(fields.models, pool, issues);
  if (
    !Array.isArray(fields.decisions) ||
    fields.decisions.length === 0 ||
    fields.decisions.length > MAX_DECISIONS
  ) {
    issues.push({
      path: "decisions",
      message: `must be a list of 1 to ${MAX_DECISIONS} decisions`,
    });
    return undefined;
  }
  const decisions = fields.decisions.map((value, i) =>
    readDecision(value, `decisions[${i}]`, issues),
  );
  checkDecisionSet(decisions, issues);
  if (signals) checkReferences(decisions, signals, issues);
  checkModelReferences(fields.models, fields.decisions, issues);
  return signals && models && decisions.every((d) => d !== undefined)
    ? {
        ...(typeof fields.description === "string" && {
          description: fields.description,
        }),
        signals,
        models,
        decisions: decisions as RoutedDecision[],
      }
    : undefined;
}

function readModels(
  value: unknown,
  path: string,
  issues: PolicyIssue[],
): ModelProfile[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({
      path,
      message: "must be a non-empty list of the models decisions may name",
    });
    return undefined;
  }
  const before = issues.length;
  const seen = new Map<string, number>();
  const models = value.map((item, i) => {
    const model = readModel(item, `${path}[${i}]`, issues);
    if (!model) return undefined;
    const first = seen.get(model.id);
    if (first !== undefined) {
      issues.push({
        path: `${path}[${i}].id`,
        message: `repeats the model of ${path}[${first}]`,
      });
    } else {
      seen.set(model.id, i);
    }
    return model;
  });
  return issues.length > before ? undefined : (models as ModelProfile[]);
}

function readModel(
  value: unknown,
  path: string,
  issues: PolicyIssue[],
): ModelProfile | undefined {
  const fields = readObject(
    value,
    path,
    ["id", "contextWindow", "tools", "structuredOutput", "vision", "source"],
    issues,
  );
  if (!fields) return undefined;
  const before = issues.length;
  if (typeof fields.id !== "string" || !MODEL_ID_PATTERN.test(fields.id)) {
    issues.push({
      path: `${path}.id`,
      message: "must be a model ID as AI Gateway names it",
    });
  }
  const window = fields.contextWindow;
  if (
    typeof window !== "number" ||
    !Number.isSafeInteger(window) ||
    window <= 0
  ) {
    issues.push({
      path: `${path}.contextWindow`,
      message: "must be a positive whole number of tokens",
    });
  }
  for (const key of ["tools", "structuredOutput", "vision"] as const) {
    if (fields[key] !== undefined && typeof fields[key] !== "boolean") {
      issues.push({
        path: `${path}.${key}`,
        message: "must be true or false, or left out when unknown",
      });
    }
  }
  if (fields.source !== undefined && typeof fields.source !== "string") {
    issues.push({ path: `${path}.source`, message: "must be text" });
  }
  if (issues.length > before) return undefined;
  return {
    id: fields.id as string,
    contextWindow: window as number,
    ...(fields.tools !== undefined && { tools: fields.tools as boolean }),
    ...(fields.structuredOutput !== undefined && {
      structuredOutput: fields.structuredOutput as boolean,
    }),
    ...(fields.vision !== undefined && { vision: fields.vision as boolean }),
    ...(fields.source !== undefined && { source: fields.source as string }),
  };
}

/** The catalogue may name only pool models, so every router chooses from the same ones. */
function checkPool(
  models: unknown,
  pool: readonly string[],
  issues: PolicyIssue[],
): void {
  if (!Array.isArray(models)) return;
  models.forEach((model, i) => {
    if (
      isObject(model) &&
      typeof model.id === "string" &&
      !pool.includes(model.id)
    ) {
      issues.push({
        path: `models[${i}].id`,
        message: `names ${model.id}, which is not in the pool every router chooses from`,
      });
    }
  });
}

/**
 * Every model a decision names must be in the catalogue. This reads the raw
 * input, so an unknown candidate is reported even when the catalogue or the
 * decision has other problems.
 */
function checkModelReferences(
  models: unknown,
  decisions: unknown[],
  issues: PolicyIssue[],
): void {
  // Without a catalogue list every candidate would be unknown; that is reported already.
  if (!Array.isArray(models)) return;
  const known = new Set(
    models.flatMap((model) =>
      isObject(model) && typeof model.id === "string" ? [model.id] : [],
    ),
  );
  decisions.forEach((decision, i) => {
    if (!isObject(decision) || !Array.isArray(decision.models)) return;
    decision.models.forEach((id: unknown, j) => {
      if (typeof id === "string" && !known.has(id)) {
        issues.push({
          path: `decisions[${i}].models[${j}]`,
          message: `names ${id}, which is not in the models list`,
        });
      }
    });
  });
}

function readSignals(
  value: unknown,
  path: string,
  issues: PolicyIssue[],
): Signals | undefined {
  const fields = readObject(
    value,
    path,
    ["keyword", "fact", "external"],
    issues,
  );
  if (!fields) return undefined;
  const before = issues.length;
  const keyword = readList(
    fields.keyword,
    `${path}.keyword`,
    issues,
    readKeywordSignal,
  );
  const fact = readList(fields.fact, `${path}.fact`, issues, readFactSignal);
  const external = readList(
    fields.external,
    `${path}.external`,
    issues,
    readExternalSignal,
  );
  const seen = new Map<string, string>();
  const lists: [
    string,
    readonly ({ name: string; type?: string } | undefined)[],
  ][] = [
    ["keyword", keyword ?? []],
    ["fact", fact ?? []],
    ["external", external ?? []],
  ];
  for (const [list, items] of lists) {
    items.forEach((item, i) => {
      if (!item) return;
      const key = `${item.type ?? list}:${item.name}`;
      const itemPath = `${path}.${list}[${i}]`;
      const first = seen.get(key);
      if (first !== undefined) {
        issues.push({
          path: itemPath,
          message: `declares ${key} again; ${first} already does`,
        });
      } else {
        seen.set(key, itemPath);
      }
    });
  }
  if (issues.length > before) return undefined;
  return {
    ...(keyword && { keyword: keyword as KeywordSignal[] }),
    ...(fact && { fact: fact as FactSignal[] }),
    ...(external && { external: external as ExternalSignal[] }),
  };
}

function readList<T>(
  value: unknown,
  path: string,
  issues: PolicyIssue[],
  read: (item: unknown, path: string, issues: PolicyIssue[]) => T | undefined,
): (T | undefined)[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be a list" });
    return undefined;
  }
  return value.map((item, i) => read(item, `${path}[${i}]`, issues));
}

function readKeywordSignal(
  value: unknown,
  path: string,
  issues: PolicyIssue[],
): KeywordSignal | undefined {
  const fields = readObject(
    value,
    path,
    ["name", "operator", "keywords", "caseSensitive"],
    issues,
    UNSUPPORTED_KEYWORD_FIELDS,
  );
  if (!fields) return undefined;
  const before = issues.length;
  checkName(fields.name, `${path}.name`, issues);
  const { operator, keywords, caseSensitive } = fields;
  if (operator !== "AND" && operator !== "OR" && operator !== "NOR") {
    issues.push({
      path: `${path}.operator`,
      message: "must be AND, OR or NOR",
    });
  }
  if (
    !Array.isArray(keywords) ||
    keywords.length === 0 ||
    keywords.length > MAX_KEYWORDS
  ) {
    issues.push({
      path: `${path}.keywords`,
      message: `must be a list of 1 to ${MAX_KEYWORDS} keywords`,
    });
  } else {
    keywords.forEach((keyword, i) => {
      if (
        typeof keyword !== "string" ||
        keyword.trim() === "" ||
        [...keyword].length > MAX_KEYWORD_LENGTH
      ) {
        issues.push({
          path: `${path}.keywords[${i}]`,
          message: `must be text of 1 to ${MAX_KEYWORD_LENGTH} characters, not only spaces`,
        });
      }
    });
  }
  if (caseSensitive !== undefined && typeof caseSensitive !== "boolean") {
    issues.push({
      path: `${path}.caseSensitive`,
      message: "must be true or false",
    });
  }
  if (issues.length > before) return undefined;
  return {
    name: fields.name as string,
    operator: operator as KeywordSignal["operator"],
    keywords: keywords as string[],
    ...(caseSensitive !== undefined && {
      caseSensitive: caseSensitive as boolean,
    }),
  };
}

function readFactSignal(
  value: unknown,
  path: string,
  issues: PolicyIssue[],
): FactSignal | undefined {
  const fields = readObject(
    value,
    path,
    ["name", "fact", "atLeast", "atMost", "equals"],
    issues,
  );
  if (!fields) return undefined;
  const before = issues.length;
  checkName(fields.name, `${path}.name`, issues);
  const { fact, atLeast, atMost, equals } = fields;
  const name = fields.name as string;

  if (NUMERIC_FACTS.includes(fact as never)) {
    for (const [key, bound] of [
      ["atLeast", atLeast],
      ["atMost", atMost],
    ] as const) {
      if (
        bound !== undefined &&
        (typeof bound !== "number" || !Number.isFinite(bound))
      ) {
        issues.push({ path: `${path}.${key}`, message: "must be a number" });
      }
    }
    if (atLeast === undefined && atMost === undefined) {
      issues.push({ path, message: `${fact} needs atLeast, atMost or both` });
    }
    if (
      typeof atLeast === "number" &&
      typeof atMost === "number" &&
      atLeast > atMost
    ) {
      issues.push({
        path: `${path}.atMost`,
        message: "must not be less than atLeast",
      });
    }
    if (equals !== undefined) {
      issues.push({
        path: `${path}.equals`,
        message: `does not apply to ${fact}; use atLeast or atMost`,
      });
    }
    if (issues.length > before) return undefined;
    return {
      name,
      fact: fact as FactSignal["fact"] & string,
      ...(atLeast !== undefined && { atLeast: atLeast as number }),
      ...(atMost !== undefined && { atMost: atMost as number }),
    } as FactSignal;
  }

  const isBoolean = BOOLEAN_FACTS.includes(fact as never);
  if (!isBoolean && fact !== "responseFormat") {
    issues.push({
      path: `${path}.fact`,
      message: `must be one of ${[...NUMERIC_FACTS, ...BOOLEAN_FACTS, "responseFormat"].join(", ")}`,
    });
    return undefined;
  }
  for (const key of ["atLeast", "atMost"] as const) {
    if (fields[key] !== undefined) {
      issues.push({
        path: `${path}.${key}`,
        message: `does not apply to ${fact}; use equals`,
      });
    }
  }
  if (isBoolean && typeof equals !== "boolean") {
    issues.push({ path: `${path}.equals`, message: "must be true or false" });
  }
  if (!isBoolean && !RESPONSE_FORMATS.includes(equals as never)) {
    issues.push({
      path: `${path}.equals`,
      message: `must be one of ${RESPONSE_FORMATS.join(", ")}`,
    });
  }
  if (issues.length > before) return undefined;
  return { name, fact, equals } as FactSignal;
}

function readExternalSignal(
  value: unknown,
  path: string,
  issues: PolicyIssue[],
): ExternalSignal | undefined {
  const fields = readObject(value, path, ["type", "name"], issues);
  if (!fields) return undefined;
  const before = issues.length;
  checkName(fields.type, `${path}.type`, issues);
  checkName(fields.name, `${path}.name`, issues);
  if (LOCAL_SIGNAL_TYPES.includes(fields.type as string)) {
    issues.push({
      path: `${path}.type`,
      message: `is reserved for signals the policy evaluates itself; declare them under signals.${fields.type as string}`,
    });
  }
  if (issues.length > before) return undefined;
  return { type: fields.type as string, name: fields.name as string };
}

/**
 * Every signal a rule refers to must be declared. A decision that refers to a
 * signal whose evidence can be unknown must say what unknown means for it:
 * external signals, and keyword signals, which are unknown when a message is
 * too long to search whole.
 */
function checkReferences(
  decisions: (Decision | undefined)[],
  signals: Signals,
  issues: PolicyIssue[],
): void {
  const alwaysKnown = new Set(
    (signals.fact ?? []).map((s) => signalKey({ type: "fact", name: s.name })),
  );
  const canBeUnknown = new Set([
    ...(signals.keyword ?? []).map((s) =>
      signalKey({ type: "keyword", name: s.name }),
    ),
    ...(signals.external ?? []).map(signalKey),
  ]);
  decisions.forEach((decision, i) => {
    if (!decision?.rules) return;
    const uncertain = new Set<string>();
    walkSignals(decision.rules, `decisions[${i}].rules`, (key, path) => {
      if (canBeUnknown.has(key)) uncertain.add(key);
      else if (!alwaysKnown.has(key)) {
        issues.push({
          path,
          message: `refers to ${key}, which is not declared in signals`,
        });
      }
    });
    if (uncertain.size > 0 && decision.onUnknown === undefined) {
      issues.push({
        path: `decisions[${i}].onUnknown`,
        message: `is required, because the rules use ${[...uncertain].join(", ")}, whose evidence can be unknown`,
      });
    }
  });
}

function walkSignals(
  node: RuleNode,
  path: string,
  visit: (key: string, path: string) => void,
): void {
  if (isSignal(node)) {
    visit(signalKey(node), path);
    return;
  }
  node.conditions.forEach((child, i) =>
    walkSignals(child, `${path}.conditions[${i}]`, visit),
  );
}

function checkName(value: unknown, path: string, issues: PolicyIssue[]): void {
  if (typeof value !== "string" || !NAME_PATTERN.test(value)) {
    issues.push({
      path,
      message:
        "must be 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit",
    });
  }
}

function readDecision(
  value: unknown,
  path: string,
  issues: PolicyIssue[],
): RoutedDecision | undefined {
  const fields = readObject(
    value,
    path,
    ["name", "description", "priority", "rules", "onUnknown", "models"],
    issues,
  );
  if (!fields) return undefined;
  const before = issues.length;

  checkName(fields.name, `${path}.name`, issues);
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

  const models = fields.models;
  if (
    !Array.isArray(models) ||
    models.length === 0 ||
    models.length > MAX_CANDIDATES
  ) {
    issues.push({
      path: `${path}.models`,
      message: `must list 1 to ${MAX_CANDIDATES} candidate models, tried in order`,
    });
  } else {
    models.forEach((id, j) => {
      if (typeof id !== "string") {
        issues.push({
          path: `${path}.models[${j}]`,
          message: "must be a model ID",
        });
      } else if (models.indexOf(id) !== j) {
        issues.push({
          path: `${path}.models[${j}]`,
          message: `repeats ${id}, which is already a candidate`,
        });
      }
    });
  }

  if (issues.length > before) return undefined;
  return {
    name: fields.name as string,
    ...(typeof fields.description === "string" && {
      description: fields.description,
    }),
    priority: fields.priority as number,
    ...(rules && { rules }),
    ...(onUnknown !== undefined && { onUnknown: onUnknown as UnknownPolicy }),
    models: models as string[],
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
        message:
          operator === "AND"
            ? "AND needs at least one condition; a decision that matches everything is written without rules"
            : "OR needs at least one condition",
      });
      return undefined;
    }
    const children = conditions.map((child, i) =>
      readRule(child, `${path}.conditions[${i}]`, depth + 1, counter, issues),
    );
    if (!children.every((c) => c !== undefined)) return undefined;
    const [first, ...rest] = children;
    return operator === "NOT"
      ? { operator, conditions: [first] }
      : { operator, conditions: [first, ...rest] };
  }

  const fields = readObject(
    value,
    path,
    ["type", "name"],
    issues,
    LEGACY_RULE_FIELDS,
  );
  if (!fields) return undefined;
  const before = issues.length;
  checkName(fields.type, `${path}.type`, issues);
  checkName(fields.name, `${path}.name`, issues);
  return issues.length > before
    ? undefined
    : { type: fields.type as string, name: fields.name as string };
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

/**
 * Returns `value` if it is an object. A field it may not have is reported, but
 * the object is still returned, so its other fields are checked too.
 */
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
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push({
        path: `${path}.${key}`,
        // Own fields only: a key such as "constructor" must not find Object's.
        message: Object.hasOwn(explained, key)
          ? explained[key]!
          : `is not a known field; expected ${allowed.join(", ")}`,
      });
    }
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
