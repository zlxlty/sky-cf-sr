import { describe, expect, it } from "vitest";
import starter from "../../policy/starter.json" with { type: "json" };
import {
  loadPolicy,
  PolicyError,
  routeRequest,
} from "../../src/policy/policy.ts";
import type { Evidence } from "../../src/policy/rules.ts";
import { POOL } from "../../src/pool.ts";

const MODELS = [
  { id: "cheap", contextWindow: 1000, tools: false },
  { id: "strong", contextWindow: 100000, tools: true, vision: true },
];

const POLICY = {
  signals: {
    keyword: [{ name: "code", operator: "OR", keywords: ["python"] }],
    external: [{ type: "clef", name: "hard" }],
  },
  models: MODELS,
  decisions: [
    {
      name: "hard",
      priority: 20,
      rules: { type: "clef", name: "hard" },
      onUnknown: "no_match",
      models: ["strong"],
    },
    {
      name: "guarded",
      priority: 15,
      rules: { type: "clef", name: "hard" },
      onUnknown: "no_match",
      models: ["strong"],
    },
    {
      name: "coding",
      priority: 10,
      rules: { type: "keyword", name: "code" },
      models: ["cheap"],
    },
    { name: "default", priority: 0, models: ["cheap", "strong"] },
  ],
};

const ask = (content: unknown, extra: Record<string, unknown> = {}) => ({
  messages: [{ role: "user", content }],
  ...extra,
});

describe("loadPolicy", () => {
  it("rejects an invalid policy with every issue", async () => {
    const error = await loadPolicy({ decisions: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyError);
    expect((error as PolicyError).issues.map((i) => i.path)).toContain(
      "decisions",
    );
  });

  it("versions a policy by its content", async () => {
    const a = await loadPolicy(POLICY);
    const b = await loadPolicy(structuredClone(POLICY));
    const changed = await loadPolicy({
      ...POLICY,
      models: [MODELS[0], { ...MODELS[1], contextWindow: 200000 }],
    });
    expect(a.version).toMatch(/^[0-9a-f]{16}$/);
    expect(b.version).toBe(a.version);
    expect(changed.version).not.toBe(a.version);
  });
});

describe("routeRequest", () => {
  it("routes to the decision's first eligible model, and explains why", async () => {
    const loaded = await loadPolicy(POLICY);
    const result = routeRequest(loaded, ask("write python"));
    expect(result).toMatchObject({
      outcome: "routed",
      model: "cheap",
      decision: "coding",
      matchedSignals: ["keyword:code"],
      ranking: { reason: "only_match" },
      rejected: [],
      policyVersion: loaded.version,
    });
  });

  it("falls through the decision's list when a model cannot serve the request", async () => {
    const loaded = await loadPolicy(POLICY);
    const result = routeRequest(
      loaded,
      ask("hello", { tools: [{ type: "function", function: { name: "f" } }] }),
    );
    expect(result).toMatchObject({
      outcome: "routed",
      decision: "default",
      model: "strong",
      rejected: [
        {
          model: "cheap",
          reasons: [
            "the request needs tool calling, which it does not support",
          ],
        },
      ],
    });
  });

  it("fails rather than leave the decision's list when nothing is eligible", async () => {
    const loaded = await loadPolicy(POLICY);
    const result = routeRequest(
      loaded,
      ask("write python", {
        tools: [{ type: "function", function: { name: "f" } }],
      }),
    );
    expect(result).toMatchObject({
      outcome: "no_eligible_model",
      decision: "coding",
    });
  });

  it("uses external evidence when it is supplied", async () => {
    const loaded = await loadPolicy(POLICY);
    const external: Evidence = new Map([["clef:hard", { state: "matched" }]]);
    expect(routeRequest(loaded, ask("hello"), external)).toMatchObject({
      outcome: "routed",
      decision: "hard",
      model: "strong",
      ranking: { reason: "priority", runnerUp: "guarded" },
    });
  });

  it("applies onUnknown when external evidence is missing", async () => {
    const loaded = await loadPolicy(POLICY);
    const result = routeRequest(loaded, ask("hello"));
    expect(result).toMatchObject({ outcome: "routed", decision: "default" });
    expect(result.traces.find((t) => t.decision === "hard")).toMatchObject({
      truth: "unknown",
      appliedPolicy: "no_match",
    });
  });

  it("fails the request when an unresolved decision says so", async () => {
    const loaded = await loadPolicy({
      ...POLICY,
      decisions: POLICY.decisions.map((d) =>
        d.name === "guarded" ? { ...d, onUnknown: "fail_request" } : d,
      ),
    });
    expect(routeRequest(loaded, ask("write python"))).toMatchObject({
      outcome: "unresolved",
      decision: "guarded",
    });
  });
});

describe("the starter policy", () => {
  it("is valid", async () => {
    await expect(loadPolicy(starter)).resolves.toBeDefined();
  });

  it("describes exactly the pool the Auto Router is given", async () => {
    const loaded = await loadPolicy(starter);
    expect(loaded.policy.models.map((m) => m.id).sort()).toEqual(
      [...POOL].sort(),
    );
  });

  it.each([
    [
      "a short question",
      ask("What is the capital of France?"),
      "default",
      "openai/gpt-5.6-luna",
    ],
    [
      "a coding question",
      ask("Why does my python script crash?"),
      "coding",
      "@cf/moonshotai/kimi-k2.7-code",
    ],
    [
      "a long document",
      ask("x".repeat(500_000)),
      "long-context",
      "openai/gpt-5.6-luna",
    ],
    [
      "a coding question asking for a JSON schema",
      ask("Refactor this SQL", {
        response_format: {
          type: "json_schema",
          json_schema: { name: "s", schema: {} },
        },
      }),
      "coding",
      "openai/gpt-6-sol",
    ],
  ])("routes %s", async (_name, body, decision, model) => {
    const loaded = await loadPolicy(starter);
    expect(routeRequest(loaded, body)).toMatchObject({
      outcome: "routed",
      decision,
      model,
    });
  });
});
