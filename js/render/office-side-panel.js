// js/render/office-side-panel.js
//
// the #panel-budget DOM target for the office detail-panel slide-out
// (plus one state var). Originally in non-contiguous fragments
// within the inline monolith; fused into one module via the multi-
// fragment pattern from v199/v201/v203/v205.
//
//   * renderOfficeOmPanel(office)        -- O&M SAG section
//   * renderOfficeBudgetPanel(office)    -- PE/RDT&E + Procurement
//                                            section + sub-org rollup
//   * _renderPeOfficePicker(peId,...)    -- inline "+ Add office"
//                                            picker for PE rows in
//                                            budget-tree.js's
//                                            renderBudget body
//   * renderOfficeSuggestionsPanel(office)-- J-Book PE-match
//                                            suggestions tab
//
//   * _panelBudgetExpanded = {}           -- per-office expand state
//                                            (module-internal; only
//                                            used by renderOffice-
//                                            BudgetPanel)
//
// Originally at file-scope of the inline monolith; lifted to ES
// module in v211. Same classic-script-split pattern as v181-v210.
//
// Pre-extraction audit (v185 pattern). 4 names exposed:
//   renderOfficeBudgetPanel      -- 23 external sites
//   renderOfficeOmPanel          -- 13 external sites
//   renderOfficeSuggestionsPanel -- 8 external sites
//   _renderPeOfficePicker        -- 4 external sites (all in
//                                    js/render/budget-tree.js)
//
// Internal cluster cross-calls (renderOfficeBudgetPanel calls itself
// + renderOfficeOmPanel; renderOfficeOmPanel calls itself;
// renderOfficeSuggestionsPanel calls renderOfficeBudgetPanel + itself)
// all resolve module-locally. No wrappers exist for any of the four;
// bare self-calls and window.X calls are behaviorally identical.
// No body rewrites needed.
//
// External file-scope refs consumed (all resolve at call time via
// globalThis):
//   DB, escHtml, escAttr, fmtBudget, document
//   computeOrgBudget, _orgRollupSet, _orgRollupOrgIds  (rollup.js, v200)
//   budgetOrgBreadcrumb, getOfficesForPe, getOfficesForSag,
//   getSagsForOffice, getSuggestionsForPe,
//   getSuggestionsForOffice, getSagSuggestionsForOffice
//   linkPeToOffice, unlinkPeFromOffice, dismissPeOfficeSuggestion
//   linkSagToOffice, unlinkSagFromOffice, dismissSagOfficeSuggestion
//   activateTab, closeDetailPanel, openDetailPanel
//   window._v147Y, window._v150SagAmt

