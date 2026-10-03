import type { Settings } from "./config.ts";
import { errorResponse } from "./errors.ts";
import {
  AUTO_ROUTER_MODEL,
  autoRouterRequest,
  readDecision,
  relayResponse,
  type RoutingDecision,
  type SessionIdentity,
} from "./gateway.ts";
import { timed, type BodyTiming } from "./timing.ts";

/**
 * One line per forwarded request, written when the response body ends. It never
 * contains prompt or response text. Times are milliseconds since the Worker
 * sent the request to the Gateway.
 */
export type RequestRecord = SessionIdentity & {
  configHash: string;
  stream: boolean;
  requestBytes: number;
  /** Until response headers arrived, or until the request failed. */
  msToHeaders: number;
} & (
    | ({ event: "auto_router_response"; status: number } & RoutingDecision &
        BodyTiming)
    | {
        event: "gateway_no_response";
        /** "cancelled" means the caller went away first; "network" means the request failed. */
        reason: "timeout" | "cancelled" | "network";
        /** The error's name, such as "TypeError". Its message is not logged. */
        error: string;
      }
  );

/** The outside world, passed in so the handler can be tested without a network. */
export interface Deps {
  fetch: (request: Request) => Promise<Response>;
  log: (record: RequestRecord) => void;
  /** The current time in milliseconds. */
  now: () => number;
  /** A signal that aborts after the given number of milliseconds. */
  deadline: (ms: number) => AbortSignal;
}

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const IDENTITY_PATTERN = /^[\w.:-]{1,128}$/;
const WHOLE_NUMBER = /^\d+$/;

/**
 * Forwards a Chat Completions request to the Auto Router and records its decision.
 * The caller has already been checked.
 */
export async function passthrough(
  request: Request,
  settings: Settings,
  deps: Deps,
): Promise<Response> {
  const identity = {
    sessionId: request.headers.get("x-session-id"),
    turnId: request.headers.get("x-turn-id"),
  };
  for (const id of [identity.sessionId, identity.turnId]) {
    if (id !== null && !IDENTITY_PATTERN.test(id)) {
      return invalid(
        "invalid_identity",
        "x-session-id and x-turn-id must be 1 to 128 letters, digits, or . _ : -",
      );
    }
  }

  // sr-bench states which setup it expects to measure; refuse to measure another.
  const expectedHash = request.headers.get("x-sr-bench-expected-config-hash");
  if (expectedHash !== null && expectedHash !== settings.configHash) {
    return errorResponse(
      409,
      "invalid_request_error",
      "config_hash_mismatch",
      `This deployment's config hash is ${settings.configHash}.`,
      { "x-vsr-config-hash": settings.configHash },
    );
  }
  const callLimit = request.headers.get("x-sr-bench-max-inference-calls");
  if (
    callLimit !== null &&
    !(WHOLE_NUMBER.test(callLimit) && Number(callLimit) >= 1)
  ) {
    return invalid(
      "invalid_inference_call_limit",
      "This endpoint makes one generation call, so x-sr-bench-max-inference-calls must be a whole number of at least 1.",
    );
  }

  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    return tooLarge();
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) return tooLarge();

  const parsed = parseObject(body);
  if (parsed === null) {
    return invalid("invalid_json", "The request body must be a JSON object.");
  }
  if (parsed.model !== AUTO_ROUTER_MODEL) {
    return invalid(
      "unsupported_model",
      `This endpoint serves only the model "${AUTO_ROUTER_MODEL}".`,
    );
  }

  const record = {
    ...identity,
    configHash: settings.configHash,
    stream: parsed.stream === true,
    requestBytes: body.byteLength,
  };
  const deadline = deps.deadline(settings.deadlineMs);
  const started = deps.now();
  const elapsed = () => deps.now() - started;
  let upstream: Response;
  try {
    // The original bytes are forwarded, so the Gateway sees exactly what the caller sent.
    upstream = await deps.fetch(
      autoRouterRequest(
        settings,
        body,
        identity,
        AbortSignal.any([request.signal, deadline]),
      ),
    );
  } catch (error) {
    const reason = deadline.aborted
      ? "timeout"
      : request.signal.aborted
        ? "cancelled"
        : "network";
    deps.log({
      event: "gateway_no_response",
      ...record,
      msToHeaders: elapsed(),
      reason,
      error: error instanceof Error ? error.name : "unknown",
    });
    return noResponse(reason, settings.deadlineMs);
  }

  const msToHeaders = elapsed();
  const logResponse = (timing: BodyTiming) =>
    deps.log({
      event: "auto_router_response",
      ...record,
      msToHeaders,
      ...timing,
      status: upstream.status,
      ...readDecision(upstream.headers),
    });

  if (upstream.body === null) {
    logResponse({
      msToFirstToken: null,
      msTotal: msToHeaders,
      ended: "complete",
    });
    return relayResponse(upstream, null, settings.configHash);
  }
  const timedBody = timed(upstream.body, {
    eventStream:
      upstream.headers.get("content-type")?.startsWith("text/event-stream") ??
      false,
    elapsed,
    deadline,
    onEnd: logResponse,
  });
  return relayResponse(upstream, timedBody, settings.configHash);
}

function parseObject(body: ArrayBuffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    const isObject =
      typeof value === "object" && value !== null && !Array.isArray(value);
    return isObject ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function noResponse(
  reason: "timeout" | "cancelled" | "network",
  deadlineMs: number,
): Response {
  switch (reason) {
    case "timeout":
      return errorResponse(
        504,
        "api_error",
        "gateway_timeout",
        `AI Gateway did not respond within ${deadlineMs} ms. The request was not retried.`,
      );
    case "cancelled":
      // Nobody reads this: the caller has gone. 499 marks it in logs, as nginx does.
      return errorResponse(
        499,
        "invalid_request_error",
        "client_closed_request",
        "The caller closed the request.",
      );
    case "network":
      return errorResponse(
        502,
        "api_error",
        "gateway_unreachable",
        "The request to AI Gateway failed before a response arrived. It was not retried.",
      );
  }
}

function invalid(code: string, message: string): Response {
  return errorResponse(400, "invalid_request_error", code, message);
}

function tooLarge(): Response {
  return errorResponse(
    413,
    "invalid_request_error",
    "body_too_large",
    `The request body exceeds ${MAX_BODY_BYTES} bytes.`,
  );
}
