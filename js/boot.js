// js/boot.js
//
// ES-module entry point for the v180 refactor. Loaded by index.html via:
//
//   <script type="module" src="./js/boot.js"></script>
//
// `type="module"` defers execution to after HTML parsing, which means this
// module runs alongside (but logically after) the inline monolith script
// during the transition. The monolith continues to drive the app; this
// module currently just installs the event-bus bridge so the
// `enigma:*` -> `waypoint:*` rename is transparent across the codebase.
//
// As extraction proceeds, more module imports land here and the monolith
// shrinks. The end state: this file boots the full app and `index.html`
// has no inline JS.
//
// v235: legacy `enigma:*` event bridge dropped; canonical names are
// `waypoint:datachange` and `waypoint:themechange` everywhere now.

import './core/event-bus.js';

// v235 / v240: one-shot localStorage key migration. Old keys (legacy
// `enigma_*` from pre-v172 + legacy `pulse_*` / `pulse-*` from the
// v172-to-v240 interim that missed several keys) are renamed to
// canonical `waypoint_*` / `waypoint-*` form. Idempotent: if the legacy
// key exists and the new one doesn't, copy across; then remove the
// legacy key. Runs once per browser per key.
(function _migrateLegacyLocalStorageKeys() {
  const migrations = [
    // v235 (enigma -> waypoint)
    ['enigma_budget_year',                  'waypoint_budget_year'],
    ['enigma-map-overrides-v1',             'waypoint-map-overrides-v1'],
    // v240 (pulse -> waypoint; migration jumps straight to v1.0 final names)
    ['pulse-v98-rail-collapsed',            'waypoint-rail-collapsed'],
    ['pulse_v97_dash_parent_collapsed',     'waypoint-dash-parent-collapsed'],
    ['pulse_v97_dash_sect_collapsed',       'waypoint-dash-sect-collapsed'],
    // v1.0 (drop version stamps from keys for clean baseline)
    ['waypoint-v98-rail-collapsed',         'waypoint-rail-collapsed'],
    ['waypoint_v97_dash_parent_collapsed',  'waypoint-dash-parent-collapsed'],
    ['waypoint_v97_dash_sect_collapsed',    'waypoint-dash-sect-collapsed'],
  ];
  for (const [oldKey, newKey] of migrations) {
    try {
      const legacy = localStorage.getItem(oldKey);
      if (legacy == null) continue;
      if (localStorage.getItem(newKey) == null) {
        localStorage.setItem(newKey, legacy);
      }
      localStorage.removeItem(oldKey);
    } catch (e) {
      // localStorage disabled or quota issue -- ignore; consumer code
      // already handles missing-key gracefully.
    }
  }
})();

// v188 fix: the inline HTML for #tab-offices has an off-by-one </div> around
// lines 5048-5050 that prematurely closes <div class="container"> (opened
// at line 4735). When the browser parser hits the mismatched </div>, it
// implicit-closes <section id="tab-offices"> to keep the stack valid, which
// leaves the subtab-panel[data-subtab-panel="offices-map"] orphaned as a
// direct child of <body> instead of nested inside #tab-offices.
//
// Visible symptom: after visiting Orgs > Map View once, Leaflet populates
// the orphan with map tiles + controls. From then on the map widget
// persists on every top-level tab because hiding #tab-offices via display:
// none no longer hides the body-level orphan.
//
// Band-aid: at DOMContentLoaded, find the orphan and re-parent it back into
// #tab-offices. Idempotent and harmless if the HTML structure ever gets
// rebalanced (the check `orphan.parentElement !== parent` short-circuits).
function _reparentOrphanedMapPanel() {
  var orphan = document.querySelector('body > .subtab-panel[data-subtab-panel="offices-map"]');
  var parent = document.getElementById('tab-offices');
  if (orphan && parent && orphan.parentElement !== parent) {
    parent.appendChild(orphan);
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _reparentOrphanedMapPanel);
} else {
  _reparentOrphanedMapPanel();
}

// Sanity log so the boot path is visible in DevTools during the refactor.
// Remove once Phase 1 ships.
if (typeof console !== 'undefined' && console.info) {
  console.info('[waypoint] js/boot.js loaded — event-bus bridge installed');
}
