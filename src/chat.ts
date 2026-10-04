import type { Settings } from "./config.ts";
import type { Entrypoints } from "./entrypoints.ts";
import { errorResponse } from "./errors.ts";
import {
  aiBindingCall,
  autoRouterRequest,
  exactModelRequest,
  readDecision,
  relayResponse,
  usesAiBinding,
  withSessionCacheKey,
  type RoutingDecision,
  type SessionIdentity,
} from "./gateway.ts";
import {
  routeRequest,
  summarizeRoute,
  type RouteResult,
  type RouteSummary,
} from "./policy/policy.ts";
import { timed, type BodyTiming } from "./timing.ts";

/**
 * One line per request that reached a router, written when the response body
 * ends, or at once when a policy chooses no model. It never contains prompt or
 * response text. Times are milliseconds since the Worker sent the request to
 * the Gateway.
 */
export type RequestRecord = SessionIdentity & {
  /** The model name the caller sent, which selects the router. */
  entrypoint: string;
  configHash: string;
  stream: boolean;
  requestBytes: number;
  /** For a `policy/` entrypoint: how the policy routed the request. */
  policy?: RouteSummary;
} & (
    | ({
        event: "auto_router_response";
        status: number;
        /** Until response headers arrived. */
        msToHeaders: number;
      } & RoutingDecision &
        BodyTiming)
    | ({
        event: "model_response";
        /** The model the Worker asked to answer. */
        model: string;
        status: number;
        /** Until response headers arrived. */
        msToHeaders: number;
        gatewayRequestId: string | null;
      } & BodyTiming)
    | {
        event: "gateway_no_response";
        /** The model the Worker asked to answer; absent for the Auto Router. */
        model?: string;
        /** Until the request failed. */
        msToHeaders: number;
        /** "cancelled" means the caller went away first; "network" means the request failed. */
        reason: "timeout" | "cancelled" | "network";
        /** The error's name, such as "TypeError". Its message is not logged. */
        error: string;
      }
    | {
        /** The policy chose no model, so the Gateway was not called. */
        event: "routing_failed";
      }
  );

type RecordBase = Omit<RequestRecord, "event">;

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
 * Serves one Chat Completions request. The model name selects the router:
 * the Auto Router gets the request as sent; a policy or a direct entrypoint
 * names one model, and the request goes to that model. The caller has
 * already been checked.
 */
export async function handleChat(
  request: Request,
  settings: Settings,
  deps: Deps,
  served: Entrypoints,
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
  const entrypoint = await served.resolve(parsed.model, settings);
  if (entrypoint === undefined) {
    return invalid("unsupported_model", served.served(settings.allowedModels));
  }

  // sr-bench states which setup it expects to measure; refuse to measure another.
  const expectedHash = request.headers.get("x-sr-bench-expected-config-hash");
  if (expectedHash !== null && expectedHash !== entrypoint.configHash) {
    return errorResponse(
      409,
      "invalid_request_error",
      "config_hash_mismatch",
      `The config hash of "${entrypoint.name}" on this deployment is ${entrypoint.configHash}.`,
      { "x-vsr-config-hash": entrypoint.configHash },
    );
  }

  const record = {
    ...identity,
    entrypoint: entrypoint.name,
    configHash: entrypoint.configHash,
    stream: parsed.stream === true,
    requestBytes: body.byteLength,
  };
  switch (entrypoint.router) {
    case "auto_router":
      return callGateway(request, settings, deps, record, {
        model: null,
        // The original bytes are forwarded, so the Gateway sees exactly what the caller sent.
        send: (signal) =>
          deps.fetch(autoRouterRequest(settings, body, identity, signal)),
      });
    case "direct":
      return callGateway(request, settings, deps, record, {
        model: entrypoint.model,
        send: await namedModelCall(
          settings,
          deps,
          entrypoint.model,
          parsed,
          identity,
        ),
      });
    case "policy": {
      const result = routeRequest(entrypoint.policy, parsed);
      const routed = { ...record, policy: summarizeRoute(result) };
      if (result.outcome !== "routed") {
        deps.log({ event: "routing_failed", ...routed });
        return routingFailed(result);
      }
      return callGateway(request, settings, deps, routed, {
        model: result.model,
        decision: result.decision,
        send: await namedModelCall(
          settings,
          deps,
          result.model,
          parsed,
          identity,
        ),
      });
    }
  }
}

