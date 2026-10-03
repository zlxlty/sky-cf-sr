import { createApp } from "./app.ts";

export default createApp({
  fetch: (request) => fetch(request),
  log: (record) => console.log(JSON.stringify(record)),
  now: Date.now,
  deadline: (ms) => AbortSignal.timeout(ms),
}) satisfies ExportedHandler<Env>;
