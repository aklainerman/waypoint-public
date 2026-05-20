// js/admin/settings-actions.js
//
// the cleanup: Export JSON (read-only download of current
// DB.state).
//
// History:
//           Save as shareable HTML, share-export wiring) into one
//           module.
//           downloaded HTML (since SEED_DATA was lifted to its
//           own module).
//             * btnImportAll + DB.replaceAll  (destructive: wipes DB
//               on import. Per principle: no UI button that wipes.)
//             * shareExportBtn + downloadShareableHtml (vestigial
//               after an earlier cleanup removed DB._seedToSupabase; the inline
//               SEED_DATA in shared HTML had no consumer.)
//             * Reset-to-defaults code path (was never wired to a
//               button; DB.reset method also removed from db.js.)
//           Result: only Export JSON remains in this module.
//
// External refs consumed (all auto-hoisted on window):
//   DB, URL, Blob, JSON

document.getElementById('btnExportAll').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(DB.state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'waypoint-export-' + (new Date().toISOString().slice(0,10)) + '.json';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
})