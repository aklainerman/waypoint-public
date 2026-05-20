// js/chrome/wire.js
//
// v98-era chrome wiring: sidebar, topbar, mobile-overlay,
// cross-tab search, keyboard shortcuts, KPI-tile dispatch.
// Consolidates the last two inline-script fragments that lived
// between the mission-control.js / drillthrough.js / utils.js
// module tags. First file under js/chrome/.
//
// Content lifted from index.html in v198 (two adjacent inline-script
// fragments at ~lines 21820-21931 and 21935-22097):
//
//   Fragment 1 -- v98WireChrome IIFE (TAB_LABELS, rail click handlers,
//                 hashchange listener, v98NewSol / v98NewContact CTAs,
//                 v98RailToggle collapse + mobile-overlay short-circuit,
//                 v98ThemeProxy cycleTheme wiring) plus the v98 MC
//                 bootstrap DOMContentLoaded handler that re-renders
//                 Mission Control 200ms after load if active.
//
//   Fragment 2 -- v108Mobile IIFE (mobile-overlay close on link/click/
//                 Esc/resize), v102Search IIFE (topbar cross-tab
//                 search with polling init, multi-source filtering,
//                 _v98GoTo* dispatch), top-level keyboard-shortcut
//                 listener (digits 1-9 -> activateTab(TABS[n-1])),
//                 and KPI-tile click forEach with per-KPI prefilters.
//
// All four IIFEs are anonymous and self-invoking; the keyboard and
// KPI handlers are top-level statements. Module is side-effect only
// (no public window exposures).
//
// External file-scope ref the block consumes:
//   TABS  -- `const TABS = [...]` file-scope in monolith (~line 21702).
//            NOT on window. Redeclared module-locally below as the
//            same array literal -- the keyboard shortcut handler
//            uses TABS[n-1] to dispatch digits-to-tabs.
//
// External function calls (all resolve via window at runtime):
//   activateTab               -- monolith function decl, auto-hoisted
//   cycleTheme                -- monolith function decl, auto-hoisted
//   renderMissionControl      -- exposed by mission-control.js
//   window._v98GoToSol/Stage/Org/Hill
//                             -- exposed by drillthrough.js
//
// Module load order (document order):
//   mission-control.js -> drillthrough.js -> chrome/wire.js -> utils.js
//   All window bindings the chrome module relies on are populated
//   either by the auto-hoisted monolith body (which evaluated long
//   before any module did) or by sibling modules that load earlier
//   in document order. The v98 MC bootstrap DOMContentLoaded
//   handler fires after all deferred scripts execute.

// =================================================================
// keyboard shortcut handler references. The monolith's
// `const TABS = [...]` is module-private in classic scripts, not
// on window -- so we duplicate the array literal here. Both copies
// reference the same set of tab IDs; one source of truth lives in
// the monolith for now (will consolidate during Phase 1.5).
// =================================================================
const TABS = ['dashboard','offices','contacts','solicitations','letters','washops','budget','scout','admin'];


