// js/nav/dispatch.js
//
//   * v20 Champions KPI -> Contacts champions-only filter
//   * v22 filter-toggle IIFE (tagPanel / kpiPanel)
//   * v98 tier-view subtab activation
//   * v49 subtab-nav delegated handler (the big switch that routes
//     subtab clicks to the right render function)
//
// All side-effect-only. No window exposures needed.
//
// F-NEW-V203-1 mitigation applied: v20 + v22 originally wrapped in
// DOMContentLoaded; rewritten to direct top-level calls (the v22
// readyState/DCL branching is also dropped).
//
// External refs consumed (all auto-hoisted on window):
//   activateTab, refreshDashboard, refreshCardCounters,
//   renderGraph, renderContacts, renderMap, renderOffices,
//   _v136RenderAdminTab, renderSolKanban, renderSolFunnel,
//   renderHeatMaps, renderSols, renderBudget, renderBudgetSankey,
//   renderBudgetOrgTree, renderBudgetTagOffices

// ---------------------------------------------------------------
// ---------------------------------------------------------------

// Champions KPI card → jump to Contacts tab AND enable Champions-only filter.
// Hook after DOM ready so event ordering is deterministic.
// v217 F-NEW-V203-1: direct call (was DOMContentLoaded wrap).
(function() {
  const champKpi = document.querySelector('.kpi [data-kpi="champions"], .mc-kpi [data-kpi="champions"]');
  if (!champKpi) return;
  const card = champKpi.closest('.kpi');
  if (!card) return;
  card.addEventListener('click', (e) => {
    // Give the user the filter, not just the tab
    if (typeof activateTab === 'function') activateTab('contacts');
    const cb = document.getElementById('contactsChampionOnly');
    if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
  }, true);
})();


// ---------------------------------------------------------------
// ---------------------------------------------------------------
(function initFilterToggleButtons() {
  function wireToggle(btnId, panelId, labelBase) {
    const btn = document.getElementById(btnId);
    const panel = document.getElementById(panelId);
    if (!btn || !panel) return;
    btn.addEventListener('click', () => {
      const willOpen = panel.hasAttribute('hidden');
      if (willOpen) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
      btn.classList.toggle('active', willOpen);
      btn.textContent = (willOpen ? '− ' : '+ ') + labelBase;
    });
  }
  // v217 F-NEW-V203-1: direct call (was readyState/DCL branching).
  wireToggle('btnFilterByTag', 'tagPanel', 'Filter by tag');
  wireToggle('btnFilterByKpi', 'kpiPanel', 'Filter by KPI');
})();

// ==================================================================

document.querySelectorAll('[data-subtab-group="offices"] .subtab-btn[data-subtab="offices-tier"]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    setTimeout(function () {
      try { refreshDashboard(); } catch (e) {}
      try { refreshCardCounters(); } catch (e) {}
    }, 0);
  });
});

// ==================================================================
document.querySelectorAll('.subtab-nav').forEach(function (nav) {
  nav.addEventListener('click', function (e) {
    var btn = e.target.closest('.subtab-btn');
    if (!btn) return;
    var target = btn.dataset.subtab;
    var group = nav.dataset.subtabGroup;
    nav.querySelectorAll('.subtab-btn').forEach(function (b) {
      b.classList.toggle('active', b === btn);
    });
    document.querySelectorAll('.subtab-panel').forEach(function (p) {
      var name = p.dataset.subtabPanel || '';
      if (name.indexOf(group + '-') === 0) {
        p.classList.toggle('active', name === target);
      }
    });
    if (target === 'contacts-graph' && typeof renderGraph === 'function') renderGraph();
    else if (target === 'contacts-list' && typeof renderContacts === 'function') renderContacts();
    else if (target === 'offices-map' && typeof renderMap === 'function') renderMap();
    else if (target === 'offices-list' && typeof renderOffices === 'function') renderOffices();
    else if (target === 'admin' && typeof _v136RenderAdminTab === 'function') {
      setTimeout(function () { _v136RenderAdminTab(); }, 30);
    }
    else if (target === 'sols-kanban' && typeof renderSolKanban === 'function') renderSolKanban();
    else if (target === 'sols-funnel' && typeof renderSolFunnel === 'function') renderSolFunnel();
    else if (target === 'sols-heatmaps' && typeof renderHeatMaps === 'function') renderHeatMaps();
    else if (target === 'sols-list' && typeof renderSols === 'function') renderSols();
    else if (target === 'budget-hierarchy' && typeof renderBudget === 'function') renderBudget();
    else if (target === 'budget-sankey' && typeof renderBudgetSankey === 'function') renderBudgetSankey();
        if (target === 'budget-org-tree' && typeof renderBudgetOrgTree === 'function') renderBudgetOrgTree();
    else if (target === 'budget-tag-offices' && typeof renderBudgetTagOffices === 'function') renderBudgetTagOffices();
  });
});

