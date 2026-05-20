// tests/smoke/boot.spec.js
//
// The single highest-value test in the suite. Verifies the Demo URL
// loads end-to-end. Strict console-error gate lives here -- the only
// test that needs to be sensitive to console noise.

const { test, expect } = require('@playwright/test');
const { trackConsoleErrors, waitForBoot } = require('./_helpers');

test('demo boot: page loads, no errors, DB.state populated', async ({ page }) => {
  const errors = trackConsoleErrors(page);

  await page.goto('/');

  // No login overlay should appear on demo
  await expect(page.locator('.v135-login-overlay')).toHaveCount(0);

  // Boot completes -- DB.state.offices populated
  await waitForBoot(page);

  // Role + demo classes on body
  await expect(page.locator('body')).toHaveClass(/role-viewer/);
  await expect(page.locator('body')).toHaveClass(/demo-mode/);

  // Mission Control should be the active tab
  await expect(page.locator('.tab-btn[data-tab="dashboard"]')).toHaveClass(/active/);

  // No console errors after a settle window
  await page.waitForTimeout(3000);
  expect(errors, `console errors:\n  ${errors.join('\n  ')}`).toHaveLength(0);
});
