// js/core/year-toggle.js
//
// window._budgetYear + a family of SAG / topline amount helpers,
// plus the segmented-pill UI in Mission Control / Budget header.
//
// Distinct from js/drawer/year-toggle.js which handles the per-row
// FY26/FY27 toggle inside narrative drawers (v46 / v180).
//
// Window exposures (all already in source, no footer additions):
//   _budgetYear, _v147Y, _v150SagAmt, _v150ToplineAmt,
//   _v151SagDedupAmt, _sagDedupForYear, _budgetCompareMode
//
// External refs consumed: _sb (Supabase client), DB, renderBudget,
// renderBudgetSankey, renderBudgetOfficeView, renderBudgetTagOffices,
// renderOffices, refreshDashboard, refreshCardCounters.
//
// F-NEW-V203-1 mitigation: paintActive/paintMcLabels init was wrapped
// in readyState/DCL fallback; rewritten to direct call.

/* ============================================================
   v147 — Year toggle (FY26 | FY27)
   ============================================================
   On year flip:
     1. Call Supabase RPC get_pes_for_year(p_year)
     2. Replace DB.state.budget_pes with the result (already shaped
        like budget_pes, including is_priority joined from legacy)
     3. Re-render Budget tab via existing renderBudget() etc.
   Default year is 2026. Persisted in localStorage.
   ============================================================ */
