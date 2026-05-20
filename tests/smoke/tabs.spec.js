// tests/smoke/tabs.spec.js
//
// assertions still inspect .tab-btn.active because activateTab toggles
// both nav surfaces. Each tab gets a generous wait for any phase-2
// data to land.

const { test, expect } = require('@playwright/test');
const { waitForBoot, waitForBudgetPhase } = require('./_helpers');

const TABS = [
  { id: 'dashboard',     waitMs: 300 },
  { id: 'offices',       waitMs: 500 },
  { id: 'contacts',      waitMs: 500 },
  { id: 'solicitations', waitMs: 500 },
  { id: 'letters',       waitMs: 300 },
  { id: 'washops',       waitMs: 800 },
  { id: 'budget',        waitMs: 2000 },
];

test('demo tabs: each tab activates and renders', async ({ page }) => {
  await page.goto('/');
  await waitForBoot(page);
  await waitForBudgetPhase(page);

  for (const { id, waitMs } of TABS) {
    const btn = page.locator(`[data-v98-tab="${id}"]`);
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(page.locator(`.tab-panel[data-tab-panel="${id}"]`)).toHaveClass(/active/);
    await page.waitForTimeout(waitMs);
  }
});
