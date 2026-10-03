import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.ts";
import { readSettings } from "../src/config.ts";
import type { Deps, RequestRecord } from "../src/passthrough.ts";
import { ENV } from "./fixtures.ts";

const CHAT = {
  model: "cloudflare/auto",
  messages: [{ role: "user", content: "hello" }],
};

const STREAMED_CHAT = { ...CHAT, stream: true };

/**
 * A stand-in for the Gateway that records what it was sent and what the Worker
 * logged. Time stands still unless a test moves `clock.ms`, and the deadline
 * passes only when a test calls `expire()`.
 */
function gateway(
  respond: (request: Request) => Response | Promise<Response> = () =>
    Response.json({ ok: true }),
) {
  const sent: Request[] = [];
  const records: RequestRecord[] = [];
  const clock = { ms: 0 };
  const deadlines: number[] = [];
  const deadline = new AbortController();
  const deps: Deps = {
    fetch: async (request) => {
      sent.push(request);
      return respond(request);
    },
    log: (record) => records.push(record),
    now: () => clock.ms,
    deadline: (ms) => {
      deadlines.push(ms);
      return deadline.signal;
    },
  };
  const expire = () =>
    deadline.abort(new DOMException("The deadline passed.", "TimeoutError"));
  return { sent, records, clock, deadlines, expire, app: createApp(deps) };
}

/** A Gateway response that never arrives; it fails only when its request is aborted. */
function hang(request: Request): Promise<Response> {
  return new Promise((_, reject) =>
    request.signal.addEventListener("abort", () =>
      reject(request.signal.reason),
    ),
  );
}

/** An event-stream response whose chunks the test sends one at a time. */
function eventStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: () =>
      new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      }),
    push: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    close: () => controller.close(),
    fail: (error: Error) => controller.error(error),
    wasCancelled: () => cancelled,
  };
}

/** One Chat Completions stream event carrying the given delta. */
function event(delta: object): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;
}

function chat(
  options: {
    body?: unknown;
    headers?: Record<string, string>;
    method?: string;
    path?: string;
    signal?: AbortSignal;
  } = {},
): Request {
  const method = options.method ?? "POST";
  const body = options.body ?? CHAT;
  const url = `https://worker.example${options.path ?? "/v1/chat/completions"}`;
  return new Request(url, {
    method,
    headers: { authorization: "Bearer client-token", ...options.headers },
    body:
      method === "POST"
        ? typeof body === "string"
          ? body
          : JSON.stringify(body)
        : undefined,
    signal: options.signal,
  });
}

async function errorCode(response: Response): Promise<string> {
  const envelope = (await response.json()) as { error: { code: string } };
  return envelope.error.code;
}

const CONFIG_HASH = (await readSettings(ENV)).configHash;

