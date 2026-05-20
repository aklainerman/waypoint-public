// js/render/budget-office-view.js
//
// contiguous extraction (~280 lines / ~14 KB) containing:
//
//   * function _bovOfficesScope()       -- filter helper for the
//                                          master office list.
//
//   * function _bovOfficeFy26Total(o)   -- focus-year ($) total
//                                          for a given office.
//                                          HEAVILY consumed by 4
//                                          sibling modules.
//                                          (Misnamed -- v56d
//                                          historical artifact.
//                                          Returns CURRENT FOCUS
//                                          YEAR, not strictly FY26.)
//
//   * function renderBudgetOfficeView() -- master-detail renderer.
//
//   * 2 document-level event listeners
//       - input on #budgetOfficeViewSearch
//       - change on #bovPriorityOnly
//
// State vars (kept in classic script per the v204 pattern; `var`
// at classic-script top scope auto-hoists to window, preserving
// cross-module binding so the activateTab routeNav handler at
// index.html:~21755 can keep writing them bare):
//   _bovSelectedOfficeId, _bovTargetSagId, _bovExpandedBas,
//   _bovPriorityOnly
//
// Originally at file-scope of the inline monolith; lifted to ES
// module in v207. Same classic-script-split pattern as v181-v206.
//
// Pre-extraction audit (v185 pattern). 2 names exposed on window:
//
//   renderBudgetOfficeView -- 6 external callers (5 index.html +
//                              1 js/scout/scout-client.js)
//
//   _bovOfficeFy26Total    -- 11+ external references across 4
//                              sibling modules
//                              (dashboard, detail-panel,
//                              mission-control, offices)
//
// Module-internal (NOT exposed):
//   _bovOfficesScope         -- 1 caller (renderBudgetOfficeView)
//
// External file-scope refs consumed (all resolved via globalThis
// or runtime helper-lookup):
//   _bovSelectedOfficeId, _bovTargetSagId, _bovExpandedBas,
//   _bovPriorityOnly      (classic-script vars; auto-hoisted)
//   DB                    (window global)
//   budgetOrgById, computeOrgBudget, fmtBudget, escHtml,
//   escAttr, _orgRollupSet, statusPill, alignmentStars
//                         (classic-script helpers / modules)
//
// Critical rewrites (F-NEW-V185-1 corollary; modules are strict,
// bare writes throw):
//   6 bare writes to _bov* state vars rewritten to window.X
//   (W1-W6); all `_bovExpandedBas.has()/.add()/.delete()` calls
//   left as-is (method calls on the shared Set instance work via
//   globalThis read of the reference).
//
// F-NEW-V203-1 check: the two document.addEventListener calls
// register listeners at module-load time. These are NOT
// DOMContentLoaded wraps; document-level event listeners attach
// successfully regardless of DOM-ready state.

function _bovOfficesScope() {
  // Scope = same offices as the Orgs tab (DB.list('offices')). Filter optional later.
  var all = (DB.list && DB.list('offices')) || [];
  var arr = all.filter(function(o){ return o && o.id; });
  if (_bovPriorityOnly) arr = arr.filter(function(o){ return !!(o && o.priority); });
  return arr;
}

