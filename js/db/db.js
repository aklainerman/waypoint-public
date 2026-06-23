// js/db/db.js
//
// of post-v222 source (the head of classic-script block #2).
//
// Contents:
//   * Pending-write tracking (_pendingWrites, _lastDbError, _bumpPending)
//   * Supabase write helpers (_supaUpsert/_supaUpdate/_supaDelete/
//                             _supaDeleteComposite)
//   * PE <-> Office link helpers (6 functions)
//   * SAG <-> Office link helpers (6 functions)
//   * DB module (DB.state / DB.load / DB.replaceAll / DB.list /
//                DB.upsert / DB.delete / DB.partialUpdate)
//   * makeId, updateSaveStatus
//
// External refs consumed (resolved via realm-shared Global Lexical
// Environment from classic script, until they get extracted too):
//   _sb               -- Supabase client (let in classic script)
//   SEED_DATA         -- now window.SEED_DATA (v222)
//   TABLES            -- (let in classic script)
//   _applyDemoMode    -- (function in classic script; gets called only
//                        via _initSupabase, indirect dependency only)
//
// Window exposures: 22 entries at module foot, one per top-level decl.

// Pending-write tracking so the save-status indicator can show "Saving…".
let _pendingWrites = 0;
let _lastDbError = null;
function _bumpPending(delta) {
  _pendingWrites = Math.max(0, _pendingWrites + delta);
  updateSaveStatus();
}
async function _supaUpsert(table, rec, opts) {
  // tell PostgREST which columns to use for conflict detection. Without
  // this, upsert silently fails on tables that have no `id` column.
  opts = opts || {};
  _bumpPending(+1);
  try {
    let res;
    if (opts.onConflict) {
      res = await _sb.from(table).upsert(rec, { onConflict: opts.onConflict });
    } else {
      res = await _sb.from(table).upsert(rec);
    }
    if (res.error) throw res.error;
    _lastDbError = null;
  } catch (e) {
    console.error('[Supabase] upsert failed', table, rec && (rec.id || JSON.stringify(rec).slice(0,80)), e);
    _lastDbError = (e && e.message) || String(e);
  } finally {
    _bumpPending(-1);
  }
}
// toggling boolean flags (is_priority, etc.) without nulling other columns.
async function _supaUpdate(table, id, fields) {
  if (!_sb || !id || !fields) return;
  _bumpPending(+1);
  try {
    const { error } = await _sb.from(table).update(fields).eq('id', id);
    if (error) throw error;
    _lastDbError = null;
  } catch (e) {
    console.error('[Supabase] update failed', table, id, fields, e);
    _lastDbError = (e && e.message) || String(e);
  } finally {
    _bumpPending(-1);
  }
}
async function _supaDelete(table, id) {
  _bumpPending(+1);
  try {
    const { error } = await _sb.from(table).delete().eq('id', id);
    if (error) throw error;
    _lastDbError = null;
  } catch (e) {
    console.error('[Supabase] delete failed', table, id, e);
    _lastDbError = (e && e.message) || String(e);
  } finally {
    _bumpPending(-1);
  }
}

// pe_office_links / pe_office_link_dismissals use a (pe_id, office_id) composite PK,
// so the standard _supaDelete (which filters by `id`) doesn't apply.
async function _supaDeleteComposite(table, match) {
  _bumpPending(+1);
  try {
    let q = _sb.from(table).delete();
    Object.keys(match).forEach(function(k){ q = q.eq(k, match[k]); });
    const { error } = await q;
    if (error) throw error;
    _lastDbError = null;
  } catch (e) {
    console.error('[Supabase] delete failed', table, match, e);
    _lastDbError = (e && e.message) || String(e);
  } finally {
    _bumpPending(-1);
  }
}

// Resolve all offices linked to a PE (excluding dismissed links).
function getOfficesForPe(peId) {
  if (!peId) return [];
  var dismissed = new Set();
  ((DB.list && DB.list('pe_office_link_dismissals')) || []).forEach(function(d){
    if (d && d.pe_id === peId && d.office_id) dismissed.add(d.office_id);
  });
  var links = ((DB.list && DB.list('pe_office_links')) || []).filter(function(l){
    return l && l.pe_id === peId && !dismissed.has(l.office_id);
  });
  // Decorate with office info for rendering.
  return links.map(function(l){
    var o = DB.get('offices', l.office_id);
    return { pe_id: l.pe_id, office_id: l.office_id, link_type: l.link_type || 'primary',
             source: l.source || 'manual', notes: l.notes || '',
             officeName: (o && (o.name || o.id)) || l.office_id,
             officeService: (o && o.service) || '' };
  }).sort(function(a, b){ return a.officeName.localeCompare(b.officeName); });
}