describe("forwarding to the Auto Router", () => {
  it("posts to the gateway's compat endpoint with the pool and its own credential", async () => {
    const { sent, app } = gateway();
    await app.fetch(chat(), ENV);

    expect(sent).toHaveLength(1);
    const outbound = sent[0]!;
    expect(outbound.method).toBe("POST");
    expect(outbound.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/account/gateway/compat/chat/completions",
    );
    expect(outbound.headers.get("cf-aig-authorization")).toBe(
      "Bearer gateway-token",
    );
    expect(outbound.headers.get("cf-aig-allowed-models")).toBe(
      "openai/gpt-5.6-luna,anthropic/claude-opus-5.5",
    );
  });

  it("turns off the Gateway's cache and retries", async () => {
    const { sent, app } = gateway();
    await app.fetch(chat(), ENV);

    expect(sent[0]!.headers.get("cf-aig-skip-cache")).toBe("true");
    expect(sent[0]!.headers.get("cf-aig-max-attempts")).toBe("1");
  });

  it.each([true, false])(
    "asks the Gateway to log payloads when logPayloads is %s",
    async (logPayloads) => {
      const { sent, app } = gateway();
      await app.fetch(chat(), {
        ...ENV,
        AUTO_ROUTER: { ...ENV.AUTO_ROUTER, logPayloads },
      });

      expect(sent[0]!.headers.get("cf-aig-collect-log-payload")).toBe(
        String(logPayloads),
      );
    },
  );

  it("forwards the body byte for byte", async () => {
    const { sent, app } = gateway();
    const body =
      '{ "messages":[{"role":"user","content":"hi"}],\n  "model":"cloudflare/auto" }';
    await app.fetch(chat({ body }), ENV);

    expect(await sent[0]!.text()).toBe(body);
  });

  it("drops the caller's credential and Gateway control headers", async () => {
    const { sent, app } = gateway();
    await app.fetch(
      chat({
        headers: {
          "cf-aig-allowed-models": "anthropic/*",
          "cf-aig-no-session-affinity": "true",
          "cf-aig-session-id": "smuggled",
          "cf-aig-max-attempts": "5",
          "x-extra": "1",
        },
      }),
      ENV,
    );

    const headers = sent[0]!.headers;
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("cf-aig-allowed-models")).toBe(
      "openai/gpt-5.6-luna,anthropic/claude-opus-5.5",
    );
    expect(headers.get("cf-aig-no-session-affinity")).toBeNull();
    expect(headers.get("cf-aig-session-id")).toBeNull();
    expect(headers.get("cf-aig-max-attempts")).toBe("1");
    expect(headers.get("x-extra")).toBeNull();
  });

  it("maps the caller's session and turn to the Gateway's headers", async () => {
    const { sent, app } = gateway();
    await app.fetch(
      chat({ headers: { "x-session-id": "run-7:branch-a", "x-turn-id": "3" } }),
      ENV,
    );

    expect(sent[0]!.headers.get("cf-aig-session-id")).toBe("run-7:branch-a");
    expect(sent[0]!.headers.get("cf-aig-turn-id")).toBe("3");
  });

  it("sends no session headers when the caller gives none", async () => {
    const { sent, app } = gateway();
    await app.fetch(chat(), ENV);

    expect(sent[0]!.headers.get("cf-aig-session-id")).toBeNull();
    expect(sent[0]!.headers.get("cf-aig-turn-id")).toBeNull();
  });
});

