import starter from "../policy/starter.json" with { type: "json" };
import { ConfigError, type Settings } from "./config.ts";
import { AUTO_ROUTER_MODEL, exactModelConfigHash } from "./gateway.ts";
import { loadPolicy, PolicyError, type LoadedPolicy } from "./policy/policy.ts";

/**
 * The policies this Worker serves, by name. A caller selects one with the
 * model name `policy/<name>`. Each is checked against the pool when it is
 * first used, and a test checks each against the deployed pool.
 */
export const POLICIES: Readonly<Record<string, unknown>> = { starter };

const POLICY_PREFIX = "policy/";
const DIRECT_PREFIX = "direct/";

/**
 * Which router serves a request, chosen by the model name the caller sends:
 * - `cloudflare/auto`: the Auto Router chooses among the pool;
 * - `policy/<name>`: the named policy chooses one pool model;
 * - `direct/<model>`: that pool model, with no routing.
 *
 * Each has its own config hash, so a benchmark run can prove which router it
 * measured. A bare model ID is refused, so no caller skips routing by mistake.
 */
export type Entrypoint = { name: string; configHash: string } & (
  | { router: "auto_router" }
  | { router: "direct"; model: string }
  | { router: "policy"; policy: LoadedPolicy }
);

export interface Entrypoints {
  /** The entrypoint a model name selects, or undefined for a name not served. */
  resolve(model: unknown, settings: Settings): Promise<Entrypoint | undefined>;
  /** Tells a caller which model names are served. */
  served(pool: readonly string[]): string;
}

/**
 * Each policy is loaded once for each pool and kept, so every request it
 * serves uses the same snapshot. An invalid policy is a configuration error.
 */
export function entrypoints(
  policies: Readonly<Record<string, unknown>> = POLICIES,
): Entrypoints {
  const loaded = new Map<string, Promise<LoadedPolicy>>();
  const load = (name: string, pool: readonly string[]) => {
    const key = `${name}\n${pool.join(",")}`;
    let policy = loaded.get(key);
    if (policy === undefined) {
      policy = loadPolicy(policies[name], pool).catch((error: unknown) => {
        throw error instanceof PolicyError
          ? new ConfigError(`${POLICY_PREFIX}${name}: ${error.message}`)
          : error;
      });
      loaded.set(key, policy);
    }
    return policy;
  };

  return {
    async resolve(model, settings) {
      if (model === AUTO_ROUTER_MODEL) {
        return {
          name: model,
          router: "auto_router",
          configHash: settings.configHash,
        };
      }
      if (typeof model !== "string") return undefined;

      if (model.startsWith(DIRECT_PREFIX)) {
        const id = model.slice(DIRECT_PREFIX.length);
        if (!isExactModel(id) || !settings.allowedModels.includes(id)) {
          return undefined;
        }
        return {
          name: model,
          router: "direct",
          model: id,
          configHash: await exactModelConfigHash(
            { model: id },
            settings.deadlineMs,
          ),
        };
      }

      if (model.startsWith(POLICY_PREFIX)) {
        const name = model.slice(POLICY_PREFIX.length);
        if (!Object.hasOwn(policies, name)) return undefined;
        const policy = await load(name, settings.allowedModels);
        return {
          name: model,
          router: "policy",
          policy,
          configHash: await exactModelConfigHash(
            { policyVersion: policy.version },
            settings.deadlineMs,
          ),
        };
      }
      return undefined;
    },

    served(pool) {
      const names = [
        AUTO_ROUTER_MODEL,
        ...Object.keys(policies).map((name) => POLICY_PREFIX + name),
      ].map((name) => `"${name}"`);
      const models = pool.filter(isExactModel).join(", ");
      return `Use ${names.join(", ")}, or "${DIRECT_PREFIX}" followed by one of: ${models}.`;
    },
  };
}

/** A pool entry such as "anthropic/*" is a pattern for the Auto Router, not a model. */
function isExactModel(id: string): boolean {
  return !id.includes("*");
}
