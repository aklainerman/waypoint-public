// js/render/priority-flags.js
//
// functions originally co-located in an inline-script block in the
// monolith. Each one is a reader (is*Priority) or an optimistic
// toggle (toggle*Priority) over the boolean is_priority column on
// budget_pes / budget_om_sags / solicitations.
//
// Originally at file-scope of the inline monolith; lifted to ES
// module in v210. Same classic-script-split pattern as v181-v209.
//
// Pre-extraction audit (v185 pattern). All 6 names externally
// referenced; all 6 exposed in footer:
//   isPePriority      -- 2 sites (index.html + sols.js)
//   isSagPriority     -- 2 sites (index.html + sols.js)
//   isSolPriority     -- 3 sites (index.html + sols.js)
//   togglePePriority  -- 4 sites (index.html + budget-tree.js + sols.js)
//   toggleSagPriority -- 4 sites (index.html + budget-tree.js + sols.js)
//   toggleSolPriority -- 4 sites (index.html + sols.js)
//
// External file-scope refs consumed (all resolve at call time via
// globalThis lookup, not module-load time):
//   DB                          (window global)
//   _supaUpdate                 (classic-script helper; auto-hoisted)
//   renderBudget                (js/render/budget-tree.js; window-
//                                hooked by v153 narrative-fill wrapper)
//   renderSols, renderSolKanban (js/render/sols.js; on window via v192)
//   document                    (browser global)
//
// No body rewrites needed; no self-recursive calls (no priority
// toggle calls itself).

// All three tables share the same shape: boolean is_priority column with
// default false. We mirror the change locally on DB.state so the UI updates
// before the Supabase round-trip resolves.
function isPePriority(peId) {
  var p = (typeof DB !== 'undefined' && DB.get) ? DB.get('budget_pes', peId) : null;
  return !!(p && p.is_priority);
}
function isSagPriority(sagId) {
  var s = (typeof DB !== 'undefined' && DB.get) ? DB.get('budget_om_sags', sagId) : null;
  return !!(s && s.is_priority);
}
function isSolPriority(solId) {
  var x = (typeof DB !== 'undefined' && DB.get) ? DB.get('solicitations', solId) : null;
  return !!(x && x.is_priority);
}
async function togglePePriority(peId) {
  var rec = DB.get('budget_pes', peId); if (!rec) return;
  var next = !rec.is_priority;
  rec.is_priority = next;                       // optimistic local
  await _supaUpdate('budget_pes', peId, { is_priority: next });
  if (typeof renderBudget === 'function') renderBudget();
}
async function toggleSagPriority(sagId) {
  var rec = DB.get('budget_om_sags', sagId); if (!rec) return;
  var next = !rec.is_priority;
  rec.is_priority = next;
  await _supaUpdate('budget_om_sags', sagId, { is_priority: next });
  if (typeof renderBudget === 'function') renderBudget();
}
async function toggleSolPriority(solId) {
  var rec = DB.get('solicitations', solId); if (!rec) return;
  var next = !rec.is_priority;
  rec.is_priority = next;
  await _supaUpdate('solicitations', solId, { is_priority: next });
  if (typeof renderSols === 'function') renderSols();
  if (typeof renderSolKanban === 'function') {
    var kw = document.getElementById('solKanbanWrap');
    if (kw && kw.offsetParent !== null) renderSolKanban();
  }
}

// =================================================================
// in index.html and/or already-extracted modules (budget-tree.js,
// sols.js).
// =================================================================
window.isPePriority = isPePriority;
window.isSagPriority = isSagPriority;
window.isSolPriority = isSolPriority;
window.togglePePriority = togglePePriority;
window.toggleSagPriority = toggleSagPriority;
window.toggleSolPriority = toggleSolPriority;