describe("relaying the response", () => {
  it("returns the Gateway's status, body and routing headers, and nothing else", async () => {
    const { app } = gateway(() =>
      Response.json(
        { error: "rate limited" },
        {
          status: 429,
          headers: {
            "cf-aig-routed-model": "openai/gpt-5.6-luna",
            "cf-aig-routing-reason": "cost_optimal_within_pool",
            "cf-aig-routing-decision-id": "decision-1",
            "retry-after": "2",
            "set-cookie": "a=b",
          },
        },
      ),
    );
    const response = await app.fetch(chat(), ENV);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate limited" });
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cf-aig-routed-model")).toBe(
      "openai/gpt-5.6-luna",
    );
    expect(response.headers.get("cf-aig-routing-reason")).toBe(
      "cost_optimal_within_pool",
    );
    expect(response.headers.get("cf-aig-routing-decision-id")).toBe(
      "decision-1",
    );
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("adds the selected model and config hash that sr-bench reads", async () => {
    const { app } = gateway(() =>
      Response.json(
        {},
        { headers: { "cf-aig-routed-model": "openai/gpt-6-sol" } },
      ),
    );
    const response = await app.fetch(chat(), ENV);

    expect(response.headers.get("x-vsr-selected-model")).toBe(
      "openai/gpt-6-sol",
    );
    expect(response.headers.get("x-vsr-config-hash")).toBe(CONFIG_HASH);
  });

  it("omits the selected model when the Gateway names none", async () => {
    const { app } = gateway();
    const response = await app.fetch(chat(), ENV);

    expect(response.headers.get("x-vsr-selected-model")).toBeNull();
  });

  it("delivers streamed chunks before the upstream finishes, and cancels with the caller", async () => {
    const upstream = eventStream();
    const { app } = gateway(upstream.response);
    const response = await app.fetch(chat({ body: STREAMED_CHAT }), ENV);
    const reader = response.body!.getReader();

    upstream.push("data: one\n\n");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: one\n\n");

    await reader.cancel();
    expect(upstream.wasCancelled()).toBe(true);
  });

  // This holds in Node. In workerd, a caller leaving before response headers did
  // not abort the request's signal in local tests; see the README.
  it("passes the caller's abort signal on to the Gateway request", async () => {
    const { sent, app } = gateway();
    const controller = new AbortController();
    await app.fetch(chat({ signal: controller.signal }), ENV);

    expect(sent[0]!.signal.aborted).toBe(false);
    controller.abort();
    expect(sent[0]!.signal.aborted).toBe(true);
  });
});

describe("when the Gateway does not respond", () => {
  it("answers 502 without retrying when the request fails", async () => {
    const { sent, records, app } = gateway(() => {
      throw new TypeError("network down");
    });
    const response = await app.fetch(chat(), ENV);

    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe("gateway_unreachable");
    expect(sent).toHaveLength(1);
    expect(records).toEqual([
      expect.objectContaining({
        event: "gateway_no_response",
        reason: "network",
        error: "TypeError",
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain("network down");
  });

  it("gives up at the deadline and aborts the Gateway request", async () => {
    const { sent, records, deadlines, expire, app } = gateway(hang);
    const pending = app.fetch(chat(), ENV);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expire();
    const response = await pending;

    expect(deadlines).toEqual([ENV.AUTO_ROUTER.deadlineMs]);
    expect(sent[0]!.signal.aborted).toBe(true);
    expect(response.status).toBe(504);
    expect(await errorCode(response)).toBe("gateway_timeout");
    expect(records).toEqual([
      expect.objectContaining({
        event: "gateway_no_response",
        reason: "timeout",
      }),
    ]);
  });

  it("records a caller who leaves before the response as cancelled", async () => {
    const { sent, records, app } = gateway(hang);
    const caller = new AbortController();
    const pending = app.fetch(chat({ signal: caller.signal }), ENV);
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    caller.abort();
    const response = await pending;

    expect(response.status).toBe(499);
    expect(records).toEqual([
      expect.objectContaining({
        event: "gateway_no_response",
        reason: "cancelled",
      }),
    ]);
  });
});

describe("sr-bench's request headers", () => {
  it("forwards a request that expects this deployment's config hash", async () => {
    const { sent, app } = gateway();
    const response = await app.fetch(
      chat({ headers: { "x-sr-bench-expected-config-hash": CONFIG_HASH } }),
      ENV,
    );

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("refuses a request that expects another config hash, and names the actual one", async () => {
    const { sent, app } = gateway();
    const response = await app.fetch(
      chat({ headers: { "x-sr-bench-expected-config-hash": "0000" } }),
      ENV,
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("x-vsr-config-hash")).toBe(CONFIG_HASH);
    expect(await errorCode(response)).toBe("config_hash_mismatch");
    expect(sent).toHaveLength(0);
  });

  it.each(["1", "5"])(
    "forwards a request allowing %s inference calls",
    async (limit) => {
      const { sent, app } = gateway();
      await app.fetch(
        chat({ headers: { "x-sr-bench-max-inference-calls": limit } }),
        ENV,
      );

      expect(sent).toHaveLength(1);
    },
  );

  it.each(["0", "-1", "1.5", "two"])(
    "refuses a request allowing %s inference calls",
    async (limit) => {
      const { sent, app } = gateway();
      const response = await app.fetch(
        chat({ headers: { "x-sr-bench-max-inference-calls": limit } }),
        ENV,
      );

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("invalid_inference_call_limit");
      expect(sent).toHaveLength(0);
    },
  );
});

describe("the decision record", () => {
  it("logs the routing decision once per forwarded request, without prompt text", async () => {
    const { records, app } = gateway(() =>
      Response.json(
        { choices: [{ message: { content: "a private answer" } }] },
        {
          headers: {
            "cf-aig-routed-model": "anthropic/claude-opus-5.5",
            "cf-aig-routing-reason": "pinned_by_turn",
            "cf-aig-routing-decision-id": "decision-2",
            "cf-aig-request-id": "request-2",
          },
        },
      ),
    );
    const body = {
      ...CHAT,
      messages: [{ role: "user", content: "a private prompt" }],
    };
    const response = await app.fetch(
      chat({ body, headers: { "x-session-id": "run-7" } }),
      ENV,
    );
    await response.text();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "auto_router_response",
      sessionId: "run-7",
      turnId: null,
      configHash: CONFIG_HASH,
      stream: false,
      requestBytes: JSON.stringify(body).length,
      status: 200,
      routedModel: "anthropic/claude-opus-5.5",
      routingReason: "pinned_by_turn",
      decisionId: "decision-2",
      gatewayRequestId: "request-2",
    });
    expect(JSON.stringify(records)).not.toContain("private");
  });
});

describe("response timing", () => {
  it("times headers, the first token and the end of a streamed response", async () => {
    const upstream = eventStream();
    const { records, clock, app } = gateway(() => {
      clock.ms = 5;
      return upstream.response();
    });
    const response = await app.fetch(chat({ body: STREAMED_CHAT }), ENV);
    const reader = response.body!.getReader();

    clock.ms = 10;
    upstream.push(event({ role: "assistant", content: "" }));
    await reader.read();
    clock.ms = 30;
    upstream.push(event({ content: "Hi" }));
    await reader.read();
    clock.ms = 40;
    upstream.push(event({ content: " there" }));
    await reader.read();
    expect(records).toHaveLength(0);

    clock.ms = 50;
    upstream.push("data: [DONE]\n\n");
    upstream.close();
    await reader.read();
    expect((await reader.read()).done).toBe(true);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      stream: true,
      msToHeaders: 5,
      msToFirstToken: 30,
      msTotal: 50,
      ended: "complete",
    });
  });

  it.each([
    ["reasoning", { reasoning_content: "Let me think" }],
    [
      "a tool call",
      { tool_calls: [{ index: 0, function: { name: "search" } }] },
    ],
  ])("counts %s as the first token", async (_name, delta) => {
    const upstream = eventStream();
    const { records, clock, app } = gateway(upstream.response);
    const response = await app.fetch(chat({ body: STREAMED_CHAT }), ENV);

    clock.ms = 20;
    upstream.push(event(delta));
    upstream.close();
    await response.text();

    expect(records[0]).toMatchObject({ msToFirstToken: 20 });
  });

  it("finds a first token whose event is split across chunks", async () => {
    const upstream = eventStream();
    const { records, clock, app } = gateway(upstream.response);
    const response = await app.fetch(chat({ body: STREAMED_CHAT }), ENV);
    const reader = response.body!.getReader();
    const whole = event({ content: "Hi" });

    clock.ms = 10;
    upstream.push(whole.slice(0, 20));
    await reader.read();
    clock.ms = 25;
    upstream.push(whole.slice(20));
    upstream.close();
    await reader.read();
    await reader.read();

    expect(records[0]).toMatchObject({ msToFirstToken: 25 });
  });

  it("records no first token for a response that is not streamed", async () => {
    const { records, clock, app } = gateway(() => {
      clock.ms = 80;
      return Response.json({ choices: [{ message: { content: "Hi" } }] });
    });
    const response = await app.fetch(chat(), ENV);
    clock.ms = 90;
    await response.text();

    expect(records[0]).toMatchObject({
      msToHeaders: 80,
      msToFirstToken: null,
      msTotal: 90,
      ended: "complete",
    });
  });

  it("records a response without a body as soon as its headers arrive", async () => {
    const { records, clock, app } = gateway(() => {
      clock.ms = 7;
      return new Response(null, { status: 204 });
    });
    await app.fetch(chat(), ENV);

    expect(records[0]).toMatchObject({
      status: 204,
      msTotal: 7,
      ended: "complete",
    });
  });

  it("records when the caller stops reading", async () => {
    const upstream = eventStream();
    const { records, clock, app } = gateway(upstream.response);
    const response = await app.fetch(chat({ body: STREAMED_CHAT }), ENV);
    const reader = response.body!.getReader();

    clock.ms = 10;
    upstream.push(event({ content: "Hi" }));
    await reader.read();
    clock.ms = 15;
    await reader.cancel();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      msToFirstToken: 10,
      msTotal: 15,
      ended: "cancelled",
    });
  });

  it("records when the upstream stream breaks, and passes the failure on", async () => {
    const upstream = eventStream();
    const { records, clock, app } = gateway(upstream.response);
    const response = await app.fetch(chat({ body: STREAMED_CHAT }), ENV);
    const reader = response.body!.getReader();

    clock.ms = 12;
    upstream.fail(new Error("connection reset"));

    await expect(reader.read()).rejects.toThrow("connection reset");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      msToFirstToken: null,
      msTotal: 12,
      ended: "error",
    });
  });

  it("cuts a stream off at the deadline, and cancels the upstream", async () => {
    const upstream = eventStream();
    const { records, clock, expire, app } = gateway(upstream.response);
    const response = await app.fetch(chat({ body: STREAMED_CHAT }), ENV);
    const reader = response.body!.getReader();

    clock.ms = 10;
    upstream.push(event({ content: "Hi" }));
    await reader.read();
    clock.ms = 60;
    expire();

    await expect(reader.read()).rejects.toThrow("The deadline passed.");
    expect(upstream.wasCancelled()).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      msToFirstToken: 10,
      msTotal: 60,
      ended: "timeout",
    });
  });
});

