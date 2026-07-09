/**
 * redirect() from mount (§10, the routes & auth guide): a protected route
 * bounces anonymous visitors to /login — via a 302 on a full load and a soft
 * client navigation on a Link click — and renders once signed in.
 */
import { expect, test } from "@playwright/test";

test("full-load visit to a protected route 302s to /login", async ({ page }) => {
  await page.goto("/account");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId("login-form")).toBeVisible();
});

test("soft Link navigation to a protected route bounces to /login", async ({ page }) => {
  await page.goto("/"); // anonymous
  await page.getByRole("link", { name: "account" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId("login-form")).toBeVisible();
});

test("protected route renders once signed in", async ({ page }) => {
  const email = `acct-${Date.now()}-${Math.floor(Math.random() * 1e6)}@x.com`;
  await page.goto("/login");
  await page.getByTestId("email").fill(email);
  await page.getByTestId("password").fill("password123");
  await page.getByTestId("do-sign-up").click();
  await expect(page.getByTestId("who")).toContainText(email);

  await page.goto("/account");
  await expect(page.getByTestId("account-email")).toContainText(email);
});
