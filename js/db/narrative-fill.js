// js/db/narrative-fill.js
//
// IIFE that:
//   1. Maintains a diff-set cache (Map<pe_id, changed>) from the
//      get_narrative_diff_set RPC, used by the budget tree's
//      "delta narrative" badge.
//   2. Provides _v153FillNarratives which walks [data-narr-fetch]
//      placeholders and fetches narratives via Supabase RPCs.
//   3. Hooks window.renderBudget so fillNarrativePlaceholders runs
//      after each tree re-render. Polls until renderBudget exists
//      (which v204 budget-tree.js sets on module load).
//
// Window exposures (already in source): _v148NarrChanged,
// _v153FillNarratives.
//
// External refs consumed: _sb (Supabase client), renderBudget,
// DB, escapeHtml, _v131FormatJBookNarrative.

/* ============================================================
   v153 — Inline-dropdown narrative fill + diff badge cache
   ----------------------------------------------------------------
   v153 is a near-rewrite of v148: drops the right-drawer narrative
   render entirely (per spec — drawer shows linked entities only)
   and instead populates [data-narr-fetch] placeholders inside the
   inline expandable dropdown rendered by renderBudget().

   Three RPCs, one cache, one DOM walker, one renderBudget hook.
   ============================================================ */
(function() {
  // ---- Diff-set cache (legacy v148 behavior; powers the Δ NARR badge) ----
  var _diffSet = null;
  var _diffPromise = null;

  function ensureDiffSet() {
    if (_diffSet) return Promise.resolve(_diffSet);
    if (_diffPromise) return _diffPromise;
    if (typeof _sb === "undefined" || !_sb) return Promise.resolve(new Map());
    _diffPromise = _sb.rpc("get_narrative_diff_set", { p_year_a: 2026, p_year_b: 2027 })
      .then(function(r) {
        var m = new Map();
        if (r && r.data) r.data.forEach(function(row){ m.set(row.pe_id, !!row.changed); });
        _diffSet = m;
        try { if (typeof renderBudget === "function") renderBudget(); } catch (e) {}
        return m;
      })
      .catch(function(e){ console.warn("[v153] diff set failed", e); _diffSet = new Map(); return _diffSet; });
    return _diffPromise;
  }
  window._v148NarrChanged = function(pe_id) {
    if (!_diffSet) { ensureDiffSet(); return null; }
    return _diffSet.has(pe_id) ? _diffSet.get(pe_id) : false;
  };

  // ---- Narrative cache (per-row, per-year). Keyed by 'kind:id:year'. ----
  var _narrCache = new Map();
  var _narrInflight = new Map();

  function cacheKey(kind, id, year) { return kind + ':' + id + ':' + year; }

  async function fetchNarrativeRow(kind, id, year) {
    var key = cacheKey(kind, id, year);
    if (_narrCache.has(key)) return _narrCache.get(key);
    if (_narrInflight.has(key)) return _narrInflight.get(key);
    if (typeof _sb === "undefined" || !_sb) throw new Error("Supabase not ready");
    var rpcName, args;
    if (kind === 'sag') {
      rpcName = 'get_om_sag_narrative';
      args = { p_sag_id: id, p_year: year };
    } else if (kind === 'proc') {
      rpcName = 'get_proc_line_narrative';
      args = { p_proc_line_id: id, p_year: year };
    } else {
      rpcName = 'get_narrative_for_pe';
      args = { p_pe_id: id, p_year: year };
    }
    var p = _sb.rpc(rpcName, args).then(function(r) {
      if (r.error) throw r.error;
      var row = (r.data && r.data[0]) || null;
      _narrCache.set(key, row);
      _narrInflight.delete(key);
      return row;
    }).catch(function(e) {
      _narrInflight.delete(key);
      throw e;
    });
    _narrInflight.set(key, p);
    return p;
  }

  // ---- Source-link footer with page anchor(s) ----
  function buildSourceFooter(row) {
    if (!row) return '';
    var src = row.source_pdf || '';
    var pd  = row.source_page_description != null ? row.source_page_description : null;
    var pa  = row.source_page_amount      != null ? row.source_page_amount      : null;
    var legacyPage = row.source_page != null ? row.source_page : null;
    if (!src && pd == null && pa == null && legacyPage == null) return '';
    var pageStr = '';
    if (pd != null && pa != null && pd !== pa) pageStr = ' · desc p.' + pd + ' / amt p.' + pa;
    else if (pd != null) pageStr = ' · p.' + pd;
    else if (pa != null) pageStr = ' · p.' + pa;
    else if (legacyPage != null) pageStr = ' · p.' + legacyPage;
    return src
      ? '<code style="font-size:10.5px;">' + escapeHtml(src) + '</code>' + escapeHtml(pageStr)
      : '<em>(no source on file)</em>';
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function(c){
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;";
    });
  }

  // ---- The main fill: walks [data-narr-fetch] elements and populates them. ----
  async function fillOne(el) {
    if (el.dataset.narrFilled === '1' || el.dataset.narrFilled === 'pending') return;
    var kind = el.dataset.narrKind;
    var id   = el.dataset.narrFetch;
    var year = parseInt(el.dataset.narrYear, 10) || (window._budgetYear || 2026);
    el.dataset.narrFilled = 'pending';
    try {
      var row = await fetchNarrativeRow(kind, id, year);
      // If still in DOM after async resolves
      if (!el.isConnected) return;
      var noun = kind === 'sag' ? 'SAG' : (kind === 'proc' ? 'procurement line' : 'PE');
      if (row && row.mission_description) {
        el.innerHTML = '<div style="white-space:pre-wrap;">' + escapeHtml(row.mission_description) + '</div>';
      } else if (row && row.source_pdf) {
        el.innerHTML = '<em style="color:var(--text-muted);">No narrative text ingested yet for this ' + noun + '. Source PDF is linked below.</em>';
      } else {
        el.innerHTML = '<em style="color:var(--text-muted);">No narrative on file for this ' + noun + '.</em>';
      }
      el.dataset.narrFilled = '1';
      // Also update the source-link line if there's one keyed to this row.
      var srcLine = document.querySelector('[data-narr-source="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if (srcLine && row) {
        var footerHtml = buildSourceFooter(row);
        if (footerHtml) srcLine.innerHTML = 'Source: ' + footerHtml;
      }
    } catch (e) {
      if (!el.isConnected) return;
      el.innerHTML = '<em style="color:var(--text-muted);">Narrative unavailable: ' + escapeHtml(e.message || String(e)) + '</em>';
      el.dataset.narrFilled = '0'; // allow retry on next render
    }
  }

  function fillNarrativePlaceholders() {
    var els = document.querySelectorAll('[data-narr-fetch]');
    els.forEach(fillOne);
  }
  window._v153FillNarratives = fillNarrativePlaceholders;

  // ---- Hook renderBudget so fill runs after each render. ----
  function hookRenderBudget() {
    if (typeof renderBudget !== 'function') { setTimeout(hookRenderBudget, 200); return; }
    var orig = renderBudget;
    window.renderBudget = function() {
      var r = orig.apply(this, arguments);
      // Defer to next tick so DOM is updated before we walk it.
      setTimeout(fillNarrativePlaceholders, 0);
      return r;
    };
  }
  hookRenderBudget();

  // Fire the diff-set fetch on first idle so badges populate.
  setTimeout(ensureDiffSet, 1500);
})();


