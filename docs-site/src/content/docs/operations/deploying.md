---
title: Deploying to production
description: Build and start the pure-runtime server, the session-secret and cookie checklist, the reverse-proxy requirements for long-lived SSE/WS, and a Bun Dockerfile.
sidebar:
  order: 1
---

Shipping rpxd is two commands and a short checklist. The runtime is
web-standard (`Request`/`Response`/`ReadableStream`), and the transport is one
long-lived connection per session. The only genuinely non-default piece of
production config is the reverse proxy: SSE and WebSocket connections stay
open, and most proxies buffer and time out by default.

## Build & start

`rpxd build` compiles two bundles (three with RSC enabled):

- `dist/client` — the hashed, immutable browser assets and a Vite manifest.
- `dist/server` — the SSR bundle (`entry-server.js`) that owns rendering.
- `dist/rsc` — the react-server bundle, emitted only when `rsc: true`.

`rpxd start` then serves that build with **no Vite at runtime** — it reads the
server bundle, serves `dist/client` statically, and runs the live wire through
the same handler the dev server uses. It binds `$PORT` (or `--port`), defaulting
to `3000`.

```sh
rpxd build          # → dist/client + dist/server (+ dist/rsc when enabled)
PORT=8080 rpxd start
```

Static assets are served with `Cache-Control: public, max-age=31536000,
immutable` — they're content-hashed, so this is safe and needs no proxy help.

The same `rpxd start` runs on Node ≥ 24; it selects the Node adapter
automatically when Bun isn't present. See
[Running on Node](/rpxd-live/operations/node/).

## The production checklist

Four settings separate a dev run from a production one. Three are security
defaults that only *tighten* in production; one is a durability choice.

- **Set `RPXD_SESSION_SECRET`.** Without it the `rpxd_sid` cookie is unsigned
  (pre-signing behavior) and the handler **warns once** at startup. With it set,
  the sid is HMAC-signed and verified — a forged or unsigned cookie is rejected
  as a fresh session, closing session fixation. Set it via the environment (the
  handler reads `process.env.RPXD_SESSION_SECRET`) or `session.secret` in
  `rpxd.config.ts`. Signing is integrity, not confidentiality — it pairs with
  the Secure cookie below.
- **Secure cookie is default-on.** The `rpxd_sid` cookie is marked `Secure`
  (HTTPS-only) by default; browsers still accept it on `http://localhost` and
  behind a TLS-terminating proxy. You only ever set `cookie: { secure: false }`
  for non-localhost plain-HTTP dev. Production is HTTPS, so leave it alone.
- **`debugErrors` off in production.** It defaults to `false`: a crash returns a
  generic plain-text `internal error` (500) and rejected `guard`/`load` return a
  generic body, with the full error **logged server-side**, so stack and message
  detail never leak to clients. The dev server flips this on; production must
  not. (It only affects the fallback bodies, not your `renderError` page.)
- **Choose a durable storage adapter.** The default `memory()` adapter is
  non-durable and single-node — every restart loses all warm sessions. Pick
  `sqlite()` for a single durable node or `redis()` for multi-node. See
  [Persistence & storage adapters](/rpxd-live/concepts/persistence/), and
  [Scaling & multi-node](/rpxd-live/operations/scaling/) for the multi-node case.

## Reverse proxy: the one thing that isn't a default

rpxd holds one long-lived connection per session: an SSE stream at
`/__rpxd/stream` (default transport) or a WebSocket at `/__rpxd/ws` (opt-in).
Most reverse proxies buffer responses and apply a read timeout — both of which
break a stream that is *supposed* to stay open and dribble bytes. Configure the
proxy to:

- **Turn response buffering off** on rpxd's own endpoints (`/__rpxd/*`) so
  envelopes — the patch messages on the stream — reach the browser as they're
  written, not in proxy-sized chunks.
- **Disable or greatly extend read timeouts** on `/__rpxd/stream` — an idle-ish
  stream is normal, not a hung upstream.
- **Pass the WebSocket upgrade through** on `/__rpxd/ws` (the `Upgrade` /
  `Connection` headers) when you run `transport: ws()`.

No special *resume* handling is needed. The SSE `id:` field mirrors each
envelope's `seq` as a proxy-level resume hint, but authoritative recovery is
always the client's `resync` → the server answers with a full snapshot (see the
[Wire protocol](/rpxd-live/concepts/wire-protocol/)). A proxy that replays or
drops `Last-Event-ID` changes nothing.

