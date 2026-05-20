// js/render/heatmaps.js
//
// org-count heatmap, service x tier weighted composite, and funnel
// view at stages of solicitation pipeline.
//
// Originally at file-scope of the inline monolith; lifted to ES module
// in v186. Same classic-script-split pattern as v181-v184. Per the
// is re-exposed on window via the footer block -- the audit ran before
// extraction confirmed 13 names need exposure.
//
// The four view renderers (renderHmEngagement, renderHmPriority,
// renderHmServiceTier, renderHmFunnel) live further down in the
// monolith at lines ~31316-31586 and remain there for now. The
// dispatcher's safe() wrapper calls them via file-scope window
// references (still hoisted because they're in classic-script context).
// If those view renderers ever move to a module too, this dispatcher
// will need updating to reach them via window. (in a v18N pass.)
//
// External callers (verified pre-extraction via cross-codebase grep):
//   - js/render/washops.js: hmEnsureDrawer (2), closeHmDrawer (9),
//     hmEscAttr (1) -- the Hill drawer in washops.js sits on top of
//     the HM drawer infrastructure, so all three are load-bearing
//   - index.html: renderHeatMaps (9), HEATMAP_SORT (4), HEATMAP_FILTERS
//     (3), HM_TIER_LABELS (3), HM_STAGE_STATUS (1), HM_ENG_ROUTES (1),
//     hmIntensity (4), hmSortArrow (4), hmEngagementScore (3),
//     openHmDrawer (1)
//
// Internal (no external refs):
//   - HEATMAP_VIEW, HEATMAP_CAPTIONS

// ================================================================
// ================================================================
let HEATMAP_VIEW = 'engagement';

// Per-view sort state. col=what to sort by, dir='asc'|'desc'.
const HEATMAP_SORT = {
  engagement: { col: 'score', dir: 'desc' },   // name|score|contacts|champions|los|solicitations|contracts
  funnel:     { col: 'total', dir: 'desc' },   // name|total|Identified|Reviewing|Drafting|Applied|Negotiating|Won
};

// Per-view filters.
const HEATMAP_FILTERS = {
  engagement: { priorityOnly: false },
};

// Module-scope attr escaper (the file's other escAttr is a nested closure
// unreachable from module scope; attr & HTML entity sets are identical).
function hmEscAttr(s) { return escHtml(s); }

// Tier labels for Service x Tier X-axis (short + plain-English).
const HM_TIER_LABELS = {
  '1':  'T1 Strategy',
  '2a': 'T2a Acquisition',
  '2b': 'T2b Rapid Cap',
  '2c': 'T2c On-Ramps',
  '3':  'T3 End Users',
  '4':  'T4 COCOMs',
  '5':  'T5 Oversight'
};

// Underlying status each canonical funnel stage collapses into / from.
const HM_STAGE_STATUS = {
  'Identified': 'Identified',
  'Reviewing':  'Reviewing',
  'Drafting':   'Drafting',
  'Applied':    'Applied',
  'Negotiating':'Negotiating',
  'Won':        'Won'
};

const HEATMAP_CAPTIONS = {
  'engagement':    'One row per engaged org, one column per KPI: CON=contacts, CHP=champions, LOS=letters of support, SOL=solicitations, CTR=awarded (Won solicitations). Cell intensity is normalized per-column against the strongest org. Click a header to sort; click a cell to open that tab filtered to this org.',
  'priority':      '<strong>Engagement Depth</strong> groups <em>every org</em> by how deep we\'ve gotten, regardless of service/tier: <strong>Contracted</strong> = &gt;=1 Won solicitation. <strong>Active sol</strong> = has at least one in-progress solicitation (no Won yet). <strong>Letter(s) only</strong> = we\'ve sent letters of support but no solicitation has been filed yet. <strong>Contacts only</strong> = we know people there but nothing has been filed. <strong>Cold</strong> = zero contacts on record. Columns bucket orgs by # of contacts. Click a cell to see every org inside.',
  'service-tier':  'Service / branch (rows) x Tier (cols). Each cell shows <strong>N ORGS</strong> and a <strong>Composite</strong> engagement score: CON&middot;1 + CHP&middot;2 + LOS&middot;3 + SOL&middot;4 + CTR&middot;5, summed over every org in the cell. Click a cell to open Orgs filtered to that service / tier.',
  'funnel':        'Orgs (rows) x solicitation stage (cols). Intensity scales with $ value at that stage (log-scaled). Six independent stages: Identified, Reviewing, Drafting, Applied, Negotiating, Won. Click a stage header to sort by that stage\'s pipeline $; click a cell to open Solicitations filtered to that org + stage.'
};

function hmIntensity(v, max) {
  if (!max || v <= 0) return '0';
  const r = v / max;
  if (r >= 0.85) return '5';
  if (r >= 0.65) return '4';
  if (r >= 0.40) return '3';
  if (r >= 0.20) return '2';
  if (r >  0.00) return '1';
  return '0';
}

function hmSortArrow(sort, col) {
  if (sort.col !== col) return '<span class="hm-sort-arrow">&#8645;</span>';
  return '<span class="hm-sort-arrow active">' + (sort.dir === 'asc' ? '&#9650;' : '&#9660;') + '</span>';
}