// Renders into #panel-budget AFTER renderOfficeBudgetPanel has populated its
// PE/RDT&E content. Appends a separate card with O&M SAG totals + top SAGs.
function renderOfficeOmPanel(office) {
  var pb = document.getElementById('panel-budget');
  if (!pb || !office) return;
  // Remove any prior O&M block first (idempotent re-render).
  var prior = pb.querySelector('.panel-om-card');
  if (prior && prior.parentNode) prior.parentNode.removeChild(prior);
  var priorLabel = pb.querySelector('.panel-om-label');
  if (priorLabel && priorLabel.parentNode) priorLabel.parentNode.removeChild(priorLabel);

  var sagLinks = (typeof getSagsForOffice === 'function') ? getSagsForOffice(office.id) : [];
  if (!sagLinks.length) {
    return; // no O&M data for this office — render nothing rather than empty card
  }
  var totalFy26 = 0;
  sagLinks.forEach(function(l){ totalFy26 += (l.sagFy26 || 0); });

  var html = [];
  html.push('<div class="detail-label panel-om-label" style="margin-top:14px;margin-bottom:6px;">Operations &amp; Maintenance</div>');
  html.push('<div class="panel-om-card" style="padding:10px 12px;background:var(--surface-alt);border:1px solid var(--border);border-radius:6px;">');
  html.push('<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px;flex-wrap:wrap;">');
  html.push('<div style="font-size:18px;font-weight:700;color:var(--text);font-family:var(--font-display);">' + fmtBudget(totalFy26) + '</div>');
  html.push('<div style="font-size:10.5px;color:var(--text-muted);">' + (window._v147Y ? window._v147Y(0) : 'FY26') + ' estimate \u00b7 ' + sagLinks.length + ' SAG' + (sagLinks.length===1?'':'s') + '</div>');
  html.push('</div>');
  // Top SAGs (compact list).
  var topSags = sagLinks.slice(0, 8);
  html.push('<div style="font-size:10.5px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Linked SAGs</div>');
  html.push('<div class="panel-om-sags">');
  topSags.forEach(function(l){
    var color = '#3b8ea5'; // default O&M color (BA-04 admin/svc-wide)
    if (l.sagAppr === 'om_dw_ba01') color = '#3b8ea5';
    else if (l.sagAppr === 'om_dw_ba03') color = '#5ba48e';
    else if (l.sagAppr === 'om_dw_ba04') color = '#7eb87a';
    html.push('<div class="panel-om-sag" data-sag-id="' + escAttr(l.sag_id) + '" '
      + 'title="' + escAttr(l.sagTitle + ' \u2014 ' + (l.sagBudgetActivity || '')) + '" '
      + 'style="display:flex;align-items:center;gap:6px;padding:5px 6px;border-bottom:1px dashed var(--border);font-size:11.5px;">'
      + '<span style="display:inline-block;width:6px;height:14px;border-radius:2px;background:' + color + ';flex-shrink:0;"></span>'
      + '<code style="font-size:11px;color:var(--text-muted);flex-shrink:0;">' + escHtml(l.sagOrg || '') + '</code>'
      + '<span style="flex:1;min-width:0;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escHtml(l.sagTitle || l.sag_id) + '</span>'
      + '<strong style="font-size:11px;flex-shrink:0;">' + fmtBudget(l.sagFy26 || 0) + '</strong>'
      + '</div>');
  });
  html.push('</div>');
  if (sagLinks.length > topSags.length) {
    html.push('<div style="margin-top:6px;font-size:10.5px;color:var(--text-muted);">+ ' + (sagLinks.length - topSags.length) + ' more</div>');
  }

  // Suggestions row (mirror of PE suggestion CTA).
  var suggs = (typeof getSagSuggestionsForOffice === 'function') ? getSagSuggestionsForOffice(office.id) : [];
  if (suggs.length) {
    html.push('<div style="margin-top:10px;padding-top:8px;border-top:1px dashed var(--border);">');
    html.push('<div style="font-size:10.5px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">SAG suggestions <span style="color:var(--accent);text-transform:none;">(' + suggs.length + ')</span></div>');
    suggs.slice(0, 4).forEach(function(s){
      html.push('<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px;">'
        + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-muted);" title="' + escAttr(s.sagTitle) + '">' + escHtml(s.sagTitle) + '</span>'
        + '<a data-office-sag-claim="' + escAttr(s.sag_id) + '" data-office-id="' + escAttr(office.id) + '" style="color:var(--accent);cursor:pointer;font-size:10.5px;">Claim</a>'
        + '<a data-office-sag-dismiss="' + escAttr(s.sag_id) + '" data-office-id="' + escAttr(office.id) + '" style="color:var(--text-muted);cursor:pointer;font-size:10.5px;">Dismiss</a>'
        + '</div>');
    });
    html.push('</div>');
  }

  html.push('</div>');
  pb.insertAdjacentHTML('beforeend', html.join(''));

  // Wire suggestion handlers.
  pb.querySelectorAll('[data-office-sag-claim]').forEach(function(a){
    a.addEventListener('click', function(){
      var sid = a.getAttribute('data-office-sag-claim');
      var oid = a.getAttribute('data-office-id');
      linkSagToOffice(sid, oid, { source: 'manual', notes: 'claimed from office sag suggestions' })
        .then(function(){ renderOfficeOmPanel(office); });
    });
  });
  pb.querySelectorAll('[data-office-sag-dismiss]').forEach(function(a){
    a.addEventListener('click', function(){
      var sid = a.getAttribute('data-office-sag-dismiss');
      var oid = a.getAttribute('data-office-id');
      dismissSagOfficeSuggestion(sid, oid).then(function(){ renderOfficeOmPanel(office); });
    });
  });
  // (with the SAG highlighted), rather than opening a side drawer.
  pb.querySelectorAll('.panel-om-sag[data-sag-id]').forEach(function(row){
    row.style.cursor = 'pointer';
    row.addEventListener('click', function(){
      var sid = row.getAttribute('data-sag-id');
      if (!sid) return;
      closeDetailPanel();
      activateTab('budget', { budgetOfficeView: { officeId: office.id, sagId: sid } });
    });
  });
}

