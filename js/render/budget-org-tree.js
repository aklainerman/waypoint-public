// js/render/budget-org-tree.js
//
// DoD Budget Org hierarchy with per-org rollup amounts. Single
// contiguous extraction (~205 lines / ~7 KB):
//
//   var _budgetOrgTreeExpanded   -- expand-state map { orgId: bool }
//                                    (module-internal; no external
//                                    callers; null until first
//                                    interaction, then a plain
//                                    object).
//
//   function renderBudgetOrgTree()
//                                -- main renderer; iterates orgs
//                                    via budget_orgs DB table,
//                                    builds parent/child tree,
//                                    renders <details>-style rows
//                                    with computeOrgBudget rollup
//                                    amounts, wires expand/collapse
//                                    chevrons and "Tag offices to
//                                    this org" buttons.
//
//   function _openTagOfficeToOrgDialog(orgId)
//                                -- modal dialog for tagging
//                                    offices.budget_org_id; lists
//                                    all offices sorted by name
//                                    with a checkbox per office;
//                                    on Save, batches DB.partialUpdate
//                                    calls and re-renders the tree.
//
//   (function _bindBudgetOrgTreeSearch(){...})()
//                                -- IIFE; registers a document-level
//                                    `input` listener that triggers
//                                    renderBudgetOrgTree() whenever
//                                    the #budgetOrgTreeSearch box
//                                    changes (delegated handler so
//                                    it survives re-renders).
//
// Originally at file-scope of the inline monolith (between the
// Sankey buildGraph and the Sankey render function); lifted to
// ES module in v206. Same classic-script-split pattern as
// v181-v205.
//
// Pre-extraction audit (v185 pattern). 1 name exposed:
//   renderBudgetOrgTree -- subtab-nav dispatch in classic-script
//                          block at index.html:~23534 (post-v206)
//                          references it via bare-name lookup;
//                          window exposure required.
//
// Module-internal (NOT exposed):
//   _budgetOrgTreeExpanded   -- 4 internal references only
//   _openTagOfficeToOrgDialog -- 1 internal caller only
//   _bindBudgetOrgTreeSearch  -- IIFE, self-invoking
//
// External file-scope refs consumed:
//   DB                  (window global)
//   budgetOrgById       (classic-script helper; auto-hoisted)
//   computeOrgBudget    (js/db/rollup.js; on window since v200)
//   fmtBudget, escHtml, escAttr  (classic-script helpers; auto-hoisted)
//
// No body rewrites needed: _budgetOrgTreeExpanded is declared in
// the module head, so the chained assignment
// `expanded = _budgetOrgTreeExpanded = {};` binds to the module-
// local var. No DOMContentLoaded wrap (F-NEW-V203-1 doesn't apply);
// the IIFE registers a document-level `input` listener that
// attaches at module-load time regardless of DOM-ready state.

