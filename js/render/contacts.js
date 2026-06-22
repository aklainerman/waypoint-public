// js/render/contacts.js
//
// Contacts feature: table renderer, contact editor modal, legislator
// (v167 hill-member <-> contact) linkage helpers, and CSV import/export.
//
// Originally at file-scope of the inline monolith; lifted to ES module
// in v191. Same classic-script-split pattern as v181-v190.
//
// Pre-extraction audit (v185 pattern). ALL six top-level declarations
// have external callers and require window exposure:
//
//   renderContacts:        9 ext refs (7 monolith + 2 scout-client.js)
//   editContact:          11 ext refs (2 monolith + 3 graph.js +
//                                       2 hill-members.js + 4 washops.js)
//   _legPartyKey:          1 ext ref  (monolith)
//   legislatorById:        3 ext refs (monolith)
//   legislatorLabel:       4 ext refs (monolith)
//   legislatorSearchHay:   1 ext ref  (monolith)
//
// All cross-module references (graph.js, hill-members.js, washops.js,
// scout-client.js) were previously reaching these functions via the
// monolith's classic-script global hoisting. The window exposures at
// the bottom of this file preserve that contract.
//
// Consumes from window (monolith + earlier modules):
//   DB, escHtml, escAttr, openModal, closeModal, field, fieldRow,
//   makeMultiSelect, refreshAll, refillOfficeSelect, contactDepartment,
//   officeName, deptBadge, attachSorting, applySort, currentTableRows,
//   csvFormat, downloadFile, importCsvInto, arrField, activateTab,
//   and other monolith file-scope helpers.

