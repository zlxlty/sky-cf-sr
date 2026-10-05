import { afterEach, describe, expect, it, vi } from "vitest";
import { readSettings } from "../src/config.ts";
import { entrypoints } from "../src/entrypoints.ts";
import { exactModelConfigHash } from "../src/gateway.ts";
import { shortHash } from "../src/hash.ts";
import { ENV } from "./fixtures.ts";
import {
  aiBinding,
  chat,
  errorCode,
  event,
  eventStream,
  gateway,
  hang,
  hangOn,
} from "./harness.ts";

// The two models of the test pool in fixtures.ts. Both are called by name
// through the compat endpoint.
const LUNA = "openai/gpt-5.6-luna";
const SONNET = "anthropic/claude-sonnet-5";

const ROUTING = {
  signals: {
    keyword: [{ name: "code", operator: "OR", keywords: ["python"] }],
  },
  models: [
    { id: LUNA, contextWindow: 100000, tools: false },
    { id: SONNET, contextWindow: 100000, tools: true },
  ],
  decisions: [
    {
      name: "coding",
      priority: 10,
      rules: { type: "keyword", name: "code" },
      onUnknown: "no_match",
      models: [SONNET],
    },
    { name: "default", priority: 0, models: [LUNA, SONNET] },
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

// A model the compat endpoint does not serve when it is named; see
// VIA_AI_BINDING in src/reach.ts.
const GLM = "fireworks/glm-5.3";
const VIA_BINDING = {
  routing: {
    models: [{ id: GLM, contextWindow: 100000 }],
    decisions: [{ name: "default", priority: 0, models: [GLM] }],
  },
};

/** The test environment with GLM in the pool and the given AI binding. */
function withBinding(ai: unknown, policy: object = {}) {
  return {
    ...ENV,
    AUTO_ROUTER: { ...ENV.AUTO_ROUTER, allowedModels: [GLM, LUNA], ...policy },
    AI: ai,
  };
}

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
      `Use "cloudflare/auto", "policy/routing", "policy/strict", "policy/outside", or "direct/" followed by one of: ${LUNA}, ${SONNET}.`,
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
      chat({ body: ask(`direct/${SONNET}`, "hi", { max_tokens: 20 }) }),
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

    expect(await sentModel(sent[0]!)).toBe(SONNET);
    expect(response.headers.get("x-vsr-selected-model")).toBe(SONNET);
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

    expect(await sentModel(sent[0]!)).toBe(SONNET);
    expect(records[0]).toMatchObject({
      event: "model_response",
      model: SONNET,
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
        model: SONNET,
        policy: {
          outcome: "routed",
          model: SONNET,
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
      `No candidate of decision "default" can serve this request. ${LUNA}: the request needs image input, and its support is unknown. ${SONNET}: the request needs image input, and its support is unknown.`,
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
        `direct/${SONNET}`,
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
        model: SONNET,
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
      chat({ body: ask(`direct/${SONNET}`, "hi") }),
      ENV,
    );

    expect(response.status).toBe(502);
    expect(sent).toHaveLength(1);
    expect(records).toEqual([
      expect.objectContaining({
        event: "gateway_no_response",
        model: SONNET,
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

describe("a model the compat endpoint does not serve", () => {
  it("is called through the AI binding, under the pool's name, with the caller's body", async () => {
    const ai = aiBinding();
    const { sent, app } = served();
    const body = {
      model: `direct/${GLM}`,
      max_tokens: 20,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    };
    const response = await app.fetch(chat({ body }), withBinding(ai.binding));
    await response.text();

    expect(sent).toHaveLength(0);
    expect(ai.calls).toHaveLength(1);
    const { model: _named, ...rest } = body;
    expect(ai.calls[0]!.model).toBe(GLM);
    expect(ai.calls[0]!.inputs).toEqual(rest);
    expect(Object.keys(ai.calls[0]!.inputs)).toEqual(Object.keys(rest));
    expect(response.headers.get("x-vsr-selected-model")).toBe(GLM);
  });

  it("goes through the same Gateway, with no cached answer, one attempt and the raw response", async () => {
    const ai = aiBinding();
    const { app } = served();
    await app.fetch(
      chat({ body: ask(`direct/${GLM}`, "hi") }),
      withBinding(ai.binding),
    );

    expect(ai.calls[0]!.options).toMatchObject({
      // The last part of AIG_GATEWAY_URL in fixtures.ts.
      gateway: {
        id: "gateway",
        skipCache: true,
        collectLog: true,
        retries: { maxAttempts: 1 },
      },
      returnRawResponse: true,
    });
  });

  it("is not logged by the Gateway when payloads are not logged", async () => {
    const ai = aiBinding();
    const { app } = served();
    await app.fetch(
      chat({ body: ask(`direct/${GLM}`, "hi") }),
      withBinding(ai.binding, { logPayloads: false }),
    );

    expect(ai.calls[0]!.options.gateway.collectLog).toBe(false);
  });

  it("relays the binding's response, and records it as any model's", async () => {
    const ai = aiBinding(() =>
      Response.json(
        { error: "busy" },
        { status: 429, headers: { "cf-aig-request-id": "request-4" } },
      ),
    );
    const { records, app } = served();
    const response = await app.fetch(
      chat({ body: ask(`direct/${GLM}`, "hi") }),
      withBinding(ai.binding),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "busy" });
    expect(response.headers.get("cf-aig-request-id")).toBe("request-4");
    expect(records).toEqual([
      expect.objectContaining({
        event: "model_response",
        model: GLM,
        status: 429,
        gatewayRequestId: "request-4",
      }),
    ]);
  });

  it("is called through the binding when a policy chooses it", async () => {
    const ai = aiBinding();
    const { sent, app } = gateway(undefined, VIA_BINDING);
    const response = await app.fetch(
      chat({ body: ask("policy/routing", "hi") }),
      withBinding(ai.binding),
    );

    expect(sent).toHaveLength(0);
    expect(ai.calls.map((call) => call.model)).toEqual([GLM]);
    expect(response.headers.get("x-vsr-selected-decision")).toBe("default");
  });

  it("leaves the other models on the compat endpoint", async () => {
    const ai = aiBinding();
    const { sent, app } = served();
    await app.fetch(
      chat({ body: ask(`direct/${LUNA}`, "hi") }),
      withBinding(ai.binding),
    );

    expect(ai.calls).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it("gives up at the deadline", async () => {
    const ai = aiBinding(hangOn);
    const { records, expire, app } = served();
    const pending = app.fetch(
      chat({ body: ask(`direct/${GLM}`, "hi") }),
      withBinding(ai.binding),
    );
    await vi.waitFor(() => expect(ai.calls).toHaveLength(1));

    expire();
    const response = await pending;

    expect(ai.calls[0]!.options.signal.aborted).toBe(true);
    expect(response.status).toBe(504);
    expect(records).toEqual([
      expect.objectContaining({
        event: "gateway_no_response",
        model: GLM,
        reason: "timeout",
      }),
    ]);
  });

  it("answers 502 without retrying when the binding fails", async () => {
    const ai = aiBinding(() => {
      throw new Error("binding failed");
    });
    const { records, app } = served();
    const response = await app.fetch(
      chat({ body: ask(`direct/${GLM}`, "hi") }),
      withBinding(ai.binding),
    );

    expect(response.status).toBe(502);
    expect(ai.calls).toHaveLength(1);
    expect(records).toEqual([
      expect.objectContaining({
        event: "gateway_no_response",
        model: GLM,
        reason: "network",
      }),
    ]);
  });

  it("has a config hash that differs from the same model's on the compat endpoint", async () => {
    const settings = await readSettings(withBinding(aiBinding().binding));
    const viaBinding = await entrypoints().resolve(`direct/${GLM}`, settings);
    const viaEndpoint = await entrypoints().resolve(`direct/${LUNA}`, settings);

    expect(viaBinding?.configHash).toMatch(/^[0-9a-f]{16}$/);
    expect(viaBinding?.configHash).not.toBe(viaEndpoint?.configHash);
  });

  it.each([
    ["the AI binding is missing", { AI: undefined }],
    ["the binding has no run method", { AI: {} }],
    [
      "the Gateway's URL does not end with its ID",
      { AIG_GATEWAY_URL: "https://gateway.ai.cloudflare.com" },
    ],
  ])("answers 500 when %s", async (_name, change) => {
    const { app } = served();
    const response = await app.fetch(
      chat({ body: ask(`direct/${GLM}`, "hi") }),
      { ...withBinding(aiBinding().binding), ...change },
    );

    expect(response.status).toBe(500);
    expect(await errorCode(response)).toBe("misconfigured");
  });

  it("needs no AI binding when the pool has no such model", async () => {
    const { app } = served();
    const response = await app.fetch(
      chat({ body: ask(`direct/${LUNA}`, "hi") }),
      ENV,
    );

    expect(response.status).toBe(200);
  });
});

describe("a session's calls to a model that gets a cache key", () => {
  /** The inputs the binding gets for one direct call to GLM. */
  async function inputsFor(
    headers: Record<string, string>,
    extra: object = {},
  ): Promise<Record<string, unknown>> {
    const ai = aiBinding();
    const { app } = served();
    await app.fetch(
      chat({ body: ask(`direct/${GLM}`, "hi", extra), headers }),
      withBinding(ai.binding),
    );
    return ai.calls[0]!.inputs;
  }

  it("carry one key, made from the session ID and not equal to it", async () => {
    const first = await inputsFor({ "x-session-id": "session-1" });
    const second = await inputsFor({
      "x-session-id": "session-1",
      "x-turn-id": "turn-2",
    });

    expect(first.prompt_cache_key).toMatch(/^session-[0-9a-f]{16}$/);
    expect(first.prompt_cache_key).not.toContain("session-1");
    expect(second.prompt_cache_key).toBe(first.prompt_cache_key);
    // The key comes last: the caller's own fields keep their order.
    expect(Object.keys(first)).toEqual(["messages", "prompt_cache_key"]);
  });

  it("carry another key in another session", async () => {
    const first = await inputsFor({ "x-session-id": "session-1" });
    const other = await inputsFor({ "x-session-id": "session-2" });

    expect(other.prompt_cache_key).not.toBe(first.prompt_cache_key);
  });

  it("carry no key when the caller names no session", async () => {
    expect(await inputsFor({})).not.toHaveProperty("prompt_cache_key");
  });

  it.each([
    ["its own key", { prompt_cache_key: "mine" }],
    ["a user, which such a model uses the same way", { user: "someone" }],
  ])("are left as they are when the caller sends %s", async (_name, own) => {
    const inputs = await inputsFor({ "x-session-id": "session-1" }, own);

    expect(inputs).toEqual({
      messages: [{ role: "user", content: "hi" }],
      ...own,
    });
  });

  it("carry the key when a policy chooses the model", async () => {
    const ai = aiBinding();
    const { app } = gateway(undefined, VIA_BINDING);
    await app.fetch(
      chat({
        body: ask("policy/routing", "hi"),
        headers: { "x-session-id": "session-1" },
      }),
      withBinding(ai.binding),
    );

    expect(ai.calls[0]!.inputs.prompt_cache_key).toMatch(/^session-/);
  });

  it("is not added for a model that is not listed to get one", async () => {
    const { sent, app } = served();
    await app.fetch(
      chat({
        body: ask(`direct/${LUNA}`, "hi"),
        headers: { "x-session-id": "session-1" },
      }),
      ENV,
    );

    expect(await sent[0]!.json()).toEqual(ask(LUNA, "hi"));
  });

  it("is not added to a request for the Auto Router, which goes as the caller sent it", async () => {
    const ai = aiBinding();
    const { sent, app } = served();
    const body = JSON.stringify(ask("cloudflare/auto", "hi"));
    await app.fetch(
      chat({ body, headers: { "x-session-id": "session-1" } }),
      withBinding(ai.binding),
    );

    expect(await sent[0]!.text()).toBe(body);
    expect(sent[0]!.headers.get("cf-aig-session-id")).toBe("session-1");
  });

  it("is part of the config hash of an entrypoint that can call such a model, and of no other", async () => {
    const env = withBinding(aiBinding().binding);
    const settings = await readSettings(env);
    const hash = (target: object, models: string[]) =>
      exactModelConfigHash(
        target as { model: string },
        models,
        settings.deadlineMs,
      );

    // What the hashes were before a session's cache key existed.
    const before = async (target: object, names: Record<string, string>) =>
      shortHash(
        JSON.stringify({
          ...target,
          gatewayNames: names,
          deadlineMs: settings.deadlineMs,
          fixedHeaders: {
            "cf-aig-skip-cache": "true",
            "cf-aig-max-attempts": "1",
          },
        }),
      );

    expect(await hash({ model: GLM }, [GLM])).not.toBe(
      await before({ model: GLM }, { [GLM]: `ai-binding:${GLM}` }),
    );
    expect(await hash({ model: LUNA }, [LUNA])).toBe(
      await before({ model: LUNA }, { [LUNA]: LUNA }),
    );
  });
});

describe("a model the binding takes in Anthropic's format", () => {
  // See ANTHROPIC_FORMAT in src/reach.ts.
  const OPUS = "anthropic/claude-opus-5.5";
  const VIA_POLICY = {
    routing: {
      models: [{ id: OPUS, contextWindow: 100000 }],
      decisions: [{ name: "default", priority: 0, models: [OPUS] }],
    },
  };

  /** The test environment with Opus in the pool and the given AI binding. */
  function withOpus(ai: unknown) {
    return {
      ...ENV,
      AUTO_ROUTER: { ...ENV.AUTO_ROUTER, allowedModels: [OPUS, LUNA] },
      AI: ai,
    };
  }

  /** The model's answer "OK", as the binding streams it. */
  function ok(): Response {
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude-opus-5-5",
          usage: { input_tokens: 9 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "OK" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
      },
      { type: "message_stop" },
    ];
    const text = events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join("");
    return new Response(text, {
      headers: {
        "content-type": "text/event-stream",
        "cf-aig-request-id": "r1",
      },
    });
  }

  it("is called through the binding, with the body translated", async () => {
    const ai = aiBinding(ok);
    const { sent, app } = served();
    const response = await app.fetch(
      chat({
        body: {
          model: `direct/${OPUS}`,
          max_completion_tokens: 20,
          temperature: 0,
          messages: [
            { role: "system", content: "Be terse." },
            { role: "user", content: "hi" },
          ],
        },
      }),
      withOpus(ai.binding),
    );
    await response.text();

    expect(sent).toHaveLength(0);
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]!.model).toBe(OPUS);
    expect(ai.calls[0]!.inputs).toEqual({
      max_tokens: 20,
      system: "Be terse.",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(ai.calls[0]!.options.gateway).toMatchObject({
      id: "gateway",
      skipCache: true,
      retries: { maxAttempts: 1 },
    });
  });

  it("carries a cache marker in a session, and none without one", async () => {
    const ai = aiBinding(ok);
    const { app } = served();
    const body = ask(`direct/${OPUS}`, "hi");
    await app.fetch(chat({ body }), withOpus(ai.binding));
    await app.fetch(
      chat({ body, headers: { "x-session-id": "session-1" } }),
      withOpus(ai.binding),
    );

    expect(ai.calls[0]!.inputs).not.toHaveProperty("cache_control");
    expect(ai.calls[1]!.inputs.cache_control).toEqual({ type: "ephemeral" });
    // The marker is this model's way to the cache; it takes no cache key.
    expect(ai.calls[1]!.inputs).not.toHaveProperty("prompt_cache_key");
  });

  it("answers a caller that asked for a stream in Chat Completions chunks, and times its first token", async () => {
    const ai = aiBinding(ok);
    const { records, clock, app } = served();
    clock.ms = 40;
    const response = await app.fetch(
      chat({
        body: ask(`direct/${OPUS}`, "hi", {
          stream: true,
          stream_options: { include_usage: true },
        }),
      }),
      withOpus(ai.binding),
    );
    const text = await response.text();

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-vsr-selected-model")).toBe(OPUS);
    expect(response.headers.get("cf-aig-request-id")).toBe("r1");
    expect(text).toContain('"delta":{"content":"OK"}');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('"usage":{"prompt_tokens":9,"completion_tokens":2');
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(records).toEqual([
      expect.objectContaining({
        event: "model_response",
        model: OPUS,
        status: 200,
        stream: true,
        msToFirstToken: 0,
        ended: "complete",
        gatewayRequestId: "r1",
      }),
    ]);
  });

  it("answers a caller that asked for no stream with one object", async () => {
    const ai = aiBinding(ok);
    const { app } = served();
    const response = await app.fetch(
      chat({ body: ask(`direct/${OPUS}`, "hi") }),
      withOpus(ai.binding),
    );

    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject({
      object: "chat.completion",
      model: "claude-opus-5-5",
      choices: [
        {
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
    });
    // The model was asked for a stream all the same.
    expect(ai.calls[0]!.inputs.stream).toBe(true);
  });

  it("refuses a body it cannot translate, before any call", async () => {
    const ai = aiBinding(ok);
    const { records, app } = served();
    const response = await app.fetch(
      chat({ body: ask(`direct/${OPUS}`, "hi", { seed: 7 }) }),
      withOpus(ai.binding),
    );

    expect(response.status).toBe(400);
    const { error } = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(error.code).toBe("unsupported_parameter");
    expect(error.message).toContain('the field "seed"');
    expect(ai.calls).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  it("goes the same way when a policy chooses it", async () => {
    const ai = aiBinding(ok);
    const { sent, app } = gateway(undefined, VIA_POLICY);
    const response = await app.fetch(
      chat({ body: ask("policy/routing", "hi") }),
      withOpus(ai.binding),
    );

    expect(sent).toHaveLength(0);
    expect(ai.calls[0]!.inputs.stream).toBe(true);
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: "OK" } }],
    });
    expect(response.headers.get("x-vsr-selected-decision")).toBe("default");
  });

  it("relays the binding's error as it is", async () => {
    const ai = aiBinding(() =>
      Response.json({ error: "busy" }, { status: 429 }),
    );
    const { records, app } = served();
    const response = await app.fetch(
      chat({ body: ask(`direct/${OPUS}`, "hi") }),
      withOpus(ai.binding),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "busy" });
    expect(records).toEqual([
      expect.objectContaining({
        event: "model_response",
        model: OPUS,
        status: 429,
      }),
    ]);
  });

  it("has a config hash that tells its format apart from another binding model's", async () => {
    const settings = await readSettings(withOpus(aiBinding().binding));
    const hash = await exactModelConfigHash(
      { model: OPUS },
      [OPUS],
      settings.deadlineMs,
    );
    const inOpenAIFormat = await shortHash(
      JSON.stringify({
        model: OPUS,
        gatewayNames: { [OPUS]: `ai-binding:${OPUS}` },
        deadlineMs: settings.deadlineMs,
        fixedHeaders: {
          "cf-aig-skip-cache": "true",
          "cf-aig-max-attempts": "1",
        },
      }),
    );

    expect(hash).not.toBe(inOpenAIFormat);
  });
});