// Get pe_office_suggestions for a PE that aren't already linked or dismissed.
function getSuggestionsForPe(peId) {
  if (!peId) return [];
  var linked = new Set();
  ((DB.list && DB.list('pe_office_links')) || []).forEach(function(l){
    if (l && l.pe_id === peId && l.office_id) linked.add(l.office_id);
  });
  var dismissed = new Set();
  ((DB.list && DB.list('pe_office_link_dismissals')) || []).forEach(function(d){
    if (d && d.pe_id === peId && d.office_id) dismissed.add(d.office_id);
  });
  var suggs = ((DB.list && DB.list('pe_office_suggestions')) || []).filter(function(s){
    return s && s.pe_id === peId && !linked.has(s.office_id) && !dismissed.has(s.office_id);
  });
  // Group by office (one suggestion row per office, taking strongest match_kind).
  var byOffice = {};
  var rank = { title: 3, description: 2, project: 1 };
  suggs.forEach(function(s){
    var cur = byOffice[s.office_id];
    if (!cur || (rank[s.match_kind] || 0) > (rank[cur.match_kind] || 0)) {
      byOffice[s.office_id] = s;
    }
  });
  return Object.values(byOffice).map(function(s){
    var o = DB.get('offices', s.office_id);
    return { pe_id: s.pe_id, office_id: s.office_id, match_kind: s.match_kind,
             matched: s.matched || '', confidence: s.confidence || 0,
             officeName: (o && (o.name || o.id)) || s.office_id,
             officeService: (o && o.service) || '' };
  }).sort(function(a, b){
    var ra = rank[a.match_kind] || 0, rb = rank[b.match_kind] || 0;
    if (rb !== ra) return rb - ra;
    return a.officeName.localeCompare(b.officeName);
  });
}

// Get pe_office_suggestions for an OFFICE (inverse of above).
function getSuggestionsForOffice(officeId) {
  if (!officeId) return [];
  var linked = new Set();
  ((DB.list && DB.list('pe_office_links')) || []).forEach(function(l){
    if (l && l.office_id === officeId && l.pe_id) linked.add(l.pe_id);
  });
  var dismissed = new Set();
  ((DB.list && DB.list('pe_office_link_dismissals')) || []).forEach(function(d){
    if (d && d.office_id === officeId && d.pe_id) dismissed.add(d.pe_id);
  });
  var pesById = {};
  ((DB.list && DB.list('budget_pes')) || []).forEach(function(p){ if (p && p.id) pesById[p.id] = p; });
  var suggs = ((DB.list && DB.list('pe_office_suggestions')) || []).filter(function(s){
    return s && s.office_id === officeId && !linked.has(s.pe_id) && !dismissed.has(s.pe_id);
  });
  var byPe = {};
  var rank = { title: 3, description: 2, project: 1 };
  suggs.forEach(function(s){
    var cur = byPe[s.pe_id];
    if (!cur || (rank[s.match_kind] || 0) > (rank[cur.match_kind] || 0)) byPe[s.pe_id] = s;
  });
  return Object.values(byPe).map(function(s){
    var p = pesById[s.pe_id] || {};
    return { pe_id: s.pe_id, office_id: s.office_id, match_kind: s.match_kind,
             matched: s.matched || '', confidence: s.confidence || 0,
             peTitle: p.title || s.pe_id, peFy26: p.request_amount || 0 };
  }).sort(function(a, b){
    var ra = rank[a.match_kind] || 0, rb = rank[b.match_kind] || 0;
    if (rb !== ra) return rb - ra;
    return (b.peFy26 || 0) - (a.peFy26 || 0);
  });
}

