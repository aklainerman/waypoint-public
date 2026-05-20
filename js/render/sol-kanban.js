// js/render/sol-kanban.js
//
//   * _solProbColor(p)       -- hue ramp helper (module-internal)
//   * renderSolKanban()      -- 8-stage kanban (v130: Ignored + Lost
//                                gated behind toolbar toggle)
//   * renderSolFunnel()      -- SVG pipeline funnel
//   * filter-change IIFE     -- input/change on sol filter inputs re-
//                                renders whichever subtab is active
//
// Exposures: renderSolKanban (3 external sites) and renderSolFunnel
// (2 external sites). _solProbColor is module-internal.

// ==================================================================
//   Six columns matching canonical pipeline stages. Cards show
//   title, office, value, due date. Click a card to open editor.
//   Respects the top-of-page filters (search, status, type, office).
// ==================================================================
// red (low) -> amber (mid) -> green (high). Used as inline-style on each card.
function _solProbColor(p) {
  p = Math.max(0, Math.min(100, Number(p)||0));
  // hue ramp 0 -> 120 (red -> green) on the standard sat/lightness axis.
  var h = Math.round(p * 1.2);
  return {
    border: 'hsl(' + h + ',62%,42%)',
    bg:     'hsla(' + h + ',62%,42%,0.10)',
    chip:   'hsl(' + h + ',62%,38%)'
  };
}
function renderSolKanban() {
  var wrap = document.getElementById('solKanbanWrap');
  if (!wrap) return;
  // so they don't fill the kanban with dead opportunities by default.
  var STAGES_CORE   = ['Identified','Reviewing','Drafting','Applied','Negotiating','Won'];
  var STAGES_HIDDEN = ['Ignored','Lost'];
  var _showHidden   = !!(window._kanbanShowHidden);
  var STAGES = _showHidden ? STAGES_CORE.concat(STAGES_HIDDEN) : STAGES_CORE.slice();
  var qEl  = document.getElementById('solSearch');
  var sfEl = document.getElementById('solStatusFilter');
  var tfEl = document.getElementById('solTypeFilter');
  var ofEl = document.getElementById('solOfficeFilter');
  var pEl  = document.getElementById('solPriorityOnly');
  var q  = (qEl  ? qEl.value  : '').toLowerCase();
  var sf = sfEl ? sfEl.value : '';
  var tf = tfEl ? tfEl.value : '';
  var of = ofEl ? ofEl.value : '';
  var pOnly = !!(pEl && pEl.checked);
  var ksortEl  = document.getElementById('solKanbanSort');
  var kminProb = document.getElementById('solKanbanMinProb');
  var ksort    = ksortEl ? ksortEl.value : 'estDesc';
  var kmin     = kminProb ? Math.max(0, Math.min(100, Number(kminProb.value)||0)) : 0;

  var rows = DB.list('solicitations').filter(function (s) {
    if (sf && s.status !== sf) return false;
    if (tf && s.type   !== tf) return false;
    if (of && s.officeId !== of) return false;
    if (pOnly && !s.is_priority) return false;
    if (kmin && (Number(s.probability_pct)||0) < kmin) return false;
    if (q) {
      var blob = [s.title, s.topic, (s.tech||[]).join(' '), s.notes, s.owner||'',
                  officeName(s.officeId)].join(' ').toLowerCase();
      if (blob.indexOf(q) === -1) return false;
    }
    return true;
  });
  var sorter;
  if (ksort === 'dueAsc')        sorter = function(a,b){ return (a.dueDate||'9999-12-31').localeCompare(b.dueDate||'9999-12-31'); };
  else if (ksort === 'valDesc')  sorter = function(a,b){ return (Number(b.value)||0) - (Number(a.value)||0); };
  else if (ksort === 'probDesc') sorter = function(a,b){ return (Number(b.probability_pct)||0) - (Number(a.probability_pct)||0); };
  else                           sorter = function(a,b){ return solEstimatedValue(b) - solEstimatedValue(a); }; // estDesc
  rows.sort(sorter);

  var byStage = {};
  STAGES.forEach(function (st) { byStage[st] = []; });
  rows.forEach(function (s) {
    if (s.status && byStage[s.status]) byStage[s.status].push(s);
  });

  // --- toolbar ---
  var toolbar = '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;font-size:12px;color:var(--text-muted);">'
    + '<label style="display:inline-flex;align-items:center;gap:6px;">Sort'
    +   '<select id="solKanbanSort" style="font-size:12px;padding:3px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);">'
    +     '<option value="estDesc"' + (ksort==='estDesc'?' selected':'') + '>Estimated $ (high -> low)</option>'
    +     '<option value="valDesc"' + (ksort==='valDesc'?' selected':'') + '>Ceiling $ (high -> low)</option>'
    +     '<option value="probDesc"' + (ksort==='probDesc'?' selected':'') + '>Probability (high -> low)</option>'
    +     '<option value="dueAsc"'  + (ksort==='dueAsc' ?' selected':'') + '>Close date (soonest first)</option>'
    +   '</select>'
    + '</label>'
    + '<label style="display:inline-flex;align-items:center;gap:6px;">Min Prob.'
    +   '<input id="solKanbanMinProb" type="number" min="0" max="100" step="5" value="' + kmin + '" style="width:70px;font-size:12px;padding:3px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);">'
    +   '%</label>'
    + '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">'
    +   '<input type="checkbox" id="solKanbanShowHidden"' + (_showHidden ? ' checked' : '') + ' style="margin:0;cursor:pointer;">'
    +   'Show Ignored / Lost'
    + '</label>'
    + '<span style="opacity:0.7;font-size:11px;">Card colour = probability (red low -> green high)</span>'
    + '</div>';

  // stage, not per-column) and render them right under the toolbar so the
  // user sees BOTH P(win)-weighted pipeline value AND raw ceiling at a glance.
  var _allWeighted = rows.reduce(function(a, r){ return a + solEstimatedValue(r); }, 0);
  var _allCeiling  = rows.reduce(function(a, r){ return a + (Number(r.value) || 0); }, 0);
  var _hdr = '<div style="display:flex;align-items:baseline;gap:18px;flex-wrap:wrap;margin:0 0 10px 0;padding:10px 12px;background:var(--surface-1);border:1px solid var(--border);border-radius:6px;font-size:12px;">'
    +   '<span style="font-family:var(--font-display);text-transform:uppercase;letter-spacing:1px;font-size:10.5px;color:var(--text-muted);">Pipeline</span>'
    +   '<span><span style="color:var(--text-muted);font-size:11px;">P(win)-weighted</span> <strong style="font-size:14px;">' + fmtMoney(_allWeighted) + '</strong></span>'
    +   '<span><span style="color:var(--text-muted);font-size:11px;">Ceiling (un-weighted)</span> <strong style="font-size:14px;color:var(--text-muted);">' + fmtMoney(_allCeiling) + '</strong></span>'
    +   '<span style="margin-left:auto;color:var(--text-muted);">' + rows.length + ' sol' + (rows.length===1?'':'s') + '</span>'
    + '</div>';
  toolbar = _hdr + toolbar;

  var html = toolbar + '<div class="sol-kanban">' + STAGES.map(function (stage) {
    var items = byStage[stage];
    var total = items.reduce(function (a, r) { return a + (Number(r.value) || 0); }, 0);
    var estTotal = items.reduce(function (a, r) { return a + solEstimatedValue(r); }, 0);
    var cards = items.length
      ? items.map(function (s) {
          var col = _solProbColor(s.probability_pct);
          var est = solEstimatedValue(s);
          var prob = Number(s.probability_pct)||0;
          return '<div class="sol-kanban-card" data-edit="' + escAttr(s.id) + '" style="border-left:3px solid ' + col.border + ';background:' + col.bg + ';position:relative;">'
            + (s.is_priority ? '<span title="Priority" style="position:absolute;right:8px;top:6px;color:var(--priority);font-size:13px;">★</span>' : '')
            + '<div class="sol-kanban-card-title">' + escHtml(s.title || '(untitled)') + '</div>'
            + '<div class="sol-kanban-card-org">' + escHtml(officeName(s.officeId) || '-') + (s.owner ? '<span style="margin-left:6px;color:var(--text-muted);">· ' + escHtml(s.owner) + '</span>' : '') + '</div>'
            + '<div class="sol-kanban-card-meta">'
            // card face. Weighted $ stays dominant; ceiling is muted/smaller so
            // the read order is "what's it worth at P × what's the upside".
            +   '<span class="sol-kanban-card-value">'
            +     (est ? fmtMoney(est) : (s.value ? fmtMoney(s.value) : '-'))
            +     (prob ? ' <span style="color:' + col.chip + ';font-weight:600;">(' + prob + '%)</span>' : '')
            +     ((est && s.value && est !== Number(s.value)) ? ' <span style="color:var(--text-muted);font-weight:400;font-size:11px;" title="Ceiling (un-weighted)">· ' + fmtMoney(s.value) + '</span>' : '')
            +   '</span>'
            +   '<span>Due: ' + escHtml(s.dueDate || '-') + '</span>'
            + '</div>'
            + '</div>';
        }).join('')
      : '<div class="sol-kanban-empty">No solicitations.</div>';
    return '<div class="sol-kanban-col">'
      + '<div class="sol-kanban-col-head">'
      +   '<span class="sol-kanban-col-title">' + stage + '</span>'
      // total when they differ, so the kanban tells the whole pipeline story
      // at a glance. Format: "N · $WEIGHTED · ceiling $RAW"
      +   '<span class="sol-kanban-col-meta">'
      +     items.length
      +     ' &middot; ' + (estTotal ? fmtMoney(estTotal) : (total ? fmtMoney(total) : '$0'))
      +     ((estTotal && total && estTotal !== total) ? ' <span style="color:var(--text-muted);font-weight:400;" title="Ceiling (un-weighted) total">&middot; ceiling ' + fmtMoney(total) + '</span>' : '')
      +   '</span>'
      + '</div>'
      + cards
      + '</div>';
  }).join('') + '</div>';
  wrap.innerHTML = html;
  wrap.querySelectorAll('[data-edit]').forEach(function (c) {
    c.addEventListener('click', function () { editSol(c.dataset.edit); });
  });
  // Re-bind the toolbar inputs after innerHTML re-render.
  var ks = document.getElementById('solKanbanSort');
  if (ks) ks.addEventListener('change', renderSolKanban);
  var km = document.getElementById('solKanbanMinProb');
  if (km) km.addEventListener('input', renderSolKanban);
  var khid = document.getElementById('solKanbanShowHidden');
  if (khid) khid.addEventListener('change', function () {
    window._kanbanShowHidden = !!khid.checked;
    renderSolKanban();
  });
}

