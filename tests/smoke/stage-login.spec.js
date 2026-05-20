// tests/smoke/stage-login.spec.js
//
// Stage-targeted (auth-gated) smoke. Runs against your stage Netlify
// site via the `stage` project in playwright.config.js (set the URL
// via the WAYPOINT_SMOKE_STAGE_URL env var). Verifies:
//   * The login overlay renders for unauthenticated visitors.
//   * The email input, send button, and copy are all present.
//
// Does NOT actually submit a magic link (would generate real emails);
// full Stage smoke including sign-in requires a test account, deferred
// to Phase 1.5 manual QA.

const { test, expect } = require('@playwright/test');

test('stage: unauthenticated visit shows v135 login overlay', async ({ page, context }) => {
  // Use a fresh context so any prior session cookies are excluded
  await context.clearCookies();

  await page.goto('/');

  // Login overlay should appear within a few seconds (after
  // _initSupabase + _v135BootAuth resolves and sees no session)
  const overlay = page.locator('.v135-login-overlay');
  await expect(overlay).toBeVisible({ timeout: 15_000 });

  // Required affordances
  await expect(overlay.locator('h2')).toContainText('Sign in to Waypoint');
  await expect(overlay.locator('#v135-email')).toBeVisible();
  await expect(overlay.locator('#v135-send')).toBeVisible();
});

test('stage: non-allowlist email returns explicit error', async ({ page, context }) => {
  await context.clearCookies();
  await page.goto('/');

  const overlay = page.locator('.v135-login-overlay');
  await expect(overlay).toBeVisible({ timeout: 15_000 });

  await overlay.locator('#v135-email').fill('definitely-not-allowed@example.com');
  await overlay.locator('#v135-send').click();

  // After is_email_allowed RPC returns false, the error message should appear
  await expect(overlay.locator('#v135-msg')).toContainTe