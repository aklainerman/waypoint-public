// js/render/budget-orgs.js
//
// system). Looks up + renders + searches budget_orgs, the tree of
// DoD organizational units that PEs and SAGs can be tagged to.
//
// Originally at file-scope of the inline monolith; lifted to ES module
// in v194. Same classic-script-split pattern as v181-v193.
//
// Pre-extraction audit (v185 pattern). All five top-level declarations
// have external callers:
//
//   budgetOrgById:        3 monolith refs (lookups in renderOffices,
//                                           dashboard cards, etc.)
//   budgetOrgBreadcrumb:  7 monolith refs (chain text in tooltips +
//                                           badge titles)
//   budgetOrgBadge:       2 monolith refs (renderOffices row inline
//                                           green-check / yellow-warn)
//   budgetOrgSearchScore: 4 monolith refs (used by the picker AND by
//                                           Budget > Tag-Offices fuzzy
//                                           suggestions)
//   makeBudgetOrgPicker:  2 refs in js/modal/office.js (the Office
//                                                       editor modal's
//                                                       "Pick budget
//                                                       org" widget)
//
// Without makeBudgetOrgPicker exposure, the Office editor's tagging
// widget would silently fail -- the audit caught this cross-module
// dependency.
//
// Consumes from window (monolith + earlier modules):
//   DB, escHtml, escAttr, openModal, closeModal,
//   and other monolith file-scope helpers.

