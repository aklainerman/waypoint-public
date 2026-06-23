// js/core/utils.js
//
// Shared utility helpers consolidated from the inline monolith in v197.
// First module under js/core/. ~30 helpers spanning six concerns:
//
//   1. Formatters / escapers   fmtMoney, fmtDate, escHtml, svcSlug,
//                               svcBadge, statusPill, alignmentStars
//   2. Chip producers          officeName, officeChip, officeChips,
//                               contactChips, multiBadgeText,
//                               legislatorChipHtml (orphan block,
//                               extracted from ~line 24703)
//   3. Table sort state        SORT_STATE, SORT_DEFAULTS,
//                               SORT_COL_DEFAULT_DIR (file-scope consts,
//                               all module-internal),
//                               paintSortArrows, attachSorting, applySort
//   4. Multi-select widgets    makeMultiSelect, makeSingleSelect
//   5. Modal scaffolding       modalBackdrop / modalEl / modalTitleEl /
//                               modalBodyEl / modalSaveBtn / modalDelBtn
//                               (file-scope DOM consts, all
//                               module-internal), modalCtx (let),
//                               openModal, closeModal, field, fieldRow,
//                               + 6 event wirings at module load
//   6. CSV import/export       csvParse, csvFormat, csvCell, downloadFile,
//                               pickFile, importCsvInto, plus the
//                               numeric helpers arrField, intOr, moneyParse
//
// Plus standalone: fmtBudget (orphan block, extracted from ~line 25515).
//
// Originally at file-scope of the inline monolith; lifted to ES module
// in v197. Same classic-script-split pattern as v181-v196.
//
// Pre-extraction audit (v185 pattern). 24 names need window exposure.
// All other top-level decls in this module are internal-only (callers
// are also inside the module).
//
// External file-scope refs the block consumes:
//   DB                       -- already on window (major global)
//   refreshAll               -- monolith function decl (auto-hoisted);
//                               called by modalDelBtn click handler
//   legislatorById, _legPartyKey, legislatorLabel
//                            -- defined in js/render/contacts.js, each
//                               exposed there via `window.X = X`.
//                               Used at call time by legislatorChipHtml.
//   makeId                   -- monolith function decl (auto-hoisted);
//                               called by importCsvInto callback at
//                               runtime.
//   (no other file-scope const / let consumed -- audit clean)
//
// Six event wirings run at module-load time, all inside Block C
// (modal helpers). They reference modalClose / modalCancel /
// modalBackdrop / modalSaveBtn / modalDelBtn -- all DOM elements that
// exist in the static HTML at line ~5902 by the time defer-ed modules
// execute. Click handlers reference module-local consts (modalCtx etc.)
// or window-exposed functions (refreshAll, DB.remove).

