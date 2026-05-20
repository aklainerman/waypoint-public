// tests/smoke/rls-anon-stage.spec.js
//
// Verifies that anon (unauthenticated) visitors to Stage CANNOT read
// ANY CRM table -- the v135 login overlay blocks the UI, but RLS is
// the authoritative guard. Tests run against the `stage` project.

const { test, expect } = require('@playwright/test');

test('anon CANNOT read any table on Stage', async ({ page, context }) => {
  // legacy form; Supabase v2 uses localStorage by default for sessions
  // (`sb-<project-ref>-auth-token`). Without clearing localStorage, a
  // session from a prior test (or even the same context's earlier
  // navigations) can leak in and turn the test into an "authenticated
  // read" test, masking the RLS we're trying to verify.
  await context.clearCookies();
  await page.goto('/');
  await page.evaluate(() => {
    try { localStorage.clear(); } catch (e) {}
    try { sessionStorage.clear(); } catch (e) {}
  });
  await page.reload();

  // Don't wait for boot -- boot will halt at the login overlay since
  // there's no session. We poke at _sb directly once the SDK loads.
  await page.waitForFunction(() => !!window._sb, { timeout: 15_000 });

  const result = await page.evaluate(async () => {
    const checks = {};
    const tables = [
      'offices', 'contacts', 'solicitations', 'letters',
      'user_roles', 'auth_allowlist',
      'hill_meetings', 'scout_jobs',
    ];
    for (const t of tables) {
      try {
        const { data, error } = await window._sb.from(t).select('*').limit(1);
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
    const denied = status.hasError === true || status.rowsReturned === 0;
    expect(denied, `Stage anon SELECT on ${table} must be denied; got: ${JSON.stringify(status)}`).toBe(true);
  }
});

test('anon CAN still call is_email_allowed RPC on Stage', async ({ page, context }) => {
  await context.clearCookies();
  await page.goto('/');
  await page.evaluate(() => {
    try { localStorage.clear(); } catch (e) {}
    try { sessionStorage.clear(); } catch (e) {}
  });
  await page.reload();
  await page.waitForFunction(() => !!window._sb, { timeout: 15_000 });

  // is_email_allowed is the one RPC anon needs to call from the login
  // modal. Verify it still works post-RLS-apply.
  const result = await page.evaluate(async () => {
    try {
      const { data, error } = await window._sb.rpc('is_email_allowed', {
        p_email: 'definitely-not-on-allowlist@example.invalid',
      });
      return { ok: !error, data, errorCode: error?.code };
    } catch (e) {
      return { ok: false, thrown: String(e) };
    }
  });

  expect(result.ok, `is_email_allowed RPC must remain callable by anon; got: ${JSON.stringify(result)}`).toBe(true);
  // aren't in auth_allowlist. The .invalid TLD is reserved (RFC 2606)
  // and definitely-not-on-allowlist@example.invalid is impossible to
  // collide with any real allowlist entry.
  expect(result.data, `is_email_allowed should return false for non-allowlist email; got: ${JSON.stringify(result)}`).toBe(false);
});
