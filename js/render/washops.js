// js/render/washops.js
//
// WASHOPS TAB (v58) -- congressional offices, requests, meeting log.
// Renders Hill cards + Hill directory table + Hill drawer + Engagement log
// (legacy washops table) + Requests table.
//
// Originally at file-scope of the inline monolith; lifted to ES module in
// scope; only the two functions consumed by external callers are
// re-exposed on window:
//
//   window.renderWos  -- tab-activation switch case (lines ~21933, ~29560)
//   window.editWo     -- Cytoscape graph click handler (line ~26875, behind
//                        a typeof === 'function' guard)
//
// All internal functions (renderHillCards, renderHillTable, openHillDrawer,
// renderWoTable, renderRequestTable, editRequest, isCongressOffice,
// partyBadgeKey, meetingsForOffice, requestsForOffice, contactsForOffice,
// lastMeetingDate, allCommittees, refillCommitteeSelect, escAttr, and the
// HILL_SORT/WOS_SORT/REQ_SORT state objects) stay module-scoped -- no
// external references in the monolith.
//
// Consumes from the still-inline monolith via window globals:
//   DB, escHtml, escAttr (shadowed locally), fmtMoney, openModal, closeModal,
//   field, fieldRow, makeMultiSelect, selectFromList, activateTab,
//   editOffice, editContact, hmEnsureDrawer, closeHmDrawer, officeName,
//   officeChips, officeIsPriority, refillOfficeSelect, refreshAll,
//   csvFormat, downloadFile, importCsvInto, arrField.

// ================================================================
// WASHOPS TAB (v58) -- congressional offices, requests, meeting log
// ================================================================

// Helpers --------------------------------------------------------
function isCongressOffice(o) { return o && o.service === 'Congress'; }

function partyBadgeKey(p) {
  if (p === 'Republican') return 'R';
  if (p === 'Democrat')   return 'D';
  if (p === 'Independent') return 'I';
  if (p === 'Mixed')      return 'M';
  return '';
}

function meetingsForOffice(officeId) {
  return DB.list('washops').filter(w => (w.officeIds || []).includes(officeId));
}
function requestsForOffice(officeId) {
  return (DB.list('requests') || []).filter(r => r.officeId === officeId);
}
function contactsForOffice(officeId) {
  return DB.list('contacts').filter(c => (c.officeIds || []).includes(officeId));
}
function lastMeetingDate(officeId) {
  let best = '';
  meetingsForOffice(officeId).forEach(w => { if (w.date && w.date > best) best = w.date; });
  return best;
}

function allCommittees() {
  const set = new Set();
  DB.list('offices').forEach(o => {
    if (!isCongressOffice(o)) return;
    (o.committees || []).forEach(c => { if (c) set.add(c); });
  });
  return Array.from(set).sort();
}

function refillCommitteeSelect(sel) {
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">All committees</option>' +
    allCommittees().map(c => '<option value="' + escAttr(c) + '">' + escHtml(c) + '</option>').join('');
  if (cur) sel.value = cur;
}

// Local attr-escape (module-scope escAttr is nested; we used hmEscAttr in
// heat-maps -- reuse that here for consistency).
function escAttr(s) { return escHtml(s); }

