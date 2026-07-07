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

/** SSR bootstrap payload embedded by the server (§12). */
export interface Bootstrap {
  instance: string;
  seq: number;
  attachToken: string;
  snapshot: { state: unknown; session: unknown };
}

export interface ConnectionOptions {
  /** Instance id (from SSR bootstrap or a control mount response). */
  instance: string;
  meta?: Record<string, RpcMeta>;
  /** Origin prefix, default same-origin (""). */
  base?: string;
  /** SSR bootstrap: seeds the store and attaches to the warm instance (§12). */
  bootstrap?: Bootstrap;
  /** Injectable transport primitives (tests, non-browser environments). */
  fetchImpl?: typeof fetch;
  eventSource?: (url: string) => EventSourceLike;
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
  #everOpened = false;

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

  /** Open the SSE stream. Reconnects are handled by EventSource itself. */
  connect(): void {
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

  /** Push a search-param change to the `params` reducer (§7) — no remount. */
  patchParams(search: Record<string, string>): void {
    void this.#control({ type: "params", instance: this.#opts.instance, search });
  }

  /** Close the stream. Server-side warm TTL takes it from here (§11). */
  close(): void {
    this.#source?.close();
    this.#source = undefined;
  }

  #fetch(): typeof fetch {
    return this.#opts.fetchImpl ?? fetch;
  }

  #send(batch: RpcBatch): void {
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
