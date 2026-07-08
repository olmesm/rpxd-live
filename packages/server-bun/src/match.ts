/**
 * URL-path matching — moved to `@rpxd/core` so the client router (§7 SPA
 * navigation) shares the exact matcher the server mounts with; re-exported
 * here for existing imports.
 */
export { matchHttpPath, matchHttpRoute, matchPath, matchRoute, type RouteMatch } from "@rpxd/core";