// ============================================================
// ============================================================
//   budgetOrgById(id)         -> org row or null
//   budgetOrgBreadcrumb(id)   -> "AFMC -> AFRL -> Munitions Directorate"
//   budgetOrgBadge(o)         -> tiny inline HTML span: green check or yellow warn
//   budgetOrgSearchScore(o,q) -> 0..1 fuzzy score across name + aliases
//   makeBudgetOrgPicker(box, selectedId, onChange)  -> { get, set } widget
function budgetOrgById(id) {
  if (!id) return null;
  return (DB.list('budget_orgs') || []).find(function(x){ return x.id === id; }) || null;
}
function budgetOrgBreadcrumb(id, opts) {
  opts = opts || {};
  var sep = opts.sep || ' \u203A ';
  var maxLen = opts.maxLen || 0;
  var chain = [];
  var seen = {};
  var cur = budgetOrgById(id);
  var hops = 0;
  while (cur && !seen[cur.id] && hops < 12) {
    seen[cur.id] = 1;
    chain.unshift(cur.name || cur.id);
    cur = cur.parent_id ? budgetOrgById(cur.parent_id) : null;
    hops++;
  }
  if (opts.array) return chain;
  var s = chain.join(sep);
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen - 1) + '\u2026';
  return s;
}
function budgetOrgBadge(o, opts) {
  opts = opts || {};
  var size = opts.size || 11;
  var hasOrgs = (DB.list('budget_orgs') || []).length > 0;
  if (!hasOrgs) return '';
  var tagged = !!(o && o.budget_org_id);
  // and not tagged, suppress the badge entirely (no check, no exclamation).
  var isSkipped = !tagged && o && Array.isArray(o.tags) && o.tags.indexOf('budget-skipped') >= 0;
  // with explicit PE attribution (but no budget_org tree map) don't show warning.
  var hasDirectLinks = false;
  if (!tagged && o) {
    var _polLinks = (DB.list && DB.list('pe_office_links')) || [];
    for (var _li = 0; _li < _polLinks.length; _li++) {
      var _l = _polLinks[_li];
      if (_l && _l.office_id === o.id &&
          (_l.source === 'manual' || _l.source === 'jbook_title')) {
        hasDirectLinks = true;
        break;
      }
    }
  }
  if (isSkipped && !hasDirectLinks) return '';
  if (tagged) {
    var bo = budgetOrgById(o.budget_org_id);
    var tip = bo ? ('Tagged: ' + budgetOrgBreadcrumb(bo.id)) : 'Tagged to budget org';
    return '<span class="budget-tag-badge tagged" title="' + escAttr(tip) + '" '
         + 'style="display:inline-flex;align-items:center;justify-content:center;'
         + 'width:' + (size+5) + 'px;height:' + (size+5) + 'px;border-radius:50%;'
         + 'background:rgba(76,175,80,0.15);color:#4caf50;font-size:' + size + 'px;'
         + 'margin-left:4px;vertical-align:middle;font-weight:700;line-height:1;">'
         + '\u2713</span>';
  }
  if (hasDirectLinks) {
    return '<span class="budget-tag-badge tagged" title="Linked via direct PE attribution (manual/jbook)" '
         + 'style="display:inline-flex;align-items:center;justify-content:center;'
         + 'width:' + (size+5) + 'px;height:' + (size+5) + 'px;border-radius:50%;'
         + 'background:rgba(76,175,80,0.15);color:#4caf50;font-size:' + size + 'px;'
         + 'margin-left:4px;vertical-align:middle;font-weight:700;line-height:1;">'
         + '\u2713</span>';
  }
  return '<span class="budget-tag-badge untagged" title="Not tagged to a DoD budget org" '
       + 'style="display:inline-flex;align-items:center;justify-content:center;'
       + 'width:' + (size+5) + 'px;height:' + (size+5) + 'px;border-radius:50%;'
       + 'background:rgba(255,193,7,0.15);color:#ffb300;font-size:' + size + 'px;'
       + 'margin-left:4px;vertical-align:middle;font-weight:700;line-height:1;">'
       + '!</span>';
}
function budgetOrgSearchScore(o, q) {
  if (!q) return 1;
  var ql = q.toLowerCase();
  var name = (o.name || '').toLowerCase();
  var id = (o.id || '').toLowerCase();
  if (name === ql || id === ql) return 1000;
  if (name.startsWith(ql)) return 500;
  if (id.startsWith(ql)) return 480;
  var aliases = Array.isArray(o.aliases) ? o.aliases : [];
  var aliasMatch = 0;
  for (var i = 0; i < aliases.length; i++) {
    var a = String(aliases[i] || '').toLowerCase();
    if (!a) continue;
    if (a === ql) { aliasMatch = Math.max(aliasMatch, 460); break; }
    if (a.startsWith(ql)) aliasMatch = Math.max(aliasMatch, 360);
    else if (a.indexOf(ql) >= 0) aliasMatch = Math.max(aliasMatch, 220);
  }
  if (aliasMatch) return aliasMatch;
  if (name.indexOf(ql) >= 0) return 240;
  if (id.indexOf(ql) >= 0) return 200;
  var bc = (budgetOrgBreadcrumb(o.id) || '').toLowerCase();
  if (bc.indexOf(ql) >= 0) return 100;
  return 0;
}
function makeBudgetOrgPicker(box, selectedId, onChange) {
  var current = selectedId || '';
  function render() {
    box.innerHTML = '';
    if (current) {
      var picked = budgetOrgById(current);
      var label = picked ? (picked.name || picked.id) : current;
      var bc = picked ? budgetOrgBreadcrumb(current, { maxLen: 80 }) : '';
      var chip = document.createElement('span');
      chip.className = 'msel-chip';
      chip.style.cssText = 'display:inline-flex;flex-direction:column;align-items:flex-start;gap:1px;';
      chip.innerHTML = '<span style="font-weight:600;">' + escHtml(label)
                     + ' <span class="msel-x" style="cursor:pointer;margin-left:6px;">\u00d7</span></span>'
                     + (bc && bc !== label
                        ? '<span style="font-size:10px;color:var(--text-dim);font-weight:400;">' + escHtml(bc) + '</span>'
                        : '');
      chip.querySelector('.msel-x').addEventListener('click', function(){
        current = '';
        render();
        onChange && onChange(current);
      });
      box.appendChild(chip);
    }
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'msel-search';
    inp.placeholder = current ? 'Change\u2026' : 'Search budget orgs \u2014 or click the tree button to browse\u2026';
    box.appendChild(inp);
    var treeBtn = document.createElement('button');
    treeBtn.type = 'button';
    treeBtn.className = 'budget-org-tree-toggle';
    treeBtn.title = 'Browse tree';
    treeBtn.innerHTML = '\u29C9';
    treeBtn.style.cssText = 'margin-left:6px;padding:4px 8px;background:var(--surface-2);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:13px;color:var(--text);';
    box.appendChild(treeBtn);
    var popup = null;
    var treeMode = false;
    function showPopup() {
      if (popup) popup.remove();
      popup = document.createElement('div');
      popup.className = 'msel-popup';
      var orgs = DB.list('budget_orgs') || [];
      if (!orgs.length) {
        popup.innerHTML = '<div class="msel-empty" style="padding:12px;color:var(--text-dim);">'
                        + 'No budget orgs loaded. Apply v56-seed-af-orgs.sql first.</div>';
      } else {
        var query = (inp.value || '').trim();
        if (treeMode && !query) {
          // ----- Tree browse mode -----
          var byParent = {};
          orgs.forEach(function(o){
            var p = o.parent_id || '__root__';
            (byParent[p] = byParent[p] || []).push(o);
          });
          Object.keys(byParent).forEach(function(k){
            byParent[k].sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); });
          });
          var expanded = {};
          // Pre-expand the chain to current selection, if any.
          if (current) {
            var c = budgetOrgById(current);
            while (c) { expanded[c.id] = 1; c = c.parent_id ? budgetOrgById(c.parent_id) : null; }
          } else {
            (byParent.__root__ || []).forEach(function(r){ expanded[r.id] = 1; });
          }
          function renderTreeNode(o, depth) {
            var kids = byParent[o.id] || [];
            var hasKids = kids.length > 0;
            var open = !!expanded[o.id];
            var chev = hasKids ? (open ? '\u25BC' : '\u25B6') : '\u2022';
            var row = document.createElement('div');
            row.className = 'msel-option budget-tree-row';
            row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;padding-left:' + (8 + depth * 14) + 'px;cursor:pointer;border-bottom:1px dashed transparent;';
            var chevSpan = document.createElement('span');
            chevSpan.style.cssText = 'display:inline-block;width:14px;text-align:center;color:var(--text-muted);font-size:9px;cursor:pointer;flex-shrink:0;';
            chevSpan.textContent = chev;
            chevSpan.addEventListener('mousedown', function(e){
              if (!hasKids) return;
              e.preventDefault(); e.stopPropagation();
              expanded[o.id] = !expanded[o.id];
              showPopup();
            });
            row.appendChild(chevSpan);
            var label = document.createElement('span');
            label.style.cssText = 'flex:1;min-width:0;font-size:12px;' + (current === o.id ? 'font-weight:700;color:var(--accent);' : '');
            label.innerHTML = '<span>' + escHtml(o.name || o.id) + '</span>'
                            + ' <span style="font-size:10px;color:var(--text-dim);">(' + escHtml(o.id) + ')</span>';
            row.appendChild(label);
            row.addEventListener('mousedown', function(e){
              e.preventDefault();
              current = o.id;
              inp.value = '';
              render();
              onChange && onChange(current);
            });
            popup.appendChild(row);
            if (hasKids && open) {
              kids.forEach(function(k){ renderTreeNode(k, depth + 1); });
            }
          }
          var roots = byParent.__root__ || [];
          if (!roots.length) {
            popup.innerHTML = '<div class="msel-empty" style="padding:12px;color:var(--text-dim);">No root orgs found.</div>';
          } else {
            roots.forEach(function(r){ renderTreeNode(r, 0); });
          }
        } else {
          // ----- Search mode -----
          var scored = orgs.filter(function(o){ return o.id !== current; })
                           .map(function(o){ return { o: o, score: budgetOrgSearchScore(o, query) }; })
                           .filter(function(x){ return x.score > 0; })
                           .sort(function(a, b){
                             if (b.score !== a.score) return b.score - a.score;
                             return (a.o.name || '').localeCompare(b.o.name || '');
                           })
                           .slice(0, 60);
          if (!scored.length) {
            popup.innerHTML = '<div class="msel-empty" style="padding:12px;color:var(--text-dim);">No matching budget orgs.</div>';
          } else {
            scored.forEach(function(x){
              var o = x.o;
              var bc = budgetOrgBreadcrumb(o.id, { maxLen: 80 });
              var div = document.createElement('div');
              div.className = 'msel-option';
              div.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;padding:6px 10px;';
              div.innerHTML = '<span style="font-weight:600;">' + escHtml(o.name || o.id) + '</span>'
                            + (bc && bc !== (o.name || o.id)
                               ? '<span style="font-size:10px;color:var(--text-dim);">' + escHtml(bc) + '</span>'
                               : '');
              div.addEventListener('mousedown', function(e){
                e.preventDefault();
                current = o.id;
                inp.value = '';
                render();
                onChange && onChange(current);
              });
              popup.appendChild(div);
            });
          }
        }
      }
      var r = inp.getBoundingClientRect();
      popup.style.left  = r.left + window.scrollX + 'px';
      popup.style.top   = r.bottom + window.scrollY + 'px';
      popup.style.width = Math.max(360, r.width + 100) + 'px';
      document.body.appendChild(popup);
    }
    inp.addEventListener('focus', showPopup);
    inp.addEventListener('input', function(){ treeMode = false; showPopup(); });
    inp.addEventListener('blur', function(){
      setTimeout(function(){ if (popup) { popup.remove(); popup = null; } }, 200);
    });
    treeBtn.addEventListener('mousedown', function(e){
      e.preventDefault();
      treeMode = !treeMode;
      treeBtn.style.background = treeMode ? 'var(--accent)' : 'var(--surface-2)';
      treeBtn.style.color = treeMode ? '#fff' : 'var(--text)';
      inp.focus();
      showPopup();
    });
  }
  render();
  return { get: function(){ return current; }, set: function(v){ current = v || ''; render(); } };
}


// =================================================================
// =================================================================
window.budgetOrgById = budgetOrgById;
window.budgetOrgBreadcrumb = budgetOrgBreadcrumb;
window.budgetOrgBadge = budgetOrgBadge;
window.budgetOrgSearchScore = budgetOrgSearchScore;
window.makeBudgetOrgPicker = makeBudgetOrgPicker;