// =============== Hill cards =====================================
function renderHillCards() {
  const grid = document.getElementById('hillCardGrid');
  if (!grid) return;
  const q       = (document.getElementById('hillSearch')          || {}).value || '';
  const fParty  = (document.getElementById('hillPartyFilter')     || {}).value || '';
  const fCham   = (document.getElementById('hillChamberFilter')   || {}).value || '';
  const fComm   = (document.getElementById('hillCommitteeFilter') || {}).value || '';
  refillCommitteeSelect(document.getElementById('hillCommitteeFilter'));
  const ql = q.toLowerCase();

  const offices = DB.list('offices').filter(isCongressOffice);
  const filtered = offices.filter(o => {
    if (fParty && (o.party  || '') !== fParty) return false;
    if (fCham  && (o.chamber|| '') !== fCham)  return false;
    if (fComm && !((o.committees||[]).includes(fComm))) return false;
    if (ql) {
      const blob = [
        o.name, o.fullName, o.notes, o.location, o.district, o.party, o.chamber,
        (o.committees||[]).join(' ')
      ].join(' ').toLowerCase();
      // also match contacts at this office
      const conBlob = contactsForOffice(o.id)
        .map(c => [c.firstName, c.lastName, c.title, c.rank].join(' '))
        .join(' ').toLowerCase();
      if (!blob.includes(ql) && !conBlob.includes(ql)) return false;
    }
    return true;
  });

  const cnt = document.getElementById('hillCount');
  if (cnt) cnt.textContent = filtered.length + (filtered.length === 1 ? ' office' : ' offices');

  if (!filtered.length) {
    grid.innerHTML = '<div class="hill-card-empty">No congressional offices match. Adjust filters or add a Hill office (every org with service = "Congress" appears here).</div>';
    return;
  }

  // Sort: priority first, then by name.
  filtered.sort((a,b) => (officeIsPriority(b)?1:0) - (officeIsPriority(a)?1:0)
                      || (a.name||'').localeCompare(b.name||''));

  grid.innerHTML = filtered.map(o => {
    const cnts = {
      contacts: contactsForOffice(o.id).length,
      meetings: meetingsForOffice(o.id).length,
      requests: requestsForOffice(o.id).length,
    };
    const last = lastMeetingDate(o.id);
    const pri  = officeIsPriority(o);
    const partyKey = partyBadgeKey(o.party || '');
    const badges = [];
    if (partyKey)  badges.push('<span class="hill-badge hill-badge--' + partyKey + '">' + escHtml(o.party) + '</span>');
    if (o.chamber) badges.push('<span class="hill-badge hill-badge--chamber">' + escHtml(o.chamber) + '</span>');
    if (o.district) badges.push('<span class="hill-badge hill-badge--district">' + escHtml(o.district) + '</span>');
    const committeesHtml = (o.committees || []).slice(0, 8)
      .map(c => '<span class="hill-chip">' + escHtml(c) + '</span>').join('');
    return '<div class="hill-card' + (pri?' priority':'') + '" data-office-id="' + escAttr(o.id) + '">'
      + '<div class="hill-card-head">'
      +   '<div>'
      +     '<div class="hill-card-name">' + (pri?'<span style="color:var(--priority);margin-right:4px;">&#9733;</span>':'') + escHtml(o.name || o.id) + '</div>'
      +     (o.fullName ? '<div class="hill-card-fullname">' + escHtml(o.fullName) + '</div>' : '')
      +   '</div>'
      +   (badges.length ? '<div class="hill-card-badges">' + badges.join('') + '</div>' : '')
      + '</div>'
      + (committeesHtml ? '<div class="hill-card-committees">' + committeesHtml + '</div>' : '')
      + '<div class="hill-card-counts">'
      +   '<div class="hill-count-cell"><span class="n">' + cnts.contacts + '</span><span class="l">CONTACTS</span></div>'
      +   '<div class="hill-count-cell"><span class="n">' + cnts.meetings + '</span><span class="l">MEETINGS</span></div>'
      +   '<div class="hill-count-cell"><span class="n">' + cnts.requests + '</span><span class="l">REQUESTS</span></div>'
      +   '<div class="hill-count-cell"><span class="last-eng">' + (last || '&mdash;') + '</span><span class="l">LAST ENG</span></div>'
      + '</div>'
      + '</div>';
  }).join('');

  // Wire card clicks -> drawer.
  grid.querySelectorAll('.hill-card').forEach(el => {
    el.addEventListener('click', () => openHillDrawer(el.dataset.officeId));
  });
}

// =============== Hill table ====================================
function renderHillTable() {
  const tbody = document.querySelector('#hillTable tbody');
  if (!tbody) return;
  const q       = (document.getElementById('hillSearch')          || {}).value || '';
  const fParty  = (document.getElementById('hillPartyFilter')     || {}).value || '';
  const fCham   = (document.getElementById('hillChamberFilter')   || {}).value || '';
  const fComm   = (document.getElementById('hillCommitteeFilter') || {}).value || '';
  const ql = q.toLowerCase();

  const offices = DB.list('offices').filter(isCongressOffice);
  let rows = offices.filter(o => {
    if (fParty && (o.party  || '') !== fParty) return false;
    if (fCham  && (o.chamber|| '') !== fCham)  return false;
    if (fComm && !((o.committees||[]).includes(fComm))) return false;
    if (ql) {
      const blob = [
        o.name, o.fullName, o.notes, o.location, o.district, o.party, o.chamber,
        (o.committees||[]).join(' ')
      ].join(' ').toLowerCase();
      if (!blob.includes(ql)) return false;
    }
    return true;
  });

  // Decorate with derived counts so attachSorting can sort by them.
  rows = rows.map(o => Object.assign({}, o, {
    _contacts: contactsForOffice(o.id).length,
    _meetings: meetingsForOffice(o.id).length,
    _requests: requestsForOffice(o.id).length,
    _lastEng:  lastMeetingDate(o.id),
  }));

  applySorting(rows, 'hill', {
    name:     r => (r.name||'').toLowerCase(),
    party:    r => (r.party||'').toLowerCase(),
    chamber:  r => (r.chamber||'').toLowerCase(),
    district: r => (r.district||'').toLowerCase(),
    contacts: r => r._contacts,
    meetings: r => r._meetings,
    requests: r => r._requests,
    lastEng:  r => r._lastEng || '',
  });

  tbody.innerHTML = rows.map(o => {
    const partyKey = partyBadgeKey(o.party||'');
    return '<tr data-id="' + escAttr(o.id) + '">'
      + '<td><strong>' + escHtml(o.name) + '</strong>' + (o.fullName ? ' &middot; <span style="color:var(--text-dim);">' + escHtml(o.fullName) + '</span>' : '') + '</td>'
      + '<td>' + (partyKey ? '<span class="hill-badge hill-badge--' + partyKey + '">' + escHtml(o.party) + '</span>' : '<span style="color:var(--text-dim);">&mdash;</span>') + '</td>'
      + '<td>' + escHtml(o.chamber||'') + '</td>'
      + '<td>' + escHtml(o.district||'') + '</td>'
      + '<td>' + (o.committees||[]).map(c => '<span class="hill-chip">' + escHtml(c) + '</span>').join(' ') + '</td>'
      + '<td>' + o._contacts + '</td>'
      + '<td>' + o._meetings + '</td>'
      + '<td>' + o._requests + '</td>'
      + '<td>' + (o._lastEng || '<span style="color:var(--text-dim);">&mdash;</span>') + '</td>'
      + '</tr>';
  }).join('');

  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', () => openHillDrawer(tr.dataset.id));
    tr.style.cursor = 'pointer';
  });
}