function _bovOfficeFy26Total(office) {
  // v56d: function name is historical — actually returns the CURRENT FOCUS YEAR
  // total (FY27 in default view, FY26 in ?year=2026 mode). PE side reads
  // pe.request_amount which is wired by get_pes_for_year(_budgetYear) branch (a)
  // to fy27_total when _budgetYear=2027. SAG side reads l.sagFy26 which is
  // populated via _v150SagAmt(s) — disc+mand for FY27, disc-only for FY26.
  // Sum {focus-year} across PEs (request_amount in dollars) + SAGs.
  var total = 0;
  // PEs via budget_org rollup + manual links
  if (office.budget_org_id) {
    var b = (typeof computeOrgBudget === 'function') ? computeOrgBudget(office.budget_org_id) : null;
    if (b && b.totalReq) total += b.totalReq;
  }
  // Add direct-linked PEs not already in rollup
  var rollupSet = {};
  if (office.budget_org_id) {
    var rs = (typeof _orgRollupSet === 'function') ? _orgRollupSet(office.budget_org_id) : {};
    rollupSet = rs || {};
  }
  var dismissed = new Set();
  ((DB.list && DB.list('pe_office_link_dismissals')) || []).forEach(function(d){
    if (d && d.office_id === office.id && d.pe_id) dismissed.add(d.pe_id);
  });
  var addedPe = new Set();
  ((DB.list && DB.list('pe_office_links')) || []).forEach(function(l){
    if (l && l.office_id === office.id && l.pe_id && !dismissed.has(l.pe_id)) {
      var pe = (DB.get && DB.get('budget_pes', l.pe_id));
      if (pe && !rollupSet[pe.owning_org_id] && !addedPe.has(pe.id)) {
        addedPe.add(pe.id);
        total += Number(pe.request_amount) || 0;
      }
    }
  });
  // SAGs
  var sagLinks = (typeof getSagsForOffice === 'function') ? getSagsForOffice(office.id) : [];
  sagLinks.forEach(function(l){ total += Number(l.sagFy26) || 0; });
  return total;
}

