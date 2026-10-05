import type { AutoRouterPolicy, Settings } from "./config.ts";
import { shortHash } from "./hash.ts";
import { ANTHROPIC_FORMAT, CACHE_KEY_MODELS, VIA_AI_BINDING } from "./reach.ts";

/** The model name that selects the Auto Router on AI Gateway. */
export const AUTO_ROUTER_MODEL = "cloudflare/auto";

/** Headers sent on every request. They can change results, so they are in the config hash. */
const FIXED_HEADERS = {
  // A cached answer would hide the routing decision and its cost.
  "cf-aig-skip-cache": "true",
  // The Worker makes one generation call; the Gateway must not add retries.
  "cf-aig-max-attempts": "1",
};

/** The body field that a provider takes as the key of its prompt cache. */
const CACHE_KEY = "prompt_cache_key";

/** Which session and turn a request belongs to, as supplied by the caller. */
export interface SessionIdentity {
  sessionId: string | null;
  turnId: string | null;
}

/** What the Auto Router reports about its choice, read from response headers. */
export interface RoutingDecision {
  routedModel: string | null;
  routingReason: string | null;
  decisionId: string | null;
  gatewayRequestId: string | null;
}

/**
 * Builds the request to the Auto Router. Every header is set here: nothing the
 * caller sent reaches the Gateway except the body and the session identity.
 */
export function autoRouterRequest(
  settings: Settings,
  body: ArrayBuffer,
  identity: SessionIdentity,
  signal: AbortSignal,
): Request {
  const headers = gatewayHeaders(settings);
  headers.set("cf-aig-allowed-models", settings.allowedModels.join(","));
  // Without a session ID the Auto Router chooses a model per request.
  if (identity.sessionId !== null) {
    headers.set("cf-aig-session-id", identity.sessionId);
  }
  if (identity.turnId !== null) headers.set("cf-aig-turn-id", identity.turnId);

  return new Request(settings.chatCompletionsUrl, {
    method: "POST",
    headers,
    body,
    signal,
  });
}

/**
 * Builds the request to one named model, through the same Gateway endpoint
 * as the Auto Router. The body is the caller's, written out again with the
 * changes in `namedModelBody`. The session headers are left out: they are the
 * Auto Router's, and the Gateway documents no use for them on a named model.
 */
export function exactModelRequest(
  settings: Settings,
  model: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Request {
  return new Request(settings.chatCompletionsUrl, {
    method: "POST",
    headers: gatewayHeaders(settings),
    body: JSON.stringify(namedModelBody(body, model)),
    signal,
  });
}

/**
 * The caller's body with a cache key for its session, for a model that gets
 * one; see `CACHE_KEY_MODELS`. Any other body comes back as it is.
 *
 * The key is a hash of the session ID: every call of a session carries the
 * same key, and the provider does not get the caller's own ID. A body that
 * already has a key, or a `user`, which such a model uses the same way, is
 * the caller's choice and is kept. A call with no session gets no key: the
 * Worker knows of no later call that shares its prompt.
 */
export async function withSessionCacheKey(
  body: Record<string, unknown>,
  model: string,
  sessionId: string | null,
): Promise<Record<string, unknown>> {
  if (
    sessionId === null ||
    !CACHE_KEY_MODELS.includes(model) ||
    Object.hasOwn(body, CACHE_KEY) ||
    Object.hasOwn(body, "user")
  ) {
    return body;
  }
  return { ...body, [CACHE_KEY]: `session-${await shortHash(sessionId)}` };
}

/** The part of the Worker's AI binding that this Worker uses. */
export interface AiBinding {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options: {
      gateway: {
        id: string;
        skipCache: boolean;
        collectLog: boolean;
        retries: { maxAttempts: number };
      };
      /** The provider's response as it is, with its status and headers. */
      returnRawResponse: true;
      signal: AbortSignal;
    },
  ): Promise<Response>;
}

/** Whether a call that names this model goes through the AI binding; see `VIA_AI_BINDING`. */
export function usesAiBinding(model: string): boolean {
  return VIA_AI_BINDING.includes(model);
}

/** Whether the binding takes and answers this model in Anthropic's format; see `ANTHROPIC_FORMAT`. */
export function usesAnthropicFormat(model: string): boolean {
  return ANTHROPIC_FORMAT.includes(model);
}

/**
 * Calls one named model through the Worker's AI binding; see `VIA_AI_BINDING`
 * for which models and why. The request goes through the same Gateway,
 * under unified billing, with the settings the fixed headers give a call to
 * the endpoint: no cached answer and one attempt. The model is named apart
 * from the body, so `model` is left out of it; nothing else changes.
 *
 * The binding has no setting for the Gateway to log a request without its
 * text. So when `logPayloads` is off, such a call is not logged at all.
 */
export function aiBindingCall(
  settings: Settings,
  model: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const { model: _named, ...inputs } = body;
  // `readSettings` has checked both for a pool that has such a model.
  return settings.ai!.run(model, inputs, {
    gateway: {
      id: settings.gatewayId!,
      skipCache: true,
      collectLog: settings.logPayloads,
      retries: { maxAttempts: 1 },
    },
    returnRawResponse: true,
    signal,
  });
}