function hmEngagementScore(o, counts, champs) {
  const c = counts[o.id] || {};
  return (c.contacts||0)*1 + (champs[o.id]||0)*2 + (c.los||0)*3 + (c.solicitations||0)*4 + (c.contracts||0)*5;
}

// ---- Drawer (lazy-created, shared by any heat-map that needs it) ----
function hmEnsureDrawer() {
  if (document.getElementById('hmDrawer')) return;
  const bd = document.createElement('div');
  bd.className = 'hm-drawer-backdrop';
  bd.id = 'hmDrawerBackdrop';
  bd.addEventListener('click', closeHmDrawer);
  const dr = document.createElement('aside');
  dr.className = 'hm-drawer';
  dr.id = 'hmDrawer';
  dr.innerHTML =
    '<header class="hm-drawer-head">'
    +   '<div>'
    +     '<div class="hm-drawer-title" id="hmDrawerTitle"></div>'
    +     '<div class="hm-drawer-sub"   id="hmDrawerSub"></div>'
    +   '</div>'
    +   '<button class="hm-drawer-close" id="hmDrawerClose" aria-label="Close">&times;</button>'
    + '</header>'
    + '<div class="hm-drawer-body" id="hmDrawerBody"></div>';
  document.body.appendChild(bd);
  document.body.appendChild(dr);
  document.getElementById('hmDrawerClose').addEventListener('click', closeHmDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dr.classList.contains('open')) closeHmDrawer();
  });
}
function openHmDrawer(opts) {
  hmEnsureDrawer();
  const title    = opts && opts.title    || '';
  const subtitle = opts && opts.subtitle || '';
  const orgs     = (opts && opts.orgs)   || [];
  const counts = computeOfficeCounts();
  const champs = championsByOffice();
  document.getElementById('hmDrawerTitle').textContent = title;
  document.getElementById('hmDrawerSub').innerHTML     = subtitle;
  const body = document.getElementById('hmDrawerBody');
  if (!orgs.length) {
    body.innerHTML = '<div class="hm-drawer-empty">No orgs in this cell.</div>';
  } else {
    body.innerHTML = orgs.map(function(o){
      const oc = counts[o.id] || {};
      const ch = champs[o.id] || 0;
      const pri = officeIsPriority(o);
      const tierTxt = o.tier ? ('Tier ' + String(o.tier) + (o.echelon ? String(o.echelon).replace(String(o.tier),'') : '')) : '';
      return '<div class="hm-drawer-row' + (pri?' hm-drawer-row--priority':'') + '">'
        + '<div class="hm-drawer-row-top">'
        +   '<span class="hm-drawer-name">' + escHtml(o.name || o.id)
        +     (pri ? ' <span style="color:var(--priority);">&#9733;</span>' : '')
        +   '</span>'
        +   '<button class="hm-drawer-open" data-office-id="' + hmEscAttr(o.id) + '">Open org &rsaquo;</button>'
        + '</div>'
        + '<div class="hm-drawer-meta">'
        +   (o.service ? '<span>' + escHtml(o.service) + '</span>' : '')
        +   (tierTxt  ? '<span>' + escHtml(tierTxt) + '</span>' : '')
        + '</div>'
        + '<div class="hm-drawer-counts">'
        +   '<span title="Contacts">CON ' + (oc.contacts||0) + '</span>'
        +   '<span title="Champions">CHP ' + ch + '</span>'
        +   '<span title="Letters of support">LOS ' + (oc.los||0) + '</span>'
        +   '<span title="Solicitations">SOL ' + (oc.solicitations||0) + '</span>'
        +   '<span title="Contracts">CTR ' + (oc.contracts||0) + '</span>'
        + '</div>'
        + '</div>';
    }).join('');
    body.querySelectorAll('.hm-drawer-open').forEach(function(b){
      b.addEventListener('click', function(){
        const oid = b.dataset.officeId;
        closeHmDrawer();
        activateTab('offices', { officeId: oid });
      });
    });
  }
  document.getElementById('hmDrawerBackdrop').classList.add('open');
  document.getElementById('hmDrawer').classList.add('open');
}
function closeHmDrawer() {
  const bd = document.getElementById('hmDrawerBackdrop');
  const dr = document.getElementById('hmDrawer');
  if (bd) bd.classList.remove('open');
  if (dr) dr.classList.remove('open');
}

// ---- Router: Engagement Matrix cell click -> correct tab + filter ----
const HM_ENG_ROUTES = {
  contacts:      { tab: 'contacts',      opts: function(oid){ return { officeId: oid }; } },
  champions:     { tab: 'contacts',      opts: function(oid){ return { officeId: oid, championsOnly: true }; } },
  los:           { tab: 'letters',       opts: function(oid){ return { officeId: oid }; } },
  solicitations: { tab: 'solicitations', opts: function(oid){ return { officeId: oid }; } },
  contracts:     { tab: 'contracts',     opts: function(oid){ return { officeId: oid }; } }
};