// ---------------------------------------------------------------
//  Helpers — formatting, sorting, chips, query
// ---------------------------------------------------------------
function fmtMoney(n) {
  n = Number(n) || 0;
  if (n === 0) return '—';
  if (n >= 1e9) return '$' + (n/1e9).toFixed(1) + 'B';
  if (n >= 1e6) return '$' + (n/1e6).toFixed(n>=10e6?0:1) + 'M';
  if (n >= 1e3) return '$' + (n/1e3).toFixed(0) + 'K';
  return '$' + n.toLocaleString();
}
function fmtDate(s) {
  if (!s) return '—';
  // Accept YYYY-MM-DD, YYYY-MM, YYYY
  return s.length === 4 ? s : (s.length === 7 ? s : s);
}
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function svcSlug(svc) { return String(svc || 'Other').replace(/\s+/g,'-'); }
function svcBadge(svc) {
  const s = escHtml(svc || '—');
  return '<span class="svc-badge svc-' + svcSlug(svc) + '">' + s + '</span>';
}
function statusPill(status) {
  if (!status) return '<span class="pill">—</span>';
  const slug = String(status).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  return '<span class="pill pill-' + slug + '">' + escHtml(status) + '</span>';
}
function alignmentStars(n) {
  n = Math.max(0, Math.min(5, parseInt(n, 10) || 0));
  let html = '<span class="alignment-stars" title="Alignment ' + n + '/5">';
  for (let i = 1; i <= 5; i++) {
    html += i <= n ? '★' : '<span class="dim">★</span>';
  }
  return html + '</span>';
}
function officeName(id) {
  const o = DB.get('offices', id);
  return o ? o.name : (id || '—');
}
function officeChip(id) {
  if (!id) return '—';
  const o = DB.get('offices', id);
  if (!o) return '<span class="chip">' + escHtml(id) + '</span>';
  return '<a class="chip chip-office" data-office-jump="' + o.id + '">' + escHtml(o.name) + '</a>';
}
function contactChips(ids) {
  if (!ids || !ids.length) return '—';
  return '<span class="chip-list">' + ids.map(id => {
    const c = DB.get('contacts', id);
    if (!c) return '<span class="chip">' + escHtml(id) + '</span>';
    return '<a class="chip chip-contact" data-contact-jump="' + c.id + '">' + escHtml((c.firstName ? c.firstName[0] + '. ' : '') + c.lastName) + '</a>';
  }).join('') + '</span>';
}
function officeChips(ids) {
  if (!ids || !ids.length) return '—';
  return '<span class="chip-list">' + ids.map(id => officeChip(id)).join('') + '</span>';
}
function multiBadgeText(arr) {
  if (!arr || !arr.length) return '—';
  return arr.map(t => '<span class="card-tag">' + escHtml(t) + '</span>').join(' ');
}

