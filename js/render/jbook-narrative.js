// js/render/jbook-narrative.js
//
// co-located at the head of an inline-script fragment in the
// monolith; lifted to ES module in v202.
//
//   _autoExpandTierTrees(maxDepth)
//     Walks the .v98-tier-view-wrap DOM and programmatically expands
//     every collapsed children-chip up to depth N (default 2).
//     Mirrors wireCards' delegated handler inline so we don't depend
//     on a click event firing. Re-runnable.
//
//   _v131FormatJBookNarrative(text)
//     Formats J-Book narrative text (PE drawer source) into readable
//     paragraphs. Recognizes structured section markers (A. Mission
//     Description, B. Accomplishments/Planned Programs, C. Other
//     Program Funding, D. Acquisition Strategy, E. Performance
//     Metrics, F. <heading>, Justification:, Approved By:, Date:,
//     Volume N, Title:, FY YYYY Base / OCO / Total / Request /
//     President / PB ..., Exhibit R-N, Program MDAP/MAIS Code,
//     Note:, etc.) and inserts paragraph breaks before them.
//     Returns escaped HTML with <p> wrapping and <strong> on the
//     section headers.
//
//   _escapeHtml(s)
//     Local HTML escaper used only by _v131FormatJBookNarrative.
//     Module-internal -- not exposed.
//
// Originally at file-scope of the inline monolith; lifted to ES
// module in v202. Same classic-script-split pattern as v181-v201.
//
// Pre-extraction audit (v185 pattern). 2 of 3 names already on
// window in the source and preserved verbatim:
//   window._autoExpandTierTrees    (line 22369 of pre-v202 source)
//   window._v131FormatJBookNarrative   (line 22439 of pre-v202 source)
//
// External file-scope refs the block consumes: NONE.
// External function calls at module-load time: NONE.

// ---------------------------------------------------------------
//
// Replaces the click-to-toggle "N children ▾" dropdown with an
// always-visible indented inline tree. Walks the tier-view DOM and
// for every collapsed children-chip up to depth 2, programmatically
// builds a children-drawer (mirroring wireCards' delegated handler
// inline so we don't depend on a click event firing). Re-runnable.
// ---------------------------------------------------------------
function _autoExpandTierTrees(maxDepth) {
  if (typeof maxDepth !== 'number') maxDepth = 2;
  var wrap = document.querySelector('.v98-tier-view-wrap');
  if (!wrap) return;
  var api = window.__DOW_P4;
  if (!api || typeof api.getChildren !== 'function' || typeof api.miniCardMarkup !== 'function') return;
  // Iterate breadth-first so depth-1 expansions exist before depth-2 attempts.
  for (var pass = 0; pass < maxDepth + 1; pass++) {
    var changed = 0;
    var chips = wrap.querySelectorAll('.children-chip');
    for (var i = 0; i < chips.length; i++) {
      var chip = chips[i];
      var host = chip.closest('.mini-card, .pae-card, .ousw-card');
      if (!host || host.classList.contains('children-open')) continue;
      var sib = host.nextElementSibling;
      if (sib && sib.classList && sib.classList.contains('children-drawer')) continue;
      var hostDepth = host.classList.contains('mini-card')
        ? (parseInt(host.dataset.depth, 10) || 0)
        : 0;
      var drawerDepth = hostDepth + 1;
      if (drawerDepth > maxDepth) continue;
      var parentUuid = chip.dataset.parentUuid;
      if (!parentUuid) continue;
      var kids = api.getChildren(parentUuid);
      if (!kids || !kids.length) continue;
      var drawer = document.createElement('div');
      drawer.className = 'children-drawer';
      drawer.dataset.depth = String(drawerDepth);
      try {
        drawer.innerHTML = kids.map(function (c) { return api.miniCardMarkup(c, drawerDepth); }).join('');
      } catch (e) {
        console.warn('[v131-tree] markup failed', e);
        continue;
      }
      host.parentNode.insertBefore(drawer, host.nextSibling);
      host.classList.add('children-open');
      // Replace the chip text "▾" with "▿" so the visual cue says "open" not
      // "click to open". Idempotent across passes.
      try { chip.textContent = chip.textContent.replace('\u25BE', '\u25BF'); } catch (_) {}
      changed++;
    }
    if (!changed) break;
  }
}
window._autoExpandTierTrees = _autoExpandTierTrees;