// -----------------------------------------------------------------
// Fragment 2: renderOfficeBudgetPanel. In the original monolith,
// the v79 budget-office-view state vars (_bovSelectedOfficeId etc.)
// sat between Fragment 1 and Fragment 2; those stay in classic
// script (kept there by v207 for binding-compat with the
// activateTab routeNav handler).
// -----------------------------------------------------------------
var _panelBudgetExpanded = {};
function renderOfficeBudgetPanel(office) {
  var pb = document.getElementById('panel-budget');
  if (!pb) return;
  var orgs = (DB.list && DB.list('budget_orgs')) || [];
  var pes = (DB.list && DB.list('budget_pes')) || [];
  if (!office || !orgs.length || !pes.length) {
    pb.style.display = 'none';
    pb.innerHTML = '';
    return;
  }
  //   even when budget_org_id is empty -- the linked PEs will populate the panel.
  var _hasManualLinks = false;
  if (!office.budget_org_id) {
    var _peLinks_v73 = (DB.list && DB.list('pe_office_links')) || [];
    for (var _i_v73 = 0; _i_v73 < _peLinks_v73.length; _i_v73++) {
      if (_peLinks_v73[_i_v73] && _peLinks_v73[_i_v73].office_id === office.id) { _hasManualLinks = true; break; }
    }
  }
  if (!office.budget_org_id && !_hasManualLinks) {
    pb.style.display = '';
    pb.innerHTML =
      '<div class="detail-label" style="margin-bottom:6px;">DoD Budget</div>' +
      '<div class="panel-budget-cta" style="padding:10px 12px;background:rgba(255,193,7,0.08);border:1px dashed rgba(255,193,7,0.45);border-radius:6px;color:var(--text-muted);font-size:11.5px;line-height:1.5;">' +
        'Tag this office to a DoD budget org to surface its RDT&amp;E + Procurement request, top PEs, and color-of-money breakdown.' +
        ' <a data-budget-cta="tag" style="color:var(--accent);cursor:pointer;text-decoration:underline;">Tag now \u2192</a>' +
      '</div>';
    var aTag = pb.querySelector('[data-budget-cta="tag"]');
    if (aTag) {
      aTag.addEventListener('click', function(e){
        e.preventDefault(); e.stopPropagation();
        closeDetailPanel();
        activateTab('offices');
        if (typeof editOffice === 'function') editOffice(office.id);
      });
    }
    return;
  }
  var b = computeOrgBudget(office.budget_org_id, office.id);
  if (!b) { pb.style.display = 'none'; pb.innerHTML = ''; return; }
  var bcArr = budgetOrgBreadcrumb(office.budget_org_id, { array: true }) || [];
  var bcFull = bcArr.join(' \u203A ');
  var fys = Object.keys(b.byFy).filter(function(f){ return f !== '?'; }).sort();
  var fyLabel;
  if (fys.length === 1) {
    fyLabel = 'FY' + String(fys[0]).slice(-2) + ' request';
  } else if (fys.length > 1) {
    fyLabel = 'Total request (FY' + String(fys[0]).slice(-2) + '\u2013FY' + String(fys[fys.length-1]).slice(-2) + ')';
  } else {
    fyLabel = 'Total request';
  }
  if (b.peCount === 0) {
    pb.style.display = '';
    pb.innerHTML =
      '<div class="detail-label" style="margin-bottom:6px;">DoD Budget</div>' +
      '<div class="panel-budget-empty" style="padding:8px 10px;background:var(--surface-alt);border:1px solid var(--border);border-radius:6px;font-size:11.5px;color:var(--text-muted);line-height:1.5;">' +
        'Tagged to <strong style="color:var(--text);">' + escHtml(bcFull) + '</strong>, but no PEs found under this org or its descendants.' +
      '</div>';
    return;
  }
  // _panelBudgetExpanded declaration above for why not pb.dataset).
  var expanded = _panelBudgetExpanded[office.id] === true;

  function bcHtml(arr) {
    return arr.map(function(seg, i){
      return '<span style="display:inline-block;font-size:10.5px;color:' + (i === arr.length-1 ? 'var(--text)' : 'var(--text-muted)') + ';">'
           + escHtml(seg) + (i < arr.length-1 ? ' \u203A ' : '') + '</span>';
    }).join('');
  }
  var html = [];
  html.push('<div class="detail-label" style="margin-bottom:6px;">DoD Budget</div>');
  html.push('<div class="panel-budget-card" style="padding:10px 12px;background:var(--surface-alt);border:1px solid var(--border);border-radius:6px;">');
  // Breadcrumb (full chain, wrap-friendly).
  html.push('<div style="margin-bottom:6px;line-height:1.55;display:flex;flex-wrap:wrap;gap:2px 0;" title="' + escAttr(bcFull) + '">' + bcHtml(bcArr) + '</div>');
  html.push('<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:8px;flex-wrap:wrap;">');
  html.push('<div style="font-size:18px;font-weight:700;color:var(--text);font-family:var(--font-display);">' + fmtBudget(b.totalReq) + '</div>');
  html.push('<div style="font-size:10.5px;color:var(--text-muted);">' + escHtml(fyLabel) + ' \u00b7 ' + b.peCount + ' PE' + (b.peCount===1?'':'s') + '</div>');
  html.push('</div>');
  if (b.byBa.length) {
    html.push('<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:10px;">');
    b.byBa.forEach(function(row){
      var label = row.ba ? ('BA ' + row.ba) : '?';
      html.push('<span class="panel-budget-chip" title="' + escAttr((row.ba_name || '') + ' \u2014 ' + fmtBudget(row.total)) + '" '
        + 'style="display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:10px;font-size:10.5px;background:var(--surface-2);border:1px solid var(--border);">'
        + '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (row.color || 'var(--text-muted)') + ';"></span>'
        + '<strong>' + escHtml(label) + '</strong>'
        + ' <span style="color:var(--text-muted);">' + fmtBudget(row.total) + '</span>'
        + '</span>');
    });
    html.push('</div>');
  }

  if (!expanded) {
    // Compact: top 5 PEs.
    html.push('<div style="font-size:10.5px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:4px;">Top PEs</div>');
    html.push('<div class="panel-budget-pes">');
    var apprs = (DB.list && DB.list('budget_appropriations')) || [];
    var apprById = {}; apprs.forEach(function(a){ apprById[a.id] = a; });
    b.topPes.forEach(function(pe){
      var ap = apprById[pe.appropriation_id];
      var color = (ap && ap.display_color) || 'var(--text-muted)';
      html.push('<div class="panel-budget-pe" data-pe-id="' + escAttr(pe.id) + '" '
        + 'style="display:flex;align-items:center;gap:6px;padding:5px 6px;border-bottom:1px dashed var(--border);font-size:11.5px;cursor:pointer;">'
        + '<span style="display:inline-block;width:6px;height:14px;border-radius:2px;background:' + color + ';flex-shrink:0;"></span>'
        + '<code style="font-size:11px;color:var(--text);flex-shrink:0;">' + escHtml(pe.id) + '</code>'
        + '<span style="flex:1;min-width:0;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escAttr(pe.title || '') + '">' + escHtml(pe.title || '') + '</span>'
        + '<strong style="font-size:11px;flex-shrink:0;">' + fmtBudget(pe.request_amount) + '</strong>'
        + '</div>');
    });
    html.push('</div>');
    html.push('<div style="margin-top:8px;display:flex;gap:8px;justify-content:space-between;align-items:center;">');
    html.push('<a data-budget-cta="expand" style="font-size:11px;color:var(--accent);cursor:pointer;text-decoration:none;">\u25BC Expand details</a>');
    html.push('<a data-budget-cta="view-all" style="font-size:11.5px;color:var(--accent);cursor:pointer;text-decoration:none;">View in Budget tab \u2192</a>');
    html.push('</div>');
  } else {
    // Expanded: all PEs grouped by BA + sub-org rollup table.
    var apprs2 = (DB.list && DB.list('budget_appropriations')) || [];
    var apprById2 = {}; apprs2.forEach(function(a){ apprById2[a.id] = a; });
    var pes2 = DB.list('budget_pes') || [];
    var rs = b.rollupSet || {};
    // not just rollup descent. PAE-MC reproducer: all of its PEs are direct-linked,
    // so the original rollup-only filter rendered an empty expanded view.
    var _v77_dismissedPes = new Set();
    ((DB.list && DB.list('pe_office_link_dismissals')) || []).forEach(function(d){
      if (d && d.office_id === office.id && d.pe_id) _v77_dismissedPes.add(d.pe_id);
    });
    var _v77_directLinkedPeIds = new Set();
    ((DB.list && DB.list('pe_office_links')) || []).forEach(function(l){
      if (l && l.office_id === office.id && l.pe_id && !_v77_dismissedPes.has(l.pe_id)) {
        _v77_directLinkedPeIds.add(l.pe_id);
      }
    });
    var allPes = pes2.filter(function(pe){
      return (pe.owning_org_id && rs[pe.owning_org_id]) || _v77_directLinkedPeIds.has(pe.id);
    });
    var byBaPes = {};
    allPes.forEach(function(pe){
      var ap = apprById2[pe.appropriation_id];
      if (!ap) return;
      (byBaPes[ap.id] = byBaPes[ap.id] || { ap: ap, pes: [] }).pes.push(pe);
    });
    var baKeys = Object.keys(byBaPes).sort(function(a,b){
      return (byBaPes[a].ap.ba || '').localeCompare(byBaPes[b].ap.ba || '', undefined, {numeric:true});
    });
    html.push('<div style="font-size:10.5px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px;margin:6px 0 4px 0;">All PEs by Budget Activity</div>');
    baKeys.forEach(function(k){
      var ap = byBaPes[k].ap;
      var pesB = byBaPes[k].pes.slice().sort(function(x,y){ return (Number(y.request_amount)||0) - (Number(x.request_amount)||0); });
      var subTotal = pesB.reduce(function(s, p){ return s + (Number(p.request_amount)||0); }, 0);
      html.push('<div style="margin-top:6px;padding:4px 8px;background:var(--surface-2);border-left:3px solid ' + (ap.display_color || 'var(--text-muted)') + ';font-size:11px;display:flex;justify-content:space-between;">'
              + '<strong>BA ' + escHtml(ap.ba || '?') + ' \u00b7 ' + escHtml(ap.ba_name || '') + '</strong>'
              + '<span style="color:var(--text-muted);">' + fmtBudget(subTotal) + ' \u00b7 ' + pesB.length + ' PE' + (pesB.length===1?'':'s') + '</span>'
              + '</div>');
      pesB.forEach(function(pe){
        html.push('<div class="panel-budget-pe" data-pe-id="' + escAttr(pe.id) + '" '
          + 'style="display:flex;align-items:center;gap:6px;padding:4px 6px;border-bottom:1px dashed var(--border);font-size:11px;cursor:pointer;">'
          + '<code style="font-size:10.5px;color:var(--text);flex-shrink:0;">' + escHtml(pe.id) + '</code>'
          + '<span style="flex:1;min-width:0;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escAttr(pe.title || '') + '">' + escHtml(pe.title || '') + '</span>'
          + '<strong style="font-size:10.5px;flex-shrink:0;">' + fmtBudget(pe.request_amount) + '</strong>'
          + '</div>');
      });
    });
    // Sub-org rollup: descendants of office.budget_org_id (1 hop down).
    var allOrgs = orgs;
    var directChildren = allOrgs.filter(function(o){ return o.parent_id === office.budget_org_id; });
    if (directChildren.length) {
      var directMap = {};
      pes2.forEach(function(pe){
        if (!pe.owning_org_id) return;
        directMap[pe.owning_org_id] = (directMap[pe.owning_org_id] || 0) + (Number(pe.request_amount)||0);
      });
      var rollupMap = _buildBudgetOrgRollup();
      var childRows = directChildren.map(function(co){
        var ids = rollupMap[co.id] || [co.id];
        var t = 0, c = 0;
        ids.forEach(function(id){
          if (directMap[id]) { t += directMap[id]; c++; }
        });
        return { org: co, total: t, count: c };
      }).filter(function(r){ return r.total > 0; }).sort(function(a,b){ return b.total - a.total; });
      var directHere = directMap[office.budget_org_id] || 0;
      if (childRows.length || directHere > 0) {
        html.push('<div style="font-size:10.5px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.4px;margin:10px 0 4px 0;">Where the money sits</div>');
        if (directHere > 0) {
          html.push('<div style="display:flex;justify-content:space-between;font-size:11px;padding:3px 6px;border-bottom:1px dashed var(--border);">'
                  + '<span><strong>directly on this node</strong> <span style="color:var(--text-dim);">(' + escHtml(bcArr[bcArr.length-1] || '?') + ')</span></span>'
                  + '<strong>' + fmtBudget(directHere) + '</strong></div>');
        }
        childRows.forEach(function(r){
          html.push('<div class="panel-budget-suborg" data-org-id="' + escAttr(r.org.id) + '" '
                  + 'style="display:flex;justify-content:space-between;font-size:11px;padding:3px 6px;border-bottom:1px dashed var(--border);cursor:pointer;">'
                  + '<span>' + escHtml(r.org.name || r.org.id) + ' <span style="color:var(--text-dim);font-size:10px;">(' + r.count + ' PE' + (r.count===1?'':'s') + ')</span></span>'
                  + '<strong>' + fmtBudget(r.total) + '</strong></div>');
        });
        html.push('<div style="margin-top:6px;font-size:10px;color:var(--text-dim);line-height:1.4;">'
                + 'If most of the money sits in a child org, consider re-tagging this office to that node.'
                + '</div>');
      }
    }
    html.push('<div style="margin-top:10px;display:flex;gap:8px;justify-content:space-between;align-items:center;">');
    html.push('<a data-budget-cta="collapse" style="font-size:11px;color:var(--accent);cursor:pointer;text-decoration:none;">\u25B2 Collapse</a>');
    html.push('<a data-budget-cta="view-all" style="font-size:11.5px;color:var(--accent);cursor:pointer;text-decoration:none;">View in Budget tab \u2192</a>');
    html.push('</div>');
  }
  html.push('</div>');
  pb.style.display = '';
  pb.innerHTML = html.join('');
  _panelBudgetExpanded[office.id] = !!expanded;

  pb.querySelectorAll('.panel-budget-pe').forEach(function(row){
    row.addEventListener('click', function(e){
      e.preventDefault(); e.stopPropagation();
      var peId = row.dataset.peId;
      closeDetailPanel();
      activateTab('budget', { budgetPe: peId });
    });
  });
  pb.querySelectorAll('.panel-budget-suborg').forEach(function(row){
    row.addEventListener('click', function(e){
      e.preventDefault(); e.stopPropagation();
      var oid = row.dataset.orgId;
      closeDetailPanel();
      activateTab('budget', { budgetOrg: oid });
    });
  });
  var aExpand = pb.querySelector('[data-budget-cta="expand"]');
  if (aExpand) aExpand.addEventListener('click', function(e){
    e.preventDefault(); e.stopPropagation();
    _panelBudgetExpanded[office.id] = true;
    renderOfficeBudgetPanel(office);
    // #panel-budget innerHTML, so the card we appended in v76 is gone.
    if (typeof renderOfficeOmPanel === 'function') {
      try { renderOfficeOmPanel(office); } catch (e2) { console.warn('[v83] re-render OM after expand failed', e2); }
    }
  });
  var aCollapse = pb.querySelector('[data-budget-cta="collapse"]');
  if (aCollapse) aCollapse.addEventListener('click', function(e){
    e.preventDefault(); e.stopPropagation();
    _panelBudgetExpanded[office.id] = false;
    renderOfficeBudgetPanel(office);
    if (typeof renderOfficeOmPanel === 'function') {
      try { renderOfficeOmPanel(office); } catch (e2) { console.warn('[v83] re-render OM after collapse failed', e2); }
    }
  });
  var aAll = pb.querySelector('[data-budget-cta="view-all"]');
  if (aAll) {
    aAll.addEventListener('click', function(e){
      e.preventDefault(); e.stopPropagation();
      closeDetailPanel();
      activateTab('budget', { budgetOrg: office.budget_org_id });
    });
  }
}