// Table sort state per tab.
// Defaults are applied the first time a table's SORT_STATE key is missing —
// new installs start with a sensible default sort order rather than seed order.
const SORT_STATE = {};
const SORT_DEFAULTS = {
  offices:       { col: 'priority', dir: -1 }, // v49: priority rows first by default
  contacts:      { col: 'lastName', dir: 1 },
  solicitations: { col: 'dueDate',  dir: 1 },
  letters:       { col: 'status',   dir: 1 },
  washops:       { col: 'date',     dir: -1 }, // newest first
};
// When a column is missing here, default direction is +1 (ascending).
const SORT_COL_DEFAULT_DIR = {
  offices: {
    priority: -1,
    contacts: -1,
    solicitations: -1,
    los: -1,
    champions: -1,
    contracts: -1,
  },
};
function paintSortArrows(tableEl, col, dir) {
  tableEl.querySelectorAll('thead th').forEach(t => {
    const match = t.dataset.sort === col;
    t.classList.toggle('sorted', match);
    const arrow = t.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = match ? (dir > 0 ? '▲' : '▼') : '';
  });
}
function attachSorting(tableEl, key, render) {
  if (!tableEl) return;
  // Apply default sort state (if any) so the first render is already sorted.
  if (!SORT_STATE[key] && SORT_DEFAULTS[key]) {
    SORT_STATE[key] = Object.assign({}, SORT_DEFAULTS[key]);
  }
  const initial = SORT_STATE[key];
  if (initial && initial.col) paintSortArrows(tableEl, initial.col, initial.dir);

  tableEl.querySelectorAll('thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      const state = SORT_STATE[key] || { col:null, dir:1 };
      if (state.col === col) state.dir = -state.dir;
      else {
        state.col = col;
        const _dfl = (SORT_COL_DEFAULT_DIR[key] || {})[col];
        state.dir = (_dfl === -1 || _dfl === 1) ? _dfl : 1;
      }
      SORT_STATE[key] = state;
      paintSortArrows(tableEl, state.col, state.dir);
      render();
    });
  });
}
function applySort(arr, key, getters) {
  const state = SORT_STATE[key];
  if (!state || !state.col) return arr;
  const get = getters[state.col] || (r => r[state.col]);
  return arr.slice().sort((a,b) => {
    const av = get(a), bv = get(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * state.dir;
    return String(av).localeCompare(String(bv), undefined, { numeric:true, sensitivity:'base' }) * state.dir;
  });
}

// ---------------------------------------------------------------
//  Multi-select chip widget (used in modal forms)
// ---------------------------------------------------------------
function makeMultiSelect(box, options, selected, onChange) {
  // options: [{ id, label }], selected: array of ids
  let current = selected.slice();
  function render() {
    box.innerHTML = '';
    current.forEach(id => {
      const opt = options.find(o => o.id === id);
      if (!opt) return;
      const chip = document.createElement('span');
      chip.className = 'msel-chip';
      chip.innerHTML = escHtml(opt.label) + ' <span class="msel-x">×</span>';
      chip.querySelector('.msel-x').addEventListener('click', () => {
        current = current.filter(i => i !== id);
        render();
        onChange && onChange(current);
      });
      box.appendChild(chip);
    });
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'msel-search'; inp.placeholder = 'Add…';
    box.appendChild(inp);

    let popup = null;
    function showPopup() {
      if (popup) popup.remove();
      popup = document.createElement('div');
      popup.className = 'msel-popup';
      const filter = (inp.value || '').toLowerCase();
      const matches = options.filter(o => !current.includes(o.id) && o.label.toLowerCase().includes(filter)).slice(0, 500);
      if (!matches.length) {
        popup.innerHTML = '<div class="msel-empty">No matches</div>';
      } else {
        matches.forEach(o => {
          const div = document.createElement('div');
          div.className = 'msel-option';
          div.textContent = o.label;
          div.addEventListener('mousedown', (e) => { e.preventDefault(); current.push(o.id); inp.value=''; render(); onChange && onChange(current); });
          popup.appendChild(div);
        });
      }
      const r = inp.getBoundingClientRect();
      popup.style.left = r.left + window.scrollX + 'px';
      popup.style.top  = r.bottom + window.scrollY + 'px';
      popup.style.width = Math.max(220, r.width + 100) + 'px';
      document.body.appendChild(popup);
    }
    inp.addEventListener('focus', showPopup);
    inp.addEventListener('input', showPopup);
    inp.addEventListener('blur', () => setTimeout(() => { if (popup) { popup.remove(); popup = null; } }, 100));
  }
  render();
  return { get: () => current, set: (vals) => { current = vals.slice(); render(); } };
}

function makeSingleSelect(box, options, selectedId, onChange) {
  // options: [{ id, label }], selectedId: string or '' ; mirrors makeMultiSelect UX for a single pick.
  let current = selectedId || '';
  function render() {
    box.innerHTML = '';
    if (current) {
      const opt = options.find(o => o.id === current);
      if (opt) {
        const chip = document.createElement('span');
        chip.className = 'msel-chip';
        chip.innerHTML = escHtml(opt.label) + ' <span class="msel-x">×</span>';
        chip.querySelector('.msel-x').addEventListener('click', () => {
          current = '';
          render();
          onChange && onChange(current);
        });
        box.appendChild(chip);
      }
    }
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'msel-search';
    inp.placeholder = current ? 'Change…' : 'Search…';
    box.appendChild(inp);

    let popup = null;
    function showPopup() {
      if (popup) popup.remove();
      popup = document.createElement('div');
      popup.className = 'msel-popup';
      const filter = (inp.value || '').toLowerCase();
      const matches = options.filter(o => o.id !== current && o.label.toLowerCase().includes(filter)).slice(0, 500);
      if (!matches.length) {
        popup.innerHTML = '<div class="msel-empty">No matches</div>';
      } else {
        matches.forEach(o => {
          const div = document.createElement('div');
          div.className = 'msel-option';
          div.textContent = o.label;
          div.addEventListener('mousedown', (e) => { e.preventDefault(); current = o.id; inp.value=''; render(); onChange && onChange(current); });
          popup.appendChild(div);
        });
      }
      const r = inp.getBoundingClientRect();
      popup.style.left = r.left + window.scrollX + 'px';
      popup.style.top  = r.bottom + window.scrollY + 'px';
      popup.style.width = Math.max(260, r.width + 100) + 'px';
      document.body.appendChild(popup);
    }
    inp.addEventListener('focus', showPopup);
    inp.addEventListener('input', showPopup);
    inp.addEventListener('blur', () => setTimeout(() => { if (popup) { popup.remove(); popup = null; } }, 100));
  }
  render();
  return { get: () => current, set: (val) => { current = val || ''; render(); } };
}

// ---------------------------------------------------------------
//  Modal helpers
// ---------------------------------------------------------------
const modalBackdrop = document.getElementById('modalBackdrop');
const modalEl       = document.getElementById('modal');
const modalTitleEl  = document.getElementById('modalTitle');
const modalBodyEl   = document.getElementById('modalBody');
const modalSaveBtn  = document.getElementById('modalSave');
const modalDelBtn   = document.getElementById('modalDelete');
let modalCtx = null; // { table, id, getRecord }

function openModal(opts) {
  modalCtx = opts;
  modalTitleEl.textContent = opts.title || 'Edit';
  modalBodyEl.innerHTML = '';
  modalBodyEl.appendChild(opts.body);
  modalDelBtn.classList.toggle('hidden', !opts.id);
  modalSaveBtn.textContent = opts.saveLabel || 'Save';
  modalSaveBtn.disabled = false;
  modalBackdrop.classList.add('open');
  setTimeout(() => {
    const first = modalBodyEl.querySelector('input, select, textarea');
    if (first) first.focus();
  }, 50);
}
function closeModal() {
  modalBackdrop.classList.remove('open');
  modalCtx = null;
  modalBodyEl.innerHTML = '';
}
document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalCancel').addEventListener('click', closeModal);
// Click-outside intentionally disabled — users must use the X button to close.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalBackdrop.classList.contains('open')) closeModal();
});
modalSaveBtn.addEventListener('click', () => { if (modalCtx && modalCtx.onSave) modalCtx.onSave(); });
modalDelBtn.addEventListener('click', () => {
  if (!modalCtx || !modalCtx.id || !modalCtx.table) return;
  if (!confirm('Delete this record? This cannot be undone.')) return;
  DB.remove(modalCtx.table, modalCtx.id);
  closeModal();
  refreshAll();
});

