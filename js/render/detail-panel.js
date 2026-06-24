// js/render/detail-panel.js
//
// Side detail panel system -- the central "drill-down" surface. Opens
// whenever the user clicks a dashboard card, a Hill contact row, a
// solicitation tile, or a budget LI / SAG cell. ~900 lines covering:
//
//   * 9 panel DOM-ref consts + 4 module-local state vars
//   * getCardTitle / getCardLead (internal DOM-walk helpers)
//   * 5 entry points:
//       openDetailPanel        -- dashboard card  (mode = "card")
//       openOfficeDetailPanel  -- office row      (mode = "card", routed)
//       openContactDetailPanel -- Hill contact    (mode = "contact")
//       openSolDetailPanel     -- solicitation    (mode = "sol")
//       openBudgetItemPanel    -- budget LI / SAG (mode = "card", routed)
//   * closeDetailPanel + navigatePanel (prev/next arrow, mode-aware)
//   * 4 button wirings (panel-close / panel-prev / panel-next / panelStar)
//   * keydown listener (Esc / arrows / p for priority + slash-to-search)
//   * one-shot section-label tier-anchor decoration (runs at module load)
//
// Originally at file-scope of the inline monolith; lifted to ES module
// in v195. Same classic-script-split pattern as v181-v194.
//
// Pre-extraction audit (v185 pattern). 7 names need window exposure:
//
//   closeDetailPanel:        7 monolith refs (any X.cancel button etc.)
//   navigatePanel:           4 monolith refs
//   openBudgetItemPanel:     2 monolith refs
//   openContactDetailPanel:  7 refs (contacts.js 1, hill-members.js 4,
//                                     scout-client.js 2)
//   openDetailPanel:        13 refs (monolith 11, graph.js 2 -- the
//                                     Cytoscape node-click handlers)
//   openOfficeDetailPanel:   2 monolith refs
//   openSolDetailPanel:      1 ref (sols.js)
//
// Module-internal only (intentionally NOT exposed):
//   _panelMode, _currentSolId, _currentContactId  (state, never read
//                                                   outside)
//   currentCard, panel, panelTitle, panelSub, panelBody, panelBadges,
//   panelCounters, panelStar, panelRelated, panelBudget  (DOM refs,
//                                                          never read
//                                                          outside)
//   getCardTitle, getCardLead                     (helpers, only used
//                                                   inside)
//
// External file-scope refs the block consumes:
//   DB                  -- already on window (major global, no shim needed)
//   modalBackdrop       -- file-scope const in monolith, NOT on window
//                           --> redeclared module-locally below
//   searchInput         -- file-scope const in monolith, NOT on window
//                           --> redeclared module-locally below
//
// External function calls (18, all auto-hoisted to window by their
// top-level `function` decls in the classic-script monolith body):
//   _bovOfficeFy26Total, activateTab, championsByOffice,
//   computeOfficeCounts, escHtml, fmtBudget, fmtMoney, getOfficesForPe,
//   getOfficesForSag, legislatorChipHtml, refreshDashboard,
//   renderOfficeBudgetPanel, renderOfficeOmPanel,
//   renderOfficeSuggestionsPanel, renderOffices, statusPill, toggle,
//   toggleOfficePriority.

// =================================================================
// the block references but the monolith never exposed on window.
// These shadow the monolith's consts cleanly: each is a re-lookup of
// the same DOM element, so identity-equality is preserved across the
// classic-script + module boundary.
// =================================================================
const modalBackdrop = document.getElementById('modalBackdrop');
const searchInput = document.getElementById('searchInput');

// ---------------------------------------------------------------
//  Side detail panel (preserved from v11, with link-row additions)
// ---------------------------------------------------------------
const panel = document.getElementById('detail-panel');
const panelTitle = panel.querySelector('.panel-title-text');
const panelSub = panel.querySelector('.panel-subtitle');
const panelBody = panel.querySelector('.panel-body');
const panelBadges = panel.querySelector('.panel-role-badges');
const panelCounters = panel.querySelector('.panel-counters');
const panelStar = panel.querySelector('.panel-star');
const panelRelated = document.getElementById('panel-related');
const panelBudget = document.getElementById('panel-budget');
let currentCard = null;
// _panelMode = 'card' | 'sol' | null (closed). _currentSolId is
// the active sol record id while _panelMode === 'sol'.
let _panelMode = null;
let _currentSolId = null;
let _currentContactId = null;

function getCardTitle(card) { const t = card.querySelector('.pae-title'); if (t) return t.textContent.trim(); const o = card.querySelector('.ousw-head'); if (o) return o.textContent.trim(); /* v134 */ const m = card.querySelector('.mini-title'); return m ? m.textContent.trim() : ''; }
function getCardLead(card) { const l = card.querySelector('.pae-lead'); if (l) return l.textContent.trim(); const s = card.querySelector('.ousw-sub'); if (s) return s.textContent.trim(); /* v134 */ const off = card.dataset && card.dataset.officeId ? (typeof DB !== 'undefined' && DB.get && DB.get('offices', card.dataset.officeId)) : null; return off ? (off.fullName || off.short_description || '') : ''; }