// Lightweight sort plumbing used by the Hill table (keeps tab-local state).
const HILL_SORT = { col: 'name', dir: 1 };
function applySorting(rows, key, accessors) {
  const acc = accessors[HILL_SORT.col] || accessors[Object.keys(accessors)[0]];
  rows.sort((a,b) => {
    const av = acc(a), bv = acc(b);
    if (typeof av === 'number' && typeof bv === 'number') return HILL_SORT.dir * (av - bv);
    return HILL_SORT.dir * String(av).localeCompare(String(bv));
  });
}
(function wireHillSorting() {
  // Defer until DOM ready.
  document.addEventListener('DOMContentLoaded', () => {
    const tbl = document.getElementById('hillTable');
    if (!tbl) return;
    tbl.querySelectorAll('th[data-sort]').forEach(th => {
      th.style.cursor = 'pointer';
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (HILL_SORT.col === col) HILL_SORT.dir = -HILL_SORT.dir;
        else { HILL_SORT.col = col; HILL_SORT.dir = 1; }
        renderHillTable();
      });
    });
  });
})();

// =============== Hill drawer ===================================
function openHillDrawer(officeId) {
  const o = DB.get('offices', officeId);
  if (!o) return;
  hmEnsureDrawer();
  const partyKey = partyBadgeKey(o.party||'');
  const subtitleBits = [];
  if (o.chamber)  subtitleBits.push('<span class="hill-badge hill-badge--chamber">' + escHtml(o.chamber) + '</span>');
  if (partyKey)   subtitleBits.push('<span class="hill-badge hill-badge--' + partyKey + '">' + escHtml(o.party) + '</span>');
  if (o.district) subtitleBits.push('<span class="hill-badge hill-badge--district">' + escHtml(o.district) + '</span>');
  document.getElementById('hmDrawerTitle').textContent = o.name || o.id;
  document.getElementById('hmDrawerSub').innerHTML =
    (o.fullName ? '<div style="margin-bottom:4px;">' + escHtml(o.fullName) + '</div>' : '')
    + (subtitleBits.length ? '<div style="display:flex;gap:4px;flex-wrap:wrap;">' + subtitleBits.join('') + '</div>' : '');

  const meetings = meetingsForOffice(o.id).slice().sort((a,b) => (b.date||'').localeCompare(a.date||''));
  const requests = requestsForOffice(o.id).slice().sort((a,b) => (b.submitDate||'').localeCompare(a.submitDate||''));
  const contacts = contactsForOffice(o.id).slice().sort((a,b) => ((a.lastName||'') + (a.firstName||'')).localeCompare((b.lastName||'') + (b.firstName||'')));

  const committeesHtml = (o.committees || []).map(c => '<span class="hill-chip">' + escHtml(c) + '</span>').join(' ');
  const detailHeader = '<div style="padding:10px 14px;border-bottom:1px solid var(--border);">'
      + (committeesHtml ? '<div style="margin-bottom:6px;">' + committeesHtml + '</div>' : '')
      + (o.notes ? '<div style="font-size:11.5px;color:var(--text-dim);">' + escHtml(o.notes) + '</div>' : '')
      + '<div style="margin-top:8px;display:flex;gap:6px;">'
      +   '<button class="hm-drawer-open" data-edit-office="' + escAttr(o.id) + '">Edit office</button>'
      +   '<button class="hm-drawer-open" data-jump-contacts="' + escAttr(o.id) + '">View all contacts &rsaquo;</button>'
      + '</div>'
    + '</div>';

  const contactsList = '<ul class="hill-drawer-list">'
    + (contacts.length ? contacts.slice(0,12).map(c => '<li class="hill-drawer-item" data-edit-contact="' + escAttr(c.id) + '">'
        + '<div><div>' + escHtml(((c.firstName||'') + ' ' + (c.lastName||'')).trim() || '(unnamed)') + (c.champion?' <span style="color:var(--priority);">&#9733;</span>':'') + '</div>'
        + '<div class="meta">' + escHtml([c.rank, c.title].filter(Boolean).join(' &middot; ')) + '</div></div>'
        + '<div class="right">' + escHtml(c.email||'') + '</div>'
        + '</li>').join('') + (contacts.length > 12 ? '<li style="color:var(--text-dim);font-size:11px;text-align:center;">&hellip; +' + (contacts.length-12) + ' more (View all contacts)</li>' : '')
        : '<li style="color:var(--text-dim);font-size:11.5px;">No contacts at this office yet.</li>')
    + '</ul>';

  const meetingsList = '<ul class="hill-drawer-list">'
    + (meetings.length ? meetings.slice(0,15).map(w => '<li class="hill-drawer-item" data-edit-wo="' + escAttr(w.id) + '">'
        + '<div><div>' + escHtml(w.summary || '(no summary)') + '</div>'
        + '<div class="meta">' + escHtml([w.type, (w.contactIds||[]).length + ' attendee' + ((w.contactIds||[]).length===1?'':'s')].filter(Boolean).join(' &middot; ')) + '</div></div>'
        + '<div class="right">' + escHtml(w.date||'') + '</div>'
        + '</li>').join('') + (meetings.length > 15 ? '<li style="color:var(--text-dim);font-size:11px;text-align:center;">&hellip; +' + (meetings.length-15) + ' more</li>' : '')
        : '<li style="color:var(--text-dim);font-size:11.5px;">No meetings logged yet.</li>')
    + '</ul>';

  const requestsList = '<ul class="hill-drawer-list">'
    + (requests.length ? requests.slice(0,15).map(r => '<li class="hill-drawer-item" data-edit-req="' + escAttr(r.id) + '">'
        + '<div><div>' + escHtml(r.title || '(untitled request)') + '</div>'
        + '<div class="meta">' + escHtml([r.type, (r.fiscalYear ? 'FY' + r.fiscalYear : ''), (r.askAmount ? fmtMoney(r.askAmount) : '')].filter(Boolean).join(' &middot; ')) + '</div></div>'
        + '<div class="right">' + (r.status ? '<span class="req-pill" data-status="' + escAttr(r.status) + '">' + escHtml(r.status) + '</span>' : '') + ' ' + escHtml(r.submitDate||'') + '</div>'
        + '</li>').join('') + (requests.length > 15 ? '<li style="color:var(--text-dim);font-size:11px;text-align:center;">&hellip; +' + (requests.length-15) + ' more</li>' : '')
        : '<li style="color:var(--text-dim);font-size:11.5px;">No requests filed yet.</li>')
    + '</ul>';

  const body = document.getElementById('hmDrawerBody');
  body.innerHTML = detailHeader
    + '<div class="hill-drawer-section"><h4>Contacts (' + contacts.length + ')<button data-jump-contacts-all="' + escAttr(o.id) + '">View all &rsaquo;</button></h4>' + contactsList + '</div>'
    + '<div class="hill-drawer-section"><h4>Meetings (' + meetings.length + ')<button data-add-wo="' + escAttr(o.id) + '">+ Log engagement</button></h4>' + meetingsList + '</div>'
    + '<div class="hill-drawer-section"><h4>Requests (' + requests.length + ')<button data-add-req="' + escAttr(o.id) + '">+ Add request</button></h4>' + requestsList + '</div>';

  // Wire drawer actions.
  body.querySelectorAll('[data-edit-office]').forEach(b => b.addEventListener('click', () => { closeHmDrawer(); editOffice(b.dataset.editOffice); }));
  body.querySelectorAll('[data-jump-contacts]').forEach(b => b.addEventListener('click', () => { closeHmDrawer(); activateTab('contacts', { officeId: b.dataset.jumpContacts }); }));
  body.querySelectorAll('[data-jump-contacts-all]').forEach(b => b.addEventListener('click', () => { closeHmDrawer(); activateTab('contacts', { officeId: b.dataset.jumpContactsAll }); }));
  body.querySelectorAll('[data-edit-contact]').forEach(b => b.addEventListener('click', () => { closeHmDrawer(); if (typeof editContact === 'function') editContact(b.dataset.editContact); }));
  body.querySelectorAll('[data-edit-wo]').forEach(b => b.addEventListener('click', () => { closeHmDrawer(); editWo(b.dataset.editWo); }));
  body.querySelectorAll('[data-edit-req]').forEach(b => b.addEventListener('click', () => { closeHmDrawer(); editRequest(b.dataset.editReq); }));
  body.querySelectorAll('[data-add-wo]').forEach(b => b.addEventListener('click', () => { closeHmDrawer(); editWo(null, { officeId: b.dataset.addWo }); }));
  body.querySelectorAll('[data-add-req]').forEach(b => b.addEventListener('click', () => { closeHmDrawer(); editRequest(null, { officeId: b.dataset.addReq }); }));

  document.getElementById('hmDrawerBackdrop').classList.add('open');
  document.getElementById('hmDrawer').classList.add('open');
}

