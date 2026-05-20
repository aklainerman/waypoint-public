// js/render/budget-tree.js
//
// function in the monolith (~1,088 lines / ~52 KB). Renders the
// Service > Account > BA > SAG/PE hierarchical tree under the Budget
// tab, with org filter, search, term filter, narrative search, and
// expand/collapse state.
//
// Originally at file-scope of the inline monolith; lifted to ES
// module in v204. Same classic-script-split pattern as v181-v203.
//
// State vars and helpers consumed (NOT extracted; remain in classic
// script and reach this module via window-scope lookup):
//   _budgetOrgFilter, _budgetExpanded, _budgetForceExpand  (var)
//   _budgetEnsureExpandedDefaults                          (function)
//   _budgetExpanded is a Set; this module mutates it through
//   .add/.delete/.has calls, which work because both sides hold a
//   reference to the same Set instance. _budgetOrgFilter and
//   _budgetForceExpand are reassigned scalars, so the module
//   writes to them via window.X = ... (strict-mode bare writes
//   would otherwise throw ReferenceError).
//
// Pre-extraction audit (v185 pattern).
//   * renderBudget has 19 external callers across index.html + 5
//     sibling modules. Exposure: window.renderBudget = renderBudget.
//   * The v153 narrative-fill wrapper at index.html:~26579 polls
//     window.renderBudget and replaces it with a wrapped function.
//     To preserve behavior, all 5 self-recursive calls inside the
//     function body have been rewritten to window.renderBudget()
//     so they flow through the wrapper.
//
// External function calls (resolved at call time via window lookup,
// not module-load time):
//   DB, escAttr, escHtml, fmtBudget, svcFromAppr, _serviceLabel,
//   _serviceLabelGlobal, _orgRollupOrgIds, budgetOrgBreadcrumb,
//   _budgetEnsureExpandedDefaults, _renderPeOfficePicker,
//   _v131FormatJBookNarrative, openBudgetItemPanel, openDetailPanel,
//   activateTab, fillNarrativePlaceholders, getOfficesForPe,
//   getOfficesForSag, getSuggestionsForPe, togglePePriority,
//   toggleSagPriority, linkPeToOffice, unlinkPeFromOffice,
//   dismissPeOfficeSuggestion, plus window._v46* / _v147Y /
//   _v148NarrChanged / _v150SagAmt / _v151SagDedupAmt /
//   _linkedPriorityOffices.

