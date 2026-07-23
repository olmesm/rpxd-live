---
title: Logging & observability
description: Install one diagnostic sink in rpxd.config.ts to log or meter everything the runtime reports — the sink contract, the forward-everything rule, and how to plug in a real logger.
sidebar:
  order: 6
---

To get logs out of an rpxd server, you install one function. The runtime
reports everything it notices — failed requests, security rejections, handler
errors, storage problems — as **diagnostics**, and they all flow through a
single sink you provide in `rpxd.config.ts`. New apps scaffolded with
`rpxd init` ship with a working sink already in place.

## Install the sink

```ts
// rpxd.config.ts
import { defineConfig } from "@rpxd/cli";

export default defineConfig({
  onDiagnostic(d) {
    if (process.env.CI && (d.level === "info" || d.level === "debug")) return;
    console[d.level](`[${d.category}/${d.type}]`, d.detail ?? "", d.error ?? "");
  },
});
```

Embedding rpxd in your own server instead? Pass the same function as
`onDiagnostic` to `createRpxdHandler` — the config field is a passthrough.

## What arrives

Every diagnostic is one plain object:

```ts
{
  category: "security" | "request" | "instance" | "storage",
  type: string,        // stable name within the category, e.g. "rpc-decode-failed"
  level: "debug" | "info" | "warn" | "error",
  detail?: Record<string, unknown>,  // structured context (ids, paths, counts)
  error?: unknown,                   // the underlying thrown error, when there is one
}
```

- **`security`** — rejections and capacity evictions: origin failures,
  throttles, caps. The full five-type taxonomy is on the
  [security page](/rpxd-live/operations/security/#observability-ondiagnostic).
- **`request`** — transport-level problems: malformed rpc batches, failed
  WebSocket messages, mount failures.
- **`instance`** — your live objects: a loader that threw, an event handler
  that failed, a queue backing up.
- **`storage`** — persistence adapters: snapshot writes, Redis pub/sub
  failures.

## The one rule: forward everything

Filter noise **out** — never allowlist categories **in**. Installing a sink
replaces the default console reporting, so a sink like
`if (d.category === "request") log(d)` silently swallows every security
warning and storage error. Route by level, gate what you don't want (the CI
guard above), and let everything else through.

## The contract

- **It must not throw.** The runtime swallows a throwing sink to protect the
  request it was observing — but your log line is lost with it.
- **Keep it fast and synchronous.** The sink runs in request paths,
  fire-and-forget. Hand off to your logger; don't await inside it.
- **One sink per server.** Fan-out to multiple destinations is your code:
  compose functions inside the one sink.

## Plug in a real logger

The sink is one call site, so swapping console for a structured logger is one
line. With [pino](https://getpino.io):

```ts
import { pino } from "pino";
const logger = pino();

export default defineConfig({
  onDiagnostic(d) {
    logger[d.level]({ ...d.detail, err: d.error }, `${d.category}/${d.type}`);
  },
});
```

LogTape, winston, or an OpenTelemetry exporter wire up the same way: map
`level`, pass `detail` as structured fields, keep `category/type` as the
message. For metrics, count `${d.category}.${d.type}` and alert on
`level: "error"`.

## What it doesn't cover

- **Successful requests.** Today the runtime reports problems, not traffic —
  there is no built-in HTTP access log yet. Until there is, your reverse proxy's
  access log is the answer (see [Deploying](/rpxd-live/operations/deploying/)).
- **The browser.** The client has no sink; it reports to the browser console.
- **Your domain logs.** The sink is for framework diagnostics. Your handlers
  log with whatever logger you already use — often the same one you wired
  above.
