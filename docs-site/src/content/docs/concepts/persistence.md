---
title: Persistence & storage adapters
description: Write-through snapshots behind a small interface that also carries the pubsub bus — memory, session, SQLite, and Redis adapters.
sidebar:
  order: 4
---

Persistence is a small interface with two jobs: store whole-state snapshots, and
carry the [pubsub bus](/rpxd-live/concepts/pubsub/).

## The adapter interface

A `StorageAdapter` does `get` / `set` of `{ state, seq, version }` plus pubsub.
The framework writes through on every `patchState` flush and rpc completion.

| Adapter | Package | Use |
| --- | --- | --- |
| `memory()` | `@rpxd/storage-memory` | default; single node, non-durable |
| `session()` | `@rpxd/storage-session` | per-session store |
| `sqlite()` | `@rpxd/storage-sqlite` | durable local (`bun:sqlite`) |
| `redis()` | `@rpxd/storage-redis` | multi-node — the bus spans nodes |

```ts
// rpxd.config.ts
import { sqlite } from "@rpxd/storage-sqlite";
export default defineConfig({ storage: sqlite("./data.db") });
```

## Snapshots are continuity, not cache

This is the key design decision: **snapshots exist for session continuity, not
as a read cache.** A cold wake always re-runs `mount`. Reloading state from a
snapshot would risk serving state that missed a broadcast while the instance was
evicted; re-running `mount` reads fresh truth and re-subscribes.

- **Write-through** on every flush / completion.
- **Cold wake re-runs `mount`** — snapshots bridge eviction, they don't replace
  the mount.
- **Version tag mismatch → discard and re-mount** (no migrations).
- **Whole-state snapshots, never patch logs** — the snapshot is the state, not a
  replayable history.

## The bus

The same adapter carries pubsub. With `memory()` the bus is in-process; with
`redis()` it spans nodes, which is what lets any node host any session (see
[Pubsub](/rpxd-live/concepts/pubsub/)). Choosing a storage adapter therefore
also chooses your multiplayer topology.
