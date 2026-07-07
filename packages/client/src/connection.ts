/**
 * LiveConnection (§11): wires a {@link LiveStore} to the server transport —
 * SSE downstream (`EventSource` auto-reconnect), HTTP POST upstream.
 * Connections are disposable; state is not.
 */
import type { Envelope, RpcBatch } from "@rpxd/core";
import { LiveStore, type RpcMeta } from "./store.ts";

/** The slice of `EventSource` the connection uses — injectable for tests. */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
}

/** The slice of `WebSocket` the connection uses — injectable for tests (§11 ws opt-in). */
export interface WebSocketLike {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
}

const WS_BACKOFF_BASE_MS = 1000;
const WS_BACKOFF_CAP_MS = 30_000;

/** SSR bootstrap payload embedded by the server (§12). */
export interface Bootstrap {
  instance: string;
  seq: number;
  attachToken: string;
  snapshot: { state: unknown; session: unknown };
}

/** Constructor options for {@link LiveConnection}. */
export interface ConnectionOptions {
  /** Instance id (from SSR bootstrap or a control mount response). */
  instance: string;
  meta?: Record<string, RpcMeta>;
  /** Origin prefix, default same-origin (""). */
  base?: string;
  /** SSR bootstrap: seeds the store and attaches to the warm instance (§12). */
  bootstrap?: Bootstrap;
  /**
   * Transport (§11): `"sse"` (default) or `"ws"` — one duplex socket, same
   * envelope protocol, identical API shape.
   */
  transport?: "sse" | "ws";
  /** Injectable transport primitives (tests, non-browser environments). */
  fetchImpl?: typeof fetch;
  eventSource?: (url: string) => EventSourceLike;
  webSocket?: (url: string) => WebSocketLike;
}

/**
 * Client connection for one live object instance.
 *
 * @example
 * ```ts
 * const boot = JSON.parse(document.getElementById("__rpxd")!.textContent!);
 * const conn = new LiveConnection({ instance: boot.instance, bootstrap: boot, meta });
 * conn.connect();
 * conn.store.rpc.create({ name: "x" });
 * ```
 */
export class LiveConnection<S = unknown, Session = Record<string, unknown>> {
  readonly store: LiveStore<S, Session>;
  readonly #opts: ConnectionOptions;
  #source: EventSourceLike | undefined;
  #socket: WebSocketLike | undefined;
  #socketOpen = false;
  #closed = false;
  #everOpened = false;
  #retryAttempt = 0;

  constructor(opts: ConnectionOptions) {
    this.#opts = opts;
    this.store = new LiveStore<S, Session>({
      instance: opts.instance,
      meta: opts.meta,
      send: (batch) => this.#send(batch),
      requestResync: () => this.#control({ type: "resync", instance: opts.instance }),
    });
    if (opts.bootstrap) {
      // Seed confirmed state from the SSR snapshot — no connect spinner (§12).
      this.store.applyEnvelope({
        seq: opts.bootstrap.seq,
        instance: opts.instance,
        full: opts.bootstrap.snapshot as { state: unknown; session: unknown },
      });
    }
  }

