// js/render/kpi-strip.js
//
//   * window._kpiFilters Set        -- active filter set
//   * toggleKpiFilter(key, chip)
//   * applyKpiFilterPass()
//   * counter-tag tooltip IIFE
//   * KPI filter chip wiring (F-NEW-V203-1 mitigated)
//   * currentTableRows(tableId, dataList)
//
// External exposures: toggleKpiFilter, applyKpiFilterPass,
// currentTableRows (plus window._kpiFilters already-global).
//
// Consumed by: dashboard.js (applyKpiFilterPass), contacts.js +
// lets.js + offices.js + sols.js (currentTableRows).

// Dashboard KPI-tag filter state. Active set of tags ('contacts','los','champions','solicitations','contracts').
window._kpiFilters = new Set();
function toggleKpiFilter(key, chip) {
  if (window._kpiFilters.has(key)) {
    window._kpiFilters.delete(key);
    chip.classList.remove('active');
  } else {
    window._kpiFilters.add(key);
    chip.classList.add('active');
  }
  applyFilters();  // pipes through the existing Dashboard filter pass
}

// Hook into applyFilters: also filter dashboard cards by KPI counters.
function applyKpiFilterPass() {
  const active = window._kpiFilters;
  if (!active || active.size === 0) return;
  const byOffice = championsByOffice();
  const counts = (typeof computeOfficeCounts === 'function') ? computeOfficeCounts() : {};
  document.querySelectorAll('.v98-tier-view-wrap .pae-card, .v98-tier-view-wrap .ousw-card').forEach(card => {
    if (card.classList.contains('hidden')) return;
    const officeId = card.dataset.officeId || card.id;
    const oc = counts[officeId] || {};
    const champs = byOffice[officeId] || 0;
    const values = {
      contacts: oc.contacts || 0,
      solicitations: oc.solicitations || 0,
      los: oc.los || 0,
      contracts: oc.contracts || 0,
      champions: champs,
    };
    // OR logic: show if ANY active filter's counter is > 0
    const keep = Array.from(active).some(k => (values[k] || 0) > 0);
    if (!keep) card.classList.add('hidden');
  });
}

(function () {
  const tip = document.createElement('div');
  tip.className = 'kpi-tooltip';
  (document.body || document.documentElement).appendChild(tip);

  let active = null;

  function show(tag) {
    const text = tag.getAttribute('data-tooltip');
    if (!text) return;
    tip.textContent = text;
    const r = tag.getBoundingClientRect();
    tip.style.left = (r.left + r.width / 2) + 'px';
    tip.style.top  = (r.top - 10) + 'px';
    tip.style.transform = 'translate(-50%, -100%)';
    tip.classList.add('visible');
    active = tag;
  }
  function hide() {
    tip.classList.remove('visible');
    active = null;
  }

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('.counter-tag[data-tooltip]');
    if (el && el !== active) show(el);
  }, true);
  document.addEventListener('mouseout', (e) => {
    const el = e.target.closest('.counter-tag[data-tooltip]');
    if (el && !el.contains(e.relatedTarget)) hide();
  }, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
})();

// Wire KPI filter chips. v214 F-NEW-V203-1 mitigation:
// was wrapped in `document.addEventListener('DOMContentLoaded', ...)`,
// which never fires inside a deferred ES module. Now invoked
// directly at module top-level.
document.querySelectorAll('.kpi-filter-chip').forEach(chip => {
  chip.addEventListener('click', () => toggleKpiFilter(chip.dataset.kpiFilter, chip));
});
// Also wire .org-cell clicks to jump to the Orgs tab for that id
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-office-jump]');
  if (!el) return;
  const tab = document.getElementById('tab-offices');
  if (!tab) return;
  if (typeof activateTab === 'function') activateTab('offices');
});

// Helper to get only visible/filtered rows from a crm-table for exports.
function currentTableRows(tableId, dataList) {
  const tbody = document.querySelector('#' + tableId + ' tbody');
  if (!tbody) return dataList;
  const visibleIds = new Set();
  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    if (tr.offsetParent !== null) visibleIds.add(tr.dataset.id);
  });
  return dataList.filter(r => visibleIds.has(r.id));
}



// =================================================================
// =================================================================
window.toggleKpiFilter = toggleKpiFilter;
window.applyKpiFilterPass = applyKpiFilterPass;
window.currentTableRows = currentTableRows;
