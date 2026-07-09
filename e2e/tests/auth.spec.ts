/**
 * Auth through the `route()` seam (the routes & auth guide): sign up via the
 * /api/auth/* delegation route, land signed-in, add a user-scoped todo, sign
 * out (todos revert to anonymous), sign back in (the todo persists for the
 * user). Exercises route() dispatch, authenticate→Scope, and user-scoped data.
 */
import { expect, test } from "@playwright/test";

test("sign up → scoped todos → sign out → sign back in", async ({ page }) => {
  // Unique per run so reruns against a reused dev server don't collide.
  const email = `user-${Date.now()}-${Math.floor(Math.random() * 1e6)}@x.com`;

  // Sign up on the login page; the form posts to /api/auth/sign-up.
  await page.goto("/login");
  await page.getByTestId("email").fill(email);
  await page.getByTestId("password").fill("password123");
  await page.getByTestId("do-sign-up").click();

  // Lands on / signed in (authenticate resolved the new session into the Scope).
  await expect(page.getByTestId("who")).toContainText(email);

  // Let the live connection settle after the full-page navigation before
  // driving an rpc — adding the instant the page loads races the SSE connect.
  await page.waitForTimeout(500);

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
  await page.getByTestId("email").fill(email);
  await page.getByTestId("password").fill("password123");
  await page.getByTestId("do-sign-in").click();
  await expect(page.getByTestId("who")).toContainText(email);
  await expect(page.getByTestId("todos")).toContainText("auth-scoped task");
});

test("bad credentials show an error and do not sign in", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("email").fill("nobody@x.com");
  await page.getByTestId("password").fill("wrong");
  await page.getByTestId("do-sign-in").click();
  await expect(page.getByTestId("login-error")).toBeVisible();
});
