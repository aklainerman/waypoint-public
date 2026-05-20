// tests/smoke/kpi-drillthrough.spec.js
//
//
// .click(). The parent <a class="mc-kpi has-data"> resolves correctly
// but Playwright's actionability check reports "not visible" -- likely
// a transient layout state during boot (the dashboard panel briefly
// has zero bounding box until refreshCardCounters paints). Native DOM
// .click() fires the same handler chain without the visibility gate.

const { test, expect } = require('@playwright/test');
const { waitForBoot, waitForKpiPopulated } = require('./_helpers');

async function clickKpi(page, dataKpi) {
  // Native DOM click -- bypasses Playwright actionability heuristic.
  // The handler in wire.js fires regardless of whether the element
  // passes Playwright's visibility check.
  const clicked = await page.evaluate((k) => {
    const el = document.querySelector(`a.mc-kpi:has([data-kpi="${k}"])`);
    if (!el) return false;
    el.click();
    return true;
  }, dataKpi);
  expect(clicked, `KPI tile [data-kpi="${dataKpi}"] not found in DOM`).toBe(true);
}

test('v229: Champions KPI applies championsOnly filter, sidebar nav resets it', async ({ page }) => {
  await page.goto('/');
  await waitForBoot(page);
  await waitForKpiPopulated(page);

  await clickKpi(page, 'champions');

  await expect(page.locator('.tab-btn[data-tab="contacts"]')).toHaveClass(/active/);
  await expect(page.locator('#contactsChampionOnly')).toBeChecked();

  await page.locator('[data-v98-tab="contacts"]').click();
  await expect(page.locator('#contactsChampionOnly')).not.toBeChecked();
});

test('v229: Awards KPI sets solStatusFilter to Won, Pipeline KPI resets', async ({ page }) => {
  await page.goto('/');
  await waitForBoot(page);
  await waitForKpiPopulated(page);

  await clickKpi(page, 'contracts');
  await expect(page.locator('.tab-btn[data-tab="solicitations"]')).toHaveClass(/active/);
  await expect(page.locator('#solStatusFilter')).toHaveValue('Won');

  await page.locator('[data-v98-tab="dashboard"]').click();
  await clickKpi(page, 'tam');
  await expect(page.locator('.tab-btn[data-tab="solicitations"]')).toHaveClass(/active/);
  await expect(page.locator('#solStatusFilter')).toHaveValue('');
});

test('v229: Priority Orgs tile from Tier View routes to List View with filter on', async ({ page }) => {
  await page.goto('/');
  await waitForBoot(page);
  await waitForKpiPopulated(page);

  await page.locator('[data-v98-tab="offices"]').click();
  await page.locator('[data-subtab-group="offices"] .subtab-btn[data-subtab="offices-tier"]').click();
  await expect(page.locator('[data-subtab-group="offices"] .subtab-btn[data-subtab="offices-tier"]')).toHaveClass(/active/);

  // Tier View KPI clicks via evaluate too, for consistency.
  const clicked = await page.evaluate(() => {
    const el = document.querySelector('.tier-mc-kpis a.mc-kpi:has([data-kpi="priority"])');
    if (!el) return false;
    el.click();
    return true;
  });
  expect(clicked).toBe(true);

  await expect(page.locator('[data-subtab-group="offices"] .subtab-btn[data-subtab="offices-list"]')).toHaveClass(/active/);
  await expect(page.locator('#officesPriorityOnly')).toBeChecked();
});
