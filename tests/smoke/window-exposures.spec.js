// tests/smoke/window-exposures.spec.js
//
// The most paranoid test. After v204-v228 extracted 52 modules, the
// scope-chain pattern depends on every module's window.X exposures
// being live by the time the boot IIFE awaits its async chain.
//
// This test catches the failure mode where someone extracts a module
// in a future commit and forgets to add window.X = X at the foot,
// breaking a classic-script bare-identifier consumer. Documented as
// F-NEW-V185-1 in memory.
//
// We list every CRITICAL window export and assert each is the right
// type. New exposures should be added here as they ship.

const { test, expect } = require('@playwright/test');
const { waitForBoot } = require('./_helpers');

const REQUIRED_EXPOSURES = {
  '_v135Auth':            'object',
  '_v135BootAuth':        'function',
  'DB':                   'object',
  '_supaUpsert':          'function',
  '_supaUpdate':          'function',
  '_supaDelete':          'function',
  'getOfficesForPe':      'function',
  'getOfficesForSag':     'function',
  'linkPeToOffice':       'function',
  'linkSagToOffice':      'function',
  'makeId':               'function',
  'updateSaveStatus':     'function',
  '_applyDemoMode':       'function',
  'activateTab':          'function',
  'TABS':                 'object',  // array is typeof 'object'
  '_sb':                  'object',
  '_initSupabase':        'function',
  // SEED_DATA removed in (seed.js deleted; no DB._seedToSupabase
  // consumer remains). Intentionally not listed below.
  'selectOfficesHtml':    'function',
  'selectFromList':       'function',
  'refillOfficeSelect':   'function',
  '_v230GoToHillEntry':   'function',
  '_renderSagOfficePicker': 'function',
  '_renderPeOfficePicker':  'function',
};

test('post-v228: every critical window exposure is live after boot', async ({ page }) => {
  await page.goto('/');
  await waitForBoot(page);

  const missing = await page.evaluate((required) => {
    const m = {};
    for (const [name, expected] of Object.entries(required)) {
      const actual = typeof window[name];
      if (actual === 'undefined') {
        m[name] = 'MISSING (' + expected + ' expected)';
      } else if (actual !== expected) {
        m[name] = 'WRONG TYPE (got ' + actual + ', expected ' + expected + ')';
      }
    }
    return m;
  }, REQUIRED_EXPOSURES);

  const missingList = Object.entries(missing).map(([k,v]) => `  ${k}: ${v}`).join('\n');
  expect(Object.keys(missing), `Missing/wrong-type exposures:\n${missingList}`).toHaveLength(0);
});
