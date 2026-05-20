// js/drawer/year-toggle.js
//
// preference in window._drawerYearMap and re-renders narrative
// placeholder via _v153FillNarratives.
//
// Originally an inline IIFE at the bottom of index.html; lifted to ES module
// in v180.
//
// Exposes on window:
//   window._drawerYearMap  — Map<id, year>
//   window._v46DrawerYearFor  — getter returning {2026, 2027} (default 2027)
//
// Consumes from window:
//   window._v153FillNarratives  — re-render narrative placeholders

if (!window._drawerYearMap) window._drawerYearMap = new Map();
window._v46DrawerYearFor = function(id){
  var v = window._drawerYearMap.get(id);
  return (v === 2026 || v === 2027) ? v : 2027;
};
document.addEventListener('click', function(ev){
  var btn = ev.target && ev.target.closest && ev.target.closest('.v46-year-btn[data-v46-year]');
  if (!btn) return;
  var box = btn.closest('.v46-year-toggle');
  if (!box) return;
  var target = box.getAttribute('data-v46-year-target');
  if (!target) return;
  var newY = parseInt(btn.getAttribute('data-v46-year'), 10);
  if (newY !== 2026 && newY !== 2027) return;
  if (window._v46DrawerYearFor(target) === newY) return;
  window._drawerYearMap.set(target, newY);
  // Update buttons' active state
  box.querySelectorAll('.v46-year-btn').forEach(function(b){
    b.classList.toggle('v46-year-on', parseInt(b.getAttribute('data-v46-year'), 10) === newY);
  });
  // Find the narrative host wrapper and swap its content for a fresh placeholder.
  var host = box.closest('[data-narr-host]');
  if (!host) return;
  // Locate the narrative div within the host (next sibling of the head row).
  var narrDiv = host.querySelector('[data-narr-fetch]');
  var existingClass = narrDiv ? narrDiv.className : '';
  // Determine the kind from the host's existing data-narr-fetch attr or fall
  // back to inferring from the row's data-is-sag attribute upstream.
  var id = host.getAttribute('data-narr-host');
  var kind = narrDiv && narrDiv.getAttribute('data-narr-kind');
  if (!kind) {
    // Look at the parent row's data-is-sag flag
    var row = host.closest('tr.budget-pe-row, tr.budget-pe-detail');
    if (row && row.previousElementSibling && row.previousElementSibling.getAttribute('data-is-sag') === '1') kind = 'sag';
    else if (row && row.previousElementSibling) {
      var aprId = row.previousElementSibling.getAttribute('data-pe-id') || '';
      kind = /^proc_/i.test(aprId) ? 'proc' : 'pe';
    } else kind = 'pe';
  }
  // v47b P1: RDT&E PEs at FY27 render raw _v131-formatted HTML inside the
  // .v131-jbook-narrative wrapper — there's no [data-narr-fetch] placeholder
  // to swap. So when toggling FY27↔FY26 on RDT&E, we must inject a fresh
  // placeholder INTO that wrapper (innerHTML) instead of replacing it.
  // For proc/SAG (which always have a placeholder), we keep outerHTML swap.
  var safeId = (id || '').replace(/"/g, '&quot;');
  var placeholderHtml =
      '<div data-narr-fetch="' + safeId + '" '
      + 'data-narr-kind="' + kind + '" '
      + 'data-narr-year="' + newY + '" '
      + (narrDiv ? 'class="' + existingClass + '" ' : '')
      + 'style="font-size:12.5px;line-height:1.6;color:var(--text);">'
      + '<em style="color:var(--text-muted);font-style:italic;">Loading FY' + (newY - 2000) + ' narrative...</em>'
      + '</div>';
  var v131Wrap = host.querySelector('.v131-jbook-narrative');
  if (v131Wrap) {
    // RDT&E path — wrapper present, inject placeholder inside it.
    v131Wrap.innerHTML = placeholderHtml;
  } else if (narrDiv) {
    // Proc / SAG path — placeholder exists, swap outerHTML.
    narrDiv.outerHTML = placeholderHtml;
  }
  // Trigger re-fill.
  if (typeof window._v153FillNarratives === 'function') window._v153FillNarratives();
});