describe("requests the Worker refuses itself", () => {
  const cases: Array<[string, Request, number, string]> = [
    ["an unknown path", chat({ path: "/v1/models" }), 404, "not_found"],
    [
      "a method other than POST",
      chat({ method: "GET" }),
      405,
      "method_not_allowed",
    ],
    [
      "a missing token",
      chat({ headers: { authorization: "" } }),
      401,
      "unauthorized",
    ],
    [
      "a wrong token",
      chat({ headers: { authorization: "Bearer nope" } }),
      401,
      "unauthorized",
    ],
    [
      "a credential that is not a bearer token",
      chat({ headers: { authorization: "Basic abc" } }),
      400,
      "invalid_authorization_header",
    ],
    ["a body that is not JSON", chat({ body: "{" }), 400, "invalid_json"],
    ["a body that is not an object", chat({ body: "[]" }), 400, "invalid_json"],
    [
      "a model other than the Auto Router",
      chat({ body: { ...CHAT, model: "openai/gpt-6-sol" } }),
      400,
      "unsupported_model",
    ],
    [
      "a malformed session ID",
      chat({ headers: { "x-session-id": "a b" } }),
      400,
      "invalid_identity",
    ],
    [
      "an oversized body",
      chat({ headers: { "content-length": String(17 * 1024 * 1024) } }),
      413,
      "body_too_large",
    ],
  ];

  it.each(cases)("rejects %s", async (_name, request, status, code) => {
    const { sent, records, app } = gateway();
    const response = await app.fetch(request, ENV);

    expect(response.status).toBe(status);
    expect(await errorCode(response)).toBe(code);
    expect(sent).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  it("answers 500 without naming the missing setting when it is misconfigured", async () => {
    const { sent, app } = gateway();
    const response = await app.fetch(chat(), { ...ENV, AIG_TOKEN: undefined });

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("AIG_TOKEN");
    expect(sent).toHaveLength(0);
  });
});