  /** Open the transport. SSE reconnects via EventSource; WS retries with backoff. */
  connect(): void {
    if (this.#opts.transport === "ws") {
      this.#connectWs();
      return;
    }
    if (this.#source) return;
    const base = this.#opts.base ?? "";
    const boot = this.#opts.bootstrap;
    const attach = boot ? `?attach=${boot.attachToken}&seq=${boot.seq}` : "";
    const factory =
      this.#opts.eventSource ??
      ((url: string) => new EventSource(url) as unknown as EventSourceLike);
    const source = factory(`${base}/__rpxd/stream${attach}`);
    this.#source = source;
    this.store.setStatus("connecting");

    source.addEventListener("open", () => {
      const reconnected = this.#everOpened;
      this.#everOpened = true;
      this.store.setStatus("live");
      if (reconnected) {
        // Unacked optimistic rpcs are resent with their original ids —
        // the server dedupes (§11).
        this.store.resendUnacked();
      }
    });
    source.addEventListener("env", (event) => {
      this.store.applyEnvelope(JSON.parse(event.data) as Envelope);
      if (this.store.status !== "live") this.store.setStatus("live");
    });
    source.addEventListener("error", () => {
      this.store.setStatus("reconnecting");
    });
  }

  #connectWs(): void {
    if (this.#socket || this.#closed) return;
    const boot = this.#opts.bootstrap;
    // Attach params are only valid for the first connect; reconnects resync.
    const attach = boot && !this.#everOpened ? `?attach=${boot.attachToken}&seq=${boot.seq}` : "";
    const base = this.#opts.base ?? "";
    const wsBase = base
      ? base.replace(/^http/, "ws")
      : typeof window !== "undefined"
        ? window.location.origin.replace(/^http/, "ws")
        : "";
    const factory =
      this.#opts.webSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    const socket = factory(`${wsBase}/__rpxd/ws${attach}`);
    this.#socket = socket;
    this.store.setStatus(this.#everOpened ? "reconnecting" : "connecting");

    socket.addEventListener("open", () => {
      const reconnected = this.#everOpened;
      this.#everOpened = true;
      this.#socketOpen = true;
      this.#retryAttempt = 0;
      this.store.setStatus("live");
      if (reconnected) this.store.resendUnacked();
    });
    socket.addEventListener("message", (event) => {
      this.store.applyEnvelope(JSON.parse(String(event.data)) as Envelope);
      if (this.store.status !== "live") this.store.setStatus("live");
    });
    const retry = () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      this.#socketOpen = false;
      if (this.#closed) return;
      this.store.setStatus("reconnecting");
      // Exponential backoff with jitter (§11): the delay lands in
      // [window/2, window], window doubling per attempt up to the cap —
      // spreads a fleet of clients after a server bounce.
      const window = Math.min(WS_BACKOFF_CAP_MS, WS_BACKOFF_BASE_MS * 2 ** this.#retryAttempt);
      this.#retryAttempt += 1;
      const delay = window / 2 + Math.random() * (window / 2);
      setTimeout(() => this.#connectWs(), delay);
    };
    socket.addEventListener("close", retry);
    socket.addEventListener("error", () => {
      this.store.setStatus("reconnecting");
    });
  }

  /** Push a search-param change to the `params` reducer (§7) — no remount. */
  patchParams(search: Record<string, string>): void {
    if (this.#socketOpen && this.#socket) {
      this.#socket.send(JSON.stringify({ type: "params", instance: this.#opts.instance, search }));
      return;
    }
    void this.#control({ type: "params", instance: this.#opts.instance, search });
  }

  /** Close the transport. Server-side warm TTL takes it from here (§11). */
  close(): void {
    this.#closed = true;
    this.#source?.close();
    this.#source = undefined;
    this.#socket?.close();
    this.#socket = undefined;
    this.#socketOpen = false;
  }

  #fetch(): typeof fetch {
    return this.#opts.fetchImpl ?? fetch;
  }

  #send(batch: RpcBatch): void {
    if (this.#opts.transport === "ws") {
      // Unacked batches resend on reopen — dropping while closed is safe (§11).
      if (this.#socketOpen && this.#socket) this.#socket.send(JSON.stringify(batch));
      return;
    }
    void this.#fetch()(`${this.#opts.base ?? ""}/__rpxd/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch),
      credentials: "same-origin",
    }).catch(() => {
      // Delivery is at-least-once: the batch stays pending and is resent on
      // the next reconnect (§11).
      this.store.setStatus("reconnecting");
    });
  }

  #control(msg: unknown): Promise<unknown> {
    if (this.#opts.transport === "ws" && this.#socketOpen && this.#socket) {
      this.#socket.send(JSON.stringify(msg));
      return Promise.resolve();
    }
    return this.#fetch()(`${this.#opts.base ?? ""}/__rpxd/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(msg),
      credentials: "same-origin",
    }).catch(() => undefined);
  }

  /**
   * Cold mount without SSR: ask the server to mount the route, then connect.
   */
  static async mount<S, Session = Record<string, unknown>>(
    path: string,
    search: Record<string, string>,
    opts: Omit<ConnectionOptions, "instance"> = {},
  ): Promise<LiveConnection<S, Session>> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(`${opts.base ?? ""}/__rpxd/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "mount", path, search }),
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`mount failed: ${res.status}`);
    const { instance } = (await res.json()) as { instance: string };
    const conn = new LiveConnection<S, Session>({ ...opts, instance });
    conn.connect();
    return conn;
  }
}
