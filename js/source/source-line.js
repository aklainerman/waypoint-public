// js/source/source-line.js
//
// bottom of index.html; lifted to an ES module in v180.
//
// Hooks a "View PDF ↗" button into the inline drawer source line. The v153
// source-line element has `data-narr-source="<id>"`; once the narrative RPC
// populates with source_pdf + source_page_*, we add a button that opens the
// PDF popup at the description page (preferred) or amount page (fallback).
//
// Periodic sweep instead of MutationObserver: v153's fillNarrativePlaceholders
// overwrites the source line's innerHTML after the narrative RPC settles,
// which wipes any button we attached previously. The sweep checks actual
// button presence each tick so we re-attach if needed. Cheap enough at 800ms.

// Re-render PDF buttons after v153FillNarratives swaps source-line text.
function attachButtons() {
  document.querySelectorAll('[data-narr-source]').forEach(function (line) {
    // overwrites the source line's innerHTML after the narrative RPC settles,
    // which wipes any button we added previously. Check actual button presence.
    if (line.querySelector('.v46-pdf-btn')) return;
    var codeEl = line.querySelector('code');
    if (!codeEl) return;
    var src = (codeEl.textContent || '').trim();
    if (!src) return;
    var m = line.textContent.match(/desc p\.(\d+)/i) || line.textContent.match(/p\.(\d+)/i);
    var page = m ? parseInt(m[1], 10) : null;
    var btn = document.createElement('a');
    btn.href = '#';
    btn.className = 'v46-pdf-btn';
    btn.setAttribute('data-v46-pdf-launch', src);
    if (page != null) btn.setAttribute('data-v46-pdf-page', String(page));
    btn.setAttribute('data-v46-pdf-kind', 'Source J-Book');
    btn.textContent = 'View PDF ↗';
    line.appendChild(document.createTextNode(' '));
    line.appendChild(btn);
  });
}

// Run periodically — narrative RPCs settle async, so we sweep every 800ms
// for a few seconds after each render. Cheap.
function sweep() { attachButtons(); }
setInterval(sweep, 800);