function renderBudget() {
  var wrap = document.getElementById('budgetHierarchyWrap');
  if (!wrap) return;

  // Order: (1) normalize 'Aircraft/Missile/Other/Weapons Procurement, X' to
  // 'Procurement of <X>, BRANCH'; (2) split CamelCase; (3) insert space after
  // commas; (4) collapse whitespace.
  function labelPretty(s){
    if (s == null) return '';
    var t = String(s);
    // (1) Procurement-form normalization — three explicit named cases plus generic.
    //     The data only has Aircraft / Missile / Other / Weapons in this
    //     position, so a closed match list is safer than a wildcard rule.
    t = t.replace(/^Aircraft Procurement,\s*(.+)$/, 'Procurement of Aircraft, $1');
    t = t.replace(/^Missile Procurement,\s*(.+)$/,  'Procurement of Missiles, $1');
    t = t.replace(/^Other Procurement,\s*(.+)$/,    'Procurement of Other, $1');
    t = t.replace(/^Weapons Procurement,\s*(.+)$/,  'Procurement of Weapons, $1');
    // (2) CamelCase split.
    t = t.replace(/([a-z])([A-Z])/g, '$1 $2');
    // (3) comma + non-space → comma + space.
    t = t.replace(/,([^\s])/g, ', $1');
    return t.replace(/\s+/g, ' ').trim();
  }
  var pes = DB.list('budget_pes') || [];
  var apprs = DB.list('budget_appropriations') || [];
  var orgs = DB.list('budget_orgs') || [];
  var apprById = {}; apprs.forEach(function(a){ apprById[a.id] = a; });
  var orgById = {}; orgs.forEach(function(o){ orgById[o.id] = o; });

  // Populate filter dropdowns (idempotent).
  var svcSel = document.getElementById('budgetServiceFilter');
  if (svcSel && svcSel.options.length <= 1) {
    var svcs = Array.from(new Set(orgs.map(function(o){ return o.service; }).filter(Boolean))).sort();
    svcs.forEach(function(s){
      var opt = document.createElement('option'); opt.value = s; opt.textContent = s;
      svcSel.appendChild(opt);
    });
  }
  var baSel = document.getElementById('budgetBaFilter');
  if (baSel && baSel.options.length <= 1) {
    var bas = Array.from(new Set(apprs.map(function(a){ return a.ba; }).filter(Boolean))).sort();
    bas.forEach(function(b){
      var opt = document.createElement('option'); opt.value = b; opt.textContent = 'BA ' + b;
      baSel.appendChild(opt);
    });
  }

  var qEl = document.getElementById('budgetSearch');
  var q = (qEl && qEl.value || '').toLowerCase();
  // a hidden fallback for older code paths and keyboard power-users.
  var _svc = (window._v46FilterState && window._v46FilterState.services) || null;  // Set or null
  var _apr = (window._v46FilterState && window._v46FilterState.apprs)    || null;  // Set or null
  var svcF = (svcSel && svcSel.value) || '';
  var baF  = (baSel && baSel.value) || '';
  var _termSel = document.getElementById('budgetTerminatedFilter');
  var _term = (_termSel && _termSel.value) || 'active';
  // Returns Set of PE/SAG/proc IDs whose mission_description matches q.
  var _narrHits = (window._v46NarrSearch && q && q.length >= 2)
    ? window._v46NarrSearch(q)
    : null;
  window._budgetForceExpand = !!q;

  var _orgFilterSet = null;
  if (_budgetOrgFilter) {
    var _ids = _orgRollupOrgIds(_budgetOrgFilter);
    _orgFilterSet = {};
    for (var _i = 0; _i < _ids.length; _i++) _orgFilterSet[_ids[_i]] = 1;
  }
  // Filter PEs (per-row predicate). v46: extends q-match to mission text via
  // _narrHits, adds left-rail multi-select for services/apprs, and adds
  // the 3-way terminated dropdown.
  function _isTerminated(pe){
    // Active: FY27 amount > 0. Terminated: FY27 = 0/null AND FY26 enacted > 0.
    var fy27 = Number(pe.request_amount) || 0;
    var fy26 = Number(pe.enacted_amount) || 0;
    return fy27 <= 0 && fy26 > 0;
  }
  function _passesTerm(pe){
    if (_term === 'all') return true;
    var term = _isTerminated(pe);
    if (_term === 'terminated') return term;
    return !term;  // 'active'
  }
  function _passesAppr(apprId){
    if (_apr && _apr.size > 0) {
      // map appropriation_id prefix -> facet key
      var key = /^rdte_/i.test(apprId) ? 'rdte'
              : /^proc_/i.test(apprId) ? 'proc'
              : /^om_/i.test(apprId)   ? 'om'
              : /^milpers_/i.test(apprId) ? 'milpers'
              : /^milcon_/i.test(apprId) ? 'milcon'
              : /^fh_/i.test(apprId)   ? 'fh'
              : /^brac_/i.test(apprId) ? 'brac'
              : /^cem(et)?_/i.test(apprId) ? 'cem'
              : /^dpa_/i.test(apprId)  ? 'dpa'
              : /^dsccp_/i.test(apprId) ? 'dsccp'
              : /^revmgmt_/i.test(apprId) ? 'revmgmt'
              : 'other';
      if (!_apr.has(key)) return false;
    }
    return true;
  }
  function _passesSvc(pe, ap){
    // (matches tree-build; owning_org.service no longer leaks).
    if (!_svc || _svc.size === 0) return true;
    var acct = (ap && ap.account) || '';
    var m = acct.match(/,\s*(.+)$/);
    var svcRaw = m ? m[1].trim() : (ap && ap.title) || '';
    var svcLab = (typeof _serviceLabelGlobal === 'function') ? _serviceLabelGlobal(svcRaw)
                : ((window._v46ServiceLabel && window._v46ServiceLabel(svcRaw)) || svcRaw);
    return _svc.has(svcLab);
  }
  var rows = pes.filter(function(pe){
    var ap = apprById[pe.appropriation_id]; if (!ap) return false;
    if (baF && ap.ba !== baF) return false;
    if (svcF) {
      var _svcF_acct = (ap && ap.account) || '';
      var _svcF_m = _svcF_acct.match(/,\s*(.+)$/);
      var _svcF_raw = _svcF_m ? _svcF_m[1].trim() : (ap && ap.title) || '';
      var _svcF_lab = (window._v46ServiceLabel && window._v46ServiceLabel(_svcF_raw)) || _svcF_raw;
      if (_svcF_lab !== svcF) return false;
    }
    if (!_passesSvc(pe, ap)) return false;
    if (!_passesAppr(pe.appropriation_id)) return false;
    if (!_passesTerm(pe)) return false;
    if (_orgFilterSet) {
      if (!pe.owning_org_id || !_orgFilterSet[pe.owning_org_id]) return false;
    }
    if (q) {
      // v47b P2: AND-tokenize over (id + title + cached pe.description for FY27).
      // pe.description on RDT&E PEs holds the FY27 narrative; we consult it
      // directly so search hits even before the bulk narrative index is ready.
      var hay = ((pe.id||'') + ' ' + (pe.title||'') + ' ' + (pe.description||'')).toLowerCase();
      var tokens = window._v46NarrTokens ? window._v46NarrTokens(q) : [q];
      var ok = true;
      for (var ti = 0; ti < tokens.length; ti++) {
        if (hay.indexOf(tokens[ti]) === -1) { ok = false; break; }
      }
      if (!ok && _narrHits) ok = _narrHits.has(pe.id);
      if (!ok) return false;
    }
    return true;
  });

  var apprFSel = document.getElementById('budgetApprFilter');
  var apprF = (apprFSel && apprFSel.value) || '';
  function _passesApprFilter(apprId) {
    if (!apprF) return true;
    if (apprF === 'rdte') return /^rdte_/i.test(apprId || '');
    if (apprF === 'proc') return /^proc_/i.test(apprId || '');
    if (apprF === 'om')   return /^om_/i.test(apprId || '');
    return true;
  }

  // Re-filter PE rows by the appropriation filter (the earlier rows[] filter
  // was service/BA/search; appropriation filter applies to all item types
  // uniformly here).
  rows = rows.filter(function(pe){ return _passesApprFilter(pe.appropriation_id); });

  // the rows[] flat list). Drives off budget_pes.is_priority for PEs;
  // for SAGs (injected below) we re-filter after injection.
  var _prioOnlyEl = document.getElementById('budgetPriorityOnly');
  var _prioOnly = !!(_prioOnlyEl && _prioOnlyEl.checked);
  if (_prioOnly) rows = rows.filter(function(pe){ return !!pe.is_priority; });

  // objects. Field mapping: id <- sag_short_code, title <- sag_title,
  // request_amount <- fy26_estimate, enacted_amount <- fy25_current,
  // prior_year_amount <- fy24_enacted. _isSag flag suppresses the PE-detail
  // expansion downstream.
  var sagsRaw = (DB.list && DB.list('budget_om_sags')) || [];
  // Reads the same apprById built earlier in this function. See the
  // _v151SagDedupAmt helper for the algorithm; mirrors harness exactly.
  var _sagDedup = (window._v151SagDedupAmt && apprById)
    ? window._v151SagDedupAmt(sagsRaw, (window._budgetYear || 2026), apprById)
    : null;
  sagsRaw.forEach(function(sag){
    if (!sag || !sag.appropriation_id) return;
    var ap = apprById[sag.appropriation_id];
    if (!ap) return;
    if (!_passesApprFilter(sag.appropriation_id)) return;
    if (baF && ap.ba !== baF) return;
    // now flows through the normal svcF check below via owning_org_id + svcFromAppr,
    // so we no longer hard-code DefWide-only.
    if (!_passesAppr(sag.appropriation_id)) return;
    var _sagOO = orgById[sag.owning_org_id];
    var _sagSvcRaw = (_sagOO && _sagOO.service) || (ap && ap.title) || '';
    var _sagSvcLab = (window._v46ServiceLabel ? window._v46ServiceLabel(_sagSvcRaw) : _sagSvcRaw);
    if (_svc && _svc.size > 0 && !_svc.has(_sagSvcLab)) return;
    // Terminated check on the SAG amount itself
    var _sagFy27 = (Number(sag.fy27_estimate) || 0) + (Number(sag.fy27_mandatory_amount) || 0);
    var _sagFy26 = Number(sag.fy26_estimate) || 0;
    var _sagTerm = _sagFy27 <= 0 && _sagFy26 > 0;
    if (_term === 'terminated' && !_sagTerm) return;
    if (_term === 'active' && _sagTerm) return;
    if (q) {
      // v47b P2: AND-tokenize over (id + sag_short_code + title + defense_wide_org + description)
      var hay = ((sag.sag_short_code||'') + ' ' + (sag.sag_title||'')
        + ' ' + (sag.defense_wide_org||'') + ' ' + (sag.id||'')
        + ' ' + (sag.description||'')).toLowerCase();
      var tokens = window._v46NarrTokens ? window._v46NarrTokens(q) : [q];
      var sagHit = true;
      for (var sti = 0; sti < tokens.length; sti++) {
        if (hay.indexOf(tokens[sti]) === -1) { sagHit = false; break; }
      }
      if (!sagHit && _narrHits) sagHit = _narrHits.has(sag.id);
      if (!sagHit) return;
    }
    rows.push({
      id: sag.sag_short_code || sag.id,
      title: sag.sag_title || sag.id,
      appropriation_id: sag.appropriation_id,
      // uses budget_orgs.service first (army_ng -> Army, sf -> Space Force, etc.).
      owning_org_id: sag.owning_org_id || null,
      // so tree.total stops double-counting umbrella+sib pairs.
      request_amount: (_sagDedup
                       ? (_sagDedup.get(sag.id) || 0)
                       : (window._v150SagAmt ? window._v150SagAmt(sag) : (Number(sag.fy26_estimate) || 0))),
      enacted_amount: Number(sag.fy25_current) || 0,
      prior_year_amount: Number(sag.fy24_enacted) || 0,
      _isSag: true,
      _sagId: sag.id,
      _sagOrg: sag.defense_wide_org || '',
      // so the same prio-only filter that gates PEs can gate SAGs.
      is_priority: !!sag.is_priority
    });
  });
  // run it again here against the SAG entries.
  if (_prioOnly) rows = rows.filter(function(pe){ return !!pe.is_priority; });

  // ---------------------------------------------------------------------
  // Cemeterial / CTEF / DHP / Drug Interdiction / Revolving Mgmt) as
  // non-drillable synthetic rows. Mirrors v121's Sankey injection pattern;
  // builds rows that render in the tree under their service+account_type.
  // ---------------------------------------------------------------------
  function _toplineSvc(svc) {
    if (svc === 'Army') return 'Army';
    if (svc === 'Navy' || svc === 'MarineCorps') return 'Navy';
    if (svc === 'AirForce' || svc === 'SpaceForce') return 'Air Force';
    return 'Defense Wide';
  }
  // Expose for the rail so service counts use the same mapping.
  window._v46ToplineSvcLabel = _toplineSvc;
  var _toplineRowsRaw = (DB.list && DB.list('budget_topline_lines')) || [];
  _toplineRowsRaw.forEach(function(row){
    if (!row || !row.appropriation_id) return;
    if (row.account_type === 'ReconciliationOnly') return;  // balancing rows, skip
    var ap = apprById[row.appropriation_id];
    if (!ap) return;
    if (!_passesApprFilter(row.appropriation_id)) return;
    if (baF && ap.ba !== baF) return;
    var fy26 = Number(row.fy26_total) || 0;
    var fy27 = Number(row.fy27_total) || 0;
    if (fy26 === 0 && fy27 === 0) return;  // no value, no row
    if (q) {
      // v47b P2: AND-tokenize over (id + title + account_type + service + appr + narrative)
      var hay = ((row.id||'') + ' ' + (row.title||'') + ' ' + (row.account_type||'')
              + ' ' + (row.service||'') + ' ' + (row.appropriation_id||'')
              + ' ' + (row.narrative||'')).toLowerCase();
      var tokens = window._v46NarrTokens ? window._v46NarrTokens(q) : [q];
      var hit = true;
      for (var tti = 0; tti < tokens.length; tti++) {
        if (hay.indexOf(tokens[tti]) === -1) { hit = false; break; }
      }
      if (!hit && _narrHits) hit = _narrHits.has(row.id);
      if (!hit) return;
    }
    var svcLab = _toplineSvc(row.service);
    if (_svc && _svc.size > 0 && !_svc.has(svcLab)) return;
    if (_apr && _apr.size > 0) {
      var k = (window._v46ApprFacet ? window._v46ApprFacet(row.appropriation_id) : null);
      if (!k || !_apr.has(k)) return;
    }
    // 3-way terminated filter
    var term = (fy27 <= 0 && fy26 > 0);
    if (_term === 'terminated' && !term) return;
    if (_term === 'active' && term) return;
    var compSuffix = (row.component && row.component !== 'NA' && row.component !== 'Total')
      ? ' (' + row.component + ')' : '';
    var noteSuffix = (row.notes && String(row.notes).indexOf('Medicare') >= 0) ? ' \u2014 Medicare' : '';
    var baSuffix = (row.ba && row.ba !== 'NA') ? (' [' + row.ba + ']') : '';
    rows.push({
      id: row.id,
      title: (row.title || row.id) + compSuffix + noteSuffix + baSuffix,
      appropriation_id: row.appropriation_id,
      owning_org_id: null,  // topline rows have no owning_org
      request_amount: fy27,
      enacted_amount: fy26,
      prior_year_amount: Number(row.fy25_enacted) || 0,
      _isTopline: true,
      _toplineId: row.id,
      _toplineAccountType: row.account_type || '',
      _toplineComponent: row.component || '',
      _toplineService: row.service || '',
      _toplineNarrative: row.narrative || '',
      _toplineSourcePdf: row.source_pdf || '',
      _toplineSourcePageStart: row.source_page_start || null,
      _toplineSourcePageEnd: row.source_page_end || null,
      _toplineBa: row.ba || '',
      _toplineSvcOverride: svcLab,  // bypass owning_org resolution (no org)
      is_priority: !!row.is_priority
    });
  });
  // priority by default but the schema supports it).
  if (_prioOnly) rows = rows.filter(function(pe){ return !!pe.is_priority; });

  // a priority office in the Orgs tab (offices.priority = true). Build a
  // set of priority office IDs once, then look up each row's tagged offices
  // through the existing pe_office_links / sag_office_links tables.
  var _prioOrgEl   = document.getElementById('budgetPriorityOrgOnly');
  var _prioOrgOnly = !!(_prioOrgEl && _prioOrgEl.checked);
  var _prioOfficeIds = {};
  ((DB.list && DB.list('offices')) || []).forEach(function(o){
    if (o && o.id && o.priority) _prioOfficeIds[o.id] = 1;
  });
  // Pre-index PE / SAG -> linked office IDs (excluding dismissed links).
  var _peDismiss = {}, _sagDismiss = {};
  ((DB.list && DB.list('pe_office_link_dismissals')) || []).forEach(function(d){
    if (d && d.pe_id && d.office_id) (_peDismiss[d.pe_id] = _peDismiss[d.pe_id] || {})[d.office_id] = 1;
  });
  ((DB.list && DB.list('sag_office_link_dismissals')) || []).forEach(function(d){
    if (d && d.sag_id && d.office_id) (_sagDismiss[d.sag_id] = _sagDismiss[d.sag_id] || {})[d.office_id] = 1;
  });
  var _peOffices  = {};  // pe_id  -> [office_id, ...]
  var _sagOffices = {};  // sag_id -> [office_id, ...]
  ((DB.list && DB.list('pe_office_links')) || []).forEach(function(l){
    if (!l || !l.pe_id || !l.office_id) return;
    if (_peDismiss[l.pe_id] && _peDismiss[l.pe_id][l.office_id]) return;
    (_peOffices[l.pe_id] = _peOffices[l.pe_id] || []).push(l.office_id);
  });
  ((DB.list && DB.list('sag_office_links')) || []).forEach(function(l){
    if (!l || !l.sag_id || !l.office_id) return;
    if (_sagDismiss[l.sag_id] && _sagDismiss[l.sag_id][l.office_id]) return;
    (_sagOffices[l.sag_id] = _sagOffices[l.sag_id] || []).push(l.office_id);
  });
  function _linkedPriorityOffices(pe) {
    var ids = pe._isSag ? (_sagOffices[pe._sagId] || []) : (_peOffices[pe.id] || []);
    var hits = [];
    for (var i = 0; i < ids.length; i++) {
      if (_prioOfficeIds[ids[i]]) hits.push(ids[i]);
    }
    return hits;
  }
  if (_prioOrgOnly) {
    rows = rows.filter(function(pe){ return _linkedPriorityOffices(pe).length > 0; });
  }

  // Build tree:  service -> account -> ba(appropriation) -> [PEs + SAGs]
  var tree = { children: {}, total: 0, count: 0 };
  var SERVICE_ORDER = ['Defense Wide', 'Air Force', 'Army', 'Navy'];
  function _serviceLabel(raw) {
    if (!raw) return 'Defense Wide';
    var u = String(raw).trim().toUpperCase();
    if (u === 'AF' || u === 'AIR FORCE' || u === 'USAF') return 'Air Force';
    if (u === 'AIR FORCE RESERVE' || u === 'AFRC')       return 'Air Force';
    if (u === 'AIR NATIONAL GUARD' || u === 'ANG')       return 'Air Force';
    if (u === 'ARMY' || u === 'DA')                      return 'Army';
    if (u === 'ARMY RESERVE' || u === 'USAR')            return 'Army';
    if (u === 'ARMY NATIONAL GUARD' || u === 'ARNG')     return 'Army';
    if (u === 'NAVY' || u === 'USN')                     return 'Navy';
    if (u === 'NAVY RESERVE' || u === 'USNR')            return 'Navy';
    if (u === 'MC' || u === 'USMC' || u === 'MARINES' || u === 'MARINE CORPS') return 'Navy';
    if (u === 'MARINE CORPS RESERVE' || u === 'USMCR')   return 'Navy';
    if (u === 'SF' || u === 'USSF' || u === 'SPACE' || u === 'SPACE FORCE')    return 'Air Force';
    if (u === 'DW' || u === 'DEFENSE' || u === 'DEFENSE-WIDE' || u === 'DEFENSE WIDE') return 'Defense Wide';
    return 'Defense Wide';
  }
  function svcFromAppr(ap) {
    // "Marine Corps Reserve", "Air National Guard".
    var acct = (ap && ap.account) || '';
    var m = acct.match(/,\s*(.+)$/);
    if (m) return m[1].trim();
    var au = acct.toUpperCase();
    if (au.indexOf('AIR FORCE') === 0) return 'Air Force';
    if (au.indexOf('ARMY') === 0)      return 'Army';
    if (au.indexOf('NAVY') === 0)      return 'Navy';
    if (au.indexOf('MARINE') === 0)    return 'Marine Corps';
    return (ap && ap.title) || '';
  }
  rows.forEach(function(pe){
    var ap = apprById[pe.appropriation_id]; if (!ap) return;
    var svcKey;
    if (pe._isTopline && pe._toplineSvcOverride) {
      svcKey = pe._toplineSvcOverride;
    } else {
      var oo = orgById[pe.owning_org_id];
      // owning_org.service is a separate lens and must NOT shape the tree.
      svcKey = _serviceLabel(svcFromAppr(ap));
    }
    // (e.g. "MILPERS, Army") not the appr.account ("Military Personnel, Army").
    // Account_type is shorter and recognizable; appr.title is too verbose.
    var acctKey;
    if (pe._isTopline && pe._toplineAccountType) {
      acctKey = pe._toplineAccountType;
    } else {
      acctKey = ap.account || '?';
    }
    var baKey = ap.id;
    var amt = Number(pe.request_amount) || 0;

    var svc = tree.children[svcKey] || (tree.children[svcKey] = { label: svcKey, children: {}, total: 0, count: 0 });
    var acct = svc.children[acctKey] || (svc.children[acctKey] = { label: acctKey, children: {}, total: 0, count: 0 });
    var ba = acct.children[baKey] || (acct.children[baKey] = { label: 'BA ' + ap.ba + ' \u00b7 ' + ap.ba_name, ba: ap.ba, color: ap.display_color, account: ap.account, items: [], total: 0, count: 0 });
    ba.items.push(pe);
    ba.total += amt; ba.count += 1;
    acct.total += amt; acct.count += 1;
    svc.total += amt; svc.count += 1;
    tree.total += amt; tree.count += 1;
  });

  var _pillEl = document.getElementById('budgetOrgFilterPill');
  if (_pillEl) {
    if (_budgetOrgFilter) {
      var _bc = (typeof budgetOrgBreadcrumb === 'function') ? budgetOrgBreadcrumb(_budgetOrgFilter, { maxLen: 80 }) : _budgetOrgFilter;
      _pillEl.style.display = '';
      _pillEl.innerHTML =
        '<div style="margin:10px 12px 0 12px;padding:8px 12px;background:rgba(76,175,80,0.10);border:1px solid rgba(76,175,80,0.35);border-radius:6px;display:flex;align-items:center;gap:8px;font-size:12px;">' +
          '<strong style="color:var(--text);">Filtered to org:</strong> ' +
          '<span style="color:var(--text-muted);">' + escHtml(_bc) + '</span>' +
          '<span style="flex:1;"></span>' +
          '<a data-budget-pill-clear="1" style="cursor:pointer;color:var(--accent);text-decoration:underline;">Clear filter</a>' +
        '</div>';
      var _clr = _pillEl.querySelector('[data-budget-pill-clear]');
      if (_clr) {
        _clr.addEventListener('click', function(e){
          e.preventDefault();
          window._budgetOrgFilter = null;
          window.renderBudget();
        });
      }
    } else {
      _pillEl.style.display = 'none';
      _pillEl.innerHTML = '';
    }
  }
  _budgetEnsureExpandedDefaults(tree);

  var countEl = document.getElementById('budgetCount');
  if (countEl) {
    // 'X PEs · N O&M Lines · K Other Appr · $Y FY27 total'. tree.total ALREADY
    // includes topline rows (they were pushed into rows[] above), so the prior
    // 'tree.total + _toplineTotal' logic double-counted to the tune of ~$264B
    // FY27. We just emit tree.total directly.
    var _peCount = 0, _sagCount = 0, _toplineCount = 0;
    rows.forEach(function(r){
      if (!r) return;
      if (r._isSag) _sagCount++;
      else if (r._isTopline) _toplineCount++;
      else _peCount++;
    });
    var parts = [];
    parts.push(_peCount + ' PE' + (_peCount===1?'':'s'));
    if (_sagCount > 0)     parts.push(_sagCount + ' O&M Line' + (_sagCount===1?'':'s'));
    if (_toplineCount > 0) parts.push(_toplineCount + ' Other Appr');
    parts.push(fmtBudget(tree.total) + ' FY27 total');
    countEl.textContent = parts.join(' \u00b7 ');
  }

  function chev(open) {
    return '<span class="budget-chev" style="display:inline-block;width:14px;text-align:center;color:var(--text-muted);transition:transform 0.15s ease;transform:rotate(' + (open ? '90' : '0') + 'deg);">\u25b6</span>';
  }
  function chip(color, ba) {
    return '<span class="budget-chip" title="BA ' + escHtml(ba) + '" style="display:inline-flex;align-items:center;justify-content:center;min-width:34px;padding:1px 6px;border-radius:10px;font-size:10.5px;font-weight:600;color:#fff;background:' + (color || 'var(--text-muted)') + ';letter-spacing:0.2px;">' + escHtml(ba) + '</span>';
  }

  var html = [];
  if (!tree.count) {
    html.push('<div class="hm-empty-note" style="margin:24px 12px;padding:16px;background:var(--surface-2);border:1px dashed var(--border);border-radius:6px;color:var(--text-muted);">');
    if (!pes.length) {
      html.push('<strong>No budget data loaded yet.</strong><br>Run <code>Supabase/v53-additive.sql</code> then load <code>Supabase/v53-seed-af-rdte-fy26.sql</code> to seed PEs.');
    } else {
      html.push('No PEs match the current filters.');
    }
    html.push('</div>');
    wrap.innerHTML = html.join('');
  } else {
    html.push('<div class="budget-tree" style="margin:14px 12px;border:1px solid var(--border);border-radius:6px;overflow:hidden;background:var(--surface-1);">');

    var svcKeys = Object.keys(tree.children).sort(function(a, b){
      var ai = SERVICE_ORDER.indexOf(a), bi = SERVICE_ORDER.indexOf(b);
      if (ai < 0 && bi < 0) return a.localeCompare(b);
      if (ai < 0) return 1;
      if (bi < 0) return -1;
      return ai - bi;
    });
    svcKeys.forEach(function(svcKey){
      var svc = tree.children[svcKey];
      var svcPath = 'svc:' + svcKey;
      var svcOpen = _budgetForceExpand || _budgetExpanded.has(svcPath);
      html.push('<div class="budget-node budget-node-svc" data-bpath="' + escHtml(svcPath) + '" data-bdepth="0" style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--surface-2);border-bottom:1px solid var(--border);cursor:pointer;user-select:none;">');
      html.push(chev(svcOpen));
      html.push('<strong style="font-size:13.5px;">' + escHtml(labelPretty(svc.label)) + '</strong>');
      html.push('<span style="margin-left:auto;font-size:12px;color:var(--text-muted);">' + svc.count + ' PEs \u00b7 <strong style="color:var(--text);">' + fmtBudget(svc.total) + '</strong></span>');
      html.push('</div>');

      if (!svcOpen) return;

      // so order matches what's rendered.
      var acctKeys = Object.keys(svc.children).sort(function(a, b){
        var la = labelPretty(svc.children[a].label || a);
        var lb = labelPretty(svc.children[b].label || b);
        return la.localeCompare(lb);
      });
      acctKeys.forEach(function(acctKey){
        var acct = svc.children[acctKey];
        var acctPath = svcPath + '|acct:' + acctKey;
        var acctOpen = _budgetForceExpand || _budgetExpanded.has(acctPath);
        html.push('<div class="budget-node budget-node-acct" data-bpath="' + escHtml(acctPath) + '" data-bdepth="1" style="display:flex;align-items:center;gap:10px;padding:8px 14px 8px 30px;background:var(--surface-1);border-bottom:1px solid var(--border);cursor:pointer;user-select:none;">');
        html.push(chev(acctOpen));
        html.push('<strong style="font-size:12.5px;color:var(--text);">' + escHtml(labelPretty(acct.label)) + '</strong>');
        html.push('<span style="font-size:11px;color:var(--text-muted);">Account</span>');
        html.push('<span style="margin-left:auto;font-size:12px;color:var(--text-muted);">' + acct.count + ' PEs \u00b7 <strong style="color:var(--text);">' + fmtBudget(acct.total) + '</strong></span>');
        html.push('</div>');

        if (!acctOpen) return;

        var baKeys = Object.keys(acct.children).sort(function(a,b){
          var ba_a = (acct.children[a].ba || '');
          var ba_b = (acct.children[b].ba || '');
          return ba_a.localeCompare(ba_b);
        });
        baKeys.forEach(function(baKey){
          var ba = acct.children[baKey];
          var baPath = acctPath + '|ba:' + baKey;
          var baOpen = _budgetForceExpand || _budgetExpanded.has(baPath);
          // e.g. MILCON / DHP / FH topline rows), skip the 'BA null · null' tier
          // entirely and render PEs directly under the Account.
          var _baNull = (ba.ba == null || ba.ba === '' || String(ba.ba).toLowerCase() === 'null')
                         && (!ba.label || /BA\s+null\s*\u00b7\s*null/i.test(ba.label) || /^BA\s+(null|undefined)/i.test(ba.label));
          if (!_baNull) {
            html.push('<div class="budget-node budget-node-ba" data-bpath="' + escHtml(baPath) + '" data-bdepth="2" style="display:flex;align-items:center;gap:10px;padding:8px 14px 8px 46px;background:var(--surface-1);border-bottom:1px solid var(--border);cursor:pointer;user-select:none;">');
            html.push(chev(baOpen));
            html.push(chip(ba.color, ba.ba));
            html.push('<strong style="font-size:12px;">' + escHtml(labelPretty(ba.label)) + '</strong>');
            html.push('<span style="margin-left:auto;font-size:12px;color:var(--text-muted);">' + ba.count + ' PEs \u00b7 <strong style="color:var(--text);">' + fmtBudget(ba.total) + '</strong></span>');
            html.push('</div>');
          } else {
            // null BA tier — always render its PE list
            baOpen = true;
          }

          if (!baOpen) return;

          var items = ba.items.slice().sort(function(a,b){ return (Number(b.request_amount)||0) - (Number(a.request_amount)||0); });
          html.push('<div class="budget-pe-list" style="background:var(--surface);">');
          html.push('<table class="crm-table" style="margin:0;table-layout:fixed;width:100%;"><colgroup>'
            + '<col style="width:60px;"><col style="width:36px;"><col style="width:130px;"><col><col style="width:120px;"><col style="width:120px;"><col style="width:110px;"></colgroup>'
            + '<thead><tr>'
            + '<th></th>'
            + '<th title="Priority">★</th>'
            + '<th>ID</th>'
            + '<th>Title</th>'
            + '<th style="text-align:right;">FY26</th>'
            + '<th style="text-align:right;">FY27</th>'
            + '<th style="text-align:right;">Δ FY26→27</th>'
            + '</tr></thead><tbody>');
          items.forEach(function(pe){
            var pePath = baPath + '|pe:' + pe.id;
            var peOpen = _budgetExpanded.has(pePath);
            // (PE or SAG branch chosen by _isSag). Chevron cell still toggles inline
            // expansion. Title/amount cells open the budget item side panel.
            var _isPrio = !!pe.is_priority;
            var _starHtml = '<a class="budget-prio-star" data-bprio-' + (pe._isSag ? 'sag' : 'pe') + '="' + escHtml(pe._isSag ? (pe._sagId || pe.id) : pe.id) + '" title="' + (_isPrio ? 'Unmark priority' : 'Mark priority') + '" style="cursor:pointer;color:' + (_isPrio ? 'var(--priority)' : 'var(--text-muted)') + ';font-size:14px;line-height:1;text-decoration:none;">' + (_isPrio ? '★' : '☆') + '</a>';
            // beside the title; independent of pe.is_priority so a row can be
            // priority-line OR priority-org-tagged OR both.
            var _prioOrgIds = _linkedPriorityOffices(pe);
            var _prioOrgHtml = _prioOrgIds.length
              ? ' <span class="v97-pe-prio-org" title="Tagged to ' + _prioOrgIds.length
                + ' priority org' + (_prioOrgIds.length===1?'':'s') + '" style="color:var(--priority);font-size:12px;">\u2605</span>'
              : '';
            // the funding line -> org connection is visible without expanding.
            // Chip rendering is gated to non-SAG rows (SAGs have a separate
            // panel and don't use pe_office_links).
            var _orgChips = '';
            if (!pe._isSag && typeof getOfficesForPe === 'function') {
              try {
                var _assigned = getOfficesForPe(pe.id) || [];
                if (_assigned.length) {
                  // Reuses the existing data-pe-jump-office delegated handler
                  // in renderBudget so we don't duplicate navigation logic.
                  _orgChips = '<div class="v131-pe-orgs" style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px;">'
                    + _assigned.slice(0, 6).map(function (a) {
                        return '<a class="v131-pe-org-chip" data-pe-jump-office="' + escAttr(a.office_id) + '" '
                          + 'title="Tagged: ' + escAttr(a.officeName) + ' (' + escAttr(a.link_type) + ') — click to open org" '
                          + 'style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;font-size:10.5px;background:var(--surface-alt);border:1px solid var(--border);border-radius:10px;color:var(--text);text-decoration:none;cursor:pointer;">'
                          + '<span>' + escHtml(a.officeName) + '</span>'
                          + '<span style="color:var(--text-muted);font-size:9px;">\u2192</span>'
                          + '</a>';
                      }).join('')
                    + (_assigned.length > 6 ? '<span style="font-size:10px;color:var(--text-muted);align-self:center;">+' + (_assigned.length - 6) + ' more</span>' : '')
                    + '</div>';
                }
              } catch (e) { /* silent — fall through to no chips */ }
            }
            // budget_pes RPC for year=2027 returns request_amount=FY27, enacted_amount=FY26.
            // For SAG synth rows we computed both at injection time.
            var _fy26v, _fy27v;
            if (pe._isSag) {
              var _sagRec = (typeof DB !== 'undefined' && DB.get) ? DB.get('budget_om_sags', pe._sagId || '') : null;
              _fy26v = _sagRec ? Number(_sagRec.fy26_estimate) || 0 : 0;
              _fy27v = pe.request_amount || 0;  // already disc+mand for FY27 via _sagDedup
            } else {
              _fy27v = Number(pe.request_amount) || 0;
              _fy26v = Number(pe.enacted_amount) || 0;
            }
            var _delta = _fy27v - _fy26v;
            var _deltaPct, _deltaLabel, _deltaArrow, _deltaColor;
            if (_fy26v === 0 && _fy27v === 0) {
              _deltaLabel = '—'; _deltaArrow = ''; _deltaColor = 'var(--text-dim)';
            } else if (_fy26v === 0) {
              _deltaLabel = 'NEW'; _deltaArrow = '▲'; _deltaColor = '#1a7f37';
            } else if (_fy27v === 0) {
              _deltaLabel = 'TERM'; _deltaArrow = '▼'; _deltaColor = '#cf222e';
            } else {
              _deltaPct = (_delta / _fy26v) * 100;
              _deltaLabel = (_deltaPct > 0 ? '+' : '') + _deltaPct.toFixed(1) + '%';
              _deltaArrow = _delta >= 0 ? '▲' : '▼';
              _deltaColor = _delta >= 0 ? '#1a7f37' : '#cf222e';
            }
            var _yoyHtml = '<span style="color:' + _deltaColor + ';font-weight:600;">' + _deltaArrow + ' ' + escHtml(_deltaLabel) + '</span>';
            html.push('<tr class="budget-pe-row" data-bpath="' + escHtml(pePath) + '" data-pe-id="' + escHtml(pe.id) + '" data-is-sag="' + (pe._isSag ? '1' : '0') + '"' + (pe._isSag && pe._sagId ? ' data-sag-id="' + escHtml(pe._sagId) + '"' : '') + (_prioOrgIds.length ? ' data-v97-prio-org="1"' : '') + ' style="cursor:pointer;">'
              + '<td class="bpe-chev-cell" style="padding-left:46px;">' + chev(peOpen) + '</td>'
              + '<td class="bpe-prio-cell" style="text-align:center;">' + _starHtml + '</td>'
              + '<td class="bpe-panel-cell"><code>' + escHtml(pe.id) + '</code></td>'
              + '<td class="bpe-panel-cell">' + escHtml(pe.title || '') + _prioOrgHtml + _orgChips + (window._v148NarrChanged && window._v148NarrChanged(pe.id) === true ? ' <span title="Narrative changed FY26 to FY27" style="display:inline-block;font-size:9.5px;padding:1px 5px;background:var(--accent);color:#fff;border-radius:3px;letter-spacing:.04em;vertical-align:1px;margin-left:4px;font-weight:600;">Δ NARR</span>' : '') + '</td>'
              + '<td class="bpe-panel-cell" style="text-align:right;color:var(--text-muted);">' + fmtBudget(_fy26v) + '</td>'
              + '<td class="bpe-panel-cell" style="text-align:right;"><strong>' + fmtBudget(_fy27v) + '</strong></td>'
              + '<td class="bpe-panel-cell" style="text-align:right;">' + _yoyHtml + '</td>'
              + '</tr>');
            if (peOpen) {
              if (pe._isTopline) {
                // PE-level structure (no projects, no office tagging, no FYDP).
                var tlNarr = pe._toplineNarrative || '';
                var tlSrc  = pe._toplineSourcePdf || '';
                var tlPg   = pe._toplineSourcePageStart || null;
                var tlPgE  = pe._toplineSourcePageEnd || null;
                var detailHtml = '<tr class="budget-pe-detail"><td colspan="7" style="background:var(--surface-2);padding:14px 24px 14px 60px;border-top:1px solid var(--border);">'
                  + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;font-size:12px;">'
                  + '<div><div style="color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Topline Line</div><code>' + escHtml(pe.id) + '</code></div>'
                  + '<div><div style="color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Account Type</div>' + escHtml(pe._toplineAccountType || '\u2014') + '</div>'
                  + '<div><div style="color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Component</div>' + escHtml(pe._toplineComponent || '\u2014') + '</div>'
                  + '<div><div style="color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Service</div>' + escHtml(pe._toplineService || '\u2014') + '</div>'
                  + '<div><div style="color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Appropriation</div><code>' + escHtml(pe.appropriation_id || '') + '</code></div>'
                  + (pe._toplineBa && pe._toplineBa !== 'NA' ? '<div><div style="color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">BA</div>' + escHtml(pe._toplineBa) + '</div>' : '')
                  + '</div>'
                  // Funding row
                  + '<div style="margin-top:14px;padding:10px 12px;background:var(--surface);border:1px solid var(--border);border-radius:6px;">'
                  + '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-muted);margin-bottom:6px;">Funding</div>'
                  + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;font-size:12px;">'
                  + '<div><div style="color:var(--text-muted);font-size:10px;">FY26 Total</div><strong>' + fmtBudget(pe.enacted_amount) + '</strong></div>'
                  + '<div><div style="color:var(--text-muted);font-size:10px;">FY27 Total</div><strong>' + fmtBudget(pe.request_amount) + '</strong></div>'
                  + (pe.prior_year_amount ? '<div><div style="color:var(--text-muted);font-size:10px;">FY25 Enacted</div><strong>' + fmtBudget(pe.prior_year_amount) + '</strong></div>' : '')
                  + '</div></div>';
                if (tlNarr) {
                  detailHtml += '<div style="margin-top:14px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:6px;">'
                    + '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-muted);margin-bottom:8px;">Description</div>'
                    + '<div style="font-size:12.5px;line-height:1.6;color:var(--text);white-space:pre-wrap;">' + escHtml(tlNarr) + '</div>'
                    + '</div>';
                }
                if (tlSrc) {
                  var pgStr = tlPg != null ? (' \u00b7 p.' + tlPg + (tlPgE && tlPgE !== tlPg ? '\u2013' + tlPgE : '')) : '';
                  detailHtml += '<div style="margin-top:10px;font-size:10.5px;color:var(--text-muted);" data-narr-source="' + escAttr(pe.id) + '">'
                    + 'Source: <code style="font-size:10.5px;">' + escHtml(tlSrc) + '</code>' + escHtml(pgStr)
                    + '</div>';
                }
                detailHtml += '</td></tr>';
                html.push(detailHtml);
              } else if (pe._isSag) {
                // -------------------------------------------------------------
                // Mirror the PE dropdown structure with SAG-appropriate fields,
                // and inject an async narrative placeholder that fillNarrativePlaceholders()
                // populates from get_om_sag_narrative.
                // -------------------------------------------------------------
                var sagFullId = pe._sagId || pe.id;
                var sagRec = (typeof DB !== 'undefined' && DB.get) ? DB.get('budget_om_sags', sagFullId) : null;
                var sagOO = sagRec ? orgById[sagRec.owning_org_id] : null;
                var sagDwOrg = sagRec ? sagRec.defense_wide_org : null;
                var sagBA = sagRec ? sagRec.budget_activity : null;
                var sagAppr = sagRec ? sagRec.appropriation_id : pe.appropriation_id;
                var sagFy = sagRec ? sagRec.fiscal_year : null;
                var fy27Est = sagRec ? Number(sagRec.fy27_estimate) || 0 : 0;
                var fy27Mand = sagRec ? Number(sagRec.fy27_mandatory_amount) || 0 : 0;
                var fy26Est = sagRec ? Number(sagRec.fy26_estimate) || 0 : 0;
                var srcPdf = sagRec ? (sagRec.fy27_source_pdf || sagRec.source_pdf || '') : '';
                var detailHtml = '<tr class="budget-pe-detail"><td colspan="7" style="background:var(--surface-2);padding:14px 24px 14px 60px;border-top:1px solid var(--border);">'
                  + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;font-size:12px;">'
                  + '<div><div style="color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">SAG</div><code>' + escHtml(sagFullId) + '</code></div>'
                  + '<div><div style="color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Short Code</div><code>' + escHtml(pe.id) + '</code></div>'
                  + '<div><div style="color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Appropriation</div>' + escHtml(sagAppr || '') + '</div>'
                  + '<div><div style="color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Budget Activity</div>' + escHtml(sagBA || '\u2014') + '</div>'
                  + '<div><div style="color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Owning Org</div>' + (sagOO ? escHtml(sagOO.name || sagOO.id) : '<span style="color:var(--text-muted);">Unmapped</span>') + (sagDwOrg ? ' <span style="color:var(--accent);font-size:10px;font-weight:600;">[' + escHtml(sagDwOrg) + ']</span>' : '') + '</div>'
                  + '<div><div style="color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Fiscal Year</div>' + escHtml(String(sagFy || '\u2014')) + '</div>'
                  + '</div>';
                // Per-year amounts
                detailHtml += '<div style="margin-top:14px;padding:10px 12px;background:var(--surface);border:1px solid var(--border);border-radius:6px;">'
                  + '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-muted);margin-bottom:6px;">Funding</div>'
                  + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;font-size:12px;">'
                  + '<div><div style="color:var(--text-muted);font-size:10px;">FY27 Estimate</div><strong>' + fmtBudget(fy27Est) + '</strong></div>'
                  + '<div><div style="color:var(--text-muted);font-size:10px;">FY27 Mandatory</div><strong>' + fmtBudget(fy27Mand) + '</strong></div>'
                  + '<div><div style="color:var(--text-muted);font-size:10px;">FY27 Total</div><strong>' + fmtBudget(fy27Est + fy27Mand) + '</strong></div>'
                  + '<div><div style="color:var(--text-muted);font-size:10px;">FY26 Estimate</div><strong>' + fmtBudget(fy26Est) + '</strong></div>'
                  + '</div></div>';
                var _sagDY = (window._v46DrawerYearFor ? window._v46DrawerYearFor(sagFullId) : 2027);
                detailHtml += '<div style="margin-top:14px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:6px;" data-narr-host="' + escAttr(sagFullId) + '">'
                  + '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">'
                  +   '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-muted);">Mission Description</div>'
                  +   '<div class="v46-year-toggle" data-v46-year-target="' + escAttr(sagFullId) + '">'
                  +     '<button type="button" data-v46-year="2026" class="v46-year-btn' + (_sagDY === 2026 ? ' v46-year-on' : '') + '">FY26</button>'
                  +     '<button type="button" data-v46-year="2027" class="v46-year-btn' + (_sagDY === 2027 ? ' v46-year-on' : '') + '">FY27</button>'
                  +   '</div>'
                  + '</div>'
                  + '<div data-narr-fetch="' + escAttr(sagFullId) + '" data-narr-kind="sag" data-narr-year="' + _sagDY + '" style="font-size:12.5px;line-height:1.6;color:var(--text);">'
                  + '<em style="color:var(--text-muted);font-style:italic;">Loading narrative...</em>'
                  + '</div>'
                  + '</div>';
                // Previously SAGs showed only read-only chips with no
                // affordance to add or remove. Now: "+ Add office" link
                // toggles an inline picker, each chip gets an unlink (x),
                // and the wrap-level event delegation (below, ~line 1090)
                // routes data-sag-* attrs to linkSagToOffice /
                // unlinkSagFromOffice / _renderSagOfficePicker.
                var sagAssigned = (typeof getOfficesForSag === 'function') ? (getOfficesForSag(sagFullId) || []) : [];
                detailHtml += '<div style="margin-top:14px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:6px;" data-sag-tag-panel="' + escAttr(sagFullId) + '">'
                  + '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-muted);margin-bottom:8px;display:flex;justify-content:space-between;align-items:baseline;gap:8px;">'
                  + '<span>Assigned offices (' + sagAssigned.length + ')</span>'
                  + '<a data-sag-add-office="' + escAttr(sagFullId) + '" style="font-size:11px;color:var(--accent);cursor:pointer;text-decoration:none;text-transform:none;letter-spacing:normal;">+ Add office</a>'
                  + '</div>';
                if (sagAssigned.length) {
                  detailHtml += '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
                  sagAssigned.forEach(function(a){
                    detailHtml += '<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 6px 4px 10px;background:var(--surface-alt);border:1px solid var(--border);border-radius:14px;font-size:11.5px;">'
                      + '<a data-pe-jump-office="' + escAttr(a.office_id) + '" style="color:var(--text);cursor:pointer;text-decoration:none;font-weight:500;">' + escHtml(a.officeName) + '</a>'
                      + '<span style="color:var(--text-muted);font-size:10px;">' + escHtml(a.link_type || 'sag_link') + '</span>'
                      + '<a data-sag-unlink-office="' + escAttr(a.office_id) + '" data-sag-id="' + escAttr(sagFullId) + '" title="Remove" style="color:var(--text-muted);cursor:pointer;font-size:14px;line-height:1;text-decoration:none;padding:0 2px;">x</a>'
                      + '</span>';
                  });
                  detailHtml += '</div>';
                } else {
                  detailHtml += '<div style="font-size:11.5px;color:var(--text-muted);font-style:italic;">No offices assigned. Click + Add office to tag this SAG.</div>';
                }
                detailHtml += '<div data-sag-office-picker="' + escAttr(sagFullId) + '" style="display:none;margin-top:10px;padding:8px;background:var(--surface-alt);border:1px solid var(--border);border-radius:6px;">'
                  + '<input type="text" data-sag-office-filter="' + escAttr(sagFullId) + '" placeholder="Type to filter offices..." style="width:100%;padding:6px 8px;font-size:12px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);box-sizing:border-box;">'
                  + '<div data-sag-office-list="' + escAttr(sagFullId) + '" style="max-height:220px;overflow-y:auto;margin-top:8px;font-size:11.5px;"></div>'
                  + '</div>';
                detailHtml += '</div>';
                // Source PDF (rendered as plain text + page anchors; clickable href will be wired
                // when J-Books are uploaded to a Supabase storage bucket — see v153 handoff).
                // v56c: include source_page_amount from sagRec so deep-link works
                // immediately on render (v153's async narrative fetch is what
                // would have updated the source-line text otherwise; for SAGs the
                // narrative is fetched but to avoid race the page is rendered up-front).
                if (srcPdf) {
                  var _v56cSagPg = '';
                  try {
                    var _sp = sagRec ? (sagRec.source_page_amount || sagRec.source_page_description || sagRec.source_page) : null;
                    if (_sp != null && _sp > 0) _v56cSagPg = ' &middot; p.' + _sp;
                  } catch(e){}
                  detailHtml += '<div style="margin-top:10px;font-size:10.5px;color:var(--text-muted);" data-narr-source="' + escAttr(sagFullId) + '">Source: <code style="font-size:10.5px;">' + escHtml(srcPdf) + '</code>' + _v56cSagPg + '</div>';
                }
                detailHtml += '</td></tr>';
                html.push(detailHtml);
              } else {
                // -------------------------------------------------------------
                // PE dropdown — existing structure, with two v153 additions:
                //   (a) async narrative placeholder for procurement (proc_*)
                //   (b) source-link line carries data-narr-source so the async
                //       fetch can update it with page anchors when available.
                // RDT&E continues to render pe.description inline (no RPC fetch).
                // -------------------------------------------------------------
                var oo = orgById[pe.owning_org_id];
                var rs = pe.raw_source || {};
                var origPe = rs && rs.original_pe && rs.original_pe !== pe.id ? rs.original_pe : null;
                var dwOrg = pe.defense_wide_org;
                var srcPdf = pe.source_pdf;
                var r1Line = pe.r1_line;
                var hasFwd = (pe.fy27_amount != null) || (pe.fy28_amount != null) || (pe.fy29_amount != null) || (pe.fy30_amount != null) || (pe.cost_to_complete != null) || (pe.total_cost != null);
                var projects = ((typeof DB !== 'undefined' && DB.list) ? DB.list('budget_projects') : []).filter(function(p){ return p && p.pe_id === pe.id; });
                projects.sort(function(a,b){
                  var av = (a && a.fy26_amount != null) ? a.fy26_amount : -1;
                  var bv = (b && b.fy26_amount != null) ? b.fy26_amount : -1;
                  if (bv !== av) return bv - av;
                  return String((a && a.project_number) || '').localeCompare(String((b && b.project_number) || ''));
                });
                var isProc = /^proc_/i.test(String(pe.appropriation_id || ''));
                var detailHtml = '<tr class="budget-pe-detail"><td colspan="7" style="background:var(--surface-2);padding:14px 24px 14px 60px;border-top:1px solid var(--border);">'
                  + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;font-size:12px;">'
                  + '<div><div style="color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">' + (isProc ? 'Line Item' : 'Program Element') + '</div><code>' + escHtml(pe.id) + '</code>' + (origPe ? ' <span style="color:var(--text-muted);">(R-1: ' + escHtml(origPe) + ')</span>' : '') + (r1Line ? ' <span style="color:var(--text-muted);">L' + escHtml(String(r1Line)) + '</span>' : '') + '</div>'
                  + '<div><div style="color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Color of Money</div>' + chip(ba.color, ba.ba) + ' <span style="color:var(--text-muted);">' + escHtml(ba.label) + '</span></div>'
                  + '<div><div style="color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Account</div>' + escHtml(ba.account || '') + '</div>'
                  + '<div><div style="color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Owning Org</div>' + (oo ? escHtml(oo.name || oo.id) : '<span style="color:var(--text-muted);">Unmapped</span>') + (dwOrg ? ' <span style="color:var(--accent);font-size:10px;font-weight:600;">[' + escHtml(dwOrg) + ']</span>' : '') + '</div>'
                  + '<div><div style="color:var(--text-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Fiscal Year</div>' + escHtml(String(pe.fiscal_year || '\u2014')) + '</div>'
                  + '</div>';
                if (hasFwd) {
                  detailHtml += '<div style="margin-top:14px;padding:10px 12px;background:var(--surface);border:1px solid var(--border);border-radius:6px;">'
                    + '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-muted);margin-bottom:6px;">FYDP Forward Years</div>'
                    + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;font-size:12px;">'
                    + '<div><div style="color:var(--text-muted);font-size:10px;">' + _v147Y(1) + '</div><strong>' + fmtBudget(pe.fy27_amount) + '</strong></div>'
                    + '<div><div style="color:var(--text-muted);font-size:10px;">' + _v147Y(2) + '</div><strong>' + fmtBudget(pe.fy28_amount) + '</strong></div>'
                    + '<div><div style="color:var(--text-muted);font-size:10px;">' + _v147Y(3) + '</div><strong>' + fmtBudget(pe.fy29_amount) + '</strong></div>'
                    + '<div><div style="color:var(--text-muted);font-size:10px;">FY30</div><strong>' + fmtBudget(pe.fy30_amount) + '</strong></div>'
                    + '<div><div style="color:var(--text-muted);font-size:10px;">Cost to Complete</div><strong>' + fmtBudget(pe.cost_to_complete) + '</strong></div>'
                    + '<div><div style="color:var(--text-muted);font-size:10px;">Total Cost</div><strong>' + fmtBudget(pe.total_cost) + '</strong></div>'
                    + '</div></div>';
                }
                if (pe.description) {
                  var _peDY = (window._v46DrawerYearFor ? window._v46DrawerYearFor(pe.id) : 2027);
                  var _peNarrativeHtml;
                  if (_peDY === 2027) {
                    // Active focus year (FY27) — pe.description is the FY27 text loaded by get_pes_for_year(2027).
                    _peNarrativeHtml = (typeof _v131FormatJBookNarrative === 'function'
                          ? _v131FormatJBookNarrative(pe.description)
                          : '<div style="white-space:pre-wrap;">' + escHtml(pe.description) + '</div>');
                  } else {
                    // FY26 — fetch via RPC. Placeholder swapped by fillNarrativePlaceholders.
                    _peNarrativeHtml = '<div data-narr-fetch="' + escAttr(pe.id) + '" data-narr-kind="pe" data-narr-year="2026" style="font-size:12.5px;line-height:1.6;color:var(--text);"><em style="color:var(--text-muted);font-style:italic;">Loading FY26 narrative...</em></div>';
                  }
                  detailHtml += '<div style="margin-top:14px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:6px;" data-narr-host="' + escAttr(pe.id) + '">'
                    + '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">'
                    +   '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-muted);">Mission Description &amp; Justification</div>'
                    +   '<div class="v46-year-toggle" data-v46-year-target="' + escAttr(pe.id) + '">'
                    +     '<button type="button" data-v46-year="2026" class="v46-year-btn' + (_peDY === 2026 ? ' v46-year-on' : '') + '">FY26</button>'
                    +     '<button type="button" data-v46-year="2027" class="v46-year-btn' + (_peDY === 2027 ? ' v46-year-on' : '') + '">FY27</button>'
                    +   '</div>'
                    + '</div>'
                    + '<div class="v131-jbook-narrative" style="font-size:12.5px;line-height:1.6;color:var(--text);">'
                    +   _peNarrativeHtml
                    + '</div>'
                    + '</div>';
                } else if (isProc) {
                  var _procDY = (window._v46DrawerYearFor ? window._v46DrawerYearFor(pe.id) : 2027);
                  detailHtml += '<div style="margin-top:14px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:6px;" data-narr-host="' + escAttr(pe.id) + '">'
                    + '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;">'
                    +   '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-muted);">Mission Description</div>'
                    +   '<div class="v46-year-toggle" data-v46-year-target="' + escAttr(pe.id) + '">'
                    +     '<button type="button" data-v46-year="2026" class="v46-year-btn' + (_procDY === 2026 ? ' v46-year-on' : '') + '">FY26</button>'
                    +     '<button type="button" data-v46-year="2027" class="v46-year-btn' + (_procDY === 2027 ? ' v46-year-on' : '') + '">FY27</button>'
                    +   '</div>'
                    + '</div>'
                    + '<div data-narr-fetch="' + escAttr(pe.id) + '" data-narr-kind="proc" data-narr-year="' + _procDY + '" style="font-size:12.5px;line-height:1.6;color:var(--text);">'
                    + '<em style="color:var(--text-muted);font-style:italic;">Loading narrative...</em>'
                    + '</div>'
                    + '</div>';
                }
                if (projects && projects.length) {
                  detailHtml += '<div style="margin-top:14px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:6px;">'
                    + '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-muted);margin-bottom:8px;">Projects (' + projects.length + ')</div>';
                  projects.forEach(function(p){
                    var pn = escHtml(p.project_number || '');
                    var pt = escHtml(p.title || '');
                    var pd = p.description ? escHtml(p.description) : '';
                    detailHtml += '<details style="margin-bottom:6px;border-top:1px dashed var(--border);padding-top:6px;">'
                      + '<summary style="cursor:pointer;font-size:12px;display:flex;justify-content:space-between;gap:12px;align-items:baseline;">'
                      + '<span><code style="font-size:11px;">' + pn + '</code> <span style="color:var(--text);">' + pt + '</span></span>'
                      + '<span style="color:var(--text-muted);font-size:11.5px;">' + (window._v147Y ? window._v147Y(0) : 'FY26') + ' ' + fmtBudget(p.fy26_amount) + '</span>'
                      + '</summary>'
                      + (pd ? '<div style="margin-top:8px;font-size:12px;line-height:1.5;white-space:pre-wrap;color:var(--text-muted);padding-left:4px;">' + pd + '</div>' : '<div style="margin-top:6px;font-size:11.5px;color:var(--text-muted);font-style:italic;">No project narrative available.</div>')
                      + '</details>';
                  });
                  detailHtml += '</div>';
                }
                // Assigned Offices + Suggestions (existing v72 logic)
                var assigned = (typeof getOfficesForPe === 'function') ? getOfficesForPe(pe.id) : [];
                var pesuggs  = (typeof getSuggestionsForPe === 'function') ? getSuggestionsForPe(pe.id) : [];
                detailHtml += '<div style="margin-top:14px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:6px;" data-pe-tag-panel="' + escAttr(pe.id) + '">'
                  + '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-muted);margin-bottom:8px;display:flex;justify-content:space-between;align-items:baseline;gap:8px;">'
                  + '<span>Assigned offices (' + assigned.length + ')</span>'
                  + '<a data-pe-add-office="' + escAttr(pe.id) + '" style="font-size:11px;color:var(--accent);cursor:pointer;text-decoration:none;text-transform:none;letter-spacing:normal;">+ Add office</a>'
                  + '</div>';
                if (assigned.length) {
                  detailHtml += '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
                  assigned.forEach(function(a){
                    var srcBadge = a.source === 'jbook_title' ? 'J-Book title'
                                 : a.source === 'jbook_desc'  ? 'J-Book desc'
                                 : a.source === 'rollup'      ? 'Rollup'
                                 : a.source === 'seed'        ? 'Seed'
                                 : 'Manual';
                    detailHtml += '<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 6px 4px 10px;background:var(--surface-alt);border:1px solid var(--border);border-radius:14px;font-size:11.5px;">'
                      + '<a data-pe-jump-office="' + escAttr(a.office_id) + '" style="color:var(--text);cursor:pointer;text-decoration:none;font-weight:500;">' + escHtml(a.officeName) + '</a>'
                      + '<span style="color:var(--text-muted);font-size:10px;">' + escHtml(a.link_type) + ' · ' + srcBadge + '</span>'
                      + '<a data-pe-unlink-office="' + escAttr(a.office_id) + '" data-pe-id="' + escAttr(pe.id) + '" title="Remove" style="color:var(--text-muted);cursor:pointer;font-size:14px;line-height:1;text-decoration:none;padding:0 2px;">×</a>'
                      + '</span>';
                  });
                  detailHtml += '</div>';
                } else {
                  detailHtml += '<div style="font-size:11.5px;color:var(--text-muted);font-style:italic;">No offices assigned. Click + Add office to tag this PE.</div>';
                }
                detailHtml += '<div data-pe-office-picker="' + escAttr(pe.id) + '" style="display:none;margin-top:10px;padding:8px;background:var(--surface-alt);border:1px solid var(--border);border-radius:6px;">'
                  + '<input type="text" data-pe-office-filter="' + escAttr(pe.id) + '" placeholder="Type to filter offices…" style="width:100%;padding:6px 8px;font-size:12px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);box-sizing:border-box;">'
                  + '<div data-pe-office-list="' + escAttr(pe.id) + '" style="max-height:220px;overflow-y:auto;margin-top:8px;font-size:11.5px;"></div>'
                  + '</div>';
                if (pesuggs.length) {
                  detailHtml += '<div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--border);">'
                    + '<div style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-muted);margin-bottom:6px;">Suggestions from J-Book narrative</div>';
                  pesuggs.forEach(function(s){
                    var kindBadge = s.match_kind === 'title' ? '<span style="color:var(--accent);font-weight:600;">title match</span>'
                                  : s.match_kind === 'description' ? '<span style="color:var(--text-muted);">description match</span>'
                                  : '<span style="color:var(--text-muted);">project match</span>';
                    detailHtml += '<div style="display:flex;align-items:baseline;gap:8px;padding:5px 0;font-size:11.5px;border-top:1px dotted var(--border);">'
                      + '<span style="flex:1;"><strong>' + escHtml(s.officeName) + '</strong> <span style="color:var(--text-muted);font-size:10.5px;">' + escHtml(s.officeService) + '</span> &middot; ' + kindBadge + (s.matched ? ' <span style="color:var(--text-muted);font-size:10.5px;">(matched "' + escHtml(s.matched) + '")</span>' : '') + '</span>'
                      + '<a data-pe-claim-sugg="' + escAttr(s.office_id) + '" data-pe-id="' + escAttr(pe.id) + '" style="color:var(--accent);cursor:pointer;font-size:11px;text-decoration:none;font-weight:500;">Claim</a>'
                      + '<a data-pe-dismiss-sugg="' + escAttr(s.office_id) + '" data-pe-id="' + escAttr(pe.id) + '" style="color:var(--text-muted);cursor:pointer;font-size:11px;text-decoration:none;">Dismiss</a>'
                      + '</div>';
                  });
                  detailHtml += '</div>';
                }
                detailHtml += '</div>';
                if (!pe.description && !isProc && !(projects && projects.length) && !hasFwd) {
                  detailHtml += '<div style="margin-top:12px;padding-top:10px;border-top:1px dashed var(--border);font-size:11.5px;color:var(--text-muted);">R-2 narrative not available for this PE. Source: ' + escHtml((rs && rs.source) || 'unknown') + '.</div>';
                } else if (srcPdf) {
                  // v56c: include source_page from RPC so v46 sweep can attach
                  // the deep-link page anchor without waiting on the v153
                  // narrative fetch (which never fires for FY27 inline mode).
                  var _v56cPg = (pe.source_page != null && pe.source_page > 0) ? (' &middot; p.' + pe.source_page) : '';
                  detailHtml += '<div style="margin-top:10px;font-size:10.5px;color:var(--text-muted);" data-narr-source="' + escAttr(pe.id) + '">Source: <code style="font-size:10.5px;">' + escHtml(srcPdf) + '</code>' + _v56cPg + (rs && rs.source ? ' &middot; ' + escHtml(rs.source) : '') + '</div>';
                } else if (isProc) {
                  // Procurement with no source_pdf on the row — the async fetch may
                  // surface one from proc_line_narratives. Render a placeholder.
                  detailHtml += '<div style="margin-top:10px;font-size:10.5px;color:var(--text-muted);" data-narr-source="' + escAttr(pe.id) + '"></div>';
                }
                detailHtml += '</td></tr>';
                html.push(detailHtml);
              }
            }
          });
          html.push('</tbody></table>');
          html.push('</div>');
        });
      });
    });

    html.push('</div>');
    wrap.innerHTML = html.join('');
  }

  // ---- Wiring (idempotent) ----
  if (qEl && !qEl.dataset.budgetWired) {
    qEl.addEventListener('input', renderBudget);
    qEl.dataset.budgetWired = '1';
  }
  if (svcSel && !svcSel.dataset.budgetWired) {
    svcSel.addEventListener('change', renderBudget);
    svcSel.dataset.budgetWired = '1';
  }
  if (baSel && !baSel.dataset.budgetWired) {
    baSel.addEventListener('change', renderBudget);
    baSel.dataset.budgetWired = '1';
  }
  var apprFSelW = document.getElementById('budgetApprFilter');
  if (apprFSelW && !apprFSelW.dataset.budgetWired) {
    apprFSelW.addEventListener('change', renderBudget);
    apprFSelW.dataset.budgetWired = '1';
  }
  var prioCb = document.getElementById('budgetPriorityOnly');
  if (prioCb && !prioCb.dataset.budgetWired) {
    prioCb.addEventListener('change', renderBudget);
    prioCb.dataset.budgetWired = '1';
  }
  var prioOrgCb = document.getElementById('budgetPriorityOrgOnly');
  if (prioOrgCb && !prioOrgCb.dataset.budgetWired) {
    prioOrgCb.addEventListener('change', renderBudget);
    prioOrgCb.dataset.budgetWired = '1';
  }
  if (!wrap.dataset.budgetTreeWired) {
    wrap.addEventListener('click', function(ev){
      // don't bubble into a tree expand/collapse.
      var addBtn = ev.target.closest('[data-pe-add-office]');
      if (addBtn) {
        ev.preventDefault(); ev.stopPropagation();
        var peId = addBtn.getAttribute('data-pe-add-office');
        var picker = wrap.querySelector('[data-pe-office-picker="' + (window.CSS && CSS.escape ? CSS.escape(peId) : peId) + '"]');
        if (picker) {
          var open = picker.style.display !== 'none';
          picker.style.display = open ? 'none' : '';
          if (!open) _renderPeOfficePicker(peId, picker);
        }
        return;
      }
      var unlink = ev.target.closest('[data-pe-unlink-office]');
      if (unlink) {
        ev.preventDefault(); ev.stopPropagation();
        var peId2 = unlink.getAttribute('data-pe-id');
        var oid2  = unlink.getAttribute('data-pe-unlink-office');
        unlinkPeFromOffice(peId2, oid2).then(function(){ window.renderBudget(); });
        return;
      }
      var sagAddBtn = ev.target.closest('[data-sag-add-office]');
      if (sagAddBtn) {
        ev.preventDefault(); ev.stopPropagation();
        var sagId = sagAddBtn.getAttribute('data-sag-add-office');
        var sagPicker = wrap.querySelector('[data-sag-office-picker="' + (window.CSS && CSS.escape ? CSS.escape(sagId) : sagId) + '"]');
        if (sagPicker) {
          var sagOpen = sagPicker.style.display !== 'none';
          sagPicker.style.display = sagOpen ? 'none' : '';
          if (!sagOpen && typeof _renderSagOfficePicker === 'function') {
            _renderSagOfficePicker(sagId, sagPicker);
          }
        }
        return;
      }
      var sagUnlink = ev.target.closest('[data-sag-unlink-office]');
      if (sagUnlink) {
        ev.preventDefault(); ev.stopPropagation();
        var sagId2 = sagUnlink.getAttribute('data-sag-id');
        var sagOid2 = sagUnlink.getAttribute('data-sag-unlink-office');
        unlinkSagFromOffice(sagId2, sagOid2).then(function(){ window.renderBudget(); });
        return;
      }
      var claim = ev.target.closest('[data-pe-claim-sugg]');
      if (claim) {
        ev.preventDefault(); ev.stopPropagation();
        var peId3 = claim.getAttribute('data-pe-id');
        var oid3  = claim.getAttribute('data-pe-claim-sugg');
        linkPeToOffice(peId3, oid3, { source: 'manual', notes: 'claimed from suggestion' })
          .then(function(){ window.renderBudget(); });
        return;
      }
      var dismiss = ev.target.closest('[data-pe-dismiss-sugg]');
      if (dismiss) {
        ev.preventDefault(); ev.stopPropagation();
        var peId4 = dismiss.getAttribute('data-pe-id');
        var oid4  = dismiss.getAttribute('data-pe-dismiss-sugg');
        dismissPeOfficeSuggestion(peId4, oid4).then(function(){ window.renderBudget(); });
        return;
      }
      var jumpOffice = ev.target.closest('[data-pe-jump-office]');
      if (jumpOffice) {
        ev.preventDefault(); ev.stopPropagation();
        var oid5 = jumpOffice.getAttribute('data-pe-jump-office');
        if (typeof activateTab === 'function') activateTab('offices');
        var card = document.querySelector('.office-card[data-id="' + (window.CSS && CSS.escape ? CSS.escape(oid5) : oid5) + '"]');
        if (card && typeof openDetailPanel === 'function') openDetailPanel(card);
        return;
      }
      var prioPe = ev.target.closest('[data-bprio-pe]');
      if (prioPe) {
        ev.preventDefault(); ev.stopPropagation();
        togglePePriority(prioPe.getAttribute('data-bprio-pe'));
        return;
      }
      var prioSag = ev.target.closest('[data-bprio-sag]');
      if (prioSag) {
        ev.preventDefault(); ev.stopPropagation();
        toggleSagPriority(prioSag.getAttribute('data-bprio-sag'));
        return;
      }
      var panelCell = ev.target.closest('.bpe-panel-cell');
      if (panelCell) {
        ev.preventDefault(); ev.stopPropagation();
        var rowEl = panelCell.closest('.budget-pe-row');
        if (rowEl) {
          var isSag = rowEl.getAttribute('data-is-sag') === '1';
          var lookupId = isSag
            ? (rowEl.getAttribute('data-sag-id') || rowEl.getAttribute('data-pe-id'))
            : rowEl.getAttribute('data-pe-id');
          if (typeof openBudgetItemPanel === 'function') openBudgetItemPanel(lookupId, isSag);
        }
        return;
      }
      // Existing: tree expand/collapse (chevron cells + group header rows).
      var node = ev.target.closest('.budget-node, .budget-pe-row');
      if (!node || !wrap.contains(node)) return;
      var path = node.getAttribute('data-bpath');
      if (!path) return;
      if (_budgetExpanded.has(path)) _budgetExpanded.delete(path);
      else _budgetExpanded.add(path);
      window.renderBudget();
    });
    // Filter input on the inline office picker (event delegation via input event).
    wrap.addEventListener('input', function(ev){
      var t = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-pe-office-filter');
      if (t) {
        var picker = wrap.querySelector('[data-pe-office-picker="' + (window.CSS && CSS.escape ? CSS.escape(t) : t) + '"]');
        if (picker) _renderPeOfficePicker(t, picker, ev.target.value || '');
        return;
      }
      var st = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-sag-office-filter');
      if (st) {
        var sagPicker = wrap.querySelector('[data-sag-office-picker="' + (window.CSS && CSS.escape ? CSS.escape(st) : st) + '"]');
        if (sagPicker && typeof _renderSagOfficePicker === 'function') {
          _renderSagOfficePicker(st, sagPicker, ev.target.value || '');
        }
      }
    });
    wrap.dataset.budgetTreeWired = '1';
  }
}

// =================================================================
// =================================================================
window.renderBudget = renderBudget;
