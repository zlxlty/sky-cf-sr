# sky-cf-sr

A Cloudflare Worker that puts an OpenAI-compatible chat endpoint in front of [AI Gateway's Auto Router](https://developers.cloudflare.com/ai-gateway/features/auto-router/), and next to it a routing policy of its own, so the two can be compared on the same models. It is built with [Hono](https://hono.dev) and Cloudflare's `cf` CLI.

## What it does

`POST /v1/chat/completions` takes a Chat Completions request, sends it through AI Gateway, and relays the response, streamed or not. The request's `model` chooses who picks the answering model:

| `model`                                                  | Who chooses                                                 | What the Gateway receives                           |
| -------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| `cloudflare/auto`                                        | The Auto Router, from the pool                              | The request, byte for byte                          |
| `policy/<name>`, such as `policy/starter`                | A routing policy in [`policy/`](policy/), run by the Worker | The request with `model` set to the policy's choice |
| `direct/<pool model>`, such as `direct/openai/gpt-6-sol` | Nobody: that model answers                                  | The request with `model` set to that model          |

All three use the same pool of models, the same Gateway, deadline and log line. Any other model name, including a bare model ID such as `openai/gpt-6-sol`, is refused with `400`, so no caller skips routing by mistake.

The endpoint is the Gateway's [OpenAI-compatible one](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/), which the Auto Router needs. Cloudflare marks it as deprecated for calls to one model, but using it for all three keeps them comparable. The Auto Router's names for models do not always work when one model is named on that endpoint, so for a policy or direct call the Worker changes six things:

- **The model's name.** A Workers AI model is named `workers-ai/@cf/...`. Responses and log lines still use the pool's name.
- **The way in, for some models.** A call that names one of the models in `VIA_AI_BINDING` in [`src/reach.ts`](src/reach.ts) goes through the Worker's [AI binding](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/), not through the endpoint. The binding takes every model of Cloudflare's catalogue under the Auto Router's name. Such a call goes through the same Gateway, under unified billing, with no cached answer and one attempt. There are two reasons. The endpoint refuses a call that names one of the pool's Fireworks models, though the Auto Router can choose them: Fireworks is not one of its providers. And the endpoint serves Opus but never from Anthropic's prompt cache: it takes a cache marker and ignores it.
- **Anthropic's format, for Opus.** The binding takes and answers an Anthropic model in Anthropic's own Messages format, so the Worker translates the request on the way in and the answer on the way back ([`src/anthropic.ts`](src/anthropic.ts)). A caller still sends and gets Chat Completions. What a caller should know:
  - With `x-session-id`, the request carries one cache marker, which caches the conversation so far for the session's next call. A caller's own `cache_control`, at the top level or on a part of a message, is kept and no other is added. Without a session there is no marker.
  - `temperature` and `top_p` are left out: the model refuses them. `reasoning_effort` becomes the model's effort setting, which takes `low`, `medium`, `high`, `xhigh` and `max`.
  - The model takes the tool choices `auto` and `none` only. `required` and a named function are sent on, and the model answers `400`.
  - A field the translation does not know, such as `seed`, is refused with `400` and the code `unsupported_parameter`, so that no setting is dropped without a word.
  - With no limit on output, the Worker sets 16,384 tokens: Anthropic requires a limit.
  - The model is always asked for a stream, because only a streamed answer reports cache reads and writes. A caller that asked for no stream gets one JSON object when the model has finished. The usage counts cached tokens in `prompt_tokens`, as OpenAI does, with the reads and writes in `prompt_tokens_details`.
  - The model's thinking is not in the answer.
- **The Responses format, for GPT-6 with tools and an effort.** In the Chat Completions format, GPT-6 Luna and GPT-6 Sol refuse a tool together with a reasoning effort, on the endpoint and through the binding alike. Only the effort `none` is taken, and a call with tools that sets no effort is refused too. In OpenAI's Responses format the binding serves such a call at every effort. So a call to one of the models in `RESPONSES_FORMAT_WITH_TOOLS` in `src/reach.ts`, with tools, at an effort other than `none`, goes through the binding in that format, and the Worker translates the request and the answer ([`src/responses.ts`](src/responses.ts)). A call with no tools, and a call with tools at the effort `none`, stay on the endpoint: no call that the endpoint serves changes. A caller still sends and gets Chat Completions. What a caller should know about a call that goes this way:
  - `reasoning_effort` becomes the model's effort setting, which takes `low`, `medium`, `high`, `xhigh` and `max`. With none sent, the model uses its own default.
  - `max_completion_tokens`, or `max_tokens`, becomes the format's limit on output.
  - The answer is not stored at the provider: the format stores it unless told not to, and the Worker tells it not to.
  - A tool's arguments are checked strictly only when the tool says `strict: true`, as in Chat Completions.
  - A field the translation does not know, such as `seed` or `stop`, is refused with `400` and the code `unsupported_parameter`. So is a `response_format` other than text. A `cache_control` marker is left out: this model's cache needs none.
  - The model is always asked for a stream. A caller that asked for no stream gets one JSON object when the model has finished.
  - The model's reasoning is not in the answer, and is not carried to the session's next call. A refusal comes back as the answer's content.
  - A conversation that grows is read from the cache by the next call at the same effort. In one test, a call at another effort read nothing from it.
- **`max_tokens` for OpenAI models.** They refuse it when named, though the Auto Router accepts it for them. The Worker renames it to `max_completion_tokens`, or drops it when `max_completion_tokens` is also given.
- **A cache key for a session, for the Fireworks models.** When the caller sends `x-session-id`, a call to one of the pool's Fireworks models carries `prompt_cache_key` in its body, with a hash of the session ID as its value. The key is for calls whose prompts start alike and end differently, such as several questions about one long document: with no key these models seldom read such a start from their cache, and with one they read all or most of it on every call after the first. A conversation that only grows does not need the key: GLM 5.3 read one from its cache on most calls, with a key and with none. A body that already has a `prompt_cache_key` or a `user` is left as it is. These models are listed in `CACHE_KEY_MODELS` in `src/reach.ts`. OpenAI's models get no key, because it changes nothing for them: they read a conversation that grows from their cache with none. Opus takes no key; its marker is described above.

- **The Worker owns the Gateway headers.** It adds its own Gateway credential, and for the Auto Router the list of models it may choose from. The caller's `Authorization` header and any `cf-aig-*` headers are not forwarded.
- **Sessions.** For `cloudflare/auto`, send `x-session-id` so the Auto Router keeps one model for each turn of a conversation, and optionally `x-turn-id` to mark turns yourself. A turn ID overrides the Auto Router's own turn detection. The other entrypoints record these IDs but do not send them to the Gateway; for a model that gets one, a session ID becomes its cache key, as above.
- **The routing decision is visible.** The response says which model was asked to answer, and for a policy which decision chose it. The Worker also writes one JSON log line per routed request, with the decision and the request's timings. It never logs prompt or response text.
- **One generation call.** The Worker sends each request once and turns off the Gateway's retries and cache. If the Gateway cannot be reached, it answers `502`; if there is no response within the deadline, `504`.
- **A deadline.** A request that takes longer than `deadlineMs`, from sending it to the end of the response, is cut off.

### Routing policies

A policy is a JSON file: signals read from the request, such as keywords and the estimated context size; decisions over those signals, with priorities; and for each decision an ordered list of candidate models. The first candidate that can serve the request answers it: its context window must fit the request's estimate, and it must support the tools, structured output or images the request uses. The rules follow [vLLM Semantic Router](https://github.com/vllm-project/semantic-router)'s decision engine for a supported subset, including unknown evidence.

- A policy is checked when it is first used, and may name only pool models. An invalid one makes the Worker answer `500`.
- Its version is a hash of its content, recorded with every request it routes.
- If no candidate can serve the request, or required evidence is unknown, the request fails with `422` (`no_eligible_model` or `routing_unresolved`). It is never sent to some other model.
- The Worker writes the body out again with the changes above. A number in the body that JavaScript cannot hold exactly, such as an integer above 2<sup>53</sup>, changes on the way.

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

| Entrypoint            | The hash covers                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `cloudflare/auto`     | The pool, the date it was pinned, the deadline and the fixed headers                       |
| `policy/<name>`       | The policy's version, how each of its models is called, the deadline and the fixed headers |
| `direct/<pool model>` | The model and how it is called, the deadline and the fixed headers                         |

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

`AI`, the Workers AI binding, bound in `cloudflare.config.ts`. It needs no token: Cloudflare supplies the providers' credentials. The Worker needs it only while the pool has a model in `VIA_AI_BINDING` or `RESPONSES_FORMAT_WITH_TOOLS`, and then `AIG_GATEWAY_URL` must end with the Gateway's ID. When `logPayloads` is off, the Gateway does not log a call made through the binding at all: the binding can turn a request's log off, but not only its text.

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
