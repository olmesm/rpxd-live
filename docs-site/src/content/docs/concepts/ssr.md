---
title: Server-side rendering
description: Mount runs during SSR and the live connection adopts the warm instance — crawlable HTML, no connect spinner, resume from seq.
sidebar:
  order: 5
---

`mount` runs during SSR, so the first paint is real server-rendered HTML — no
connect-spinner, crawlable — and the live connection then **adopts the warm
instance** rather than mounting again.

## The flow

1. An HTTP GET runs `mount`, producing HTML plus an embedded
   `{ snapshot, seq, attachToken }`.
2. The client connects and presents the `attachToken` (a `control` message —
   see the [wire protocol](/rpxd-live/concepts/wire-protocol/)).
3. Within the pending-attach TTL (~10s) the server **adopts** the SSR-warmed
   instance and resumes the stream from `seq`. No second mount.
4. If the token is expired or unknown, the server does **not** re-mount — it
   resyncs the still-warm instance and pushes a `full` snapshot instead. No
   second `guard`/`setup`/`load` run; the same instance just catches the
   client up.

## Guarantees

- **Mount runs once per page load.** The SSR mount and the live connection are
  the same instance, so there's no double-fetch and no flash of empty state.
- **Crawlable.** The initial HTML contains the rendered state, not a loading
  shell.
- **Seamless handoff.** Because the connection resumes from `seq`, the user
  never sees a re-fetch when the socket comes up.