// ============================================================
// ------------------------------------------------------------
// Sidebar links call activateTab(...) using the existing tab IDs.
// Top-bar CTAs trigger the existing per-tab "Add" buttons so all
// ============================================================
(function v98WireChrome() {
  const TAB_LABELS = {
    dashboard: ['OPS', 'Mission Control'],
    solicitations: ['OPS', 'Pipeline'],
    letters: ['OPS', 'Support'],
    washops: ['OPS', 'Hill Ops'],
    offices: ['INTEL', 'Orgs'],
    contacts: ['INTEL', 'Contacts'],
    budget: ['INTEL', 'Budget'],
    scout: ['INTEL', 'Scout'],
  };
  const railLinks = document.querySelectorAll('.v98-rail-link[data-v98-tab]');
  function setActive(tab) {
    railLinks.forEach(el => {
      el.classList.toggle('active', el.dataset.v98Tab === tab);
    });
    const lbl = TAB_LABELS[tab];
    if (lbl) {
      const grp = document.querySelector('#v98Crumb > span');
      const leaf = document.getElementById('v98CrumbLeaf');
      if (grp) grp.textContent = lbl[0];
      if (leaf) leaf.textContent = lbl[1];
    }
  }
  railLinks.forEach(el => {
    el.addEventListener('click', () => {
      const tab = el.dataset.v98Tab;
      if (typeof activateTab === 'function') activateTab(tab);
      setActive(tab);
    });
  });
  // Reflect activateTab() calls from anywhere else (deep links,
  // KPI clicks, etc.) onto the rail's active state. We piggyback on
  // hashchange + an interval as a last resort if no event fires.
  window.addEventListener('hashchange', () => {
    const t = (location.hash || '').replace('#','').split('?')[0];
    if (t) setActive(t);
  });
  // Initial sync from current hash (fallback to dashboard).
  const startTab = (location.hash || '').replace('#','').split('?')[0] || 'dashboard';
  setActive(startTab);

  // --- top-bar CTAs ---
  const newSol = document.getElementById('v98NewSol');
  if (newSol) newSol.addEventListener('click', () => {
    if (typeof activateTab === 'function') activateTab('solicitations');
    setTimeout(() => {
      const b = document.getElementById('btnAddSol');
      if (b) b.click();
    }, 30);
  });
  const newContact = document.getElementById('v98NewContact');
  if (newContact) newContact.addEventListener('click', () => {
    if (typeof activateTab === 'function') activateTab('contacts');
    setTimeout(() => {
      const b = document.getElementById('btnAddContact');
      if (b) b.click();
    }, 30);
  });

  // --- rail collapse toggle ---
  const railBtn = document.getElementById('v98RailToggle');
  const COLLAPSED_KEY = 'waypoint-rail-collapsed';
  function applyCollapsed(collapsed) {
    document.body.classList.toggle('rail-collapsed', !!collapsed);
  }
  try {
    applyCollapsed(localStorage.getItem(COLLAPSED_KEY) === '1');
  } catch (e) { /* ignore */ }
  if (railBtn) railBtn.addEventListener('click', () => {
    // controls .rail-mobile-open instead of the desktop .rail-collapsed.
    if (window.innerWidth <= 768) {
      document.body.classList.toggle('rail-mobile-open');
      return;
    }
    const next = !document.body.classList.contains('rail-collapsed');
    applyCollapsed(next);
    try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch (e) {}
  });

  // --- theme proxy in sidebar foot ---
  const themeProxy = document.getElementById('v98ThemeProxy');
  if (themeProxy) themeProxy.addEventListener('click', () => {
    if (typeof cycleTheme === 'function') cycleTheme();
    try {
      const cur = localStorage.getItem('dow-theme-v1') || 'dark';
      const lbl = document.getElementById('v98ThemeLabel');
      if (lbl) lbl.textContent = cur.charAt(0).toUpperCase() + cur.slice(1);
    } catch (e) { /* ignore */ }
  });
})();

document.addEventListener('DOMContentLoaded', function () {
  setTimeout(function () {
    if (document.getElementById('tab-dashboard') && document.getElementById('tab-dashboard').classList.contains('active')) {
      try { renderMissionControl(); } catch (e) { console.warn('[mc]', e); }
    }
  }, 200);
});

// ---------------------------------------------------------------

(function v108Mobile() {
  function isMobile() { return window.innerWidth <= 768; }
  function close() { document.body.classList.remove('rail-mobile-open'); }
  // Auto-close when any rail link is clicked while mobile.
  document.querySelectorAll('.v98-rail-link[data-v98-tab]').forEach(function (el) {
    el.addEventListener('click', function () { if (isMobile()) close(); });
  });
  // Backdrop click (anywhere outside the sidebar + toggle) closes.
  document.addEventListener('click', function (e) {
    if (!isMobile()) return;
    if (!document.body.classList.contains('rail-mobile-open')) return;
    const sb = document.getElementById('v98Sidebar');
    const tg = document.getElementById('v98RailToggle');
    if (sb && sb.contains(e.target)) return;
    if (tg && tg.contains(e.target)) return;
    close();
  });
  // Esc closes.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && document.body.classList.contains('rail-mobile-open')) close();
  });
  // Resize past breakpoint clears the mobile-only class.
  window.addEventListener('resize', function () {
    if (!isMobile()) close();
  });
})();