function openDetailPanel(card) {
  if (!card) return;
  // drawer collapses it. Pairs with the click-outside handler
  // wired at the tail of this module (which skips clicks inside
  // a card so the card click handler reaches this function).
  if (currentCard === card && panel.classList.contains('open')) {
    closeDetailPanel();
    return;
  }
  _panelMode = 'card';
  _currentSolId = null;
  _currentContactId = null;
  panelStar.style.display = '';
  currentCard = card;
  panelTitle.textContent = getCardTitle(card);
  panelSub.textContent = getCardLead(card);
  const badges = card.querySelector('.role-badges');
  panelBadges.innerHTML = badges ? badges.outerHTML : '';
  const counters = card.querySelector('.counter-tags');
  panelCounters.innerHTML = counters ? counters.outerHTML : '';
  const body = card.querySelector('.pae-body, .ousw-body');
  panelBody.innerHTML = body ? body.innerHTML : '';
  panelBody.querySelectorAll('.xref').forEach(link => {
    link.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = document.getElementById(link.dataset.target);
      if (!target) return;
      openDetailPanel(target);
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
  // Add live link rows for the office's records
  const officeId = card.dataset.officeId || card.id;
  const office = DB.get('offices', officeId);
  if (office) {
    const counts = computeOfficeCounts()[office.id] || {};
    const champCount = (championsByOffice()[office.id] || 0);
    const rels = [];
    if (counts.contacts)      rels.push('<div class="rel-link-row">' + counts.contacts + ' contact' + (counts.contacts===1?'':'s') + ' · <a data-jump="contacts">view in Contacts →</a></div>');
    if (champCount)           rels.push('<div class="rel-link-row">' + champCount + ' champion' + (champCount===1?'':'s') + ' · <a data-jump="contacts" data-champ="1">view in Contacts →</a></div>');
    if (counts.solicitations) rels.push('<div class="rel-link-row">' + counts.solicitations + ' solicitation' + (counts.solicitations===1?'':'s') + ' · <a data-jump="solicitations">view in Solicitations →</a></div>');
    if (counts.los)           rels.push('<div class="rel-link-row">' + counts.los + ' letter' + (counts.los===1?'':'s') + ' of support · <a data-jump="letters">view in Letters →</a></div>');
    if (counts.contracts)     rels.push('<div class="rel-link-row">' + counts.contracts + ' awarded contract' + (counts.contracts===1?'':'s') + ' · <a data-jump="solicitations" data-won="1">view in Solicitations →</a></div>');
    rels.push('<div class="rel-link-row" style="margin-top:6px;border-top:1px dashed var(--border);padding-top:6px;"><a data-jump="offices">Edit office record →</a></div>');
    panelRelated.innerHTML = '<div class="detail-label" style="margin-bottom:6px;">CRM links</div>' + rels.join('');
    panelRelated.style.display = '';
    panelRelated.querySelectorAll('a[data-jump]').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        closeDetailPanel();
        if (a.dataset.jump === 'offices') { activateTab('offices'); editOffice(office.id); }
        else {
          const opts = { officeId: office.id };
          if (a.dataset.champ === '1') opts.championsOnly = true;
          if (a.dataset.won === '1') opts.wonOnly = true;
          activateTab(a.dataset.jump, opts);
        }
      });
    });
    (function _appendOfficeContacts(){
      try {
        var _contacts = DB.list('contacts').filter(function(c){ return (c.officeIds||[]).indexOf(office.id) >= 0; });
        _contacts.sort(function(a,b){
          return (b.champion?1:0) - (a.champion?1:0)
              || (a.lastName||'').localeCompare(b.lastName||'');
        });
        var _ch = '<div class="rel-block" style="margin-top:10px;">'
                + '<div class="detail-label" style="margin-bottom:4px;">Contacts (' + _contacts.length + ')</div>';
        if (_contacts.length === 0) {
          _ch += '<div style="color:var(--text-muted);">None on file.</div>';
        } else {
          var _scroll = _contacts.length > 10 ? 'max-height:320px;overflow-y:auto;padding-right:4px;' : '';
          _ch += '<div style="display:flex;flex-direction:column;gap:3px;' + _scroll + '">'
              + _contacts.map(function(c){
                  return '<a class="rel-link-row" data-office-contact="' + escHtml(c.id) + '" style="display:block;cursor:pointer;">'
                      + (c.champion ? '<span title="Champion" style="color:var(--accent);">★</span> ' : '')
                      + '<strong>' + escHtml(((c.firstName||'') + ' ' + (c.lastName||'')).trim()) + '</strong>'
                      + (c.title ? ' <span style="color:var(--text-muted);font-size:11px;">· ' + escHtml(c.title) + '</span>' : '')
                      + '</a>';
                }).join('')
              + '</div>';
        }
        _ch += '</div>';
        panelBody.insertAdjacentHTML('beforeend', _ch);
        panelBody.querySelectorAll('a[data-office-contact]').forEach(function(a){
          a.addEventListener('click', function(e){
            e.preventDefault(); e.stopPropagation();
            var cid = a.getAttribute('data-office-contact');
            closeDetailPanel();
            activateTab('contacts');
            if (typeof openContactDetailPanel === 'function') openContactDetailPanel(cid);
          });
        });
      } catch (e) { console.error('[office-panel-contacts] render failed:', e); }
    })();
    // panel body as compact rel-blocks. All three are no-ops when the
    // underlying data is absent so existing offices render unchanged.
    (function _appendV97OfficeBlocks(){
      try {
        // TRL band
        if (office.trl_min != null || office.trl_max != null) {
          var lo = office.trl_min != null ? Number(office.trl_min) : null;
          var hi = office.trl_max != null ? Number(office.trl_max) : null;
          var label = (lo != null && hi != null && lo === hi) ? ('TRL ' + lo)
                    : (lo != null && hi != null) ? ('TRL ' + lo + '\u2013' + hi)
                    : (lo != null) ? ('TRL ' + lo + '+')
                    : ('up to TRL ' + hi);
          panelBody.insertAdjacentHTML('beforeend',
            '<div class="rel-block" style="margin-top:10px;">'
            + '<div class="detail-label" style="margin-bottom:4px;">Target TRL</div>'
            + '<div style="font-size:13px;"><strong>' + escHtml(label) + '</strong>'
            + ' <span style="color:var(--text-muted);font-size:11px;">target tech-readiness band this org buys / funds</span></div>'
            + '</div>');
        }
        // Parent linkage \u2014 only show when a parent_id resolves.
        if (office.parent_id) {
          var parent = DB.get('offices', office.parent_id);
          if (parent) {
            var parentTotal = (typeof _bovOfficeFy26Total === 'function') ? _bovOfficeFy26Total(parent) : 0;
            var selfTotal   = (typeof _bovOfficeFy26Total === 'function') ? _bovOfficeFy26Total(office) : 0;
            var moneyBit = (parentTotal > 0)
              ? (' <span style="color:var(--text-muted);font-size:11px;">parent ' + (window._v147Y ? window._v147Y(0) : 'FY26') + ' total: ' + fmtBudget(parentTotal)
                 + (selfTotal > 0 ? ' \u2192 this org: ' + fmtBudget(selfTotal) : '') + '</span>')
              : '';
            panelBody.insertAdjacentHTML('beforeend',
              '<div class="rel-block" style="margin-top:10px;">'
              + '<div class="detail-label" style="margin-bottom:4px;">\u2197 Funding flow / parent</div>'
              + '<div style="font-size:13px;">'
              + 'Sits under <a data-v97-parent-jump="' + escAttr(parent.id) + '" '
              + 'style="color:var(--accent);cursor:pointer;text-decoration:none;font-weight:600;">'
              + escHtml(parent.name || parent.id) + '</a>'
              + moneyBit
              + '</div></div>');
            var pj = panelBody.querySelector('[data-v97-parent-jump]');
            if (pj) pj.addEventListener('click', function(e){
              e.preventDefault(); e.stopPropagation();
              closeDetailPanel();
              if (typeof openOfficeDetailPanel === 'function') openOfficeDetailPanel(parent.id);
            });
          }
        }
        // Children indicator (inverse of parent).
        var _kids = DB.list('offices').filter(function(x){ return x && x.parent_id === office.id; });
        if (_kids.length) {
          panelBody.insertAdjacentHTML('beforeend',
            '<div class="rel-block" style="margin-top:10px;">'
            + '<div class="detail-label" style="margin-bottom:4px;">\u2198 Funding flow / children (' + _kids.length + ')</div>'
            + '<div style="display:flex;flex-wrap:wrap;gap:6px;font-size:12px;">'
            + _kids.map(function(k){
                var kt = (typeof _bovOfficeFy26Total === 'function') ? _bovOfficeFy26Total(k) : 0;
                return '<a data-v97-child-jump="' + escAttr(k.id) + '" '
                  + 'style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;background:var(--surface-alt);border:1px solid var(--border);border-radius:12px;cursor:pointer;color:var(--text);text-decoration:none;">'
                  + escHtml(k.name || k.id)
                  + (kt > 0 ? ' <span style="color:var(--text-muted);font-size:11px;">' + fmtBudget(kt) + '</span>' : '')
                  + '</a>';
              }).join('')
            + '</div></div>');
          panelBody.querySelectorAll('[data-v97-child-jump]').forEach(function(a){
            a.addEventListener('click', function(e){
              e.preventDefault(); e.stopPropagation();
              var cid = a.getAttribute('data-v97-child-jump');
              closeDetailPanel();
              if (typeof openOfficeDetailPanel === 'function') openOfficeDetailPanel(cid);
            });
          });
        }
        // Media library \u2014 thumbnails + filename links.
        var _media = (DB.list && DB.list('office_media') ? DB.list('office_media') : [])
          .filter(function(m){ return m && m.office_id === office.id; })
          .sort(function(a,b){ return String(b.uploaded_at||'').localeCompare(String(a.uploaded_at||'')); });
        if (_media.length) {
          var thumbs = _media.map(function(m){
            var isImg = /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(m.filename || m.media_url || '');
            return '<a href="' + escHtml(m.media_url) + '" target="_blank" rel="noopener" '
              + 'style="display:inline-block;border:1px solid var(--border);border-radius:6px;padding:4px;background:var(--surface);text-decoration:none;color:var(--text);max-width:140px;">'
              + (isImg
                  ? '<img src="' + escHtml(m.media_url) + '" alt="" style="display:block;max-width:130px;max-height:80px;object-fit:cover;border-radius:4px;">'
                  : '<div style="font-size:18px;color:var(--text-muted);text-align:center;">\u00b6</div>')
              + '<div style="font-size:10.5px;color:var(--text-muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escAttr(m.filename||'') + '">'
              + escHtml(m.filename || '(file)') + '</div>'
              + '</a>';
          }).join('');
          panelBody.insertAdjacentHTML('beforeend',
            '<div class="rel-block" style="margin-top:10px;">'
            + '<div class="detail-label" style="margin-bottom:4px;">Media (' + _media.length + ')</div>'
            + '<div style="display:flex;flex-wrap:wrap;gap:6px;">' + thumbs + '</div>'
            + '</div>');
        }
      } catch (e) { console.error('[v97-office-blocks] render failed:', e); }
    })();
    // the slide-out from opening (this fix is defensive — the
    // dataset bug it was guarding against has also been removed).
    if (typeof renderOfficeBudgetPanel === 'function') {
      try { renderOfficeBudgetPanel(office); }
      catch (e) { console.error('[panel-budget] render failed:', e); }
    }
    if (typeof renderOfficeOmPanel === 'function') {
      try { renderOfficeOmPanel(office); }
      catch (e) { console.error('[panel-om] render failed:', e); }
    }
    if (typeof renderOfficeSuggestionsPanel === 'function') {
      try { renderOfficeSuggestionsPanel(office); }
      catch (e) { console.error('[renderOfficeSuggestionsPanel] crashed (continuing without):', e); }
    }
  } else {
    panelRelated.innerHTML = '';
    panelRelated.style.display = 'none';
    if (typeof renderOfficeBudgetPanel === 'function') {
      try { renderOfficeBudgetPanel(null); }
      catch (e) { console.error('[panel-budget] hide failed:', e); }
    }
  }
  panelStar.classList.toggle('active', card.classList.contains('priority'));
  document.querySelectorAll('.card-active').forEach(c => c.classList.remove('card-active'));
  card.classList.add('card-active');
  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  document.body.classList.add('panel-open');
}
function openOfficeDetailPanel(officeId) {
  if (!officeId) return;
  var card = document.getElementById(officeId)
          || document.querySelector('[data-office-id="' + officeId + '"]');
  if (card) { openDetailPanel(card); return; }
  // No dashboard card (office hidden) — build a virtual one off-screen.
  var office = DB.get('offices', officeId);
  if (!office) { if (typeof editOffice === 'function') editOffice(officeId); return; }
  var v = document.getElementById('virtual-card-' + officeId);
  if (v) v.remove();
  v = document.createElement('div');
  v.id = officeId;
  v.className = 'pae-card virtual-office-card';
  v.dataset.officeId = officeId;
  v.style.cssText = 'position:absolute;left:-99999px;top:-99999px;visibility:hidden;';
  var titleEl = document.createElement('div');
  titleEl.className = 'pae-title';
  titleEl.textContent = office.name || office.fullName || officeId;
  v.appendChild(titleEl);
  var leadEl = document.createElement('div');
  leadEl.className = 'pae-lead';
  leadEl.textContent = office.fullName || office.short_description || '';
  v.appendChild(leadEl);
  var bodyEl = document.createElement('div');
  bodyEl.className = 'pae-body';
  var bodyParts = [];
  if (office.short_description) {
    bodyParts.push('<p>' + escHtml(office.short_description) + '</p>');
  }
  if (office.location) {
    bodyParts.push('<p><strong>Location:</strong> ' + escHtml(office.location) + '</p>');
  }
  if (office.department) {
    bodyParts.push('<p><strong>Service:</strong> ' + escHtml(office.department) + '</p>');
  }
  if (Array.isArray(office.tags) && office.tags.length) {
    bodyParts.push('<p><strong>Tags:</strong> ' + office.tags.map(escHtml).join(', ') + '</p>');
  }
  if (Array.isArray(office.leadership) && office.leadership.length) {
    bodyParts.push('<p><strong>Leadership:</strong> ' + office.leadership.map(escHtml).join(', ') + '</p>');
  }
  if (office.notes) {
    bodyParts.push('<p style="white-space:pre-wrap;">' + escHtml(office.notes) + '</p>');
  }
  if (!bodyParts.length) {
    bodyParts.push('<p style="color:var(--text-muted);">No description on file. Open <em>Edit</em> on the row to add details.</p>');
  }
  bodyEl.innerHTML = bodyParts.join('');
  v.appendChild(bodyEl);
  document.body.appendChild(v);
  openDetailPanel(v);
}

