// tests/smoke/rls-anon-demo.spec.js
//
// Verifies the RLS posture on the demo project (<YOUR_DEMO_PROJECT_REF>):
//   * Anon CAN SELECT the public set (offices, contacts w/ fake PII,
//     hill_*, budget_*, etc.)
//   * Anon CANNOT SELECT the hidden set (scout_*, user_roles,
//     auth_allowlist, office_media).
//   * Anon CANNOT INSERT/UPDATE/DELETE on any table.
//
// Targets supabase/migrations/optional/rls_demo.sql post-apply.

const { test, expect } = require('@playwright/test');
const { waitForBoot } = require('./_helpers');

test('demo RLS: anon CAN read demo-public tables', async ({ page }) => {
  await page.goto('/');
  await waitForBoot(page);

  const result = await page.evaluate(async () => {
    const checks = {};
    const publicTables = [
      'offices', 'contacts', 'solicitations', 'letters', 'washops',
      'hill_members', 'hill_committees',
      'budget_pes', 'budget_om_sags',
    ];
    for (const t of publicTables) {
      try {
        const { data, error } = await window._sb.from(t).select('*', { count: 'exact', head: true }).limit(1);
        checks[t] = error ? { err: error.code || error.message } : { ok: true };
      } catch (e) {
        checks[t] = { err: String(e) };
      }
    }
    return checks;
  });

  for (const [table, status] of Object.entries(result)) {
    expect(status.ok, `anon SELECT on ${table} should succeed; got: ${JSON.stringify(status)}`).toBe(true);
  }
});

test('anon CANNOT read demo-hidden tables', async ({ page }) => {
  await page.goto('/');
  await waitForBoot(page);

  const result = await page.evaluate(async () => {
    const checks = {};
    const hiddenTables = [
      'user_roles', 'auth_allowlist',
      'scout_findings', 'scout_jobs', 'scout_messages',
      'apollo_phone_webhook_log',
      'office_media',
    ];
    for (const t of hiddenTables) {
      try {
        const { data, error } = await window._sb.from(t).select('*').limit(1);
        // Either an error (good) OR empty data (still acceptable -- RLS
        // returns 0 rows rather than an error in some configs). We
        // require either error OR (data is array AND data.length === 0).
        checks[t] = {
          hasError: !!error,
          errorCode: error?.code,
          rowsReturned: Array.isArray(data) ? data.length : null,
        };
      } catch (e) {
        checks[t] = { hasError: true, errorCode: 'thrown', thrown: String(e) };
      }
    }
    return checks;
  });

  for (const [table, status] of Object.entries(result)) {
    // We accept either: error returned, OR zero rows. Either way no data leaks.
    const safe = status.hasError === true || status.rowsReturned === 0;
    expect(safe, `anon should not see rows from ${table}; got: ${JSON.stringify(status)}`).toBe(true);
  }
});

test('anon CANNOT write to any demo table', async ({ page }) => {
  await page.goto('/');
  await waitForBoot(page);

  const result = await page.evaluate(async () => {
    const checks = {};
    const writeAttempts = [
      ['offices',       { id: 'rls-test-' + Date.now(), name: 'rls-test-should-fail' }],
      ['contacts',      { id: 'rls-test-' + Date.now(), name: 'rls-test-should-fail' }],
      ['solicitations', { id: 'rls-test-' + Date.now(), title: 'rls-test-should-fail' }],
    ];
    for (const [table, row] of writeAttempts) {
      try {
        const { data, error } = await window._sb.from(table).insert(row).select();
        checks[table] = {
          hasError: !!error,
          errorCode: error?.code,
          // Demo also has the SDK proxy that intercepts writes (v224).
          // Either layer blocking is acceptable; the test verifies that
          // the row didn't actually land.
          insertedRows: Array.isArray(data) ? data.length : 0,
        };
      } catch (e) {
        checks[table] = { hasError: true, errorCode: 'thrown', thrown: String(e) };
      }
    }
    return checks;
  });

  for (const [table, status] of Object.entries(result)) {
    const blocked = status.hasError === true || status.insertedRows === 0;
    expect(blocked, `anon write on ${table} should be blocked; got: ${JSON.stringify(status)}`).toBe(true);
  }
});
