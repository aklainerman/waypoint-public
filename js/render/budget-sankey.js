// js/render/budget-sankey.js
//
// graph-build helper + hierarchy-drill helper. Two non-contiguous
// inline fragments fused into one module:
//
//   Fragment A (originally lines 22931-23293 of post-v204 source):
//     * v55 Sankey banner comment block
//     * var _budgetSankeyState { thresholdM, hoveredKey,
//                                 expandedBas, expandedAccts }
//     * function _budgetSankeyBuildGraph(threshold) -- builds the
//       Service > Account > BA > PE graph from DB tables; honors
//       threshold; buckets sub-threshold PEs into "Other (N PEs)"
//       nodes; v56 tag-status badges + DoD Budget Org grouping.
//
//   Fragment B (originally lines 23502-23934 of post-v204 source):
//     * function renderBudgetSankey() -- D3 + d3-sankey driver,
//       reads state, calls buildGraph, renders <svg> + tooltip,
//       wires hover / drill / threshold-slider / BA-and-acct
//       expand-collapse (mutates _budgetSankeyState).
//     * function _budgetSankeyDrillTo(n) -- switches to Hierarchy
//       View sub-tab and force-expands the target via
//       window._budgetExpanded.
//
// Originally at file-scope of the inline monolith; lifted to ES
// module in v205. Same classic-script-split pattern as v181-v204.
//
// Pre-extraction audit (v185 pattern). External callers (callers
// outside the extracted fragments):
//   renderBudgetSankey   -- 7 sites (5 in js/scout/scout-client.js,
//                            2 in index.html outside cluster)
//   _budgetSankeyState   -- 6 sites in js/scout/scout-client.js
//                            (already accesses via window._budgetSankeyState)
//   _budgetSankeyBuildGraph / _budgetSankeyDrillTo -- 0 external
//                            (only called from within this module)
//
// External file-scope refs consumed (resolved via globalThis or
// runtime call-site lookup; no module-load-time deps):
//   _budgetExpanded     (classic-script var, hoisted to window;
//                         single bare write at drillTo rewritten
//                         to window._budgetExpanded; all other
//                         interactions are .add()/.has()/.delete()
//                         method calls on the shared Set instance)
//   DB                  (window global)
//   d3 / d3-sankey      (CDN globals on window)
//   renderBudget        (v204 budget-tree.js; resolves via
//                         globalThis; flows through v153 narrative-
//                         fill wrapper because the wrapper replaced
//                         window.renderBudget post-load)
//   escAttr, escHtml, fmtBudget, fmtCompact, svcFromAppr
//                       (classic-script helpers; auto-hoisted)
//
// Module-internal helpers (NOT exposed): _budgetSankeyBuildGraph,
// _budgetSankeyDrillTo, and the various inner closures inside the
// two big functions.

// =================================================================
// BUDGET TAB (v55) -- Sankey Diagram sub-tab. (v56 adds Tag Offices.)
//   D3 + d3-sankey rendered into #budgetSankeyWrap. Flow:
//     Service -> Account -> BA -> PE
//   Phase 4 (v56) adds tag-status badges + DoD Budget Org picker.
//   Threshold input controls the minimum PE request_amount to show as its own
//   leaf; PEs below threshold within a BA are bucketed into a synthetic
//   "Other (N PEs)" node so the chart stays legible at the 277-PE seed scale.
// =================================================================
var _budgetSankeyState = {
  thresholdM: 100,        // default: hide PE leaves under $100M
  hoveredKey: null,
  expandedBas: null,      // Set of baKeys currently showing PE leaves; null = none expanded
  expandedAccts: null,    // v66: Set of acctKeys currently showing BAs; null = none expanded (default)
};

