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
//  Canonical US military + civilian rank list (datalist)
// ---------------------------------------------------------------
const RANK_LIST = [
  // ── Army / Marine Corps / USSF / Air Force Officers (O1-O10) ──
  // O1-O6 shared across these branches; flag officers follow same pattern
  '2nd LT','1st LT','Capt (O3)','Maj','Lt Col','Colonel',
  'Brig Gen','Maj Gen','Lt Gen','Gen','Gen of Army',
  // ── Army / Marine Corps Warrant Officers ───────────────────
  'WO1','CW2','CW3','CW4','CW5',
  // ── Army Enlisted ──────────────────────────────────────────
  'PVT','PV2','PFC','SPC','CPL','SGT','SSG','SFC','MSG','1SG','SGM','CSM','SMA',
  // ── Marine Corps Enlisted ──────────────────────────────────
  'Pvt','PFC','LCpl','Cpl','Sgt','SSgt','GySgt','MSgt','1stSgt','MGySgt','SgtMaj','SgtMajMC',
  // ── Air Force Enlisted ─────────────────────────────────────
  'AB','Amn','A1C','SrA','SSgt','TSgt','MSgt','SMSgt','CMSgt','CCM','CMSAF',
  // ── Space Force Enlisted (Guardians) ──────────────────────
  'Spc1','Spc2','Spc3','Spc4','Sgt','TSgt','MSgt','SMSgt','CMSgt','CMSgT',
  // ── Navy / Coast Guard Officers (O1-O10) ───────────────────
  'ENS','LTJG','LT','LTCDR','CDR','CAPT (O6)','RDML','RADM','VADM','ADM','FADM',
  // ── Navy / Coast Guard Warrant ─────────────────────────────
  'CWO2','CWO3','CWO4','CWO5',
  // ── Navy / Coast Guard Enlisted ────────────────────────────
  'SR','SA','SN','PO3','PO2','PO1','CPO','SCPO','MCPO','MCPON','MCPOCG',
  // ── GS Civilian ────────────────────────────────────────────
  'GS-1','GS-2','GS-3','GS-4','GS-5','GS-6','GS-7','GS-8','GS-9','GS-10',
  'GS-11','GS-12','GS-13','GS-14','GS-15',
  // ── Senior / Executive Civilian ────────────────────────────
  'SES','SL','ST',
  // ── Other ──────────────────────────────────────────────────
  'Civilian','Contractor','SETA','Fellow',
];
// Deduplicate while preserving order
const RANK_OPTIONS = [...new Set(RANK_LIST)];
const RANK_DATALIST_ID = 'rankDatalist';
// Inject datalist once into the document
(function () {
  if (document.getElementById(RANK_DATALIST_ID)) return;
  const dl = document.createElement('datalist');
  dl.id = RANK_DATALIST_ID;
  dl.innerHTML = RANK_OPTIONS.map(r => '<option value="' + escHtml(r) + '">').join('');
  document.body.appendChild(dl);
})();

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
    field('Rank',  '<input id="f-rank" list="' + RANK_DATALIST_ID + '" value="' + escHtml(c.rank||'') + '" placeholder="Type to search ranks…" autocomplete="off">')
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

// ---------------------------------------------------------------
//  AI Engagement Log
// ---------------------------------------------------------------
async function logEngagement() {
  // ── Step 1: input modal ──────────────────────────────────────
  const step1Body = document.createElement('div');
  step1Body.innerHTML = `
    <p style="color:var(--text-muted);font-size:13px;margin:0 0 10px;">
      Describe who you met, what was discussed, or paste any notes.
      The AI will extract contact info and look up background on the person.
    </p>
    <textarea id="ai-log-text" rows="7" placeholder="e.g. Met with Col. Sarah McClain at AFRL Wright-Patt on 10 June to discuss the Directed Energy portfolio. She is the division chief for DE programs and was very interested in our laser ranging work. Follow up scheduled for July.

Or: New contact — General George Patton, runs the 3rd Army out of Fort Knox, legendary tank commander." style="width:100%;box-sizing:border-box;font-size:13px;"></textarea>
    <div id="ai-log-status" style="margin-top:8px;font-size:12px;color:var(--text-dim);min-height:18px;"></div>`;

  openModal({
    title: '✦ AI Engagement Log',
    body: step1Body,
    saveLabel: 'Analyze →',
    table: null, id: null,
    onSave: async () => {
      const text = (document.getElementById('ai-log-text') || {}).value || '';
      if (!text.trim()) { alert('Please enter some text first.'); return; }

      const statusEl = document.getElementById('ai-log-status');
      if (statusEl) statusEl.textContent = '⏳ Analyzing…';

      // Disable save button while working
      const saveBtn = document.getElementById('modalSave');
      if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Analyzing…'; }

      let result;
      try {
        const res = await fetch('/.netlify/functions/contact-intel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || ('HTTP ' + res.status));
        }
        result = await res.json();
      } catch (e) {
        if (statusEl) statusEl.textContent = '❌ Error: ' + e.message;
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Analyze →'; }
        return;
      }

      closeModal();
      _showIntelResult(result, text);
    }
  });
  setTimeout(() => { const t = document.getElementById('ai-log-text'); if (t) t.focus(); }, 50);
}

