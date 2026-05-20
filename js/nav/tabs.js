// js/nav/tabs.js
//
// lines 5989-6132 of post-v225 source. Drains the last logic
// out of classic-script block #2.
//
//   * activateTab now RESETS filters on every call (no more sticky
//     champions/wonOnly/priorityOnly state across drill-throughs).
//   * Filter-bearing KPI drill-throughs force the relevant subtab
//     (Priority Orgs on Tier View routes to List View; Champions
//     anywhere routes to contacts List View; Awards routes to sols
//     List View).
//
// Contents:
//   * HEADER_COLLAPSED_KEY (localStorage key)
//   * Init IIFE reading the stored collapse state
//   * headerCollapseBtn click handler (toggle + persist)
//   * TABS array (canonical tab order, also duplicated in
//     chrome/wire.js since v198 for digit shortcuts)
//   * activateTab(tab, opts) -- the central tab router (~115 LOC)
//   * .tab-btn click handlers + hashchange -> activateTab listener
//
// External refs consumed (via realm-shared GLE / window):
//   refreshDashboard, refreshAll, refreshCardCounters, renderBudget,
//   renderOffices, renderContacts, ... (most exposed on window now)
//   DEMO_MODE                                          (window)
//
// Window exposures: HEADER_COLLAPSED_KEY, headerCollapseBtn, TABS,
// activateTab.

// ---------------------------------------------------------------
//  Header collapse toggle
// ---------------------------------------------------------------
const HEADER_COLLAPSED_KEY = 'dow-header-collapsed-v1';
(function initHeaderCollapse() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(HEADER_COLLAPSED_KEY) === '1'; } catch (e) { /* ignore */ }
  if (collapsed) document.body.classList.add('header-collapsed');
})();
const headerCollapseBtn = document.getElementById('headerCollapseToggle');
if (headerCollapseBtn) {
  headerCollapseBtn.addEventListener('click', () => {
    const next = !document.body.classList.contains('header-collapsed');
    document.body.classList.toggle('header-collapsed', next);
    try { localStorage.setItem(HEADER_COLLAPSED_KEY, next ? '1' : '0'); } catch (e) { /* ignore */ }
  });
}

