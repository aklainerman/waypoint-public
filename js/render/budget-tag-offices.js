// js/render/budget-tag-offices.js
//
// renderBudget* cluster (v204-v208). Single contiguous extraction
// (~277 lines / ~14 KB) containing:
//
//   * v56 Phase 4 banner
//   * function renderBudgetTagOffices()
//     Walks every office, surfaces top-3 fuzzy budget_org
//     candidates via budgetOrgSearchScore, accept/skip flow.
//     Lives under Budget tab so it's discoverable alongside the
//     rest of the budget integration UI.
//   * filter-input event wiring on #budgetTagSearch /
//     #budgetTagFilter / #budgetTagSvcFilter
//
// Originally at file-scope of the inline monolith; lifted to ES
// module in v208. Same classic-script-split pattern as v181-v207.
//
// Pre-extraction audit (v185 pattern). 1 name exposed:
//   renderBudgetTagOffices -- 7 external callers (6 in index.html
//                              + 1 in js/render/mission-control.js)
//
// External file-scope refs consumed:
//   DB                  (window global)
//   budgetOrgSearchScore   (classic-script helper; auto-hoisted)
//   budgetOrgById, fmtBudget, escHtml, escAttr,
//   computeOrgBudget    (classic-script helpers / modules; all
//                        auto-hoisted or already on window)
//
// F-NEW-V203-1 mitigation:
//   The original source wrapped the filter-input event wiring in
//   `document.addEventListener('DOMContentLoaded', ...)`. Inside a
//   deferred ES module, DOMContentLoaded has already fired by the
//   time the module evaluates, so the wrap never runs and filter
//   changes would stop re-rendering. Replaced with a direct
//   top-level call: deferred modules execute after HTML parsing, so
//   document.getElementById() finds the inputs without further
//   coordination.

