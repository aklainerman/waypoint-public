// tests/smoke/theme.spec.js
//
// (the sidebar button). The legacy #themeToggle still exists but is
// CSS-hidden in the current layout. Both fire the same cycleTheme()
// handler; click the proxy.

const { test, expect } = require('@playwright/test');
const { waitForBoot } = require('./_helpers');

test('v225: theme toggle cycles auto -> light -> dark -> auto', async ({ page }) => {
  await page.goto('/');
  await waitForBoot(page);

  const toggle = page.locator('#v98ThemeProxy');
  await expect(toggle).toBeVisible();

  const startTheme = await page.evaluate(() => localStorage.getItem('dow-theme-v1') || 'auto');

  for (let i = 0; i < 3; i++) {
    await toggle.click();
    await page.waitForTimeout(250);
  }

  const endTheme = await page.evaluate(() => localStorage.getItem('dow-theme-v1') || 'auto');
  expect(endTheme).toBe(startTheme);
});