// Write helpers — all idempotent and update local DB.state in-place so the UI
// re-renders immediately without waiting for a Supabase round-trip.
async function linkPeToOffice(peId, officeId, opts) {
  if (!peId || !officeId) return;
  opts = opts || {};
  var rec = { pe_id: peId, office_id: officeId,
              link_type: opts.link_type || 'primary',
              source: opts.source || 'manual',
              notes: opts.notes || null };
  var arr = DB.state.pe_office_links;
  var idx = arr.findIndex(function(l){ return l.pe_id === peId && l.office_id === officeId; });
  if (idx >= 0) arr[idx] = Object.assign({}, arr[idx], rec); else arr.push(rec);
  // Removing any matching dismissal so the link is now visible.
  var darr = DB.state.pe_office_link_dismissals;
  var didx = darr.findIndex(function(d){ return d.pe_id === peId && d.office_id === officeId; });
  if (didx >= 0) darr.splice(didx, 1);
  await _supaUpsert('pe_office_links', rec, { onConflict: 'pe_id,office_id' });
  await _supaDeleteComposite('pe_office_link_dismissals', { pe_id: peId, office_id: officeId });
}

async function unlinkPeFromOffice(peId, officeId) {
  if (!peId || !officeId) return;
  var arr = DB.state.pe_office_links;
  var idx = arr.findIndex(function(l){ return l.pe_id === peId && l.office_id === officeId; });
  if (idx >= 0) arr.splice(idx, 1);
  await _supaDeleteComposite('pe_office_links', { pe_id: peId, office_id: officeId });
}

async function dismissPeOfficeSuggestion(peId, officeId) {
  if (!peId || !officeId) return;
  var rec = { pe_id: peId, office_id: officeId, notes: 'dismissed in UI' };
  var arr = DB.state.pe_office_link_dismissals;
  var idx = arr.findIndex(function(d){ return d.pe_id === peId && d.office_id === officeId; });
  if (idx >= 0) arr[idx] = Object.assign({}, arr[idx], rec); else arr.push(rec);
  await _supaUpsert('pe_office_link_dismissals', rec, { onConflict: 'pe_id,office_id' });
}


// Used by the O&M section in the office side panel.

function getSagsForOffice(officeId) {
  if (!officeId) return [];
  var dismissed = new Set();
  ((DB.list && DB.list('sag_office_link_dismissals')) || []).forEach(function(d){
    if (d && d.office_id === officeId && d.sag_id) dismissed.add(d.sag_id);
  });
  var sagsById = {};
  ((DB.list && DB.list('budget_om_sags')) || []).forEach(function(s){ if (s && s.id) sagsById[s.id] = s; });
  var links = ((DB.list && DB.list('sag_office_links')) || []).filter(function(l){
    return l && l.office_id === officeId && !dismissed.has(l.sag_id);
  });
  return links.map(function(l){
    var s = sagsById[l.sag_id] || {};
    return { sag_id: l.sag_id, office_id: l.office_id,
             link_type: l.link_type || 'primary', source: l.source || 'manual', notes: l.notes || '',
             sagTitle: s.sag_title || l.sag_id,
             sagShortCode: s.sag_short_code || '',
             sagOrg: s.defense_wide_org || '',
             sagFy26: (window._v150SagAmt ? window._v150SagAmt(s) : (Number(s.fy26_estimate) || 0)),
             sagAppr: s.appropriation_id || '',
             sagBudgetActivity: s.budget_activity || '' };
  }).sort(function(a, b){ return (b.sagFy26 || 0) - (a.sagFy26 || 0); });
}

function getOfficesForSag(sagId) {
  if (!sagId) return [];
  var dismissed = new Set();
  ((DB.list && DB.list('sag_office_link_dismissals')) || []).forEach(function(d){
    if (d && d.sag_id === sagId && d.office_id) dismissed.add(d.office_id);
  });
  var links = ((DB.list && DB.list('sag_office_links')) || []).filter(function(l){
    return l && l.sag_id === sagId && !dismissed.has(l.office_id);
  });
  return links.map(function(l){
    var o = DB.get('offices', l.office_id);
    return { sag_id: l.sag_id, office_id: l.office_id,
             link_type: l.link_type || 'primary', source: l.source || 'manual',
             notes: l.notes || '',
             officeName: (o && (o.name || o.id)) || l.office_id,
             officeService: (o && o.service) || '' };
  }).sort(function(a, b){ return a.officeName.localeCompare(b.officeName); });
}

