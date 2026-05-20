// playwright.config.js
//
// for the bulk of tests (no auth needed); one test hits Stage to
// verify the login overlay still renders.
//
// To install Playwright + Chromium:   npm install -D @playwright/test
//                                      npx playwright install chromium
// To run:                              npm run smoke
//                                      npm run smoke:headed   (visible browser)
//                                      npm run smoke:debug    (inspector)

// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// Set WAYPOINT_SMOKE_DEMO_URL and WAYPOINT_SMOKE_STAGE_URL in your shell
// or CI to point at your own Netlify sites. Defaults below are placeholders
// and will fail the smoke until you override them.
const DEMO_URL  = process.env.WAYPOINT_SMOKE_DEMO_URL  || 'https://your-demo-site.netlify.app';
const STAGE_URL = process.env.WAYPOINT_SMOKE_STAGE_URL || 'https://your-stage-site.netlify.app';

module.exports = defineConfig({
  testDir: './tests/smoke',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1, // Netlify cold-starts can be flaky
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 60_000, // 60s per test -- generous because of Netlify cold starts + Supabase round trips

  use: {
    baseURL: DEMO_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'demo',
      use: { ...devices['Desktop Chrome'], baseURL: DEMO_URL },
      // Match any spec with "stage" in the filename and route it to
      // the `stage` project below; everything else runs on Demo.
      testIgnore: /stage.*\.spec\.js$/,
    },
    {
      name: 'stage',
      use: { ...devices['Desktop Chrome'], baseURL: STAGE_URL },
      // Catch both "stage-foo.spec.js" AND "foo-stage.spec.js" naming.
      testMatch: /stage.*\.spec\.js$/,
    },
  ],
});