function _showIntelResult(result, originalText) {
  const ex = result.extracted || {};
  const enr = result.enrichment || {};
  const questions = result.questions || [];
  const engNote = result.engagementNote || '';

  const body = document.createElement('div');

  // ── Enrichment banner ───────────────────────────────────────
  if (enr.summary) {
    const conf = enr.confidence || 'low';
    const confColor = conf === 'high' ? '#2d7a3a' : conf === 'medium' ? '#8a6a00' : '#666';
    body.insertAdjacentHTML('beforeend', `
      <div style="background:var(--surface-alt);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:14px;">
        <div style="font-size:11px;font-weight:600;letter-spacing:.05em;color:${confColor};margin-bottom:4px;">
          AI BACKGROUND · ${conf.toUpperCase()} CONFIDENCE
        </div>
        <div style="font-size:13px;color:var(--text);line-height:1.5;">${escHtml(enr.summary)}</div>
        ${enr.caveat ? `<div style="font-size:11px;color:var(--text-dim);margin-top:6px;font-style:italic;">${escHtml(enr.caveat)}</div>` : ''}
        ${enr.currentRole ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">Current role: ${escHtml(enr.currentRole)}</div>` : ''}
      </div>`);
  }

  // ── Extracted fields ────────────────────────────────────────
  body.insertAdjacentHTML('beforeend', `<div style="font-size:11px;font-weight:600;letter-spacing:.05em;color:var(--text-dim);margin-bottom:8px;">EXTRACTED CONTACT INFO — review and edit before saving</div>`);

  const fRow = (label, id, val, placeholder, datalistId) =>
    `<div style="margin-bottom:8px;">
      <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:2px;">${label}</label>
      <input id="${id}" value="${escHtml(val||'')}" placeholder="${escHtml(placeholder||'')}" style="width:100%;box-sizing:border-box;font-size:13px;"${datalistId ? ' list="' + escHtml(datalistId) + '" autocomplete="off"' : ''}>
    </div>`;

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:0 12px;';
  grid.innerHTML =
    fRow('First Name',  'ai-firstName',  ex.firstName,  '') +
    fRow('Last Name',   'ai-lastName',   ex.lastName,   '') +
    fRow('Rank',        'ai-rank',       ex.rank,       'e.g. Col, BGen, SES', RANK_DATALIST_ID) +
    fRow('Title / Role','ai-title',      ex.title,      '') +
    fRow('Org',         'ai-org',        ex.org,        'e.g. AFRL, MDA') +
    fRow('Department',  'ai-dept',       ex.department, 'e.g. Directed Energy') +
    fRow('Email',       'ai-email',      ex.email,      '') +
    fRow('Phone',       'ai-phone',      ex.phone,      '');
  body.appendChild(grid);

  // Notes / engagement summary
  body.insertAdjacentHTML('beforeend', `
    <div style="margin-bottom:10px;">
      <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:2px;">Engagement Notes</label>
      <textarea id="ai-notes" rows="4" style="width:100%;box-sizing:border-box;font-size:13px;">${escHtml(engNote)}</textarea>
    </div>`);

  // ── Clarifying questions ────────────────────────────────────
  if (questions.length) {
    body.insertAdjacentHTML('beforeend', `<div style="font-size:11px;font-weight:600;letter-spacing:.05em;color:var(--text-dim);margin:10px 0 6px;">AI QUESTIONS — answer to improve accuracy</div>`);
    questions.forEach((q, i) => {
      const qEl = document.createElement('div');
      qEl.style.cssText = 'background:var(--accent-bg);border-radius:6px;padding:10px 12px;margin-bottom:6px;';
      qEl.innerHTML = `
        <div style="font-size:12px;color:var(--text);margin-bottom:4px;">${escHtml(q.question)}</div>
        <input id="ai-q-${i}" value="${escHtml(q.suggestedAnswer||'')}" placeholder="Your answer…" style="width:100%;box-sizing:border-box;font-size:12px;" data-ai-q-field="${escHtml(q.field||'')}">`;
      body.appendChild(qEl);
    });
  }

  openModal({
    title: '✦ AI Log — Confirm Contact',
    body,
    saveLabel: 'Save Contact',
    table: null, id: null,
    onSave: () => {
      // Merge question answers back into fields
      const fieldOverrides = {};
      questions.forEach((q, i) => {
        const inp = document.getElementById('ai-q-' + i);
        if (inp && inp.value.trim() && q.field) fieldOverrides[q.field] = inp.value.trim();
      });

      const rec = {
        id: '',
        firstName:  (fieldOverrides.firstName  || document.getElementById('ai-firstName').value  || '').trim(),
        lastName:   (fieldOverrides.lastName   || document.getElementById('ai-lastName').value   || '').trim(),
        rank:       (fieldOverrides.rank       || document.getElementById('ai-rank').value       || '').trim(),
        title:      (fieldOverrides.title      || document.getElementById('ai-title').value      || '').trim(),
        org:        (fieldOverrides.org        || document.getElementById('ai-org').value        || '').trim(),
        department: (fieldOverrides.department || document.getElementById('ai-dept').value       || '').trim(),
        email:      (fieldOverrides.email      || document.getElementById('ai-email').value      || '').trim(),
        phone:      (fieldOverrides.phone      || document.getElementById('ai-phone').value      || '').trim(),
        notes:      (document.getElementById('ai-notes').value || '').trim(),
        officeIds: [],
        photoUrl: '',
        linkedinUrl: enr.linkedinHint || '',
        source: 'AI Log',
        lead: '', callsign: '', unit: '', branch: ex.branch || '', legislator_bioguide_id: null,
      };
      if (!rec.lastName && !rec.firstName) { alert('At least a name is required.'); return; }
      DB.upsert('contacts', rec);
      closeModal();
      refreshAll();
    }
  });
}

document.getElementById('btnLogEngagement').addEventListener('click', logEngagement);
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