var _budgetOrgTreeExpanded = null;
function renderBudgetOrgTree() {
  var wrap = document.getElementById('budgetOrgTreeWrap');
  if (!wrap) return;
  var orgs = DB.list('budget_orgs') || [];
  if (!orgs.length) {
    wrap.innerHTML = '<div class="hm-empty-note" style="margin:24px 0;padding:16px;background:var(--surface-2);border:1px dashed var(--border);border-radius:6px;color:var(--text-muted);">'
                  + '<strong>No budget orgs loaded yet.</strong> Apply <code>v56-seed-af-orgs.sql</code> + <code>v61-seed-multi-service-orgs.sql</code>.</div>';
    return;
  }
  var pes = DB.list('budget_pes') || [];
  var offices = DB.list('offices') || [];
  var byParent = {};
  orgs.forEach(function(o){
    var p = o.parent_id || '__root__';
    (byParent[p] = byParent[p] || []).push(o);
  });
  Object.keys(byParent).forEach(function(k){
    byParent[k].sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); });
  });
  // Direct (non-rollup) request totals per org id.
  var directReq = {}, directCount = {};
  pes.forEach(function(pe){
    if (!pe.owning_org_id) return;
    directReq[pe.owning_org_id] = (directReq[pe.owning_org_id] || 0) + (Number(pe.request_amount) || 0);
    directCount[pe.owning_org_id] = (directCount[pe.owning_org_id] || 0) + 1;
  });
  // Offices tagged per org id.
  var taggedOffices = {};
  offices.forEach(function(o){
    if (!o.budget_org_id) return;
    (taggedOffices[o.budget_org_id] = taggedOffices[o.budget_org_id] || []).push(o);
  });
  // Rollup (descendant-aware) — uses existing helper.
  var rollupMap = _buildBudgetOrgRollup();
  function rollupTotals(id) {
    var ids = rollupMap[id] || [id];
    var t = 0, c = 0;
    for (var i = 0; i < ids.length; i++) {
      t += directReq[ids[i]] || 0;
      c += directCount[ids[i]] || 0;
    }
    return { total: t, count: c };
  }

  var expanded = _budgetOrgTreeExpanded;
  if (!expanded) {
    expanded = _budgetOrgTreeExpanded = {};
    (byParent.__root__ || []).forEach(function(r){ expanded[r.id] = 1; });
  }
  var query = (document.getElementById('budgetOrgTreeSearch') || {}).value || '';
  query = query.trim().toLowerCase();
  var matches = null;
  if (query) {
    matches = {};
    orgs.forEach(function(o){
      if (budgetOrgSearchScore(o, query) > 0) {
        // Mark this org and all ancestors as visible.
        var c = o; var hops = 0;
        while (c && hops < 12) {
          matches[c.id] = 1;
          c = c.parent_id ? budgetOrgById(c.parent_id) : null;
          hops++;
        }
      }
    });
  }

  var rows = [];
  function renderTreeRow(o, depth) {
    if (matches && !matches[o.id]) return;
    var kids = byParent[o.id] || [];
    var hasKids = kids.length > 0;
    var isOpen = !!expanded[o.id] || !!query;
    var chev = hasKids ? (isOpen ? '\u25BC' : '\u25B6') : '\u2022';
    var totals = rollupTotals(o.id);
    var direct = { total: directReq[o.id] || 0, count: directCount[o.id] || 0 };
    var tagged = taggedOffices[o.id] || [];
    var taggedHtml = tagged.length
      ? ' <span title="' + escAttr(tagged.map(function(of){ return of.name || of.id; }).join(', ')) + '" style="display:inline-block;padding:1px 6px;border-radius:9px;font-size:10px;background:rgba(76,175,80,0.18);color:#4caf50;font-weight:600;margin-left:6px;">' + tagged.length + ' office' + (tagged.length===1?'':'s') + '</span>'
      : '';
    var row = '<div class="budget-tree-row" data-org-id="' + escAttr(o.id) + '" '
            + 'style="display:flex;align-items:center;gap:8px;padding:5px 8px;padding-left:' + (8 + depth*16) + 'px;border-bottom:1px dashed var(--border);">'
            + '<span class="tree-chev" data-org-id="' + escAttr(o.id) + '" style="display:inline-block;width:16px;text-align:center;color:var(--text-muted);font-size:10px;cursor:' + (hasKids?'pointer':'default') + ';flex-shrink:0;">' + chev + '</span>'
            + '<span style="flex:1;min-width:0;">'
            +   '<strong style="font-size:12.5px;">' + escHtml(o.name || o.id) + '</strong>'
            +   ' <code style="font-size:10.5px;color:var(--text-dim);">' + escHtml(o.id) + '</code>'
            +   taggedHtml
            + '</span>'
            + '<span style="font-size:11px;color:var(--text-muted);min-width:120px;text-align:right;">'
            +   (totals.count
                  ? ('<strong style="color:var(--text);">' + fmtBudget(totals.total) + '</strong> '
                     + '<span style="font-size:10px;">(' + totals.count + ' PE' + (totals.count===1?'':'s') + ')</span>')
                  : '<span style="color:var(--text-dim);">no PEs</span>')
            + '</span>'
            + (direct.count
                ? '<span style="font-size:10px;color:var(--text-dim);min-width:90px;text-align:right;" title="Directly assigned to this node (no descendants)">direct: ' + fmtBudget(direct.total) + '</span>'
                : '<span style="font-size:10px;min-width:90px;"></span>')
            + '<button class="tree-tag-btn" data-org-id="' + escAttr(o.id) + '" '
            +       'style="font-size:10.5px;padding:3px 8px;border:1px solid var(--border);background:var(--surface-2);border-radius:3px;cursor:pointer;color:var(--text);">'
            +   'Tag office\u2026</button>'
            + '</div>';
    rows.push(row);
    if (hasKids && isOpen) {
      kids.forEach(function(k){ renderTreeRow(k, depth + 1); });
    }
  }
  (byParent.__root__ || []).forEach(function(r){ renderTreeRow(r, 0); });
  if (!rows.length) {
    wrap.innerHTML = '<div class="hm-empty-note" style="margin:18px 0;color:var(--text-muted);">No matches.</div>';
    return;
  }
  wrap.innerHTML = rows.join('');

  // Wire chevrons.
  wrap.querySelectorAll('.tree-chev').forEach(function(c){
    c.addEventListener('click', function(e){
      e.stopPropagation();
      var oid = c.dataset.orgId;
      _budgetOrgTreeExpanded[oid] = !_budgetOrgTreeExpanded[oid];
      renderBudgetOrgTree();
    });
  });
  // Wire tag-office buttons.
  wrap.querySelectorAll('.tree-tag-btn').forEach(function(b){
    b.addEventListener('click', function(e){
      e.stopPropagation();
      var oid = b.dataset.orgId;
      _openTagOfficeToOrgDialog(oid);
    });
  });
}

