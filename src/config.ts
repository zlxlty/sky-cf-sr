import { configHash, type AiBinding } from "./gateway.ts";
import { VIA_AI_BINDING } from "./pool.ts";

/** The Worker's bindings before validation; see `cloudflare.config.ts`. */
export interface RawEnv {
  AIG_GATEWAY_URL?: unknown;
  AIG_TOKEN?: unknown;
  CLIENT_TOKEN?: unknown;
  AUTO_ROUTER?: unknown;
  AI?: unknown;
}

/**
 * How the Worker calls the Auto Router; everything here but `logPayloads` is
 * in its config hash. The pool, the deadline and `logPayloads` also apply to
 * the policy and direct entrypoints.
 */
export interface AutoRouterPolicy {
  /**
   * The pool: the models the Auto Router may choose from, sent in this order.
   * Policies and direct calls may use only these.
   */
  allowedModels: readonly string[];
  /** The day the pool was last checked against Cloudflare's model list. */
  poolPinnedOn: string;
  /** How long one request may take, from sending it to the end of the response. */
  deadlineMs: number;
  /** Whether AI Gateway stores prompt and response text in its logs. */
  logPayloads: boolean;
}

export interface Settings extends AutoRouterPolicy {
  /** The Gateway's OpenAI-compatible Chat Completions URL. */
  chatCompletionsUrl: string;
  gatewayToken: string;
  /**
   * The AI binding and the Gateway's ID, for calls that name a model the
   * compat endpoint does not serve. Both are set when the pool has such a model.
   */
  ai: AiBinding | null;
  gatewayId: string | null;
  /** The bearer token callers of this Worker must present. */
  clientToken: string;
  /** The `cloudflare/auto` entrypoint's config hash; see `configHash` in `gateway.ts`. */
  configHash: string;
}

/** A missing or malformed setting. The message names the setting, never its value. */
export class ConfigError extends Error {}

// A model ID or wildcard pattern, such as "@cf/qwen/qwen3.8-27b" or "anthropic/*".
// Excluding commas and whitespace keeps one entry from becoming two in the header.
const MODEL_PATTERN = /^[\w@.*/:-]+$/;

// The bearer token grammar Hono's bearerAuth accepts; other tokens could never match.
const BEARER_TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const LOCAL_HOSTS = ["localhost", "127.0.0.1"];

export async function readSettings(env: RawEnv): Promise<Settings> {
  const policy = autoRouterPolicy(env.AUTO_ROUTER);
  const gateway = gatewayUrl(env.AIG_GATEWAY_URL);
  const ai = aiBinding(env.AI);
  const gatewayId = gateway.pathname.split("/").filter(Boolean).at(-1) ?? null;
  if (policy.allowedModels.some((model) => VIA_AI_BINDING.includes(model))) {
    if (ai === null) {
      throw new ConfigError(
        "AI is not bound, and the pool has a model that is called through it",
      );
    }
    if (gatewayId === null) {
      throw new ConfigError(
        "AIG_GATEWAY_URL must end with the Gateway's ID: the pool has a model that is called through the AI binding",
      );
    }
  }
  return {
    ...policy,
    chatCompletionsUrl: `${gateway.origin}${gateway.pathname.replace(/\/+$/, "")}/compat/chat/completions`,
    gatewayToken: required(env.AIG_TOKEN, "AIG_TOKEN"),
    ai,
    gatewayId,
    clientToken: clientToken(env.CLIENT_TOKEN),
    configHash: await configHash(policy),
  };
}

function autoRouterPolicy(value: unknown): AutoRouterPolicy {
  if (typeof value !== "object" || value === null) {
    throw new ConfigError("AUTO_ROUTER is not set");
  }
  const { allowedModels, poolPinnedOn, deadlineMs, logPayloads } =
    value as Record<string, unknown>;
  if (
    !Array.isArray(allowedModels) ||
    allowedModels.length === 0 ||
    !allowedModels.every((m) => typeof m === "string" && MODEL_PATTERN.test(m))
  ) {
    throw new ConfigError(
      "AUTO_ROUTER.allowedModels must be a non-empty list of model IDs",
    );
  }
  if (typeof poolPinnedOn !== "string" || !DATE_PATTERN.test(poolPinnedOn)) {
    throw new ConfigError(
      "AUTO_ROUTER.poolPinnedOn must be a date such as 2026-10-01",
    );
  }
  if (
    typeof deadlineMs !== "number" ||
    !Number.isInteger(deadlineMs) ||
    deadlineMs <= 0
  ) {
    throw new ConfigError(
      "AUTO_ROUTER.deadlineMs must be a positive whole number of milliseconds",
    );
  }
  if (typeof logPayloads !== "boolean") {
    throw new ConfigError("AUTO_ROUTER.logPayloads must be true or false");
  }
  return { allowedModels, poolPinnedOn, deadlineMs, logPayloads };
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`${name} is not set`);
  }
  return value.trim();
}

function clientToken(value: unknown): string {
  const token = required(value, "CLIENT_TOKEN");
  if (!BEARER_TOKEN_PATTERN.test(token)) {
    throw new ConfigError(
      "CLIENT_TOKEN may contain only letters, digits and . _ ~ + / -",
    );
  }
  return token;
}

function aiBinding(value: unknown): AiBinding | null {
  const bound =
    typeof value === "object" &&
    value !== null &&
    typeof (value as { run?: unknown }).run === "function";
  return bound ? (value as AiBinding) : null;
}

/** The Gateway's base URL, which ends with the account's ID and the Gateway's. */
function gatewayUrl(value: unknown): URL {
  const url = URL.parse(required(value, "AIG_GATEWAY_URL"));
  // The Gateway token is sent to this URL, so only a local stand-in may use plain HTTP.
  const secure =
    url?.protocol === "https:" ||
    (url?.protocol === "http:" && LOCAL_HOSTS.includes(url.hostname));
  if (
    url === null ||
    !secure ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ConfigError(
      "AIG_GATEWAY_URL must be an https URL without a query, fragment or credentials",
    );
  }
  return url;
}
