// js/db/supabase.js
//
// 5924-5976 of post-v226 source (block 1, the last meaningful chunk
// of classic-script app logic).
//
// Contents:
//   * TABLES         -- canonical 24-table list
//   * window._sb     -- Supabase client, lazily populated by
//                       _initSupabase
//   * _initSupabase  -- fetches /.netlify/functions/config, creates
//                       supabase.createClient, sets WAYPOINT_ENV +
//                       DEMO_MODE on window, optionally calls
//                       _applyDemoMode (demo-mode.js)
//
// IMPORTANT REWRITE: classic-script `let _sb = null` rewritten to
// `window._sb = null` so every consumer module's bare `_sb` resolves
// via the window object (Global Object Record on the realm scope
// chain). Same fall-through pattern that DB / refreshAll / etc. use.
// Without this, after extracting _sb out of classic GLE, bare `_sb`
// in db.js / login.js / admin.js / demo-mode.js would throw
// ReferenceError on first call.
//
// Consumer modules (no source changes needed):
//   js/db/db.js, js/auth/login.js, js/auth/admin.js,
//   js/demo/demo-mode.js
//
// External global consumed: `supabase` (UMD global from the
// supabase-js v2 CDN script in <head>).

/* =============================================================
   v12 JS — Waypoint CRM
   ============================================================= */

// ---------------------------------------------------------------
//  DB module — Supabase-backed shared DB with in-memory cache
//
//  Reads are synchronous (off DB.state, populated on load).
//  Writes update DB.state immediately (UI stays snappy) and push to
//  Supabase in the background (fire-and-forget). Errors surface in
//  the save-status indicator and the browser console.
//  ---------------------------------------------------------------
//  Access control: Netlify password gate protects the whole app.
//  Supabase RLS is configured to allow anon full access — see
//  supabase_schema.sql in this folder.
// ---------------------------------------------------------------
// Supabase URL / anon key are provided by a Netlify Function at runtime so
// the same HTML can deploy to both stage and prod Netlify sites and each
// will connect to its own Supabase project (env vars set by the Netlify
// Supabase integration per site). See netlify/functions/config.js.
const TABLES = ['offices','contacts','solicitations','letters','washops','requests','budget_orgs','budget_appropriations','budget_pes','budget_projects','pe_office_links','pe_office_link_dismissals','pe_office_suggestions','budget_om_sags','budget_topline_lines','sag_office_links','sag_office_link_dismissals','sag_office_suggestions','office_media','hill_members','hill_committees','hill_committee_memberships','hill_meetings','hill_requests','engagements'];

// _sb is populated by _initSupabase() during boot. All uses of _sb happen
// inside async functions invoked after boot completes, so late binding is safe.
window._sb = null;
async function _initSupabase() {
  const resp = await fetch('/.netlify/functions/config', { cache: 'no-store' });
  if (!resp.ok) throw new Error('config endpoint returned ' + resp.status);
  const cfg = await resp.json();
  const url = cfg.supabaseUrl;
  const key = cfg.supabaseAnonKey;
  if (!url || !key) throw new Error('config endpoint missing supabaseUrl or supabaseAnonKey');
  // supabase-js v2 UMD exposes a global `supabase` with createClient.
  window._sb = supabase.createClient(url, key);

  // -----------------------------------------------------------------------
  // Environment-aware setup. WAYPOINT_ENV is set per Netlify site (prod /
  // stage / demo) and read here from /.netlify/functions/config. The
  // 'demo' value triggers a global read-only posture: Scout UI hidden,
  // edit/delete/add buttons suppressed via CSS, and every
  // supabase.from(...).insert/update/delete/upsert intercepted at the SDK
  // layer so even handlers that bypass the CSS hide cannot mutate data.
  // Server-side RLS on the DEMO project is the authoritative guard; this
  // wiring is for UX, not security.
  // -----------------------------------------------------------------------
  if (cfg.warning) console.warn('[waypoint/config]', cfg.warning);
  window.WAYPOINT_ENV = (cfg.env || 'unknown').toLowerCase();
  window.DEMO_MODE = (window.WAYPOINT_ENV === 'demo');

  // SCOUT_AVAILABLE mirrors functions/config.js's Boolean(ANTHROPIC_API_KEY).
  // js/chrome/wire.js + js/nav/tabs.js gate the Scout tab + rail link on this
  // flag so a fork deployed without an Anthropic key never shows Scout UI
  // that would 503 on click. Demo mode also forces this false because the
  // demo env unconditionally 404s Scout endpoints.
  window.SCOUT_AVAILABLE = !window.DEMO_MODE && Boolean(cfg.scoutAvailable);

  // Hide Scout UI elements when not available. This runs AFTER the
  // deferred chrome/wire.js + nav/tabs.js modules have already wired
  // click handlers — those handlers harmlessly no-op on hidden nodes,
  // and activateTab() additionally redirects 'scout' -> 'dashboard'
  // when SCOUT_AVAILABLE is false. The body class is exposed for any
  // CSS rules that want to target the Scout-disabled state directly.
  if (!window.SCOUT_AVAILABLE) {
    document.body.classList.add('scout-disabled');
    try {
      const scoutNodes = document.querySelectorAll(
        '.tab-btn[data-tab="scout"], .v98-rail-link[data-v98-tab="scout"], .tab-panel[data-tab-panel="scout"]'
      );
      scoutNodes.forEach(el => { el.hidden = true; });
    } catch (e) { /* non-fatal */ }
  }

  // Populate footer with live version + build SHA from cfg. The HTML
  // fallback ("Waypoint v1.0.x") shows during initial paint before this
  // resolves; once cfg arrives we replace with the authoritative value.
  try {
    var footEl = document.getElementById('footer-version');
    if (footEl) {
      var sha = cfg.buildSha && cfg.buildSha !== 'dev' ? ' (build ' + cfg.buildSha + ')' : '';
      footEl.textContent = 'Waypoint ' + (cfg.version || '') + sha;
    }
  } catch (e) { /* non-fatal */ }

  // Saves ~17 KB on prod/stage payload where this module is never used.
  // Top-level await is fine -- _initSupabase is async and the boot
  // IIFE awaits it before any consumer reads window._applyDemoMode.
  if (window.DEMO_MODE) {
    await import('../demo/demo-mode.js');
    if (typeof window._applyDemoMode === 'function') {
      window._applyDemoMode();
    }
  }
}

// Window exposures
window.TABLES = TABLES;
window._initSupabase = _initSupabase;
