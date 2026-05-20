// js/boot-app.js
//
// Supabase + auth + the two-phase DB.load + all the boot-step
// renderers.
//
// Loaded LAST in the module sequence (after every render/data module
// has registered its window.X exposures) so the bare-identifier
// callouts inside this IIFE resolve via the global object at call
// time.
//
// Lifted from index.html lines 6016-6097 of post-v227 source (the
// boot-IIFE classic-script block).
//
// External refs consumed via window (set by sibling modules):
//   _initSupabase   (supabase.js)
//   _v135BootAuth   (auth/login.js)
//   DB.load         (db.js)
//   _lastDbError, updateSaveStatus  (db.js)
//   migrateDepts, renderDashboard, wireCards, refreshAll,
//   activateTab, TABS, renderMissionControl, _v46RebuildRail
//   (all from various render/* modules)
//
// Note: the sibling js/boot.js module (loaded earlier in the chain)
// handles event-bus bridge and the v188 orphan-reparent fix. They are
// intentionally kept separate -- boot.js runs FIRST as a foundation
// shim, boot-app.js runs LAST as the dynamic entry point.

// Boot: resolve Supabase config from the Netlify Function, fetch from
// Supabase (seeding on first run), then render.
//
// letters/hill_*), so Mission Control's KPI strip can paint as soon as
// they land.  Phase 2 = the budget_* tables (multi-MB, slow), kicked off
// in the background right after the fast pass finishes rendering.  When
// the budget phase resolves, the existing v147 hook re-renders Mission
// Control + Budget views automatically via reloadForYear().
(async () => {
  try {
    await _initSupabase();
    const _authOk = await _v135BootAuth();
    if (!_authOk) {
      // Login modal shown; abort the boot. The page will reload after
      // the user clicks the magic link.
      return;
    }
    await DB.load({ phase: 'fast' });
  } catch (e) {
    console.error('[Supabase] initial load failed', e);
    _lastDbError = (e && e.message) || String(e);
    updateSaveStatus();
    alert('Failed to load data from Supabase.\n\n' + ((e && e.message) || e) + '\n\nYou can still view the app, but changes will not save until the connection recovers.');
  }
  window.__waypoint_boot_errors = window.__waypoint_boot_errors || [];
  function __waypointBootStep(name, fn) {
    try { fn(); }
    catch (e) {
      const msg = '[boot:' + name + '] ' + ((e && e.message) || String(e));
      console.error(msg, e);
      window.__waypoint_boot_errors.push(msg);
    }
  }
  __waypointBootStep('migrateDepts', function () {
    if (typeof migrateDepts === 'function') migrateDepts();
  });
  __waypointBootStep('renderDashboard', function () {
    if (typeof renderDashboard === 'function') renderDashboard();
  });
  __waypointBootStep('wireCards', function () {
    if (typeof wireCards === 'function') wireCards();
  });
  __waypointBootStep('refreshAll', function () {
    if (typeof refreshAll === 'function') refreshAll();
  });
  __waypointBootStep('activateTab', function () {
    const initial = location.hash.replace('#','');
    if (initial && TABS.includes(initial)) activateTab(initial);
    else activateTab('dashboard');
  });

  // tables land, which already re-renders Mission Control + Budget views.
  (async function _budgetPhase() {
    try {
      await DB.load({ phase: 'budget' });
    } catch (e) {
      console.error('[v172] budget phase load failed', e);
      window.__waypoint_boot_errors.push('[v172:budget] ' + ((e && e.message) || String(e)));
    }
    // Belt-and-suspenders: re-render Mission Control + Budget rail.  The
    // it threw (e.g. RPC missing on a non-budget Supabase) we still want
    // an explicit refresh so any data that did land is reflected.
    try { if (typeof renderMissionControl === 'function') renderMissionControl(); } catch (e) {}
    try { if (typeof window._v46RebuildRail === 'function') window._v46RebuildRail(); } catch (e) {}
    try { if (typeof refreshAll === 'function') refreshAll(); } catch (e) {}
  })();
})();
