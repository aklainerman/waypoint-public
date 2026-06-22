// js/render/offices.js
//
// Orgs (Offices) CRM table renderer + office helpers. Combines two
// inline-script fragments from the monolith:
//
//   Fragment A -- the OFFICES tab body: department helpers
//     (officeDepartmentById, contactDepartment, solicitationDepartment,
//     deptChip), the main renderOffices(~194 lines), and
//     officeIsPriority + toggleOfficePriority.
//
//   Fragment B -- computeOfficeCounts(), a small standalone helper
//     that lived in its own inline-script chunk between
//     modal/office.js and render/contacts.js module tags. Heavily
//     consumed by renderOffices and 5 extracted modules.
//
// Pre-extraction audit (v185 pattern). 8 names need window exposure
// (every top-level decl is externally referenced); all 8 added in
// the footer.
//
// External file-scope refs consumed: NONE.
// External function calls (resolve at runtime via window-lookup):
//   DB                        -- window global
//   refreshDashboard          -- dashboard.js
//   renderGraph, GRAPH        -- monolith
//   escHtml, svcBadge,
//   fmtMoney, statusPill,
//   alignmentStars            -- utils.js
//   activateTab               -- monolith
//   championsByOffice         -- core/refresh.js
//   computeOrgBudget,
//   _bovOfficeFy26Total       -- db/rollup.js + monolith
//   legislatorChipHtml,
//   legislatorById,
//   legislatorLabel,
//   _legPartyKey              -- utils.js + contacts.js

// ---------------------------------------------------------------
//  OFFICES tab
// ---------------------------------------------------------------

// ---------------------------------------------------------------
// ---------------------------------------------------------------
function officeDepartmentById(officeId) {
  if (!officeId) return '';
  const o = DB.get('offices', officeId);
  return o ? (o.service || '') : '';
}
function contactDepartment(c) {
  // Direct department field wins (set via the Department dropdown in the form).
  if (c && c.department) return c.department;
  // who works for a senator is fundamentally a Hill person, even if they
  // also liaise with a DoW org on the side. Resolve to 'Congress' before
  // falling through to the office check. This makes the DEPT badge
  // populate the instant the user picks a Member in the Add Contact
  // modal's "Link to > Congress" pane, with no office required.
  if (c && c.legislator_bioguide_id) return 'Congress';
  // First office's department wins; fall back to branch heuristic.
  const oids = c.officeIds || [];
  for (const oid of oids) {
    const dept = officeDepartmentById(oid);
    if (dept) return dept;
  }
  // Heuristic from branch field
  const b = (c.branch || '').trim().toLowerCase();
  if (!b) return '';
  if (b.includes('sof') || b.includes('socom')) return 'SOCOM';
  if (b.includes('usaf') || b.includes('air force') || b.startsWith('ang')) return 'Air Force';
  if (b.includes('army') || b.includes('national guard')) return 'Army';
  if (b.includes('navy')) return 'Navy';
  if (b.includes('usmc') || b.includes('marine')) return 'Marines';
  if (b.includes('ousd') || b.includes('osd') || b === 'diu' || b === 'dod') return 'OSD';
  if (b.includes('indopacom') || b.includes('transcom') || b.includes('cocom')) return 'Joint';
  if (b.includes('space')) return 'Other';
  if (b.includes('dhs')) return 'Other';
  return 'Other';
}
function solicitationDepartment(s) {
  // officeId wins; fallback to s.department (seeded from CSV)
  const dept = officeDepartmentById(s.officeId);
  if (dept) return dept;
  const d = (s.department || '').trim();
  if (!d) return '';
  // Normalize seeded values to the 9 canonical departments
  const map = { 'DoD':'OSD','Air Force':'Air Force','Army':'Army','Navy':'Navy',
                'Marines':'Marines','SOCOM':'SOCOM','TRANSCOM':'Joint',
                'Other':'Other','Coast Guard':'Other' };
  return map[d] || 'Other';
}
function deptChip(dept) {
  if (!dept) return '<span class="dept-chip other">—</span>';
  const slug = dept.toLowerCase().replace(/\s+/g, '');
  // Normalize unknown to 'other'
  const known = ['osd','airforce','army','navy','marines','socom','joint','congress','other'];
  const cls = known.includes(slug) ? slug : 'other';
  return '<span class="dept-chip ' + cls + '">' + escHtml(dept) + '</span>';
}

