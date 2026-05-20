// js/db/narrative-search.js
//
// non-empty keystroke, then return Set<id> for query matches. Cached
// indefinitely (4,242 narratives × ~600 bytes ≈ 2.5 MB).
//
// Originally an inline IIFE at the bottom of index.html; lifted to ES module
// in v180.
//
// Exposes on window:
//   window._v46NarrTokens(q)      — phrase-aware tokenizer
//   window._v46NarrSearch(q)      — returns Set<id> of matches (null if not ready)
//   window._narrSearchPreload  — trigger eager preload
//
// Consumes from window:
//   _sb              — global Supabase client (v172 boot)
//   renderBudget()   — global render fn from the monolith

var _index = null;            // Array<{id, kind, mission_description}>
var _loading = null;          // Promise
var _statusEl = null;         // text shown when loading
function preload(){
  if (_index) return Promise.resolve(_index);
  if (_loading) return _loading;
  if (typeof _sb === 'undefined' || !_sb) return Promise.resolve(null);
  if (_statusEl == null) {
    _statusEl = document.getElementById('budgetCount');
  }
  if (_statusEl) _statusEl.textContent = 'Loading narrative search index…';
  // 1000 rows. Our UNION ALL returns 4,242 (1,753 PE + 772 SAG + 1,717 proc).
  // Without pagination, only ~1000 rows (all RDT&E PE) get through, breaking
  // SAG and procurement search. Same pattern as v149's get_pes_for_year fix.
  _loading = (async function(){
    // v47c: PostgREST Range header doesn't paginate RPC results — server
    // caps every call at 1000 rows. .range() was a no-op; only the first
    // 1000 PE rows ever made it into the index, and all 772 SAG + 1717 proc
    // narratives were missing. Switch to param-based (p_offset/p_limit)
    // pagination + Promise.all parallelism.
    var allRows = [];
    var PAGE = 1000;
    var MAX_PAGES = 12;  // 12 × 1000 = 12,000 row ceiling (current corpus 4,242)
    try {
      var pagePromises = [];
      for (var i = 0; i < MAX_PAGES; i++) {
        (function(idx){
          pagePromises.push(_sb.rpc('get_all_narratives_brief', { p_offset: idx*PAGE, p_limit: PAGE }));
        })(i);
      }
      var results = await Promise.all(pagePromises);
      for (var pi = 0; pi < results.length; pi++) {
        var r = results[pi];
        if (r && r.error) { console.warn('[v47c] narr RPC failed at offset', pi*PAGE, r.error); continue; }
        var batch = (r && Array.isArray(r.data)) ? r.data : [];
        if (batch.length === 0) break;  // stop concat'ing trailing empty pages
        allRows = allRows.concat(batch);
        if (batch.length < PAGE) break;  // last page reached
      }
    } catch (e) {
      console.warn('[v47c] narr search RPC threw', e);
      _loading = null;
      return null;
    }
    var byId = new Map();
    allRows.forEach(function(row){
      if (!row || !row.id) return;
      var prev = byId.get(row.id);
      var next = (prev && prev.mission_description ? prev.mission_description + ' ' : '')
               + ((row.mission_description || '') + ' ' + (row.title || ''));
      byId.set(row.id, { id: row.id, kind: row.kind, mission_description: next.toLowerCase() });
    });
    _index = Array.from(byId.values());
    var counts = { pe: 0, sag: 0, proc: 0, other: 0 };
    _index.forEach(function(r){ counts[r.kind] = (counts[r.kind] || 0) + 1; });
    console.log('[v46] narrative search index loaded:',
                _index.length, 'unique IDs across', allRows.length, 'rows',
                '(pe=' + counts.pe + ' sag=' + counts.sag + ' proc=' + counts.proc + ')');
    try { if (typeof renderBudget === 'function') renderBudget(); } catch(e){}
    return _index;
  })();
  return _loading;
}
// v47b P2 + v158: tokenize q into words; match if ALL non-empty tokens occur in
// the (already-lowercased) mission_description / hay string. Powers multi-word
// search like hypersonic missile — substring of either token still matches.
//
// parenthesized phrase ((contested logistics)) is emitted as a SINGLE token
// with its internal whitespace preserved. Because every hay string in the
// four call sites (PE / SAG / topline / bulk narrative index) is built by
// joining fields with single ASCII spaces, a multi-word phrase token only
// satisfies hay.indexOf(...) >= 0 when the two words sit ADJACENT in the
// same source field — i.e. true phrase search. Unquoted text continues to
// tokenize on whitespace as before, so existing AND-of-words behaviour is
// unchanged for non-quoted queries. Curly quotes that paste from
// Word/Slack/email are normalised to straight ASCII before parsing.
// Unclosed quotes/parens degrade gracefully: the stray delimiters are
// stripped and the remaining text tokenises as plain words.
window._v46NarrTokens = function(q){
  if (!q) return [];
  var s = String(q).toLowerCase()
    .replace(/[“”]/g, '"')   // “ ” -> "
    .replace(/[‘’]/g, "'");  // ‘ ’ -> '  (consumed only as a fallback below)
  var out = [];
  // Pull out "..." and (...) phrases first; non-greedy, non-nested.
  var phraseRe = /"([^"]+)"|\(([^)]+)\)/g;
  var m;
  while ((m = phraseRe.exec(s)) !== null) {
    var phrase = (m[1] || m[2] || '').trim().replace(/\s+/g, ' ');
    if (phrase) out.push(phrase);
  }
  // Strip the matched phrases AND any remaining stray phrase punctuation
  // so an unclosed quote/paren degrades to plain word tokens rather than
  // poisoning the next token with a literal " or ( character.
  var rest = s.replace(phraseRe, ' ').replace(/["()]/g, ' ');
  var raw = rest.split(/\s+/);
  for (var k = 0; k < raw.length; k++) { if (raw[k]) out.push(raw[k]); }
  return out;
};
window._v46NarrSearch = function(q){
  var tokens = window._v46NarrTokens(q);
  if (tokens.length === 0) return null;
  // Each non-empty token must be at least 2 chars to avoid trivial matches.
  var minOk = tokens.some(function(t){ return t.length >= 2; });
  if (!minOk) return null;
  if (!_index) {
    preload();
    return null;
  }
  var hits = new Set();
  for (var i = 0; i < _index.length; i++) {
    var row = _index[i];
    var ok = true;
    for (var j = 0; j < tokens.length; j++) {
      if (row.mission_description.indexOf(tokens[j]) === -1) { ok = false; break; }
    }
    if (ok) hits.add(row.id);
  }
  return hits;
};
window._narrSearchPreload = preload;
// Auto-preload after 4s of idle so first search is instant.
setTimeout(preload, 4000);