// -----------------------------------------------------------------
// Fragment 3: _renderPeOfficePicker. In the original monolith, the
// _budgetForceExpand, _budgetEnsureExpandedDefaults) sat between
// Fragment 2 and Fragment 3; those stay in classic script (kept
// there by v204 for window-globalThis interop with budget-tree.js).
// -----------------------------------------------------------------
function _renderPeOfficePicker(peId, picker, filter) {
  if (!picker) return;
  var listEl = picker.querySelector('[data-pe-office-list="' + (window.CSS && CSS.escape ? CSS.escape(peId) : peId) + '"]');
  if (!listEl) return;
  var q = (filter || '').trim().toLowerCase();
  var assigned = new Set(getOfficesForPe(peId).map(function(a){ return a.office_id; }));
  var rows = ((DB.list && DB.list('offices')) || []).filter(function(o){
    if (!o || !o.id) return false;
    if (assigned.has(o.id)) return false;
    if (!q) return true;
    var blob = ((o.name || '') + ' ' + (o.id || '') + ' ' + (o.service || '')).toLowerCase();
    return blob.indexOf(q) >= 0;
  }).slice(0, 30);
  if (!rows.length) {
    listEl.innerHTML = '<div style="padding:6px 4px;color:var(--text-muted);font-size:11.5px;font-style:italic;">No matches.</div>';
    return;
  }
  listEl.innerHTML = rows.map(function(o){
    return '<a data-pe-pick-office="' + escAttr(o.id) + '" data-pe-id="' + escAttr(peId) + '" style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:5px 6px;cursor:pointer;border-radius:4px;text-decoration:none;color:var(--text);">'
      + '<span><strong style="font-size:11.5px;">' + escHtml(o.name || o.id) + '</strong> <span style="color:var(--text-muted);font-size:10.5px;">' + escHtml(o.id) + '</span></span>'
      + '<span style="color:var(--text-muted);font-size:10.5px;">' + escHtml(o.service || '') + '</span>'
      + '</a>';
  }).join('');
  // Hover/active styles + click handler.
  listEl.querySelectorAll('[data-pe-pick-office]').forEach(function(a){
    a.addEventListener('mouseenter', function(){ a.style.background = 'var(--surface)'; });
    a.addEventListener('mouseleave', function(){ a.style.background = ''; });
    a.addEventListener('click', function(ev){
      ev.preventDefault(); ev.stopPropagation();
      var pid = a.getAttribute('data-pe-id');
      var oid = a.getAttribute('data-pe-pick-office');
      linkPeToOffice(pid, oid, { source: 'manual' }).then(function(){
        if (typeof renderBudget === 'function') renderBudget();
      });
    });
  });
}