// Champion toggle — delegated listener. Any click on .champ-toggle flips the
// champion flag and triggers a full refresh.
document.addEventListener('click', function(e) {
  const el = e.target.closest('[data-champ-toggle]');
  if (!el) return;
  e.stopPropagation();
  const cid = el.dataset.champToggle;
  const c = DB.get('contacts', cid);
  if (!c) return;
  DB.upsert('contacts', Object.assign({}, c, { champion: !c.champion }));
  refreshAll();
});

function renderOffices() {
  const tbody = document.querySelector('#officesTable tbody');
  const q = (document.getElementById('officesSearch').value || '').toLowerCase();
  const svc = document.getElementById('officesServiceFilter').value;
  const tier = document.getElementById('officesTierFilter').value;
  const prio = document.getElementById('officesPriorityOnly').checked;
  const hasChpOnly = (document.getElementById('officesHasChpOnly')||{}).checked || false;
  const hasSolOnly = (document.getElementById('officesHasSolOnly')||{}).checked || false;
  const hasLosOnly = (document.getElementById('officesHasLosOnly')||{}).checked || false;

  // Refresh service filter options
  const svcSel = document.getElementById('officesServiceFilter');
  const svcs = Array.from(new Set(DB.list('offices').map(o => o.service).filter(Boolean))).sort();
  const cur = svcSel.value;
  const _fixedDepts = ['OSD','Air Force','Army','Navy','Marines','SOCOM','Joint','Congress','Other'];
  const _allDepts = Array.from(new Set([..._fixedDepts, ...svcs]));
  svcSel.innerHTML = '<option value="">All departments</option>' + _allDepts.map(s => '<option' + (s===cur?' selected':'') + '>'+escHtml(s)+'</option>').join('');

  const counts = computeOfficeCounts();
  const champsByOffice = championsByOffice();
  let rows = DB.list('offices').filter(o => {
    if (svc && o.service !== svc) return false;
    if (tier && (o.tier || '-') !== tier) return false;
    if (prio && !officeIsPriority(o)) return false;
    const _cnt = counts[o.id] || {contacts:0,solicitations:0,los:0,contracts:0};
    const _champ = champsByOffice[o.id] || 0;
    if (hasChpOnly && _champ === 0) return false;
    if (hasSolOnly && (_cnt.solicitations||0) === 0) return false;
    if (hasLosOnly && (_cnt.los||0) === 0) return false;
    if (q) {
      const blob = [o.name, o.fullName, o.service, o.location, o.notes, (o.tags||[]).join(' ')].join(' ').toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });

  rows = applySort(rows, 'offices', {
    name: r => r.name,
    fullName: r => r.fullName,
    service: r => r.service,
    tier: r => {
      const t = (r.tier || '-').toString();
      return t === '-' ? 'zzz' : t;
    },
    fy26Funding: r => (typeof _bovOfficeFy26Total === 'function') ? (_bovOfficeFy26Total(r) || 0) : 0,
    contacts: r => counts[r.id]?.contacts||0, solicitations: r => counts[r.id]?.solicitations||0,
    los: r => counts[r.id]?.los||0, contracts: r => counts[r.id]?.contracts||0,
    champions: r => champsByOffice[r.id] || 0,
    priority: r => officeIsPriority(r) ? 1 : 0,
    location: r => r.location || '',
  });

  document.getElementById('officesCount').textContent = rows.length + ' orgs';

  // = fall back to flat for searchability. Top-level rows = those whose
  // parent's id_new isn't in the visible set (or who have no parent).
  const _filtered = !!(q || svc || tier || prio || hasChpOnly || hasSolOnly || hasLosOnly);
  function _emitOfficeRow(o, depth, childCount) {
    const c = counts[o.id] || {};
    const isPrio = officeIsPriority(o);
    const isExpanded = window._orgExpanded && window._orgExpanded.has(o.id);
    let chev = '';
    if (childCount > 0) {
      chev = '<span class="v142-chev" data-v142-toggle="' + escAttr(o.id) + '" '
        + 'title="' + (isExpanded ? 'Collapse' : 'Expand') + ' subordinate units" '
        + 'style="display:inline-block;width:14px;text-align:center;cursor:pointer;'
        + 'color:var(--text-muted);font-size:10px;user-select:none;margin-right:4px;'
        + 'vertical-align:middle;'
        + 'transform:' + (isExpanded ? 'rotate(90deg)' : 'rotate(0deg)') + ';'
        + 'transition:transform 0.15s;">\u25B6</span>';
    } else {
      chev = '<span style="display:inline-block;width:14px;margin-right:4px;vertical-align:middle;"></span>';
    }
    const indent = depth > 0
      ? '<span style="display:inline-block;width:' + (depth*16) + 'px;vertical-align:middle;"></span>'
      : '';
    const childBadge = childCount > 0
      ? ' <span class="v142-childcount" title="' + childCount + ' subordinate unit' + (childCount===1?'':'s')
        + '" style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:8px;'
        + 'background:var(--surface-2);color:var(--text-muted);font-size:9px;font-weight:600;'
        + 'vertical-align:middle;">' + childCount + '</span>'
      : '';
    return '<tr class="' + (isPrio ? 'priority-row' : '') + ' v142-row v142-depth-' + depth + '" data-id="' + o.id + '">'
      + '<td><span class="priority-toggle" data-prio-toggle="' + o.id + '">\u2605</span></td>'
      + '<td class="td-org" style="white-space:nowrap;min-width:300px;">'
        + indent + chev
        + '<strong style="display:inline-block;vertical-align:middle;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escAttr(o.name||'') + '">' + escHtml(o.name) + '</strong>'
        + childBadge
        + (o.dashboardCardId ? ' <span class="card-tag" title="Linked to Dashboard" style="vertical-align:middle;">\ud83d\udcca</span>' : '')
        + budgetOrgBadge(o)
      + '</td>'
      + '<td class="td-truncate" title="' + escHtml(o.fullName||'') + '">' + escHtml(o.fullName || '') + '</td>'
      + '<td>' + svcBadge(o.service) + '</td>'
      + '<td>' + escHtml(o.tier || '\u2014') + '</td>'
      + '<td class="td-fy26-funding" data-bov-jump="' + escAttr(o.id) + '" '
          + 'title="Click to open Budget \u203A Office View" '
          + 'style="cursor:pointer;font-weight:600;">'
          + ((typeof _bovOfficeFy26Total === 'function' && _bovOfficeFy26Total(o)) ? fmtBudget(_bovOfficeFy26Total(o)) : '\u2014')
          + '</td>'
      + '<td>' + (c.contacts||0) + '</td>'
      + '<td>' + (c.solicitations||0) + '</td>'
      + '<td>' + (c.los||0) + '</td>'
      + '<td>' + (champsByOffice[o.id] || 0) + '</td>'
      + '<td>' + (c.contracts||0) + '</td>'
      + '<td class="td-truncate" title="' + escHtml(o.location||'') + '">' + escHtml(o.location || '') + '</td>'
      + '<td class="td-actions">'
        + '<button class="btn-icon" data-edit="' + o.id + '">Edit</button>'
        + '<button class="btn-icon danger" data-del="' + o.id + '">Del</button>'
      + '</td>'
    + '</tr>';
  }
  let html;
  if (_filtered) {
    // Flat mode (preserves v141 search behavior).
    html = rows.map(o => _emitOfficeRow(o, 0, 0)).join('');
  } else {
    // Hierarchical mode. Build childless lookups, then walk top-down.
    if (!window._orgExpanded) window._orgExpanded = new Set();
    const _byId = new Map();
    rows.forEach(r => { if (r.id_new) _byId.set(String(r.id_new), r); });
    const _childrenByParentUuid = new Map();
    rows.forEach(r => {
      const p = r.parent_id ? String(r.parent_id) : '';
      if (!p) return;
      if (!_byId.has(p)) return; // parent not in visible set -> treat as top-level
      if (!_childrenByParentUuid.has(p)) _childrenByParentUuid.set(p, []);
      _childrenByParentUuid.get(p).push(r);
    });
    const _topLevel = rows.filter(r => {
      const p = r.parent_id ? String(r.parent_id) : '';
      return !p || !_byId.has(p);
    });
    // SORT_STATE['offices'] so that clicking a column header in the
    // Orgs table actually reorders the table (was broken since v142 --
    // the prior _sortChildren wrap re-sorted alphabetically by name,
    // silently overriding the user's column sort). Children inside a
    // parent stay alphabetical-by-name because that's the hierarchy's
    // natural display order, independent of the top-level sort.
    const _sortChildren = arr => arr.slice().sort((a,b) => (a.name||'').localeCompare(b.name||''));
    const out = [];
    function _walk(o, depth) {
      const kids = _childrenByParentUuid.get(String(o.id_new||'')) || [];
      out.push(_emitOfficeRow(o, depth, kids.length));
      if (kids.length && window._orgExpanded.has(o.id)) {
        _sortChildren(kids).forEach(k => _walk(k, depth+1));
      }
    }
    _topLevel.forEach(o => _walk(o, 0));
    html = out.join('');
  }
  tbody.innerHTML = html || '<tr><td colspan="13" style="text-align:center;color:var(--text-dim);padding:1.5rem;">No offices match.</td></tr>';

  tbody.querySelectorAll('[data-v142-toggle]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = el.getAttribute('data-v142-toggle');
      if (!window._orgExpanded) window._orgExpanded = new Set();
      if (window._orgExpanded.has(id)) window._orgExpanded.delete(id);
      else window._orgExpanded.add(id);
      renderOffices();
    });
  });

  // Wire row actions
  tbody.querySelectorAll('[data-bov-jump]').forEach(td => td.addEventListener('click', (e) => {
    e.stopPropagation();
    var oid = td.getAttribute('data-bov-jump');
    if (oid && typeof activateTab === 'function') {
      activateTab('budget', { budgetOfficeView: { officeId: oid } });
    }
  }));
  tbody.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); editOffice(b.dataset.edit); }));
  tbody.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (confirm('Delete this org? Linked records will be unlinked.')) { DB.remove('offices', b.dataset.del); refreshAll(); }
  }));
  tbody.querySelectorAll('[data-prio-toggle]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleOfficePriority(b.dataset.prioToggle);
    refreshAll();
  }));
  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button, span.priority-toggle')) return;
      // Use existing dashboard card if present; otherwise build a synthetic one
      // so openDetailPanel's logic still works for hidden offices.
      var oid = tr.dataset.id;
      if (typeof openOfficeDetailPanel === 'function') {
        openOfficeDetailPanel(oid);
      } else if (typeof editOffice === 'function') {
        editOffice(oid);
      }
    });
  });
}
// Phase 3 Part B: priority is persisted in DB (offices.priority), not localStorage.
// officeIsPriority is a thin reader; toggleOfficePriority writes via DB.upsert.
function officeIsPriority(o) {
  return !!(o && o.priority);
}
function toggleOfficePriority(officeId) {
  const o = DB.get('offices', officeId);
  if (!o) return;
  const nextPriority = !o.priority;
  DB.upsert('offices', { id: o.id, priority: nextPriority });
  // Keep the dashboard DOM card class in sync so existing CSS continues to work.
  if (o.dashboardCardId) {
    const card = document.getElementById(o.dashboardCardId);
    if (card) card.classList.toggle('priority', nextPriority);
  }
  refreshDashboard();
  if (document.getElementById('tab-offices').classList.contains('active')) renderOffices();
  // Refresh Graph if it's showing
  if (typeof GRAPH !== 'undefined' && GRAPH.cy &&
      document.getElementById('tab-graph') &&
      document.getElementById('tab-graph').classList.contains('active')) {
    renderGraph();
  }
}