// ---------------------------------------------------------------
//  CONTACTS tab
// ---------------------------------------------------------------
function renderContacts() {
  const tbody = document.querySelector('#contactsTable tbody');
  const q = (document.getElementById('contactsSearch').value || '').toLowerCase();
  const officeFilter = document.getElementById('contactsOfficeFilter').value;
  const deptFilter = (document.getElementById('contactsDeptFilter')||{}).value || '';
  const champOnly = (document.getElementById('contactsChampionOnly')||{}).checked || false;
  const prioOrgOnly = (document.getElementById('contactsPriorityOrgOnly')||{}).checked || false;
  const hasSolOnly  = (document.getElementById('contactsHasSolOnly')||{}).checked || false;
  const hasLosOnly  = (document.getElementById('contactsHasLosOnly')||{}).checked || false;
  refillOfficeSelect(document.getElementById('contactsOfficeFilter'), 'All orgs');
  let rows = DB.list('contacts').filter(c => {
    if (officeFilter && !(c.officeIds||[]).includes(officeFilter)) return false;
    if (deptFilter && contactDepartment(c) !== deptFilter) return false;
    if (champOnly && !c.champion) return false;
    if (prioOrgOnly) {
      const prio = (c.officeIds||[]).some(oid => { const o = DB.get('offices', oid); return o && officeIsPriority(o); });
      if (!prio) return false;
    }
    if (hasSolOnly) {
      const sols = DB.list('solicitations');
      const hasSol = (c.officeIds||[]).some(oid => sols.some(s => s.officeId === oid));
      if (!hasSol) return false;
    }
    if (hasLosOnly) {
      const lets = DB.list('letters');
      const hasLos = (c.officeIds||[]).some(oid => lets.some(l => l.officeId === oid));
      if (!hasLos) return false;
    }
    if (q) {
      const blob = [c.firstName, c.lastName, c.callsign, c.rank, c.title, c.email, c.phone,
        c.unit, c.branch, c.source, c.lead, c.notes,
        (c.officeIds||[]).map(officeName).join(' '),
        legislatorSearchHay(c)].join(' ').toLowerCase();   // v167
      if (!blob.includes(q)) return false;
    }
    return true;
  });
  rows = applySort(rows, 'contacts', {
    champion:  r => r.champion ? 0 : 1,
    firstName: r => (r.firstName||'') + ' ' + (r.lastName||''),
    lastName:  r => (r.lastName||'')  + ' ' + (r.firstName||''),
    callsign:  r => r.callsign || '',
    rank: r => r.rank || '',
    title: r => r.title, email: r => r.email, phone: r => r.phone,
    department: r => contactDepartment(r),
    officeId:   r => (r.officeIds||[]).map(officeName).join(', ') + ' ' + legislatorSearchHay(r),  // v167
  });
  document.getElementById('contactsCount').textContent = rows.length + ' contacts';
  tbody.innerHTML = rows.map(c => '<tr data-id="' + c.id + '">'
    + '<td><span class="champ-toggle ' + (c.champion?'on':'') + '" data-champ-toggle="' + c.id + '" title="Toggle champion">★</span></td>'
    + '<td>' + escHtml(c.firstName||'') + '</td>'
    + '<td><strong>' + escHtml(c.lastName||'') + '</strong></td>'
    + '<td>' + escHtml(c.callsign||'') + '</td>'
    + '<td>' + escHtml(c.rank||'') + '</td>'
    + '<td>' + escHtml(c.title||'') + '</td>'
    + '<td>' + orgCells(c.officeIds, c.legislator_bioguide_id, c.org) + '</td>'
    + '<td>' + deptBadge(contactDepartment(c)) + '</td>'
    + '<td>' + (c.email ? '<a href="mailto:' + escHtml(c.email) + '">' + escHtml(c.email) + '</a>' : '—') + '</td>'
    + '<td>' + escHtml(c.phone||'—') + '</td>'
    + '<td class="td-actions">'
      + '<button class="btn-icon" data-edit="' + c.id + '">Edit</button>'
      + '<button class="btn-icon danger" data-del="' + c.id + '">Del</button>'
    + '</td></tr>'
  ).join('') || '<tr><td colspan="11" style="text-align:center;color:var(--text-dim);padding:1.5rem;">No contacts.</td></tr>';
  tbody.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); editContact(b.dataset.edit); }));
  tbody.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); if (confirm('Delete contact?')) { DB.remove('contacts', b.dataset.del); refreshAll(); }}));
  tbody.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', (e) => {
    if (e.target.closest('button, .chip, a')) return; openContactDetailPanel(tr.dataset.id);
  }));
  wireChipJumps(tbody);
}
function _legPartyKey(p) {
  p = String(p || '').toLowerCase();
  if (p.indexOf('republic') === 0) return 'R';
  if (p.indexOf('democrat') === 0) return 'D';
  if (p.indexOf('indep')    === 0) return 'I';
  return 'M';
}
function legislatorById(bg) {
  if (!bg) return null;
  return ((DB.list && DB.list('hill_members')) || []).find(m => m && m.bioguide_id === bg) || null;
}
function legislatorLabel(m) {
  if (!m) return '';
  const honorific = m.chamber === 'senate' ? 'Sen.' : 'Rep.';
  const party = _legPartyKey(m.party);
  const stateBit = m.state ? (m.state + (m.district != null && m.district !== '' ? '-' + m.district : '')) : '';
  const tail = (party && stateBit) ? ' (' + party + '-' + stateBit + ')' : (stateBit ? ' (' + stateBit + ')' : '');
  return honorific + ' ' + (m.full_name || m.last_name || m.bioguide_id) + tail;
}
function legislatorSearchHay(c) {
  const m = legislatorById(c && c.legislator_bioguide_id);
  return m ? legislatorLabel(m) : '';
}