function _budgetSankeyBuildGraph(threshold) {
  var pes = DB.list('budget_pes') || [];
  var apprs = DB.list('budget_appropriations') || [];
  var orgs = DB.list('budget_orgs') || [];
  var apprById = {}; apprs.forEach(function(a){ apprById[a.id] = a; });
  var orgById = {}; orgs.forEach(function(o){ orgById[o.id] = o; });

  var SERVICE_ORDER = ['Defense Wide', 'Air Force', 'Army', 'Navy'];
  function _serviceLabel(raw) {
    if (!raw) return 'Defense Wide';
    var s = String(raw).trim();
    var u = s.toUpperCase();
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
    return 'Defense Wide'; // catch-all for orphan suffixes
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

  // First pass: bucket PEs into (svc, acct, ba) using consolidated svc labels.
  var byBa = {}; // baKey -> { ap, svcKey, acctKey, items:[] }
  pes.forEach(function(pe){
    var ap = apprById[pe.appropriation_id]; if (!ap) return;
    var svcKey = _serviceLabel(svcFromAppr(ap));
    var acctKey = ap.account || '?';
    var baKey = ap.id;
    var b = byBa[baKey] || (byBa[baKey] = { ap: ap, svcKey: svcKey, acctKey: acctKey, items: [] });
    b.items.push(pe);
  });

  // emits Defense-Wide -> O&M,Defense-Wide -> BA-01/03/04 -> SAG flows
  // alongside the existing RDT&E + Procurement PE flows.
  // budget tree header (no umbrella+sib double-count).
  var sags = (DB.list && DB.list('budget_om_sags')) || [];
  var _sagDedupSankey = (window._v151SagDedupAmt && apprById)
    ? window._v151SagDedupAmt(sags, (window._budgetYear || 2026), apprById)
    : null;
  sags.forEach(function(sag){
    if (!sag || !sag.appropriation_id) return;
    var ap = apprById[sag.appropriation_id];
    if (!ap) return;
    // O&M SAGs are all Defense-Wide (consolidated to "Defense Wide" by
    // _serviceLabel). Account label comes from the appropriation row,
    // typically "O&M,Defense-Wide".
    var svcKey = _serviceLabel(svcFromAppr(ap));
    var acctKey = ap.account || 'O&M,Defense-Wide';
    var baKey = ap.id;
    var synthetic = {
      id: sag.sag_short_code || sag.id,
      title: sag.sag_title || sag.id,
      request_amount: (_sagDedupSankey
                       ? (_sagDedupSankey.get(sag.id) || 0)
                       : (window._v150SagAmt ? window._v150SagAmt(sag) : (Number(sag.fy26_estimate) || 0))),
      // Mark for downstream consumers (hover tooltips etc.) — currently a no-op
      // because the rest of the build only reads .id/.title/.request_amount.
      _isSag: true,
      _sagId: sag.id,
      _sagOrg: sag.defense_wide_org || ''
    };
    var b = byBa[baKey] || (byBa[baKey] = { ap: ap, svcKey: svcKey, acctKey: acctKey, items: [] });
    b.items.push(synthetic);
  });

  // so the Sankey reflects the full FY26 topline (~$961.6B) and not just
  // PEs+SAGs (~$683B). Skips ReconciliationOnly + Cemeterial + balancing rows
  // (NULL appropriation_id).
  var _svcLabel = function(svc) {
    if (svc === 'Army') return 'Army';
    if (svc === 'Navy' || svc === 'MarineCorps') return 'Navy';
    if (svc === 'AirForce' || svc === 'SpaceForce') return 'Air Force';
    return 'Defense Wide';
  };
  var topline = (DB.list && DB.list('budget_topline_lines')) || [];
  topline.forEach(function(row){
    if (!row || !row.appropriation_id) return;
    var at = row.account_type;
    if (at === 'ReconciliationOnly' || at === 'Cemeterial') return;
    var amt = (window._v150ToplineAmt ? window._v150ToplineAmt(row) : (Number(row.fy26_total) || 0));
    if (!isFinite(amt) || amt === 0) return;
    var ap = apprById[row.appropriation_id];
    if (!ap) return;
    var svcKey = _svcLabel(row.service);
    var acctKey = ap.account || at || '?';
    var baKey = ap.id;
    var compSuffix = (row.component && row.component !== 'NA' && row.component !== 'Total')
      ? ' (' + row.component + ')' : '';
    var noteSuffix = (row.notes && row.notes.indexOf('Medicare') >= 0) ? ' — Medicare' : '';
    var ba = (row.ba && row.ba !== 'NA') ? (' [' + row.ba + ']') : '';
    var synthetic = {
      id: row.id,
      title: (row.title || row.id) + compSuffix + noteSuffix + ba,
      request_amount: amt,
      _isTopline: true,
      _toplineId: row.id,
      _accountType: at
    };
    var b = byBa[baKey] || (byBa[baKey] = { ap: ap, svcKey: svcKey, acctKey: acctKey, items: [] });
    b.items.push(synthetic);
  });

  var nodes = [];
  var nodeIdx = {};

  // - svc: index in SERVICE_ORDER (any unknown -> end)
  // - acct: alphabetical within each svc (sequential global counter walks
  //         services in SERVICE_ORDER, then accounts alphabetically)
  // - ba/pe: numeric/alpha by id (BA number, PE id)
  function _svcRank(s) {
    var i = SERVICE_ORDER.indexOf(s);
    return i < 0 ? 999 : i;
  }
  // Collect service -> set of accounts present in data.
  var _svcAccts = {};
  Object.keys(byBa).forEach(function(k){
    var b = byBa[k];
    (_svcAccts[b.svcKey] = _svcAccts[b.svcKey] || {})[b.acctKey] = 1;
  });
  // Acct global rank: walk services in SERVICE_ORDER, accounts alphabetical.
  var _acctRank = {}; // acctKey-by-svc -> rank
  var _acctCtr = 0;
  SERVICE_ORDER.concat(Object.keys(_svcAccts).filter(function(s){ return SERVICE_ORDER.indexOf(s) < 0; }))
    .forEach(function(svc){
      if (!_svcAccts[svc]) return;
      Object.keys(_svcAccts[svc]).sort(function(a,b){ return a.localeCompare(b); })
        .forEach(function(acct){
          _acctRank[svc + '|' + acct] = _acctCtr++;
        });
    });

  function nodeId(prefix, key, label, meta) {
    var id = prefix + ':' + key;
    if (id in nodeIdx) return nodeIdx[id];
    var i = nodes.length;
    nodeIdx[id] = i;
    var ord;
    if (prefix === 'svc')      ord = _svcRank(key);
    else if (prefix === 'acct') ord = (meta && meta._acctRank != null) ? meta._acctRank : nodes.length;
    else                        ord = nodes.length; // ba/pe/other handled by per-leaf sort upstream
    nodes.push(Object.assign({ id: id, kind: prefix, key: key, label: label, value: 0, _order: ord }, meta || {}));
    return i;
  }
  var links = [];

  // Iterate BAs in service-major, account-alpha, BA-number order so the
  // ba/pe/other _order values (= insertion index) match the desired layout.
  var baKeysSorted = Object.keys(byBa).sort(function(a, b){
    var ba = byBa[a], bb = byBa[b];
    var sa = _svcRank(ba.svcKey), sb = _svcRank(bb.svcKey);
    if (sa !== sb) return sa - sb;
    var ar = _acctRank[ba.svcKey + '|' + ba.acctKey];
    var br = _acctRank[bb.svcKey + '|' + bb.acctKey];
    if (ar !== br) return ar - br;
    var an = (ba.ap && ba.ap.ba) || '';
    var bn = (bb.ap && bb.ap.ba) || '';
    return an.localeCompare(bn, undefined, { numeric: true });
  });

  var expanded = (_budgetSankeyState && _budgetSankeyState.expandedBas) || null;

  // the svc + acct rectangles are visible (with svc->acct flows). Click
  // an acct rect to reveal its BAs (and from there, BA -> PE leaves).
  var acctExpanded = (_budgetSankeyState && _budgetSankeyState.expandedAccts) || null;
  function _isAcctExpanded(k) {
    return !!(acctExpanded && acctExpanded.has && acctExpanded.has(k));
  }

  // We use this to emit the svc->acct link with the FULL acct value
  // even when the acct is collapsed (no acct->ba links to sum from).
  var _acctTotals = {};
  Object.keys(byBa).forEach(function(_k){
    var _b = byBa[_k];
    var _t = 0;
    for (var _j = 0; _j < _b.items.length; _j++) _t += Number(_b.items[_j].request_amount) || 0;
    if (_t > 0) {
      var _ak = _b.svcKey + '|' + _b.acctKey;
      _acctTotals[_ak] = (_acctTotals[_ak] || 0) + _t;
    }
  });

  // Track which (svc, acct) pairs we've already emitted a svc->acct link
  // for, so we only push it once per acct (not once per BA in that acct).
  var _emittedSvcAcct = {};

  baKeysSorted.forEach(function(baKey){
    var b = byBa[baKey];
    var ap = b.ap;
    var isExpanded = !!(expanded && expanded.has && expanded.has(baKey));

    // PEs sum to zero (e.g. v60 P-1 seed has 4 zero-total appropriations),
    // skip it entirely so we don't strand orphan svc/acct/ba nodes in
    // column 0 of the Sankey (d3-sankeyLeft default for nodes with no
    // in/out links).
    var items = b.items.slice().sort(function(a, c){
      return String(a.id).localeCompare(String(c.id), undefined, { numeric: true });
    });
    var precompTotal = 0;
    for (var _i = 0; _i < items.length; _i++) {
      precompTotal += Number(items[_i].request_amount) || 0;
    }
    if (precompTotal <= 0) return; // skip orphan-producing BAs

    var svcIdx = nodeId('svc', b.svcKey, b.svcKey);

    // for the click handler. Since multiple BAs share an acct, only the
    // first call's label "wins" inside nodeId() — that's fine, the label
    // we pass is deterministic across iterations.
    var _acctIsExp = _isAcctExpanded(b.acctKey);
    var _acctLabel = (_acctIsExp ? '\u25bc ' : '\u25b6 ') + b.acctKey;
    var acctIdx = nodeId('acct', b.acctKey, _acctLabel, {
      _acctRank: _acctRank[b.svcKey + '|' + b.acctKey],
      expanded: _acctIsExp,
      svcKey: b.svcKey
    });

    // precomputed total. This keeps the acct rect visible (with its full
    // flow value from the svc) regardless of expansion state.
    var _saKey = b.svcKey + '|' + b.acctKey;
    if (!_emittedSvcAcct[_saKey]) {
      _emittedSvcAcct[_saKey] = 1;
      var _saTotal = _acctTotals[_saKey] || precompTotal;
      links.push({ source: svcIdx, target: acctIdx, value: _saTotal, color: ap.display_color, kind: 'svc_acct' });
    }

    // acct->ba link. The svc and acct rects + svc->acct flow remain.
    if (!_acctIsExp) return;

    // (MILPERS, MILCON, DHP, FH, tail accounts from budget_topline_lines).
    // Avoids showing "BA null · null" in the Sankey middle column.
    var baLabel;
    if (ap.ba || ap.ba_name) {
      baLabel = (isExpanded ? '\u25bc ' : '\u25b6 ') + 'BA ' + (ap.ba || '?') + ' \u00b7 ' + (ap.ba_name || '');
    } else {
      baLabel = (isExpanded ? '\u25bc ' : '\u25b6 ') + (ap.account || ap.title || 'Unspecified');
    }
    var baIdx = nodeId('ba', baKey, baLabel, { color: ap.display_color, ba: ap.ba, expanded: isExpanded });

    var aboveTotal = 0, belowTotal = 0, belowCount = 0;
    items.forEach(function(pe){
      var amt = Number(pe.request_amount) || 0;
      if (!isExpanded) { aboveTotal += amt; return; }
      if (amt >= threshold) {
        var peIdx = nodeId('pe', pe.id, pe.id + ' \u00b7 ' + (pe.title || ''), { peId: pe.id, title: pe.title, baKey: baKey, color: ap.display_color, _isSag: !!pe._isSag, _sagId: pe._sagId || null, _sagOrg: pe._sagOrg || '' });
        links.push({ source: baIdx, target: peIdx, value: Math.max(amt, 1), color: ap.display_color, kind: 'ba_pe' });
        aboveTotal += amt;
      } else {
        belowTotal += amt;
        belowCount += 1;
      }
    });

    if (isExpanded && belowCount > 0 && belowTotal > 0) {
      var otherKey = baKey + ':other';
      var otherIdx = nodeId('other', otherKey, 'Other (' + belowCount + ' PEs)', { baKey: baKey, color: ap.display_color });
      links.push({ source: baIdx, target: otherIdx, value: belowTotal, color: ap.display_color, kind: 'ba_other' });
    }

    var total = aboveTotal + belowTotal;
    if (total > 0) {
      // emit acct->ba here.
      links.push({ source: acctIdx, target: baIdx, value: total, color: ap.display_color, kind: 'acct_ba' });
    }
  });

  // Sankey expects index-based links; collapse duplicates between svc/acct
  // if multiple BAs share an account. Aggregate by (source,target).
  var aggKey = {};
  var agg = [];
  links.forEach(function(l){
    var key = l.source + '->' + l.target;
    if (key in aggKey) {
      agg[aggKey[key]].value += l.value;
    } else {
      aggKey[key] = agg.length;
      agg.push({ source: l.source, target: l.target, value: l.value, color: l.color, kind: l.kind });
    }
  });

  // link is dropped, and remaining link source/target indices are remapped.
  // This catches edge cases beyond the zero-total-BA short-circuit above
  // (e.g. future schema changes that introduce new orphan-node paths).
  var refMask = new Array(nodes.length);
  for (var _r = 0; _r < agg.length; _r++) {
    refMask[agg[_r].source] = 1;
    refMask[agg[_r].target] = 1;
  }
  var newIdx = new Array(nodes.length);
  var prunedNodes = [];
  for (var _n = 0; _n < nodes.length; _n++) {
    // outgoing links but must still render as the column-1 rectangles.
    if (refMask[_n] || (nodes[_n] && (nodes[_n].kind === 'svc' || nodes[_n].kind === 'acct'))) {
      newIdx[_n] = prunedNodes.length;
      prunedNodes.push(nodes[_n]);
    }
  }
  if (prunedNodes.length !== nodes.length) {
    var droppedN = nodes.length - prunedNodes.length;
    if (window.console && console.debug) {
      console.debug('[sankey] pruned ' + droppedN + ' orphan node(s)');
    }
    for (var _l = 0; _l < agg.length; _l++) {
      agg[_l].source = newIdx[agg[_l].source];
      agg[_l].target = newIdx[agg[_l].target];
    }
    return { nodes: prunedNodes, links: agg };
  }

  return { nodes: nodes, links: agg };
}



// -----------------------------------------------------------------
// Fragment B starts here. In the original monolith, the OrgTree
// subtab code (renderBudgetOrgTree, _openTagOfficeToOrgDialog,
// _bindBudgetOrgTreeSearch IIFE) sat between Fragment A and
// Fragment B; that block stays in classic script and will be
// extracted in v206.
// -----------------------------------------------------------------
function renderBudgetSankey() {
  var wrap = document.getElementById('budgetSankeyWrap');
  if (!wrap) return;

  // Empty-state guards
  var pes = DB.list('budget_pes') || [];
  if (!pes.length) {
    wrap.innerHTML = '<div class="hm-empty-note" style="margin:24px 12px;padding:16px;background:var(--surface-2);border:1px dashed var(--border);border-radius:6px;color:var(--text-muted);"><strong>No budget data loaded yet.</strong><br>Run <code>Supabase/v53-additive.sql</code> then load <code>Supabase/v53-seed-af-rdte-fy26.sql</code> to seed PEs.</div>';
    return;
  }
  if (typeof d3 === 'undefined' || typeof d3.sankey !== 'function') {
    wrap.innerHTML = '<div class="hm-empty-note" style="margin:24px 12px;padding:16px;background:var(--surface-2);border:1px dashed var(--border);border-radius:6px;color:var(--text-muted);"><strong>Loading D3 + d3-sankey from CDN…</strong> If this message persists, your network may be blocking <code>cdn.jsdelivr.net</code>.</div>';
    // Retry once D3 is available.
    var tries = 0;
    var poll = setInterval(function(){
      tries += 1;
      if (typeof d3 !== 'undefined' && typeof d3.sankey === 'function') {
        clearInterval(poll); renderBudgetSankey();
      } else if (tries > 50) {
        clearInterval(poll);
      }
    }, 100);
    return;
  }

  var thresholdM = Number(_budgetSankeyState.thresholdM) || 0;
  var threshold = thresholdM * 1e6;

  var graph = _budgetSankeyBuildGraph(threshold);

  // Layout
  var bbox = wrap.getBoundingClientRect();
  var width = Math.max(800, Math.floor(bbox.width || 1100));
  // Size canvas to fit all leaves. v65: a "leaf" is now any node with no
  // outgoing links — covers PE/Other AND collapsed BAs AND collapsed svcs,
  // which all need their own vertical lane in the strict-downward layout.
  var _hasOut = {};
  graph.links.forEach(function(_l){ _hasOut[_l.source] = 1; });
  var leafCount = graph.nodes.filter(function(_n, _i){ return !_hasOut[_i]; }).length;
  var rowH = 22;
  var heightPx = Math.max(520, 80 + leafCount * rowH);

  var svgNS = 'http://www.w3.org/2000/svg';
  // Build the SVG via D3. (D3 mutates the graph nodes/links in place.)
  var nodesCopy = graph.nodes.map(function(n){ return Object.assign({}, n); });
  var linksCopy = graph.links.map(function(l){ return Object.assign({}, l); });

  var sankey = d3.sankey()
    .nodeId(function(d){ return d.id; })
    .nodeAlign(d3.sankeyLeft)
    .nodeWidth(14)
    .nodePadding(8)
    .nodeSort(function(a, b){ return (a._order || 0) - (b._order || 0); })
    .iterations(0)
    .extent([[10, 30], [width - 220, heightPx - 20]]);

  // d3-sankey wants source/target as node objects when using nodeId
  // but it also accepts indices when you pass nodes/links arrays.
  // Use the index-based approach here.
  // Convert source/target indices -> node objects (sankey will resolve):
  linksCopy.forEach(function(l){
    l.source = nodesCopy[l.source];
    l.target = nodesCopy[l.target];
  });

  var laid;
  try {
    laid = sankey({ nodes: nodesCopy, links: linksCopy });
  } catch (err) {
    wrap.innerHTML = '<div class="hm-empty-note" style="margin:24px 12px;padding:16px;color:var(--text-muted);">Sankey layout failed: ' + escHtml(String(err && err.message || err)) + '</div>';
    return;
  }

  // DFS placement guarantees that every link's target.y0 >= source.y0,
  // so every ribbon curves downward (or runs horizontally for the topmost
  // child of a parent). Each service is placed at globalY in SERVICE_ORDER;
  // its accounts stack starting at the service's y0; each account's BAs
  // stack starting at the account's y0; each BA's PEs (when expanded) stack
  // starting at the BA's y0. The global cursor advances past the deepest
  // descendant of one service before placing the next service. Canvas
  // height auto-grows to fit — page becomes scrollable.
  (function strictDownwardLayout(){
    var minLeafH = 18;
    var leafPad = 4;       // small vertical pad between sibling children
    var svcGap = 28;       // gap between consecutive service subtrees
    var topY = 30;

    var totalSvcVal = 0;
    laid.nodes.forEach(function(n){ if (n.kind === 'svc') totalSvcVal += (n.value || 0); });
    if (totalSvcVal <= 0) return;
    var extentH = Math.max(120, heightPx - topY - 20);
    var ky = extentH / totalSvcVal;

    // 1. Build parent->children map (deduped, sorted by _order; 'other' last)
    var childrenMap = {};
    var seenLinkPair = {};
    laid.links.forEach(function(l){
      var pair = l.source.id + '\u0001' + l.target.id;
      if (seenLinkPair[pair]) return;
      seenLinkPair[pair] = 1;
      (childrenMap[l.source.id] = childrenMap[l.source.id] || []).push(l.target);
    });
    Object.keys(childrenMap).forEach(function(k){
      childrenMap[k].sort(function(a, b){
        var ao = a.kind === 'other' ? 1 : 0;
        var bo = b.kind === 'other' ? 1 : 0;
        if (ao !== bo) return ao - bo;
        return (a._order || 0) - (b._order || 0);
      });
    });

    // 2. Service order (matches _budgetSankeyBuildGraph SERVICE_ORDER)
    var SERVICE_ORDER = ['Defense Wide', 'Air Force', 'Army', 'Navy'];
    var svcs = laid.nodes.filter(function(n){ return n.kind === 'svc'; }).slice();
    svcs.sort(function(a, b){
      var ai = SERVICE_ORDER.indexOf(a.key);
      var bi = SERVICE_ORDER.indexOf(b.key);
      var ar = ai < 0 ? 999 : ai;
      var br = bi < 0 ? 999 : bi;
      if (ar !== br) return ar - br;
      return (a._order || 0) - (b._order || 0);
    });

    // 3. Recursively place a node and its descendants.
    //    parent.y0 sits at y0; parent.y1 = y0 + naturalHeight (so source-y
    //    positions for outgoing links stay within the rect). Children stack
    //    starting at parent.y0 — first child sits flush with parent's top.
    //    Subtree may extend below parent.y1 (the colored rect represents
    //    the value, the children's column extent represents the layout span).
    function placeNode(node, y0) {
      var nh = Math.max(minLeafH, (node.value || 0) * ky);
      node.y0 = y0;
      node.y1 = y0 + nh;
      var children = childrenMap[node.id] || [];
      var cy = y0; // first child at parent.y0 -> link runs horizontally
      for (var i = 0; i < children.length; i++) {
        placeNode(children[i], cy);
        cy = children[i].y1 + leafPad;
        // 'cy' may now exceed parent.y1; that's fine — children belong to a
        // later column, and the global cursor logic below will advance past
        // them before placing the next service's subtree.
      }
    }

    // 4. Find deepest y1 across an entire subtree (for advancing globalY).
    function subtreeMaxY(node) {
      var m = node.y1 || 0;
      var ch = childrenMap[node.id] || [];
      for (var i = 0; i < ch.length; i++) {
        var c = subtreeMaxY(ch[i]);
        if (c > m) m = c;
      }
      return m;
    }

    var globalY = topY;
    svcs.forEach(function(svc){
      placeNode(svc, globalY);
      globalY = subtreeMaxY(svc) + svcGap;
    });

    // 5. Link widths — same scale as natural rect heights.
    laid.links.forEach(function(l){
      l.width = Math.max(1, (l.value || 0) * ky);
    });

    // 6. Grow canvas if subtree extents exceed the initial heightPx.
    var maxY = 0;
    laid.nodes.forEach(function(n){ if (n.y1 > maxY) maxY = n.y1; });
    var needed = Math.ceil(maxY + 30);
    if (needed > heightPx) heightPx = needed;

    // 7. Recompute link source/target anchors from the new geometry.
    if (typeof sankey.update === 'function') {
      sankey.update({ nodes: laid.nodes, links: laid.links });
    }
  })();

  // Render
  var html = ['<svg class="budget-sankey-svg" xmlns="' + svgNS + '" viewBox="0 0 ' + width + ' ' + heightPx + '" style="width:100%;height:' + heightPx + 'px;display:block;">'];

  // Links
  var linkPath = d3.sankeyLinkHorizontal();
  laid.links.forEach(function(l){
    var d = linkPath(l);
    var color = l.color || '#888';
    html.push('<path class="budget-sankey-link" data-link-id="' + escHtml(l.source.id + '->' + l.target.id) + '" d="' + d + '" fill="none" stroke="' + color + '" stroke-opacity="0.34" stroke-width="' + Math.max(1, l.width) + '"></path>');
  });

  // Nodes
  laid.nodes.forEach(function(n){
    var x = n.x0, y = n.y0, w = n.x1 - n.x0, h = Math.max(2, n.y1 - n.y0);
    var fill = n.color || (n.kind === 'svc' ? '#5b8def' : n.kind === 'acct' ? '#866abf' : n.kind === 'other' ? '#9aa3ad' : '#dc4565');
    html.push('<rect class="budget-sankey-node" data-node-id="' + escHtml(n.id) + '" data-kind="' + escHtml(n.kind) + '" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + fill + '" rx="2"></rect>');
    var labelX, anchor;
    if (n.kind === 'svc' || n.kind === 'acct') { labelX = x + w + 6; anchor = 'start'; }
    else { labelX = x + w + 6; anchor = 'start'; }
    // For PE/other nodes (rightmost column), render labels to the RIGHT of the rect
    var label = n.label || n.id;
    var maxChars = (n.kind === 'pe') ? 38 : 60;
    if (label.length > maxChars) label = label.slice(0, maxChars - 1) + '\u2026';
    html.push('<text class="budget-sankey-label" x="' + labelX + '" y="' + (y + h / 2 + 4) + '" text-anchor="' + anchor + '">' + escHtml(label) + '</text>');
  });

  html.push('</svg>');

  // Tooltip layer
  html.push('<div class="budget-sankey-tooltip" id="budgetSankeyTip" style="display:none;"></div>');

  wrap.innerHTML = html.join('');

  // Event wiring
  var svg = wrap.querySelector('svg.budget-sankey-svg');
  var tip = wrap.querySelector('#budgetSankeyTip');

  function showTip(html, ev) {
    tip.innerHTML = html;
    tip.style.display = 'block';
    var rect = wrap.getBoundingClientRect();
    var x = ev.clientX - rect.left + 12;
    var y = ev.clientY - rect.top + 12;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  function hideTip() { tip.style.display = 'none'; }

  // Build a quick index for tooltip lookups
  var nodeById = {}; laid.nodes.forEach(function(n){ nodeById[n.id] = n; });

  svg.addEventListener('mousemove', function(ev){
    var t = ev.target;
    if (t.classList.contains('budget-sankey-node')) {
      var n = nodeById[t.getAttribute('data-node-id')];
      if (!n) return;
      var pathHtml;
      if (n.kind === 'svc') pathHtml = '<strong>Service</strong> \u00b7 ' + escHtml(n.label);
      else if (n.kind === 'acct') pathHtml = '<strong>Account</strong> \u00b7 ' + escHtml(n.label);
      else if (n.kind === 'ba') pathHtml = '<strong>' + escHtml(n.label) + '</strong>'
        + '<div style="margin-top:4px;font-size:11px;color:var(--text-muted);">Click to ' + (n.expanded ? 'collapse' : 'expand') + ' PE leaves</div>';
      else if (n.kind === 'pe') pathHtml = '<strong>PE</strong> \u00b7 <code>' + escHtml(n.peId || '') + '</code><br>' + escHtml(n.title || '');
      else if (n.kind === 'other') pathHtml = '<strong>' + escHtml(n.label) + '</strong> below threshold';
      else pathHtml = escHtml(n.label || n.id);
      showTip(pathHtml + '<div style="margin-top:4px;font-size:11px;color:var(--text-muted);">' + fmtBudget(n.value) + ' total flow</div>', ev);
    } else if (t.classList.contains('budget-sankey-link')) {
      var lid = t.getAttribute('data-link-id') || '';
      var parts = lid.split('->');
      var s = nodeById[parts[0]], d = nodeById[parts[1]];
      if (!s || !d) return;
      // Stroke-width is approximately link.width but easier to recover the value via DB scan; just compute from scaled width.
      var v = Number(t.getAttribute('stroke-width')) || 1;
      // Not exact dollars from stroke; but link.value is on the laid links — find it.
      var matched = null;
      for (var i = 0; i < laid.links.length; i++) {
        if (laid.links[i].source.id === s.id && laid.links[i].target.id === d.id) { matched = laid.links[i]; break; }
      }
      var amt = matched ? matched.value : null;
      showTip('<strong>' + escHtml(s.label || s.id) + '</strong> \u2192 <strong>' + escHtml(d.label || d.id) + '</strong>'
        + (amt !== null ? '<div style="margin-top:4px;font-size:11px;color:var(--text-muted);">' + fmtBudget(amt) + '</div>' : ''), ev);
    } else {
      hideTip();
    }
  });
  svg.addEventListener('mouseleave', hideTip);

  // Click behavior (v66):
  //   Acct -> toggle account expansion (show/hide its BAs)
  //   BA   -> toggle PE leaves on/off (in-Sankey expansion)
  //   Svc / PE / Other -> drill into Hierarchy View
  svg.addEventListener('click', function(ev){
    var t = ev.target;
    if (!t.classList.contains('budget-sankey-node')) return;
    var n = nodeById[t.getAttribute('data-node-id')];
    if (!n) return;
    if (n.kind === 'acct') {
      if (!_budgetSankeyState.expandedAccts) _budgetSankeyState.expandedAccts = new Set();
      var sa = _budgetSankeyState.expandedAccts;
      if (sa.has(n.key)) sa.delete(n.key); else sa.add(n.key);
      renderBudgetSankey();
      return;
    }
    if (n.kind === 'ba') {
      if (!_budgetSankeyState.expandedBas) _budgetSankeyState.expandedBas = new Set();
      var s = _budgetSankeyState.expandedBas;
      if (s.has(n.key)) s.delete(n.key); else s.add(n.key);
      renderBudgetSankey();
      return;
    }
    _budgetSankeyDrillTo(n);
  });
}

function _budgetSankeyDrillTo(n) {
  // Switch to the Hierarchy View sub-tab; expand the path so the target is visible.
  if (!window._budgetExpanded) window._budgetExpanded = new Set();

  // Re-build a tree to derive svc/acct/ba paths for this PE/BA
  var pes = DB.list('budget_pes') || [];
  var apprs = DB.list('budget_appropriations') || [];
  var orgs = DB.list('budget_orgs') || [];
  var apprById = {}; apprs.forEach(function(a){ apprById[a.id] = a; });
  var orgById = {}; orgs.forEach(function(o){ orgById[o.id] = o; });
  function svcFromAppr(ap) {
    var acct = (ap && ap.account) || '';
    var m = acct.match(/,\s*(.+)$/);
    if (m) return m[1].trim();
    var au = acct.toUpperCase();
    if (au.indexOf('AIR FORCE') === 0) return 'Air Force';
    if (au.indexOf('ARMY') === 0)      return 'Army';
    if (au.indexOf('NAVY') === 0)      return 'Navy';
    if (au.indexOf('MARINE') === 0)    return 'Marine Corps';
    return (ap && ap.title) || '?';
  }

  // _budgetSankeyBuildGraph use, so the keys we add to _budgetExpanded
  // ('svc:Air Force', 'svc:Army', ...) actually match the path the tree
  // renders against. Without this, oo.service='AF' produced 'svc:AF'
  // and the hierarchy stayed collapsed after drill.
  function _consolidateSvc(raw) {
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

  function expandToBa(baKey) {
    var ap = apprById[baKey]; if (!ap) return;
    var sample = pes.find(function(p){ return p.appropriation_id === baKey; });
    var oo = sample && orgById[sample.owning_org_id];
    var rawSvc = svcFromAppr(ap);
    var svcKey = _consolidateSvc(rawSvc);
    var acctKey = ap.account || '?';
    _budgetExpanded.add('svc:' + svcKey);
    _budgetExpanded.add('svc:' + svcKey + '|acct:' + acctKey);
    _budgetExpanded.add('svc:' + svcKey + '|acct:' + acctKey + '|ba:' + baKey);
    return { svcKey: svcKey, acctKey: acctKey };
  }

  if (n.kind === 'pe' && n._isSag) {
    // O&M path (svc='Defense Wide', acct from appropriation, ba=appr_id,
    // pe=sag_short_code which is what the hierarchy uses as the row id).
    var sags = (DB.list && DB.list('budget_om_sags')) || [];
    var sag = sags.find(function(s){ return s.id === n._sagId; });
    if (!sag) return;
    var sap = apprById[sag.appropriation_id];
    if (!sap) return;
    var svcKeyS = 'Defense Wide';
    var acctKeyS = sap.account || 'O&M,Defense-Wide';
    _budgetExpanded.add('svc:' + svcKeyS);
    _budgetExpanded.add('svc:' + svcKeyS + '|acct:' + acctKeyS);
    _budgetExpanded.add('svc:' + svcKeyS + '|acct:' + acctKeyS + '|ba:' + sag.appropriation_id);
    _budgetExpanded.add('svc:' + svcKeyS + '|acct:' + acctKeyS + '|ba:' + sag.appropriation_id + '|pe:' + (sag.sag_short_code || sag.id));
  } else if (n.kind === 'pe') {
    // Find the PE's BA + path.
    var pe = pes.find(function(p){ return p.id === n.peId; });
    if (pe) {
      var path = expandToBa(pe.appropriation_id);
      if (!path) return;
      _budgetExpanded.add('svc:' + path.svcKey + '|acct:' + path.acctKey + '|ba:' + pe.appropriation_id + '|pe:' + pe.id);
    } else {
      // Not in budget_pes — look up the row in budget_topline_lines and
      // expand to its BA so at least the section is visible. The row itself
      // isn't yet rendered as a hierarchy line, so no PE-level key.
      var topline = (DB.list && DB.list('budget_topline_lines')) || [];
      var row = topline.find(function(r){ return r && r.id === n.peId; });
      if (!row || !row.appropriation_id) return;
      var apTl = apprById[row.appropriation_id];
      if (!apTl) return;
      var svcKeyTl = _consolidateSvc(row.service || '');
      var acctKeyTl = apTl.account || '?';
      _budgetExpanded.add('svc:' + svcKeyTl);
      _budgetExpanded.add('svc:' + svcKeyTl + '|acct:' + acctKeyTl);
      _budgetExpanded.add('svc:' + svcKeyTl + '|acct:' + acctKeyTl + '|ba:' + row.appropriation_id);
    }
  } else if (n.kind === 'ba') {
    expandToBa(n.key);
  } else if (n.kind === 'other') {
    // Open the BA so the user sees what's there.
    expandToBa(n.baKey);
  } else if (n.kind === 'acct') {
    // Open every BA that lives under this account.
    apprs.forEach(function(ap){
      if (ap.account === n.key) expandToBa(ap.id);
    });
  } else if (n.kind === 'svc') {
    // Expand all in this service.
    apprs.forEach(function(ap){ expandToBa(ap.id); });
  }

  // Switch sub-tab to Hierarchy View
  var navBtns = document.querySelectorAll('[data-subtab-group="budget"] .subtab-btn');
  navBtns.forEach(function(b){ b.classList.toggle('active', b.dataset.subtab === 'budget-hierarchy'); });
  document.querySelectorAll('.subtab-panel').forEach(function(p){
    var name = p.dataset.subtabPanel || '';
    if (name.indexOf('budget-') === 0) p.classList.toggle('active', name === 'budget-hierarchy');
  });
  if (typeof renderBudget === 'function') renderBudget();

  // Scroll the corresponding row into view.
  setTimeout(function(){
    var sel;
    if (n.kind === 'pe') sel = '.budget-pe-row[data-pe-id="' + (window.CSS && CSS.escape ? CSS.escape(n.peId) : n.peId) + '"]';
    else if (n.kind === 'ba') sel = '.budget-node-ba[data-bpath$="ba:' + n.key + '"]';
    else if (n.kind === 'acct') sel = '.budget-node-acct[data-bpath$="acct:' + n.key + '"]';
    else if (n.kind === 'svc') sel = '.budget-node-svc[data-bpath="svc:' + n.key + '"]';
    if (!sel) return;
    var el = document.querySelector(sel);
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (el) {
      el.style.transition = 'background 0.4s';
      var orig = el.style.background;
      el.style.background = 'rgba(255,200,40,0.25)';
      setTimeout(function(){ el.style.background = orig; }, 1200);
    }
  }, 80);
}



// =================================================================
// Both are externally referenced from sibling modules:
//   _budgetSankeyState   -- 6 reads/writes in js/scout/scout-client.js
//   renderBudgetSankey   -- 7 callers (scout-client + index.html nav)
// =================================================================
window._budgetSankeyState = _budgetSankeyState;
window.renderBudgetSankey = renderBudgetSankey;