function getSagSuggestionsForOffice(officeId) {
  if (!officeId) return [];
  var linked = new Set();
  ((DB.list && DB.list('sag_office_links')) || []).forEach(function(l){
    if (l && l.office_id === officeId && l.sag_id) linked.add(l.sag_id);
  });
  var dismissed = new Set();
  ((DB.list && DB.list('sag_office_link_dismissals')) || []).forEach(function(d){
    if (d && d.office_id === officeId && d.sag_id) dismissed.add(d.sag_id);
  });
  var sagsById = {};
  ((DB.list && DB.list('budget_om_sags')) || []).forEach(function(s){ if (s && s.id) sagsById[s.id] = s; });
  var suggs = ((DB.list && DB.list('sag_office_suggestions')) || []).filter(function(s){
    return s && s.office_id === officeId && !linked.has(s.sag_id) && !dismissed.has(s.sag_id);
  });
  var bySag = {};
  var rank = { title: 4, description: 3, sub_narrative: 2, org_alias: 1 };
  suggs.forEach(function(s){
    var cur = bySag[s.sag_id];
    if (!cur || (rank[s.match_kind] || 0) > (rank[cur.match_kind] || 0)) bySag[s.sag_id] = s;
  });
  return Object.values(bySag).map(function(s){
    var rec = sagsById[s.sag_id] || {};
    return { sag_id: s.sag_id, office_id: s.office_id, match_kind: s.match_kind,
             matched: s.matched || '', confidence: s.confidence || 0,
             sagTitle: rec.sag_title || s.sag_id,
             sagOrg: rec.defense_wide_org || '',
             sagFy26: (window._v150SagAmt ? window._v150SagAmt(rec) : (Number(rec.fy26_estimate) || 0)) };
  }).sort(function(a, b){
    var ra = rank[a.match_kind] || 0, rb = rank[b.match_kind] || 0;
    if (rb !== ra) return rb - ra;
    return (b.sagFy26 || 0) - (a.sagFy26 || 0);
  });
}

async function linkSagToOffice(sagId, officeId, opts) {
  if (!sagId || !officeId) return;
  opts = opts || {};
  var rec = { sag_id: sagId, office_id: officeId,
              link_type: opts.link_type || 'primary',
              source: opts.source || 'manual',
              notes: opts.notes || null };
  var arr = DB.state.sag_office_links;
  var idx = arr.findIndex(function(l){ return l.sag_id === sagId && l.office_id === officeId; });
  if (idx >= 0) arr[idx] = Object.assign({}, arr[idx], rec); else arr.push(rec);
  var darr = DB.state.sag_office_link_dismissals;
  var didx = darr.findIndex(function(d){ return d.sag_id === sagId && d.office_id === officeId; });
  if (didx >= 0) darr.splice(didx, 1);
  await _supaUpsert('sag_office_links', rec, { onConflict: 'sag_id,office_id' });
  await _supaDeleteComposite('sag_office_link_dismissals', { sag_id: sagId, office_id: officeId });
}

async function unlinkSagFromOffice(sagId, officeId) {
  if (!sagId || !officeId) return;
  var arr = DB.state.sag_office_links;
  var idx = arr.findIndex(function(l){ return l.sag_id === sagId && l.office_id === officeId; });
  if (idx >= 0) arr.splice(idx, 1);
  await _supaDeleteComposite('sag_office_links', { sag_id: sagId, office_id: officeId });
}

async function dismissSagOfficeSuggestion(sagId, officeId) {
  if (!sagId || !officeId) return;
  var rec = { sag_id: sagId, office_id: officeId, notes: 'dismissed in UI' };
  var arr = DB.state.sag_office_link_dismissals;
  var idx = arr.findIndex(function(d){ return d.sag_id === sagId && d.office_id === officeId; });
  if (idx >= 0) arr[idx] = Object.assign({}, arr[idx], rec); else arr.push(rec);
  await _supaUpsert('sag_office_link_dismissals', rec, { onConflict: 'sag_id,office_id' });
}