// =============== Engagement log (legacy washops table) =========
function renderWos() {
  // Two parts: top section (cards + Hill directory table), legacy log.
  renderHillCards();
  renderHillTable();
  renderWoTable();
  renderRequestTable();
}

function renderWoTable() {
  const tbody = document.querySelector('#woTable tbody');
  if (!tbody) return;
  const q = (document.getElementById('woSearch')||{}).value || '';
  const tf = (document.getElementById('woTypeFilter')||{}).value || '';
  const of = (document.getElementById('woOfficeFilter')||{}).value || '';
  const dfRaw = (document.getElementById('woDateFilter')||{}).value || '';
  const df = dfRaw.trim();
  refillOfficeSelect(document.getElementById('woOfficeFilter'), 'All orgs');
  const ql = q.toLowerCase();
  const rows = DB.list('washops').filter(w => {
    if (tf && w.type !== tf) return false;
    if (of && !(w.officeIds||[]).includes(of)) return false;
    if (df && !(w.date||'').startsWith(df)) return false;
    if (ql) {
      const blob = [w.summary, w.notes, (w.officeIds||[]).map(officeName).join(' ')].join(' ').toLowerCase();
      if (!blob.includes(ql)) return false;
    }
    return true;
  });
  applySortingGeneric(rows, 'wos', {
    date: r => r.date || '', type: r => r.type || '', summary: r => r.summary || ''
  });
  document.getElementById('woCount').textContent = rows.length + ' entries';
  tbody.innerHTML = rows.map(w =>
    '<tr data-id="' + escAttr(w.id) + '">'
    + '<td>' + escHtml(w.date||'') + '</td>'
    + '<td>' + escHtml(w.type||'') + '</td>'
    + '<td>' + officeChips(w.officeIds) + '</td>'
    + '<td>' + (w.contactIds||[]).map(id => { const c=DB.get('contacts',id); return c?escHtml((c.firstName||'')+' '+(c.lastName||'')):''; }).filter(Boolean).join(', ') + '</td>'
    + '<td>' + escHtml(w.summary||'') + '</td>'
    + '<td>' + escHtml((w.notes||'').slice(0,140)) + (w.notes && w.notes.length>140?'&hellip;':'') + '</td>'
    + '<td><button class="btn small" data-edit="' + escAttr(w.id) + '">Edit</button></td>'
    + '</tr>'
  ).join('');
  tbody.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); editWo(b.dataset.edit); }));
  tbody.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', (e) => { if (e.target.closest('button, .chip')) return; editWo(tr.dataset.id); }));
}

