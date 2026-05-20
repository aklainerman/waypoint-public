// js/render/dashboard.js
//
// Dashboard render + filter + sort + wire cluster. Largest single
// extraction by line count in the Phase 1.2 refactor (~1,385 lines).
// Two non-contiguous source blocks from index.html were combined
// because the v199 source range straddled the v195 detail-panel.js
// module tag boundary:
//
//   Block A -- dashboard refresh/filter/sort/priority-state cluster
//              (originally ~lines 22281-22765 of the monolith). Closes
//              with `function savePriorityState() { ... }`.
//
//   Block B -- the big render functions (originally ~lines 22799-23667
//              of the monolith, inside a separate inline-script
//              fragment). renderDashboard + wireCards.
//
// Contents at a glance:
//
//   * 3 refresh funcs:    refreshDashboard, _decorateParentCards,
//                          refreshCardCounters
//   * card open/collapse: toggle, #expandAll / #collapseAll handlers,
//                          _initV97DashboardSectionCollapse IIFE
//   * filters / sort:     setActive, clearTagFilter,
//                          _activateRoleChip, tierOfLabel,
//                          applyTierVisibility, applyFilters,
//                          clearSearch + file-scope state
//                          (activeTags, activeRole, priorityOnlyActive,
//                          searchInput, ROLE_TO_TIER, CARD_NAMES, ...)
//   * priority state:     _migratePriorityLocalStorage,
//                          loadPriorityState, savePriorityState
//   * big renderers:      renderDashboard (~578 lines), wireCards
//                          (~270 lines)
//
// Originally at file-scope of the inline monolith; lifted to ES module
// in v199. Same classic-script-split pattern as v181-v198.
//
// Pre-extraction audit (v185 pattern). 7 names need window exposure;
// 4 are already attached in source and preserved verbatim:
//   window.toggle, window.clearSearch, window.renderDashboard,
//   window.wireCards.
// 3 new exposures added in the module footer:
//   window.refreshDashboard (detail-panel.js)
//   window.refreshCardCounters (4 monolith callers)
//   window.applyFilters (toggleKpiFilter at ~27470, 27473)
//
// External file-scope refs the block consumes: NONE.
//
// External function calls (all auto-hoisted to window from classic-
// script monolith decls OR exposed by sibling modules, all resolve
// at runtime via window-lookup): utils.js exports (~25 names),
// detail-panel.js (openDetailPanel), contacts.js (legislatorById,
// _legPartyKey, legislatorLabel), and ~25 monolith function decls
// (activateTab, _bovOfficeFy26Total, computeOrgBudget, ...).

// ---------------------------------------------------------------
//  DASHBOARD wiring (KPI rollup + per-card live counters)
// ---------------------------------------------------------------
function refreshDashboard() {
  // KPI tiles
  const cards = Array.from(document.querySelectorAll('.pae-card, .ousw-card'));
  const priorityCount = cards.filter(c => c.classList.contains('priority')).length;
  const sols = DB.list('solicitations');
  const totalTAM = sols.reduce((a,s) => a + (Number(s.value)||0), 0);
  const updates = {
    priority: priorityCount,
    champions: DB.list('contacts').filter(c => c.champion).length,
    contacts: DB.list('contacts').length,
    solicitations: sols.length,
    los: DB.list('letters').length,
    contracts: fmtMoney(DB.list('solicitations').filter(s => s.status === 'Won').reduce((a,s) => a + (Number(s.value)||0), 0)),
    tam: fmtMoney(totalTAM),
  };
  Object.entries(updates).forEach(([k, v]) => {
    const el = document.querySelector('[data-kpi="' + k + '"]');
    if (!el) return;
    el.textContent = v;
    const numeric = (typeof v === 'number') ? v : (v && v !== '\u2014' && v !== '$0' ? 1 : 0);
    el.parentElement.classList.toggle('has-data', numeric > 0);
  });
  if (typeof _decorateParentCards === 'function') {
    try { _decorateParentCards(); } catch (e) { console.warn('[v97-decorate]', e); }
  }
  // click the chip to reveal children. (v131 auto-expanded; user wanted
  // the dropdown affordance restored.)
}
// the user can collapse all of a parent's children inline without leaving
// the Overview tab. Children are looked up by offices.parent_id; the
// toggle hides only cards whose office has a resolvable parent on the
// dashboard. State persisted in localStorage by office.id.
function _decorateParentCards() {
  try {
    var KEY = 'waypoint-dash-parent-collapsed';
    function _load(){ try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch(_) { return {}; } }
    function _save(s){ try { localStorage.setItem(KEY, JSON.stringify(s)); } catch(_) {} }
    var dash = document.getElementById('tab-dashboard');
    if (!dash) return;
    var cards = Array.from(dash.querySelectorAll('.pae-card, .ousw-card'));
    if (!cards.length) return;
    var cardByOffice = {};
    cards.forEach(function(c){
      var oid = c.dataset.officeId || c.id;
      if (oid) cardByOffice[oid] = c;
    });
    var childMap = {};
    cards.forEach(function(c){
      var oid = c.dataset.officeId || c.id;
      var off = oid ? DB.get('offices', oid) : null;
      if (!off || !off.parent_id) return;
      if (!cardByOffice[off.parent_id]) return;
      (childMap[off.parent_id] = childMap[off.parent_id] || []).push(c);
    });
    var state = _load();
    Object.keys(childMap).forEach(function(parentOfficeId){
      var parentCard = cardByOffice[parentOfficeId];
      if (!parentCard) return;
      var children = childMap[parentOfficeId];
      children.forEach(function(c){ c.dataset.v97ParentOffice = parentOfficeId; });
      parentCard.querySelectorAll('.v97-parent-toggle').forEach(function(n){ n.remove(); });
      var chip = document.createElement('a');
      chip.className = 'v97-parent-toggle';
      chip.title = 'Show / hide children on the dashboard';
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:600;padding:1px 6px;margin-left:6px;border-radius:10px;background:var(--surface-alt);border:1px solid var(--border);color:var(--text-muted);cursor:pointer;text-decoration:none;vertical-align:middle;';
      var collapsed = !!state[parentOfficeId];
      chip.dataset.v97Collapsed = collapsed ? '1' : '0';
      function _renderChip(){
        var col = chip.dataset.v97Collapsed === '1';
        chip.innerHTML = (col ? '\u25b6 ' : '\u25bc ') + children.length + ' child' + (children.length===1?'':'ren');
      }
      _renderChip();
      function _apply(col){
        children.forEach(function(c){
          c.classList.toggle('v97-parent-collapsed', col);
          c.style.display = col ? 'none' : '';
        });
      }
      chip.addEventListener('click', function(e){
        e.preventDefault(); e.stopPropagation();
        var nowCollapsed = chip.dataset.v97Collapsed !== '1';
        chip.dataset.v97Collapsed = nowCollapsed ? '1' : '0';
        var s = _load();
        if (nowCollapsed) s[parentOfficeId] = 1; else delete s[parentOfficeId];
        _save(s);
        _renderChip();
        _apply(nowCollapsed);
      });
      var titleEl = parentCard.querySelector('.pae-title, .ousw-title') || parentCard;
      titleEl.appendChild(chip);
      if (collapsed) _apply(true);
      parentCard.classList.add('v97-is-parent');
    });
    // Annotate child cards with a subtle "\u21b3 parent" line in their lead area.
    cards.forEach(function(c){
      var oid = c.dataset.officeId || c.id;
      var off = oid ? DB.get('offices', oid) : null;
      if (!off || !off.parent_id) return;
      var parent = DB.get('offices', off.parent_id);
      if (!parent || !cardByOffice[parent.id]) return;
      c.querySelectorAll('.v97-parent-line').forEach(function(n){ n.remove(); });
      var line = document.createElement('div');
      line.className = 'v97-parent-line';
      line.style.cssText = 'font-size:10px;color:var(--text-muted);margin-top:2px;letter-spacing:0.2px;';
      line.innerHTML = '\u21b3 under <strong>' + escHtml(parent.name || parent.id) + '</strong>';
      var lead = c.querySelector('.pae-lead, .ousw-sub-title');
      if (lead) lead.parentNode.insertBefore(line, lead.nextSibling);
      else c.appendChild(line);
    });
  } catch (e) { console.error('[v97-parent-cards]', e); }
}

