import { afterEach, describe, expect, it, vi } from "vitest";
import { readSettings } from "../src/config.ts";
import { entrypoints } from "../src/entrypoints.ts";
import { ENV } from "./fixtures.ts";
import {
  chat,
  errorCode,
  event,
  eventStream,
  gateway,
  hang,
} from "./harness.ts";

// The two models of the test pool in fixtures.ts.
const LUNA = "openai/gpt-5.6-luna";
const OPUS = "anthropic/claude-opus-5.5";
// Anthropic's own ID for OPUS, from GATEWAY_NAMES in src/pool.ts.
const OPUS_AT_ANTHROPIC = "anthropic/claude-opus-5-5";

const ROUTING = {
  signals: {
    keyword: [{ name: "code", operator: "OR", keywords: ["python"] }],
  },
  models: [
    { id: LUNA, contextWindow: 100000, tools: false },
    { id: OPUS, contextWindow: 100000, tools: true },
  ],
  decisions: [
    {
      name: "coding",
      priority: 10,
      rules: { type: "keyword", name: "code" },
      onUnknown: "no_match",
      models: [OPUS],
    },
    { name: "default", priority: 0, models: [LUNA, OPUS] },
  ],
};

// No external evidence arrives yet, so "hard" is always unknown and fails.
const STRICT = {
  signals: { external: [{ type: "clef", name: "hard" }] },
  models: [{ id: LUNA, contextWindow: 100000 }],
  decisions: [
    {
      name: "hard",
      priority: 10,
      rules: { type: "clef", name: "hard" },
      onUnknown: "fail_request",
      models: [LUNA],
    },
    { name: "default", priority: 0, models: [LUNA] },
  ],
};

const OUTSIDE_POOL = {
  ...ROUTING,
  models: [...ROUTING.models, { id: "openai/gpt-6-sol", contextWindow: 1000 }],
};

const POLICIES = {
  routing: ROUTING,
  strict: STRICT,
  outside: OUTSIDE_POOL,
};

const SETTINGS = await readSettings(ENV);

/** The fake Gateway, serving the test policies. */
function served(respond?: (request: Request) => Response | Promise<Response>) {
  return gateway(respond, POLICIES);
}

function ask(model: string, content: unknown, extra: object = {}) {
  return { model, messages: [{ role: "user", content }], ...extra };
}

async function sentModel(request: Request): Promise<unknown> {
  return ((await request.json()) as { model?: unknown }).model;
}