// ---------------------------------------------------------------
//  Tab routing
// ---------------------------------------------------------------
const TABS = ['dashboard','offices','contacts','solicitations','letters','washops','budget','scout','admin'];
function activateTab(tab, opts) {
  // Redirect Scout requests to dashboard when Scout is not configured
  // (no ANTHROPIC_API_KEY on the deploy). SCOUT_AVAILABLE is populated
  // by _initSupabase from /.netlify/functions/config; until that
  // resolves SCOUT_AVAILABLE is undefined. We strict-compare to false
  // here so a deep-link to #scout before init resolves still routes to
  // Scout (init will hide it a moment later if disabled). Only the
  // confirmed-disabled case redirects, avoiding a spurious bounce-to-
  // dashboard on a working deploy during the boot race window.
  if (tab === 'scout' && window.SCOUT_AVAILABLE === false) tab = 'dashboard';
  if (!TABS.includes(tab)) tab = 'dashboard';
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tabPanel === tab));
  if (location.hash.replace('#','').split('?')[0] !== tab) {
    history.replaceState(null, '', '#' + tab);
  }
  // Refresh current tab's grid (in case data changed)
  switch (tab) {
    case 'offices': {
      renderOffices();
      const _sbo = document.querySelector('[data-subtab-group="offices"] .subtab-btn.active');
      const _subo = _sbo ? _sbo.dataset.subtab : 'offices-list';
      if (_subo === 'offices-map' && typeof renderMap === 'function') renderMap();
      if (_subo === 'offices-tier') {
        try { refreshDashboard(); } catch (e) {}
        try { refreshCardCounters(); } catch (e) {}
      }
      break;
    }
    case 'contacts': {
      renderContacts();
      if (typeof renderGraph === 'function' && document.querySelector('[data-subtab-group="contacts"] .subtab-btn.active[data-subtab="contacts-graph"]')) renderGraph();
      break;
    }
    case 'solicitations': {
      renderSols();
      const _sb = document.querySelector('[data-subtab-group="sols"] .subtab-btn.active');
      const _sub = _sb ? _sb.dataset.subtab : 'sols-list';
      if (_sub === 'sols-kanban') renderSolKanban();
      else if (_sub === 'sols-funnel') renderSolFunnel();
      else if (_sub === 'sols-heatmaps' && typeof renderHeatMaps === 'function') renderHeatMaps();
      break;
    }
    case 'letters':       renderLets(); break;
    case 'washops': {
      renderWos();
      // only to physical tab-button clicks, so programmatic
      // activateTab('washops') calls (e.g. _v98GoToHill from Mission
      // Control) landed on the default-active "Loading..." Summary
      // subtab with nothing populated until the user manually clicked
      // a different subtab and came back.
      try { if (typeof renderHillSummary === 'function') renderHillSummary(); } catch (e) { console.warn('[hill:summary]', e); }
      try { if (typeof renderHillMembers === 'function') renderHillMembers(); } catch (e) { console.warn('[hill:members]', e); }
      try { if (typeof renderHillCommittees === 'function') renderHillCommittees(); } catch (e) { console.warn('[hill:cmts]', e); }
      // drawer right after the tab is shown. Threaded through from MC.
      if (opts && opts.hillBioguide) {
        setTimeout(function () {
          try {
            if (typeof window.openHillMemberDrawer === 'function') {
              window.openHillMemberDrawer(opts.hillBioguide);
            }
          } catch (e) { console.warn('[hill:drawer]', e); }
        }, 60);
      }
      break;
    }
    case 'budget': {
      if (opts && opts.budgetPe) {
        _budgetOrgFilter = null;
        var _qInp = document.getElementById('budgetSearch');
        if (_qInp) { _qInp.value = String(opts.budgetPe); }
        var _hb = document.querySelector('[data-subtab-group="budget"] .subtab-btn[data-subtab="budget-hierarchy"]');
        if (_hb && !_hb.classList.contains('active')) _hb.click();
      } else if (opts && opts.budgetOrg) {
        _budgetOrgFilter = opts.budgetOrg;
        var _qInp2 = document.getElementById('budgetSearch'); if (_qInp2) _qInp2.value = '';
        var _hb2 = document.querySelector('[data-subtab-group="budget"] .subtab-btn[data-subtab="budget-hierarchy"]');
        if (_hb2 && !_hb2.classList.contains('active')) _hb2.click();
      } else if (opts && opts.budgetOfficeView) {
        if (opts.budgetOfficeView.officeId) _bovSelectedOfficeId = opts.budgetOfficeView.officeId;
        _bovTargetSagId = opts.budgetOfficeView.sagId || null;
        if (opts.budgetOfficeView.priorityOnly === true) {
          _bovPriorityOnly = true;
          _bovSelectedOfficeId = opts.budgetOfficeView.officeId || null;
          var _cb = document.getElementById('bovPriorityOnly');
          if (_cb) _cb.checked = true;
        } else if (opts.budgetOfficeView.priorityOnly === false) {
          _bovPriorityOnly = false;
          var _cb2 = document.getElementById('bovPriorityOnly');
          if (_cb2) _cb2.checked = false;
        }
        var _bovBtn = document.querySelector('[data-subtab-group="budget"] .subtab-btn[data-subtab="budget-office-view"]');
        if (_bovBtn && !_bovBtn.classList.contains('active')) _bovBtn.click();
      }
      renderBudget();
      try { renderBudgetOfficeView(); } catch (e) { console.warn('[bov] render failed', e); }
      break;
    }
    case 'graph':         renderGraph(); break;
    case 'dashboard': {
      if (typeof renderMissionControl === 'function') {
        try { renderMissionControl(); } catch (e) { console.warn('[mc]', e); }
      }
      // KPI counters keep ticking for the rail badges and the v97 KPI
      // strip (now living inside Orgs > Tier View).
      try { refreshDashboard(); } catch (e) {}
      try { refreshCardCounters(); } catch (e) {}
      break;
    }
  }
  // Optional: apply filter from opts (e.g. pre-filter by office id)
  if (opts && opts.officeId) {
    const officeFilter = document.getElementById(
      ({ contacts:'contactsOfficeFilter', solicitations:'solOfficeFilter',
         letters:'letOfficeFilter', washops:'woOfficeFilter',
         requests:'reqOfficeFilter' })[tab]
    );
    if (officeFilter) {
      // filter listeners (contacts.js / sols.js / lets.js) wire 'input'
      // on <select> elements but 'change' on checkboxes. Dispatching only
      // 'change' previously left the table unfiltered on drill-in.
      officeFilter.value = opts.officeId;
      officeFilter.dispatchEvent(new Event('input', { bubbles: true }));
      officeFilter.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  // ------------------------------------------------------------------
  //
  // Every activateTab call ESTABLISHES the target tab's filter state.
  // If opts.X is present and truthy, the filter is ON. If absent, the
  // filter is RESET to its default (off/empty). Previously these
  // blocks only set filters when opts asked for them and never reset,
  // causing sticky state across drill-throughs (a champions-filtered
  // contacts page would stay champions-filtered when the user later
  // clicked the contacts sidebar nav with no filter intent).
  //
  // For KPI tiles that route the user to a tab they're already on
  // (e.g. the Tier View KPI banner's "PRIORITY ORGS" tile inside the
  // Orgs tab routes to offices+priorityOnly), the filtered drill-
  // through ALSO forces the list-view subtab so the filter is visible.
  // Without this the filter was applied to the list checkbox but the
  // user stayed on Tier View and saw no effect.
  // ------------------------------------------------------------------
  function _applyFilter(el, want) {
    if (!el) return;
    if (el.type === 'checkbox') {
      const next = !!want;
      if (el.checked !== next) {
        el.checked = next;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else {
      const next = (want === undefined || want === null || want === false) ? '' : String(want);
      if (el.value !== next) {
        el.value = next;
        // listeners wire 'input' on <select>, some wire 'change' too.
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }
  function _forceSubtab(group, subtab) {
    const btn = document.querySelector('[data-subtab-group="' + group + '"] .subtab-btn[data-subtab="' + subtab + '"]');
    if (btn && !btn.classList.contains('active')) btn.click();
  }

  if (tab === 'offices') {
    _applyFilter(document.getElementById('officesPriorityOnly'),
                     opts && opts.priorityOnly);
    if (opts && opts.priorityOnly) {
      // Tier View KPI banner -> the Priority Orgs filter lives on
      // List View; force the user there so the filter is visible.
      _forceSubtab('offices', 'offices-list');
    }
  }
  if (tab === 'contacts') {
    _applyFilter(document.getElementById('contactsChampionOnly'),
                     opts && opts.championsOnly);
    if (opts && opts.championsOnly) {
      _forceSubtab('contacts', 'contacts-list');
    }
  }
  if (tab === 'solicitations') {
    _applyFilter(document.getElementById('solStatusFilter'),
                     (opts && opts.wonOnly) ? 'Won' : '');
    if (opts && opts.wonOnly) {
      _forceSubtab('sols', 'sols-list');
    }
  }
}
document.querySelectorAll('.tab-btn').forEach(b => {
  b.addEventListener('click', () => activateTab(b.dataset.tab));
});
window.addEventListener('hashchange', () => activateTab(location.hash.replace('#','')));

// ============================================================
// Window exposures -- activateTab is the central tab router; bare
// classic-script onclick="" handlers and module callers resolve to
// these.
// ============================================================
window.HEADER_COLLAPSED_KEY = HEADER_COLLAPSED_KEY;
window.headerCollapseBtn = headerCollapseBtn;
window.TABS = TABS;
window.activateTab = activateTab;