function renderHeatMaps() {
  // Wire toggle buttons (idempotent).
  const nav = document.getElementById('heatmapNav');
  if (nav && !nav.dataset.wired) {
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.heatmap-btn');
      if (!btn) return;
      HEATMAP_VIEW = btn.dataset.hmView || 'engagement';
      nav.querySelectorAll('.heatmap-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderHeatMaps();
    });
    nav.dataset.wired = '1';
  }
  // Refresh caption.
  const cap = document.getElementById('heatmapCaption');
  const TITLES = {
    'engagement':  'Engagement Matrix',
    'priority':    'Engagement Depth',
    'service-tier':'Service x Tier Coverage',
    'funnel':      'Pipeline Funnel'
  };
  if (cap) cap.innerHTML = '<strong>' + escHtml(TITLES[HEATMAP_VIEW] || '') + '</strong> &mdash; ' + (HEATMAP_CAPTIONS[HEATMAP_VIEW] || '');
  // Render the wrapper + legend.
  const wrap = document.getElementById('heatmapWrapper');
  const leg  = document.getElementById('heatmapLegend');
  if (!wrap) return;

  // Defensive wrapper - a render-time exception should produce a visible
  // diagnostic rather than a silently blank grid.
  function safe(fn, legendLabel) {
    try {
      wrap.innerHTML = fn();
      if (leg) leg.innerHTML = hmLegendHtml(legendLabel);
    } catch (err) {
      console.error('[heatmap]', HEATMAP_VIEW, err);
      wrap.innerHTML =
        '<div class="hm-empty-note" style="border-color:var(--priority);color:var(--priority);">'
        + '<strong>Heat-map render failed.</strong><br>'
        + 'Open the browser devtools console for the stack trace.<br>'
        + '<code style="font-size:10px;">' + escHtml(String(err && err.message || err)) + '</code>'
        + '</div>';
      if (leg) leg.innerHTML = '';
    }
  }

  // Pre-check: DB loaded?
  const nOff = (DB && typeof DB.list === 'function') ? DB.list('offices').length : 0;
  if (nOff === 0) {
    wrap.innerHTML = '<div class="hm-empty-note">Loading data&hellip; If this persists, check your network / Supabase connection.</div>';
    if (leg) leg.innerHTML = '';
    return;
  }

  if      (HEATMAP_VIEW === 'engagement')   safe(renderHmEngagement,  'per-KPI max');
  else if (HEATMAP_VIEW === 'priority')     safe(renderHmPriority,    'org count');
  else if (HEATMAP_VIEW === 'service-tier') safe(renderHmServiceTier, 'weighted composite');
  else if (HEATMAP_VIEW === 'funnel')       safe(renderHmFunnel,      'log $ at stage');
}


// solicitation cards instead of org rows. Used by the Pipeline Funnel
// view's cell click handler to surface the proposals at a given
// office+stage as a vertical stack inside the shared hm-drawer.
function openHmDrawerSols(opts) {
  hmEnsureDrawer();
  const title    = (opts && opts.title)    || '';
  const subtitle = (opts && opts.subtitle) || '';
  const sols     = (opts && opts.sols)     || [];
  const stage    = (opts && opts.stage)    || '';
  document.getElementById('hmDrawerTitle').textContent = title;
  document.getElementById('hmDrawerSub').textContent   = subtitle;
  const body = document.getElementById('hmDrawerBody');
  if (!sols.length) {
    body.innerHTML = '<div class="hm-drawer-empty">No proposals in this stage for this org.</div>';
  } else {
    const fmtUsd = function(v) {
      v = Number(v) || 0;
      if (typeof fmtMoney === 'function') return fmtMoney(v);
      if (typeof fmtBudget === 'function') return fmtBudget(v);
      return '$' + v.toLocaleString();
    };
    body.innerHTML = sols.map(function(s) {
      const v   = Number(s.value)           || 0;
      const p   = Number(s.probability_pct) || 0;
      const due = s.dueDate || '';
      const ofc = (DB.get && DB.get('offices', s.officeId)) || null;
      const ofcName = ofc ? (ofc.name || ofc.id) : (s.officeId || '');
      const owner = s.owner || '';
      const probBg = p >= 70 ? '#2a9d8f' : (p >= 40 ? '#e9c46a' : '#e76f51');
      return ''
        + '<div class="hm-drawer-row" data-sol-id="' + hmEscAttr(s.id) + '" style="cursor:pointer;">'
        +   '<div class="hm-drawer-row-top">'
        +     '<span class="hm-drawer-name">' + escHtml(s.title || s.id)
        +       (s.is_priority ? ' <span style="color:var(--priority);" title="Priority">&#9733;</span>' : '')
        +     '</span>'
        +     '<button class="hm-drawer-open" data-sol-open="' + hmEscAttr(s.id) + '">Open &rsaquo;</button>'
        +   '</div>'
        +   '<div class="hm-drawer-meta">'
        +     (ofcName ? '<span>' + escHtml(ofcName) + '</span>' : '')
        +     (owner   ? '<span>' + escHtml(owner) + '</span>' : '')
        +     (due     ? '<span>Due ' + escHtml(due) + '</span>' : '')
        +   '</div>'
        +   '<div class="hm-drawer-counts">'
        +     '<span title="Value"><strong>' + escHtml(fmtUsd(v)) + '</strong></span>'
        +     '<span title="Probability" style="color:' + probBg + ';font-weight:600;">' + p + '%</span>'
        +     '<span title="Status">' + escHtml(stage || s.status || '') + '</span>'
        +   '</div>'
        + '</div>';
    }).join('');
    function openSol(sid) {
      // (side-drawer summary). QA smoke note: 'edit modal that shows the
      // details of the proposal' -- the side panel led with the office
      // card and looked like an office view.
      closeHmDrawer();
      if (typeof editSol === 'function') {
        editSol(sid);
      } else if (typeof openSolDetailPanel === 'function') {
        openSolDetailPanel(sid);
      }
    }
    body.querySelectorAll('.hm-drawer-row').forEach(function(row) {
      row.addEventListener('click', function(e) {
        if (e.target.closest('.hm-drawer-open')) return;
        const sid = row.dataset.solId;
        if (sid) openSol(sid);
      });
    });
    body.querySelectorAll('.hm-drawer-open').forEach(function(b) {
      b.addEventListener('click', function(e) {
        e.stopPropagation();
        const sid = b.dataset.solOpen;
        if (sid) openSol(sid);
      });
    });
  }
  document.getElementById('hmDrawerBackdrop').classList.add('open');
  document.getElementById('hmDrawer').classList.add('open');
}