// the SAG side of the budget tree (O&M lines). Same DOM/event pattern,
// renamed attrs (data-sag-* instead of data-pe-*) and uses
// linkSagToOffice / getOfficesForSag for the data layer. Previously
// SAGs had no inline office-tagging UI -- the v228 bug report.
function _renderSagOfficePicker(sagId, picker, filter) {
  if (!picker) return;
  var listEl = picker.querySelector('[data-sag-office-list="' + (window.CSS && CSS.escape ? CSS.escape(sagId) : sagId) + '"]');
  if (!listEl) return;
  var q = (filter || '').trim().toLowerCase();
  var assigned = new Set(getOfficesForSag(sagId).map(function(a){ return a.office_id; }));
  var rows = ((DB.list && DB.list('offices')) || []).filter(function(o){
    if (!o || !o.id) return false;
    if (assigned.has(o.id)) return false;
    if (!q) return true;
    var blob = ((o.name || '') + ' ' + (o.id || '') + ' ' + (o.service || '')).toLowerCase();
    return blob.indexOf(q) >= 0;
  }).slice(0, 30);
  if (!rows.length) {
    listEl.innerHTML = '<div style="padding:6px 4px;color:var(--text-muted);font-size:11.5px;font-style:italic;">No matches.</div>';
    return;
  }
  listEl.innerHTML = rows.map(function(o){
    return '<a data-sag-pick-office="' + escAttr(o.id) + '" data-sag-id="' + escAttr(sagId) + '" style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:5px 6px;cursor:pointer;border-radius:4px;text-decoration:none;color:var(--text);">'
      + '<span><strong style="font-size:11.5px;">' + escHtml(o.name || o.id) + '</strong> <span style="color:var(--text-muted);font-size:10.5px;">' + escHtml(o.id) + '</span></span>'
      + '<span style="color:var(--text-muted);font-size:10.5px;">' + escHtml(o.service || '') + '</span>'
      + '</a>';
  }).join('');
  listEl.querySelectorAll('[data-sag-pick-office]').forEach(function(a){
    a.addEventListener('mouseenter', function(){ a.style.background = 'var(--surface)'; });
    a.addEventListener('mouseleave', function(){ a.style.background = ''; });
    a.addEventListener('click', function(ev){
      ev.preventDefault(); ev.stopPropagation();
      var sid = a.getAttribute('data-sag-id');
      var oid = a.getAttribute('data-sag-pick-office');
      linkSagToOffice(sid, oid, { source: 'manual' }).then(function(){
        if (typeof renderBudget === 'function') renderBudget();
      });
    });
  });
}