function refreshCardCounters() {
  // Per-card CON / SOL / LOS / CTR are live queries by office_id
  const counts = computeOfficeCounts();
  document.querySelectorAll('.pae-card, .ousw-card').forEach(card => {
    const officeId = card.dataset.officeId || card.id;
    const c = counts[officeId] || { contacts:0, solicitations:0, los:0, contracts:0 };
    const champsMap = championsByOffice();
    const map = { 'c-contacts': c.contacts, 'c-solicitations': c.solicitations, 'c-los': c.los, 'c-contracts': c.contracts, 'c-champions': (champsMap[officeId] || 0) };
    card.querySelectorAll('.counter-tag').forEach(tag => {
      const key = Array.from(tag.classList).find(cl => cl.startsWith('c-'));
      const v = (key in map) ? map[key] : 0;
      const num = tag.querySelector('.c-num');
      if (num) num.textContent = v;
      tag.classList.toggle('zero', v === 0);
    });
  });
}

// ---------------------------------------------------------------
//  Dashboard card behaviour (preserved from v11)
// ---------------------------------------------------------------
function toggle(headEl) {
  const card = headEl.closest('.pae-card');
  if (card) openDetailPanel(card);
}
window.toggle = toggle;

document.getElementById('expandAll').addEventListener('click', () => {
  document.querySelectorAll('.pae-card, .ousw-card').forEach(c => c.classList.add('open'));
  // exactly that.
  if (typeof _setSectionCollapsed === 'function') {
    document.querySelectorAll('.v98-tier-view-wrap .section-label').forEach(function(lbl){
      _setSectionCollapsed(lbl, false, /*persist=*/true);
    });
  }
});
document.getElementById('collapseAll').addEventListener('click', () => {
  document.querySelectorAll('.pae-card, .ousw-card').forEach(c => c.classList.remove('open'));
});