const WOS_SORT = { col: 'date', dir: -1 };
const REQ_SORT = { col: 'submitDate', dir: -1 };
function applySortingGeneric(rows, key, accessors) {
  const sortMap = key === 'wos' ? WOS_SORT : REQ_SORT;
  const acc = accessors[sortMap.col] || accessors[Object.keys(accessors)[0]];
  rows.sort((a,b) => {
    const av = acc(a), bv = acc(b);
    if (typeof av === 'number' && typeof bv === 'number') return sortMap.dir * (av - bv);
    return sortMap.dir * String(av).localeCompare(String(bv));
  });
}

function editWo(id, presets) {
  const w = id ? Object.assign({}, DB.get('washops', id))
              : { id:'', date: new Date().toISOString().slice(0,10), type:'Meeting', officeIds: (presets && presets.officeId ? [presets.officeId] : []), contactIds:[], summary:'', notes:'' };
  const body = document.createElement('div');
  body.appendChild(fieldRow(
    field('Date', '<input id="f-date" type="date" value="' + escHtml(w.date||'') + '">'),
    field('Type', selectFromList('f-type', ['Meeting','Call','Briefing','CapHill Visit','Trip Report','Conference','Email Thread','Other'], w.type))
  ));
  body.appendChild(field('Summary', '<input id="f-summary" value="' + escHtml(w.summary||'') + '" placeholder="Brief one-liner">'));
  const oBox = document.createElement('div'); oBox.className = 'multi-select-box';
  body.appendChild(field('Offices', '')); body.lastChild.appendChild(oBox);
  const oMs = makeMultiSelect(oBox, DB.list('offices').map(o => ({id:o.id,label:o.name})), w.officeIds||[]);
  const cBox = document.createElement('div'); cBox.className = 'multi-select-box';
  body.appendChild(field('Attendees', '')); body.lastChild.appendChild(cBox);
  const cMs = makeMultiSelect(cBox, DB.list('contacts').map(c => ({id:c.id,label:(c.firstName||'')+' '+(c.lastName||'')})), w.contactIds||[]);
  body.appendChild(field('Notes / detailed write-up', '<textarea id="f-notes" style="min-height:140px;">' + escHtml(w.notes||'') + '</textarea>'));
  openModal({
    title: id ? 'Edit Engagement' : 'Log DC Engagement',
    body, table:'washops', id: w.id || '',
    onSave: () => {
      const rec = {
        id: w.id || '',
        date:    document.getElementById('f-date').value,
        type:    document.getElementById('f-type').value,
        summary: document.getElementById('f-summary').value.trim(),
        officeIds: oMs.get(),
        contactIds: cMs.get(),
        notes:   document.getElementById('f-notes').value.trim(),
      };
      DB.upsert('washops', rec); closeModal(); refreshAll();
    }
  });
}