function field(label, html, helpText) {
  const div = document.createElement('div');
  div.className = 'field';
  div.innerHTML = '<label>' + escHtml(label) + '</label>' + html + (helpText ? '<div class="help">' + escHtml(helpText) + '</div>' : '');
  return div;
}
function fieldRow(...fields) {
  const div = document.createElement('div'); div.className = 'field-row';
  fields.forEach(f => div.appendChild(f));
  return div;
}

// ---------------------------------------------------------------
//  CSV Import / Export utilities
// ---------------------------------------------------------------
function csvParse(text) {
  // Robust mini-CSV parser supporting quoted fields w/ embedded commas/newlines and "" escapes.
  const rows = []; let cur = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i+1];
    if (inQ) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQ = true; }
      else if (c === ',') { cur.push(field); field=''; }
      else if (c === '\n') { cur.push(field); rows.push(cur); cur=[]; field=''; }
      else if (c === '\r') { /* skip */ }
      else { field += c; }
    }
  }
  if (field !== '' || cur.length) { cur.push(field); rows.push(cur); }
  // Drop empty trailing rows
  while (rows.length && rows[rows.length-1].every(c => c === '')) rows.pop();
  if (!rows.length) return { headers: [], data: [] };
  const headers = rows[0].map(h => h.trim());
  const data = rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h,i) => obj[h] = (r[i] != null ? r[i] : ''));
    return obj;
  });
  return { headers, data };
}
function csvFormat(rows, headers) {
  const lines = [headers.map(csvCell).join(',')];
  rows.forEach(r => lines.push(headers.map(h => csvCell(r[h])).join(',')));
  return lines.join('\n');
}
function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (Array.isArray(v)) s = v.join('; ');
  if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function downloadFile(name, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
}
function pickFile(accept, cb) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = accept;
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => cb(r.result, f.name);
    r.readAsText(f);
  };
  inp.click();
}
function importCsvInto(table, rowMapper) {
  pickFile('.csv,text/csv', (text, name) => {
    try {
      const { data } = csvParse(text);
      let added = 0, updated = 0;
      data.forEach(row => {
        const rec = rowMapper(row);
        if (!rec) return;
        if (rec.id && DB.get(table, rec.id)) { updated++; }
        else { added++; if (!rec.id) rec.id = makeId(table); }
        DB.upsert(table, rec);
      });
      alert('Imported ' + name + ': ' + added + ' added, ' + updated + ' updated.');
      refreshAll();
    } catch (e) { alert('Import failed: ' + e.message); }
  });
}
function arrField(s) { return String(s||'').split(/[,;]\s*/).map(x => x.trim()).filter(Boolean); }
function intOr(v, def) { const n = parseInt(v, 10); return isNaN(n) ? def : n; }
function moneyParse(v) {
  if (v == null || v === '') return 0;
  const s = String(v).trim().replace(/[\$,]/g,'').toLowerCase();
  let mult = 1;
  if (s.endsWith('k')) mult = 1e3;
  else if (s.endsWith('m')) mult = 1e6;
  else if (s.endsWith('b')) mult = 1e9;
  const num = parseFloat(s);
  return isNaN(num) ? 0 : Math.round(num * mult);
}

