# sky-cf-sr

A Cloudflare Worker that puts an OpenAI-compatible chat endpoint in front of [AI Gateway's Auto Router](https://developers.cloudflare.com/ai-gateway/features/auto-router/). It is built with [Hono](https://hono.dev) and Cloudflare's `cf` CLI.

## What it does

`POST /v1/chat/completions` forwards a Chat Completions request to the Auto Router (`cloudflare/auto`) and relays the response, streamed or not.

- **The Worker owns the Gateway headers.** It adds its own Gateway credential and the list of models the Auto Router may choose from. The caller's `Authorization` header and any `cf-aig-*` headers are not forwarded.
- **Sessions.** Send `x-session-id` so the Auto Router keeps one model for each turn of a conversation, and optionally `x-turn-id` to mark turns yourself. A turn ID overrides the Auto Router's own turn detection.
- **The routing decision is visible.** The response carries the Gateway's `cf-aig-routed-model`, `cf-aig-routing-reason` and `cf-aig-routing-decision-id` headers. The Worker also writes one JSON log line per forwarded request, with those values and the request's timings. It never logs prompt or response text.
- **One generation call.** The Worker sends each request once and turns off the Gateway's retries and cache. If the Gateway cannot be reached, it answers `502`; if there is no response within the deadline, `504`.
- **A deadline.** A request that takes longer than `deadlineMs`, from sending it to the end of the response, is cut off.

The request body must be a JSON object with `"model": "cloudflare/auto"`. The Worker forwards it unchanged.

### What the Worker cannot control

- **The Auto Router's own fallback.** If the model it chose cannot serve the request, AI Gateway tries another eligible model. That is a second generation call, and it cannot be turned off. It shows as the routing reason `fallback_candidate_unavailable`.
- **A caller who leaves before response headers.** In local tests the Gateway call kept running until its response arrived, even with the `enable_request_signal` compatibility flag set. The request is then logged with `ended: "cancelled"` once the headers arrive. A caller who leaves while a response is streaming does cancel the Gateway call.

## Benchmark harness headers

The Worker implements the response headers and request checks that [sr-bench](https://github.com/vllm-project/semantic-router) expects from a routed target.

| Header                            | Direction | Meaning                                                                                                                                          |
| --------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `x-vsr-selected-model`            | Response  | The model the Auto Router chose, copied from `cf-aig-routed-model`                                                                               |
| `x-vsr-config-hash`               | Response  | A hash of the pool, the pin date, the deadline and the fixed Gateway headers. It identifies this Worker's setup, not Cloudflare's router version |
| `x-sr-bench-expected-config-hash` | Request   | If it differs from the Worker's hash, the request is refused with `409`                                                                          |
| `x-sr-bench-max-inference-calls`  | Request   | Must be a whole number of at least 1, since the Worker makes one call                                                                            |

## The log line

One JSON line is written per forwarded request, when the response body ends. Requests the Worker refuses itself, such as a wrong token, are not logged.

| Field                                                            | Meaning                                                                                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `event`                                                          | `auto_router_response`, or `gateway_no_response` when no response arrived                                                  |
| `routedModel`, `routingReason`, `decisionId`, `gatewayRequestId` | The Auto Router's decision, from the Gateway's response headers                                                            |
| `sessionId`, `turnId`                                            | What the caller sent                                                                                                       |
| `configHash`                                                     | The Worker's config hash                                                                                                   |
| `status`, `stream`, `requestBytes`                               | The Gateway's status, whether streaming was requested, and the request size                                                |
| `msToHeaders`                                                    | Until the Gateway's response headers arrived, or the request failed                                                        |
| `msToFirstToken`                                                 | Until the first streamed chunk carrying generated text, reasoning or a tool call. `null` when the response is not streamed |
| `msTotal`                                                        | Until the response body ended                                                                                              |
| `ended`                                                          | `complete`, `cancelled` (the caller stopped reading), `timeout` (the deadline passed) or `error` (the stream broke)        |
| `reason`, `error`                                                | For `gateway_no_response` only: `timeout`, `cancelled` or `network`, and the error's name. The error message is not logged |

Times are milliseconds since the Worker sent the request to the Gateway. The log lines are kept in Workers Logs, which `cloudflare.config.ts` turns on.

## Settings

Secrets:

| Name              | Meaning                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `AIG_GATEWAY_URL` | Your gateway's base URL: `https://gateway.ai.cloudflare.com/v1/<account id>/<gateway id>`. It must use HTTPS, except for a local stand-in |
| `AIG_TOKEN`       | A Cloudflare API token with the AI Gateway Run permission                                                                                 |
| `CLIENT_TOKEN`    | The bearer token callers of this Worker must present. Letters, digits and `. _ ~ + / -` only; the output of `openssl rand -hex 32` fits   |

`AUTO_ROUTER`, in `cloudflare.config.ts`:

| Field           | Meaning                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `allowedModels` | The models the Auto Router may choose from, sent in this order                                              |
| `poolPinnedOn`  | The day the pool was last checked against Cloudflare's model list                                           |
| `deadlineMs`    | How long one request may take, from sending it to the end of the response                                   |
| `logPayloads`   | Whether AI Gateway stores prompt and response text in its logs. Turn it off before sending private sessions |

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
```

## Licence

Apache-2.0. See [LICENSE](LICENSE).