// Reuses the shared #detail-panel slide-out. Sectioned per office:
// each office contributes a Contacts list (excluding self, champions
// first) and a Solicitations list. The #panel-budget slot renders the
// primary (first) office's budget via renderOfficeBudgetPanel.
function openContactDetailPanel(contactId) {
  if (!contactId) return;
  const contact = DB.get('contacts', contactId);
  if (!contact) return;
  _panelMode = 'contact';
  _currentContactId = contactId;
  _currentSolId = null;
  currentCard = null;
  document.querySelectorAll('.card-active').forEach(c => c.classList.remove('card-active'));

  const officeIds = Array.isArray(contact.officeIds) ? contact.officeIds.slice() : [];
  const offices = officeIds.map(oid => DB.get('offices', oid)).filter(Boolean);
  const primaryOffice = offices[0] || null;

  // -- Header --
  const fullName = ((contact.firstName||'') + ' ' + (contact.lastName||'')).trim();
  const titleParts = [];
  if (contact.rank) titleParts.push(contact.rank);
  titleParts.push(fullName || '(unnamed contact)');
  if (contact.callsign) titleParts.push('”' + contact.callsign + '”');
  panelTitle.textContent = titleParts.join(' ');
  panelSub.innerHTML = contact.title ? escHtml(contact.title) : '';

  // Badges: champion star + office chips + legislator chip.
  const badges = [];
  if (contact.champion) badges.push('<span class=”pill” style=”background:var(--priority-bg, #4d3a14);color:var(--priority, #f3b13c);”>★ Champion</span>');
  offices.forEach(o => {
    badges.push('<a class=”chip chip-office” data-contact-office=”' + escHtml(o.id) + '”>' + escHtml(o.name || o.id) + '</a>');
  });
  if (contact.legislator_bioguide_id) {
    const _legBadge = legislatorChipHtml(contact.legislator_bioguide_id);
    if (_legBadge) badges.push(_legBadge);
  }
  panelBadges.innerHTML = badges.join(' ');
  panelCounters.innerHTML = '';

  // -- Body --
  let html = '';

  // ── Contact card ────────────────────────────────────────────
  html += '<div class=”rel-block” style=”display:flex;gap:14px;align-items:flex-start;margin-bottom:4px;”>';
  // Avatar: initials as base layer; proxy img on top (same-origin avoids CORS/tracking-prevention)
  const _initials = ((contact.firstName||'').charAt(0) + (contact.lastName||'').charAt(0)).toUpperCase() || '?';
  const _proxyPhotoSrc = contact.photoUrl
    ? '/.netlify/functions/photo-proxy?url=' + encodeURIComponent(contact.photoUrl)
    : '';
  const _dq = String.fromCharCode(34);
  const _imgTag = _proxyPhotoSrc
    ? '<img src=' + _dq + _proxyPhotoSrc + _dq + ' loading=' + _dq + 'eager' + _dq + ' alt=' + _dq + _dq + ' style=' + _dq + 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;' + _dq + ' onerror=' + _dq + 'this.style.display=\'none\'' + _dq + '>'
    : '';
  html += '<div style=\'position:relative;width:144px;height:144px;border-radius:50%;border:2px solid var(--border);flex-shrink:0;overflow:hidden;background:var(--surface-alt);\'>'
    + '<div style=\'position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:44px;font-weight:700;color:var(--text-muted);\'>' + escHtml(_initials) + '</div>'
    + _imgTag
    + '</div>';
  // Info block
  html += '<div style=”flex:1;min-width:0;”>';
  if (contact.org || contact.department) {
    html += '<div style=”font-size:12px;color:var(--text-muted);margin-bottom:6px;”>'
      + escHtml([contact.org, contact.department].filter(Boolean).join(' · '))
      + '</div>';
  }
  // Contact rows
  const _contactRows = [];
  if (contact.email) _contactRows.push(
    '<div style=”display:flex;align-items:center;gap:7px;font-size:13px;margin-bottom:5px;”>'
    + '<span style=”color:var(--text-muted);font-size:11px;width:40px;flex-shrink:0;”>EMAIL</span>'
    + '<a href=”mailto:' + escHtml(contact.email) + '” style=”color:var(--accent);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;”>' + escHtml(contact.email) + '</a>'
    + '</div>'
  );
  if (contact.phone) _contactRows.push(
    '<div style=”display:flex;align-items:center;gap:7px;font-size:13px;margin-bottom:5px;”>'
    + '<span style=”color:var(--text-muted);font-size:11px;width:40px;flex-shrink:0;”>PHONE</span>'
    + '<a href=”tel:' + escHtml(contact.phone) + '” style=”color:var(--accent);text-decoration:none;”>' + escHtml(contact.phone) + '</a>'
    + '</div>'
  );
  if (contact.linkedinUrl) {
    const luFull = /^https?:\/\//i.test(contact.linkedinUrl) ? contact.linkedinUrl : ('https://' + contact.linkedinUrl);
    _contactRows.push(
      '<div style=”display:flex;align-items:center;gap:7px;font-size:13px;margin-bottom:5px;”>'
      + '<span style=”color:var(--text-muted);font-size:11px;width:40px;flex-shrink:0;”>LI</span>'
      + '<a href=”' + escHtml(luFull) + '” target=”_blank” rel=”noopener” style=”color:var(--accent);text-decoration:none;”>LinkedIn profile</a>'
      + '</div>'
    );
  }
  if (contact.notes) _contactRows.push(
    '<div style=”font-size:12px;color:var(--text-muted);margin-top:4px;white-space:pre-wrap;line-height:1.4;”>' + escHtml(contact.notes) + '</div>'
  );
  html += _contactRows.join('') || '<div style=”color:var(--text-muted);font-size:12px;”>No contact details on file.</div>';
  html += '</div></div>'; // close info + card

  if (offices.length === 0 && !contact.org) {
    html += '<div class=”rel-block”><div style=”color:var(--text-muted);font-size:12px;”>No offices linked to this contact.</div></div>';
  } else {
    offices.forEach(office => {
      const otherContacts = DB.list('contacts')
        .filter(c => c.id !== contact.id && (c.officeIds||[]).includes(office.id));
      otherContacts.sort((a,b) => (b.champion?1:0) - (a.champion?1:0)
        || (a.lastName||'').localeCompare(b.lastName||''));
      const sols = DB.list('solicitations').filter(x => x.officeId === office.id);

      html += '<div class="rel-block" style="margin-bottom:10px;">';
      // Office header.
      html += '<div class="detail-label" style="margin-bottom:6px;">Office</div>';
      html += '<div style="margin-bottom:8px;"><a class="chip chip-office" data-contact-office="' + escHtml(office.id) + '">' + escHtml(office.name || office.id) + '</a>'
           +  (office.fullName ? ' <span style="color:var(--text-muted);font-size:11px;">' + escHtml(office.fullName) + '</span>' : '')
           +  '</div>';
      // Other contacts at this office. v70: scroll when > 10.
      html += '<div class="detail-label" style="margin-bottom:4px;">Other contacts at this office (' + otherContacts.length + ')</div>';
      if (otherContacts.length === 0) {
        html += '<div style="color:var(--text-muted);margin-bottom:8px;">None on file.</div>';
      } else {
        const _ocScroll = otherContacts.length > 10 ? 'max-height:320px;overflow-y:auto;padding-right:4px;' : '';
        html += '<div style="display:flex;flex-direction:column;gap:3px;margin-bottom:8px;' + _ocScroll + '">'
             + otherContacts.map(c =>
                 '<a class="rel-link-row" data-contact-jump="' + escHtml(c.id) + '" style="display:block;cursor:pointer;">'
                 + (c.champion ? '<span title="Champion" style="color:var(--accent);">★</span> ' : '')
                 + '<strong>' + escHtml(((c.firstName||'') + ' ' + (c.lastName||'')).trim()) + '</strong>'
                 + (c.title ? ' <span style="color:var(--text-muted);font-size:11px;">· ' + escHtml(c.title) + '</span>' : '')
                 + '</a>'
               ).join('')
             + '</div>';
      }
      // Solicitations at this office.
      html += '<div class="detail-label" style="margin-bottom:4px;">Solicitations at this office (' + sols.length + ')</div>';
      if (sols.length === 0) {
        html += '<div style="color:var(--text-muted);">None.</div>';
      } else {
        html += '<div style="display:flex;flex-direction:column;gap:3px;">'
             + sols.map(x =>
                 '<a class="rel-link-row" data-contact-sol-jump="' + escHtml(x.id) + '" style="display:block;cursor:pointer;">'
                 + '<strong>' + escHtml(x.title || '(untitled)') + '</strong> '
                 + statusPill(x.status)
                 + (x.value ? ' <span style="color:var(--text-muted);font-size:11px;">· ' + fmtMoney(x.value) + '</span>' : '')
                 + '</a>'
               ).join('')
             + '</div>';
      }
      html += '</div>';
    });
  }
  panelBody.innerHTML = html;

  // -- Body link wiring --
  panelBody.querySelectorAll('a[data-contact-office]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const oid = a.getAttribute('data-contact-office');
      closeDetailPanel();
      if (typeof openOfficeDetailPanel === 'function') openOfficeDetailPanel(oid);
    });
  });
  panelBadges.querySelectorAll('a[data-contact-office]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const oid = a.getAttribute('data-contact-office');
      closeDetailPanel();
      if (typeof openOfficeDetailPanel === 'function') openOfficeDetailPanel(oid);
    });
  });
  panelBadges.querySelectorAll('[data-legislator-jump]').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const bg = el.getAttribute('data-legislator-jump');
      closeDetailPanel();
      if (typeof activateTab === 'function') activateTab('washops');
      const sub = document.querySelector('.subtab-btn[data-subtab="washops-members"]');
      if (sub) sub.click();
      const m = legislatorById(bg);
      const search = document.getElementById('hillMSearch');
      if (search && m) {
        search.value = m.full_name || m.last_name || '';
        try { search.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      }
    });
  });
  panelBody.querySelectorAll('a[data-contact-jump]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const cid = a.getAttribute('data-contact-jump');
      // Re-open panel for the other contact -- keeps user in flow.
      openContactDetailPanel(cid);
    });
  });
  panelBody.querySelectorAll('a[data-contact-sol-jump]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const sid = a.getAttribute('data-contact-sol-jump');
      openSolDetailPanel(sid);
    });
  });

  // -- Budget: primary office only (single-slot #panel-budget). --
  if (typeof renderOfficeBudgetPanel === 'function') {
    try { renderOfficeBudgetPanel(primaryOffice); }
    catch (e) { console.error('[contact-panel-budget] render failed:', e); }
  }

  // -- Engagement history section --
  (function _appendEngagements() {
    try {
      const engs = (DB.list('engagements') || [])
        .filter(e => e && e.contact_id === contactId)
        .sort((a, b) => String(b.engaged_at || '').localeCompare(String(a.engaged_at || '')));
      let eHtml = '<div class="rel-block" style="margin-top:10px;" id="eng-history-block">';
      eHtml += '<div class="detail-label" style="margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;">'
        + '<span>Engagement History (' + engs.length + ')</span>'
        + '<button id="btnLogEngInPanel" style="font-size:11px;padding:2px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface-alt);cursor:pointer;color:var(--text);">+ Log</button>'
        + '</div>';
      if (engs.length === 0) {
        eHtml += '<div style="color:var(--text-muted);font-size:12px;">No engagements logged yet.</div>';
      } else {
        eHtml += '<div style="display:flex;flex-direction:column;gap:6px;' + (engs.length > 5 ? 'max-height:260px;overflow-y:auto;' : '') + '">';
        engs.forEach(e => {
          eHtml += '<div style="border-left:3px solid var(--border);padding-left:8px;position:relative;" data-eng-id="' + escHtml(e.id) + '">'
            + '<div style="font-size:11px;font-weight:600;color:var(--text-muted);display:flex;align-items:center;gap:8px;">'
            + escHtml(e.engaged_at || '')
            + '<button data-del-eng="' + escHtml(e.id) + '" title="Remove this engagement" style="font-size:10px;padding:0 4px;border:1px solid var(--border);border-radius:3px;background:none;cursor:pointer;color:var(--text-muted);line-height:16px;">✕</button>'
            + '</div>'
            + (e.notes ? '<div style="font-size:12px;color:var(--text);margin-top:2px;white-space:pre-wrap;">' + escHtml(e.notes) + '</div>' : '')
            + '</div>';
        });
        eHtml += '</div>';
      }
      eHtml += '</div>';
      panelBody.insertAdjacentHTML('beforeend', eHtml);

      const logBtn = panelBody.querySelector('#btnLogEngInPanel');
      if (logBtn) {
        logBtn.addEventListener('click', e => {
          e.stopPropagation();
          _openLogEngagementModal(contactId);
        });
      }

      panelBody.querySelectorAll('[data-del-eng]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const engId = btn.getAttribute('data-del-eng');
          DB.remove('engagements', engId);
          // Recalculate last_engaged_at from remaining engagements
          const remaining = (DB.list('engagements') || []).filter(x => x.contact_id === contactId);
          const latest = remaining.reduce((max, x) => (!max || x.engaged_at > max) ? x.engaged_at : max, null);
          const c = DB.get('contacts', contactId);
          if (c) DB.upsert('contacts', Object.assign({}, c, { last_engaged_at: latest || null }));
          openContactDetailPanel(contactId); // re-render panel
        });
      });
    } catch (err) { console.error('[engagement-panel] render failed:', err); }
  })();

  // -- Related actions --
  const rels = [];
  rels.push('<div class="rel-link-row"><a data-contact-edit="' + escHtml(contact.id) + '">Edit contact →</a></div>');
  if (offices.length > 1 && primaryOffice) {
    rels.push('<div class="rel-link-row" style="color:var(--text-muted);font-size:11px;">Budget shown above is for primary office (' + escHtml(primaryOffice.name || primaryOffice.id) + ').</div>');
  }
  panelRelated.innerHTML = '<div class="detail-label" style="margin-bottom:6px;">Actions</div>' + rels.join('');
  panelRelated.style.display = '';
  panelRelated.querySelectorAll('a[data-contact-edit]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const cid = a.getAttribute('data-contact-edit');
      closeDetailPanel();
      editContact(cid);
    });
  });

  // Hide priority star -- contacts have no priority concept.
  panelStar.style.display = 'none';

  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  document.body.classList.add('panel-open');
}