// Wire engagement-log toolbar.
document.getElementById('btnAddWo').addEventListener('click', () => editWo(null));
['woSearch','woTypeFilter','woOfficeFilter','woDateFilter'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', renderWoTable);
});
(function wireWoSorting() {
  const tbl = document.getElementById('woTable');
  if (!tbl) return;
  tbl.querySelectorAll('th[data-sort]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (WOS_SORT.col === col) WOS_SORT.dir = -WOS_SORT.dir;
      else { WOS_SORT.col = col; WOS_SORT.dir = (col === 'date' ? -1 : 1); }
      renderWoTable();
    });
  });
})();

document.getElementById('btnExportWo').addEventListener('click', () => {
  const headers = ['id','date','type','officeIds','officeNames','contactIds','summary','notes'];
  const rows = DB.list('washops').map(w => Object.assign({}, w, {
    officeIds: (w.officeIds||[]).join('; '),
    officeNames: (w.officeIds||[]).map(officeName).join('; '),
    contactIds: (w.contactIds||[]).join('; '),
  }));
  downloadFile('washops.csv', csvFormat(rows, headers));
});
document.getElementById('btnImportWo').addEventListener('click', () => {
  importCsvInto('washops', row => ({
    id: row.id || '',
    date: row.date || row.Date || '',
    type: row.type || row.Type || 'Meeting',
    officeIds: arrField(row.officeIds || row.Offices || ''),
    contactIds: arrField(row.contactIds || row.Attendees || ''),
    summary: row.summary || row.Summary || '',
    notes: row.notes || row.Notes || '',
  }));
});

