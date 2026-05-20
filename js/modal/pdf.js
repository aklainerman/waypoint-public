// js/modal/pdf.js
//
// PDF viewer modal — opens a J-Book source PDF in an inline iframe and
// deep-links to a specific page via `#page=N`.
//
// Source PDFs live in a Supabase Storage public bucket. The base URL is read
// from `window._pdfBaseUrl` (overridable in console for testing); default
// matches the live storage path. If a PDF 404s the iframe stays blank — we do
// a lightweight HEAD probe up front and switch to a friendly "not yet hosted"
// message when missing.
//
// Originally an inline IIFE at the bottom of index.html; lifted to ES module
// in v180. Renamed from `v46-pdf.js` → `pdf.js` at OSS publish time; the
// internal `v46-*` identifiers (CSS classes, data attributes, function names)
// are intentionally preserved as cache-busters / refactor breadcrumbs.
//
// Exposes on window:
//   window.openV46PdfModal(srcPdf, page, kindLabel)
//   window._pdfBaseUrl    — overridable base URL for the budget-jbooks bucket

// which is set by _initSupabase (js/db/supabase.js) using the
// Supabase URL returned by /.netlify/functions/config. This makes the
// PDF viewer agnostic to which Supabase project is hosting it.
//
// Override pattern (DevTools): set window._pdfBaseUrl to any string;
// the resolver below short-circuits if it's already set.
function _resolveBaseUrl() {
  if (window._pdfBaseUrl) return window._pdfBaseUrl;
  // Supabase JS v2 client exposes .supabaseUrl on the client instance.
  var supaUrl = (window._sb && window._sb.supabaseUrl) || null;
  if (supaUrl) {
    window._pdfBaseUrl = supaUrl + '/storage/v1/object/public/budget-jbooks/';
    return window._pdfBaseUrl;
  }
  // Fallback: derive from current page origin. Only works if PDFs are
  // served from the same Supabase the app talks to (typical config).
  return null;
}
function _encode(p){
  // Encode each path segment (preserve slashes).
  return String(p || '').split('/').map(encodeURIComponent).join('/');
}
function _buildUrl(srcPdf, page){
  if (!srcPdf) return null;
  var base = _resolveBaseUrl();
  if (!base) {
    console.warn('[pdf] base URL unresolved (window._sb missing). Set window._pdfBaseUrl manually.');
    return null;
  }
  var u = base + _encode(srcPdf);
  if (page != null) u += '#page=' + encodeURIComponent(page);
  return u;
}
window.openV46PdfModal = function(srcPdf, page, kindLabel){
  var bd = document.getElementById('v46PdfBackdrop');
  var iframe = document.getElementById('v46PdfIframe');
  var title = document.getElementById('v46PdfTitle');
  var sub = document.getElementById('v46PdfSub');
  var newTab = document.getElementById('v46PdfNewTab');
  var body = document.getElementById('v46PdfBody');
  if (!bd || !iframe) return;
  var url = _buildUrl(srcPdf, page);
  if (!url) return;
  title.textContent = kindLabel || 'Source J-Book';
  sub.textContent = (srcPdf || '') + (page ? ' · page ' + page : '');
  newTab.href = url;
  // Reset body state
  iframe.style.display = '';
  iframe.src = url;
  var existingMissing = body.querySelector('.v46-pdf-missing');
  if (existingMissing) existingMissing.remove();
  bd.classList.add('open');
  document.body.classList.add('v46-pdf-open');
  // HEAD probe so we can swap to "not hosted yet" if 404.
  try {
    fetch(url.split('#')[0], { method: 'HEAD' }).then(function(r){
      if (!r.ok) {
        iframe.style.display = 'none';
        if (!body.querySelector('.v46-pdf-missing')) {
          var div = document.createElement('div');
          div.className = 'v46-pdf-missing';
          var safeUrl = url.replace(/&/g,'&amp;').replace(/</g,'&lt;');
          div.innerHTML =
            '<strong>PDF not yet hosted.</strong><br><br>' +
            'Expected at <code>' + safeUrl + '</code><br><br>' +
            'PDFs are an <strong>optional</strong> install step. To enable Source ' +
            'button deep-links, follow the 4-step setup in ' +
            '<a href="https://github.com/reesemozer/waypoint/blob/main/supabase/seed/budget/PDF_MANIFEST.md" ' +
            'target="_blank" rel="noopener"><code>supabase/seed/budget/PDF_MANIFEST.md</code></a>: ' +
            'download the 219 J-Book PDFs from ' +
            '<a href="https://comptroller.defense.gov/Budget-Materials/" ' +
            'target="_blank" rel="noopener">comptroller.defense.gov</a>, create a ' +
            'Supabase Storage bucket named <code>budget-jbooks</code> with public ' +
            'read access, and upload preserving the exact filenames listed in the ' +
            'manifest. The rest of the app works without this — only the Source ' +
            'buttons will resolve once PDFs are uploaded.';
          body.appendChild(div);
        }
      }
    }).catch(function(){});
  } catch(e){}
};
function close(){
  var bd = document.getElementById('v46PdfBackdrop');
  var iframe = document.getElementById('v46PdfIframe');
  if (bd) bd.classList.remove('open');
  if (iframe) iframe.src = 'about:blank';
  document.body.classList.remove('v46-pdf-open');
}
document.addEventListener('click', function(ev){
  var t = ev.target;
  if (!t) return;
  if (t.matches && t.matches('[data-v46-pdf-close]')) { close(); return; }
  // Backdrop click (outside modal)
  if (t.matches && t.matches('[data-v46-pdf-backdrop]')) { close(); return; }
  // Source-PDF launcher buttons inside inline drawer
  var launch = t.closest && t.closest('[data-v46-pdf-launch]');
  if (launch) {
    ev.preventDefault();
    var s = launch.getAttribute('data-v46-pdf-launch');
    var p = launch.getAttribute('data-v46-pdf-page');
    var k = launch.getAttribute('data-v46-pdf-kind') || 'Source J-Book';
    window.openV46PdfModal(s, p ? parseInt(p, 10) : null, k);
  }
});
document.addEventListener('keydown', function(ev){
  if (ev.key === 'Escape' && document.body.classList.contains('v46-pdf-open')) close();
});