// Reuses the shared #detail-panel slide-out (same DOM as office mode).
// Renders 4 sections: office, contacts (champions-first), sibling sols
// from the same office, and budget (via renderOfficeBudgetPanel).
function openSolDetailPanel(solId) {
  if (!solId) return;
  const sol = DB.get('solicitations', solId);
  if (!sol) return;
  _panelMode = 'sol';
  _currentSolId = solId;
  // Sols don't share office-card visual state; clear card mode.
  currentCard = null;
  document.querySelectorAll('.card-active').forEach(c => c.classList.remove('card-active'));

  const office = sol.officeId ? DB.get('offices', sol.officeId) : null;

  // -- Header --
  panelTitle.textContent = sol.title || '(untitled solicitation)';
  const subParts = [];
  if (sol.type) subParts.push(escHtml(sol.type));
  if (sol.phase) subParts.push(escHtml(sol.phase));
  if (sol.value) subParts.push(fmtMoney(sol.value));
  let dateBit = '';
  if (sol.status === 'Won' && sol.awardDate) dateBit = 'Awarded ' + escHtml(sol.awardDate);
  else if (sol.openDate || sol.dueDate) dateBit = (sol.openDate || '?') + ' → ' + (sol.dueDate || '?');
  if (dateBit) subParts.push(dateBit);
  panelSub.innerHTML = subParts.join(' · ');
  panelBadges.innerHTML = sol.status ? statusPill(sol.status) : '';
  panelCounters.innerHTML = '';

  // -- Body: office, contacts, sibling sols (budget is its own slot below) --
  let html = '';

  // 1. Office
  html += '<div class="rel-block"><div class="detail-label" style="margin-bottom:4px;">Office</div>';
  if (office) {
    html += '<div><a class="chip chip-office" data-sol-office="' + escHtml(office.id) + '">'
         +  escHtml(office.name || office.id) + '</a>'
         +  (office.fullName ? ' <span style="color:var(--text-muted);font-size:11px;">' + escHtml(office.fullName) + '</span>' : '')
         +  '</div>';
  } else {
    html += '<div style="color:var(--text-muted);">No office assigned.</div>';
  }
  html += '</div>';

  // 1b. v97: PDF attachments \u2014 sol PDF + our submission PDF.
  if (sol.pdf_url || sol.submission_pdf_url) {
    html += '<div class="rel-block"><div class="detail-label" style="margin-bottom:4px;">Attachments</div>'
         +  '<div style="display:flex;flex-direction:column;gap:4px;font-size:12px;">';
    if (sol.pdf_url) {
      html += '<a href="' + escHtml(sol.pdf_url) + '" target="_blank" rel="noopener" '
           +  'style="color:var(--accent);text-decoration:none;">'
           +  '\u00b6 Solicitation PDF <span style="color:var(--text-muted);font-size:11px;">'
           +  escHtml(sol.pdf_filename || '') + '</span></a>';
    }
    if (sol.submission_pdf_url) {
      html += '<a href="' + escHtml(sol.submission_pdf_url) + '" target="_blank" rel="noopener" '
           +  'style="color:var(--accent);text-decoration:none;">'
           +  '\u00b6 Our Submission PDF <span style="color:var(--text-muted);font-size:11px;">'
           +  escHtml(sol.submission_pdf_filename || '') + '</span></a>';
    }
    html += '</div></div>';
  }

  // 2. Contacts (champions first) -- v70: scroll when > 10.
  if (office) {
    const contacts = DB.list('contacts').filter(c => (c.officeIds||[]).includes(office.id));
    contacts.sort((a,b) => (b.champion?1:0) - (a.champion?1:0)
      || (a.lastName||'').localeCompare(b.lastName||''));
    html += '<div class="rel-block"><div class="detail-label" style="margin-bottom:4px;">Contacts (' + contacts.length + ')</div>';
    if (contacts.length === 0) {
      html += '<div style="color:var(--text-muted);">None on file.</div>';
    } else {
      const _scroll = contacts.length > 10 ? 'max-height:320px;overflow-y:auto;padding-right:4px;' : '';
      html += '<div style="display:flex;flex-direction:column;gap:3px;' + _scroll + '">'
           + contacts.map(c =>
               '<a class="rel-link-row" data-sol-contact="' + escHtml(c.id) + '" style="display:block;cursor:pointer;">'
               + (c.champion ? '<span title="Champion" style="color:var(--accent);">★</span> ' : '')
               + '<strong>' + escHtml(((c.firstName||'') + ' ' + (c.lastName||'')).trim()) + '</strong>'
               + (c.title ? ' <span style="color:var(--text-muted);font-size:11px;">· ' + escHtml(c.title) + '</span>' : '')
               + '</a>'
             ).join('')
           + '</div>';
    }
    html += '</div>';
  }

  // 3. Other sols from the same office
  if (office) {
    const siblings = DB.list('solicitations').filter(x => x.officeId === office.id && x.id !== sol.id);
    html += '<div class="rel-block"><div class="detail-label" style="margin-bottom:4px;">Other solicitations from this office (' + siblings.length + ')</div>';
    if (siblings.length === 0) {
      html += '<div style="color:var(--text-muted);">None.</div>';
    } else {
      html += '<div style="display:flex;flex-direction:column;gap:3px;">'
           + siblings.map(x =>
               '<a class="rel-link-row" data-sol-jump="' + escHtml(x.id) + '" style="display:block;cursor:pointer;">'
               + '<strong>' + escHtml(x.title || '(untitled)') + '</strong> '
               + statusPill(x.status)
               + (x.value ? ' <span style="color:var(--text-muted);font-size:11px;">· ' + fmtMoney(x.value) + '</span>' : '')
               + '</a>'
             ).join('')
           + '</div>';
    }
    html += '</div>';
  }

  panelBody.innerHTML = html;

  // -- Body link wiring --
  panelBody.querySelectorAll('a[data-sol-office]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const oid = a.getAttribute('data-sol-office');
      closeDetailPanel();
      if (typeof openOfficeDetailPanel === 'function') openOfficeDetailPanel(oid);
    });
  });
  panelBody.querySelectorAll('a[data-sol-contact]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const cid = a.getAttribute('data-sol-contact');
      closeDetailPanel();
      activateTab('contacts');
      if (typeof openContactDetailPanel === 'function') openContactDetailPanel(cid);
    });
  });
  panelBody.querySelectorAll('a[data-sol-jump]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const sid = a.getAttribute('data-sol-jump');
      // Re-open the panel for the sibling -- keeps the user in flow.
      openSolDetailPanel(sid);
    });
  });

  // -- 4. Budget -- reuse the office budget renderer (same #panel-budget). --
  if (typeof renderOfficeBudgetPanel === 'function') {
    try { renderOfficeBudgetPanel(office); }
    catch (e) { console.error('[sol-panel-budget] render failed:', e); }
  }
  if (typeof renderOfficeOmPanel === 'function') {
    try { renderOfficeOmPanel(office); }
    catch (e) { console.error('[sol-panel-om] render failed:', e); }
  }

  // -- Related actions --
  const rels = [];
  rels.push('<div class="rel-link-row"><a data-sol-edit="' + escHtml(sol.id) + '">Edit solicitation →</a></div>');
  if (office) {
    rels.push('<div class="rel-link-row"><a data-sol-list="' + escHtml(office.id) + '">View all sols for ' + escHtml(office.name || office.id) + ' →</a></div>');
  }
  panelRelated.innerHTML = '<div class="detail-label" style="margin-bottom:6px;">Actions</div>' + rels.join('');
  panelRelated.style.display = '';
  panelRelated.querySelectorAll('a[data-sol-edit]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const sid = a.getAttribute('data-sol-edit');
      closeDetailPanel();
      editSol(sid);
    });
  });
  panelRelated.querySelectorAll('a[data-sol-list]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const oid = a.getAttribute('data-sol-list');
      closeDetailPanel();
      activateTab('solicitations', { officeId: oid });
    });
  });

  // Hide priority star -- solicitations have no priority concept.
  panelStar.style.display = 'none';

  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  document.body.classList.add('panel-open');
}