// ---------------------------------------------------------------
// Fragment B begins: computeOfficeCounts (originally a separate
// inline-script chunk between modal/office.js and contacts.js)
// ---------------------------------------------------------------

function computeOfficeCounts() {
  const result = {};
  DB.list('offices').forEach(o => result[o.id] = { contacts:0, solicitations:0, los:0, contracts:0 });
  DB.list('contacts').forEach(c => (c.officeIds||[]).forEach(o => { if (result[o]) result[o].contacts++; }));
  DB.list('solicitations').forEach(s => { if (result[s.officeId]) result[s.officeId].solicitations++; });
  DB.list('letters').forEach(l => { if (result[l.officeId]) result[l.officeId].los++; });
  DB.list('solicitations').forEach(s => { if (s.status === 'Won' && result[s.officeId]) result[s.officeId].contracts++; });
  return result;
}
document.getElementById('btnAddOffice').addEventListener('click', () => editOffice(null));
['officesSearch','officesServiceFilter','officesTierFilter','officesPriorityOnly','officesHasChpOnly','officesHasSolOnly','officesHasLosOnly'].forEach(id =>
  document.getElementById(id).addEventListener('input', renderOffices));
document.getElementById('officesPriorityOnly').addEventListener('change', renderOffices);
// utils.js (which exposes window.attachSorting). The v197.1
// DOMContentLoaded wrap is no longer needed here -- sibling modules
// (contacts.js / sols.js / lets.js) call attachSorting at top level
// directly. Replicate that pattern. The DOMContentLoaded wrap was
// actively broken inside a module: by the time offices.js evaluates,
// the DOMContentLoaded event may have already fired, leaving the
// callback unregistered.
attachSorting(document.getElementById('officesTable'), 'offices', renderOffices);