// ==================================================================
// ==================================================================
function renderSolFunnel() {
  var wrap = document.getElementById('solFunnelWrap');
  if (!wrap) return;
  var STAGES = ['Identified','Reviewing','Drafting','Applied','Negotiating','Won'];
  var qEl  = document.getElementById('solSearch');
  var sfEl = document.getElementById('solStatusFilter');
  var tfEl = document.getElementById('solTypeFilter');
  var ofEl = document.getElementById('solOfficeFilter');
  var q  = (qEl  ? qEl.value  : '').toLowerCase();
  var sf = sfEl ? sfEl.value : '';
  var tf = tfEl ? tfEl.value : '';
  var of = ofEl ? ofEl.value : '';
  var rows = DB.list('solicitations').filter(function (s) {
    if (sf && s.status !== sf) return false;
    if (tf && s.type   !== tf) return false;
    if (of && s.officeId !== of) return false;
    if (q) {
      var blob = [s.title, s.topic, (s.tech||[]).join(' '), s.notes,
                  officeName(s.officeId)].join(' ').toLowerCase();
      if (blob.indexOf(q) === -1) return false;
    }
    return true;
  });
  var stats = {};
  var maxCount = 0;
  STAGES.forEach(function (st) { stats[st] = { count: 0, value: 0 }; });
  rows.forEach(function (s) {
    if (s.status && stats[s.status]) {
      stats[s.status].count += 1;
      stats[s.status].value += (Number(s.value) || 0);
      if (stats[s.status].count > maxCount) maxCount = stats[s.status].count;
    }
  });
  if (maxCount === 0) {
    wrap.innerHTML = '<div class="sol-funnel-empty">No solicitations match the current filters.</div>';
    return;
  }
  // Continuous inverted-pyramid SVG. Each stage is a trapezoid stacked
  // vertically; widths step down linearly from TOP_W (top) to BOT_W (bottom).
  var SVG_W = 600, ROW_H = 64, TOP_W = 580, BOT_W = 150;
  var n = STAGES.length;
  var SVG_H = ROW_H * n + 8;
  var cx = SVG_W / 2;
  var step = (TOP_W - BOT_W) / n;
  // Color ramp across stages (sampled from theme variables via inline styles).
  var COLORS = [
    '#5b8def', // Identified - cool blue
    '#6f7bd6', // Reviewing
    '#866abf', // Drafting
    '#a35aa6', // Applied
    '#c14a85', // Negotiating
    '#e63946'  // Won        - warm priority red
  ];
  var parts = [];
  parts.push('<svg class="sol-funnel-svg" viewBox="0 0 ' + SVG_W + ' ' + SVG_H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Solicitation pipeline funnel">');
  for (var i = 0; i < n; i++) {
    var st = STAGES[i];
    var topW = TOP_W - step * i;
    var botW = TOP_W - step * (i + 1);
    var y0 = 4 + ROW_H * i;
    var y1 = y0 + ROW_H;
    var pts = [
      (cx - topW / 2) + ',' + y0,
      (cx + topW / 2) + ',' + y0,
      (cx + botW / 2) + ',' + y1,
      (cx - botW / 2) + ',' + y1
    ].join(' ');
    var color = COLORS[i] || COLORS[COLORS.length - 1];
    var midY = y0 + ROW_H / 2;
    var c = stats[st].count;
    var v = fmtMoney(stats[st].value);
    var countTxt = c + ' sol' + (c === 1 ? '' : 's');
    parts.push('<g class="seg">');
    parts.push('<polygon points="' + pts + '" fill="' + color + '" stroke="rgba(255,255,255,0.15)" stroke-width="1"></polygon>');
    parts.push('<text class="seg-stage" x="' + cx + '" y="' + (midY - 12) + '" text-anchor="middle">' + escHtml(st) + '</text>');
    parts.push('<text class="seg-count" x="' + cx + '" y="' + (midY + 6) + '" text-anchor="middle">' + countTxt + '</text>');
    parts.push('<text class="seg-money" x="' + cx + '" y="' + (midY + 22) + '" text-anchor="middle">' + escHtml(v) + '</text>');
    parts.push('</g>');
  }
  parts.push('</svg>');
  wrap.innerHTML = '<div class="sol-funnel-wrap">' + parts.join('') + '</div>';
}

// Re-run kanban/funnel when sol filters change.
['solSearch','solStatusFilter','solTypeFilter','solOfficeFilter','solPriorityOnly'].forEach(function (id) {
  var el = document.getElementById(id);
  if (!el) return;
  var handler = function () {
    var subBtn = document.querySelector('[data-subtab-group="sols"] .subtab-btn.active');
    if (!subBtn) return;
    if (subBtn.dataset.subtab === 'sols-kanban') renderSolKanban();
    else if (subBtn.dataset.subtab === 'sols-funnel') renderSolFunnel();
  };
  el.addEventListener('input', handler);
  el.addEventListener('change', handler);
});



window.renderSolKanban = renderSolKanban;
window.renderSolFunnel = renderSolFunnel;