// click target with a chevron. Toggling hides/shows every following
// sibling element until the next .section-label, persisted in
// localStorage so collapsed state survives reload.
(function _initV97DashboardSectionCollapse(){
  var STORAGE_KEY = 'waypoint-dash-sect-collapsed';
  function _load() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function _save(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
  }
  function _key(lbl) { return (lbl.textContent || '').trim().slice(0, 80); }
  function _siblingsAfter(lbl) {
    var out = [];
    var n = lbl.nextElementSibling;
    while (n && !n.classList.contains('section-label')) { out.push(n); n = n.nextElementSibling; }
    return out;
  }
  function _applyCollapsed(lbl, collapsed) {
    _siblingsAfter(lbl).forEach(function(n){
      // Don't permanently hide structural .tier2-band wrappers; instead,
      // hide their inner content. Nested labels self-manage so we apply
      // visual state only to direct simple siblings.
      if (n.classList.contains('section-label')) return;
      // Don't hide our own collapse-spacer (added below) on a re-apply.
      if (n.classList.contains('v97-sect-spacer')) return;
      n.style.display = collapsed ? 'none' : '';
    });
    var chev = lbl.querySelector('.v97-sect-chev');
    if (chev) chev.textContent = collapsed ? '\u25b6' : '\u25bc';
    lbl.classList.toggle('v97-sect-collapsed', collapsed);
    // every block sibling between two adjacent labels is hidden, the labels
    // visually collapse onto the same row. Sit a 0-height, full-width block
    // spacer right after this label whenever it's collapsed; remove on expand.
    var nextSib = lbl.nextElementSibling;
    var hasSpacer = !!(nextSib && nextSib.classList && nextSib.classList.contains('v97-sect-spacer'));
    if (collapsed && !hasSpacer) {
      var s = document.createElement('div');
      s.className = 'v97-sect-spacer';
      s.style.cssText = 'display:block;height:0;width:100%;clear:both;line-height:0;';
      lbl.parentNode.insertBefore(s, nextSib);
    } else if (!collapsed && hasSpacer) {
      nextSib.parentNode.removeChild(nextSib);
    }
  }
  // Public-ish helper used by Expand all to flip everything open.
  window._setSectionCollapsed = function(lbl, collapsed, persist) {
    if (!lbl) return;
    _applyCollapsed(lbl, collapsed);
    if (persist) {
      var st = _load();
      var k = _key(lbl);
      if (collapsed) st[k] = 1; else delete st[k];
      _save(st);
    }
  };
  function _wireOne(lbl) {
    if (lbl.dataset.v97Wired === '1') return;
    lbl.dataset.v97Wired = '1';
    var chev = document.createElement('span');
    chev.className = 'v97-sect-chev';
    chev.style.cssText = 'display:inline-block;width:16px;text-align:center;cursor:pointer;color:var(--text-muted);margin-right:6px;font-size:11px;';
    chev.textContent = '\u25bc';
    lbl.insertBefore(chev, lbl.firstChild);
    lbl.style.cursor = 'pointer';
    lbl.style.userSelect = 'none';
    lbl.addEventListener('click', function(e){
      if (e.target.closest('a, button')) return;
      var st = _load();
      var k = _key(lbl);
      var nowCollapsed = !lbl.classList.contains('v97-sect-collapsed');
      _applyCollapsed(lbl, nowCollapsed);
      if (nowCollapsed) st[k] = 1; else delete st[k];
      _save(st);
    });
  }
  function _init() {
    var labels = document.querySelectorAll('.v98-tier-view-wrap .section-label');
    if (!labels.length) return;
    var st = _load();
    labels.forEach(function(lbl){
      _wireOne(lbl);
      var k = _key(lbl);
      if (st[k]) _applyCollapsed(lbl, true);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
document.getElementById('priorityOnly').addEventListener('click', function() {
  if (priorityOnlyActive) {
    priorityOnlyActive = false;
    this.classList.remove('active');
    const allBtn = document.getElementById('showAll');
    if (allBtn) allBtn.classList.add('active');
  } else {
    priorityOnlyActive = true;
    setActive(this);
  }
  applyFilters();
});
document.getElementById('showAll').addEventListener('click', function() {
  priorityOnlyActive = false;
  activeRole = 'all';
  setActive(this);
  clearTagFilter();
  document.getElementById('searchInput').value = '';
  document.querySelectorAll('.role-chip').forEach(c => c.classList.remove('active'));
  const allChip = document.querySelector('.role-chip[data-role-filter="all"]');
  if (allChip) allChip.classList.add('active');
  applyFilters();
});
function setActive(btn) {
  document.querySelectorAll('#priorityOnly, #showAll').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

let activeTags = new Set();
document.querySelectorAll('.tag-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const tag = chip.dataset.tag;
    if (activeTags.has(tag)) { activeTags.delete(tag); chip.classList.remove('active'); }
    else { activeTags.add(tag); chip.classList.add('active'); }
    applyFilters();
  });
});
function clearTagFilter() {
  activeTags.clear();
  document.querySelectorAll('.tag-chip').forEach(c => c.classList.remove('active'));
}

const searchInput = document.getElementById('searchInput');
searchInput.addEventListener('input', () => applyFilters());

document.querySelectorAll('.xref').forEach(link => {
  link.addEventListener('click', (e) => {
    e.stopPropagation();
    const targetId = link.dataset.target;
    const target = document.getElementById(targetId);
    if (!target) return;
    document.querySelectorAll('.highlighted').forEach(el => el.classList.remove('highlighted'));
    target.classList.add('open');
    target.classList.remove('hidden');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => target.classList.add('highlighted'), 400);
    setTimeout(() => target.classList.remove('highlighted'), 2200);
  });
});

// ---------------------------------------------------------------
//  Pipeline connections + role badges (preserved from v11)
// ---------------------------------------------------------------
const CARD_NAMES = {};

// ---------------------------------------------------------------
//  Tier filter (preserved from v11)
// ---------------------------------------------------------------
let activeRole = 'all';
// even if one path fails:
//   (a) Per-chip click listeners attached at script-load (legacy, kept).
//   (b) Event-delegated listener on #roleBar — catches clicks even if (a)
//       never attached (e.g. earlier line threw) or the chip element was
//       later replaced. dataset.v173Delegated guards against double-wiring.
// Section-label clicks are intentionally NOT hijacked here — the v97
// collapse handler already owns the same element and stopImmediatePropagation
// would race with it (registration order forces v97 to fire first). The
// .role-chip strip is the canonical tier-toggle affordance.
function _activateRoleChip(chip) {
  if (!chip) return;
  document.querySelectorAll('.role-chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  activeRole = chip.dataset.roleFilter || 'all';
  // Reset the Show-all/Priority-only pair so the toolbar reflects reality.
  var showBtn = document.getElementById('showAll');
  var prioBtn = document.getElementById('priorityOnly');
  if (showBtn) showBtn.classList.toggle('active', activeRole === 'all' && !priorityOnlyActive);
  if (prioBtn) prioBtn.classList.toggle('active', !!priorityOnlyActive);
  try { applyFilters(); }
  catch (err) { console.error('[v173-role-chip] applyFilters failed', err); }
}
document.querySelectorAll('.role-chip').forEach(chip => {
  chip.addEventListener('click', () => _activateRoleChip(chip));
});
(function _wireRoleBarDelegation() {
  var roleBar = document.getElementById('roleBar');
  if (!roleBar || roleBar.dataset.v173Delegated === '1') return;
  roleBar.dataset.v173Delegated = '1';
  roleBar.addEventListener('click', function (e) {
    var chip = e.target.closest('.role-chip');
    if (!chip || !roleBar.contains(chip)) return;
    _activateRoleChip(chip);
  });
})();
const defaultRoleChip = document.querySelector('.role-chip[data-role-filter="all"]');
if (defaultRoleChip) defaultRoleChip.classList.add('active');
const ROLE_TO_TIER = { 'strategy':'1', 'acquisition':'2', 'end-user':'3', 'demand-arbiter':'4', 'oversight':'5' };
let priorityOnlyActive = false;
function tierOfLabel(labelEl) {
  // first child of every .section-label, so textContent starts with the
  // chevron rather than 'Tier'.  Strip leading whitespace + chevron chars
  // before matching the tier number.  Without this strip, every label
  // resolves to tier=null and applyTierVisibility() hides EVERY section
  // whenever the user selects anything other than 'All tiers'.
  var t = (labelEl.textContent || '').replace(/^[\s\u25b6\u25bc]+/, '');
  var m = t.match(/^Tier\s*(\d)/);
  return m ? m[1] : null;
}
function applyTierVisibility() {
  const activeTier = activeRole === 'all' ? null : ROLE_TO_TIER[activeRole];
  const dash = document.querySelector('.v98-tier-view-wrap');
  // Ensure structural wrapper is re-shown before we decide anew
  dash.querySelectorAll('.tier2-band').forEach(el => el.style.display = '');
  const labels = Array.from(dash.querySelectorAll('.section-label'));
  labels.forEach((label) => {
    const tier = tierOfLabel(label);
    const show = !activeTier || tier === activeTier;
    label.style.display = show ? '' : 'none';
    let node = label.nextElementSibling;
    while (node && !node.classList.contains('section-label')) {
      // Never hide the tier2-band wrapper itself — it contains other tiers.
      // Individual Tier 2 section-labels will handle visibility inside the band.
      if (!node.classList.contains('tier2-band')) {
        node.style.display = show ? '' : 'none';
      }
      node = node.nextElementSibling;
    }
  });
  // Final pass: show/hide the tier2-band itself based on whether we're
  // currently showing Tier 2 (any sub-tier). Hides the "The money layer"
  // label + gray border when filtering to Tier 1/3/4/5.
  const band = dash.querySelector('.tier2-band');
  if (band) {
    band.style.display = (!activeTier || activeTier === '2') ? '' : 'none';
  }
}
function applyFilters() {
  const query = searchInput.value.trim().toLowerCase();
  let visibleCount = 0;
  document.querySelectorAll('.v98-tier-view-wrap .pae-card, .v98-tier-view-wrap .ousw-card').forEach(card => {
    const cardText = card.textContent.toLowerCase();
    const cardTags = (card.dataset.tags || '').split(' ');
    const matchesSearch = !query || cardText.includes(query);
    const matchesTags = activeTags.size === 0 || Array.from(activeTags).every(t => cardTags.includes(t));
    const matchesPriority = !priorityOnlyActive || card.classList.contains('priority');
    if (matchesSearch && matchesTags && matchesPriority) {
      card.classList.remove('hidden'); visibleCount++;
    } else {
      card.classList.add('hidden');
    }
  });
  applyTierVisibility();
  if (typeof applyKpiFilterPass === 'function') applyKpiFilterPass();
  document.getElementById('noResults').classList.toggle('show', visibleCount === 0);
}
function clearSearch(e) {
  if (e) e.preventDefault();
  searchInput.value = '';
  clearTagFilter();
  applyFilters();
}
window.clearSearch = clearSearch;

// ---------------------------------------------------------------
//  Priority toggle + counter tags decoration
//  Phase 3 Part B: state lives in DB (offices.priority). This file-level
//  migration runs once to move any legacy localStorage priorities into DB.
// ---------------------------------------------------------------
const PRIORITY_KEY = 'dow-outreach-priorities-v5';  // legacy, for one-shot migration only
let _priorityMigrationDone = false;
function _migratePriorityLocalStorage() {
  if (_priorityMigrationDone) return;
  _priorityMigrationDone = true;
  let raw;
  try { raw = localStorage.getItem(PRIORITY_KEY); } catch (e) { raw = null; }
  if (!raw) return;
  let saved;
  try { saved = JSON.parse(raw); } catch (e) { saved = null; }
  if (!Array.isArray(saved) || !saved.length) {
    try { localStorage.removeItem(PRIORITY_KEY); } catch (e) { /* ignore */ }
    return;
  }
  const keys = new Set(saved);
  let migrated = 0;
  (DB.state.offices || []).forEach(o => {
    // Old format stored either dashboardCardId or office id.
    const hit = (o.dashboardCardId && keys.has(o.dashboardCardId)) || keys.has(o.id);
    if (hit && !o.priority) {
      DB.upsert('offices', { id: o.id, priority: true });
      migrated++;
    }
  });
  try { localStorage.removeItem(PRIORITY_KEY); } catch (e) { /* ignore */ }
  if (migrated) console.info('[priority] migrated ' + migrated + ' entries from localStorage to DB');
}
function loadPriorityState() {
  // Run the one-shot migration first (idempotent after the first call).
  _migratePriorityLocalStorage();
  // Then mirror DB.state.offices[].priority onto the dashboard DOM so existing
  // CSS (.pae-card.priority / .ousw-card.priority) renders correctly.
  const priCardIds = new Set();
  const priOfficeIds = new Set();
  (DB.state.offices || []).forEach(o => {
    if (!o.priority) return;
    if (o.dashboardCardId) priCardIds.add(o.dashboardCardId);
    if (o.id) priOfficeIds.add(o.id);
  });
  document.querySelectorAll('.pae-card, .ousw-card').forEach(c => {
    const matches = (c.id && priCardIds.has(c.id)) ||
                    (c.dataset && c.dataset.officeId && priOfficeIds.has(c.dataset.officeId));
    if (matches) c.classList.add('priority');
    else c.classList.remove('priority');
  });
}
// savePriorityState is retained as a no-op for backward compatibility in case
// any stray caller survives. New code should call DB.upsert directly.
function savePriorityState() { /* no-op; priority is persisted via DB.upsert */ }

// ---------------------------------------------------------------
// Block B begins: renderDashboard + wireCards (originally in a
// separate inline-script fragment after the detail-panel.js tag)
// ---------------------------------------------------------------

// ---------------------------------------------------------------
//  renderDashboard() — Phase 2 dynamic renderer.
//  Reads DB.state.offices (populated by DB.load()) and emits the
//  canonical 57 cards into the empty tier containers in the HTML.
//
//  Tier selection: primary role picked in the canonical priority
//  order (Strategy > Acquisition > End-User > COCOM > Oversight).
//  Matrix orgs (multiple roles) render once in their primary tier
//  with an "also in: X" indicator.
//
//  Tier 2 sub-tiers come from offices.echelon ('2a','2b','2c').
//  Within grouped tiers (2a, 3, 5) cards are bucketed by
//  offices.dashboard_group and rendered into .service wrappers
//  with matching .service-header labels.
//
//  Phase 2 card body is deliberately minimal — title/lead/pitch.
//  Phase 3 rebuilds the body with data-driven sections pulled
//  from related tables.
// ---------------------------------------------------------------
function renderDashboard() {
  const offices = (DB.state.offices || [])
    .filter(o => o && o.show_on_dashboard)
    .slice()
    .sort((a, b) => (a.sort_order ?? 99999) - (b.sort_order ?? 99999));

  const PRIORITY_ORDER = ['strategy','acquisition','end-user','demand-arbiter','oversight'];

  function arr(v) {
    if (Array.isArray(v)) return v;
    if (v == null) return [];
    if (typeof v === 'string') {
      try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (e) { return []; }
    }
    return [];
  }
  function primaryRole(o) {
    const roles = arr(o.roles);
    for (const r of PRIORITY_ORDER) { if (roles.includes(r)) return r; }
    return roles[0] || null;
  }
  function secondaryTierRoles(o, primary) {
    const roles = arr(o.roles);
    return roles.filter(r => r !== primary && PRIORITY_ORDER.includes(r));
  }
  function escHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
  }
  function escAttr(s) { return escHtml(s); }
  function firstLeadership(o) {
    const l = arr(o.leadership);
    return l.length ? String(l[0]) : '';
  }
  function tagsMarkup(tags) {
    const xs = arr(tags);
    if (!xs.length) return '';
    return '<div class="card-tags">' +
      xs.map(t => '<span class="card-tag">#' + escHtml(t) + '</span>').join('') +
      '</div>';
  }
  function roleLabelPretty(r) {
    return r.replace(/-/g,' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  function matrixIndicator(secondaries) {
    if (!secondaries || !secondaries.length) return '';
    return '<div class="matrix-indicator" style="font-size:11px;opacity:0.75;margin-top:2px;">also in: ' +
      escHtml(secondaries.map(roleLabelPretty).join(', ')) + '</div>';
  }
  function noteMarkup(o) {
    if (!o.short_description) return '';
    return '<div class="note"><strong>Pitch angle:</strong> ' + escHtml(o.short_description) + '</div>';
  }
  function dataAttrs(o) {
    const parts = [
      'id="' + escAttr(o.id) + '"',
      'data-office-id="' + escAttr(o.id) + '"',
    ];
    const roleAttr = arr(o.roles).join(' ');
    if (roleAttr) parts.push('data-role="' + escAttr(roleAttr) + '"');
    const feeds = arr(o.dashboard_feeds).join(' ');
    if (feeds) parts.push('data-feeds="' + escAttr(feeds) + '"');
    const auths = arr(o.dashboard_authorizes).join(' ');
    if (auths) parts.push('data-authorizes="' + escAttr(auths) + '"');
    const tags = arr(o.tags).join(' ');
    if (tags) parts.push('data-tags="' + escAttr(tags) + '"');
    return parts.join(' ');
  }
  function deptColorClass(o) {
    const d = String(o.department || '').toLowerCase();
    if (d.includes('air force') || d === 'af') return 'af';
    if (d.includes('army'))    return 'army';
    if (d.includes('marine'))  return 'marines';
    if (d.includes('navy'))    return 'navy';
    if (d.includes('socom'))   return 'joint';
    if (d.includes('joint'))   return 'joint';
    return '';
  }
  // ---------------- Phase 3 · Part A · card-body helpers ----------------
  // Quick lookups computed once per render so per-card work stays O(offices).
  const _officesById   = new Map();
  const _officesByUuid = new Map();
  const _children      = new Map();  // uuid -> [office,...] (parent_id or also_reports_to)
  for (const o of (DB.state.offices || [])) {
    if (o.id)     _officesById.set(o.id, o);
    if (o.id_new) _officesByUuid.set(o.id_new, o);
  }
  function _pushChild(key, office) {
    if (!key) return;
    if (!_children.has(key)) _children.set(key, []);
    _children.get(key).push(office);
  }
  for (const o of (DB.state.offices || [])) {
    if (o.parent_id) _pushChild(o.parent_id, o);
    const alsoReports = arr(o.also_reports_to);
    for (const r of alsoReports) _pushChild(r, o);
  }

  function deptLabel(d) {
    const k = String(d || '').toLowerCase();
    if (k === 'af' || k.includes('air force')) return 'AF';
    if (k === 'army' || k.includes('army'))    return 'Army';
    if (k === 'navy' || k.includes('navy'))    return 'Navy';
    if (k === 'marines' || k.includes('marine')) return 'Marines';
    if (k === 'socom')   return 'SOCOM';
    if (k === 'osd')     return 'OSD';
    if (k === 'joint')   return 'Joint';
    if (k === 'congress' || k.includes('hill')) return 'Congress';
    if (!d) return '';
    return String(d);
  }
  function deptChipClass(d) {
    const k = String(d || '').toLowerCase();
    if (k === 'af' || k.includes('air force')) return 'af';
    if (k === 'army' || k.includes('army'))    return 'army';
    if (k === 'navy' || k.includes('navy'))    return 'navy';
    if (k === 'marines' || k.includes('marine')) return 'marines';
    if (k === 'socom')   return 'joint';
    if (k === 'osd')     return 'osd';
    if (k === 'joint')   return 'joint';
    if (k === 'congress' || k.includes('hill')) return 'hill';
    return '';
  }
  function deptChipMarkup(o) {
    const label = deptLabel(o.department);
    if (!label) return '';
    const cls = deptChipClass(o.department);
    return '<span class="dept-chip' + (cls ? ' ' + cls : '') + '">' + escHtml(label) + '</span>';
  }
  function shortDescMarkup(o) {
    if (!o.short_description) return '';
    return '<div class="pae-desc" style="font-size:11.5px;color:var(--text-muted);margin-top:4px;line-height:1.4;">' +
           escHtml(o.short_description) + '</div>';
  }
  function leadershipSectionMarkup(o) {
    const items = arr(o.leadership);
    if (!items.length) return '';
    const lis = items.map(x => '<li>' + escHtml(String(x)) + '</li>').join('');
    return '<div class="detail-section">' +
           '<div class="detail-label">Leadership</div>' +
           '<ul style="margin:0;padding-left:18px;font-size:12px;line-height:1.5;">' + lis + '</ul>' +
           '</div>';
  }
  function _countContracts(o)     { return (DB.state.solicitations || []).filter(x => x.status === 'Won' && x.office_id_new === o.id_new).length; }
  function _countSolicitations(o) { return (DB.state.solicitations || []).filter(x => x.office_id_new === o.id_new).length; }
  function _countLetters(o)       { return (DB.state.letters       || []).filter(x => x.office_id_new === o.id_new).length; }
  function _countContacts(o) {
    return (DB.state.contacts || []).filter(c => {
      const xs = arr(c.office_ids_new);
      return xs.indexOf(o.id_new) !== -1;
    }).length;
  }
  function _childrenCount(o) { return (_children.get(o.id_new) || []).length; }
  // ---------------- Phase 4 · hierarchy expansion helpers ----------------
  function childrenChipMarkup(o) {
    const n = _childrenCount(o);
    if (!n) return '';
    const uuid = escAttr(o.id_new || '');
    const label = n + ' ' + (n === 1 ? 'child' : 'children') + ' \u25BE';
    return '<button type="button" class="children-chip" data-parent-uuid="' + uuid + '" title="Show direct children">' +
           escHtml(label) + '</button>';
  }
  function miniCardMarkup(o, depth) {
    const uuid = escAttr(o.id_new || '');
    const oid  = escAttr(o.id || '');
    const chip = deptChipMarkup(o);
    // (star + dept chip + name only). Per-org descriptions live on the
    // detail panel that opens when the card is clicked.
    const cls = ['mini-card'];
    if (o.priority) cls.push('priority');
    const cc = childrenChipMarkup(o);
    return '<div class="' + cls.join(' ') + '" data-office-id="' + oid + '" data-uuid="' + uuid + '" data-depth="' + depth + '" style="cursor:pointer;">' +
      '<div class="mini-head">' +
        '<span class="priority-toggle mini-star' + (o.priority ? ' active' : '') + '" title="Toggle priority" data-mini-prio="' + oid + '">\u2605</span>' +
        (chip ? chip : '') +
        '<span class="mini-title">' + escHtml(o.name || o.id) + '</span>' +
      '</div>' +
      (cc ? '<div class="mini-footer">' + cc + '</div>' : '') +
    '</div>';
  }
  // Expose the closure-scoped helpers for wireCards' delegated handler.
  // (Re-assigned on every renderDashboard so the _children map stays fresh.)
  window.__DOW_P4 = {
    getChildren: function(uuid) { return _children.get(uuid) || []; },
    miniCardMarkup: miniCardMarkup,
  };
  function _parentLink(o) {
    if (!o.parent_id) return '';
    const p = _officesByUuid.get(o.parent_id);
    if (!p) return '';
    const onDash = !!p.show_on_dashboard;
    const label = escHtml(p.name || p.id || '');
    if (onDash) {
      return '<a class="rel-link xref" data-target="' + escAttr(p.id) + '">' + label + '</a>';
    }
    return '<span>' + label + '</span>';
  }
  function _relRow(label, count, tab, officeId) {
    // Clickable rows jump to the target tab and pre-filter by office.
    // Rows with count 0 render as plain dim text (not linked).
    const lbl = escHtml(label);
    const cnt = String(count);
    if (count > 0 && tab && officeId) {
      return '<div class="rel-link-row">' +
             '<a class="rel-link" data-jump="' + escAttr(tab) + '" data-office="' + escAttr(officeId) + '">' +
             lbl + ' <strong>' + cnt + '</strong></a>' +
             '</div>';
    }
    return '<div class="rel-link-row" style="opacity:0.55;">' + lbl + ' <strong>' + cnt + '</strong></div>';
  }
  function relatedSectionMarkup(o) {
    const rows = [];
    // Parent (only if set and resolvable; per handoff, nothing is set yet)
    const parent = _parentLink(o);
    if (parent) rows.push('<div class="rel-link-row">Parent: ' + parent + '</div>');
    // Children — interactive chip (Phase 4). Clicking opens inline drawer.
    const chipHtml = childrenChipMarkup(o);
    if (chipHtml) rows.push('<div class="rel-link-row">Children: ' + chipHtml + '</div>');
    // Related records (always emitted so the section has a predictable shape)
    rows.push(_relRow('Contracts',     _countContracts(o),     'solicitations', o.id));
    rows.push(_relRow('Solicitations', _countSolicitations(o), 'solicitations', o.id));
    rows.push(_relRow('Contacts',      _countContacts(o),      'contacts',      o.id));
    rows.push(_relRow('Letters',       _countLetters(o),       'letters',       o.id));
    return '<div class="detail-section">' +
           '<div class="detail-label">Related</div>' +
           '<div class="related-panel" style="display:block;padding:0;background:transparent;border:0;">' +
             rows.join('') +
           '</div>' +
           '</div>';
  }
  function budgetSectionMarkup(o) {
    // v168-tierview-fix: replaced the static "No budget data" placeholder
    // with a real inline budget summary. Uses _bovOfficeFy26Total (which
    // returns the CURRENT focus-year total despite its name — FY27 in the
    // default view, FY26 in ?year=2026 mode) for the headline number and
    // computeOrgBudget for the PE count when budget_org_id is set.
    // Returns '' when the org has no budget signal at all so the section
    // just doesn't render instead of falsely claiming zero budget.
    // data-source="card-budget" lets the drawer hide this block via CSS
    // (the drawer's #panel-budget shows a richer version of the same data).
    if (!o) return '';
    var total = 0;
    try {
      if (typeof _bovOfficeFy26Total === 'function') {
        total = _bovOfficeFy26Total(o) || 0;
      }
    } catch (e) { total = 0; }
    if (!total || total <= 0) return '';
    var peCount = 0;
    if (o.budget_org_id && typeof computeOrgBudget === 'function') {
      try {
        var _b = computeOrgBudget(o.budget_org_id, o.id);
        if (_b && _b.peCount) peCount = _b.peCount;
      } catch (e) { /* swallow */ }
    }
    var yLabel = (typeof window !== 'undefined' && typeof window._v147Y === 'function')
      ? window._v147Y(0)
      : 'FY27';
    var fmt = (typeof fmtBudget === 'function') ? fmtBudget : function(n){ return String(n); };
    var pesBit = peCount > 0 ? (' \u00b7 ' + peCount + ' PE' + (peCount === 1 ? '' : 's')) : '';
    return '<div class="detail-section" data-source="card-budget">' +
           '<div class="detail-label">Budget</div>' +
           '<div style="font-size:13px;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums;">' + fmt(total) + '</div>' +
           '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">' + yLabel + ' request' + pesBit + '</div>' +
           '</div>';
  }
  function locationSectionMarkup(o) {
    // Leadership. Hidden when empty so card bodies stay compact.
    const loc = (o.location || '').trim();
    if (!loc) return '';
    return '<div class="detail-section">' +
           '<div class="detail-label">Location</div>' +
           '<div style="font-size:12px;line-height:1.5;">' + escHtml(loc) + '</div>' +
           '</div>';
  }
  function cardBodyInner(o) {
    // panel covers contracts/contacts/letters/solicitations). Add
    // locationSectionMarkup above Leadership.
    return locationSectionMarkup(o) + leadershipSectionMarkup(o) + budgetSectionMarkup(o);
  }

  function renderOuswCard(o) {
    const primary = primaryRole(o);
    const secondaries = secondaryTierRoles(o, primary);
    const cls = ['ousw-card'];
    if (o.priority) cls.push('priority');
    const chip = deptChipMarkup(o);
    // so it is always visible (no expand required) and its clicks are
    // handled by the Block H delegated handler on #tab-dashboard.
    const kidChip = childrenChipMarkup(o);
    const kidBar = kidChip ? '<div class="children-bar" style="padding:4px 10px 10px 10px;">' + kidChip + '</div>' : '';
    return '<div class="' + cls.join(' ') + '" ' + dataAttrs(o) + '>' +
      '<div class="ousw-head">' + escHtml(o.name || o.id) + (chip ? ' ' + chip : '') + '</div>' +
      '<div class="ousw-sub">' + escHtml(firstLeadership(o)) + '</div>' +
      kidBar +
      '<div class="ousw-body">' + cardBodyInner(o) + '</div>' +
    '</div>';
  }
  function renderPaeCard(o, colorClass) {
    const primary = primaryRole(o);
    const secondaries = secondaryTierRoles(o, primary);
    const cls = ['pae-card'];
    if (colorClass) cls.push(colorClass);
    if (o.priority) cls.push('priority');
    const chip = deptChipMarkup(o);
    // not trip toggle()/openDetailPanel. Block H catches the bubbled
    // click on #tab-dashboard and opens the inline drawer.
    const kidChip = childrenChipMarkup(o);
    // sit on the card's bottom border.
    const kidBar = kidChip ? '<div class="children-bar" style="padding:4px 12px 10px 12px;">' + kidChip + '</div>' : '';
    return '<div class="' + cls.join(' ') + '" ' + dataAttrs(o) + '>' +
      '<div class="pae-head" onclick="toggle(this)">' +
        '<div class="pae-head-text">' +
          '<div class="pae-title">' + escHtml(o.name || o.id) + (chip ? ' ' + chip : '') + '</div>' +
          '<div class="pae-lead">' + escHtml(firstLeadership(o)) + '</div>' +
          tagsMarkup(o.tags) +
        '</div>' +
        '<span class="chevron">&#9656;</span>' +
      '</div>' +
      kidBar +
      '<div class="pae-body">' + cardBodyInner(o) + '</div>' +
    '</div>';
  }
  function groupOrdered(cards) {
    // empty so newly-toggled show_on_dashboard orgs nest under the
    // correct service header instead of floating in a trailing null
    // bucket. Idempotent — service-header render re-normalizes.
    const order = [], map = new Map();
    for (const c of cards) {
      const raw = c.dashboard_group || c.department || null;
      const g = raw ? (normalizeGroupLabel(raw) || raw) : null;
      if (!map.has(g)) { map.set(g, []); order.push(g); }
      map.get(g).push(c);
    }
    return order.map(g => ({ group: g, cards: map.get(g) }));
  }
  // form. Keeps Navy + Marine Corps in one group. Safe to re-apply.
  function normalizeGroupLabel(g) {
    // HASC / SASC subcommittee groups also shortened.
    if (!g) return g;
    const s = String(g).trim();
    const k = s.toLowerCase();
    if (k === 'department of the army' || k === 'army' || k === 'dept. of the army') return 'Army';
    if (k === 'department of the navy' || k === 'navy' || k === 'navy / marines' || k === 'navy/marines' || k === 'marines' || k === 'marine corps' || k === 'dept. of the navy') return 'Navy';
    if (k === 'department of the air force' || k === 'air force' || k === 'dept. of the air force' || k === 'af') return 'Air Force';
    if (k === 'socom' || k === 'ussocom' || k === 'united states special operations command' || k === 'special operations command' || k === 'joint sof theater commands' || k === 'joint sof' || k === 'sof theater commands') return 'SOCOM';
    if (k === 'hasc' || k === 'hasc subcommittees' || k === 'house armed services committee' || k === 'house armed services') return 'HASC';
    if (k === 'sasc' || k === 'sasc subcommittees' || k === 'senate armed services committee' || k === 'senate armed services') return 'SASC';
    if (k === 'osd' || k === 'osw' ||
        k === 'department of war' || k === 'department of defense' ||
        k === 'dod' || k === 'dow' ||
        k === 'office of the secretary of war' ||
        k === 'office of the secretary of war (osd)' ||
        k === 'office of the secretary of war (osw)' ||
        k === 'office of the secretary of defense' ||
        k === 'office of the secretary of defense (osd)') return 'OSW';
    if (k === 'congress' || k === 'hill') return 'Congress';
    return s;
  }
  function setHtml(id, s) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = s;
  }

  // Bucket by primary tier
  const b = { t1: [], t2a: [], t2b: [], t2c: [], t3: [], t4: [], t5: [] };
  const FORCE_2C_IDS = new Set(['afwerx','spacewerx','aal','navalx','pit','sofwerx']);
  for (const o of offices) {
    if (FORCE_2C_IDS.has(String(o.id||'').toLowerCase())) { b.t2c.push(o); continue; }
    const p = primaryRole(o);
    if (p === 'strategy')            b.t1.push(o);
    else if (p === 'acquisition') {
      const e = String(o.echelon || '').toLowerCase();
      if (e === '2b') b.t2b.push(o);
      else if (e === '2c') b.t2c.push(o);
      else b.t2a.push(o);
    }
    else if (p === 'end-user')       b.t3.push(o);
    else if (p === 'demand-arbiter') b.t4.push(o);
    else if (p === 'oversight')      b.t5.push(o);
  }

  // ---- Tier 1 split ASW vs other ----
  setHtml('dash-tier1-asw',   b.t1.filter(o => String(o.id||'').startsWith('asw-')).map(renderOuswCard).join(''));
  setHtml('dash-tier1-other', b.t1.filter(o => !String(o.id||'').startsWith('asw-')).map(renderOuswCard).join(''));

  // ---- Tier 2(a/b/c): v51 canonical 5-column render ----
  // Always emit AF / Army / Navy / SOCOM / OSW in fixed left-to-right order
  // so all three Tier-2 rows align vertically. Empty dept columns still emit
  // their banner; any non-canonical named groups append after.
  // HEAD probe, all 200 OK). Keys must match normalizeGroupLabel() output.
  const DEPT_INSIGNIA = {
    'Air Force': { src: 'https://upload.wikimedia.org/wikipedia/commons/8/8e/Seal_of_the_United_States_Department_of_the_Air_Force.svg', alt: 'Seal of the United States Department of the Air Force' },
    'Army':      { src: 'https://upload.wikimedia.org/wikipedia/commons/f/fa/Emblem_of_the_U.S._Department_of_the_Army.svg',           alt: 'Emblem of the United States Department of the Army' },
    'Navy':      { src: 'https://upload.wikimedia.org/wikipedia/commons/0/09/Seal_of_the_United_States_Department_of_the_Navy.svg',    alt: 'Seal of the United States Department of the Navy' },
    'SOCOM':     { src: 'https://upload.wikimedia.org/wikipedia/commons/1/10/United_States_Special_Operations_Command_Insignia.svg',   alt: 'United States Special Operations Command insignia' },
    'OSW':       { src: 'https://upload.wikimedia.org/wikipedia/commons/c/c4/Seal_of_the_United_States_Department_of_War_%282025%29.svg', alt: 'Seal of the United States Department of War' }
  };
  function insigniaImg(deptLabel, cls) {
    const meta = DEPT_INSIGNIA[deptLabel];
    if (!meta) return '';
    return '<img class="' + (cls || 'service-insignia') + '" src="' +
           escAttr(meta.src) + '" alt="' + escAttr(meta.alt) +
           '" loading="lazy" decoding="async" referrerpolicy="no-referrer">';
  }
  const T2_DEPT_ORDER = ['Air Force', 'Army', 'Navy', 'SOCOM', 'OSW'];
  // v168-tierview: forceColor (optional) — when set, all cards in this
  //                tier render with the same colorClass (e.g. 'enduser'
  //                for Tier 3) instead of per-card dept colours.
  function renderT2ByDept(cards, forceColor) {
    const pickColor = forceColor
      ? function(_c) { return forceColor; }
      : deptColorClass;
    const byDept = new Map();
    for (const d of T2_DEPT_ORDER) byDept.set(d, []);
    const other = new Map();   // preserve insertion order for non-canonical groups
    const ungrouped = [];
    for (const c of cards) {
      const raw = c.dashboard_group || c.department || null;
      const g = raw ? (normalizeGroupLabel(raw) || raw) : null;
      if (g && byDept.has(g)) byDept.get(g).push(c);
      else if (g) {
        if (!other.has(g)) other.set(g, []);
        other.get(g).push(c);
      } else {
        ungrouped.push(c);
      }
    }
    const parts = [];
    for (const dept of T2_DEPT_ORDER) {
      const ccs = byDept.get(dept);
      const header = '<div class="service"><div class="service-header enduser">' + insigniaImg(dept) + escHtml(dept) + '</div>';
      const body = ccs.map(c => renderPaeCard(c, pickColor(c))).join('');
      parts.push(header + body + '</div>');
    }
    for (const [g, ccs] of other) {
      const header = '<div class="service"><div class="service-header enduser">' + insigniaImg(g) + escHtml(g) + '</div>';
      const body = ccs.map(c => renderPaeCard(c, pickColor(c))).join('');
      parts.push(header + body + '</div>');
    }
    if (ungrouped.length) {
      const body = ungrouped.map(c => renderPaeCard(c, pickColor(c))).join('');
      parts.push('<div class="service">' + body + '</div>');
    }
    return parts.join('');
  }
  setHtml('dash-tier2a', renderT2ByDept(b.t2a));
  setHtml('dash-tier2b', renderT2ByDept(b.t2b));
  setHtml('dash-tier2c', renderT2ByDept(b.t2c));

  // ---- Tier 3: v168-tierview canonical 5-column render ----
  // Mirrors Tier 2(a/b/c) — always emit AF / Army / Navy / SOCOM / OSW
  // banners in fixed order so an empty service column (e.g. OSW with no
  // Tier-3 orgs) still appears as a placeholder rather than collapsing
  // out and re-expanding the other 4. forceColor='enduser' keeps the
  // existing Tier-3 card colour scheme.
  setHtml('dash-tier3', renderT2ByDept(b.t3, 'enduser'));

  // ---- Tier 4: flat cocom cards ----
  setHtml('dash-tier4', b.t4.map(c => renderPaeCard(c, 'cocom')).join(''));

  // ---- Tier 5 priority committees: flat row of pae-cards ----
  // v168-tier5-committees: mirror the Hill Ops Summary predicate exactly
  // (`hill_committees.show_on_summary === true`). Render each as a pae-card
  // with `hill` color so it looks identical to the existing Tier 5 oversight
  // cards / Tier 4 cocom cards. Click routes to openHillCommitteeDrawer via
  // the `data-committee-card` marker + the broadened pae-card click handler
  // (see wireCards block G).
  function renderCommitteePaeCard(c) {
    if (!c || !c.thomas_id) return '';
    const cls = ['pae-card', 'hill'];
    if (c.is_priority) cls.push('priority');
    const ch = String(c.chamber || '').toLowerCase();
    const chamberLabel = ch === 'senate' ? 'Senate' : (ch === 'house' ? 'House' : (c.chamber || ''));
    const kindLabel    = c.parent_thomas_id ? 'Subcommittee' : 'Committee';
    const subtitle     = [chamberLabel, kindLabel].filter(Boolean).join(' \u00b7 ');
    const chamberChip  = chamberLabel
      ? ('<span class="dept-chip hill">' + escHtml(chamberLabel.toUpperCase()) + '</span>')
      : '';
    return '<div class="' + cls.join(' ') + '" '
         +   'data-summary-tid="' + escAttr(c.thomas_id) + '" '
         +   'data-committee-tid="' + escAttr(c.thomas_id) + '" '
         +   'data-committee-card="1" '
         +   'data-office-id="committee:' + escAttr(c.thomas_id) + '" '
         +   'style="cursor:pointer;">'
         +   '<div class="pae-head">'
         +     '<div class="pae-head-text">'
         +       '<div class="pae-title">' + escHtml(c.name || c.thomas_id) + (chamberChip ? ' ' + chamberChip : '') + '</div>'
         +       '<div class="pae-lead">' + escHtml(subtitle) + '</div>'
         +     '</div>'
         +     '<span class="chevron">\u25B8</span>'
         +   '</div>'
         + '</div>';
  }
  {
    const _allComms = (DB.list && DB.list('hill_committees')) || [];
    const priorityComms = _allComms
      .filter(c => c && c.show_on_summary)
      .slice()
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    setHtml('dash-tier5-committees', priorityComms.map(renderCommitteePaeCard).join(''));
  }

  // ---- Tier 5: grouped by dashboard_group, banner=enduser (v51), body=hill ----
  {
    const parts = groupOrdered(b.t5).map(({ group, cards }) => {
      const header = group ? '<div class="service"><div class="service-header enduser">' + escHtml(normalizeGroupLabel(group)) + '</div>' : '<div class="service">';
      const body = cards.map(c => renderPaeCard(c, 'hill')).join('');
      return header + body + '</div>';
    });
    setHtml('dash-tier5', parts.join(''));
  }

  // Re-tag tier labels with .tier-anchor for the sticky-nav highlight logic
  document.querySelectorAll('.v98-tier-view-wrap .section-label').forEach(label => {
    const m = label.textContent.match(/^Tier (\d)(?!\()/);
    if (m) label.classList.add('tier-anchor');
    if (/^Tier 2\(a\)/.test(label.textContent)) label.classList.add('tier-anchor');
  });
}
window.renderDashboard = renderDashboard;

// ============================================================================
// renderDashboard() rebuilds every #dash-tier* grid via setHtml(), which
// replaces the .pae-card / .ousw-card DOM nodes as fresh, undecorated
// cards.  wireCards() does the heavy decoration (priority star + counter-
// tags + click handlers).  Without re-running wireCards after every render,
// cards built by reloadForYear() / hcEditSave() / etc end up bare.
//
// Wrap window.renderDashboard so every invocation is followed by:
//   1) wireCards() - now idempotent (see Block A/F/G dataset.v174*Bind flags).
//   2) loadPriorityState() - repaint the .priority class on cards.
//   3) refreshCardCounters() - populate the just-inserted CON/SOL/LOS/CHP/CTR.
//   4) applyFilters() - re-apply the current tier-toggle so a re-render
//      doesn't silently clear the user's Tier 1/2/3/4/5 selection.
// ============================================================================
(function _installRenderDashboardWrapper() {
  if (typeof window.renderDashboard !== 'function') return;
  if (window.renderDashboard._wrapped) return;
  var _orig = window.renderDashboard;
  function wrapped() {
    var ret = _orig.apply(this, arguments);
    try { if (typeof wireCards === 'function') wireCards(); }
    catch (e) { console.warn('[v174-wireCards]', e); }
    try { if (typeof loadPriorityState === 'function') loadPriorityState(); }
    catch (e) {}
    try { if (typeof refreshCardCounters === 'function') refreshCardCounters(); }
    catch (e) { console.warn('[v174-refreshCardCounters]', e); }
    try { if (typeof applyFilters === 'function') applyFilters(); }
    catch (e) {}
    return ret;
  }
  wrapped._wrapped = true;
  window.renderDashboard = wrapped;
})();

// ---------------------------------------------------------------
//  wireCards() — re-runnable card decoration / binding pass.
//  Called once from boot after renderDashboard() inserts the 57
//  canonical cards. Consolidates the scattered top-level binds
//  that existed in v40; each still operates on the same DOM it
//  always did, just deferred until cards exist.
// ---------------------------------------------------------------
function wireCards() {
  // --- A: ousw-card single-click open panel (legacy binding) ---
  document.querySelectorAll('.ousw-card').forEach(c => {
    if (c.dataset.v174ABind === '1') return;
    c.dataset.v174ABind = '1';
    c.addEventListener('click', (e) => {
      if (e.target.closest('.xref, .priority-toggle, .counter-tag, .rel-link, .panel-btn, .children-chip')) return;
      openDetailPanel(c);
    });
  });

  // --- B/C/D: card-name map, pipeline connections, rel-link handlers ---
  document.querySelectorAll('.pae-card, .ousw-card').forEach(c => {
    if (!c.id) return;
    const titleEl = c.querySelector('.pae-title') || c.querySelector('.ousw-head');
    if (titleEl) CARD_NAMES[c.id] = titleEl.textContent.replace(/ ★$/, '').trim();
  });
  function mkLink(id) { return '<a class="rel-link xref" data-target="' + id + '">' + (CARD_NAMES[id] || id) + '</a>'; }
  function mkRow(label, ids) {
    const unique = Array.from(new Set(ids.filter(i => CARD_NAMES[i])));
    if (!unique.length) return '';
    return '<div class="rel-row"><div class="rel-label">' + label + '</div><div class="rel-targets">' + unique.map(mkLink).join('') + '</div></div>';
  }
  document.querySelectorAll('.pae-card, .ousw-card').forEach(card => {
    const id = card.id; if (!id) return;
    const body = card.querySelector('.pae-body, .ousw-body'); if (!body) return;
    // (data-feeds / data-authorizes) was sparse and the UI needs
    // re-architecting before it can be surfaced usefully.
    const cardRoles = (card.dataset.role || '').split(/\s+/).filter(Boolean);
    if (cardRoles.length) {
      const badgeDiv = document.createElement('div');
      badgeDiv.className = 'role-badges';
      badgeDiv.innerHTML = cardRoles.map(r => '<span class="role-badge ' + r + '">' + r.replace('-', ' ') + '</span>').join('');
      const target = card.querySelector('.pae-head-text');
      if (target) target.appendChild(badgeDiv);
      else { const sub = card.querySelector('.ousw-sub'); if (sub) sub.after(badgeDiv); }
    }
  });
  document.querySelectorAll('.rel-link.xref').forEach(link => {
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetId = link.dataset.target;
      const target = document.getElementById(targetId);
      if (!target) return;
      document.querySelectorAll('.highlighted').forEach(el => el.classList.remove('highlighted'));
      target.classList.add('open'); target.classList.remove('hidden');
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => target.classList.add('highlighted'), 400);
      setTimeout(() => target.classList.remove('highlighted'), 2200);
    });
  });

  // --- E: apply persisted priority state ---
  loadPriorityState();

  // --- F: priority-toggle star + counter-tags decoration ---
  // wireCards() can be re-called after every renderDashboard() without
  // double-decorating.  The star + tags blocks are gated individually
  // since either can already exist independently.
  document.querySelectorAll('.pae-card, .ousw-card').forEach(card => {
    var _alreadyStar = !!card.querySelector(':scope > .priority-toggle, :scope > .pae-head > .priority-toggle');
    var _alreadyTags = !!card.querySelector(':scope .counter-tags');
    if (_alreadyStar && _alreadyTags) return;
    const star = document.createElement('span');
    star.className = 'priority-toggle';
    star.textContent = '★';
    star.title = 'Toggle priority';
    star.setAttribute('role', 'button');
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      const officeId = card.dataset.officeId || card.id;
      const o = DB.get('offices', officeId);
      if (o) {
        toggleOfficePriority(o.id);
        card.classList.toggle('priority', !!(DB.get('offices', o.id) || {}).priority);
      } else {
        // Fallback: DOM-only toggle for cards with no backing record.
        card.classList.toggle('priority');
        refreshDashboard();
        if (document.getElementById('tab-offices').classList.contains('active')) renderOffices();
      }
    });

    const tags = document.createElement('div');
    tags.className = 'counter-tags';
    const types = [
      ['c-contacts',      'CON', 'Contacts',      'contacts'],
      ['c-solicitations', 'SOL', 'Solicitations', 'solicitations'],
      ['c-los',           'LOS', 'Letters of Support', 'letters'],
      ['c-champions',     'CHP', 'Champions',     'contacts'],
      ['c-contracts',     'CTR', 'Awarded Contracts', 'contracts'],
    ];
    tags.innerHTML = types.map(([cls, label, full]) =>
      '<span class="counter-tag ' + cls + ' zero" title="' + full + '" data-tooltip="' + full + '">' + label + ' <span class="c-num">0</span></span>'
    ).join('');
    // Tag click → jump to corresponding tab pre-filtered to this office.
    const TAG_TARGETS = {
      'c-contacts':       { tab: 'contacts' },
      'c-solicitations':  { tab: 'solicitations' },
      'c-los':            { tab: 'letters' },
      'c-champions':      { tab: 'contacts',      extra: { championsOnly: true } },
      'c-contracts':      { tab: 'solicitations', extra: { wonOnly: true } },
    };
    tags.querySelectorAll('.counter-tag').forEach((tag) => {
      tag.addEventListener('click', (e) => {
        e.stopPropagation();
        const cls = Array.from(tag.classList).find(c => /^c-/.test(c));
        const target = TAG_TARGETS[cls] || { tab: 'offices' };
        const officeId = card.dataset.officeId || card.id;
        activateTab(target.tab, Object.assign({ officeId }, target.extra || {}));
      });
    });

    if (card.classList.contains('pae-card')) {
      const head = card.querySelector('.pae-head');
      const headText = card.querySelector('.pae-head-text');
      if (headText && !_alreadyTags) {
        const leadEl = headText.querySelector('.pae-lead');
        if (leadEl) headText.insertBefore(tags, leadEl);
        else headText.appendChild(tags);
      }
      if (head && !_alreadyStar) {
        const chev = head.querySelector('.chevron');
        if (chev) head.insertBefore(star, chev);
        else head.appendChild(star);
      }
    } else {
      if (!_alreadyTags) {
        const sub = card.querySelector('.ousw-sub');
        if (sub) sub.parentNode.insertBefore(tags, sub);
        else { const body = card.querySelector('.ousw-body'); if (body) card.insertBefore(tags, body); else card.appendChild(tags); }
      }
      if (!_alreadyStar) card.insertBefore(star, card.firstChild);
    }
  });

  // --- G: pae-card/ousw-card click -> open detail panel ---
  // v168-tier5-committees: cards with data-committee-card="1" are Hill
  // committee tiles in Tier 5; route those to the committee drawer
  // instead of openDetailPanel (which expects an office DB row).
  // (reloadForYear() rebuilds these cards every budget-year change).
  document.querySelectorAll('.pae-card, .ousw-card').forEach(card => {
    if (card.dataset.v174GBind === '1') return;
    card.dataset.v174GBind = '1';
    card.addEventListener('click', (e) => {
      if (e.target.closest('.xref, .priority-toggle, .counter-tag, .rel-link, .panel-btn, .children-chip')) return;
      e.stopPropagation();
      if (card.dataset && card.dataset.committeeCard) {
        var tid = card.dataset.summaryTid || card.dataset.committeeTid;
        if (tid && typeof openHillCommitteeDrawer === 'function') {
          openHillCommitteeDrawer(tid);
          return;
        }
      }
      openDetailPanel(card);
    });
  });
  // --- Phase 3 Part A: Related-section row click -> jump to tab with office filter ---
  document.querySelectorAll('.rel-link[data-jump]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const tab = a.dataset.jump;
      const officeId = a.dataset.office || '';
      if (!tab) return;
      if (officeId) { activateTab(tab, { officeId }); }
      else          { activateTab(tab); }
    });
  });
  // --- H: Phase 4 · hierarchy expansion (delegated handler) ---
  // Handles: (1) mini-card priority star, (2) children-chip toggle,
  // (3) depth-3 "Too deep — open in Graph?" prompt + focus.
  // Control) AND tab-offices (Tier View). Click events don't cross sibling
  // sections, so a single host binding misses one of the two views.
  const __p4Hosts = [
    document.getElementById('tab-dashboard'),
    document.getElementById('tab-offices'),
  ].filter(Boolean);
  __p4Hosts.forEach(function (__p4Host) {
  if (__p4Host && !__p4Host.dataset.p4Wired) {
    __p4Host.dataset.p4Wired = '1';
    __p4Host.addEventListener('click', (e) => {
      // Excludes star/chip so those keep their own behaviors.
      const miniCard = e.target.closest('.mini-card');
      if (miniCard
          && !e.target.closest('.priority-toggle, .children-chip, .xref, .panel-btn, .counter-tag, .rel-link')) {
        e.stopPropagation();
        e.preventDefault();
        if (typeof openDetailPanel === 'function') {
          try { openDetailPanel(miniCard); } catch (_e) { console.warn('[v134-mini-card-open]', _e); }
        }
        return;
      }
      // (1) Mini-card priority toggle
      const priBtn = e.target.closest('.mini-card .priority-toggle');
      if (priBtn) {
        e.stopPropagation();
        e.preventDefault();
        const oid = priBtn.dataset.miniPrio;
        const o = oid && DB.get('offices', oid);
        if (o) {
          toggleOfficePriority(o.id);
          const now = !!(DB.get('offices', o.id) || {}).priority;
          const mini = priBtn.closest('.mini-card');
          if (mini) mini.classList.toggle('priority', now);
          priBtn.classList.toggle('active', now);
        }
        return;
      }
      // (2) / (3) Children-chip
      const chip = e.target.closest('.children-chip');
      if (!chip) return;
      e.stopPropagation();
      e.preventDefault();
      const parentUuid = chip.dataset.parentUuid;
      if (!parentUuid) return;
      const host = chip.closest('.mini-card, .pae-card, .ousw-card');
      if (!host) return;
      const hostDepth = host.classList.contains('mini-card')
        ? (parseInt(host.dataset.depth, 10) || 0)
        : 0;
      const drawerDepth = hostDepth + 1;

      // Toggle off if already expanded
      if (host.classList.contains('children-open')) {
        const sib = host.nextElementSibling;
        if (sib && sib.classList.contains('children-drawer')) sib.remove();
        host.classList.remove('children-open');
        chip.textContent = chip.textContent.replace('\u25B4', '\u25BE');
        return;
      }

      // Depth 3+ -> prompt and jump to Graph
      if (drawerDepth >= 3) {
        if (window.confirm('Too deep \u2014 open in Graph?')) {
          activateTab('graph');
          setTimeout(() => {
            try {
              if (typeof focusNeighborhood === 'function' &&
                  typeof GRAPH !== 'undefined' && GRAPH && GRAPH.cy) {
                focusNeighborhood(parentUuid);
              }
            } catch (err) { console.warn('[p4] graph focus failed', err); }
          }, 350);
        }
        return;
      }

      // Lazy-render drawer (depth 1 or 2)
      const api = window.__DOW_P4;
      if (!api || typeof api.getChildren !== 'function') return;
      const kids = api.getChildren(parentUuid);
      if (!kids.length) return;
      const drawer = document.createElement('div');
      drawer.className = 'children-drawer';
      drawer.dataset.depth = String(drawerDepth);
      drawer.innerHTML = kids.map(c => api.miniCardMarkup(c, drawerDepth)).join('');
      host.parentNode.insertBefore(drawer, host.nextSibling);
      host.classList.add('children-open');
      chip.textContent = chip.textContent.replace('\u25BE', '\u25B4');
    });
  }
  }); // v133: end forEach over __p4Hosts
}
window.wireCards = wireCards;


// =================================================================
// inside the extracted blocks (window.toggle, window.clearSearch,
// window.renderDashboard, window.wireCards). The 3 lines below add
// the remaining exposures the audit identified.
// =================================================================
window.refreshDashboard = refreshDashboard;
window.refreshCardCounters = refreshCardCounters;
window.applyFilters = applyFilters;
