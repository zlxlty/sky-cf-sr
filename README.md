# sky-cf-sr

A Cloudflare Worker that puts an OpenAI-compatible chat endpoint in front of [AI Gateway's Auto Router](https://developers.cloudflare.com/ai-gateway/features/auto-router/), and next to it a routing policy of its own, so the two can be compared on the same models. It is built with [Hono](https://hono.dev) and Cloudflare's `cf` CLI.

## What it does

`POST /v1/chat/completions` takes a Chat Completions request, sends it through AI Gateway, and relays the response, streamed or not. The request's `model` chooses who picks the answering model:

| `model`                                                  | Who chooses                                                 | What the Gateway receives                           |
| -------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| `cloudflare/auto`                                        | The Auto Router, from the pool                              | The request, byte for byte                          |
| `policy/<name>`, such as `policy/starter`                | A routing policy in [`policy/`](policy/), run by the Worker | The request with `model` set to the policy's choice |
| `direct/<pool model>`, such as `direct/openai/gpt-6-sol` | Nobody: that model answers                                  | The request with `model` set to that model          |

All three use the same pool of models, the same Gateway endpoint, deadline and log line. Any other model name, including a bare model ID such as `openai/gpt-6-sol`, is refused with `400`, so no caller skips routing by mistake.

The endpoint is the Gateway's [OpenAI-compatible one](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/), which the Auto Router needs. Cloudflare marks it as deprecated for calls to one model, but using it for all three keeps them comparable. On it, a Workers AI model is named `workers-ai/@cf/...`; the Worker adds the prefix, and reports the model by its pool name, `@cf/...`.

- **The Worker owns the Gateway headers.** It adds its own Gateway credential, and for the Auto Router the list of models it may choose from. The caller's `Authorization` header and any `cf-aig-*` headers are not forwarded.
- **Sessions.** For `cloudflare/auto`, send `x-session-id` so the Auto Router keeps one model for each turn of a conversation, and optionally `x-turn-id` to mark turns yourself. A turn ID overrides the Auto Router's own turn detection. The other entrypoints record these IDs but do not send them to the Gateway.
- **The routing decision is visible.** The response says which model was asked to answer, and for a policy which decision chose it. The Worker also writes one JSON log line per routed request, with the decision and the request's timings. It never logs prompt or response text.
- **One generation call.** The Worker sends each request once and turns off the Gateway's retries and cache. If the Gateway cannot be reached, it answers `502`; if there is no response within the deadline, `504`.
- **A deadline.** A request that takes longer than `deadlineMs`, from sending it to the end of the response, is cut off.

### Routing policies

A policy is a JSON file: signals read from the request, such as keywords and the estimated context size; decisions over those signals, with priorities; and for each decision an ordered list of candidate models. The first candidate that can serve the request answers it: its context window must fit the request's estimate, and it must support the tools, structured output or images the request uses. The rules follow [vLLM Semantic Router](https://github.com/vllm-project/semantic-router)'s decision engine for a supported subset, including unknown evidence.

- A policy is checked when it is first used, and may name only pool models. An invalid one makes the Worker answer `500`.
- Its version is a hash of its content, recorded with every request it routes.
- If no candidate can serve the request, or required evidence is unknown, the request fails with `422` (`no_eligible_model` or `routing_unresolved`). It is never sent to some other model.
- The Worker writes the body out again with the new `model`. A number in the body that JavaScript cannot hold exactly, such as an integer above 2<sup>53</sup>, changes on the way.

The policies served are listed in [`src/entrypoints.ts`](src/entrypoints.ts). [`policy/starter.json`](policy/starter.json) is an untuned example that exercises each part of the engine.

### What the Worker cannot control

- **The Auto Router's own fallback.** If the model it chose cannot serve the request, AI Gateway tries another eligible model. That is a second generation call, and it cannot be turned off. It shows as the routing reason `fallback_candidate_unavailable`.
- **A caller who leaves before response headers.** Deployed, Cloudflare cancels the Worker's invocation when the caller disconnects, so no log line is written for that request; in one test the Gateway logged no entry for it either. Under `cf dev` the Gateway call instead keeps running until its response arrives, and is then logged with `ended: "cancelled"`. A caller who leaves while a response is streaming cancels the Gateway call in both.

### Calling it

- **Set a user agent.** Cloudflare's bot check can reject some HTTP clients' default user agents with error 1010.
- **Leave room for reasoning.** Reasoning models spend output tokens on reasoning first. With a small `max_tokens` the reply can come back empty, or fail with `500` and still be billed.

## Benchmark harness headers

The Worker implements the response headers and request checks that [sr-bench](https://github.com/vllm-project/semantic-router) expects from a routed target.

| Header                            | Direction | Meaning                                                                                                           |
| --------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `x-vsr-selected-model`            | Response  | The model asked to answer: for `cloudflare/auto`, copied from `cf-aig-routed-model`                               |
| `x-vsr-selected-decision`         | Response  | For a policy, the decision that chose the model                                                                   |
| `x-vsr-config-hash`               | Response  | The hash of the entrypoint's setup; see below. It identifies this Worker's setup, not Cloudflare's router version |
| `x-sr-bench-expected-config-hash` | Request   | If it differs from the entrypoint's hash, the request is refused with `409`                                       |
| `x-sr-bench-max-inference-calls`  | Request   | Must be a whole number of at least 1, since the Worker makes one call                                             |

Each entrypoint has its own config hash, so a benchmark run can prove which router it measured:

| Entrypoint            | The hash covers                                                      |
| --------------------- | -------------------------------------------------------------------- |
| `cloudflare/auto`     | The pool, the date it was pinned, the deadline and the fixed headers |
| `policy/<name>`       | The policy's version, the deadline and the fixed headers             |
| `direct/<pool model>` | The model, the deadline and the fixed headers                        |

## The log line

One JSON line is written per routed request: when the response body ends, or at once if a policy could not route it. Requests the Worker refuses itself, such as a wrong token, are not logged.

| Field                                                            | Meaning                                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event`                                                          | `auto_router_response` or `model_response`; `gateway_no_response` when no response arrived; `routing_failed` when a policy chose no model                                                                                  |
| `entrypoint`                                                     | The model name the caller sent                                                                                                                                                                                             |
| `routedModel`, `routingReason`, `decisionId`, `gatewayRequestId` | The Auto Router's decision, from the Gateway's response headers. For other entrypoints, only `gatewayRequestId`                                                                                                            |
| `model`                                                          | For a policy or direct entrypoint, the model asked to answer                                                                                                                                                               |
| `policy`                                                         | For a policy: its version, the outcome, the decision, the matched signals, why the decision won, what the request needed, the candidates passed over and why, and the decisions whose unknown evidence `onUnknown` settled |
| `sessionId`, `turnId`                                            | What the caller sent                                                                                                                                                                                                       |
| `configHash`                                                     | The entrypoint's config hash                                                                                                                                                                                               |
| `status`, `stream`, `requestBytes`                               | The Gateway's status, whether streaming was requested, and the request size                                                                                                                                                |
| `msToHeaders`                                                    | Until the Gateway's response headers arrived, or the request failed                                                                                                                                                        |
| `msToFirstToken`                                                 | Until the first streamed chunk carrying generated text, reasoning or a tool call. `null` when the response is not streamed                                                                                                 |
| `msTotal`                                                        | Until the response body ended                                                                                                                                                                                              |
| `ended`                                                          | `complete`, `cancelled` (the caller stopped reading), `timeout` (the deadline passed) or `error` (the stream broke)                                                                                                        |
| `reason`, `error`                                                | For `gateway_no_response` only: `timeout`, `cancelled` or `network`, and the error's name. The error message is not logged                                                                                                 |

Times are milliseconds since the Worker sent the request to the Gateway. The log lines are kept in Workers Logs, which `cloudflare.config.ts` turns on.

## Settings

Secrets:

| Name              | Meaning                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `AIG_GATEWAY_URL` | Your gateway's base URL: `https://gateway.ai.cloudflare.com/v1/<account id>/<gateway id>`. It must use HTTPS, except for a local stand-in |
| `AIG_TOKEN`       | A Cloudflare API token with the AI Gateway Run permission                                                                                 |
| `CLIENT_TOKEN`    | The bearer token callers of this Worker must present. Letters, digits and `. _ ~ + / -` only; the output of `openssl rand -hex 32` fits   |

`AUTO_ROUTER`, set in `src/pool.ts` and bound in `cloudflare.config.ts`. Despite its name, all but `poolPinnedOn` apply to every entrypoint:

| Field           | Meaning                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `allowedModels` | The pool: the models the Auto Router may choose from, sent in this order. Policies and direct calls may use only these |
| `poolPinnedOn`  | The day the pool was last checked against Cloudflare's model list                                                      |
| `deadlineMs`    | How long one request may take, from sending it to the end of the response                                              |
| `logPayloads`   | Whether AI Gateway stores prompt and response text in its logs. Turn it off before sending private sessions            |

For local development, copy `.dev.vars.example` to `.dev.vars` and fill it in.

## Develop

```sh
npm install
npm run dev        # serve locally
npm test           # unit tests; no network or Cloudflare account needed
npm run typecheck
npm run build
npm run format     # Prettier
```

```sh
curl -i http://localhost:5173/v1/chat/completions \
  -H "Authorization: Bearer $CLIENT_TOKEN" \
  -H "x-session-id: demo-1" \
  -d '{"model": "cloudflare/auto", "messages": [{"role": "user", "content": "hello"}]}'

# The same request, routed by the starter policy
curl -i http://localhost:5173/v1/chat/completions \
  -H "Authorization: Bearer $CLIENT_TOKEN" \
  -d '{"model": "policy/starter", "messages": [{"role": "user", "content": "Fix my python script"}]}'
```

## Licence

Apache-2.0. See [LICENSE](LICENSE).