(function v102Search() {
  function init() {
    const inp = document.getElementById('v98Search');
    const box = document.getElementById('v98SearchResults');
    if (!inp || !box) { setTimeout(init, 100); return; }
    let timer = null;
    let lastResults = [];
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function perform(qRaw) {
      const q = (qRaw || '').trim().toLowerCase();
      if (!q || q.length < 2) {
        box.hidden = true; box.innerHTML = ''; lastResults = []; return;
      }
      if (!window.DB || !DB.state) return;
      const out = [];
      (DB.list('solicitations') || []).forEach(s => {
        if (out.length >= 24) return;
        if (String(s.title || '').toLowerCase().includes(q)) {
          out.push({ kind: 'Sol', label: s.title || '(untitled)', _v: s.title || '', go: function () { window._v98GoToSol(s.title || ''); } });
        }
      });
      (DB.list('offices') || []).forEach(o => {
        if (out.length >= 24) return;
        if (String(o.name || '').toLowerCase().includes(q)) {
          out.push({ kind: 'Org', label: o.name || o.id, go: function () { window._v98GoToOrg(o.name || ''); } });
        }
      });
      (DB.list('contacts') || []).forEach(c => {
        if (out.length >= 24) return;
        const name = ((c.firstName || '') + ' ' + (c.lastName || '')).trim();
        if (!name) return;
        if (name.toLowerCase().includes(q) || String(c.callsign || '').toLowerCase().includes(q)) {
          out.push({ kind: 'Contact', label: name + (c.callsign ? ' \u00B7 ' + c.callsign : ''), go: function () {
            activateTab('contacts');
            setTimeout(function () {
              const cs = document.getElementById('contactsSearch');
              if (cs) { cs.value = name; cs.dispatchEvent(new Event('input')); }
            }, 30);
          } });
        }
      });
      (DB.list('letters') || []).forEach(l => {
        if (out.length >= 24) return;
        const txt = (l.subject || l.title || '').toLowerCase();
        if (txt && txt.includes(q)) {
          out.push({ kind: 'Support', label: l.subject || l.title || '(letter)', go: function () { activateTab('letters'); } });
        }
      });
      (DB.list('washops') || []).forEach(w => {
        if (out.length >= 24) return;
        if (String(w.summary || '').toLowerCase().includes(q)) {
          out.push({ kind: 'Hill Ops', label: w.summary, go: function () { window._v98GoToHill(w.summary); } });
        }
      });
      (DB.list('budget_pes') || []).forEach(p => {
        if (out.length >= 24) return;
        if (String(p.title || '').toLowerCase().includes(q) || String(p.id || '').toLowerCase().includes(q)) {
          out.push({ kind: 'PE', label: (p.id ? p.id + ' \u00B7 ' : '') + (p.title || ''), go: function () { activateTab('budget', { budgetPe: p.id }); } });
        }
      });
      lastResults = out.slice(0, 12);
      if (!lastResults.length) {
        box.innerHTML = '<div class="v98-search-empty">No matches.</div>';
      } else {
        box.innerHTML = lastResults.map(function (r, i) {
          return '<div class="v98-search-item" data-idx="' + i + '">'
            + '<span class="v98-search-kind">' + esc(r.kind) + '</span>'
            + '<span class="v98-search-name">' + esc(r.label) + '</span>'
            + '</div>';
        }).join('');
        box.querySelectorAll('.v98-search-item').forEach(function (el) {
          el.addEventListener('mousedown', function (e) {
            e.preventDefault();
            const idx = parseInt(el.dataset.idx, 10);
            const r = lastResults[idx];
            if (r && typeof r.go === 'function') r.go();
            box.hidden = true;
            inp.value = '';
          });
        });
      }
      box.hidden = false;
    }
    inp.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { perform(inp.value); }, 120);
    });
    inp.addEventListener('focus', function () {
      if ((inp.value || '').trim().length >= 2) box.hidden = false;
    });
    inp.addEventListener('blur', function () {
      setTimeout(function () { box.hidden = true; }, 150);
    });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { inp.value = ''; box.hidden = true; box.innerHTML = ''; }
      else if (e.key === 'Enter' && lastResults.length) {
        e.preventDefault();
        const r = lastResults[0];
        if (r && typeof r.go === 'function') r.go();
        inp.value = ''; box.hidden = true;
      }
    });
  }
  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();

// Keyboard shortcuts 1-7 to switch tabs
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (document.getElementById('modalBackdrop').classList.contains('open')) return;
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= 9) { activateTab(TABS[n-1]); e.preventDefault(); }
});

// KPI tiles → jump to tab, with per-KPI pre-filter (v49)
document.querySelectorAll('.kpi[data-kpi-jump], .mc-kpi[data-kpi-jump]').forEach(t => {
  t.addEventListener('click', () => {
    const opts = {};
    const valEl = t.querySelector('.kpi-value, .mc-kpi-value');
    const kpiKey = valEl ? valEl.dataset.kpi : '';
    if (kpiKey === 'priority')   opts.priorityOnly   = true;
    if (kpiKey === 'champions')  opts.championsOnly  = true;
    if (kpiKey === 'contracts')  opts.wonOnly        = true;
    activateTab(t.dataset.kpiJump, opts);
  });
});

// =================================================================
//
// The chrome module is side-effect only. All four IIFEs are
// anonymous and self-invoking; the keyboard + KPI handlers are
// top-level statements. Nothing outside this module references
// v98WireChrome / v108Mobile / v102Search by name. No exposures.
// =================================================================