// ---------------------------------------------------------------
//
// J-Book narratives ship as a single line (or with sparse \n) where
// section headers like "B. Accomplishments/Planned Programs",
// "Justification:", "Date:", "FY 2026", "Approved By:", and capital-letter
// section markers run on inline. This helper inserts paragraph breaks at
// recognized boundaries, then renders each paragraph as a <p> with
// margin so the text scans instead of forming a wall.
// ---------------------------------------------------------------
function _v131FormatJBookNarrative(text) {
  if (!text || typeof text !== 'string') return '';
  // Normalize whitespace.
  var t = String(text).replace(/\r\n?/g, '\n');
  // Insert hard paragraph break BEFORE each known section marker.
  // Order matters — most specific first.
  var BREAK_PATTERNS = [
    /(\s)(B\.\s+Accomplishments\/?Planned\s+Programs)/g,
    /(\s)(C\.\s+Other\s+Program\s+Funding\s+Summary)/g,
    /(\s)(D\.\s+Acquisition\s+Strategy)/g,
    /(\s)(E\.\s+Performance\s+Metrics)/g,
    /(\s)(F\.\s+[A-Z][^\n]{2,80})/g,
    /(\s)(A\.\s+Mission\s+Description)/g,
    /(\s)(Justification:)/g,
    /(\s)(Approved\s+By:)/g,
    /(\s)(Date:)/g,
    /(\s)(Volume\s+\d+[A-Z]?)/g,
    /(\s)(Title:)/g,
    /(\s)(FY\s+\d{4}\s+(?:Base|OCO|Total|Request|President|PB)[^\n]*)/g,
    /(\s)(Exhibit\s+R-?\d[A-Z]?[^\n]*)/g,
    /(\s)(Program\s+MDAP\/MAIS\s+Code)/g,
    /(\s)(Note:)/g,
    /(\s)([A-Z]{3,}\s+(?:NOTE|HEADER|PROJECTS?))/g,
  ];
  BREAK_PATTERNS.forEach(function (re) {
    t = t.replace(re, '$1\n\n$2');
  });
  // Collapse 3+ blank lines to 2.
  t = t.replace(/\n{3,}/g, '\n\n');
  // Split on blank-line boundaries.
  var parts = t.split(/\n\s*\n/);
  // Render each non-empty part as <p>.
  var html = parts
    .map(function (p) { return p.trim(); })
    .filter(function (p) { return p.length > 0; })
    .map(function (p) {
      // If the paragraph starts with a known header label, bold it.
      var headerMatch = p.match(/^(A\.|B\.|C\.|D\.|E\.|F\.|Justification:|Date:|Title:|Approved By:|Note:|Volume\s+\d+[A-Z]?|Exhibit\s+R-?\d[A-Z]?)/);
      var safe = _escapeHtml(p);
      if (headerMatch) {
        var hLen = headerMatch[0].length;
        safe = '<strong>' + safe.slice(0, hLen) + '</strong>' + safe.slice(hLen);
      }
      // Preserve any remaining single newlines inside the paragraph.
      safe = safe.replace(/\n/g, '<br>');
      return '<p style="margin:0 0 9px 0;">' + safe + '</p>';
    })
    .join('');
  return html || ('<div style="white-space:pre-wrap;">' + _escapeHtml(text) + '</div>');
}
function _escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
window._v131FormatJBookNarrative = _v131FormatJBookNarrative;