These snippets are **starting points**, not drop-in configs — adjust hosts,
TLS, and timeouts for your setup.

### nginx

```nginx
location /__rpxd/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;

    # SSE + WS: never buffer, never time out a healthy open stream.
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;

    # WebSocket upgrade pass-through (transport: ws()).
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
}
```

(`$connection_upgrade` comes from the usual `map $http_upgrade` block that maps
`""` → `close` and everything else → `upgrade`.)

### Caddy

```caddy
example.com {
    reverse_proxy 127.0.0.1:3000 {
        # Caddy passes WebSocket upgrades through automatically; disable
        # response buffering so SSE envelopes flush immediately.
        flush_interval -1
    }
}
```

## Graceful shutdown

On `SIGTERM` / `SIGINT` — a `docker stop`, a Kubernetes pod eviction, `Ctrl-C`
— `rpxd start` shuts down in a fixed order so no warm state is lost:

1. **stop** taking new connections,
2. **dispose** — flush every warm instance's snapshot to the storage adapter,
3. **`onShutdown`** — your userland cleanup hook (below),
4. **close storage** — rpxd closes the storage handle it opened itself.

The order matters: snapshots are written in step 2, so storage stays open
through it. `onShutdown` runs in step 3, before rpxd closes storage, in case
your cleanup still touches it. A second signal, or a shutdown that overruns the
timeout, force-exits — a wedged hook can't hang the process forever.

This is why the Dockerfile below matters for signal delivery: the Bun runtime
must be PID 1 (or run under an init that forwards `SIGTERM`) so `docker stop`'s
signal reaches `bun run start`, which forwards it to rpxd.

### `onShutdown` — close what your app owns

rpxd closes the storage adapter it created; your app closes the resources **it**
opened. `onShutdown` is the hook — most commonly to disconnect a Prisma client
(a `--db` scaffold opens one), but any Redis client, queue connection, or
external SDK closes here too:

```ts
// rpxd.config.ts
import { defineConfig } from "@rpxd/cli";
import { db } from "./adapters/db";

export default defineConfig({
  // …storage, session, etc.
  onShutdown: () => db.$disconnect(),
});
```

## A Bun Dockerfile

`rpxd init` scaffolds a production `Dockerfile` and `.dockerignore` for you — a
multi-stage build on `oven/bun`, then `rpxd start` on the slim runtime. It's the
same shape as below; the generated one is db-aware (applies the Prisma schema on
boot) and keeps the Bun runtime as PID 1 so `SIGTERM` reaches it and graceful
shutdown works:

```dockerfile
# syntax=docker/dockerfile:1
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install          # add --frozen-lockfile once a lockfile is committed
COPY . .
RUN bun run build        # `bun run db:generate && bun run build` for a --db app

FROM oven/bun:1-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["bun", "run", "start"]
# --db apps instead: CMD ["sh", "-c", "bun run db:push && exec bun run start"]
# — `exec` makes `bun run start` PID 1 so it receives docker stop's SIGTERM.
```

```sh
docker build -t my-app .
docker run --init -p 3000:3000 \
  -e RPXD_SESSION_SECRET=$(openssl rand -hex 32) \
  my-app
```

`--init` runs a tiny init as PID 1 to reap zombies and forward signals — cheap
insurance for clean shutdown. Set `RPXD_SESSION_SECRET` (and storage connection
details) as **runtime** environment, not build args — they're deploy config, not
part of the image. The scaffold already git- and docker-ignores `.env` so a
local secrets file is never committed or baked in.

If you scaffolded `--db`, the default sqlite file lives in the container's
ephemeral layer and is lost on every redeploy — mount a volume where it lives
(`-v my-app-data:/app/prisma`) or point `DATABASE_URL` at durable storage. For a
Node base image and `better-sqlite3`, see
[Running on Node](/rpxd-live/operations/node/).

## Multiple nodes

Everything above is single-node-complete. The moment you run more than one
instance behind a load balancer, read
[Scaling & multi-node](/rpxd-live/operations/scaling/) — the short version is
that rpxd needs no sticky sessions, but multi-node *does* require `redis()` so
both snapshots and the broadcast bus span nodes.