// ---------------------------------------------------------------


function legislatorChipHtml(bg) {
  if (!bg) return '';
  const m = legislatorById(bg);
  if (!m) return '<span class="leg-chip" title="Linked Hill Member no longer in hill_members">?</span>';
  const honorific = m.chamber === 'senate' ? 'Sen.' : 'Rep.';
  const name = m.last_name || (m.full_name || '').split(/\s+/).slice(-1)[0] || m.bioguide_id;
  const partyKey = _legPartyKey(m.party);
  const stateBit = m.state ? (m.state + (m.district != null && m.district !== '' ? '-' + m.district : '')) : '';
  const tail = stateBit ? ('-' + stateBit) : '';
  return '<span class="leg-chip" data-legislator-jump="' + escHtml(m.bioguide_id) + '" title="' + escHtml(legislatorLabel(m)) + '">'
    + '<span class="leg-party party-' + partyKey + '">' + partyKey + tail + '</span>'
    + escHtml(honorific + ' ' + name)
    + '</span>';
}

// ---------------------------------------------------------------


function fmtBudget(n) {
  n = Number(n) || 0;
  if (Math.abs(n) >= 1e9) return '$' + (n/1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return '$' + (n/1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return '$' + (n/1e3).toFixed(0) + 'K';
  return '$' + n.toFixed(0);
}

// =================================================================
// external caller (in extracted js/** modules or in monolith function
// bodies that execute at runtime after module load) is exposed below.
// Module-internal helpers (svcSlug, officeChip, contactChips,
// multiBadgeText, paintSortArrows, csvCell, SORT_* consts,
// modal* DOM consts, modalCtx) are deliberately NOT exposed.
// =================================================================

// Formatters / escapers (8)
window.fmtMoney = fmtMoney;
window.fmtDate = fmtDate;
window.escHtml = escHtml;
window.svcBadge = svcBadge;
window.statusPill = statusPill;
window.alignmentStars = alignmentStars;
window.officeName = officeName;
window.officeChips = officeChips;

// Table sort (2)
window.attachSorting = attachSorting;
window.applySort = applySort;

// Multi-select widgets (2)
window.makeMultiSelect = makeMultiSelect;
window.makeSingleSelect = makeSingleSelect;

// Modal scaffolding (4)
window.openModal = openModal;
window.closeModal = closeModal;
window.field = field;
window.fieldRow = fieldRow;

// CSV / file (5)
window.csvFormat = csvFormat;
window.csvParse = csvParse;
window.downloadFile = downloadFile;
window.pickFile = pickFile;
window.importCsvInto = importCsvInto;

// Numeric (3)
window.arrField = arrField;
window.intOr = intOr;
window.moneyParse = moneyParse;

// Chips / formatters (orphans)
window.legislatorChipHtml = legislatorChipHtml;
window.fmtBudget = fmtBudget;
