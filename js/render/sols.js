// js/render/sols.js
//
// Solicitations feature: estimated-value helper, table renderer,
// modal editor, and CSV import/export.
//
// Originally at file-scope of the inline monolith; lifted to ES module
// in v192. Same classic-script-split pattern as v181-v191.
//
// Pre-extraction audit (v185 pattern). Three top-level declarations
// need window exposure:
//
//   renderSols:        8 ext refs (6 monolith including tab-activation
//                                   switches, sort-key updates, and
//                                   refreshAll; 2 in scout-client.js for
//                                   the Scout finding commit flow)
//   editSol:           5 ext refs (2 monolith including the sol detail
//                                   panel's "Edit" button + sol-row
//                                   click handler; 3 in graph.js for
//                                   sol-node clicks in Cytoscape graph)
//   solEstimatedValue: 5 ext refs (monolith, used by Mission Control,
//                                   priority-pipeline rollups, etc.)
//
// Priority helpers (isPePriority/isSagPriority/isSolPriority +
// togglePePriority/toggleSagPriority/toggleSolPriority) remain in the
// monolith for now; they're shared between Budget and Solicitations
// and will get their own small module later.
//
// Consumes from window (monolith + earlier modules):
//   DB, escHtml, escAttr, fmtMoney, fmtDate, statusPill, alignmentStars,
//   openModal, closeModal, field, fieldRow, makeMultiSelect,
//   selectFromList, refillOfficeSelect, officeName, officeChips,
//   attachSorting, applySort, currentTableRows, csvFormat, downloadFile,
//   importCsvInto, arrField, intOr, moneyParse, refreshAll, activateTab,
//   isSolPriority, toggleSolPriority, contactDepartment,
//   and other monolith file-scope helpers.

function solEstimatedValue(s) {
  if (!s) return 0;
  var v = Number(s.value) || 0;
  var p = Number(s.probability_pct) || 0;
  return v * (p / 100);
}