// =================================================================
// pre-extraction audit results.
// =================================================================
window.HEATMAP_SORT = HEATMAP_SORT;
window.HEATMAP_FILTERS = HEATMAP_FILTERS;
window.HM_TIER_LABELS = HM_TIER_LABELS;
window.HM_STAGE_STATUS = HM_STAGE_STATUS;
window.HM_ENG_ROUTES = HM_ENG_ROUTES;
window.hmEscAttr = hmEscAttr;
window.hmIntensity = hmIntensity;
window.hmSortArrow = hmSortArrow;
window.hmEngagementScore = hmEngagementScore;
window.hmEnsureDrawer = hmEnsureDrawer;
window.openHmDrawer = openHmDrawer;
window.closeHmDrawer = closeHmDrawer;
window.renderHeatMaps = renderHeatMaps;

// =================================================================
// 22144-22549; consolidated into this module per the TODO at the top
// of the file. All 5 names exposed at the bottom for the dispatcher's
// safe() wrapper and for classic-script subtab dispatch.
// =================================================================

function hmLegendHtml(scaleLabel) {
  return '<span class="legend-label">Low</span>'
       + '<span class="legend-ramp">'
       +   '<span style="background: var(--surface-alt);"></span>'
       +   '<span style="background: rgba(9,25,142,0.12);"></span>'
       +   '<span style="background: rgba(9,25,142,0.26);"></span>'
       +   '<span style="background: rgba(9,25,142,0.44);"></span>'
       +   '<span style="background: rgba(9,25,142,0.68);"></span>'
       +   '<span style="background: rgba(9,25,142,0.92);"></span>'
       + '</span>'
       + '<span class="legend-label">High</span>'
       + '<span class="legend-sep">&middot;</span>'
       + '<span>Normalized against ' + escHtml(scaleLabel) + '</span>';
}

