import { createApp } from "../src/app.ts";
import type { Deps, RequestRecord } from "../src/chat.ts";

export const CHAT = {
  model: "cloudflare/auto",
  messages: [{ role: "user", content: "hello" }],
};

/**
 * A stand-in for the Gateway that records what it was sent and what the Worker
 * logged. Time stands still unless a test moves `clock.ms`, and the deadline
 * passes only when a test calls `expire()`. `policies` replace the bundled ones.
 */
export function gateway(
  respond: (request: Request) => Response | Promise<Response> = () =>
    Response.json({ ok: true }),
  policies?: Record<string, unknown>,
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
  return {
    sent,
    records,
    clock,
    deadlines,
    expire,
    app: createApp(deps, policies),
  };
}

/** A Gateway response that never arrives; it fails only when its request is aborted. */
export function hang(request: Request): Promise<Response> {
  return new Promise((_, reject) =>
    request.signal.addEventListener("abort", () =>
      reject(request.signal.reason),
    ),
  );
}

/** An event-stream response whose chunks the test sends one at a time. */
export function eventStream() {
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
export function event(delta: object): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;
}

export function chat(
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

export async function errorCode(response: Response): Promise<string> {
  const envelope = (await response.json()) as { error: { code: string } };
  return envelope.error.code;
}