// =============== Requests table ================================
function renderRequestTable() {
  const tbody = document.querySelector('#reqTable tbody');
  if (!tbody) return;
  const q  = (document.getElementById('reqSearch')||{}).value || '';
  const tf = (document.getElementById('reqTypeFilter')||{}).value || '';
  const sf = (document.getElementById('reqStatusFilter')||{}).value || '';
  const of = (document.getElementById('reqOfficeFilter')||{}).value || '';
  refillOfficeSelect(document.getElementById('reqOfficeFilter'), 'All offices', isCongressOffice);
  const ql = q.toLowerCase();
  const rows = (DB.list('requests')||[]).filter(r => {
    if (tf && r.type !== tf) return false;
    if (sf && r.status !== sf) return false;
    if (of && r.officeId !== of) return false;
    if (ql) {
      const blob = [r.title, r.type, r.status, r.notes, officeName(r.officeId)].join(' ').toLowerCase();
      if (!blob.includes(ql)) return false;
    }
    return true;
  });
  applySortingGeneric(rows, 'requests', {
    submitDate: r => r.submitDate || '',
    type: r => r.type || '',
    title: r => (r.title||'').toLowerCase(),
    officeId: r => officeName(r.officeId).toLowerCase(),
    askAmount: r => Number(r.askAmount||0),
    fiscalYear: r => r.fiscalYear || '',
    status: r => r.status || '',
  });
  document.getElementById('reqCount').textContent = rows.length + (rows.length===1 ? ' request' : ' requests');
  tbody.innerHTML = rows.map(r =>
    '<tr data-id="' + escAttr(r.id) + '">'
    + '<td>' + escHtml(r.submitDate||'') + '</td>'
    + '<td>' + escHtml(r.type||'') + '</td>'
    + '<td>' + escHtml(r.title||'') + '</td>'
    + '<td>' + escHtml(officeName(r.officeId)) + '</td>'
    + '<td>' + (r.askAmount ? fmtMoney(r.askAmount) : '') + '</td>'
    + '<td>' + escHtml(r.fiscalYear||'') + '</td>'
    + '<td>' + (r.status ? '<span class="req-pill" data-status="' + escAttr(r.status) + '">' + escHtml(r.status) + '</span>' : '') + '</td>'
    + '<td>' + (r.contactIds||[]).map(id => { const c=DB.get('contacts',id); return c?escHtml((c.firstName||'')+' '+(c.lastName||'')):''; }).filter(Boolean).join(', ') + '</td>'
    + '<td><button class="btn small" data-edit-req="' + escAttr(r.id) + '">Edit</button></td>'
    + '</tr>'
  ).join('');
  tbody.querySelectorAll('[data-edit-req]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); editRequest(b.dataset.editReq); }));
  tbody.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', (e) => { if (e.target.closest('button')) return; editRequest(tr.dataset.id); }));
}

function editRequest(id, presets) {
  const r = id ? Object.assign({}, DB.get('requests', id))
               : { id:'', submitDate: new Date().toISOString().slice(0,10), type:'NDAA mark', title:'', officeId: (presets && presets.officeId) || '', askAmount: 0, fiscalYear:'', status:'Drafted', contactIds:[], notes:'' };
  const body = document.createElement('div');
  body.appendChild(fieldRow(
    field('Submit date', '<input id="f-submitDate" type="date" value="' + escHtml(r.submitDate||'') + '">'),
    field('Type', selectFromList('f-type', ['NDAA mark','Plus-up','RFI','Approps request','Authorization language','Other'], r.type))
  ));
  body.appendChild(field('Title', '<input id="f-title" value="' + escHtml(r.title||'') + '" placeholder="e.g. RAS UAS plus-up FY27">'));
  // Office picker (Congress only) -- single select.
  const congressList = DB.list('offices').filter(isCongressOffice).slice()
    .sort((a,b) => (a.name||'').localeCompare(b.name||''));
  body.appendChild(field('Office (Hill)',
    '<select id="f-officeId">'
    + '<option value=""' + (!r.officeId ? ' selected' : '') + '>(none)</option>'
    + congressList.map(o => '<option value="' + escAttr(o.id) + '"' + (o.id===r.officeId?' selected':'') + '>' + escHtml(o.name) + '</option>').join('')
    + '</select>'
  ));
  body.appendChild(fieldRow(
    field('Ask amount ($)', '<input id="f-askAmount" type="number" min="0" step="1000" value="' + escHtml(String(r.askAmount||0)) + '">'),
    field('Fiscal year', '<input id="f-fy" value="' + escHtml(r.fiscalYear||'') + '" placeholder="e.g. 2027">')
  ));
  body.appendChild(field('Status', selectFromList('f-status', ['Drafted','Submitted','Accepted','Included','Rejected'], r.status||'Drafted')));
  const cBox = document.createElement('div'); cBox.className = 'multi-select-box';
  body.appendChild(field('Contacts', '')); body.lastChild.appendChild(cBox);
  const cMs = makeMultiSelect(cBox, DB.list('contacts').map(c => ({id:c.id,label:(c.firstName||'')+' '+(c.lastName||'')})), r.contactIds||[]);
  body.appendChild(field('Notes', '<textarea id="f-notes" style="min-height:120px;">' + escHtml(r.notes||'') + '</textarea>'));
  openModal({
    title: id ? 'Edit Request' : 'Log Hill Request',
    body, table:'requests', id: r.id || '',
    onSave: () => {
      const rec = {
        id: r.id || '',
        submitDate: document.getElementById('f-submitDate').value,
        type:       document.getElementById('f-type').value,
        title:      document.getElementById('f-title').value.trim(),
        officeId:   document.getElementById('f-officeId').value,
        askAmount:  Number(document.getElementById('f-askAmount').value) || 0,
        fiscalYear: document.getElementById('f-fy').value.trim(),
        status:     document.getElementById('f-status').value,
        contactIds: cMs.get(),
        notes:      document.getElementById('f-notes').value.trim(),
      };
      DB.upsert('requests', rec); closeModal(); refreshAll();
    }
  });
}

// Wire requests toolbar.
(function wireRequests() {
  const addBtn = document.getElementById('btnAddRequest');
  if (addBtn) addBtn.addEventListener('click', () => editRequest(null));
  ['reqSearch','reqTypeFilter','reqStatusFilter','reqOfficeFilter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', renderRequestTable);
  });
  const tbl = document.getElementById('reqTable');
  if (tbl) tbl.querySelectorAll('th[data-sort]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (REQ_SORT.col === col) REQ_SORT.dir = -REQ_SORT.dir;
      else { REQ_SORT.col = col; REQ_SORT.dir = (col === 'submitDate' ? -1 : 1); }
      renderRequestTable();
    });
  });
  const exp = document.getElementById('btnExportReq');
  if (exp) exp.addEventListener('click', () => {
    const headers = ['id','submitDate','type','title','officeId','officeName','askAmount','fiscalYear','status','contactIds','notes'];
    const rows = (DB.list('requests')||[]).map(r => Object.assign({}, r, {
      officeName: officeName(r.officeId),
      contactIds: (r.contactIds||[]).join('; '),
    }));
    downloadFile('requests.csv', csvFormat(rows, headers));
  });
  const imp = document.getElementById('btnImportReq');
  if (imp) imp.addEventListener('click', () => {
    importCsvInto('requests', row => ({
      id: row.id || '',
      submitDate: row.submitDate || row['Submit Date'] || '',
      type: row.type || row.Type || 'Other',
      title: row.title || row.Title || '',
      officeId: row.officeId || row.Office || '',
      askAmount: Number(row.askAmount || row['Ask Amount'] || 0) || 0,
      fiscalYear: row.fiscalYear || row['Fiscal Year'] || row.FY || '',
      status: row.status || row.Status || 'Drafted',
      contactIds: arrField(row.contactIds || row.Contacts || ''),
      notes: row.notes || row.Notes || '',
    }));
  });
})();