// ==================================================================
// View 1: Engagement Matrix (v57)
//   - No 30-cap; all engaged orgs always rendered.
//   - Priority-only toolbar chip.
//   - Sortable columns (CON/CHP/LOS/SOL/CTR/Score) + name.
//   - Per-column cell routing: CON->Contacts, CHP->Contacts+championsOnly,
//     LOS->Letters, SOL->Solicitations, CTR->Contracts -- all filtered to
//     the clicked org.
//   - No star in CON column (priority orgs show via orange row-header text).
// ==================================================================
function renderHmEngagement() {
  const offices = DB.list('offices').slice();
  const counts = computeOfficeCounts();
  const champs = championsByOffice();
  const metrics = [
    { key:'contacts',      label:'CON', get: o => (counts[o.id]||{}).contacts      || 0 },
    { key:'champions',     label:'CHP', get: o => champs[o.id]                      || 0 },
    { key:'los',           label:'LOS', get: o => (counts[o.id]||{}).los           || 0 },
    { key:'solicitations', label:'SOL', get: o => (counts[o.id]||{}).solicitations || 0 },
    { key:'contracts',     label:'CTR', get: o => (counts[o.id]||{}).contracts     || 0 },
  ];

  const engaged = offices.filter(o => hmEngagementScore(o, counts, champs) > 0);
  const totalEngaged = engaged.length;
  const filt = HEATMAP_FILTERS.engagement;
  let rows = engaged.slice();
  if (filt.priorityOnly) rows = rows.filter(o => officeIsPriority(o));

  // Sort.
  const sort = HEATMAP_SORT.engagement;
  const sign = sort.dir === 'asc' ? 1 : -1;
  if (sort.col === 'name') {
    rows.sort((a,b) => sign * (a.name||'').localeCompare(b.name||''));
  } else if (sort.col === 'score') {
    rows.sort((a,b) => sign * (hmEngagementScore(a, counts, champs) - hmEngagementScore(b, counts, champs))
                    || (a.name||'').localeCompare(b.name||''));
  } else {
    const m = metrics.find(x => x.key === sort.col);
    if (m) rows.sort((a,b) => sign * (m.get(a) - m.get(b))
                           || (a.name||'').localeCompare(b.name||''));
  }

  if (!rows.length) {
    return '<div class="hm-empty-note">No engagement data matches. Turn off "Priority only" or add contacts, solicitations, letters, or contracts.</div>';
  }

  // Per-metric max for column normalization.
  const maxes = metrics.map(m => Math.max(0, ...rows.map(m.get)));

  // Toolbar.
  const sortLabel = { name:'Name', score:'Score', contacts:'CON', champions:'CHP', los:'LOS', solicitations:'SOL', contracts:'CTR' }[sort.col] || sort.col;
  let html = '<div class="hm-toolbar">';
  html += '<span class="hm-toolbar-label">' + rows.length + ' of ' + totalEngaged + ' engaged org' + (totalEngaged===1?'':'s') + '</span>';
  html += '<span class="hm-toolbar-sep">&middot;</span>';
  html += '<button class="hm-chip' + (filt.priorityOnly?' active':'') + '" data-hm-toggle="priorityOnly" title="Show only priority orgs"><span>&#9733;</span> Priority only</button>';
  html += '<span class="hm-toolbar-sep">&middot;</span>';
  html += '<span class="hm-toolbar-label">Sort: <strong>' + escHtml(sortLabel) + '</strong> ' + (sort.dir==='asc'?'&uarr;':'&darr;') + '</span>';
  html += '</div>';

  // Grid.
  html += '<div class="heatmap-grid hm-v-engagement">';
  html += '<div class="hm-row-header hm-corner hm-sortable" data-hm-sort="name" title="Sort by org name">Org ' + hmSortArrow(sort, 'name') + '</div>';
  metrics.forEach(m => {
    html += '<div class="hm-col-header hm-sortable" data-hm-sort="' + hmEscAttr(m.key) + '" title="Sort by ' + hmEscAttr(m.label) + '">'
          + escHtml(m.label) + ' ' + hmSortArrow(sort, m.key)
          + '</div>';
  });
  rows.forEach(o => {
    const pri = officeIsPriority(o);
    html += '<div class="hm-row-header' + (pri?' hm-priority-row':'') + '" title="' + hmEscAttr(o.name||'') + '">' + escHtml(o.name || o.id) + '</div>';
    metrics.forEach((m, i) => {
      const v = m.get(o);
      const intensity = hmIntensity(v, maxes[i]);
      html += '<div class="hm-cell hm-eng-cell' + (v===0?' hm-empty':'') + '" data-intensity="' + intensity
           +  '" data-office-id="' + hmEscAttr(o.id) + '"'
           +  ' data-hm-kpi="' + hmEscAttr(m.key) + '"'
           +  ' title="' + hmEscAttr(o.name + ' - ' + m.label + ': ' + v) + '">'
           + (v > 0 ? v : '&middot;')
           + '</div>';
    });
  });
  html += '</div>';

  // Wire toolbar chip + sortable headers + cell clicks (routed per KPI).
  setTimeout(() => {
    const wrap = document.getElementById('heatmapWrapper');
    if (!wrap) return;
    wrap.querySelectorAll('[data-hm-toggle="priorityOnly"]').forEach(el => {
      el.addEventListener('click', () => {
        HEATMAP_FILTERS.engagement.priorityOnly = !HEATMAP_FILTERS.engagement.priorityOnly;
        renderHeatMaps();
      });
    });
    wrap.querySelectorAll('.hm-sortable[data-hm-sort]').forEach(el => {
      el.addEventListener('click', () => {
        const col = el.dataset.hmSort;
        const s = HEATMAP_SORT.engagement;
        if (s.col === col) s.dir = (s.dir === 'asc' ? 'desc' : 'asc');
        else { s.col = col; s.dir = (col === 'name' ? 'asc' : 'desc'); }
        renderHeatMaps();
      });
    });
    wrap.querySelectorAll('.hm-eng-cell[data-office-id]').forEach(el => {
      el.addEventListener('click', () => {
        const oid = el.dataset.officeId;
        const kpi = el.dataset.hmKpi;
        const route = HM_ENG_ROUTES[kpi];
        if (route) activateTab(route.tab, route.opts(oid));
        else activateTab('offices', { officeId: oid });
      });
    });
  }, 0);
  return html;
}

