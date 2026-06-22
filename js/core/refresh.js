// js/core/refresh.js
//
// refreshAll orchestrator + small data-migration + chip / badge /
// lookup helpers, lifted from the inline monolith in v201 across two
// non-contiguous source blocks that straddled the v188 map.js
// module-tag boundary.
//
// Block A (originally ~lines 22441-22484):
//   refreshAll()         -- top-level refresh dispatcher. Calls
//                            refreshTabCounts (drillthrough.js),
//                            refreshDashboard + refreshCardCounters
//                            (dashboard.js), then re-renders whichever
//                            tab panel is active by calling its
//                            renderX function.
//
// Block B (originally ~lines 22644-22699):
//   migrateDepts()       -- runtime data-migration. Normalizes
//                            stale DIU/DARPA/CDAO/Hill/etc. service
//                            values into their canonical buckets;
//                            fire-and-forget pushes via _supaUpsert.
//                            Called once from the Boot IIFE.
//   orgCell(officeId)    -- single-office chip producer
//   orgCells(officeIds,
//            legislatorBg) -- v167 chip list with optional Hill
//                            legislator chip merge
//   deptBadge(dept)      -- post-v131 replacement for the legacy
//                            deptChip; delegates to svcBadge from
//                            utils.js for consistent Orgs-tab styling
//   championsByOffice()  -- {officeId -> championCount} aggregate
//                            built from DB.list('contacts')
//
// Pre-extraction audit (v185 pattern). 6 names need window exposure
// (every top-level decl in this module is externally referenced):
//   refreshAll              -- 8 monolith callers + many js/ callers
//   migrateDepts            -- 2 monolith callers (Boot IIFE)
//   orgCell                 -- sols.js, lets.js
//   orgCells                -- contacts.js
//   deptBadge               -- contacts.js, lets.js, sols.js
//   championsByOffice       -- 4 monolith callers + dashboard.js,
//                              detail-panel.js, heatmaps.js
//
// External file-scope refs the block consumes: NONE.
//
// External function calls (all auto-hoisted to window OR exposed by
// sibling modules, all resolve at runtime via window-lookup):
//   refreshTabCounts        (drillthrough.js)
//   refreshDashboard /
//   refreshCardCounters     (dashboard.js)
//   render* per-tab
//   escHtml, svcBadge,
//   legislatorChipHtml      (utils.js)
//   DB, _supaUpsert         (window globals from boot path / monolith)

// ---------------------------------------------------------------
//  Boot
// ---------------------------------------------------------------
function refreshAll() {
  refreshTabCounts();
  refreshDashboard();
  refreshCardCounters();
  // Re-render whichever tab is visible
  const active = document.querySelector('.tab-panel.active');
  if (!active) return;
  switch (active.dataset.tabPanel) {
    case 'offices': {
      renderOffices();
      const _sbo = document.querySelector('[data-subtab-group="offices"] .subtab-btn.active');
      const _subo = _sbo ? _sbo.dataset.subtab : 'offices-list';
      if (_subo === 'offices-map' && typeof renderMap === 'function') renderMap();
      break;
    }
    case 'contacts': {
      renderContacts();
      if (typeof renderGraph === 'function' && document.querySelector('[data-subtab-group="contacts"] .subtab-btn.active[data-subtab="contacts-graph"]')) renderGraph();
      break;
    }
    case 'solicitations': {
      renderSols();
      const _sb = document.querySelector('[data-subtab-group="sols"] .subtab-btn.active');
      const _sub = _sb ? _sb.dataset.subtab : 'sols-list';
      if (_sub === 'sols-kanban') renderSolKanban();
      else if (_sub === 'sols-funnel') renderSolFunnel();
      else if (_sub === 'sols-heatmaps' && typeof renderHeatMaps === 'function') renderHeatMaps();
      break;
    }
    case 'letters': renderLets(); break;
    case 'washops': renderWos(); break;
    case 'budget':  renderBudget(); break;
    case 'dashboard': {
      if (typeof renderMissionControl === 'function') {
        try { renderMissionControl(); } catch (e) { console.warn('[mc]', e); }
      }
      break;
    }
  }
}

// ---------------------------------------------------------------
// Block B begins: migrateDepts + chip helpers (originally inside
// the inline-script fragment that came after the map.js module tag)
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// ---------------------------------------------------------------

// Runtime migration: normalize stale DIU/DARPA/CDAO/Hill/etc. service values.
// Called once from the async boot sequence, after Supabase load completes.
function migrateDepts() {
  const MAP = {
    'DIU':'OSD','DARPA':'OSD','CDAO':'OSD','Hill':'Congress',
    'Space Force':'Other','DHS':'Other','DoD':'OSD',
  };
  (DB.state.offices || []).forEach(o => {
    if (MAP[o.service]) {
      o.service = MAP[o.service];
      _supaUpsert('offices', o); // fire-and-forget push of the normalized row
    }
  });
}

// Bold plain-text renderer for an office name (shared across tabs).
function orgCell(officeId) {
  if (!officeId) return '<span class="org-cell">—</span>';
  const o = DB.get('offices', officeId);
  if (!o) return '<span class="org-cell">—</span>';
  return '<span class="org-cell" data-office-jump="' + o.id + '">' + escHtml(o.name || '') + '</span>';
}
function orgCells(officeIds, legislatorBg, fallbackOrg) {
  const ids = (officeIds || []).filter(Boolean);
  const legChip = legislatorChipHtml(legislatorBg);
  if (!ids.length && !legChip) {
    if (fallbackOrg) return '<span class="org-cell">' + escHtml(fallbackOrg) + '</span>';
    return '<span class="org-cell">—</span>';
  }
  const parts = [];
  ids.forEach(id => {
    const o = DB.get('offices', id);
    if (o) parts.push('<span data-office-jump="' + o.id + '">' + escHtml(o.name || '') + '</span>');
  });
  if (legChip) parts.push(legChip);
  return '<span class="org-cell">' + parts.join('<span class="org-sep">·</span>') + '</span>';
}


// Replacement for deptChip: uses svcBadge so visual style matches Orgs tab.
function deptBadge(dept) {
  if (!dept) return '<span class="svc-badge svc-Other">—</span>';
  return svcBadge(dept);
}

// Champion-count-per-office: extends computeOfficeCounts without overriding it.
function championsByOffice() {
  const out = {};
  DB.list('contacts').forEach(c => {
    if (!c.champion) return;
    (c.officeIds||[]).forEach(oid => { out[oid] = (out[oid]||0) + 1; });
  });
  return out;
}

// =================================================================
// =================================================================
window.refreshAll = refreshAll;
window.migrateDepts = migrateDepts;
window.orgCell = orgCell;
window.orgCells = orgCells;
window.deptBadge = deptBadge;
window.championsByOffice = championsByOffice;
