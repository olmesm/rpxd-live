/**
 * Auth issuance route (the routes & auth guide): a `route()` whose body
 * delegates the whole `/api/auth/*` subtree to the auth library. `.all`
 * forwards every method — the library owns sign-up/in/out and session.
 */
import { route } from "@rpxd/core";
import { auth } from "../adapters/auth";

export default route("/api/auth/$").all((req) => auth.handler(req));