function editContact(id) {
  const c = id ? Object.assign({}, DB.get('contacts', id)) : { id:'', firstName:'', lastName:'', callsign:'', rank:'', title:'', email:'', phone:'', linkedinUrl:'', org:'', photoUrl:'', officeIds:[], legislator_bioguide_id:'', unit:'', branch:'', source:'', lead:'', notes:'' };
  const body = document.createElement('div');
  body.appendChild(fieldRow(
    field('First Name', '<input id="f-firstName" value="' + escHtml(c.firstName) + '">'),
    field('Last Name',  '<input id="f-lastName"  value="' + escHtml(c.lastName) + '">')
  ));
  body.appendChild(fieldRow(
    field('Callsign', '<input id="f-callsign" value="' + escHtml(c.callsign||'') + '" placeholder="e.g. MAVERICK">'),
    field('Rank',  '<input id="f-rank"  value="' + escHtml(c.rank||'') + '" placeholder="e.g. Lt Col / Col / SES / Civilian">')
  ));
  body.appendChild(field('Title / Role', '<input id="f-title" value="' + escHtml(c.title||'') + '">'));
  body.appendChild(fieldRow(
    field('Email', '<input id="f-email" type="email" value="' + escHtml(c.email||'') + '">'),
    field('Phone', '<input id="f-phone" value="' + escHtml(c.phone||'') + '">')
  ));
  body.appendChild(field('LinkedIn URL', '<input id="f-linkedinUrl" type="url" value="' + escHtml(c.linkedinUrl||'') + '" placeholder="https://linkedin.com/in/...">'));
  body.appendChild(fieldRow(
    field('Org / Organization', '<input id="f-org" value="' + escHtml(c.org||'') + '" placeholder="e.g. AFRL, OSD, DARPA, Boeing">'),
    field('Department', '<input id="f-department" value="' + escHtml(c.department||'') + '" placeholder="e.g. Directed Energy, S&T, Acquisitions">')
  ));
  // Photo: file upload (uploads to Supabase storage on save) or keep existing URL
  let _pendingPhotoFile = null;
  const _photoPreviewId = 'f-photo-preview-' + Math.random().toString(36).slice(2);
  const _photoInputId   = 'f-photo-input-'   + Math.random().toString(36).slice(2);
  const photoWrap = document.createElement('div');
  photoWrap.innerHTML = field('Photo', '').outerHTML;
  const photoFieldEl = field('Photo',
    (c.photoUrl ? '<img id="' + _photoPreviewId + '" src="' + escHtml(c.photoUrl) + '" style="width:64px;height:64px;border-radius:50%;object-fit:cover;display:block;margin-bottom:6px;">' : '')
    + '<input type="file" id="' + _photoInputId + '" accept="image/*" style="font-size:12px;color:var(--text-dim);">'
  );
  body.appendChild(photoFieldEl);
  // Wire preview on file select (after DOM is attached by openModal)
  setTimeout(() => {
    const inp = document.getElementById(_photoInputId);
    if (!inp) return;
    inp.addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      _pendingPhotoFile = f;
      const reader = new FileReader();
      reader.onload = ev => {
        let prev = document.getElementById(_photoPreviewId);
        if (!prev) {
          prev = document.createElement('img');
          prev.id = _photoPreviewId;
          prev.style.cssText = 'width:64px;height:64px;border-radius:50%;object-fit:cover;display:block;margin-bottom:6px;';
          inp.parentNode.insertBefore(prev, inp);
        }
        prev.src = ev.target.result;
      };
      reader.readAsDataURL(f);
    });
  }, 0);
  // values are independent (a contact may carry both a DoW org AND a
  // Hill principal); the toggle only controls which picker is visible.
  const linkField = field('Link to', '', 'Toggle between DoW orgs and Congress members. Both can be set; current selections are preserved when you switch.');
  body.appendChild(linkField);

  const toggle = document.createElement('div');
  toggle.className = 'link-toggle';
  toggle.innerHTML =
    '<button type="button" data-pane="dow" class="active">DoW <span class="lt-count" data-pane-count="dow">0</span></button>' +
    '<button type="button" data-pane="congress">Congress <span class="lt-count" data-pane-count="congress">0</span></button>';
  linkField.appendChild(toggle);

  const dowPane = document.createElement('div');
  dowPane.className = 'link-pane active'; dowPane.dataset.pane = 'dow';
  const officeBox = document.createElement('div'); officeBox.className = 'multi-select-box';
  dowPane.appendChild(officeBox);
  linkField.appendChild(dowPane);

  const congressPane = document.createElement('div');
  congressPane.className = 'link-pane'; congressPane.dataset.pane = 'congress';
  const legBox = document.createElement('div'); legBox.className = 'multi-select-box';
  congressPane.appendChild(legBox);
  linkField.appendChild(congressPane);

  const _DEPT_SHORT_EC = { af:'AF', army:'Army', navy:'Navy', marines:'Marines', socom:'SOCOM', osd:'OSD', joint:'Joint', congress:'Congress' };
  const officeOptions = DB.list('offices').map(o => {
    const dk = String(o.department||'').toLowerCase();
    const suffix = dk && _DEPT_SHORT_EC[dk] ? ' · ' + _DEPT_SHORT_EC[dk] : (o.department ? ' · ' + o.department : '');
    return { id: o.id, label: (o.name || o.id) + suffix };
  }).sort((a,b) => a.label.localeCompare(b.label));

  const legislatorOptions = ((DB.list && DB.list('hill_members')) || [])
    .filter(m => m && m.bioguide_id)
    .map(m => ({
      id: m.bioguide_id,
      label: legislatorLabel(m),
      _chamberRank: m.chamber === 'senate' ? 0 : 1,
      _last: (m.last_name || m.full_name || '').toLowerCase()
    }))
    .sort((a, b) => (a._chamberRank - b._chamberRank) || a._last.localeCompare(b._last))
    .map(o => ({ id: o.id, label: o.label }));

  const updateCounts = () => {
    const dowN = officeMS.get().length;
    const cgN  = legSS.get() ? 1 : 0;
    const dowEl = toggle.querySelector('[data-pane-count="dow"]');
    const cgEl  = toggle.querySelector('[data-pane-count="congress"]');
    if (dowEl) dowEl.textContent = String(dowN);
    if (cgEl)  cgEl.textContent  = String(cgN);
  };

  const officeMS = makeMultiSelect(officeBox, officeOptions, c.officeIds || [], updateCounts);
  const legSS    = makeSingleSelect(legBox, legislatorOptions, c.legislator_bioguide_id || '', updateCounts);
  updateCounts();

  const initialPane = (!(c.officeIds||[]).length && c.legislator_bioguide_id) ? 'congress' : 'dow';
  toggle.querySelectorAll('button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.pane === initialPane);
    btn.addEventListener('click', () => {
      const target = btn.dataset.pane;
      toggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.pane === target));
      [dowPane, congressPane].forEach(p => p.classList.toggle('active', p.dataset.pane === target));
    });
  });
  [dowPane, congressPane].forEach(p => p.classList.toggle('active', p.dataset.pane === initialPane));
  body.appendChild(fieldRow(
    field('Source', '<input id="f-source" value="' + escHtml(c.source||'') + '" placeholder="BHG / Bart / Airtable / etc." data-dup="1">'),
    field('Relationship Lead', '<input id="f-lead" value="' + escHtml(c.lead||'') + '" placeholder="e.g. Chance / Greg / Trish">')
  ));
  body.appendChild(field('Notes', '<textarea id="f-notes">' + escHtml(c.notes||'') + '</textarea>'));
  openModal({
    title: id ? 'Edit Contact · ' + (c.firstName + ' ' + c.lastName).trim() : 'Add Contact',
    body, table:'contacts', id: c.id || '',
    onSave: async () => {
      const rec = {
        id: c.id || '',
        firstName: document.getElementById('f-firstName').value.trim(),
        lastName:  document.getElementById('f-lastName').value.trim(),
        callsign:  document.getElementById('f-callsign').value.trim(),
        rank:      document.getElementById('f-rank').value.trim(),
        title:     document.getElementById('f-title').value.trim(),
        email:     document.getElementById('f-email').value.trim(),
        phone:     document.getElementById('f-phone').value.trim(),
        linkedinUrl: document.getElementById('f-linkedinUrl').value.trim(),
        org:         document.getElementById('f-org').value.trim(),
        department:  document.getElementById('f-department').value,
        photoUrl:    c.photoUrl || '',
        officeIds: officeMS.get(),
        legislator_bioguide_id: legSS.get() || null,   // v167
        unit:      c.unit || '',     // preserved; field removed in v16
        branch:    c.branch || '',   // preserved; UI field removed in v47 (use Org's department instead)
        source:    document.getElementById('f-source').value.trim(),
        lead:      document.getElementById('f-lead').value.trim(),
        notes:     document.getElementById('f-notes').value.trim(),
      };
      if (!rec.lastName && !rec.firstName) { alert('At least a name is required.'); return; }
      if (_pendingPhotoFile) {
        try {
          const contactId = rec.id || ('contact_' + Date.now() + '_' + Math.random().toString(36).slice(2));
          rec.id = rec.id || contactId;
          const up = await uploadIntoLettersBucket('contact-photos', contactId, _pendingPhotoFile);
          rec.photoUrl = up.url;
        } catch (e) {
          alert('Photo upload failed: ' + (e && e.message ? e.message : e));
          return;
        }
      }
      DB.upsert('contacts', rec); closeModal(); refreshAll();
    }
  });
}
document.getElementById('btnAddContact').addEventListener('click', () => editContact(null));
['contactsSearch','contactsOfficeFilter','contactsDeptFilter','contactsChampionOnly','contactsPriorityOrgOnly','contactsHasSolOnly','contactsHasLosOnly'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  const evt = el.type === 'checkbox' ? 'change' : 'input';
  el.addEventListener(evt, renderContacts);
});
attachSorting(document.getElementById('contactsTable'), 'contacts', renderContacts);