/** One Gateway call. `model` is the model asked to answer, or null when the Auto Router chooses. */
interface Call {
  model: string | null;
  decision?: string;
  send: (signal: AbortSignal) => Promise<Response>;
}

/**
 * How one named model is called: through the Gateway's compat endpoint, or
 * through the AI binding for the models that endpoint does not serve. The
 * body is the caller's, with a cache key for the session where the model
 * needs one to read from its cache.
 */
async function namedModelCall(
  settings: Settings,
  deps: Deps,
  model: string,
  body: Record<string, unknown>,
  identity: SessionIdentity,
): Promise<Call["send"]> {
  const sent = await withSessionCacheKey(body, model, identity.sessionId);
  return usesAiBinding(model)
    ? (signal) => aiBindingCall(settings, model, sent, signal)
    : (signal) => deps.fetch(exactModelRequest(settings, model, sent, signal));
}

/**
 * Sends one request to the Gateway, relays the response, and logs one record
 * when it ends. The same deadline, timing and record serve every router.
 */
async function callGateway(
  request: Request,
  settings: Settings,
  deps: Deps,
  record: RecordBase,
  call: Call,
): Promise<Response> {
  const deadline = deps.deadline(settings.deadlineMs);
  const started = deps.now();
  const elapsed = () => deps.now() - started;
  let upstream: Response;
  try {
    upstream = await call.send(AbortSignal.any([request.signal, deadline]));
  } catch (error) {
    const reason = deadline.aborted
      ? "timeout"
      : request.signal.aborted
        ? "cancelled"
        : "network";
    deps.log({
      event: "gateway_no_response",
      ...record,
      ...(call.model !== null && { model: call.model }),
      msToHeaders: elapsed(),
      reason,
      error: error instanceof Error ? error.name : "unknown",
    });
    return noResponse(reason, settings.deadlineMs);
  }

  const msToHeaders = elapsed();
  const logResponse = (timing: BodyTiming) =>
    deps.log(
      call.model === null
        ? {
            event: "auto_router_response",
            ...record,
            msToHeaders,
            ...timing,
            status: upstream.status,
            ...readDecision(upstream.headers),
          }
        : {
            event: "model_response",
            ...record,
            model: call.model,
            msToHeaders,
            ...timing,
            status: upstream.status,
            gatewayRequestId: upstream.headers.get("cf-aig-request-id"),
          },
    );
  const receipt = {
    configHash: record.configHash,
    selectedModel: call.model ?? upstream.headers.get("cf-aig-routed-model"),
    selectedDecision: call.decision,
  };

  if (upstream.body === null) {
    logResponse({
      msToFirstToken: null,
      msTotal: msToHeaders,
      ended: "complete",
    });
    return relayResponse(upstream, null, receipt);
  }
  const timedBody = timed(upstream.body, {
    eventStream:
      upstream.headers.get("content-type")?.startsWith("text/event-stream") ??
      false,
    elapsed,
    deadline,
    onEnd: logResponse,
  });
  return relayResponse(upstream, timedBody, receipt);
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

/**
 * The request is valid, but the policy cannot send it anywhere. The same
 * request fails the same way again, so the status is 422, not 5xx.
 */
function routingFailed(
  result: Exclude<RouteResult, { outcome: "routed" }>,
): Response {
  if (result.outcome === "unresolved") {
    return errorResponse(
      422,
      "invalid_request_error",
      "routing_unresolved",
      result.message,
    );
  }
  const reasons = result.rejected
    .map(({ model, reasons }) => `${model}: ${reasons.join("; ")}.`)
    .join(" ");
  return errorResponse(
    422,
    "invalid_request_error",
    "no_eligible_model",
    `No candidate of decision "${result.decision}" can serve this request. ${reasons}`,
  );
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