// in the Budget Hierarchy view to open this. Shows the linked offices,
// the contacts at those offices (champions-first), and the solicitations
// at those offices. Read-only — no edit affordances.
function openBudgetItemPanel(itemId, isSag) {
  if (!itemId) return;
  var rec, title, codeStr, fy26, fy25, fy24, kindLabel;
  if (isSag) {
    rec = DB.get('budget_om_sags', itemId);
    if (!rec) return;
    title = rec.sag_title || rec.id;
    codeStr = rec.sag_short_code || rec.id;
    fy26 = (window._v150SagAmt ? window._v150SagAmt(rec) : (Number(rec.fy26_estimate) || 0));
    fy25 = Number(rec.fy25_current) || 0;
    fy24 = Number(rec.fy24_enacted) || 0;
    kindLabel = 'O&M SAG';
  } else {
    rec = DB.get('budget_pes', itemId);
    if (!rec) return;
    title = rec.title || rec.id;
    codeStr = rec.id;
    fy26 = Number(rec.request_amount) || 0;
    fy25 = Number(rec.enacted_amount) || 0;
    fy24 = Number(rec.prior_year_amount) || 0;
    kindLabel = /^proc_/i.test(rec.appropriation_id || '') ? 'Procurement PE' : 'RDT&E PE';
  }
  _panelMode = 'budgetItem';
  _currentSolId = null;
  currentCard = null;
  document.querySelectorAll('.card-active').forEach(function(c){ c.classList.remove('card-active'); });

  // Resolve linked offices for this PE/SAG.
  var assigned = [];
  if (isSag) {
    if (typeof getOfficesForSag === 'function') assigned = getOfficesForSag(itemId);
  } else {
    if (typeof getOfficesForPe === 'function') assigned = getOfficesForPe(itemId);
  }
  var officeIds = assigned.map(function(a){ return a.office_id; });
  var officesById = {};
  (DB.list('offices') || []).forEach(function(o){ if (o && o.id) officesById[o.id] = o; });

  // Header
  panelTitle.textContent = title;
  panelSub.innerHTML = escHtml(kindLabel) + ' · <code>' + escHtml(codeStr) + '</code> · ' + (window._v147Y ? window._v147Y(0) : 'FY26') + ' ' + fmtBudget(fy26)
    + ' · ' + (window._v147Y ? window._v147Y(-1) : 'FY25') + ' ' + fmtBudget(fy25) + ' · ' + (window._v147Y ? window._v147Y(-2) : 'FY24') + ' ' + fmtBudget(fy24);
  panelBadges.innerHTML = rec.is_priority ? '<span class="status-pill" style="background:var(--priority);color:#fff;">★ Priority</span>' : '';
  panelCounters.innerHTML = '';

  // Body
  var html = '';
  // Offices
  html += '<div class="rel-block"><div class="detail-label" style="margin-bottom:4px;">Linked offices (' + assigned.length + ')</div>';
  if (assigned.length === 0) {
    html += '<div style="color:var(--text-muted);">No offices currently linked to this ' + (isSag ? 'SAG' : 'PE') + '.</div>';
  } else {
    html += '<div style="display:flex;flex-wrap:wrap;gap:6px;">'
      + assigned.map(function(a){
          return '<a class="chip chip-office" data-bp-office="' + escHtml(a.office_id) + '" style="cursor:pointer;">' + escHtml(a.officeName) + '</a>';
        }).join('') + '</div>';
  }
  html += '</div>';

  // Contacts at linked offices (champions-first, dedup by id)
  var contactSeen = {};
  var contactRows = [];
  officeIds.forEach(function(oid){
    DB.list('contacts').filter(function(c){ return (c.officeIds||[]).includes(oid); }).forEach(function(c){
      if (contactSeen[c.id]) return;
      contactSeen[c.id] = 1;
      contactRows.push({ c: c, officeName: (officesById[oid] && officesById[oid].name) || oid });
    });
  });
  contactRows.sort(function(a,b){
    return (b.c.champion?1:0) - (a.c.champion?1:0)
      || ((a.c.lastName||'').localeCompare(b.c.lastName||''));
  });
  html += '<div class="rel-block"><div class="detail-label" style="margin-bottom:4px;">Contacts at these offices (' + contactRows.length + ')</div>';
  if (contactRows.length === 0) {
    html += '<div style="color:var(--text-muted);">None on file.</div>';
  } else {
    var _scroll = contactRows.length > 10 ? 'max-height:320px;overflow-y:auto;padding-right:4px;' : '';
    html += '<div style="display:flex;flex-direction:column;gap:3px;' + _scroll + '">'
      + contactRows.map(function(r){
          return '<a class="rel-link-row" data-bp-contact="' + escHtml(r.c.id) + '" style="display:block;cursor:pointer;">'
            + (r.c.champion ? '<span title="Champion" style="color:var(--accent);">★</span> ' : '')
            + '<strong>' + escHtml(((r.c.firstName||'') + ' ' + (r.c.lastName||'')).trim()) + '</strong>'
            + (r.c.title ? ' <span style="color:var(--text-muted);font-size:11px;">· ' + escHtml(r.c.title) + '</span>' : '')
            + ' <span style="color:var(--text-muted);font-size:10.5px;">@ ' + escHtml(r.officeName) + '</span>'
            + '</a>';
        }).join('')
      + '</div>';
  }
  html += '</div>';

  // Solicitations at linked offices
  var solRows = [];
  var solSeen = {};
  officeIds.forEach(function(oid){
    DB.list('solicitations').filter(function(x){ return x.officeId === oid; }).forEach(function(x){
      if (solSeen[x.id]) return;
      solSeen[x.id] = 1;
      solRows.push({ s: x, officeName: (officesById[oid] && officesById[oid].name) || oid });
    });
  });
  solRows.sort(function(a,b){ return (Number(b.s.value)||0) - (Number(a.s.value)||0); });
  html += '<div class="rel-block"><div class="detail-label" style="margin-bottom:4px;">Solicitations at these offices (' + solRows.length + ')</div>';
  if (solRows.length === 0) {
    html += '<div style="color:var(--text-muted);">None.</div>';
  } else {
    html += '<div style="display:flex;flex-direction:column;gap:3px;">'
      + solRows.map(function(r){
          return '<a class="rel-link-row" data-bp-sol="' + escHtml(r.s.id) + '" style="display:block;cursor:pointer;">'
            + (r.s.is_priority ? '<span title="Priority" style="color:var(--priority);">★</span> ' : '')
            + '<strong>' + escHtml(r.s.title || '(untitled)') + '</strong> '
            + statusPill(r.s.status)
            + (r.s.value ? ' <span style="color:var(--text-muted);font-size:11px;">· ' + fmtMoney(r.s.value) + '</span>' : '')
            + ' <span style="color:var(--text-muted);font-size:10.5px;">@ ' + escHtml(r.officeName) + '</span>'
            + '</a>';
        }).join('')
      + '</div>';
  }
  html += '</div>';

  panelBody.innerHTML = html;

  // Wire body links
  panelBody.querySelectorAll('a[data-bp-office]').forEach(function(a){
    a.addEventListener('click', function(e){
      e.preventDefault(); e.stopPropagation();
      var oid = a.getAttribute('data-bp-office');
      closeDetailPanel();
      activateTab('offices');
      var card = document.querySelector('.office-card[data-id="' + (window.CSS && CSS.escape ? CSS.escape(oid) : oid) + '"]');
      if (card && typeof openDetailPanel === 'function') openDetailPanel(card);
    });
  });
  panelBody.querySelectorAll('a[data-bp-contact]').forEach(function(a){
    a.addEventListener('click', function(e){
      e.preventDefault(); e.stopPropagation();
      var cid = a.getAttribute('data-bp-contact');
      closeDetailPanel();
      activateTab('contacts');
      if (typeof openContactDetailPanel === 'function') openContactDetailPanel(cid);
    });
  });
  panelBody.querySelectorAll('a[data-bp-sol]').forEach(function(a){
    a.addEventListener('click', function(e){
      e.preventDefault(); e.stopPropagation();
      var sid = a.getAttribute('data-bp-sol');
      closeDetailPanel();
      activateTab('solicitations');
      if (typeof openSolDetailPanel === 'function') openSolDetailPanel(sid);
    });
  });

  // Hide priority star (the panel is read-only for budget items; toggle from
  // the row star in the hierarchy table).
  panelStar.style.display = 'none';
  panelRelated.innerHTML = '';
  panelRelated.style.display = 'none';

  panel.classList.add('open');
  panel.setAttribute('aria-hidden', 'false');
  document.body.classList.add('panel-open');
}