document.getElementById('btnExportContacts').addEventListener('click', () => {
  const headers = ['id','firstName','lastName','callsign','rank','title','department','email','phone','linkedinUrl','org','photoUrl','officeIds','officeNames','legislator_bioguide_id','legislatorLabel','branch','source','lead','champion','notes'];
  const visible = currentTableRows('contactsTable', DB.list('contacts'));
  const rows = visible.map(c => Object.assign({}, c, {
    department: contactDepartment(c),
    officeIds: (c.officeIds||[]).join('; '),
    officeNames: (c.officeIds||[]).map(officeName).join('; '),
    legislator_bioguide_id: c.legislator_bioguide_id || '',
    legislatorLabel: legislatorSearchHay(c),
  }));
  downloadFile('contacts.csv', csvFormat(rows, headers));
});
document.getElementById('btnImportContacts').addEventListener('click', () => {
  importCsvInto('contacts', row => ({
    id: row.id || '',
    firstName: row.firstName || row['First Name'] || row.First || '',
    lastName:  row.lastName  || row['Last Name']  || row.Last  || '',
    callsign:  row.callsign  || row.Callsign      || row['Call Sign'] || '',
    rank:      row.rank || row.Rank || '',
    title:     row.title || row.Title || row['Title/Role'] || row['Title / Role'] || '',
    email:     row.email || row.Email || '',
    phone:     row.phone || row.Phone || '',
    linkedinUrl: row.linkedinUrl || row['LinkedIn'] || row['LinkedIn URL'] || row.linkedin || '',
    org:        row.org || row.Org || row.Organization || row['Org / Organization'] || '',
    department: row.department || row.Department || '',
    photoUrl:   row.photoUrl || row['Photo URL'] || row.photo || '',
    officeIds: arrField(row.officeIds || row.Offices || ''),
    legislator_bioguide_id: (row.legislator_bioguide_id || row['Legislator BioguideId'] || row.bioguide_id || '').trim() || null,  // v167
    unit:      row.unit || row.Unit || row['Unit/HHQ'] || row['Unit / HHQ'] || '',
    branch:    row.branch || row.Branch || '',
    source:    row.source || row.Source || '',
    lead:      row.lead || row.Lead || row['BHG Relationship Lead'] || row['Relationship Lead'] || '',
    notes:     row.notes || row.Notes || '',
  }));
});

// =================================================================
// =================================================================
window.renderContacts = renderContacts;
window.editContact = editContact;
window._legPartyKey = _legPartyKey;
window.legislatorById = legislatorById;
window.legislatorLabel = legislatorLabel;
window.legislatorSearchHay = legislatorSearchHay;