document.getElementById('btnExportOffices').addEventListener('click', () => {
  const headers = ['id','name','fullName','service','tier','dashboardCardId','tags','location','location_city','location_state','location_country','chamber','party','district','committees','notes'];
  const visible = currentTableRows('officesTable', DB.list('offices'));
  const rows = visible.map(o => Object.assign({}, o, {
    tags: (o.tags||[]).join('; '),
    committees: (o.committees||[]).join('; '),
  }));
  downloadFile('offices.csv', csvFormat(rows, headers));
});
document.getElementById('btnImportOffices').addEventListener('click', () => {
  importCsvInto('offices', row => ({
    id: row.id || '',
    name: row.name || row.Name || row['Unit Name'] || '',
    fullName: row.fullName || row['Full Name'] || '',
    service: row.service || row['Service/Department'] || row.Service || '',
    tier: row.tier || '',
    dashboardCardId: row.dashboardCardId || '',
    tags: arrField(row.tags || row.Tags || ''),
    location: row.location || row.Location || '',
    location_city:    row.location_city    || row['City']    || row.City    || '',
    location_state:   row.location_state   || row['State']   || row.State   || '',
    location_country: row.location_country || row['Country'] || row.Country || '',
    notes: row.notes || row.Notes || '',
    chamber:  row.chamber  || row.Chamber  || '',
    party:    row.party    || row.Party    || '',
    district: row.district || row.District || '',
    committees: arrField(row.committees || row.Committees || ''),
  }));
});

// =================================================================
// =================================================================
window.renderOffices = renderOffices;
window.officeIsPriority = officeIsPriority;
window.toggleOfficePriority = toggleOfficePriority;
window.officeDepartmentById = officeDepartmentById;
window.contactDepartment = contactDepartment;
window.solicitationDepartment = solicitationDepartment;
window.deptChip = deptChip;
window.computeOfficeCounts = computeOfficeCounts;
