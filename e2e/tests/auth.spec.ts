/**
 * Auth through the `route()` seam (the routes & auth guide): sign up via the
 * /api/auth/* delegation route, land signed-in, add a user-scoped todo, sign
 * out (todos revert to anonymous), sign back in (the todo persists for the
 * user). Exercises route() dispatch, authenticate→Scope, and user-scoped data.
 */
import { expect, test } from "@playwright/test";
import { gotoHydrated } from "./helpers";

test("sign up → scoped todos → sign out → sign back in", async ({ page }) => {
  // Unique per run so reruns against a reused dev server don't collide.
  const email = `user-${Date.now()}-${Math.floor(Math.random() * 1e6)}@x.com`;

  // Sign up on the login page; the form posts to /api/auth/sign-up. Wait for
  // hydration first — a pre-hydration click falls through to a native form
  // submit and the sign-up never happens (the old flake).
  await gotoHydrated(page, "/login");
  await page.getByTestId("email").fill(email);
  await page.getByTestId("password").fill("password123");
  await page.getByTestId("do-sign-up").click();

  // Lands on / signed in (authenticate resolved the new session into the Scope).
  await expect(page.getByTestId("who")).toContainText(email);

  // `who` is SSR content — visible before hydration. Gate the form submit on
  // the fresh document's hydration marker, or it falls through to a native
  // form navigation and the todo is never added (the old 500ms guess raced
  // slow cold boots).
  await page.waitForSelector("html[data-rpxd-hydrated]", { state: "attached" });

  // Add a todo — scoped to this user. Wait for the server id (the ack, meaning
  // it's persisted); generous timeout since the shared dev server is under
  // parallel load from the other e2e specs.
  await page.fill('input[name="text"]', "auth-scoped task");
  await page.click('button[type="submit"]');
  await expect(page.getByTestId("todos").locator('li[data-id^="srv-"]')).toContainText(
    "auth-scoped task",
    { timeout: 15000 },
  );

  // Sign out → anonymous session no longer sees the user's todo.
  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("sign-in-link")).toBeVisible();
  await expect(page.getByTestId("todos")).not.toContainText("auth-scoped task");

  // Sign back in → the todo is still there, keyed to the user's identity.
  await page.getByTestId("sign-in-link").click();
  // The link may be a full navigation — gate on the fresh document's hydration
  // marker before typing (a soft-nav keeps the old marker and passes instantly).
  await page.waitForSelector("html[data-rpxd-hydrated]", { state: "attached" });
  await page.getByTestId("email").fill(email);
  await page.getByTestId("password").fill("password123");
  await page.getByTestId("do-sign-in").click();
  await expect(page.getByTestId("who")).toContainText(email);
  await expect(page.getByTestId("todos")).toContainText("auth-scoped task");
});

test("bad credentials show an error and do not sign in", async ({ page }) => {
  await gotoHydrated(page, "/login");
  await page.getByTestId("email").fill("nobody@x.com");
  await page.getByTestId("password").fill("wrong");
  await page.getByTestId("do-sign-in").click();
  await expect(page.getByTestId("login-error")).toBeVisible();
});
