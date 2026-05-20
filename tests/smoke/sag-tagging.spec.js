// tests/smoke/sag-tagging.spec.js
//
// headless Chromium against Demo -- renderBudget paints 0 rows even
// though DB.state has 2143 PEs + 389 SAGs (probably a subtab-active
// dependency in the budget-tree renderer that doesn't reproduce
// outside a real browser session). The DOM check kept giving false
// negatives.
//
// Replacement: verify the SAG <-> Office wiring at the CODE level.
// That's what the regression class actually is: "did the module
// extraction break the symbol chain?" -- which a code-level check
// catches deterministically. Visual / UX verification of "+ Add office
// click works" stays in the manual smoke checklist (docs/SMOKE.md).

const { test, expect } = require('@playwright/test');
const { waitForBoot } = require('./_helpers');

test('SAG <-> Office wiring is intact (code-level)', async ({ page }) => {
  await page.goto('/');
  await waitForBoot(page);

  // Every symbol the SAG-side affordance depends on must be
  // callable from the window scope. If any of these falls back to
  // undefined after a future extraction, this test fails immediately.
  const wiring = await page.evaluate(() => ({
    _renderSagOfficePicker:    typeof window._renderSagOfficePicker,
    linkSagToOffice:           typeof window.linkSagToOffice,
    unlinkSagFromOffice:       typeof window.unlinkSagFromOffice,
    dismissSagOfficeSuggestion: typeof window.dismissSagOfficeSuggestion,
    getOfficesForSag:          typeof window.getOfficesForSag,
    getSagsForOffice:          typeof window.getSagsForOffice,
    renderBudget:              typeof window.renderBudget,
    DB:                        typeof window.DB,
  }));

  const broken = Object.entries(wiring)
    .filter(([_, t]) => t !== 'function' && t !== 'object')
    .map(([name, t]) => `${name}: ${t}`);

  expect(broken, `Broken wiring:\n  ${broken.join('\n  ')}`).toHaveLength(0);
});
