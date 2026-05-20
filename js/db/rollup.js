// js/db/rollup.js
//
// Budget-org rollup helpers (v61 Per-Org Budget panel cluster).
// Memoizes the {orgId -> descendants} tree from DB.list('budget_orgs')
// and uses it to compute per-office budget aggregates by summing PE
// request_amounts where pe.owning_org_id is in the office's
// budget_org_id rollup tree.
//
// Originally at file-scope of the inline monolith; lifted to ES
// module in v200. Same classic-script-split pattern as v181-v199.
//
// Pre-extraction audit (v185 pattern). 4 names need window exposure
// (all 4 added in the footer at the bottom of this module):
//   _buildBudgetOrgRollup  -- 2 monolith callers
//   _orgRollupOrgIds       -- 1 monolith caller
//   _orgRollupSet          -- 2 monolith callers
//   computeOrgBudget       -- 2 monolith callers + 1 module caller
//                             (dashboard.js renderDashboard body)
//
// Module-internal only (NOT exposed):
//   _budgetOrgRollupCache / _budgetOrgRollupCacheKey
//                          -- memoization state for
//                             _buildBudgetOrgRollup; never read outside
//
// External file-scope refs the block consumes: NONE. Audit clean.
//
// External function calls: DB.list / DB.get (both via the window
// global). All resolve at runtime; safe under deferred module load.

// ============================================================
// ============================================================
//   _budgetOrgRollup             -> {orgId: [orgId, ...descendants]} cache
//   _orgRollupOrgIds(orgId)      -> array including self + all descendants
//   computeOrgBudget(orgId)      -> { totalReq, peCount, topPes,
//                                     byBa[], byFy{}, rollupSet{} }
//   renderOfficeBudgetPanel(o)   -> populates #panel-budget for the
//                                   slide-out (CTA when untagged)
//   _budgetOrgFilter             -> string orgId or null; consumed by
//                                   renderBudget filter predicate
var _budgetOrgRollupCache = null;
var _budgetOrgRollupCacheKey = null;
function _buildBudgetOrgRollup() {
  var orgs = (DB.list && DB.list('budget_orgs')) || [];
  var key = orgs.length + '|' + (orgs[0] && orgs[0].id || '');
  if (_budgetOrgRollupCacheKey === key) return _budgetOrgRollupCache;
  var childrenOf = {};
  orgs.forEach(function(o){
    var p = o.parent_id || '__root__';
    if (!childrenOf[p]) childrenOf[p] = [];
    childrenOf[p].push(o.id);
  });
  var rollup = {};
  orgs.forEach(function(o){
    var seen = {};
    var stack = [o.id];
    while (stack.length) {
      var cur = stack.pop();
      if (seen[cur]) continue;
      seen[cur] = 1;
      var kids = childrenOf[cur] || [];
      for (var i = 0; i < kids.length; i++) stack.push(kids[i]);
    }
    rollup[o.id] = Object.keys(seen);
  });
  _budgetOrgRollupCache = rollup;
  _budgetOrgRollupCacheKey = key;
  return rollup;
}
function _orgRollupOrgIds(orgId) {
  if (!orgId) return [];
  var rollup = _buildBudgetOrgRollup();
  return rollup[orgId] || [orgId];
}
function _orgRollupSet(orgId) {
  var ids = _orgRollupOrgIds(orgId);
  var s = {};
  for (var i = 0; i < ids.length; i++) s[ids[i]] = 1;
  return s;
}

function computeOrgBudget(officeBudgetOrgId, officeId) {
  // are merged into the matched set (deduped by pe.id). This makes "Claim"
  // actions show up in the budget panel without requiring budget_org rollup.
  // If neither rollup nor pe_office_links yields anything, return null.
  var rollupSet = officeBudgetOrgId ? _orgRollupSet(officeBudgetOrgId) : {};
  var pes = (DB.list && DB.list('budget_pes')) || [];
  var apprs = (DB.list && DB.list('budget_appropriations')) || [];
  var apprById = {}; apprs.forEach(function(a){ apprById[a.id] = a; });
  // Build a set of PE ids manually linked to this office (excludes rollup-source
  // links because those are already covered by rollupSet via owning_org_id).
  var linkedPeIds = {};
  if (officeId) {
    var links = (DB.list && DB.list('pe_office_links')) || [];
    for (var j = 0; j < links.length; j++) {
      var l = links[j];
      if (l && l.office_id === officeId && l.pe_id) linkedPeIds[l.pe_id] = true;
    }
  }
  var matched = [];
  var seen = {};
  for (var i = 0; i < pes.length; i++) {
    var pe = pes[i];
    var inRollup = pe.owning_org_id && rollupSet[pe.owning_org_id];
    var inLinks  = linkedPeIds[pe.id];
    if ((inRollup || inLinks) && !seen[pe.id]) {
      matched.push(pe);
      seen[pe.id] = true;
    }
  }
  if (!officeBudgetOrgId && !matched.length) return null;
  var totalReq = 0;
  var byBa = {};
  var byFy = {};
  matched.forEach(function(pe){
    var amt = Number(pe.request_amount) || 0;
    totalReq += amt;
    var ap = apprById[pe.appropriation_id];
    if (ap) {
      var key = ap.id;
      if (!byBa[key]) byBa[key] = {
        ba: ap.ba, ba_name: ap.ba_name, color: ap.display_color,
        total: 0, count: 0, account: ap.account
      };
      byBa[key].total += amt; byBa[key].count += 1;
    }
    var fy = pe.fiscal_year || '?';
    byFy[fy] = (byFy[fy] || 0) + amt;
  });
  var topPes = matched.slice().sort(function(a,b){
    return (Number(b.request_amount)||0) - (Number(a.request_amount)||0);
  }).slice(0, 5);
  var byBaArr = Object.keys(byBa).map(function(k){ return byBa[k]; })
                      .sort(function(a,b){ return b.total - a.total; });
  return {
    totalReq: totalReq, peCount: matched.length, topPes: topPes,
    byBa: byBaArr, byFy: byFy, rollupSet: rollupSet
  };
}


// =================================================================
// All four are referenced from the monolith body and/or sibling
// modules at runtime; expose unconditionally.
// =================================================================
window._buildBudgetOrgRollup = _buildBudgetOrgRollup;
window._orgRollupOrgIds = _orgRollupOrgIds;
window._orgRollupSet = _orgRollupSet;
window.computeOrgBudget = computeOrgBudget;
