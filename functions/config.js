// Netlify Function: env bridge.
//
// Returns the small payload the client needs at boot to talk to the right
// Supabase project and pick the right runtime feature set:
//
//   { env, supabaseUrl, supabaseAnonKey }
//
// `env` is one of "prod" | "stage" | "demo" | "unknown" and is set per
// Netlify site via the WAYPOINT_ENV environment variable. The client uses
// it to enable Demo mode (read-only UI, no Scout, no Apollo).
//
// Supabase env vars: the Netlify Supabase integration sets one of these
// pairs per site, and they vary by integration version. We check several
// common names so the same code works regardless of how the integration
// is configured:
//
//   SUPABASE_URL              | SUPABASE_DATABASE_URL
//   SUPABASE_ANON_KEY         | SUPABASE_PUBLISHABLE_KEY | SUPABASE_KEY

const ALLOWED_ENVS = new Set(['prod', 'stage', 'demo']);
const APP_VERSION = 'v1.0.2';  // bump per release tag
const BUILD_SHA = (process.env.COMMIT_REF || '').slice(0, 7) || 'dev';

// Scout requires an Anthropic API key. When absent, the client hides the
// Scout tab + rail link entirely (graceful degradation; see js/db/supabase.js
// + js/chrome/wire.js + js/nav/tabs.js). The Scout Netlify functions
// independently 503 if the key is missing as belt-and-suspenders.
const SCOUT_AVAILABLE = Boolean(process.env.ANTHROPIC_API_KEY);

exports.handler = async () => {
  const rawEnv = (process.env.WAYPOINT_ENV || '').trim().toLowerCase();
  const env = ALLOWED_ENVS.has(rawEnv) ? rawEnv : 'unknown';

  const supabaseUrl =
    process.env.SUPABASE_URL ||
    process.env.SUPABASE_DATABASE_URL ||
    '';

  const supabaseAnonKey =
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_KEY ||
    '';

  if (!supabaseUrl || !supabaseAnonKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        error: 'Supabase env vars not set on this Netlify site. Expected SUPABASE_URL and SUPABASE_ANON_KEY (or the integration equivalents).',
        env,
      }),
    };
  }

  // Visible warning if WAYPOINT_ENV is missing/garbage. We still serve the
  // Supabase keys so the dashboard renders, but the client will log this
  // to console so misconfiguration is loud rather than silent.
  const warning = env === 'unknown'
    ? `WAYPOINT_ENV is missing or invalid (got "${rawEnv}"). Expected one of: prod, stage, demo.`
    : null;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify({ env, supabaseUrl, supabaseAnonKey, version: APP_VERSION, buildSha: BUILD_SHA, scoutAvailable: SCOUT_AVAILABLE, warning }),
  };
};
