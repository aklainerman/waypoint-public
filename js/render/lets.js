// js/render/lets.js
//
// Letters of Support feature: table renderer, PDF viewer modal, Supabase
// upload helpers (general letters bucket), modal editor, and CSV import/
// export wirings.
//
// Originally at file-scope of the inline monolith; lifted to ES module
// in v193. Same classic-script-split pattern as v181-v192.
//
// Pre-extraction audit (v185 pattern):
//
//   renderLets:               2 ext refs (monolith tab-activation
//                                          switches)
//   editLet:                  2 ext refs (graph.js, for letter-node
//                                          clicks in Cytoscape graph)
//   uploadIntoLettersBucket:  4 ext refs (office.js x2 for office-media
//                                          uploads; sols.js x2 for sol
//                                          PDF + submission PDF uploads)
//   openLetterPdfViewer:      module-internal only (called from row
//                                                    click handler)
//   uploadLetterPdf:          module-internal only (called from editLet)
//
// The three exposed names preserve the cross-module contract: graph.js
// reaches editLet via window, and office.js / sols.js reach
// uploadIntoLettersBucket via window for their respective file-upload
// paths.
//
// Consumes from window (monolith + earlier modules):
//   DB, escHtml, escAttr, fmtMoney, openModal, closeModal, field,
//   fieldRow, makeMultiSelect, selectFromList, refillOfficeSelect,
//   officeName, attachSorting, applySort, currentTableRows, csvFormat,
//   downloadFile, importCsvInto, arrField, refreshAll, activateTab,
//   _sb (Supabase client),
//   and other monolith file-scope helpers.