/**
 * The caller's body as one named model accepts it, with the keys in their
 * order. `model` becomes the Gateway's name for the model. OpenAI's models
 * refuse `max_tokens` when named, though the Auto Router accepts it for them,
 * so for an OpenAI model it becomes `max_completion_tokens`, or is dropped
 * when that is also given: then it would not apply anyway.
 */
function namedModelBody(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const openAI = model.startsWith("openai/");
  const hasCompletionLimit = Object.hasOwn(body, "max_completion_tokens");
  return Object.fromEntries(
    Object.entries(body).flatMap(([key, value]): [string, unknown][] => {
      if (key === "model") return [[key, gatewayModelName(model)]];
      if (key === "max_tokens" && openAI) {
        return hasCompletionLimit ? [] : [["max_completion_tokens", value]];
      }
      return [[key, value]];
    }),
  );
}

/**
 * The pool names models as the Auto Router does. A call to one named model
 * uses the compat endpoint's `{provider}/{model}` form, which for Workers AI
 * is `workers-ai/@cf/...`.
 */
function gatewayModelName(model: string): string {
  return model.startsWith("@cf/") ? `workers-ai/${model}` : model;
}

function gatewayHeaders(settings: Settings): Headers {
  return new Headers({
    ...FIXED_HEADERS,
    "content-type": "application/json",
    "cf-aig-authorization": `Bearer ${settings.gatewayToken}`,
    "cf-aig-collect-log-payload": String(settings.logPayloads),
  });
}

/**
 * A short hash of everything that decides how the Auto Router is called. It is
 * returned on every response and checked against sr-bench's expected hash, so a
 * benchmark run can prove which setup it measured. It identifies this Worker's
 * setup, not Cloudflare's internal router version.
 */
export async function configHash(policy: AutoRouterPolicy): Promise<string> {
  const canonical = JSON.stringify({
    model: AUTO_ROUTER_MODEL,
    allowedModels: policy.allowedModels,
    poolPinnedOn: policy.poolPinnedOn,
    deadlineMs: policy.deadlineMs,
    fixedHeaders: FIXED_HEADERS,
  });
  return shortHash(canonical);
}

/**
 * The config hash of an entrypoint that calls one named model: the model, or
 * the version of the policy that chooses it; how each model it can call is
 * reached, by the name the Gateway gets or through the AI binding, and in
 * which format; which of them get a session's cache key; the deadline; and
 * the fixed headers. Like `configHash`, it leaves out `logPayloads`, which
 * does not change results.
 */
export async function exactModelConfigHash(
  target: { model: string } | { policyVersion: string },
  models: readonly string[],
  deadlineMs: number,
): Promise<string> {
  const gatewayNames = Object.fromEntries(
    models.map((model) => [model, reachedBy(model)]),
  );
  const cacheKeyed = models.filter((model) => CACHE_KEY_MODELS.includes(model));
  return shortHash(
    JSON.stringify({
      ...target,
      gatewayNames,
      deadlineMs,
      fixedHeaders: FIXED_HEADERS,
      // Left out when no model gets a key, so such an entrypoint keeps its hash.
      ...(cacheKeyed.length > 0 && { sessionCacheKey: cacheKeyed }),
    }),
  );
}

function reachedBy(model: string): string {
  if (!usesAiBinding(model)) return gatewayModelName(model);
  return usesAnthropicFormat(model)
    ? `ai-binding:anthropic-format:${model}`
    : `ai-binding:${model}`;
}

export function readDecision(headers: Headers): RoutingDecision {
  return {
    routedModel: headers.get("cf-aig-routed-model"),
    routingReason: headers.get("cf-aig-routing-reason"),
    decisionId: headers.get("cf-aig-routing-decision-id"),
    gatewayRequestId: headers.get("cf-aig-request-id"),
  };
}

const RELAYED_HEADERS = ["content-type", "retry-after"];

/** What the Worker adds to a relayed response, in the header names of vLLM-SR. */
export interface Receipt {
  configHash: string;
  /** The model that was asked to answer, when it is known. */
  selectedModel: string | null;
  /** The policy decision that chose it, for a policy entrypoint. */
  selectedDecision?: string;
}

/**
 * Answers with the Gateway's status and the given body. Only the Gateway's own
 * `cf-aig-*` headers and the few a client needs are kept, plus the receipt:
 * sr-bench reads the selected model and the config hash.
 */
export function relayResponse(
  upstream: Response,
  body: ReadableStream<Uint8Array> | null,
  receipt: Receipt,
): Response {
  const headers = new Headers({ "x-vsr-config-hash": receipt.configHash });
  for (const [name, value] of upstream.headers) {
    if (name.startsWith("cf-aig-") || RELAYED_HEADERS.includes(name)) {
      headers.set(name, value);
    }
  }
  if (receipt.selectedModel !== null) {
    headers.set("x-vsr-selected-model", receipt.selectedModel);
  }
  if (receipt.selectedDecision !== undefined) {
    headers.set("x-vsr-selected-decision", receipt.selectedDecision);
  }
  return new Response(body, { status: upstream.status, headers });
}
