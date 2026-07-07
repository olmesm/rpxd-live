/**
 * rpxd CLI + zero-config app shell (§14).
 *
 * @packageDocumentation
 */
export { defineConfig, type RpxdConfig, sse, type TransportConfig, ws } from "./config.ts";
export { createDevServer, type DevServer, type DevServerOptions } from "./dev-server.ts";
export { CLIENT_ENTRY_URL, rpxdEntryPlugin } from "./entry.ts";