function renderBudgetOfficeView() {
  var listEl = document.getElementById('budgetOfficeViewList');
  var detailEl = document.getElementById('budgetOfficeViewDetail');
  var countEl = document.getElementById('budgetOfficeViewCount');
  if (!listEl || !detailEl) return;

  var search = ((document.getElementById('budgetOfficeViewSearch') || {}).value || '').toLowerCase();
  var offices = _bovOfficesScope();
  if (search) {
    offices = offices.filter(function(o){
      return ((o.name || '') + ' ' + (o.fullName || '') + ' ' + (o.id || '')).toLowerCase().indexOf(search) !== -1;
    });
  }
  // Sort: total funding desc, then name asc
  offices = offices.map(function(o){ return { o: o, total: _bovOfficeFy26Total(o) }; })
                   .sort(function(a, b){ return (b.total - a.total) || ((a.o.name||'').localeCompare(b.o.name||'')); });

  if (countEl) countEl.textContent = offices.length + ' office' + (offices.length===1?'':'s');

  // Auto-select first office if none yet, OR keep _bovSelectedOfficeId if it's still in the list
  var ids = offices.map(function(x){ return x.o.id; });
  if (!_bovSelectedOfficeId || ids.indexOf(_bovSelectedOfficeId) === -1) {
    window._bovSelectedOfficeId = ids[0] || null;
  }

  // Render list (master).
  var html = [];
  offices.forEach(function(x){
    var o = x.o;
    var active = (o.id === _bovSelectedOfficeId);
    var subtitle = [o.service || '', o.tier || ''].filter(Boolean).join(' \u00b7 ');
    html.push('<div class="bov-office-row' + (active ? ' active' : '') + '" data-bov-office="' + escAttr(o.id) + '">');
    html.push('<div class="bov-office-name">' + escHtml(o.name || o.id) + '</div>');
    html.push('<div class="bov-office-meta">' + (subtitle ? '<span>' + escHtml(subtitle) + '</span>' : '') + '<span class="bov-office-total">' + (x.total ? fmtBudget(x.total) : '\u2014') + '</span></div>');
    html.push('</div>');
  });
  if (!offices.length) {
    html.push('<div style="padding:14px;color:var(--text-muted);font-size:12px;">No offices match.</div>');
  }
  listEl.innerHTML = html.join('');
  listEl.querySelectorAll('[data-bov-office]').forEach(function(row){
    row.addEventListener('click', function(){
      window._bovSelectedOfficeId = row.getAttribute('data-bov-office');
      window._bovTargetSagId = null; // selecting manually clears any SAG-target highlight
      renderBudgetOfficeView();
    });
  });

  // Render detail.
  if (!_bovSelectedOfficeId) {
    detailEl.innerHTML = '<div style="padding:24px;color:var(--text-muted);font-size:13px;text-align:center;">No office selected.</div>';
    return;
  }
  var sel = (DB.get && DB.get('offices', _bovSelectedOfficeId));
  if (!sel) {
    detailEl.innerHTML = '<div style="padding:24px;color:var(--text-muted);">Selected office not found.</div>';
    return;
  }
  var dhtml = [];
  dhtml.push('<h3>' + escHtml(sel.name || sel.id) + '</h3>');
  if (sel.fullName) dhtml.push('<div style="font-size:11.5px;color:var(--text-muted);margin-bottom:8px;">' + escHtml(sel.fullName) + '</div>');
  var totalFy26 = _bovOfficeFy26Total(sel);
  dhtml.push('<div style="display:flex;align-items:baseline;gap:8px;margin-top:6px;">');
  dhtml.push('<div style="font-size:22px;font-weight:700;font-family:var(--font-display);">' + (totalFy26 ? fmtBudget(totalFy26) : '\u2014') + '</div>');
  dhtml.push('<div style="font-size:11px;color:var(--text-muted);">total ' + (window._v147Y ? window._v147Y(0) : 'FY26') + ' funding (RDT&amp;E + Procurement + O&amp;M)</div>');
  dhtml.push('</div>');
  // to the PE list below. Draws a left-border rule + a small inline SVG
  // bracket so the master-detail connection reads at a glance.
  dhtml.push('<div class="v131-bov-anchor" aria-hidden="true" style="position:relative;height:18px;margin:6px 0 0 14px;border-left:2px solid var(--border);">'
    +   '<svg viewBox="0 0 60 18" preserveAspectRatio="none" style="position:absolute;left:-1px;top:0;width:60px;height:18px;overflow:visible;">'
    +     '<path d="M0,0 C0,12 18,18 30,18" fill="none" stroke="var(--accent)" stroke-width="1.4" stroke-dasharray="3 3"/>'
    +   '</svg>'
    +   '<span style="position:absolute;left:34px;top:1px;font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px;">funding lines tagged below</span>'
    + '</div>');

  // PEs section (rollup + direct-linked, grouped by appropriation).
  var apprs = (DB.list && DB.list('budget_appropriations')) || [];
  var apprById = {}; apprs.forEach(function(a){ apprById[a.id] = a; });
  var pes = (DB.list && DB.list('budget_pes')) || [];
  var rs = sel.budget_org_id && (typeof _orgRollupSet === 'function') ? (_orgRollupSet(sel.budget_org_id) || {}) : {};
  var dismissedPes = new Set();
  ((DB.list && DB.list('pe_office_link_dismissals')) || []).forEach(function(d){
    if (d && d.office_id === sel.id && d.pe_id) dismissedPes.add(d.pe_id);
  });
  var directLinkedPeIds = new Set();
  ((DB.list && DB.list('pe_office_links')) || []).forEach(function(l){
    if (l && l.office_id === sel.id && l.pe_id && !dismissedPes.has(l.pe_id)) directLinkedPeIds.add(l.pe_id);
  });
  var allPes = pes.filter(function(pe){
    return (pe.owning_org_id && rs[pe.owning_org_id]) || directLinkedPeIds.has(pe.id);
  });
  // Group by appropriation
  var byAppr = {};
  allPes.forEach(function(pe){
    var ap = apprById[pe.appropriation_id];
    if (!ap) return;
    (byAppr[ap.id] = byAppr[ap.id] || { ap: ap, pes: [] }).pes.push(pe);
  });
  var apprKeys = Object.keys(byAppr).sort(function(a, b){
    return (byAppr[a].ap.title || '').localeCompare(byAppr[b].ap.title || '')
        || (byAppr[a].ap.ba || '').localeCompare(byAppr[b].ap.ba || '', undefined, {numeric:true});
  });
  if (apprKeys.length) {
    dhtml.push('<div class="bov-section">');
    dhtml.push('<div class="bov-section-label">RDT&amp;E + Procurement (' + allPes.length + ' PE' + (allPes.length===1?'':'s') + ')</div>');
    apprKeys.forEach(function(k){
      var ap = byAppr[k].ap;
      var pesB = byAppr[k].pes.slice().sort(function(x, y){ return (Number(y.request_amount) || 0) - (Number(x.request_amount) || 0); });
      var subT = pesB.reduce(function(s, p){ return s + (Number(p.request_amount) || 0); }, 0);
      var baExpKey = sel.id + '|' + ap.id;
      var baExp = _bovExpandedBas.has(baExpKey);
      var chev = baExp ? '\u25bc' : '\u25b6';
      dhtml.push('<div class="bov-ba-header" data-bov-ba-toggle="' + escAttr(baExpKey) + '" style="margin-top:8px;padding:4px 8px;background:var(--surface-2);border-left:3px solid ' + (ap.display_color || 'var(--text-muted)') + ';font-size:11.5px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none;">');
      dhtml.push('<span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:10px;color:var(--text-muted);">' + chev + '</span><strong>' + escHtml(ap.account || '') + ' \u00b7 BA ' + escHtml(ap.ba || '?') + ' \u2014 ' + escHtml(ap.ba_name || '') + '</strong></span>');
      dhtml.push('<span style="color:var(--text-muted);">' + fmtBudget(subT) + ' \u00b7 ' + pesB.length + ' PE' + (pesB.length===1?'':'s') + '</span>');
      dhtml.push('</div>');
      if (baExp) {
        pesB.forEach(function(pe){
          dhtml.push('<div class="bov-line bov-pe-line" data-bov-pe="' + escAttr(pe.id) + '">');
          dhtml.push('<code class="bov-line-id">' + escHtml(pe.id) + '</code>');
          dhtml.push('<span class="bov-line-title" title="' + escAttr(pe.title || '') + '">' + escHtml(pe.title || '') + '</span>');
          dhtml.push('<span class="bov-line-amt">' + fmtBudget(pe.request_amount) + '</span>');
          dhtml.push('</div>');
        });
      }
    });
    dhtml.push('</div>');
  } else {
    dhtml.push('<div class="bov-section"><div class="bov-section-label">RDT&amp;E + Procurement</div><div style="padding:8px;color:var(--text-muted);font-size:11.5px;">No PEs linked.</div></div>');
  }

  // SAGs section (O&M).
  var sagLinks = (typeof getSagsForOffice === 'function') ? getSagsForOffice(sel.id) : [];
  if (sagLinks.length) {
    // Group by appropriation_id (om_dw_ba01/03/04)
    var apprBuckets = {};
    sagLinks.forEach(function(s){
      var k = s.sagAppr || 'om_dw_ba04';
      (apprBuckets[k] = apprBuckets[k] || { id: k, sags: [] }).sags.push(s);
    });
    var apprBucketKeys = Object.keys(apprBuckets).sort();
    dhtml.push('<div class="bov-section">');
    dhtml.push('<div class="bov-section-label">Operations &amp; Maintenance (' + sagLinks.length + ' SAG' + (sagLinks.length===1?'':'s') + ')</div>');
    apprBucketKeys.forEach(function(k){
      var bucket = apprBuckets[k];
      var ap = apprById[bucket.id] || { ba: '?', ba_name: '', display_color: 'var(--text-muted)' };
      var subT = bucket.sags.reduce(function(s, x){ return s + (Number(x.sagFy26) || 0); }, 0);
      var baExpKey = sel.id + '|' + bucket.id;
      var hasTarget = _bovTargetSagId && bucket.sags.some(function(x){ return x.sag_id === _bovTargetSagId; });
      var baExp = _bovExpandedBas.has(baExpKey) || hasTarget;
      var chev = baExp ? '\u25bc' : '\u25b6';
      dhtml.push('<div class="bov-ba-header" data-bov-ba-toggle="' + escAttr(baExpKey) + '" style="margin-top:8px;padding:4px 8px;background:var(--surface-2);border-left:3px solid ' + (ap.display_color || 'var(--text-muted)') + ';font-size:11.5px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none;">');
      dhtml.push('<span style="display:inline-flex;align-items:center;gap:6px;"><span style="display:inline-block;width:10px;color:var(--text-muted);">' + chev + '</span><strong>O&amp;M \u00b7 BA ' + escHtml(ap.ba || '?') + ' \u2014 ' + escHtml(ap.ba_name || '') + '</strong></span>');
      dhtml.push('<span style="color:var(--text-muted);">' + fmtBudget(subT) + ' \u00b7 ' + bucket.sags.length + ' SAG' + (bucket.sags.length===1?'':'s') + '</span>');
      dhtml.push('</div>');
      if (baExp) {
        bucket.sags.forEach(function(s){
          var targetCls = (_bovTargetSagId === s.sag_id) ? ' bov-line-targeted' : '';
          dhtml.push('<div class="bov-line bov-sag-line' + targetCls + '" data-bov-sag="' + escAttr(s.sag_id) + '">');
          dhtml.push('<code class="bov-line-id">' + escHtml(s.sagOrg || '') + '</code>');
          dhtml.push('<span class="bov-line-title" title="' + escAttr(s.sagTitle || '') + '">' + escHtml(s.sagTitle || s.sag_id) + '</span>');
          dhtml.push('<span class="bov-line-amt">' + fmtBudget(s.sagFy26) + '</span>');
          dhtml.push('</div>');
        });
      }
    });
    dhtml.push('</div>');
  } else {
    dhtml.push('<div class="bov-section"><div class="bov-section-label">Operations &amp; Maintenance</div><div style="padding:8px;color:var(--text-muted);font-size:11.5px;">No SAGs linked.</div></div>');
  }

  detailEl.innerHTML = dhtml.join('');

  // Scroll the targeted SAG into view, then clear the target so subsequent renders don't re-scroll.
  if (_bovTargetSagId) {
    var hit = detailEl.querySelector('.bov-sag-line[data-bov-sag="' + _bovTargetSagId.replace(/"/g, '\\"') + '"]');
    if (hit && typeof hit.scrollIntoView === 'function') {
      hit.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  detailEl.querySelectorAll('[data-bov-pe]').forEach(function(row){
    row.style.cursor = 'pointer';
    row.addEventListener('click', function(){
      var peId = row.getAttribute('data-bov-pe');
      if (peId && typeof activateTab === 'function') {
        activateTab('budget', { budgetPe: peId });
      }
    });
  });
  detailEl.querySelectorAll('[data-bov-ba-toggle]').forEach(function(row){
    row.addEventListener('click', function(){
      var k = row.getAttribute('data-bov-ba-toggle');
      if (!k) return;
      if (_bovExpandedBas.has(k)) _bovExpandedBas.delete(k);
      else _bovExpandedBas.add(k);
      renderBudgetOfficeView();
    });
  });
  // Wire SAG row clicks: pulse / log / future drill-in. Currently a no-op highlight.
  detailEl.querySelectorAll('[data-bov-sag]').forEach(function(row){
    row.addEventListener('click', function(){
      // Future: open a SAG-specific detail card. For now, just toggle the highlight.
      detailEl.querySelectorAll('.bov-line-targeted').forEach(function(el){ el.classList.remove('bov-line-targeted'); });
      row.classList.add('bov-line-targeted');
      window._bovTargetSagId = row.getAttribute('data-bov-sag');
    });
  });
}

// Wire search input
document.addEventListener('input', function(e){
  if (e.target && e.target.id === 'budgetOfficeViewSearch') {
    renderBudgetOfficeView();
  }
});

document.addEventListener('change', function(e){
  if (e.target && e.target.id === 'bovPriorityOnly') {
    window._bovPriorityOnly = !!e.target.checked;
    // When the filter changes, drop the current selection so the master
    // list auto-falls-back to the top of the (re)filtered set.
    window._bovSelectedOfficeId = null;
    if (typeof renderBudgetOfficeView === 'function') renderBudgetOfficeView();
  }
});



// =================================================================
// renderBudgetOfficeView -- 6 external callers
// _bovOfficeFy26Total    -- 11+ external references in 4 sibling
//                           modules (dashboard, detail-panel,
//                           mission-control, offices)
// =================================================================
window.renderBudgetOfficeView = renderBudgetOfficeView;
window._bovOfficeFy26Total = _bovOfficeFy26Total;