function _openTagOfficeToOrgDialog(orgId) {
  var org = budgetOrgById(orgId);
  if (!org) return;
  var offices = (DB.list('offices') || []).slice().sort(function(a,b){
    return (a.name || '').localeCompare(b.name || '');
  });
  var bc = budgetOrgBreadcrumb(orgId);
  // Modal-style overlay.
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;';
  var box = document.createElement('div');
  box.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:18px 20px;width:520px;max-height:75vh;overflow:auto;color:var(--text);box-shadow:0 12px 40px rgba(0,0,0,0.4);';
  box.innerHTML = '<div style="font-size:14px;font-weight:700;margin-bottom:6px;">Tag office to budget org</div>'
                + '<div style="font-size:11.5px;color:var(--text-muted);margin-bottom:12px;">Will be tagged to: <strong style="color:var(--text);">' + escHtml(bc) + '</strong></div>'
                + '<input type="text" id="_tagOfficeFilter" placeholder="Filter offices\u2026" style="width:100%;padding:6px 10px;border:1px solid var(--border);background:var(--surface-2);border-radius:4px;color:var(--text);font-size:12px;margin-bottom:10px;">'
                + '<div id="_tagOfficeList" style="max-height:48vh;overflow:auto;border:1px solid var(--border);border-radius:4px;"></div>'
                + '<div style="text-align:right;margin-top:14px;"><button type="button" id="_tagCancel" style="padding:5px 14px;background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:4px;cursor:pointer;">Cancel</button></div>';
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  function renderList() {
    var q = (box.querySelector('#_tagOfficeFilter').value || '').trim().toLowerCase();
    var list = box.querySelector('#_tagOfficeList');
    var rows = offices.filter(function(of){
      if (!q) return true;
      var hay = ((of.name||'') + ' ' + (of.fullName||'') + ' ' + (of.id||'')).toLowerCase();
      return hay.indexOf(q) >= 0;
    }).slice(0, 200);
    list.innerHTML = rows.length
      ? rows.map(function(of){
          var alreadyHere = of.budget_org_id === orgId;
          var cur = of.budget_org_id ? budgetOrgBreadcrumb(of.budget_org_id, {maxLen:60}) : '';
          return '<div class="_tag-row" data-office-id="' + escAttr(of.id) + '" '
               + 'style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border);cursor:' + (alreadyHere?'default':'pointer') + ';' + (alreadyHere?'opacity:0.6;':'') + '">'
               + '<span style="flex:1;min-width:0;"><strong>' + escHtml(of.name || of.id) + '</strong>'
               + (cur ? ' <span style="font-size:10px;color:var(--text-dim);">(currently: ' + escHtml(cur) + ')</span>' : '')
               + '</span>'
               + (alreadyHere ? '<span style="font-size:10px;color:#4caf50;">already here</span>' : '<span style="font-size:10px;color:var(--accent);">click to tag</span>')
               + '</div>';
        }).join('')
      : '<div style="padding:18px;text-align:center;color:var(--text-muted);">No matches.</div>';
    list.querySelectorAll('._tag-row').forEach(function(r){
      r.addEventListener('click', function(){
        var oid = r.dataset.officeId;
        var rec = DB.get('offices', oid);
        if (!rec || rec.budget_org_id === orgId) return;
        rec.budget_org_id = orgId;
        DB.upsert('offices', rec);
        document.body.removeChild(overlay);
        renderBudgetOrgTree();
        if (typeof refreshAll === 'function') refreshAll();
      });
    });
  }
  box.querySelector('#_tagOfficeFilter').addEventListener('input', renderList);
  box.querySelector('#_tagCancel').addEventListener('click', function(){
    document.body.removeChild(overlay);
  });
  overlay.addEventListener('click', function(e){
    if (e.target === overlay) document.body.removeChild(overlay);
  });
  renderList();
}

(function _bindBudgetOrgTreeSearch(){
  document.addEventListener('input', function(e){
    if (e.target && e.target.id === 'budgetOrgTreeSearch'
        && typeof renderBudgetOrgTree === 'function') {
      renderBudgetOrgTree();
    }
  });
})();


// =================================================================
// renderBudgetOrgTree referenced by classic-script subtab-nav
// dispatch (`else if (target === 'budget-org-tree' && typeof
// renderBudgetOrgTree === 'function') renderBudgetOrgTree();`),
// so the bare-name lookup must resolve via globalThis.
// =================================================================
window.renderBudgetOrgTree = renderBudgetOrgTree;
