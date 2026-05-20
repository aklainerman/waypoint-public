// js/render/filter-rail.js
//
// loaded data, renders service + appropriation multi-select checkboxes on
// the left rail, persists state in window._v46FilterState, kicks
// renderBudget() on change.
//
// Originally an inline IIFE at the bottom of index.html; lifted to an
// ES module in v180.
//
// Exposes on window for cross-module callers (consumed by the still-inline
// monolith until its extraction completes):
//   window._v46ServiceLabel  — canonical service-name mapper
//   window._v46ApprFacet     — canonical appropriation-facet bucketing
//   window._v46FilterState   — active filter set {services, apprs}
//   window._v46RebuildRail   — re-render the rail (called after DB.load)
//
// Consumes from window:
//   DB                            — global DB object from the monolith
//   renderBudget()                — global render fn from the monolith
//   window._v46ToplineSvcLabel    — optional alternate service mapper (defined elsewhere)

var SERVICE_LABELS = ['Defense Wide', 'Air Force', 'Army', 'Navy'];
// Mirror the canonical mapping from renderBudget so left-rail counts match exactly.
function svcLabel(raw){
  if (!raw) return 'Defense Wide';
  var u = String(raw).trim().toUpperCase();
  if (u === 'AF' || u === 'AIR FORCE' || u === 'USAF') return 'Air Force';
  if (u === 'AIR FORCE RESERVE' || u === 'AFRC') return 'Air Force';
  if (u === 'AIR NATIONAL GUARD' || u === 'ANG') return 'Air Force';
  if (u === 'ARMY' || u === 'DA') return 'Army';
  if (u === 'ARMY RESERVE' || u === 'USAR') return 'Army';
  if (u === 'ARMY NATIONAL GUARD' || u === 'ARNG') return 'Army';
  if (u === 'NAVY' || u === 'USN') return 'Navy';
  if (u === 'NAVY RESERVE' || u === 'USNR') return 'Navy';
  if (u === 'MC' || u === 'USMC' || u === 'MARINES' || u === 'MARINE CORPS') return 'Navy';
  if (u === 'MARINE CORPS RESERVE' || u === 'USMCR') return 'Navy';
  if (u === 'SF' || u === 'USSF' || u === 'SPACE' || u === 'SPACE FORCE') return 'Air Force';
  if (u === 'DW' || u === 'DEFENSE' || u === 'DEFENSE-WIDE' || u === 'DEFENSE WIDE') return 'Defense Wide';
  return 'Defense Wide';
}
window._v46ServiceLabel = svcLabel;
// Appropriation facet keys + labels.  v46.2: added DHP + DrugInterdiction
// facets so budget_topline_lines surface in the rail.
var APPR_FACETS = [
  ['rdte', 'RDT&E'],
  ['proc', 'Procurement'],
  ['om', 'O&M'],
  ['milpers', 'MilPers'],
  ['milcon', 'MilCon'],
  ['fh', 'Family Housing'],
  ['brac', 'BRAC'],
  ['cem', 'Cemeterial'],
  ['dhp', 'Defense Health'],
  ['drug', 'Drug Interdiction'],
  ['dpa', 'DPA'],
  ['dsccp', 'DSCCP'],
  ['revmgmt', 'Revolving Funds'],
  ['other', 'Other'],
];
// budget_topline_lines uses the canonical short codes from budget_appropriations
// (mpa, mca, fha, brac, etc.). CTEF folds into O&M (security cooperation
// funding is O&M-style by character), even though it has its own MILPERS-tier
// bucket in the topline.
var TOPLINE_APPR_FACET = {
  // MILPERS
  mpa:'milpers', mpaf:'milpers', mpn:'milpers', mpsf:'milpers', mpmc:'milpers',
  ngpa:'milpers', ngpaf:'milpers', rpa:'milpers', rpaf:'milpers', rpn:'milpers', rpmc:'milpers',
  // MILCON
  mca:'milcon', mcar:'milcon', mcng:'milcon', mcaf:'milcon', mcafr:'milcon', mcang:'milcon',
  mcn:'milcon', mcnr:'milcon', mcdw:'milcon', nato:'milcon',
  // Family Housing
  fha:'fh', fhaf:'fh', fhdw:'fh', fhif:'fh', fhn:'fh', muhif:'fh',
  // BRAC
  brac:'brac', braca:'brac', bracn:'brac',
  // Cemeterial
  cea:'cem',
  // CTEF -> O&M
  ctef:'om',
  // DHP / Drug Interdiction (own facets)
  dhp:'dhp',
  drug:'drug',
  // Revolving / Management Funds
  rmgmt:'revmgmt',
};
function apprFacet(apprId){
  if (!apprId) return null;  // v46.2: NULL means "skip in count" (bug fix #1)
  var lower = String(apprId).toLowerCase();
  // Bare-ID lookup first (topline rows)
  if (TOPLINE_APPR_FACET[lower]) return TOPLINE_APPR_FACET[lower];
  // Then prefix matchers (PE / SAG)
  if (/^rdte_/.test(lower)) return 'rdte';
  if (/^proc_/.test(lower)) return 'proc';
  if (/^om_/.test(lower))   return 'om';
  if (/^milpers_/.test(lower)) return 'milpers';
  if (/^milcon_/.test(lower))  return 'milcon';
  if (/^fh_/.test(lower))   return 'fh';
  if (/^brac_/.test(lower)) return 'brac';
  if (/^cem(et)?_/.test(lower)) return 'cem';
  if (/^dpa_/.test(lower))  return 'dpa';
  if (/^dsccp_/.test(lower)) return 'dsccp';
  if (/^revmgmt_/.test(lower)) return 'revmgmt';
  return 'other';
}
window._v46ApprFacet = apprFacet;  // expose so renderBudget shares the same logic
window._v46FilterState = window._v46FilterState || {
  services: new Set(),  // empty = no filter
  apprs: new Set(),
};
function escapeHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
    return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
  });
}
function rebuild(){
  var rail = document.getElementById('budgetFilterRail');
  if (!rail) return;
  var svcEl = document.getElementById('budgetRailServices');
  var aprEl = document.getElementById('budgetRailApprs');
  if (!svcEl || !aprEl) return;
  if (typeof DB === 'undefined' || !DB.list) {
    svcEl.innerHTML = '<em style="color:var(--text-muted);font-size:11px;">Loading…</em>';
    return;
  }
  // Service counts: count PEs grouped by canonical service label.
  var pes = DB.list('budget_pes') || [];
  var orgs = DB.list('budget_orgs') || [];
  var apprs = DB.list('budget_appropriations') || [];
  var orgById = {}; orgs.forEach(function(o){ orgById[o.id] = o; });
  var apprById = {}; apprs.forEach(function(a){ apprById[a.id] = a; });
  var svcCounts = {};
  SERVICE_LABELS.forEach(function(s){ svcCounts[s] = 0; });
  pes.forEach(function(pe){
    var ap = apprById[pe.appropriation_id]; if (!ap) return;
    var oo = orgById[pe.owning_org_id];
    var svcRaw = (oo && oo.service) || (ap && ap.title) || '';
    var lab = svcLabel(svcRaw);
    svcCounts[lab] = (svcCounts[lab] || 0) + 1;
  });
  var sags = (DB.list && DB.list('budget_om_sags')) || [];
  sags.forEach(function(s){
    var ap = apprById[s.appropriation_id]; if (!ap) return;  // skip NULL/unknown apprs
    var oo = orgById[s.owning_org_id];
    var svcRaw = (oo && oo.service) || (ap && ap.title) || '';
    var lab = svcLabel(svcRaw);
    svcCounts[lab] = (svcCounts[lab] || 0) + 1;
  });
  // contribute to the rail counts too so the visible facets match what the
  // tree actually renders. Skip ReconciliationOnly (per v121 convention) and
  // NULL appropriation balancing rows.
  var topline = (DB.list && DB.list('budget_topline_lines')) || [];
  topline.forEach(function(row){
    if (!row || !row.appropriation_id) return;
    if (row.account_type === 'ReconciliationOnly') return;
    var lab = (window._v46ToplineSvcLabel ? window._v46ToplineSvcLabel(row.service) : svcLabel(row.service));
    svcCounts[lab] = (svcCounts[lab] || 0) + 1;
  });
  // Render service checkboxes
  svcEl.innerHTML = SERVICE_LABELS.map(function(lab){
    var checked = window._v46FilterState.services.has(lab);
    var n = svcCounts[lab] || 0;
    return '<label><input type="checkbox" data-v46-rail-svc="' + escapeHtml(lab) + '"' + (checked ? ' checked' : '') + '><span>' + escapeHtml(lab) + '</span><span class="v46-rail-count">' + n + '</span></label>';
  }).join('');
  // Appropriation counts.  v46.2: skip NULL appropriation_id (bug fix #1 —
  // those rows aren't rendered in the tree either) and include topline_lines.
  var aprCounts = {};
  APPR_FACETS.forEach(function(p){ aprCounts[p[0]] = 0; });
  pes.forEach(function(pe){
    var k = apprFacet(pe.appropriation_id);
    if (k) aprCounts[k] = (aprCounts[k] || 0) + 1;
  });
  sags.forEach(function(s){
    var k = apprFacet(s.appropriation_id);
    if (k) aprCounts[k] = (aprCounts[k] || 0) + 1;
  });
  topline.forEach(function(row){
    if (!row || !row.appropriation_id) return;
    if (row.account_type === 'ReconciliationOnly') return;
    var k = apprFacet(row.appropriation_id);
    if (k) aprCounts[k] = (aprCounts[k] || 0) + 1;
  });
  aprEl.innerHTML = APPR_FACETS.map(function(p){
    var checked = window._v46FilterState.apprs.has(p[0]);
    var n = aprCounts[p[0]] || 0;
    return '<label><input type="checkbox" data-v46-rail-apr="' + escapeHtml(p[0]) + '"' + (checked ? ' checked' : '') + '><span>' + escapeHtml(p[1]) + '</span><span class="v46-rail-count">' + n + '</span></label>';
  }).join('');
}
// Delegated handlers
document.addEventListener('change', function(ev){
  var t = ev.target;
  if (!t) return;
  var svcKey = t.getAttribute && t.getAttribute('data-v46-rail-svc');
  var aprKey = t.getAttribute && t.getAttribute('data-v46-rail-apr');
  if (svcKey) {
    if (t.checked) window._v46FilterState.services.add(svcKey);
    else window._v46FilterState.services.delete(svcKey);
    if (typeof renderBudget === 'function') renderBudget();
  } else if (aprKey) {
    if (t.checked) window._v46FilterState.apprs.add(aprKey);
    else window._v46FilterState.apprs.delete(aprKey);
    if (typeof renderBudget === 'function') renderBudget();
  } else if (t.id === 'budgetTerminatedFilter') {
    if (typeof renderBudget === 'function') renderBudget();
  }
});
document.addEventListener('click', function(ev){
  var t = ev.target;
  if (t && t.id === 'budgetRailClear') {
    window._v46FilterState.services.clear();
    window._v46FilterState.apprs.clear();
    var tf = document.getElementById('budgetTerminatedFilter');
    if (tf) tf.value = 'active';
    rebuild();
    if (typeof renderBudget === 'function') renderBudget();
  }
});
// Re-build the rail whenever DB.load completes (or on first DOMContentLoaded).
// — initial DB.list() returns [] before async load completes, which produced the
// "0 0 0" facet bug on first paint. Cap at 80 retries (20 s) to avoid infinite loop.
function tryBuild(attempt){
  attempt = attempt || 0;
  if (typeof DB === 'undefined' || !DB.list) { setTimeout(function(){ tryBuild(attempt+1); }, 250); return; }
  var pes = DB.list('budget_pes') || [];
  var apprs = DB.list('budget_appropriations') || [];
  if ((pes.length === 0 || apprs.length === 0) && attempt < 80) {
    setTimeout(function(){ tryBuild(attempt+1); }, 250);
    return;
  }
  rebuild();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function(){ tryBuild(); });
} else {
  tryBuild();
}
window._v46RebuildRail = rebuild;