// ==================================================================
// View 2: Engagement Depth (v57, formerly "Priority x Progress")
//   - "N ORGS" label format.
//   - Cell click opens right-side drawer listing every org in the cell
//     with counts + "Open org" action.
// ==================================================================
function renderHmPriority() {
  const offices = DB.list('offices');
  const counts = computeOfficeCounts();
  const conBuckets = [
    { label:'0',   test: n => n === 0 },
    { label:'1-2', test: n => n >= 1 && n <= 2 },
    { label:'3-5', test: n => n >= 3 && n <= 5 },
    { label:'6+',  test: n => n >= 6 },
  ];
  const depthBuckets = [
    { key:'contracted',    label:'Contracted',     test: oc => (oc.contracts||0) > 0 },
    { key:'active-sol',    label:'Active sol',     test: oc => (oc.contracts||0) === 0 && (oc.solicitations||0) > 0 },
    { key:'letters-only',  label:'Letter(s) only', test: oc => (oc.contracts||0) === 0 && (oc.solicitations||0) === 0 && (oc.los||0) > 0 },
    { key:'contacts-only', label:'Contacts only',  test: oc => (oc.contracts||0) === 0 && (oc.solicitations||0) === 0 && (oc.los||0) === 0 && (oc.contacts||0) > 0 },
    { key:'cold',          label:'Cold',           test: oc => (oc.contracts||0) === 0 && (oc.solicitations||0) === 0 && (oc.los||0) === 0 && (oc.contacts||0) === 0 },
  ];
  const grid = depthBuckets.map(() => conBuckets.map(() => []));
  offices.forEach(o => {
    const oc = counts[o.id] || { contacts:0, solicitations:0, los:0, contracts:0 };
    const r = depthBuckets.findIndex(b => b.test(oc));
    const c = conBuckets.findIndex(b => b.test(oc.contacts||0));
    if (r >= 0 && c >= 0) grid[r][c].push(o);
  });
  const allCounts = grid.flat().map(arr => arr.length);
  const maxCount = Math.max(0, ...allCounts);

  let html = '<div class="heatmap-grid hm-v-priority">';
  html += '<div class="hm-corner"></div>';
  conBuckets.forEach(b => { html += '<div class="hm-col-header">' + escHtml(b.label) + ' contacts</div>'; });
  depthBuckets.forEach((rb, r) => {
    html += '<div class="hm-row-header">' + escHtml(rb.label) + '</div>';
    conBuckets.forEach((cb, c) => {
      const orgs = grid[r][c];
      const n = orgs.length;
      const hasPri = orgs.some(o => officeIsPriority(o));
      const intensity = hmIntensity(n, maxCount);
      if (n === 0) {
        html += '<div class="hm-cell hm-empty" data-intensity="0">&middot;</div>';
      } else {
        const listHtml = orgs.slice(0, 6).map(o => escHtml(o.name || o.id) + (officeIsPriority(o)?' &#9733;':'')).join('<br>')
                       + (orgs.length > 6 ? '<br>&hellip; +' + (orgs.length-6) + ' more' : '');
        html += '<div class="hm-cell hm-depth-cell" data-intensity="' + intensity + '"'
             +  ' data-hm-row="' + r + '" data-hm-col="' + c + '"'
             +  ' title="Click to see all ' + n + ' org' + (n===1?'':'s') + '">'
             +  '<div class="hm-count"><span class="hm-count-n">' + n + '</span> <span class="hm-count-label">ORG' + (n===1?'':'S') + '</span></div>'
             +  '<div class="hm-org-list">' + listHtml + '</div>'
             +  (hasPri ? '<span class="hm-star">&#9733;</span>' : '')
             +  '</div>';
      }
    });
  });
  html += '</div>';

  // Wire: cell click -> drawer.
  setTimeout(() => {
    const wrap = document.getElementById('heatmapWrapper');
    if (!wrap) return;
    wrap.querySelectorAll('.hm-depth-cell').forEach(el => {
      el.addEventListener('click', () => {
        const r = parseInt(el.dataset.hmRow, 10);
        const c = parseInt(el.dataset.hmCol, 10);
        const rb = depthBuckets[r];
        const cb = conBuckets[c];
        const orgs = grid[r][c].slice()
          .sort((a,b) => (officeIsPriority(b)?1:0) - (officeIsPriority(a)?1:0)
                      || (a.name||'').localeCompare(b.name||''));
        openHmDrawer({
          title: rb.label + ' . ' + cb.label + ' contacts',
          subtitle: '<strong>' + orgs.length + '</strong> org' + (orgs.length===1?'':'s') + ' in this cell',
          orgs: orgs
        });
      });
    });
  }, 0);
  return html;
}

