// js/modal/select-helpers.js
//
// offices or fixed enum values. Lifted from index.html lines
// 5974-6001 of post-v227 source.
//
// External callers:
//   js/render/sols.js (selectFromList, selectOfficesHtml, refillOfficeSelect)
//   js/render/lets.js (same)
//   js/render/contacts.js (refillOfficeSelect)
//
// Consumes via window (set by db.js + utils.js):
//   DB.list  -- read offices list
//   escHtml  -- HTML-escape office names

// ---------------------------------------------------------------
//  Helpers (selects + chip jumps)
// ---------------------------------------------------------------
function selectOfficesHtml(id, current) {
  return '<select id="' + id + '"><option value="">(none)</option>' +
    DB.list('offices').map(o => '<option value="' + o.id + '"' + (o.id===current?' selected':'') + '>' + escHtml(o.name + (o.service ? ' · ' + o.service : '')) + '</option>').join('') +
    '</select>';
}
function selectFromList(id, items, current, isPairs) {
  const opts = items.map(it => {
    const v = isPairs ? it[0] : it;
    const lbl = isPairs ? it[1] : it;
    return '<option value="' + escHtml(v) + '"' + (v===current?' selected':'') + '>' + escHtml(lbl||'(blank)') + '</option>';
  }).join('');
  return '<select id="' + id + '">' + opts + '</select>';
}
function refillOfficeSelect(sel, blankLabel, predicate) {
  if (!sel) return;
  const cur = sel.value;
  let offices = DB.list('offices').slice().sort((a,b) => a.name.localeCompare(b.name));
  if (typeof predicate === 'function') offices = offices.filter(predicate);
  sel.innerHTML = '<option value="">' + escHtml(blankLabel) + '</option>' +
    offices.map(o => '<option value="' + o.id + '"' + (o.id===cur?' selected':'') + '>' + escHtml(o.name) + '</option>').join('');
}

window.selectOfficesHtml = selectOfficesHtml;
window.selectFromList = selectFromList;
window.refillOfficeSelect = refillOfficeSelect;