// ---------------------------------------------------------------
//  SOLICITATIONS tab
// ---------------------------------------------------------------
function renderSols() {
  const tbody = document.querySelector('#solTable tbody');
  const q = (document.getElementById('solSearch').value || '').toLowerCase();
  const sf = document.getElementById('solStatusFilter').value;
  const tf = document.getElementById('solTypeFilter').value;
  const of = document.getElementById('solOfficeFilter').value;
  refillOfficeSelect(document.getElementById('solOfficeFilter'), 'All orgs');
  const _solPrioEl = document.getElementById('solPriorityOnly');
  const _solPrioOnly = !!(_solPrioEl && _solPrioEl.checked);
  let rows = DB.list('solicitations').filter(s => {
    if (sf && s.status !== sf) return false;
    if (tf && s.type !== tf) return false;
    if (of && s.officeId !== of) return false;
    if (_solPrioOnly && !s.is_priority) return false;
    if (q) {
      const blob = [s.title, s.topic, (s.tech||[]).join(' '), s.notes, s.owner||'',
        officeName(s.officeId), (s.contactIds||[]).map(id => { const c=DB.get('contacts',id); return c?(c.firstName+' '+c.lastName):''; }).join(' ')
      ].join(' ').toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });
  rows = applySort(rows, 'sols', {
    title: r => r.title, officeId: r => officeName(r.officeId), value: r => Number(r.value||0),
    openDate: r => r.openDate || '', dueDate: r => r.dueDate || '', awardDate: r => r.awardDate || '', orgContacts: r => r.officeId ? DB.list('contacts').filter(c => (c.officeIds||[]).includes(r.officeId)).length : 0, type: r => r.type, phase: r => r.phase,
    status: r => r.status, alignment: r => Number(r.alignment||0),
    department: r => r.department || solicitationDepartment(r),
    priority: r => (r.is_priority ? 1 : 0),
    owner:    r => r.owner || '',
    probability:    r => Number(r.probability_pct||0),
    estimatedValue: r => solEstimatedValue(r),
  });
  const totalVal = rows.reduce((a,r)=>a + (Number(r.value)||0), 0);
  document.getElementById('solCount').textContent = rows.length + ' solicitations · ' + fmtMoney(totalVal);
  tbody.innerHTML = rows.map(s => {
    var _est = solEstimatedValue(s);
    var _prob = Number(s.probability_pct)||0;
    return '<tr data-id="' + s.id + '">'
    + '<td style="text-align:center;"><a class="sol-prio-star" data-sol-prio="' + escAttr(s.id) + '" title="' + (s.is_priority?'Unmark priority':'Mark priority') + '" style="cursor:pointer;color:' + (s.is_priority?'var(--priority)':'var(--text-muted)') + ';font-size:14px;line-height:1;text-decoration:none;">' + (s.is_priority?'★':'☆') + '</a></td>'
    + '<td><strong>' + escHtml(s.title) + '</strong>' + (s.link ? ' <a href="' + escHtml(s.link) + '" target="_blank" rel="noopener" title="Open link">↗</a>' : '') + '</td>'
    + '<td>' + escHtml(s.org || officeName(s.officeId) || '—') + '</td>'
    + '<td>' + (s.department ? deptBadge(s.department) : deptBadge(solicitationDepartment(s))) + '</td>'
    + '<td>' + (s.owner ? '<span class="card-tag">' + escHtml(s.owner) + '</span>' : '<span style="color:var(--text-muted);">—</span>') + '</td>'
    + '<td>' + (s.officeId ? DB.list('contacts').filter(c => (c.officeIds||[]).includes(s.officeId)).length : 0) + '</td>'
    + '<td>' + fmtMoney(s.value) + '</td>'
    + '<td>' + (_prob ? (_prob + '%') : '—') + '</td>'
    + '<td>' + (_est ? fmtMoney(_est) : '—') + '</td>'
    + '<td>' + escHtml(s.openDate || '—') + '</td>'
    + '<td>' + escHtml(s.dueDate || '—') + '</td>'
    + '<td>' + escHtml(s.awardDate || '—') + '</td>'
    + '<td>' + escHtml(s.type||'—') + '</td>'
    + '<td>' + escHtml(s.phase||'—') + '</td>'
    + '<td>' + statusPill(s.status) + '</td>'
    + '<td>' + alignmentStars(s.alignment) + '</td>'
    + '<td><span class="td-truncate" style="display:inline-block;max-width:180px;" title="' + escHtml((s.topic||'') + (s.tech?.length?' · ' + s.tech.join(', '):'')) + '">' + (s.tech&&s.tech.length ? s.tech.map(t => '<span class="card-tag">'+escHtml(t)+'</span>').join(' ') : escHtml(s.topic||'—')) + '</span></td>'
    + '<td class="td-actions">'
      + '<button class="btn-icon" data-edit="' + s.id + '">Edit</button>'
      + '<button class="btn-icon danger" data-del="' + s.id + '">Del</button>'
    + '</td></tr>';
  }).join('') || '<tr><td colspan="18" style="text-align:center;color:var(--text-dim);padding:1.5rem;">No solicitations.</td></tr>';
  tbody.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); editSol(b.dataset.edit); }));
  tbody.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); if (confirm('Delete solicitation?')) { DB.remove('solicitations', b.dataset.del); refreshAll(); }}));
  tbody.querySelectorAll('[data-sol-prio]').forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleSolPriority(a.getAttribute('data-sol-prio')); }));
  tbody.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', (e) => { if (e.target.closest('button, .chip, a')) return; openSolDetailPanel(tr.dataset.id); }));
  wireChipJumps(tbody);
}
function editSol(id) {
  const s = id ? Object.assign({}, DB.get('solicitations', id)) : { id:'', title:'', link:'', officeId:'', value:0, openDate:'', dueDate:'', awardDate:'', type:'', phase:'', topic:'', tech:[], products:[], status:'', contactIds:[], alignment:3, notes:'' };
  const body = document.createElement('div');
  body.appendChild(field('Title', '<input id="f-title" value="' + escHtml(s.title||'') + '">'));
  body.appendChild(fieldRow(
    field('Org', '<input id="f-org" value="' + escHtml(s.org||officeName(s.officeId)||'') + '" placeholder="e.g. Space Systems Command">'),
    field('Department', '<input id="f-department" value="' + escHtml(s.department||'') + '" placeholder="e.g. DEPARTMENT OF THE AIR FORCE">'),
    field('Link / URL', '<input id="f-link" value="' + escHtml(s.link||'') + '">')
  ));
  body.appendChild(fieldRow(
    field('Value (USD)', '<input id="f-value" type="number" min="0" step="1000" value="' + (Number(s.value)||0) + '">'),
    field('Open Date',  '<input id="f-openDate"  type="date" value="' + escHtml(s.openDate||'') + '">'),
    field('Due Date',   '<input id="f-dueDate"   type="date" value="' + escHtml(s.dueDate||'') + '">'),
    field('Award Date', '<input id="f-awardDate" type="date" value="' + escHtml(s.awardDate||'') + '">')
  ));
  body.appendChild(fieldRow(
    field('Type', selectFromList('f-type', ['','SBIR','STTR','IDIQ','OTA','BAA','Grant','RFI','RFP','CSO','Other'], s.type)),
    field('Phase', '<input id="f-phase" value="' + escHtml(s.phase||'') + '" placeholder="Phase II / D2P2 / STRATFI / …">'),
    field('Status', selectFromList('f-status', ['','Identified','Reviewing','Drafting','Applied','Negotiating','Won','Ignored','Lost'], s.status)),
    field('Alignment (1-5)', '<input id="f-alignment" type="number" min="0" max="5" value="' + (s.alignment||3) + '">')
  ));
  body.appendChild(fieldRow(
    field('Probability (%)', '<input id="f-probability" type="number" min="0" max="100" step="5" value="' + (Number(s.probability_pct)||0) + '">'),
    field('Owner', '<input id="f-owner" value="' + escHtml(s.owner||'') + '" placeholder="e.g. JS · BCM">'),
    field('Priority', '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;"><input id="f-isPriority" type="checkbox"' + (s.is_priority ? ' checked' : '') + '><span style="color:var(--priority);">★</span> Mark as priority</label>')
  ));
  body.appendChild(fieldRow(
    field('Topic', '<input id="f-topic" value="' + escHtml(s.topic||'') + '">'),
    field('Tech (comma-sep)', '<input id="f-tech" value="' + escHtml((s.tech||[]).join(', ')) + '" placeholder="Phoenix, Strata, DropPod, …">')
  ));
  // Useful for Won sols to record which products were delivered.
  body.appendChild(field('Products (comma-sep)', '<input id="f-products" value="' + escHtml((s.products||[]).join(', ')) + '" placeholder="Phoenix, Strata, DropPod, …">'));
  // Contacts multi-select
  const cBox = document.createElement('div'); cBox.className = 'multi-select-box';
  body.appendChild(field('Key Contacts', '', 'Add contacts already in CRM'));
  body.lastChild.appendChild(cBox);
  const contactOptions = DB.list('contacts').map(c => ({ id:c.id, label: (c.firstName||'') + ' ' + (c.lastName||'') + (c.title?' · '+c.title:'') }));
  const cMs = makeMultiSelect(cBox, contactOptions, s.contactIds || []);
  body.appendChild(field('Notes', '<textarea id="f-notes">' + escHtml(s.notes||'') + '</textarea>'));

  // Both reuse the existing 'letters' Storage bucket under different
  // prefixes (sols/<id>/... and submissions/<id>/...).
  // Existing PDFs render with View/Replace/Remove. New files upload on Save.
  function _makeSolPdfBlock(prefix, fieldLabel, urlAttr, filenameAttr, hint) {
    var state = { pending: null, remove: false };
    var slot = document.createElement('div');
    slot.style.cssText = 'min-height:24px;';
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/pdf';
    inp.style.cssText = 'margin-top:6px;font-size:12px;display:block;';
    inp.dataset.pdfInput = prefix;
    function _renderSlot() {
      var cur = state.remove ? '' : (s[urlAttr] || '');
      var fname = state.remove ? '' : (s[filenameAttr] || '');
      if (state.pending) {
        slot.innerHTML = '<div style="display:flex;align-items:center;gap:8px;font-size:12px;">'
          + '<span style="color:var(--accent);">\u23f7 New file:</span>'
          + '<span><strong>' + escHtml(state.pending.name) + '</strong> ' + Math.round(state.pending.size/1024) + ' KB</span>'
          + '<a data-cancel-new style="margin-left:auto;color:var(--text-muted);cursor:pointer;font-size:11.5px;">cancel</a>'
          + '</div>';
        var c = slot.querySelector('[data-cancel-new]');
        if (c) c.addEventListener('click', function(){ state.pending = null; inp.value = ''; _renderSlot(); });
        return;
      }
      if (cur) {
        slot.innerHTML = '<div style="display:flex;align-items:center;gap:8px;font-size:12px;flex-wrap:wrap;">'
          + '<a href="' + escHtml(cur) + '" target="_blank" rel="noopener" style="color:var(--accent);">\u00b6 ' + escHtml(fname || (prefix + '.pdf')) + '</a>'
          + '<a data-replace style="color:var(--text-muted);cursor:pointer;font-size:11.5px;">replace</a>'
          + '<a data-remove  style="color:var(--text-muted);cursor:pointer;font-size:11.5px;">remove</a>'
          + '</div>';
        var rep = slot.querySelector('[data-replace]');
        var rem = slot.querySelector('[data-remove]');
        if (rep) rep.addEventListener('click', function(){ inp.click(); });
        if (rem) rem.addEventListener('click', function(){ state.remove = true; state.pending = null; _renderSlot(); });
        return;
      }
      slot.innerHTML = '<div style="font-size:11.5px;color:var(--text-muted);">No PDF attached. Use the file picker below to add one.</div>';
    }
    inp.addEventListener('change', function(){
      var f = inp.files && inp.files[0];
      if (!f) return;
      if (f.type && f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name||'')) {
        alert('Please pick a PDF file.'); inp.value = ''; return;
      }
      state.pending = f; state.remove = false; _renderSlot();
    });
    _renderSlot();
    var wrap = document.createElement('div');
    wrap.appendChild(slot);
    wrap.appendChild(inp);
    body.appendChild(field(fieldLabel, '', hint));
    body.lastChild.appendChild(wrap);
    return state;
  }
  var _solPdfState = _makeSolPdfBlock(
    'sols', 'Solicitation PDF',
    'pdf_url', 'pdf_filename',
    'Upload the official solicitation document (RFP / RFI / SBIR topic, etc.).'
  );
  var _subPdfState = _makeSolPdfBlock(
    'submissions', 'Our Submission PDF',
    'submission_pdf_url', 'submission_pdf_filename',
    'Upload our final response / proposal PDF, once submitted.'
  );

  openModal({
    title: id ? 'Edit Solicitation · ' + (s.title||s.id) : 'Add Solicitation',
    body, table:'solicitations', id: s.id || '',
    onSave: async () => {
      var _probEl = document.getElementById('f-probability');
      var _prob = _probEl ? Math.max(0, Math.min(100, Math.round(Number(_probEl.value)||0))) : 0;
      // creating, so the storage path is stable. Upload BEFORE DB.upsert so
      // the URL columns land in the same write.
      var _pdfUrl       = _solPdfState.remove ? '' : (s.pdf_url || '');
      var _pdfFilename  = _solPdfState.remove ? '' : (s.pdf_filename || '');
      var _subUrl       = _subPdfState.remove ? '' : (s.submission_pdf_url || '');
      var _subFilename  = _subPdfState.remove ? '' : (s.submission_pdf_filename || '');
      if (_solPdfState.pending || _subPdfState.pending) {
        var _recId = s.id || ('sol_' + Date.now());
        try {
          if (_solPdfState.pending) {
            const up1 = await uploadIntoLettersBucket('sols', _recId, _solPdfState.pending);
            _pdfUrl = up1.url; _pdfFilename = up1.filename;
          }
          if (_subPdfState.pending) {
            const up2 = await uploadIntoLettersBucket('submissions', _recId, _subPdfState.pending);
            _subUrl = up2.url; _subFilename = up2.filename;
          }
          if (!s.id) s.id = _recId;
        } catch (e) {
          alert('PDF upload failed: ' + (e && e.message ? e.message : e));
          return;
        }
      }
      const rec = {
        id: s.id || '',
        title:      document.getElementById('f-title').value.trim(),
        org:        document.getElementById('f-org').value.trim(),
        department: document.getElementById('f-department').value.trim(),
        link:       document.getElementById('f-link').value.trim(),
        officeId:   s.officeId || '',
        value:    Number(document.getElementById('f-value').value) || 0,
        openDate: document.getElementById('f-openDate').value,
        dueDate:  document.getElementById('f-dueDate').value,
        awardDate:document.getElementById('f-awardDate').value,
        type:     document.getElementById('f-type').value,
        phase:    document.getElementById('f-phase').value.trim(),
        status:   document.getElementById('f-status').value,
        alignment:Number(document.getElementById('f-alignment').value) || 0,
        topic:    document.getElementById('f-topic').value.trim(),
        tech: arrField(document.getElementById('f-tech').value),
        products: arrField(document.getElementById('f-products').value),
        contactIds: cMs.get(),
        notes:    document.getElementById('f-notes').value.trim(),
        // generated column server-side and is not written from the client.
        probability_pct: _prob,
        is_priority: !!(document.getElementById('f-isPriority') && document.getElementById('f-isPriority').checked),
        owner:    (document.getElementById('f-owner') ? document.getElementById('f-owner').value.trim() : ''),
        pdf_url:                 _pdfUrl,
        pdf_filename:            _pdfFilename,
        submission_pdf_url:      _subUrl,
        submission_pdf_filename: _subFilename,
      };
      if (!rec.title) { alert('Title is required.'); return; }
      const saved = DB.upsert('solicitations', rec);
      // upsert silently failed on an unknown column, this still lands
      // probability/priority/owner. If it succeeds, this is a redundant
      // (idempotent) write.
      try {
        if (saved && saved.id && typeof _supaUpdate === 'function') {
          _supaUpdate('solicitations', saved.id, {
            probability_pct: rec.probability_pct,
            is_priority:     rec.is_priority,
            owner:           rec.owner,
          }).then(() => {
            if (_lastDbError) {
              alert('Save warning: ' + _lastDbError + '\n\nProbability / priority / owner may not have persisted. Check the browser console for the offending column.');
            }
          });
        }
      } catch (e) {
        console.warn('[v90] partial sol save failed', e);
      }
      closeModal(); refreshAll();
    }
  });
}
document.getElementById('btnAddSol').addEventListener('click', () => editSol(null));
['solSearch','solStatusFilter','solTypeFilter','solOfficeFilter','solPriorityOnly'].forEach(id => { var el = document.getElementById(id); if (el) el.addEventListener('input', renderSols); el && el.addEventListener('change', renderSols); });
attachSorting(document.getElementById('solTable'), 'sols', renderSols);