const DB = {
  state: { offices:[], contacts:[], solicitations:[], letters:[], washops:[], requests:[], budget_orgs:[], budget_appropriations:[], budget_pes:[], budget_projects:[], pe_office_links:[], pe_office_link_dismissals:[], pe_office_suggestions:[], budget_om_sags:[], sag_office_links:[], sag_office_link_dismissals:[], sag_office_suggestions:[], engagements:[], lastSaved:null },

  // Fetch all tables from Supabase. If every table is empty, seed on first use.
  // before the v58 migration is run) does NOT break boot.
  //
  // tables (offices/contacts/sols/letters/hill_*) so Mission Control's KPI
  // strip can paint before the multi-MB budget payload is fetched.  Phase
  // 'budget' loads the budget_* tables.  Phase 'all' (default) loads both
  // and preserves the old behavior for replaceAll/reset/test callers.
  async load(opts) {
    opts = opts || {};
    const phase = opts.phase || 'all';
    const BUDGET_SET = new Set(['budget_orgs','budget_appropriations','budget_pes','budget_projects','pe_office_links','pe_office_link_dismissals','pe_office_suggestions','budget_om_sags','budget_topline_lines','sag_office_links','sag_office_link_dismissals','sag_office_suggestions']);
    const tablesToLoad = TABLES.filter(function (t) {
      if (phase === 'fast')   return !BUDGET_SET.has(t);
      if (phase === 'budget') return  BUDGET_SET.has(t);
      return true; // 'all'
    });
    // tables that exceed the cap (pe_office_links after rollup seeds, anything
    // that grows organically) silently drop rows past the first 1000.
    const PAGE = 1000;
    async function _fetchAll(table) {
      let all = [];
      for (let start = 0; ; start += PAGE) {
        const end = start + PAGE - 1;
        const { data, error } = await _sb.from(table).select('*').range(start, end);
        if (error) return { error };
        const batch = data || [];
        all = all.concat(batch);
        if (batch.length < PAGE) break;     // last page
        if (start > 200000) break;          // safety: cap at 201k rows
      }
      return { data: all };
    }
    const results = await Promise.all(tablesToLoad.map(t =>
      _fetchAll(t).then(r => ({ t, r })).catch(err => ({ t, r: { error: err } }))
    ));
    let total = 0;
    let nonOptionalTotal = 0;
    const OPTIONAL = new Set(['requests','budget_orgs','budget_appropriations','budget_pes','budget_projects','pe_office_links','pe_office_link_dismissals','pe_office_suggestions','budget_om_sags','budget_topline_lines','sag_office_links','sag_office_link_dismissals','sag_office_suggestions','hill_members','hill_committees','hill_committee_memberships','hill_meetings','hill_requests','engagements']);
    results.forEach(({ t, r }) => {
      if (r.error) {
        if (OPTIONAL.has(t)) {
          console.warn('[Supabase] optional table ' + t + ' load failed (probably missing) - degrading to empty:', r.error.message || r.error);
          this.state[t] = [];
          return;
        }
        throw new Error('Load failed for ' + t + ': ' + (r.error.message || r.error));
      }
      this.state[t] = r.data || [];
      total += this.state[t].length;
      if (!OPTIONAL.has(t)) nonOptionalTotal += this.state[t].length;
    });
    // the app simply renders with no rows -- the operator's job to
    // populate via Supabase Studio or the in-app create flows.
    this.state.lastSaved = new Date().toISOString();
    updateSaveStatus();
  },

  // commit notes -- the destructive primitives are gone.

// CRUD helpers
  list(table)        { return this.state[table] || []; },
  get(table, id)     { return (this.state[table] || []).find(r => r.id === id); },

  upsert(table, rec) {
    if (!rec.id) rec.id = makeId(table);
    const arr = this.state[table];
    const i = arr.findIndex(r => r.id === rec.id);
    const merged = i === -1 ? rec : Object.assign({}, arr[i], rec);
    if (i === -1) arr.push(merged);
    else arr[i] = merged;
    var GENERATED_COLS = { solicitations: ['estimated_value'] };
    var stripFor = GENERATED_COLS[table] || [];
    var toSend = merged;
    if (stripFor.length) { toSend = Object.assign({}, merged); for (var ci=0;ci<stripFor.length;ci++) delete toSend[stripFor[ci]]; }
    _supaUpsert(table, toSend); // fire-and-forget
    this.state.lastSaved = new Date().toISOString();
    updateSaveStatus();
    try {
      document.dispatchEvent(new CustomEvent('waypoint:datachange', { detail: { table: table, id: merged.id } }));
    } catch (_) { /* CustomEvent unsupported -> ignore */ }
    return merged;
  },

  remove(table, id) {
    this.state[table] = this.state[table].filter(r => r.id !== id);
    _supaDelete(table, id);
    // Cascade: unlink orphan refs + track touched records so we push updates.
    const touched = { offices:new Set(), contacts:new Set(), solicitations:new Set(), letters:new Set(), washops:new Set(), requests:new Set() };
    if (table === 'offices') {
      this.state.contacts.forEach(c => {
        const before = (c.officeIds||[]).length;
        c.officeIds = (c.officeIds||[]).filter(o => o !== id);
        if (c.officeIds.length !== before) touched.contacts.add(c.id);
      });
      ['solicitations','letters'].forEach(t => {
        this.state[t].forEach(r => { if (r.officeId === id) { r.officeId = ''; touched[t].add(r.id); } });
      });
      this.state.washops.forEach(w => {
        const before = (w.officeIds||[]).length;
        w.officeIds = (w.officeIds||[]).filter(o => o !== id);
        if (w.officeIds.length !== before) touched.washops.add(w.id);
      });
      (this.state.requests || []).forEach(rq => {
        if (rq.officeId === id) { rq.officeId = ''; touched.requests.add(rq.id); }
      });
    }
    if (table === 'contacts') {
      ['solicitations','letters','washops','requests'].forEach(t => {
        (this.state[t] || []).forEach(r => {
          if (r.contactIds) {
            const before = r.contactIds.length;
            r.contactIds = r.contactIds.filter(c => c !== id);
            if (r.contactIds.length !== before) touched[t].add(r.id);
          }
        });
      });
    }
    Object.entries(touched).forEach(([t, ids]) => {
      ids.forEach(rid => {
        const rec = this.state[t].find(r => r.id === rid);
        if (rec) _supaUpsert(t, rec);
      });
    });
    this.state.lastSaved = new Date().toISOString();
    updateSaveStatus();
  },
};

