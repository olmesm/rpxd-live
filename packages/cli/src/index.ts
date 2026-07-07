/**
 * rpxd CLI + zero-config app shell (§14).
 *
 * @packageDocumentation
 */
export { buildApp, SERVER_ENTRY_URL } from "./build.ts";
export { defineConfig, type RpxdConfig, sse, type TransportConfig, ws } from "./config.ts";
export { createDevServer, type DevServer, type DevServerOptions } from "./dev-server.ts";
export { CLIENT_ENTRY_URL, rpxdEntryPlugin } from "./entry.ts";
export { type StartedApp, type StartOptions, startApp } from "./start.ts";