// ==================================================================
// View 3: Service x Tier Coverage (v57)
//   - Short tier labels ("T2a Acquisition" etc.)
//   - Cell shows "N ORGS" on the left + "Composite: <score>" below.
// ==================================================================
function renderHmServiceTier() {
  const offices = DB.list('offices');
  const counts = computeOfficeCounts();
  const champs = championsByOffice();
  const TIERS = ['1','2a','2b','2c','3','4','5'];
  const SERVICES = ['Air Force','Army','Navy','SOCOM','Joint','OSW','OSD','Congress','Other'];
  const grid = SERVICES.map(() => TIERS.map(() => ({ cells: 0, weighted: 0, orgs: [] })));
  function rowIdx(o) {
    const svc = (o.service || 'Other');
    const i = SERVICES.indexOf(svc);
    return i >= 0 ? i : SERVICES.length - 1;
  }
  function colIdx(o) {
    const t = String(o.tier || '').trim();
    const ech = String(o.echelon || '').trim().toLowerCase();
    if (t === '2' && (ech === '2a' || ech === '2b' || ech === '2c')) return TIERS.indexOf(ech);
    const idx = TIERS.indexOf(t.toLowerCase());
    return idx >= 0 ? idx : -1;
  }
  offices.forEach(o => {
    const c = colIdx(o); const r = rowIdx(o);
    if (c < 0 || r < 0) return;
    const oc = counts[o.id] || {};
    const w = (oc.contacts||0)*1 + (champs[o.id]||0)*2 + (oc.los||0)*3 + (oc.solicitations||0)*4 + (oc.contracts||0)*5;
    grid[r][c].cells += 1;
    grid[r][c].weighted += w;
    grid[r][c].orgs.push(o);
  });
  const maxWeighted = Math.max(0, ...grid.flat().map(x => x.weighted));
  let html = '<div class="heatmap-grid hm-v-service">';
  html += '<div class="hm-corner"></div>';
  TIERS.forEach(t => {
    const lbl = HM_TIER_LABELS[t] || ('Tier ' + t);
    html += '<div class="hm-col-header" title="' + hmEscAttr(lbl) + '">' + escHtml(lbl) + '</div>';
  });
  SERVICES.forEach((svc, r) => {
    html += '<div class="hm-row-header">' + escHtml(svc) + '</div>';
    TIERS.forEach((t, c) => {
      const cell = grid[r][c];
      const intensity = hmIntensity(cell.weighted, maxWeighted);
      if (cell.cells === 0) {
        html += '<div class="hm-cell hm-empty" data-intensity="0" title="' + hmEscAttr(svc + ' / ' + (HM_TIER_LABELS[t]||t) + ' - no orgs') + '">&middot;</div>';
      } else {
        const names = cell.orgs.slice(0,8).map(o => o.name || o.id).join(', ');
        html += '<div class="hm-cell hm-svc-cell" data-intensity="' + intensity
             +  '" data-hm-svc="' + hmEscAttr(svc) + '" data-hm-tier="' + hmEscAttr(t)
             +  '" title="' + hmEscAttr(svc + ' / ' + (HM_TIER_LABELS[t]||t) + ' (' + cell.cells + ' orgs, composite ' + cell.weighted + '): ' + names) + '">'
             +  '<div class="hm-svc-top">'
             +    '<span class="hm-count-n">' + cell.cells + '</span> <span class="hm-count-label">ORG' + (cell.cells===1?'':'S') + '</span>'
             +  '</div>'
             +  '<div class="hm-svc-score">Composite: <strong>' + cell.weighted + '</strong></div>'
             +  '</div>';
      }
    });
  });
  html += '</div>';
  setTimeout(() => {
    document.querySelectorAll('#heatmapWrapper .hm-svc-cell').forEach(el => {
      el.addEventListener('click', () => {
        activateTab('offices');
        setTimeout(() => {
          const sf = document.getElementById('officesServiceFilter');
          const tf = document.getElementById('officesTierFilter');
          // wires 'input' on <select> filters. 'change'-only dispatch
          // left the Orgs table unfiltered.
          if (sf) {
            sf.value = el.dataset.hmSvc || '';
            sf.dispatchEvent(new Event('input', { bubbles: true }));
            sf.dispatchEvent(new Event('change', { bubbles: true }));
          }
          if (tf) {
            tf.value = el.dataset.hmTier || '';
            tf.dispatchEvent(new Event('input', { bubbles: true }));
            tf.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, 20);
      });
    });
  }, 0);
  return html;
}

// ==================================================================
// View 4: Pipeline Funnel (v57; stages decollapsed in v49)
//   - Sortable stage columns + name + total.
//   - Cell click -> Solicitations tab filtered to org + stage.
// ==================================================================
function renderHmFunnel() {
  const STAGE_MAP = {
    'Identified': 'Identified',
    'Reviewing':  'Reviewing',
    'Drafting':   'Drafting',
    'Applied':    'Applied',
    'Negotiating':'Negotiating',
    'Won':        'Won'
  };
  const STAGES = ['Identified','Reviewing','Drafting','Applied','Negotiating','Won'];
  const offices = DB.list('offices');
  const sols = DB.list('solicitations');
  const byOffice = {};
  sols.forEach(s => {
    if (!s.officeId) return;
    const stage = STAGE_MAP[s.status] || null;
    if (!stage) return;
    if (!byOffice[s.officeId]) byOffice[s.officeId] = { total:0, stages:{} };
    if (!byOffice[s.officeId].stages[stage]) byOffice[s.officeId].stages[stage] = { count:0, value:0 };
    byOffice[s.officeId].stages[stage].count += 1;
    byOffice[s.officeId].stages[stage].value += (Number(s.value) || 0);
    byOffice[s.officeId].total += (Number(s.value) || 0);
  });
  let rowOrgs = offices.filter(o => byOffice[o.id]);
  if (!rowOrgs.length) return '<div class="hm-empty-note">No solicitations with a recognized stage yet. Add solicitations with Identified / Reviewing / Drafting / Applied / Negotiating / Won status to populate the funnel.</div>';

  // Sort.
  const sort = HEATMAP_SORT.funnel;
  const sign = sort.dir === 'asc' ? 1 : -1;
  function cellVal(o, stage) { const s = byOffice[o.id].stages[stage]; return s ? s.value : 0; }
  if (sort.col === 'name') {
    rowOrgs.sort((a,b) => sign * (a.name||'').localeCompare(b.name||''));
  } else if (sort.col === 'total') {
    rowOrgs.sort((a,b) => sign * (byOffice[a.id].total - byOffice[b.id].total)
                        || (a.name||'').localeCompare(b.name||''));
  } else if (STAGES.includes(sort.col)) {
    rowOrgs.sort((a,b) => sign * (cellVal(a, sort.col) - cellVal(b, sort.col))
                        || (byOffice[b.id].total - byOffice[a.id].total));
  }

  // Intensity: log-scale of value across all cells.
  const allValues = [];
  rowOrgs.forEach(o => STAGES.forEach(st => {
    const cell = byOffice[o.id].stages[st]; if (cell && cell.value > 0) allValues.push(cell.value);
  }));
  const logMax = Math.max(0, ...allValues.map(v => Math.log10(v + 1)));

  // Toolbar (sort summary).
  const sortLabel = sort.col === 'name' ? 'Name' : (sort.col === 'total' ? 'Total $' : sort.col);
  let html = '<div class="hm-toolbar">';
  html += '<span class="hm-toolbar-label">' + rowOrgs.length + ' org' + (rowOrgs.length===1?'':'s') + ' with pipeline</span>';
  html += '<span class="hm-toolbar-sep">&middot;</span>';
  html += '<span class="hm-toolbar-label">Sort: <strong>' + escHtml(sortLabel) + '</strong> ' + (sort.dir==='asc'?'&uarr;':'&darr;') + '</span>';
  html += '</div>';

  html += '<div class="heatmap-grid hm-v-funnel">';
  html += '<div class="hm-row-header hm-corner hm-sortable" data-hm-sort="name" title="Sort by org name">Org ' + hmSortArrow(sort, 'name') + '</div>';
  STAGES.forEach(st => {
    html += '<div class="hm-col-header hm-sortable" data-hm-sort="' + hmEscAttr(st) + '" title="Sort by ' + hmEscAttr(st) + ' pipeline $">'
          + escHtml(st) + ' ' + hmSortArrow(sort, st)
          + '</div>';
  });
  rowOrgs.forEach(o => {
    const pri = officeIsPriority(o);
    html += '<div class="hm-row-header' + (pri?' hm-priority-row':'') + '" title="' + hmEscAttr(o.name + ' - total ' + fmtMoney(byOffice[o.id].total)) + '">' + escHtml(o.name || o.id) + '</div>';
    STAGES.forEach(st => {
      const cell = byOffice[o.id].stages[st];
      if (!cell || cell.count === 0) {
        html += '<div class="hm-cell hm-empty" data-intensity="0">&middot;</div>';
      } else {
        const logV = Math.log10(cell.value + 1);
        const intensity = logMax > 0 ? hmIntensity(logV, logMax) : (cell.count > 0 ? '2' : '0');
        const label = cell.count + ' &middot; ' + fmtMoney(cell.value);
        html += '<div class="hm-cell hm-funnel-cell" data-intensity="' + intensity
             +  '" data-office-id="' + hmEscAttr(o.id) + '"'
             +  ' data-hm-stage="' + hmEscAttr(st) + '"'
             +  ' title="' + hmEscAttr(o.name + ' - ' + st + ': ' + cell.count + ' sol, ' + fmtMoney(cell.value)) + '">'
             + label + '</div>';
      }
    });
  });
  html += '</div>';

  // Wire: sortable headers + cell click -> Solicitations filtered.
  setTimeout(() => {
    const wrap = document.getElementById('heatmapWrapper');
    if (!wrap) return;
    wrap.querySelectorAll('.hm-sortable[data-hm-sort]').forEach(el => {
      el.addEventListener('click', () => {
        const col = el.dataset.hmSort;
        const s = HEATMAP_SORT.funnel;
        if (s.col === col) s.dir = (s.dir === 'asc' ? 'desc' : 'asc');
        else { s.col = col; s.dir = (col === 'name' ? 'asc' : 'desc'); }
        renderHeatMaps();
      });
    });
    wrap.querySelectorAll('.hm-funnel-cell').forEach(el => {
      el.addEventListener('click', () => {
        // proposal cards instead of jumping to the Solicitations tab.
        const oid = el.dataset.officeId;
        const stage = el.dataset.hmStage;
        const underlying = HM_STAGE_STATUS[stage] || stage;
        const office = DB.get('offices', oid) || { id: oid, name: oid };
        const sols = (DB.list('solicitations') || []).filter(function(s) {
          return s && s.officeId === oid && s.status === underlying;
        }).sort(function(a, b) { return (Number(b.value)||0) - (Number(a.value)||0); });
        openHmDrawerSols({
          title: stage + ' \u2014 ' + (office.name || oid),
          subtitle: sols.length + ' proposal' + (sols.length===1?'':'s') + ' in this stage',
          sols: sols,
          stage: stage
        });
      });
    });
  }, 0);
  return html;
}



window.hmLegendHtml = hmLegendHtml;
window.renderHmEngagement = renderHmEngagement;
window.renderHmPriority = renderHmPriority;
window.renderHmServiceTier = renderHmServiceTier;
window.renderHmFunnel = renderHmFunnel;