function makeId(table) {
  const prefix = { offices:'o', contacts:'c', solicitations:'s', letters:'l', washops:'w', requests:'r' }[table] || 'x';
  return prefix + '-' + Date.now().toString(36) + '-' + Math.floor(Math.random()*1000).toString(36);
}

// v97's `const DB` is script-scoped; window.DB was always undefined,
// which made every `window.DB && DB.state` check in v98 return false
// and silently no-op renderMissionControl + rail-count refresh.
if (typeof window !== 'undefined' && typeof DB !== 'undefined') {
  window.DB = DB;
}

function updateSaveStatus() {
  const el = document.getElementById('saveStatus');
  if (!el) return;
  const counts = ' · ' + (DB.state.offices.length) + ' offices · ' + (DB.state.contacts.length) + ' contacts · ' + (DB.state.solicitations.length) + ' solicitations';
  if (_lastDbError) {
    el.textContent = 'Sync error: ' + _lastDbError + counts;
  } else if (_pendingWrites > 0) {
    el.textContent = 'Saving… (' + _pendingWrites + ')' + counts;
  } else if (DB.state.lastSaved) {
    const d = new Date(DB.state.lastSaved);
    const hh = String(d.getHours()).padStart(2,'0');
    const mm = String(d.getMinutes()).padStart(2,'0');
    el.textContent = 'Synced ' + d.toLocaleDateString() + ' ' + hh + ':' + mm + counts;
  } else {
    el.textContent = 'Loading…';
  }
}



// ============================================================
// Window exposures -- bare references from classic script + sibling
// modules resolve via the global object at call time (functions don't
// bind references at parse time, so the timing is fine: classic script
// finishes parsing, modules eval, window props get set, then the boot
// IIFE awaits and starts calling these).
// ============================================================
window._pendingWrites = _pendingWrites;
window._lastDbError = _lastDbError;
window._bumpPending = _bumpPending;
window._supaUpsert = _supaUpsert;
window._supaUpdate = _supaUpdate;
window._supaDelete = _supaDelete;
window._supaDeleteComposite = _supaDeleteComposite;
window.getOfficesForPe = getOfficesForPe;
window.getSuggestionsForPe = getSuggestionsForPe;
window.getSuggestionsForOffice = getSuggestionsForOffice;
window.linkPeToOffice = linkPeToOffice;
window.unlinkPeFromOffice = unlinkPeFromOffice;
window.dismissPeOfficeSuggestion = dismissPeOfficeSuggestion;
window.getSagsForOffice = getSagsForOffice;
window.getOfficesForSag = getOfficesForSag;
window.getSagSuggestionsForOffice = getSagSuggestionsForOffice;
window.linkSagToOffice = linkSagToOffice;
window.unlinkSagFromOffice = unlinkSagFromOffice;
window.dismissSagOfficeSuggestion = dismissSagOfficeSuggestion;
window.DB = DB;
window.makeId = makeId;
window.updateSaveStatus = updateSaveStatus;