// Top-toolbar buttons (mirror the legacy log buttons).
(function wireTopButtons() {
  const bAddOff = document.getElementById('btnAddCongressOffice');
  if (bAddOff) bAddOff.addEventListener('click', () => {
    // Pre-stage a Congress org for the editOffice modal.
    const stub = { id:'', name:'', fullName:'', service:'Congress', tier:'5',
      dashboardCardId:'', location:'', notes:'', tags:[], parent_id:'', department:'',
      roles:[], echelon:'', show_on_dashboard:false, priority:false, short_description:'',
      leadership:[], chamber:'', party:'', district:'', committees:[] };
    // Stash on DB momentarily so editOffice picks it up via DB.get -- simplest:
    // call editOffice(null) which builds defaults, then user sets service=Congress
    // implicitly via the always-visible Hill block. (We can't easily push the
    // service value into the modal; document this in the placeholder.)
    editOffice(null);
    setTimeout(() => {
      // Visibly tell the user to keep service = Congress (no UI control to set it
      // post-v47, so an Add Hill Office should mark service automatically).
      const block = document.querySelector('[data-hill-block="1"]');
      if (block) {
        block.style.display = '';
        const heading = block.querySelector('div');
        if (heading) heading.title = 'New Hill office: service will be set to "Congress" on save.';
      }
      // Override service inside the form by stamping a hidden input...
      const form = document.getElementById('modalBody');
      if (form && !form.querySelector('input[data-force-service]')) {
        const hid = document.createElement('input');
        hid.type='hidden'; hid.dataset.forceService='Congress'; hid.value='Congress';
        form.appendChild(hid);
      }
    }, 0);
  });
  const bAddReq = document.getElementById('btnAddRequestTop');
  if (bAddReq) bAddReq.addEventListener('click', () => editRequest(null));
  const bAddWo  = document.getElementById('btnAddWoTop');
  if (bAddWo)  bAddWo.addEventListener('click',  () => editWo(null));
  ['hillSearch','hillPartyFilter','hillChamberFilter','hillCommitteeFilter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => { renderHillCards(); renderHillTable(); });
  });
})();

// =================================================================
// =================================================================
window.renderWos = renderWos;
window.editWo = editWo;

// monolith (hoisted to window). v181 lifted it into this module along
// with the WASHOPS section, making it module-scoped and breaking the
// 106 monolith callers (renderOffices, renderContacts, renderSols,
// renderLets, and every other render path that escapes attribute
// values). Re-expose to preserve the original contract.
window.escAttr = escAttr;