function closeDetailPanel() {
  panel.classList.remove('open');
  panel.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('panel-open');
  if (currentCard) currentCard.classList.remove('card-active');
  currentCard = null;
  // (sol mode hides it because solicitations have no priority concept).
  _panelMode = null;
  _currentSolId = null;
  _currentContactId = null;
  panelStar.style.display = '';
}
function navigatePanel(direction) {
  if (_panelMode === 'sol' && _currentSolId) {
    const rows = Array.from(document.querySelectorAll('#solTable tbody tr[data-id]'));
    const ids = rows.map(r => r.dataset.id);
    const sIdx = ids.indexOf(_currentSolId);
    if (sIdx === -1) return;
    const sNext = (sIdx + direction + ids.length) % ids.length;
    openSolDetailPanel(ids[sNext]);
    rows[sNext].scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (_panelMode === 'contact' && _currentContactId) {
    const rows = Array.from(document.querySelectorAll('#contactsTable tbody tr[data-id]'));
    const ids = rows.map(r => r.dataset.id);
    const cIdx = ids.indexOf(_currentContactId);
    if (cIdx === -1) return;
    const cNext = (cIdx + direction + ids.length) % ids.length;
    openContactDetailPanel(ids[cNext]);
    rows[cNext].scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (!currentCard) return;
  const visible = Array.from(document.querySelectorAll('.v98-tier-view-wrap .pae-card, .v98-tier-view-wrap .ousw-card'))
    .filter(c => !c.classList.contains('hidden') && c.offsetParent !== null);
  const idx = visible.indexOf(currentCard);
  if (idx === -1) return;
  const nextIdx = (idx + direction + visible.length) % visible.length;
  openDetailPanel(visible[nextIdx]);
  visible[nextIdx].scrollIntoView({ behavior: 'smooth', block: 'center' });
}
panel.querySelector('.panel-close').addEventListener('click', closeDetailPanel);
panel.querySelector('.panel-prev').addEventListener('click', () => navigatePanel(-1));
panel.querySelector('.panel-next').addEventListener('click', () => navigatePanel(1));
panelStar.addEventListener('click', () => {
  if (!currentCard) return;
  // Resolve the office record from the card (data-office-id falls back to id).
  const officeId = currentCard.dataset.officeId || currentCard.id;
  const o = DB.get('offices', officeId);
  if (o) {
    toggleOfficePriority(o.id);
    // toggleOfficePriority has already toggled DOM class on any matching
    // dashboard card. Reflect the new state on currentCard + the star button.
    const now = !!(DB.get('offices', o.id) || {}).priority;
    currentCard.classList.toggle('priority', now);
    panelStar.classList.toggle('active', now);
  } else {
    // Fallback: DOM-only toggle (keeps old behavior if no matching record).
    currentCard.classList.toggle('priority');
    panelStar.classList.toggle('active', currentCard.classList.contains('priority'));
    refreshDashboard();
    if (document.getElementById('tab-offices').classList.contains('active')) renderOffices();
  }
});

document.addEventListener('keydown', (e) => {
  if (modalBackdrop.classList.contains('open')) return;
  if (!panel.classList.contains('open')) {
    if (e.key === '/' && document.activeElement !== searchInput) {
      e.preventDefault(); searchInput.focus();
    }
    return;
  }
  if (e.target.matches('input, textarea')) return;
  if (e.key === 'Escape') closeDetailPanel();
  else if (e.key === 'ArrowRight') navigatePanel(1);
  else if (e.key === 'ArrowLeft') navigatePanel(-1);
  else if (e.key === 'p' || e.key === 'P') { if (_panelMode !== 'sol' && _panelMode !== 'contact') panelStar.click(); }
});

document.querySelectorAll('.section-label').forEach(label => {
  const m = label.textContent.match(/^Tier (\d)(?!\()/);
  if (m) label.classList.add('tier-anchor');
  if (/^Tier 2\(a\)/.test(label.textContent)) label.classList.add('tier-anchor');
});


// ---------------------------------------------------------------
//  Log Engagement modal (called from contact detail panel)
// ---------------------------------------------------------------
function _openLogEngagementModal(contactId) {
  const contact = DB.get('contacts', contactId);
  const today = new Date().toISOString().slice(0, 10);
  const body = document.createElement('div');
  body.innerHTML =
    '<div style="margin-bottom:10px;">'
    + '<label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:3px;">Date</label>'
    + '<input id="eng-date" type="date" value="' + escHtml(today) + '" style="width:160px;font-size:13px;">'
    + '</div>'
    + '<div>'
    + '<label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:3px;">Notes</label>'
    + '<textarea id="eng-notes" rows="5" placeholder="What was discussed, outcomes, follow-ups…" style="width:100%;box-sizing:border-box;font-size:13px;"></textarea>'
    + '</div>';
  openModal({
    title: 'Log Engagement · ' + ((contact && ((contact.firstName||'') + ' ' + (contact.lastName||'')).trim()) || contactId),
    body,
    saveLabel: 'Save',
    table: null, id: null,
    onSave: () => {
      const date = (document.getElementById('eng-date').value || today).trim();
      const notes = (document.getElementById('eng-notes').value || '').trim();
      if (!date) { alert('Please enter a date.'); return; }
      const engId = 'eng_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      DB.upsert('engagements', { id: engId, contact_id: contactId, engaged_at: date, notes });
      // Update denormalized last_engaged_at on the contact if this date is newer
      const existing = DB.get('contacts', contactId);
      if (existing && (!existing.last_engaged_at || date > existing.last_engaged_at)) {
        DB.upsert('contacts', Object.assign({}, existing, { last_engaged_at: date }));
      }
      closeModal();
      openContactDetailPanel(contactId);
      if (typeof renderContacts === 'function') renderContacts();
    }
  });
  setTimeout(() => { const n = document.getElementById('eng-notes'); if (n) n.focus(); }, 50);
}

// =================================================================
// =================================================================
window.openDetailPanel = openDetailPanel;
window.openOfficeDetailPanel = openOfficeDetailPanel;
window.openContactDetailPanel = openContactDetailPanel;
window.openSolDetailPanel = openSolDetailPanel;
window.openBudgetItemPanel = openBudgetItemPanel;
window.closeDetailPanel = closeDetailPanel;
window.navigatePanel = navigatePanel;

// =================================================================
//   (1) Click outside drawer + outside any card-opener -> close.
//   (2) Click same card that opened drawer -> close (handled inside
//       openDetailPanel; see M1 mutation above).
//   (3) ESC key -> close.
// Tab-button clicks fall through (1) and close the drawer before the
// tab transition runs.
// =================================================================
(function _wireDrawerAutoClose() {
  if (!panel) return;
  // Click-outside (mousedown, capture). Fires before any other
  // click handler so the drawer collapses synchronously.
  document.addEventListener('mousedown', function(e) {
    if (!panel.classList.contains('open')) return;
    var target = e.target;
    if (!target || target.nodeType !== 1) return;
    if (panel.contains(target)) return;  // inside drawer -- ignore
    // Skip clicks inside any card-opener element. The card has its
    // own click handler that will call openDetailPanel(card), which
    // toggles when card === currentCard (M1) or replaces otherwise.
    if (target.closest('.pae-card, .ousw-card, .mini-card')) return;
    closeDetailPanel();
  }, true);
  // ESC key.
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && panel.classList.contains('open')) {
      closeDetailPanel();
    }
  });
})();