// -----------------------------------------------------------------
// Fragment 4: renderOfficeSuggestionsPanel. Contiguous with
// Fragment 3 in the original monolith except for blank lines.
// -----------------------------------------------------------------
// Surfaces J-Book PE matches that aren't yet linked or dismissed.
function renderOfficeSuggestionsPanel(office) {
  var pb = document.getElementById('panel-budget');
  if (!pb || !office) return;
  if (typeof getSuggestionsForOffice !== 'function') return;
  var suggs = getSuggestionsForOffice(office.id);
  if (!suggs.length) return;
  // Build container (appended below the existing budget card).
  var div = document.createElement('div');
  div.setAttribute('data-office-sugg', office.id);
  div.style.marginTop = '10px';
  div.innerHTML =
    '<div class="detail-label" style="margin-bottom:6px;">PE Suggestions (' + suggs.length + ')</div>'
    + '<div style="padding:8px 10px;background:var(--surface-alt);border:1px solid var(--border);border-radius:6px;font-size:11.5px;line-height:1.45;color:var(--text-muted);">'
    +   'Found in J-Book narrative; not yet linked to this office. Claim or dismiss each:'
    +   '<div data-office-sugg-list="' + escAttr(office.id) + '" style="margin-top:8px;max-height:260px;overflow-y:auto;"></div>'
    + '</div>';
  pb.appendChild(div);
  var list = div.querySelector('[data-office-sugg-list]');
  list.innerHTML = suggs.slice(0, 20).map(function(s){
    var kindBadge = s.match_kind === 'title' ? '<span style="color:var(--accent);font-weight:600;">title</span>'
                  : s.match_kind === 'description' ? '<span>desc</span>'
                  : '<span>project</span>';
    return '<div style="display:flex;align-items:baseline;gap:6px;padding:5px 0;border-top:1px dotted var(--border);font-size:11.5px;color:var(--text);">'
      + '<span style="flex:1;"><code style="font-size:10.5px;">' + escHtml(s.pe_id) + '</code> ' + escHtml(s.peTitle) + '</span>'
      + '<span style="color:var(--text-muted);font-size:10px;">' + kindBadge + '</span>'
      + '<a data-office-sugg-claim="' + escAttr(s.pe_id) + '" data-office-id="' + escAttr(office.id) + '" style="color:var(--accent);cursor:pointer;font-size:11px;text-decoration:none;font-weight:500;">Claim</a>'
      + '<a data-office-sugg-dismiss="' + escAttr(s.pe_id) + '" data-office-id="' + escAttr(office.id) + '" style="color:var(--text-muted);cursor:pointer;font-size:11px;text-decoration:none;">Dismiss</a>'
      + '</div>';
  }).join('');
  if (suggs.length > 20) {
    list.insertAdjacentHTML('beforeend', '<div style="padding:6px 0;font-size:11px;color:var(--text-muted);font-style:italic;">+ ' + (suggs.length - 20) + ' more not shown</div>');
  }
  list.querySelectorAll('[data-office-sugg-claim]').forEach(function(a){
    a.addEventListener('click', function(ev){
      ev.preventDefault(); ev.stopPropagation();
      var pid = a.getAttribute('data-office-sugg-claim');
      var oid = a.getAttribute('data-office-id');
      linkPeToOffice(pid, oid, { source: 'manual', notes: 'claimed from office suggestions' }).then(function(){
        var off = DB.get('offices', oid);
        if (off && typeof renderOfficeBudgetPanel === 'function') {
          renderOfficeBudgetPanel(off);
          renderOfficeSuggestionsPanel(off);
        }
      });
    });
  });
  list.querySelectorAll('[data-office-sugg-dismiss]').forEach(function(a){
    a.addEventListener('click', function(ev){
      ev.preventDefault(); ev.stopPropagation();
      var pid = a.getAttribute('data-office-sugg-dismiss');
      var oid = a.getAttribute('data-office-id');
      dismissPeOfficeSuggestion(pid, oid).then(function(){
        var off = DB.get('offices', oid);
        if (off && typeof renderOfficeBudgetPanel === 'function') {
          renderOfficeBudgetPanel(off);
          renderOfficeSuggestionsPanel(off);
        }
      });
    });
  });
}


// =================================================================
// =================================================================
window.renderOfficeOmPanel = renderOfficeOmPanel;
window.renderOfficeBudgetPanel = renderOfficeBudgetPanel;
window._renderPeOfficePicker = _renderPeOfficePicker;
window._renderSagOfficePicker = _renderSagOfficePicker;
window.renderOfficeSuggestionsPanel = renderOfficeSuggestionsPanel;