// ---------------------------------------------------------------
//  LETTERS OF SUPPORT tab
// ---------------------------------------------------------------
function renderLets() {
  const tbody = document.querySelector('#letTable tbody');
  const q = (document.getElementById('letSearch').value || '').toLowerCase();
  const sf = document.getElementById('letStageFilter').value;
  const of = document.getElementById('letOfficeFilter').value;
  refillOfficeSelect(document.getElementById('letOfficeFilter'), 'All orgs');
  let rows = DB.list('letters').filter(l => {
    if (sf && l.status !== sf) return false;
    if (of && l.officeId !== of) return false;
    if (q) {
      const blob = [l.name, l.letter_type, l.notes, officeName(l.officeId)].join(' ').toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });
  rows = applySort(rows, 'lets', {
    name: r => r.name,
    letter_type: r => r.letter_type || '',
    officeId: r => officeName(r.officeId),
    status: r => r.status,
    department: r => officeDepartmentById(r.officeId),
  });
  document.getElementById('letCount').textContent = rows.length + ' letters';
  tbody.innerHTML = rows.map(l => '<tr data-id="' + l.id + '">'
    + '<td><strong>' + escHtml(l.name) + '</strong></td>'
    + '<td><span class="chip" style="font-size:11px;padding:2px 7px;background:var(--surface-2);border:1px solid var(--border);border-radius:10px;color:var(--text);">' + escHtml(l.letter_type || 'Letter of Support') + '</span></td>'
    + '<td>' + orgCell(l.officeId) + '</td>'
    + '<td>' + deptBadge(officeDepartmentById(l.officeId)) + '</td>'
    + '<td>' + (l.officeId ? DB.list('contacts').filter(c => (c.officeIds||[]).includes(l.officeId)).length : (l.contactIds||[]).length) + '</td>'
    + '<td>' + statusPill(l.status) + '</td>'
    + '<td class="td-truncate" title="' + escHtml(l.notes||'') + '">' + escHtml(l.notes||'') + '</td>'
    + '<td class="td-actions">'
      + '<button class="btn-icon" data-edit="' + l.id + '">Edit</button>'
      + '<button class="btn-icon danger" data-del="' + l.id + '">Del</button>'
    + '</td></tr>'
  ).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text-dim);padding:1.5rem;">No letters.</td></tr>';
  tbody.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); editLet(b.dataset.edit); }));
  tbody.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); if (confirm('Delete letter?')) { DB.remove('letters', b.dataset.del); refreshAll(); }}));
  tbody.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', (e) => {
    if (e.target.closest('button, .chip, a')) return;
    // NOT the edit modal. Edit lives behind the explicit Edit button.
    openLetterPdfViewer(tr.dataset.id);
  }));
  wireChipJumps(tbody);
}
function openLetterPdfViewer(letterId) {
  var l = DB.get('letters', letterId); if (!l) return;
  var body = document.createElement('div');
  body.style.cssText = 'min-width:520px;max-width:80vw;';
  if (l.pdf_url) {
    var fname = l.pdf_filename || 'letter.pdf';
    body.innerHTML = '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px;">'
      + '<div style="font-size:12px;color:var(--text-muted);">' + escHtml(fname) + '</div>'
      + '<a href="' + escHtml(l.pdf_url) + '" target="_blank" rel="noopener" style="font-size:11.5px;color:var(--accent);">Open in new tab ↗</a>'
      + '</div>'
      + '<iframe src="' + escHtml(l.pdf_url) + '" style="width:100%;height:70vh;border:1px solid var(--border);border-radius:6px;background:#fff;"></iframe>';
  } else {
    body.innerHTML = '<div style="padding:24px 12px;text-align:center;color:var(--text-muted);">'
      + '<div style="font-size:14px;margin-bottom:6px;">No PDF attached to this letter yet.</div>'
      + '<div style="font-size:12px;">Click <strong>Edit</strong> on the row to upload one.</div>'
      + '</div>';
  }
  openModal({
    title: 'Letter · ' + (l.name || l.id),
    body, table: 'letters', id: l.id,
    saveLabel: 'Close',
    onSave: function(){ closeModal(); },
    hideDelete: true,
    hideSave: true
  });
}
// return its public URL. Filename is namespaced by letter id + a timestamp
// so re-uploads don't collide.
async function uploadLetterPdf(letterId, file) {
  if (!_sb) throw new Error('Supabase client not ready');
  if (!file || !letterId) throw new Error('uploadLetterPdf: missing args');
  var safeName = String(file.name || 'letter.pdf').replace(/[^A-Za-z0-9._-]+/g, '_');
  var path = letterId + '/' + Date.now() + '_' + safeName;
  var up = await _sb.storage.from('letters').upload(path, file, {
    cacheControl: '3600', upsert: true, contentType: file.type || 'application/pdf'
  });
  if (up.error) throw up.error;
  var pub = _sb.storage.from('letters').getPublicUrl(path);
  var url = pub && pub.data && pub.data.publicUrl;
  if (!url) throw new Error('uploadLetterPdf: no public URL returned');
  return { url: url, filename: file.name || safeName, path: path };
}
// bucket under a path prefix. Used for sol PDFs (prefix='sols'), our
// submission PDFs (prefix='submissions'), and org media (prefix='org-media').
// Returns { url, filename, path } the same way uploadLetterPdf does.
async function uploadIntoLettersBucket(prefix, ownerId, file) {
  if (!_sb) throw new Error('Supabase client not ready');
  if (!file || !ownerId || !prefix) throw new Error('uploadIntoLettersBucket: missing args');
  var safeName = String(file.name || 'file').replace(/[^A-Za-z0-9._-]+/g, '_');
  var path = prefix + '/' + ownerId + '/' + Date.now() + '_' + safeName;
  var up = await _sb.storage.from('letters').upload(path, file, {
    cacheControl: '3600', upsert: true,
    contentType: file.type || 'application/octet-stream'
  });
  if (up.error) throw up.error;
  var pub = _sb.storage.from('letters').getPublicUrl(path);
  var url = pub && pub.data && pub.data.publicUrl;
  if (!url) throw new Error('uploadIntoLettersBucket: no public URL returned');
  return { url: url, filename: file.name || safeName, path: path };
}
function editLet(id) {
  const l = id ? Object.assign({}, DB.get('letters', id)) : { id:'', name:'', letter_type:'Letter of Support', officeId:'', contactIds:[], status:'1. Identified', notes:'' };
  const body = document.createElement('div');
  body.appendChild(field('Name / Title', '<input id="f-name" value="' + escHtml(l.name||'') + '">'));
  body.appendChild(field('Type', selectFromList('f-letter-type',
    ['Letter of Support','Capability Needs Statement','Urgent Operational Needs','Other'],
    l.letter_type || 'Letter of Support')));
  body.appendChild(fieldRow(
    field('Office', selectOfficesHtml('f-officeId', l.officeId)),
    field('Stage', selectFromList('f-status', ['1. Identified','2. In Contact','3. Drafting','4. In Review','5. Signed','6. Complete'], l.status))
  ));
  const cBox = document.createElement('div'); cBox.className = 'multi-select-box';
  body.appendChild(field('Contacts', '')); body.lastChild.appendChild(cBox);
  const cMs = makeMultiSelect(cBox, DB.list('contacts').map(c => ({id:c.id, label:(c.firstName||'')+' '+(c.lastName||'')})), l.contactIds||[]);
    body.appendChild(field('Notes', '<textarea id="f-notes">' + escHtml(l.notes||'') + '</textarea>'));
  // New uploads are saved on Save (the file is uploaded to the 'letters' bucket and
  // the resulting public URL is written into letters.pdf_url + pdf_filename).
  let _pendingPdfFile = null;
  let _pendingPdfRemove = false;
  const pdfWrap = document.createElement('div');
  pdfWrap.id = 'f-pdf-wrap';
  function _renderPdfSlot() {
    const cur = (!_pendingPdfRemove) ? (l.pdf_url || '') : '';
    const fname = _pendingPdfRemove ? '' : (l.pdf_filename || '');
    if (_pendingPdfFile) {
      pdfWrap.innerHTML = '<div style="display:flex;align-items:center;gap:8px;font-size:12px;">'
        + '<span style="color:var(--accent);">⏷ New file:</span>'
        + '<span><strong>' + escHtml(_pendingPdfFile.name) + '</strong> ' + Math.round(_pendingPdfFile.size/1024) + ' KB</span>'
        + '<a id="f-pdf-cancel-new" style="margin-left:auto;color:var(--text-muted);cursor:pointer;font-size:11.5px;">cancel</a>'
        + '</div>';
      pdfWrap.querySelector('#f-pdf-cancel-new').addEventListener('click', function(){ _pendingPdfFile = null; _renderPdfSlot(); });
      return;
    }
    if (cur) {
      pdfWrap.innerHTML = '<div style="display:flex;align-items:center;gap:8px;font-size:12px;flex-wrap:wrap;">'
        + '<a href="' + escHtml(cur) + '" target="_blank" rel="noopener" style="color:var(--accent);">¶ ' + escHtml(fname || 'letter.pdf') + '</a>'
        + '<a id="f-pdf-replace" style="color:var(--text-muted);cursor:pointer;font-size:11.5px;">replace</a>'
        + '<a id="f-pdf-remove" style="color:var(--text-muted);cursor:pointer;font-size:11.5px;">remove</a>'
        + '</div>';
      pdfWrap.querySelector('#f-pdf-replace').addEventListener('click', function(){ document.getElementById('f-pdf-input').click(); });
      pdfWrap.querySelector('#f-pdf-remove').addEventListener('click', function(){ _pendingPdfRemove = true; _pendingPdfFile = null; _renderPdfSlot(); });
      return;
    }
    pdfWrap.innerHTML = '<div style="font-size:11.5px;color:var(--text-muted);">No PDF attached. Use the file picker below to add one.</div>';
  }
  _renderPdfSlot();
  const pdfInput = document.createElement('input');
  pdfInput.type = 'file'; pdfInput.id = 'f-pdf-input'; pdfInput.accept = 'application/pdf';
  pdfInput.style.cssText = 'margin-top:6px;font-size:12px;';
  pdfInput.addEventListener('change', function(){
    var f = pdfInput.files && pdfInput.files[0];
    if (!f) return;
    if (f.type && f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name||'')) {
      alert('Please pick a PDF file.'); pdfInput.value = ''; return;
    }
    _pendingPdfFile = f; _pendingPdfRemove = false; _renderPdfSlot();
  });
  const pdfBlock = document.createElement('div');
  pdfBlock.appendChild(pdfWrap);
  pdfBlock.appendChild(pdfInput);
  body.appendChild(field('PDF Attachment', ''));
  body.lastChild.appendChild(pdfBlock);
  openModal({
    title: id ? 'Edit Letter · ' + (l.name||l.id) : 'Add Letter',
    body, table:'letters', id: l.id || '',
    onSave: async () => {
      let pdfUrl = (_pendingPdfRemove ? '' : (l.pdf_url || ''));
      let pdfFilename = (_pendingPdfRemove ? '' : (l.pdf_filename || ''));
      if (_pendingPdfFile) {
        try {
          const recId = l.id || ('let_' + Date.now());
          const up = await uploadLetterPdf(recId, _pendingPdfFile);
          pdfUrl = up.url; pdfFilename = up.filename;
          if (!l.id) l.id = recId; // promote so DB.upsert below picks the same id
        } catch (e) {
          alert('PDF upload failed: ' + (e && e.message ? e.message : e));
          return;
        }
      }
      const rec = {
        id: l.id || '',
        name:        document.getElementById('f-name').value.trim(),
        letter_type: document.getElementById('f-letter-type').value,
        officeId: document.getElementById('f-officeId').value,
        contactIds: cMs.get(),
        status:   document.getElementById('f-status').value,
        notes:    document.getElementById('f-notes').value.trim(),
        pdf_url:      pdfUrl,
        pdf_filename: pdfFilename,
      };
      if (!rec.name) { alert('Name is required.'); return; }
      DB.upsert('letters', rec); closeModal(); refreshAll();
    }
  });
}
document.getElementById('btnAddLet').addEventListener('click', () => editLet(null));
['letSearch','letStageFilter','letOfficeFilter'].forEach(id => document.getElementById(id).addEventListener('input', renderLets));
attachSorting(document.getElementById('letTable'), 'lets', renderLets);

document.getElementById('btnExportLet').addEventListener('click', () => {
  const headers = ['id','name','officeId','officeName','contactIds','status','notes'];
  const rows = currentTableRows('letTable', DB.list('letters')).map(l => Object.assign({}, l, {
    officeName: officeName(l.officeId),
    contactIds: (l.contactIds||[]).join('; '),
  }));
  downloadFile('letters_view.csv', csvFormat(rows, headers));
});
document.getElementById('btnImportLet').addEventListener('click', () => {
  importCsvInto('letters', row => ({
    id: row.id || '',
    name: row.name || row.Name || '',
    officeId: row.officeId || row.Units || row.Office || '',
    contactIds: arrField(row.contactIds || row.Contacts || ''),
    status: row.status || row.Status || '',
    assignee: row.assignee || row.Assignee || '',
    notes: row.notes || row.Notes || '',
  }));
});

// =================================================================
// =================================================================
window.renderLets = renderLets;
window.editLet = editLet;
window.uploadIntoLettersBucket = uploadIntoLettersBucket;
