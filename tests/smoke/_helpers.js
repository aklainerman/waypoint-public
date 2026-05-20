// tests/smoke/_helpers.js -- hardening.
//
// Shared utilities for the smoke suite. added:
//   * waitForBudgetPhase  -- gates Budget-tab tests until phase-2 load
//                            populates DB.state.budget_pes.
//   * waitForKpiPopulated -- gates MC tests until KPI numbers are
//                            written by refreshCardCounters (otherwise
//                            tests can latch onto a placeholder "0"
//                            node that gets replaced mid-click).
//   * dropped the strict console-error gate from tabs.spec; promoted
//     it to boot.spec where it actually belongs.

const NOISE_CONSOLE_PATTERNS = [
  // Known harmless warnings from third-party libs / pre-existing issues
  /\bwheelSensitivity\b/i,           // Cytoscape
  /font-family.*not.*found/i,        // Cytoscape font-fallback chain
  /bioguide\.congress\.gov/i,        // upstream image-load failures
  /chrome-extension/i,               // user's browser extensions
  /Failed to load resource.*favicon/i,
  // Demo-specific noise: the SDK proxy logs a [waypoint:demo] info
  // line on every blocked write; that's expected, not an error.
  /\[waypoint:demo\]/i,
  // Supabase RPC 404s on Demo for budget RPCs (RLS-blocked) are
  // expected per the v135 stage policy; don't fail tests on them.
  /406|404.*\.rpc/i,
];

function trackConsoleErrors(page) {
  const errors = [];
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (NOISE_CONSOLE_PATTERNS.some(re => re.test(text))) return;
    errors.push(text);
  });
  page.on('pageerror', err => {
    const text = err.message || String(err);
    if (NOISE_CONSOLE_PATTERNS.some(re => re.test(text))) return;
    errors.push('[pageerror] ' + text);
  });
  return errors;
}

/**
 * Wait for boot's fast phase: DB.state.offices populated.
 */
async function waitForBoot(page, timeout = 30_000) {
  await page.waitForFunction(
    () => window.DB && window.DB.state && Array.isArray(window.DB.state.offices) && window.DB.state.offices.length > 0,
    { timeout },
  );
}

/**
 * Wait for the v172 budget phase. Required for any test that pokes
 * at the Budget tab content (budget-tree rows, SAG detail rows, etc).
 * Budget load happens in the background AFTER the fast phase, so most
 * tests don't need to wait, but Budget-specific ones do.
 */
async function waitForBudgetPhase(page, timeout = 45_000) {
  await page.waitForFunction(
    () => window.DB && window.DB.state && Array.isArray(window.DB.state.budget_pes) && window.DB.state.budget_pes.length > 0,
    { timeout },
  );
}

/**
 * Wait for refreshCardCounters to populate KPI tile values. Without
 * this, locators can resolve to a placeholder "0" node that gets
 * replaced during the click action -> "element is not visible".
 *
 * Heuristic: the KPI strip has at least one tile whose value is no
 * longer the literal "0" or "-" / em-dash.
 */
async function waitForKpiPopulated(page, timeout = 15_000) {
  await page.waitForFunction(
    () => {
      const vals = Array.from(document.querySelectorAll('.mc-kpi-value'));
      if (!vals.length) return false;
      return vals.some(el => {
        const t = (el.textContent || '').trim();
        return t && t !== '0' && t !== '—' && t !== '-' && t !== '—';
      });
    },
    { timeout },
  );
}

module.exports = {
  trackConsoleErrors,
  waitForBoot,
  waitForBudgetPhase,
  waitForKpiPopulated,
};