// ==================================================================
//   Walks every office, surfaces top-3 fuzzy budget_org candidates,
//   accept/skip flow. Lives under Budget tab so it's discoverable
//   alongside the rest of the budget integration UI.
// ==================================================================
function renderBudgetTagOffices() {
  var wrap = document.getElementById('budgetTagOfficesWrap');
  if (!wrap) return;
  var search = (document.getElementById('budgetTagSearch')||{}).value || '';
  var filter = (document.getElementById('budgetTagFilter')||{}).value || 'untagged';
  var svc    = (document.getElementById('budgetTagSvcFilter')||{}).value || '';
  var orgs   = DB.list('budget_orgs') || [];

  // Refresh dept filter options
  var svcSel = document.getElementById('budgetTagSvcFilter');
  if (svcSel) {
    var svcs = Array.from(new Set((DB.list('offices')||[]).map(function(o){return o.service;}).filter(Boolean))).sort();
    var cur = svcSel.value;
    svcSel.innerHTML = '<option value="">All departments</option>'
      + svcs.map(function(s){ return '<option' + (s===cur?' selected':'') + '>'+escHtml(s)+'</option>'; }).join('');
  }

  if (!orgs.length) {
    wrap.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-dim);">'
                   + '<strong>No budget orgs loaded.</strong><br>'
                   + 'Apply <code>Supabase/v56-seed-af-orgs.sql</code> to populate the AF org hierarchy, '
                   + 'then refresh this view.'
                   + '</div>';
    document.getElementById('budgetTagCount').textContent = '0 offices';
    return;
  }

  // Build list of offices per filter
  var allOffices = (DB.list('offices') || []).slice();
  var rows = allOffices.filter(function(o){
    if (svc && o.service !== svc) return false;
    var tagged = !!o.budget_org_id;
    var skipped = Array.isArray(o.tags) && o.tags.indexOf('budget-skipped') >= 0;
    if (filter === 'untagged' && (tagged || skipped)) return false;
    if (filter === 'tagged'   && !tagged) return false;
    if (filter === 'skipped'  && (!skipped || tagged)) return false;
    if (search) {
      var blob = [o.name, o.fullName, o.service, o.location, o.notes].join(' ').toLowerCase();
      if (blob.indexOf(search.toLowerCase()) < 0) return false;
    }
    return true;
  }).sort(function(a, b){
    // Untagged first, then by service, then by name
    var ta = !!a.budget_org_id, tb = !!b.budget_org_id;
    if (ta !== tb) return ta ? 1 : -1;
    var sa = (a.service||'').localeCompare(b.service||'');
    if (sa) return sa;
    return (a.name||'').localeCompare(b.name||'');
  });

  // Headline counts
  var totalOffices = allOffices.length;
  var totalTagged  = allOffices.filter(function(o){ return !!o.budget_org_id; }).length;
  var totalUntag   = totalOffices - totalTagged;
  var pct = totalOffices ? Math.round(100 * totalTagged / totalOffices) : 0;
  document.getElementById('budgetTagCount').textContent =
    rows.length + ' shown · ' + totalTagged + '/' + totalOffices + ' tagged (' + pct + '%)';

  // Build candidate suggestions per office
  function suggestionsFor(o) {
    // Score every org by combined match across the office's name + fullName
    var query = ((o.name||'') + ' ' + (o.fullName||'')).toLowerCase();
    if (!query.trim()) return [];
    // Try multi-token: rank by sum of best per-token aliases match.
    var tokens = query.split(/[^a-z0-9]+/i).filter(function(t){ return t && t.length >= 2; });
    var scored = orgs.map(function(org){
      var best = 0;
      // Whole-name match boost
      best = Math.max(best, budgetOrgSearchScore(org, o.name || ''));
      best = Math.max(best, budgetOrgSearchScore(org, o.fullName || ''));
      // Token-level alias matches give extra signal
      var tokSum = 0;
      tokens.forEach(function(tk){
        var s = budgetOrgSearchScore(org, tk);
        if (s > 50) tokSum += Math.min(s, 360);
      });
      var combined = best + tokSum * 0.4;
      return { org: org, score: combined };
    }).filter(function(x){ return x.score > 30; })
      .sort(function(a, b){ return b.score - a.score; })
      .slice(0, 3);
    return scored;
  }

  if (!rows.length) {
    wrap.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-dim);">'
                   + 'No offices match the current filters.'
                   + (filter === 'untagged' && totalUntag === 0
                      ? '<br><strong style="color:#4caf50;">All offices are tagged!</strong>'
                      : '')
                   + '</div>';
    return;
  }

  var html = ['<div style="display:flex;flex-direction:column;gap:8px;">'];
  // Headline progress bar
  html.push(
    '<div style="background:var(--surface-2);border:1px solid var(--border);padding:10px 14px;border-radius:6px;'
    + 'display:flex;align-items:center;gap:14px;">'
    +   '<div style="font-size:12px;color:var(--text-muted);min-width:120px;">Backfill progress</div>'
    +   '<div style="flex:1;background:var(--surface);border:1px solid var(--border);height:14px;border-radius:7px;overflow:hidden;">'
    +     '<div style="background:#4caf50;height:100%;width:' + pct + '%;transition:width 0.2s;"></div>'
    +   '</div>'
    +   '<div style="font-size:12px;font-weight:600;min-width:60px;text-align:right;">'
    +     totalTagged + ' / ' + totalOffices
    +   '</div>'
    + '</div>'
  );

  rows.forEach(function(o){
    var tagged = !!o.budget_org_id;
    var bo = tagged ? budgetOrgById(o.budget_org_id) : null;
    var bc = tagged ? budgetOrgBreadcrumb(o.budget_org_id, { maxLen: 100 }) : '';
    var sugs = tagged ? [] : suggestionsFor(o);
    html.push(
      '<div class="budget-tag-row" data-office-id="' + escAttr(o.id) + '" '
      + 'style="border:1px solid var(--border);background:var(--surface);border-radius:6px;'
      + 'padding:12px 14px;display:flex;flex-wrap:wrap;align-items:flex-start;gap:14px;">'
    );
    // Office identity column
    html.push(
      '<div style="flex:1 1 240px;min-width:240px;">'
      +   '<div style="font-weight:600;font-size:14px;display:flex;align-items:center;gap:6px;">'
      +     escHtml(o.name || o.id)
      +     budgetOrgBadge(o, { size: 11 })
      +   '</div>'
      +   (o.fullName ? '<div style="font-size:11px;color:var(--text-dim);">' + escHtml(o.fullName) + '</div>' : '')
      +   '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">'
      +     (o.service ? svcBadge(o.service) + ' ' : '')
      +     (o.location ? '<span>· ' + escHtml(o.location) + '</span>' : '')
      +   '</div>'
      + '</div>'
    );
    // Right column: suggestions / current tag / skipped state
    var _isSkipped = Array.isArray(o.tags) && o.tags.indexOf('budget-skipped') >= 0;
    if (tagged && bo) {
      html.push(
        '<div style="flex:2 1 360px;min-width:300px;display:flex;flex-direction:column;gap:6px;align-items:flex-start;">'
        +   '<div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;">Tagged to</div>'
        +   '<div style="font-weight:600;">' + escHtml(bo.name) + '</div>'
        +   (bc && bc !== bo.name ? '<div style="font-size:11px;color:var(--text-dim);">' + escHtml(bc) + '</div>' : '')
        +   '<div style="display:flex;gap:8px;margin-top:4px;">'
        +     '<button class="btn-icon" data-tag-edit="' + escAttr(o.id) + '">Edit office</button>'
        +     '<button class="btn-icon danger" data-tag-clear="' + escAttr(o.id) + '">Clear tag</button>'
        +   '</div>'
        + '</div>'
      );
    } else if (_isSkipped) {
      html.push(
        '<div style="flex:2 1 360px;min-width:300px;display:flex;flex-direction:column;gap:6px;align-items:flex-start;">'
        +   '<div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;">Skipped</div>'
        +   '<div style="font-size:12px;color:var(--text-muted);font-style:italic;">No budget-org mapping requested for this office.</div>'
        +   '<div style="display:flex;gap:8px;margin-top:4px;">'
        +     '<button class="btn-icon" data-tag-edit="' + escAttr(o.id) + '">Pick manually\u2026</button>'
        +     '<button class="btn-icon" data-tag-unskip="' + escAttr(o.id) + '">Unskip</button>'
        +   '</div>'
        + '</div>'
      );
    } else {
      html.push('<div style="flex:2 1 360px;min-width:300px;display:flex;flex-direction:column;gap:6px;">');
      html.push('<div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;">Suggested matches</div>');
      if (!sugs.length) {
        html.push('<div style="font-size:12px;color:var(--text-dim);font-style:italic;">No automatic candidates. Use the office editor to pick manually.</div>');
      } else {
        sugs.forEach(function(s){
          var bcs = budgetOrgBreadcrumb(s.org.id, { maxLen: 90 });
          html.push(
            '<div style="display:flex;align-items:center;gap:10px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface-2);">'
            + '<div style="flex:1;">'
            +   '<div style="font-weight:600;font-size:12.5px;">' + escHtml(s.org.name || s.org.id) + '</div>'
            +   (bcs && bcs !== s.org.name ? '<div style="font-size:10.5px;color:var(--text-dim);">' + escHtml(bcs) + '</div>' : '')
            + '</div>'
            + '<button class="btn-icon" data-tag-accept="' + escAttr(o.id) + '" data-tag-org="' + escAttr(s.org.id) + '" '
            + 'style="background:rgba(76,175,80,0.18);color:#4caf50;border-color:#4caf50;">Use</button>'
            + '</div>'
          );
        });
      }
      html.push(
        '<div style="display:flex;gap:8px;margin-top:4px;">'
        +   '<button class="btn-icon" data-tag-edit="' + escAttr(o.id) + '">Pick manually\u2026</button>'
        +   '<button class="btn-icon" data-tag-skip="' + escAttr(o.id) + '">Skip</button>'
        + '</div>'
      );
      html.push('</div>');
    }
    html.push('</div>');
  });
  html.push('</div>');
  wrap.innerHTML = html.join('');

  // Wire actions
  wrap.querySelectorAll('[data-tag-accept]').forEach(function(b){
    b.addEventListener('click', function(){
      var oid = b.dataset.tagAccept;
      var orgId = b.dataset.tagOrg;
      var o = DB.get('offices', oid);
      if (!o) return;
      DB.upsert('offices', { id: o.id, budget_org_id: orgId });
      renderBudgetTagOffices();
      if (typeof renderOffices === 'function'
          && document.getElementById('tab-offices')
          && document.getElementById('tab-offices').classList.contains('active')) {
        renderOffices();
      }
    });
  });
  wrap.querySelectorAll('[data-tag-clear]').forEach(function(b){
    b.addEventListener('click', function(){
      var oid = b.dataset.tagClear;
      var o = DB.get('offices', oid);
      if (!o) return;
      if (!confirm('Clear the budget org tag on "' + (o.name||o.id) + '"?')) return;
      DB.upsert('offices', { id: o.id, budget_org_id: null });
      renderBudgetTagOffices();
    });
  });
  wrap.querySelectorAll('[data-tag-edit]').forEach(function(b){
    b.addEventListener('click', function(){
      var oid = b.dataset.tagEdit;
      if (typeof editOffice === 'function') editOffice(oid);
    });
  });
  // The badge becomes empty for skipped offices; the untagged filter
  // hides them; a new 'Skipped only' filter exposes them; Unskip removes
  // the tag.
  wrap.querySelectorAll('[data-tag-skip]').forEach(function(b){
    b.addEventListener('click', function(){
      var oid = b.dataset.tagSkip;
      var o = DB.get('offices', oid);
      if (!o) return;
      var newTags = Array.isArray(o.tags) ? o.tags.slice() : [];
      if (newTags.indexOf('budget-skipped') < 0) newTags.push('budget-skipped');
      DB.upsert('offices', { id: o.id, tags: newTags });
      renderBudgetTagOffices();
      if (typeof renderOffices === 'function'
          && document.getElementById('tab-offices')
          && document.getElementById('tab-offices').classList.contains('active')) {
        renderOffices();
      }
    });
  });
  wrap.querySelectorAll('[data-tag-unskip]').forEach(function(b){
    b.addEventListener('click', function(){
      var oid = b.dataset.tagUnskip;
      var o = DB.get('offices', oid);
      if (!o) return;
      var newTags = (Array.isArray(o.tags) ? o.tags : []).filter(function(t){ return t !== 'budget-skipped'; });
      DB.upsert('offices', { id: o.id, tags: newTags });
      renderBudgetTagOffices();
      if (typeof renderOffices === 'function'
          && document.getElementById('tab-offices')
          && document.getElementById('tab-offices').classList.contains('active')) {
        renderOffices();
      }
    });
  });
}

// Re-render Tag Offices when filters change.
// v208 F-NEW-V203-1 mitigation: was wrapped in
// `document.addEventListener('DOMContentLoaded', ...)`, which
// would never fire inside a deferred ES module (DOMContentLoaded
// has already fired by module-eval time). Now invoked directly
// at module top-level; deferred modules execute after HTML
// parsing, so the target inputs are guaranteed to exist.
['budgetTagSearch','budgetTagFilter','budgetTagSvcFilter'].forEach(function(id){
  var el = document.getElementById(id);
  if (el) el.addEventListener('input', function(){
    if (typeof renderBudgetTagOffices === 'function') renderBudgetTagOffices();
  });
});


// =================================================================
// 7 external callers (index.html subtab dispatch, scout refresh
// hooks, mission-control ensureSubtabRender).
// =================================================================
window.renderBudgetTagOffices = renderBudgetTagOffices;