async function hashOf(model: string, env = ENV): Promise<string> {
  const entrypoint = await entrypoints(POLICIES).resolve(
    model,
    await readSettings(env),
  );
  return entrypoint!.configHash;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("choosing the router by model name", () => {
  it.each([
    ["a bare pool model", LUNA],
    ["a direct model outside the pool", "direct/openai/gpt-6-sol"],
    ["a direct entrypoint without a model", "direct/"],
    ["a policy that is not served", "policy/missing"],
    ["a name that only an object's prototype has", "policy/constructor"],
    ["a policy entrypoint without a name", "policy/"],
    ["a model name that is not a string", 42],
    ["no model name", undefined],
  ])("refuses %s, and names what it serves", async (_name, model) => {
    const { sent, records, app } = served();
    const response = await app.fetch(
      chat({ body: ask("", "hi", { model }) }),
      ENV,
    );

    expect(response.status).toBe(400);
    const { error } = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(error.code).toBe("unsupported_model");
    expect(error.message).toBe(
      `Use "cloudflare/auto", "policy/routing", "policy/strict", "policy/outside", or "direct/" followed by one of: ${LUNA}, ${OPUS}.`,
    );
    expect(sent).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  it("refuses a direct call to a wildcard in the pool", async () => {
    const env = {
      ...ENV,
      AUTO_ROUTER: { ...ENV.AUTO_ROUTER, allowedModels: ["anthropic/*", LUNA] },
    };
    const { sent, app } = served();
    const response = await app.fetch(
      chat({ body: ask("direct/anthropic/*", "hi") }),
      env,
    );

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("unsupported_model");
    expect(sent).toHaveLength(0);
  });
});

describe("a direct entrypoint", () => {
  it("sends the caller's body to the named model, with only the model changed", async () => {
    const { sent, app } = served();
    const body = {
      temperature: 0,
      model: `direct/${LUNA}`,
      messages: [{ role: "user", content: "hi" }],
      stream_options: { include_usage: true },
    };
    await app.fetch(chat({ body }), ENV);

    expect(sent[0]!.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/account/gateway/compat/chat/completions",
    );
    const forwarded = (await sent[0]!.json()) as object;
    expect(forwarded).toEqual({ ...body, model: LUNA });
    expect(Object.keys(forwarded)).toEqual(Object.keys(body));
  });

  it("names a Workers AI model as the compat endpoint documents it, and records the pool's name", async () => {
    const kimi = "@cf/moonshotai/kimi-k2.7-code";
    const env = {
      ...ENV,
      AUTO_ROUTER: { ...ENV.AUTO_ROUTER, allowedModels: [kimi, LUNA] },
    };
    const { sent, records, app } = served();
    const response = await app.fetch(
      chat({ body: ask(`direct/${kimi}`, "hi") }),
      env,
    );
    await response.text();

    expect(await sentModel(sent[0]!)).toBe(`workers-ai/${kimi}`);
    expect(response.headers.get("x-vsr-selected-model")).toBe(kimi);
    expect(records[0]).toMatchObject({ model: kimi });
  });

  it("names an xAI model under the compat endpoint's provider name, and records the pool's name", async () => {
    const grok = "xai/grok-4.6";
    const env = {
      ...ENV,
      AUTO_ROUTER: { ...ENV.AUTO_ROUTER, allowedModels: [grok, LUNA] },
    };
    const { sent, records, app } = served();
    const response = await app.fetch(
      chat({ body: ask(`direct/${grok}`, "hi") }),
      env,
    );
    await response.text();

    expect(await sentModel(sent[0]!)).toBe("grok/grok-4.6");
    expect(response.headers.get("x-vsr-selected-model")).toBe(grok);
    expect(records[0]).toMatchObject({ model: grok });
  });

  it("names a model by its provider's ID where that differs, and records the pool's name", async () => {
    const { sent, records, app } = served();
    const response = await app.fetch(
      chat({ body: ask(`direct/${OPUS}`, "hi") }),
      ENV,
    );
    await response.text();

    expect(await sentModel(sent[0]!)).toBe(OPUS_AT_ANTHROPIC);
    expect(response.headers.get("x-vsr-selected-model")).toBe(OPUS);
    expect(records[0]).toMatchObject({ model: OPUS });
  });

  it("renames max_tokens to max_completion_tokens for an OpenAI model, in place", async () => {
    const { sent, app } = served();
    const body = {
      model: `direct/${LUNA}`,
      max_tokens: 20,
      messages: [{ role: "user", content: "hi" }],
    };
    await app.fetch(chat({ body }), ENV);

    const forwarded = (await sent[0]!.json()) as object;
    expect(forwarded).toEqual({
      model: LUNA,
      max_completion_tokens: 20,
      messages: body.messages,
    });
    expect(Object.keys(forwarded)).toEqual([
      "model",
      "max_completion_tokens",
      "messages",
    ]);
  });

  it("drops max_tokens for an OpenAI model when max_completion_tokens is also given", async () => {
    const { sent, app } = served();
    await app.fetch(
      chat({
        // max_tokens comes last, so a wrong rename would win.
        body: ask(`direct/${LUNA}`, "hi", {
          max_completion_tokens: 20,
          max_tokens: 5,
        }),
      }),
      ENV,
    );

    const forwarded = (await sent[0]!.json()) as Record<string, unknown>;
    expect(forwarded.max_completion_tokens).toBe(20);
    expect(Object.hasOwn(forwarded, "max_tokens")).toBe(false);
  });

  it("keeps max_tokens for a model of another provider", async () => {
    const { sent, app } = served();
    await app.fetch(
      chat({ body: ask(`direct/${OPUS}`, "hi", { max_tokens: 20 }) }),
      ENV,
    );

    const forwarded = (await sent[0]!.json()) as Record<string, unknown>;
    expect(forwarded.max_tokens).toBe(20);
    expect(Object.hasOwn(forwarded, "max_completion_tokens")).toBe(false);
  });

  it("sends the Worker's own Gateway headers, without the pool or session headers", async () => {
    const { sent, app } = served();
    await app.fetch(
      chat({
        body: ask(`direct/${LUNA}`, "hi"),
        headers: {
          "x-session-id": "run-7",
          "x-turn-id": "2",
          "cf-aig-max-attempts": "5",
        },
      }),
      ENV,
    );

    const headers = sent[0]!.headers;
    expect(headers.get("cf-aig-authorization")).toBe("Bearer gateway-token");
    expect(headers.get("cf-aig-skip-cache")).toBe("true");
    expect(headers.get("cf-aig-max-attempts")).toBe("1");
    expect(headers.get("cf-aig-collect-log-payload")).toBe("true");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cf-aig-allowed-models")).toBeNull();
    expect(headers.get("cf-aig-session-id")).toBeNull();
    expect(headers.get("cf-aig-turn-id")).toBeNull();
  });

  it("names the model in the response and in the record", async () => {
    const { records, app } = served(() =>
      Response.json({}, { headers: { "cf-aig-request-id": "request-9" } }),
    );
    const response = await app.fetch(
      chat({
        body: ask(`direct/${LUNA}`, "a private prompt"),
        headers: { "x-session-id": "run-7" },
      }),
      ENV,
    );
    await response.text();

    const hash = await hashOf(`direct/${LUNA}`);
    expect(response.headers.get("x-vsr-selected-model")).toBe(LUNA);
    expect(response.headers.get("x-vsr-selected-decision")).toBeNull();
    expect(response.headers.get("x-vsr-config-hash")).toBe(hash);
    expect(records).toEqual([
      {
        event: "model_response",
        sessionId: "run-7",
        turnId: null,
        entrypoint: `direct/${LUNA}`,
        configHash: hash,
        stream: false,
        requestBytes: expect.any(Number),
        model: LUNA,
        msToHeaders: 0,
        msToFirstToken: null,
        msTotal: 0,
        ended: "complete",
        status: 200,
        gatewayRequestId: "request-9",
      },
    ]);
    expect(JSON.stringify(records)).not.toContain("private");
  });
});

describe("a policy entrypoint", () => {
  it("sends the request to the model the policy chooses", async () => {
    const { sent, app } = served();
    const response = await app.fetch(
      chat({ body: ask("policy/routing", "Fix my python script") }),
      ENV,
    );

    expect(await sentModel(sent[0]!)).toBe(OPUS_AT_ANTHROPIC);
    expect(response.headers.get("x-vsr-selected-model")).toBe(OPUS);
    expect(response.headers.get("x-vsr-selected-decision")).toBe("coding");
    expect(response.headers.get("x-vsr-config-hash")).toBe(
      await hashOf("policy/routing"),
    );
  });

  it("passes over a candidate that cannot serve the request", async () => {
    const { sent, records, app } = served();
    const tools = [{ type: "function", function: { name: "search" } }];
    const response = await app.fetch(
      chat({ body: ask("policy/routing", "What is new?", { tools }) }),
      ENV,
    );
    await response.text();

    expect(await sentModel(sent[0]!)).toBe(OPUS_AT_ANTHROPIC);
    expect(records[0]).toMatchObject({
      event: "model_response",
      model: OPUS,
      policy: {
        outcome: "routed",
        decision: "default",
        rejected: [
          {
            model: LUNA,
            reasons: [
              "the request needs tool calling, which it does not support",
            ],
          },
        ],
      },
    });
  });

  it("records the policy's decision, without prompt text", async () => {
    const { records, app } = served();
    const response = await app.fetch(
      chat({ body: ask("policy/routing", "a private python question") }),
      ENV,
    );
    await response.text();

    expect(records).toEqual([
      expect.objectContaining({
        event: "model_response",
        entrypoint: "policy/routing",
        model: OPUS,
        policy: {
          outcome: "routed",
          model: OPUS,
          decision: "coding",
          matchedSignals: ["keyword:code"],
          ranking: { reason: "only_match" },
          requirements: {
            contextTokens: expect.any(Number),
            tools: false,
            structuredOutput: false,
            vision: false,
          },
          rejected: [],
          policyVersion: expect.stringMatching(/^[0-9a-f]{16}$/),
          appliedUnknownPolicy: [],
        },
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("private");
    expect(JSON.stringify(records)).not.toContain("python");
  });

  it("records when onUnknown settled unknown evidence", async () => {
    const { records, app } = served();
    const response = await app.fetch(
      chat({ body: ask("policy/routing", "x".repeat(40_000)) }),
      ENV,
    );
    await response.text();

    expect(records[0]).toMatchObject({
      model: LUNA,
      policy: {
        decision: "default",
        appliedUnknownPolicy: ["coding=no_match"],
      },
    });
  });

  it("fails with no_eligible_model, without calling the Gateway, when no candidate can serve the request", async () => {
    const { sent, records, app } = served();
    const content = [
      { type: "text", text: "What is in this picture?" },
      { type: "image_url", image_url: { url: "https://example.com/a.png" } },
    ];
    const response = await app.fetch(
      chat({ body: ask("policy/routing", content) }),
      ENV,
    );

    expect(response.status).toBe(422);
    const { error } = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(error.code).toBe("no_eligible_model");
    expect(error.message).toBe(
      `No candidate of decision "default" can serve this request. ${LUNA}: the request needs image input, and its support is unknown. ${OPUS}: the request needs image input, and its support is unknown.`,
    );
    expect(sent).toHaveLength(0);
    expect(records).toEqual([
      expect.objectContaining({
        event: "routing_failed",
        entrypoint: "policy/routing",
        policy: expect.objectContaining({
          outcome: "no_eligible_model",
          decision: "default",
        }),
      }),
    ]);
  });

  it("fails with routing_unresolved when evidence it requires is unknown", async () => {
    const { sent, records, app } = served();
    const response = await app.fetch(
      chat({ body: ask("policy/strict", "hi") }),
      ENV,
    );

    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("routing_unresolved");
    expect(sent).toHaveLength(0);
    expect(records).toEqual([
      expect.objectContaining({
        event: "routing_failed",
        policy: expect.objectContaining({
          outcome: "unresolved",
          decision: "hard",
          appliedUnknownPolicy: ["hard=fail_request"],
        }),
      }),
    ]);
  });

  it("answers 500 when a policy names a model outside the pool", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sent, app } = served();
    const response = await app.fetch(
      chat({ body: ask("policy/outside", "hi") }),
      ENV,
    );

    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe("misconfigured");
    expect(sent).toHaveLength(0);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("policy/outside: The policy is invalid"),
    );
  });

  it("loads a policy once and keeps it", async () => {
    let reads = 0;
    const counted = new Proxy(ROUTING, {
      get(target, key, receiver) {
        if (key === "decisions") reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const resolve = entrypoints({ counted }).resolve;
    const first = await resolve("policy/counted", SETTINGS);
    const readsAfterFirst = reads;
    const second = await resolve("policy/counted", SETTINGS);

    expect(readsAfterFirst).toBeGreaterThan(0);
    expect(reads).toBe(readsAfterFirst);
    expect(second).toEqual(first);
  });
});

describe("config hashes", () => {
  it("gives each entrypoint its own hash", async () => {
    const hashes = await Promise.all(
      [
        "cloudflare/auto",
        `direct/${LUNA}`,
        `direct/${OPUS}`,
        "policy/routing",
        "policy/strict",
      ].map((model) => hashOf(model)),
    );

    expect(hashes[0]).toBe(SETTINGS.configHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("gives a policy entrypoint a new hash when only the policy changes", async () => {
    const edited = {
      ...ROUTING,
      decisions: ROUTING.decisions.map((d) => ({ ...d, description: "new" })),
    };
    const before = await entrypoints({ p: ROUTING }).resolve(
      "policy/p",
      SETTINGS,
    );
    const after = await entrypoints({ p: edited }).resolve(
      "policy/p",
      SETTINGS,
    );

    expect(after!.configHash).not.toBe(before!.configHash);
  });

  it("gives a new hash when the deadline changes", async () => {
    const slower = {
      ...ENV,
      AUTO_ROUTER: { ...ENV.AUTO_ROUTER, deadlineMs: 120_000 },
    };

    expect(await hashOf(`direct/${LUNA}`, slower)).not.toBe(
      await hashOf(`direct/${LUNA}`),
    );
    expect(await hashOf("policy/routing", slower)).not.toBe(
      await hashOf("policy/routing"),
    );
  });

  it("forwards a request that expects its entrypoint's hash", async () => {
    const { sent, app } = served();
    const response = await app.fetch(
      chat({
        body: ask("policy/routing", "hi"),
        headers: {
          "x-sr-bench-expected-config-hash": await hashOf("policy/routing"),
        },
      }),
      ENV,
    );

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("refuses a request that expects another entrypoint's hash, before routing it", async () => {
    const { sent, records, app } = served();
    const response = await app.fetch(
      chat({
        body: ask("policy/routing", "hi"),
        headers: { "x-sr-bench-expected-config-hash": SETTINGS.configHash },
      }),
      ENV,
    );

    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("config_hash_mismatch");
    expect(response.headers.get("x-vsr-config-hash")).toBe(
      await hashOf("policy/routing"),
    );
    expect(sent).toHaveLength(0);
    expect(records).toHaveLength(0);
  });
});

describe("the exact-model path shares the pass-through's call handling", () => {
  it("gives up at the deadline, and records the model and the decision", async () => {
    const { sent, records, deadlines, expire, app } = served(hang);
    const pending = app.fetch(
      chat({ body: ask("policy/routing", "python") }),
      ENV,
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expire();
    const response = await pending;

    expect(deadlines).toEqual([ENV.AUTO_ROUTER.deadlineMs]);
    expect(sent[0]!.signal.aborted).toBe(true);
    expect(response.status).toBe(504);
    expect(records).toEqual([
      expect.objectContaining({
        event: "gateway_no_response",
        model: OPUS,
        reason: "timeout",
        policy: expect.objectContaining({ decision: "coding" }),
      }),
    ]);
  });

  it("answers 502 without retrying when the request fails", async () => {
    const { sent, records, app } = served(() => {
      throw new TypeError("network down");
    });
    const response = await app.fetch(
      chat({ body: ask(`direct/${OPUS}`, "hi") }),
      ENV,
    );

    expect(response.status).toBe(502);
    expect(sent).toHaveLength(1);
    expect(records).toEqual([
      expect.objectContaining({
        event: "gateway_no_response",
        model: OPUS,
        reason: "network",
        error: "TypeError",
      }),
    ]);
  });

  it("streams the response and times its first token", async () => {
    const upstream = eventStream();
    const { records, clock, app } = served(() => {
      clock.ms = 5;
      return upstream.response();
    });
    const response = await app.fetch(
      chat({ body: ask(`direct/${LUNA}`, "hi", { stream: true }) }),
      ENV,
    );
    const reader = response.body!.getReader();

    clock.ms = 20;
    upstream.push(event({ content: "Hi" }));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      event({ content: "Hi" }),
    );
    clock.ms = 30;
    upstream.close();
    expect((await reader.read()).done).toBe(true);

    expect(records[0]).toMatchObject({
      event: "model_response",
      stream: true,
      msToHeaders: 5,
      msToFirstToken: 20,
      msTotal: 30,
      ended: "complete",
    });
  });
});