document.getElementById('btnExportSol').addEventListener('click', () => {
  const headers = ['id','title','link','officeId','officeName','value','openDate','dueDate','awardDate','type','phase','status','alignment','topic','tech','contactIds','notes'];
  const rows = currentTableRows('solTable', DB.list('solicitations')).map(s => Object.assign({}, s, {
    officeName: officeName(s.officeId),
    tech: (s.tech||[]).join('; '),
    contactIds: (s.contactIds||[]).join('; '),
  }));
  downloadFile('solicitations_view.csv', csvFormat(rows, headers));
});
document.getElementById('btnImportSol').addEventListener('click', () => {
  importCsvInto('solicitations', row => ({
    id: row.id || '',
    title: row.title || row.Title || '',
    link: row.link || row['Solicitation Link'] || '',
    officeId: row.officeId || row['Organization'] || '',
    value: moneyParse(row.value || row['Value $'] || row['Value']),
    openDate: row.openDate || row['Open Date'] || '',
    dueDate: row.dueDate || row['Due Date'] || '',
    awardDate: row.awardDate || row['Exp. Award'] || '',
    type: row.type || row.Type || '',
    phase: row.phase || row.Phase || '',
    status: row.status || row.Status || '',
    alignment: intOr(row.alignment || row.Alignment, 0),
    topic: row.topic || row.Topic || '',
    tech: arrField(row.tech || row.Tech || row.Products || ''),
    contactIds: arrField(row.contactIds || row['Key Contacts'] || ''),
    notes: row.notes || row.Notes || '',
  }));
});

// =================================================================
// =================================================================
window.solEstimatedValue = solEstimatedValue;
window.renderSols = renderSols;
window.editSol = editSol;