(function() {
  var KEY = 'waypoint_budget_year';
  var DEFAULT_YEAR = 2027;            // v46: was 2026 — spec defaults to FY27 throughout
  var ALLOWED = [2026, 2027];

  function readYear() {
    // single canonical lens for amounts/rollups/Sankey. Honor an explicit
    // ?year=2026 query string for one-off historical inspection only.
    try {
      var qs = new URLSearchParams(window.location.search);
      var qy = parseInt(qs.get('year') || '', 10);
      if (ALLOWED.indexOf(qy) >= 0) return qy;
    } catch (e) {}
    return DEFAULT_YEAR;
  }
  function writeYear(y) { try { localStorage.setItem(KEY, String(y)); } catch (e) {} }

  window._budgetYear = readYear();
  // Year-label helper used by build_v147 string substitutions in render code.
  // _v147Y(0) returns 'FY' + (_budgetYear - 2000)
  // _v147Y(-1) returns the year before, etc.
  window._v147Y = function (offset) {
    var y = (window._budgetYear || 2026) + (offset || 0);
    var yy = y - 2000;
    return 'FY' + (yy < 10 ? '0' + yy : String(yy));
  };

  // ----------------------------------------------------------------
  //
  // The PE path is already year-aware via the get_pes_for_year RPC
  // (fixed in v168 + v149 pagination). But OM SAGs are read directly
  // from DB.list('budget_om_sags') in many sites, and budget_topline_lines
  // is read for MILPERS/MILCON/FH/BRAC/Drug rollups. Both still hit
  // .fy26_estimate / .fy26_total when window._budgetYear === 2027.
  //
  // _v150SagAmt(s)     — disc + mand for FY27, disc-only for FY26.
  //                      No fall-back to FY26 on FY27 NULL (preserves the
  //                      have fy27=NULL on PURPOSE; falling back would
  //                      double-count against budget_om_sags COMP+PSCP).
  // _v150ToplineAmt(r) — r.fy27_total for FY27, r.fy26_total for FY26.
  //                      fy27_total is already disc+mand combined per the
  // ----------------------------------------------------------------
  window._v150SagAmt = function (s) {
    if (!s) return 0;
    var y = window._budgetYear || 2026;
    if (y === 2027) {
      var disc = Number(s.fy27_estimate) || 0;
      var mand = Number(s.fy27_mandatory_amount) || 0;
      return disc + mand;
    }
    return Number(s.fy26_estimate) || 0;
  };
  window._v150ToplineAmt = function (r) {
    if (!r) return 0;
    var y = window._budgetYear || 2026;
    if (y === 2027) {
      var v = Number(r.fy27_total);
      return isFinite(v) ? v : 0;
    }
    var v2 = Number(r.fy26_total);
    return isFinite(v2) ? v2 : 0;
  };

  // ----------------------------------------------------------------
  //
  // The audit harness (tools/audit_lib.py SQL_OM_BY_ACCOUNT) treats the
  // umbrella row in each (account, defense_wide_org, appropriation_id)
  // group as a roll-up of the same money in the sibling rows, never
  // additive. Naive SUM(amt) over budget_om_sags double-counts to the
  // tune of ~$15B FY27 / ~$13B FY26. Per memory I-21, the harness uses
  //
  //     GREATEST(umb_disc, sum(sib_disc)) + sum(cyber_disc) + sum(per-row mand)
  //
  // and per memory I-16 the *_cyber rows are SEPARATE numbered O-1
  // entries that ARE additive (FY27 PB O-1 lines 2248-2304 verified).
  // This helper returns Map<sag.id, contribution> implementing that rule.
  // It does NOT modify per-row data; the budget tree loop reads
  // request_amount which is wired to this map at SAG injection time, so
  // tree.total / svc.total / acct.total / ba.total / Mission Control
  // headline are all corrected in lockstep without touching DB rows.
  //
  // Tie-handling: when umb_disc == sibs_disc (SOCOM is the canonical
  // case), the umbrella row keeps its full value and sibs are zeroed.
  // This preserves the umbrella as the canonical aggregate row and is
  // what the harness's GREATEST() arithmetic does in degenerate ties.
  //
  // Mand axis: per harness comment in SQL_OM_BY_ACCOUNT, FY27 mand is
  // on at most one row per group (umbrella OR sib, never both), so
  // each row's own fy27_mandatory_amount is added back as-is. FY26
  // has no per-row mand column on budget_om_sags.
  // ----------------------------------------------------------------
  window._v151SagDedupAmt = function (sags, year, apprById) {
    var out = new Map();
    if (!Array.isArray(sags) || !apprById) return out;
    year = year || (window._budgetYear || 2026);

    function discOf(s) {
      if (year === 2027) return Number(s.fy27_estimate) || 0;
      return Number(s.fy26_estimate) || 0;
    }
    function mandOf(s) {
      if (year === 2027) return Number(s.fy27_mandatory_amount) || 0;
      return 0;
    }

    var groups = new Map();
    sags.forEach(function (s) {
      if (!s || !s.id || !s.appropriation_id) return;
      var ap = apprById[s.appropriation_id];
      if (!ap) return;
      var k = (ap.account || '?') + '|' + (s.defense_wide_org || '') + '|' + s.appropriation_id;
      var g = groups.get(k);
      if (!g) { g = { umb: null, sibs: [], cyber: [] }; groups.set(k, g); }
      if (/_umbrella$/.test(s.id))   g.umb = s;
      else if (/_cyber$/.test(s.id)) g.cyber.push(s);
      else                           g.sibs.push(s);
    });

    groups.forEach(function (g) {
      var umbDisc  = g.umb ? discOf(g.umb) : 0;
      var sibsDisc = g.sibs.reduce(function (a, s) { return a + discOf(s); }, 0);
      // Tie favors umbrella (sibsDisc < umbDisc OR equal -> keep umb)
      var keepUmb  = umbDisc >= sibsDisc;
      if (g.umb) {
        out.set(g.umb.id, (keepUmb ? umbDisc : 0) + mandOf(g.umb));
      }
      g.sibs.forEach(function (s) {
        out.set(s.id, (keepUmb ? 0 : discOf(s)) + mandOf(s));
      });
      g.cyber.forEach(function (s) {
        out.set(s.id, discOf(s) + mandOf(s));
      });
    });
    return out;
  };

  // Convenience: build dedup map for the active year using DB.list().
  window._sagDedupForYear = function (year) {
    var sags = (window.DB && window.DB.list) ? (window.DB.list('budget_om_sags') || []) : [];
    var apprList = (window.DB && window.DB.list) ? (window.DB.list('budget_appropriations') || []) : [];
    var apprById = {};
    apprList.forEach(function (a) { if (a && a.id) apprById[a.id] = a; });
    return window._v151SagDedupAmt(sags, year || (window._budgetYear || 2026), apprById);
  };

  window._budgetCompareMode = 'single';

  function setStatus(msg) {
    document.querySelectorAll('[data-v147-year-status]').forEach(function(el){ el.textContent = msg || ''; });
  }
  function paintMcLabels() {
    document.querySelectorAll('[data-v147-year-sub]').forEach(function(el){
      el.textContent = (window._v147Y ? window._v147Y(0) : 'FY26');
    });
  }
  function paintActive() {
    document.querySelectorAll('[data-v147-year-pills] .v147-year-pill').forEach(function(b){
      var v = b.getAttribute('data-v147-year');
      if (String(window._budgetYear) === v) b.setAttribute('data-v147-active', '1');
      else b.removeAttribute('data-v147-active');
    });
  }

  async function reloadForYear(year) {
    if (typeof _sb === "undefined" || !_sb) {
      setStatus('Supabase client not ready — reload page');
      return;
    }
    setStatus('Loading FY' + (year - 2000) + ' …');
    var t0 = performance.now();
    try {
      // .range() we silently dropped rows past the first page. The original v74
      // pagination fix in DB.load() didn't cover this RPC path because v147
      // shipped after v74. Match the same _fetchAll loop pattern.
      var rows = [];
      var PAGE = 1000;
      for (var _start = 0; _start < 200000; _start += PAGE) {
        var _end = _start + PAGE - 1;
        var _resp = await _sb.rpc('get_pes_for_year', { p_year: year }).range(_start, _end);
        if (_resp.error) throw _resp.error;
        var _batch = Array.isArray(_resp.data) ? _resp.data : [];
        rows = rows.concat(_batch);
        if (_batch.length < PAGE) break;  // last page
      }
      // Replace state.budget_pes with the rows
      if (typeof DB !== "undefined" && DB && DB.state) {
        DB.state.budget_pes = rows;
        // Refresh DB._byId cache if it exists for budget_pes
        if (DB._byId && DB._byId.budget_pes) {
          DB._byId.budget_pes = {};
          rows.forEach(function(r) { if (r && r.id) DB._byId.budget_pes[r.id] = r; });
        }
      }
      var ms = (performance.now() - t0).toFixed(0);
      setStatus('FY' + (year - 2000) + ' loaded — ' + rows.length + ' PEs · ' + ms + 'ms');

      // Trigger re-render of all Budget subviews
      try { if (typeof renderBudget === 'function') renderBudget(); } catch (e) { console.warn('[v147] renderBudget failed', e); }
      // after the year-RPC fetch hydrates budget_pes (was zero on first paint).
      try { if (typeof window._v46RebuildRail === 'function') window._v46RebuildRail(); } catch (e) { console.warn('[v47] rail rebuild failed', e); }
      try { if (typeof renderBudgetOfficeView === 'function') renderBudgetOfficeView(); } catch (e) { console.warn('[v147] renderBudgetOfficeView failed', e); }
      try { if (typeof renderBudgetSankey === 'function' && document.querySelector('[data-subtab-panel="budget-sankey"].active')) renderBudgetSankey(); } catch (e) {}
      try { if (typeof renderBudgetTagOffices === 'function' && document.querySelector('[data-subtab-panel="budget-tag-offices"].active')) renderBudgetTagOffices(); } catch (e) {}
      try { if (typeof renderDashboard === 'function') renderDashboard(); } catch (e) {}
      try { if (typeof renderMissionControl === 'function') renderMissionControl(); } catch (e) {}
    } catch (e) {
      console.error('[v147] RPC failed', e);
      setStatus('Failed: ' + (e.message || e));
    }
  }
  window._budgetReloadForYear = reloadForYear;

  // Click delegation on year pills
  document.addEventListener('click', function(ev) {
    var btn = ev.target && ev.target.closest && ev.target.closest('.v147-year-pill[data-v147-year]');
    if (!btn || btn.disabled) return;
    var v = btn.getAttribute('data-v147-year');
    var y = parseInt(v, 10);
    if (ALLOWED.indexOf(y) < 0) return;  // YoY mode not yet implemented
    if (y === window._budgetYear) return;
    window._budgetYear = y;
    writeYear(y);
    paintActive();
    paintMcLabels();
    reloadForYear(y);
  });

  // After DB.load() completes for the first time, replace the budget_pes
  // payload with the RPC result so the user sees the selected year's data
  // even on first load.
  function hookFirstLoad() {
    if (typeof DB === "undefined" || !DB.load) { setTimeout(hookFirstLoad, 200); return; }
    var origLoad = DB.load.bind(DB);
    DB.load = async function(opts) {
      var r = await origLoad(opts);
      // phase. The 'fast' phase intentionally skips this so Mission Control
      // can render its KPI strip before the budget payload streams in.
      var phase = (opts && opts.phase) || 'all';
      if (phase === 'all' || phase === 'budget') {
        try { await reloadForYear(window._budgetYear); } catch (e) { console.warn('[v147] post-load year fetch failed', e); }
      }
      return r;
    };
  }
  hookFirstLoad();

  // v218 F-NEW-V203-1: direct call (was readyState/DCL fallback).
  paintActive(); paintMcLabels();
})();



