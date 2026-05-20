// tests/smoke/hill-ops.spec.js
//
// [data-v98-tab="washops"] which is the visible nav surface.

const { test, expect } = require('@playwright/test');
const { waitForBoot } = require('./_helpers');

test('direct nav to Hill Ops tab populates Summary subtab', async ({ page }) => {
  await page.goto('/');
  await waitForBoot(page);

  await page.locator('[data-v98-tab="washops"]').click();

  await expect(page.locator('[data-subtab-group="washops"] .subtab-btn[data-subtab="washops-summary"]')).toHaveClass(/active/);
  await expect(page.locator('#hillSummaryWrap')).not.toContainText('Loading', { timeout: 15_000 });
});

test('programmatic activateTab("washops") fires hill renderers', async ({ page }) => {
  await page.goto('/');
  await waitForBoot(page);

  await page.evaluate(() => window.activateTab('washops'));

  await expect(page.locator('.tab-btn[data-tab="washops"]')).toHaveClass(/active/);
  await expect(page.locator('#hillSummaryWrap')).not.toContainText('Loading', { timeout: 15_000 });
});
