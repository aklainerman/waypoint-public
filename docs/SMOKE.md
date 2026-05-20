# Smoke harness

Headless Playwright tests covering the highest-value regression
surfaces in Waypoint. Targets the public Demo site by default (no
auth needed); a separate `stage` project hits Stage to verify the
login overlay.

## First-time setup

```bash
# From the repo root
npm install                              # picks up @playwright/test
npx playwright install chromium          # downloads the Chromium binary (~150 MB)
```

## Running

```bash
npm run smoke           # headless, the daily-driver
npm run smoke:headed    # visible browser, useful for debugging
npm run smoke:debug     # Playwright inspector, step-by-step
npm run smoke:ui        # interactive test runner
npm run smoke:report    # open the HTML report from the last run
```

Run only one project (Demo or Stage):

```bash
npx playwright test --project=demo
npx playwright test --project=stage
```

Run a specific spec file:

```bash
npx playwright test tests/smoke/boot.spec.js
```

## What's covered

| Spec | Surface | Tag origin |
|---|---|---|
| `boot.spec.js` | Demo loads end-to-end, DB.state populated, no console errors | v204-v228 |
| `window-exposures.spec.js` | Every critical `window.X = X` export is live post-boot | — |
| `tabs.spec.js` | All 9 main tabs activate and render without errors | — |
| `kpi-drillthrough.spec.js` | KPI tiles route to right tab + filter; sidebar nav resets filter | — |
| `hill-ops.spec.js` | Direct + programmatic activateTab('washops') populates Summary | — |
| `sag-tagging.spec.js` | SAG detail row has `+ Add office` affordance | — |
| `theme.spec.js` | Theme cycle auto → light → dark → auto, localStorage roundtrip | — |
| `demo-write-block.spec.js` | SDK proxy intercepts writes in DEMO_MODE | — |
| `stage-login.spec.js` | Stage unauth visit shows v135 overlay; non-allowlist email rejected | — |

## What's NOT covered

- **Authenticated Stage flows.** Magic-link sign-in requires either a test account with allowed email or a service-role token. Deferred to Phase 1.5 manual QA until we set up a test user.
- **Prod.** Same constraints as Stage. Smoke prod manually after each push.
- **Visual regressions.** No screenshot diffing yet. Add `expect(page).toHaveScreenshot()` calls as needed.
- **Net new bugs from real DB shape changes.** Tests assert SHAPE (DB.state.offices is an Array), not content (no specific office IDs hard-coded).
- **Multi-browser.** Chromium-only. Add WebKit/Firefox projects in `playwright.config.js` if cross-browser regressions ever bite.

## How to extend

When you extract a new module that exposes `window.X`:
1. Add `X: 'function'` (or `'object'`) to the `REQUIRED_EXPOSURES` map in `tests/smoke/window-exposures.spec.js`. This single test guards against the F-NEW-V185-1 family of regressions.

When you fix a UX bug like a recent UX-fix batch:
1. Drop a spec file at `tests/smoke/<short-name>.spec.js`.
2. Mirror the existing format: import `_helpers`, gate on `waitForBoot`, assert the specific behavior.
3. Reference the tag in a top-of-file comment so future readers know why the test exists.

When you add a new tab or KPI tile:
1. Append to the `TABS` array in `tabs.spec.js`.
2. Add a KPI-specific test in `kpi-drillthrough.spec.js` if it has a filter or subtab side-effect.

## Environment variables

Override the target URLs without editing config:

```bash
WAYPOINT_SMOKE_DEMO_URL=https://my-fork-demo.netlify.app npm run smoke
WAYPOINT_SMOKE_STAGE_URL=https://my-fork-stage.netlify.app npm run smoke
```

## CI integration (future)

The harness is CI-ready. Set `CI=1` to flip on stricter mode:
- 2 retries instead of 1 (Netlify cold starts)
- Forbid `.only()` in test files
- 2 workers max (rate-limit-friendly)

GitHub Actions example (not yet wired):

```yaml
- name: Smoke
  run: |
    npm ci
    npx playwright install --with-deps chromium
    npm run smoke
  env:
    CI: '1'
- name: Upload report
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: playwright-report
    path: playwright-report/
```

## Known flake conditions

- **Cold-start latency.** First test after Netlify spins up a function can take 10-15s. The 60s per-test timeout absorbs this; if you see widespread timeouts, retry once before chasing real bugs.
- **DEMO Supabase RLS.** If the demo project ever changes RLS policies, `boot.spec.js` may time out on `waitForBoot` because `DB.load` fails. Check the Supabase dashboard first.
- **Window-exposures false negatives.** If a new module is added without updating `REQUIRED_EXPOSURES`, that test stays green even though the new module isn't covered. The list is a floor, not a ceiling.


