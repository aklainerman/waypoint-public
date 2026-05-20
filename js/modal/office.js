// js/modal/office.js
//
// editOffice -- the Office editor modal. The v178 redesign consolidates
// the Tier control into a single dropdown (Show-on-Dashboard required
// first); roles are derived from tier on save via _TIER_TO_ROLES_V178
// (closure-local, defined inside the function). Legacy o.tier is
// mirrored from the new echelon dropdown so other code that still reads
// o.tier continues to work.
//
// Originally a file-scope function in the inline monolith; lifted to
// ES module in v190. Same classic-script-split pattern as v181-v189.
//
// This is also the Phase 1.3 target (componentize office modal). v190
// does a vanilla extraction; the deeper componentization (OfficeModal
// split into pure .open / .collect / .validate / .save functions) is
// a follow-up cleanup pass scheduled for after the surrounding helpers
// land as their own modules.
//
// Exposes on window:
//   window.editOffice  -- 8 external callers (Orgs > List View row
//                          actions, Hill drawer edit, btnAddOffice CTA,
//                          btnAddCongressOffice CTA, dashboard detail
//                          panel "Edit office" button, contact modal
//                          office pickers, etc.)
//
// Consumes from window (provided by the monolith + earlier modules):
//   DB, escHtml, escAttr, openModal, closeModal, field, fieldRow,
//   makeMultiSelect, makeSingleSelect, makeBudgetOrgPicker,
//   uploadIntoLettersBucket, refreshAll, _supaUpsert, _sb,
//   and other monolith file-scope helpers reached via global hoisting.

function editOffice(id) {
  const o = id ? Object.assign({}, DB.get('offices', id)) : {
    id:'', name:'', fullName:'',
    location:'', location_city:'', location_state:'', location_country:'',
    notes:'', tags:[],
    parent_id:'', department:'', roles:[], echelon:'',
    show_on_dashboard:false, priority:false, short_description:'',
    leadership:[],
    chamber:'', party:'', district:'', committees:[],
  };
  const body = document.createElement('div');

  // ---- Identity ----
  body.appendChild(field('Name (short)', '<input id="f-name" value="' + escHtml(o.name) + '">'));
  body.appendChild(field('Full Name', '<input id="f-fullName" value="' + escHtml(o.fullName||'') + '">'));
  body.appendChild(field('Tags (comma-separated)', '<input id="f-tags" value="' + escHtml((o.tags||[]).join(', ')) + '">'));

  // ---- Location (v48: split into city / state / country) ----
  // Backward-compat: when the structured fields are empty but the legacy
  // single-string `location` has a value, parse it to pre-populate inputs.
  // Heuristic: 2-letter ALL-CAPS final segment is treated as a US state code.
  const _structPresent = !!(o.location_city || o.location_state || o.location_country);
  let _initCity = o.location_city || '', _initState = o.location_state || '', _initCountry = o.location_country || '';
  if (!_structPresent && (o.location || '').trim()) {
    const _parts = (o.location || '').split(',').map(s => s.trim()).filter(Boolean);
    if (_parts.length === 1) {
      _initCity = _parts[0];
    } else if (_parts.length === 2) {
      _initCity = _parts[0];
      if (/^[A-Z]{2}$/.test(_parts[1])) _initState = _parts[1]; else _initCountry = _parts[1];
    } else {
      const _last = _parts[_parts.length - 1];
      if (/^[A-Z]{2}$/.test(_last)) {
        _initCity  = _parts.slice(0, -1).join(', ');
        _initState = _last;
      } else {
        _initCity    = _parts.slice(0, -2).join(', ');
        _initState   = _parts[_parts.length - 2];
        _initCountry = _last;
      }
    }
  }
  body.appendChild(fieldRow(
    field('City', '<input id="f-location-city" value="' + escHtml(_initCity) + '" placeholder="e.g. Fort Liberty">'),
    field('State', '<input id="f-location-state" value="' + escHtml(_initState) + '" placeholder="e.g. NC">')
  ));
  body.appendChild(field('Country', '<input id="f-location-country" value="' + escHtml(_initCountry) + '" placeholder="e.g. United States (leave blank for US)">', 'City, state, country. Combined for the Offices grid + map lookup.'));

  // ---- v97: Target TRL range ----
  // Two integer inputs, 1..9, where blank means "unspecified". A check
  // constraint at the DB level enforces max >= min when both are set.
  body.appendChild(fieldRow(
    field('Target TRL min',
      '<input id="f-trl-min" type="number" min="1" max="9" step="1" value="'
      + (o.trl_min != null && o.trl_min !== '' ? Number(o.trl_min) : '')
      + '" placeholder="1\u20139">'),
    field('Target TRL max',
      '<input id="f-trl-max" type="number" min="1" max="9" step="1" value="'
      + (o.trl_max != null && o.trl_max !== '' ? Number(o.trl_max) : '')
      + '" placeholder="1\u20139">',
      'TRL range this org typically buys / funds (e.g. 6\u20138 = late prototypes through fielded systems).'
    )
  ));

  // ---- Dashboard & Hierarchy ----
  const _sectDiv = document.createElement('div');
  _sectDiv.innerHTML = '<div class="detail-label" style="margin:14px 0 8px 0;border-top:1px solid var(--border);padding-top:12px;">Dashboard &amp; Hierarchy</div>';
  body.appendChild(_sectDiv);

  // Parent — searchable single-select (v47 replaces raw UUID input)
  const DEPT_SHORT = { af:'AF', army:'Army', navy:'Navy', marines:'Marines', socom:'SOCOM', osd:'OSD', joint:'Joint', congress:'Congress' };
  const parentBox = document.createElement('div'); parentBox.className = 'multi-select-box';
  body.appendChild(field('Parent Org', '', 'Pick a parent from the list. Leave blank for roots.'));
  body.lastChild.appendChild(parentBox);
  const parentOpts = (DB.state.offices || [])
    .filter(po => po.id_new && po.id !== o.id)
    .map(po => {
      const dk = String(po.department||'').toLowerCase();
      const deptSuffix = dk && DEPT_SHORT[dk] ? ' · ' + DEPT_SHORT[dk] : (po.department ? ' · ' + po.department : '');
      return { id: po.id_new, label: (po.name || po.id) + deptSuffix };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  const parentPicker = makeSingleSelect(parentBox, parentOpts, o.parent_id || '');

  // Show-on-Dashboard / Priority toggle row (see Patch 3 / new Tier block),
  // is widened to full row width, gets an expanded 1/2a/2b/2c/3/4/5 option
  // set, and is disabled until Show-on-Dashboard is checked. The Roles
  // checkbox row that previously lived between Tier and the toggle row is
  // deleted; roles are now derived from the Tier selection on save.
  const DEPTS = ['', 'af', 'army', 'navy', 'marines', 'socom', 'osd', 'joint', 'congress'];
  const DEPT_LABELS = { '': '(none)', af:'Air Force', army:'Army', navy:'Navy', marines:'Marines', socom:'SOCOM', osd:'OSD', joint:'Joint', congress:'Congress' };
  //
  // The data has two issues caught after v190.1 didn't fully work:
  //   1. o.department for existing orgs holds DISPLAY values ("Marines",
  //      "Joint", "OSD") instead of the lowercase codes the dropdown uses
  //      (DEPTS: "marines", "joint", "osd"). v190.1's o.department-first
  //      fallback didn't help because o.department WAS populated -- just
  //      with the wrong casing/format.
  //   2. Older orgs may have only o.service populated and o.department null.
  //
  // Map any reasonable display/code/abbreviation to the canonical lowercase
  // code. Try o.department first; fall back to o.service. Saves still write
  // the canonical code to o.department, so the data converges over time.
  const _toDeptCode = (s) => {
    const v = String(s || '').toLowerCase().trim();
    const M = {
      'air force':'af', 'space force':'af', 'af':'af', 'usaf':'af',
      'army':'army', 'da':'army', 'usa':'army',
      'navy':'navy', 'usn':'navy',
      'marines':'marines', 'usmc':'marines', 'marine corps':'marines',
      'socom':'socom', 'ussocom':'socom',
      'osd':'osd', 'diu':'osd', 'darpa':'osd', 'cdao':'osd',
      'joint':'joint', 'jcs':'joint',
      'congress':'congress', 'hill':'congress',
    };
    return M[v] || '';
  };
  const _initialDept = _toDeptCode(o.department) || _toDeptCode(o.service) || '';
  body.appendChild(field('Department',
    '<select id="f-department">' + DEPTS.map(d => '<option' + (d === _initialDept ? ' selected' : '') + ' value="' + escHtml(d) + '">' + escHtml(DEPT_LABELS[d]) + '</option>').join('') + '</select>'
  ));

  // derived from the consolidated Tier dropdown rendered below the
  // Show-on-Dashboard / Priority toggle row. See Patch 4 for the
  // tier→roles mapping applied on save.

  {
    const mkInlineToggle = (id, labelText, checked, extra) => {
      const div = document.createElement('div');
      div.className = 'field field-toggle-inline';
      // v178b: parent .field class sets flex-direction:column; we override
      // to row + content width so the checkbox + uppercase label sit on a
      // single line. flex:0 0 auto stops the toggle from expanding to half
      // the row (which was forcing the label into a 2-line wrap).
      div.style.cssText = 'flex:0 0 auto;display:flex;flex-direction:row;align-items:center;justify-content:flex-start;margin-bottom:12px;margin-right:28px;';
      div.innerHTML =
        '<label style="display:flex;align-items:center;gap:8px;font-family:var(--font-display);font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);cursor:pointer;margin:0;white-space:nowrap;">' +
          '<input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + ' style="margin:0;flex-shrink:0;width:auto;padding:0;border:0;background:transparent;height:auto;appearance:auto;-webkit-appearance:auto;">' +
          '<span style="white-space:nowrap;">' + labelText + (extra ? ' ' + extra : '') + '</span>' +
        '</label>';
      return div;
    };
    const row = document.createElement('div');
    row.className = 'field-row';
    row.style.cssText = 'justify-content:flex-start;';
    row.appendChild(mkInlineToggle('f-show_on_dashboard', 'Show on Dashboard', o.show_on_dashboard, ''));
    row.appendChild(mkInlineToggle('f-priority', 'Priority', o.priority, '\u2605'));
    body.appendChild(row);
  }

  // immediately below the Show-on-Dashboard / Priority toggles. Replaces
  // the narrow Department-paired Tier select + Roles checkbox row. The
  // dropdown is disabled (grayed out) until Show-on-Dashboard is checked,
  // since tier placement only matters for orgs that render on the Tier
  // View tab. N/A renders as a faux-placeholder italic-gray option so the
  // user can always return to "no tier" without re-enabling the control.
  const TIER_OPTIONS_V178 = [
    ['',   'N/A'],
    ['1',  '1. Strategy & Innovation Ecosystem \u2014 Roadmap Shapers and Co-Funders'],
    ['2a', '2a. Acquisition \u2014 Contract Authority & Program Budget'],
    ['2b', '2b. Rapid Capabilities Offices \u2014 Acquisition with Bypass Authority'],
    ['2c', '2c. Non-Traditional On Ramps \u2014 Werx & Innovation Hubs'],
    ['3',  '3. End Users & Force Providers \u2014 Demand Signal Generators'],
    ['4',  '4. Combatant Commands \u2014 Demand Arbiters'],
    ['5',  '5. Oversight \u2014 Authorization & Appropriations'],
  ];
  const _curTier_v178 = String(o.echelon || o.tier || '');
  const _tierSelectHtml_v178 =
    '<select id="f-echelon" style="width:100%;font-family:inherit;">' +
    TIER_OPTIONS_V178.map(function(pair){
      var val = pair[0], label = pair[1];
      var sel = (val === _curTier_v178) ? ' selected' : '';
      var sty = (val === '') ? ' style="color:var(--text-dim);font-style:italic;"' : '';
      return '<option value="' + escHtml(val) + '"' + sel + sty + '>' + escHtml(label) + '</option>';
    }).join('') +
    '</select>';
  body.appendChild(field(
    'Tier',
    _tierSelectHtml_v178,
    'Select the tier that best describes this org\u2019s role in the DoD outreach map. Enabled only when "Show on Dashboard" is checked.'
  ));
  // v178b: Validation closure. When Show-on-Dashboard is checked, both
  // Department and Tier MUST be non-empty. Invalid fields render with a
  // red border + faint red glow; valid fields revert to default styling.
  // Returns true iff the current state would allow save.
  function _validateV178() {
    var dashCb  = document.getElementById('f-show_on_dashboard');
    var deptSel = document.getElementById('f-department');
    var tierSel = document.getElementById('f-echelon');
    if (!dashCb || !deptSel || !tierSel) return true;
    var requireSelections = !!dashCb.checked;
    var deptOk = !requireSelections || (deptSel.value !== '');
    var tierOk = !requireSelections || (tierSel.value !== '');
    var redCol = '#d33';
    var redGlow = '0 0 0 2px rgba(221,51,51,0.20)';
    if (!deptOk) {
      deptSel.style.borderColor = redCol;
      deptSel.style.boxShadow   = redGlow;
    } else {
      deptSel.style.borderColor = '';
      deptSel.style.boxShadow   = '';
    }
    if (!tierOk) {
      tierSel.style.borderColor = redCol;
      tierSel.style.boxShadow   = redGlow;
    } else {
      tierSel.style.borderColor = '';
      tierSel.style.boxShadow   = '';
    }
    return deptOk && tierOk;
  }

  // Wire enable/disable + validation: gray the Tier dropdown out unless
  // Show-on-Dashboard is checked, and turn Department / Tier red if either
  // is empty while Show-on-Dashboard is checked. Sync immediately + on
  // every change so styling stays in lockstep with the UI state.
  (function _wireV178TierEnable(){
    var _dashCb  = document.getElementById('f-show_on_dashboard');
    var _tierSel = document.getElementById('f-echelon');
    var _deptSel = document.getElementById('f-department');
    function _syncTierEnabled() {
      var en = !!(_dashCb && _dashCb.checked);
      if (_tierSel) {
        _tierSel.disabled        = !en;
        _tierSel.style.opacity   = en ? '1' : '0.5';
        _tierSel.style.cursor    = en ? '' : 'not-allowed';
        _tierSel.title           = en ? '' : 'Enable "Show on Dashboard" above to choose a tier.';
      }
      _validateV178();
    }
    if (_dashCb)  _dashCb.addEventListener('change', _syncTierEnabled);
    if (_deptSel) _deptSel.addEventListener('change', _validateV178);
    if (_tierSel) _tierSel.addEventListener('change', _validateV178);
    _syncTierEnabled();
  })();

  body.appendChild(field(
    'Short Description',
    '<textarea id="f-short_description" maxlength="200" rows="2" placeholder="One-line description, max 200 chars.">' + escHtml(o.short_description || '') + '</textarea>'
  ));

  const leadershipLines = (Array.isArray(o.leadership) ? o.leadership : []).join('\n');
  body.appendChild(field(
    'Leadership (one per line)',
    '<textarea id="f-leadership" rows="4" placeholder="Title · Name">' + escHtml(leadershipLines) + '</textarea>'
  ));

  // We render it for every office; it's just hidden when service !== 'Congress'.
  // For brand-new orgs, we show it always (user may set service to Congress).
  {
    const isCongress = (o.service === 'Congress') || !o.service;
    const hill = document.createElement('div');
    hill.style.cssText = 'border-top:1px dashed var(--border);margin-top:14px;padding-top:10px;' + (isCongress ? '' : 'display:none;');
    hill.dataset.hillBlock = '1';
    const heading = document.createElement('div');
    heading.style.cssText = 'font-family:var(--font-display);font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:8px;';
    heading.textContent = 'Hill metadata';
    if (!isCongress) {
      const note = document.createElement('span');
      note.style.cssText = 'color:var(--text-dim);font-weight:400;font-size:10px;text-transform:none;letter-spacing:0.2px;margin-left:6px;';
      note.textContent = '(visible only for Congress orgs)';
      heading.appendChild(note);
    }
    hill.appendChild(heading);
    hill.appendChild(fieldRow(
      field('Chamber', '<select id="f-chamber"><option value="">--</option><option' + (o.chamber==='House'?' selected':'') + '>House</option><option' + (o.chamber==='Senate'?' selected':'') + '>Senate</option><option' + (o.chamber==='Joint'?' selected':'') + '>Joint</option></select>'),
      field('Party', '<select id="f-party"><option value="">--</option><option' + (o.party==='Republican'?' selected':'') + '>Republican</option><option' + (o.party==='Democrat'?' selected':'') + '>Democrat</option><option' + (o.party==='Independent'?' selected':'') + '>Independent</option><option' + (o.party==='Mixed'?' selected':'') + '>Mixed</option></select>')
    ));
    hill.appendChild(fieldRow(
      field('District', '<input id="f-district" value="' + escHtml(o.district||'') + '" placeholder="e.g. TX-22 (House) or TX (Senate). Blank for committees.">'),
      field('Committees', '<input id="f-committees" value="' + escHtml((o.committees||[]).join(', ')) + '" placeholder="comma-separated, e.g. HASC CITI, HAC-D">')
    ));
    body.appendChild(hill);
  }
  // ---- v56: DoD Budget Org typeahead (Phase 4) ----
  const _budgetSect = document.createElement('div');
  _budgetSect.innerHTML = '<div class="detail-label" style="margin:14px 0 8px 0;border-top:1px solid var(--border);padding-top:12px;">DoD Budget Org <span style="color:var(--text-dim);font-weight:400;font-size:10px;text-transform:none;letter-spacing:0.2px;margin-left:6px;">(optional, links this org to a canonical budget hierarchy node)</span></div>';
  body.appendChild(_budgetSect);
  const budgetOrgBox = document.createElement('div');
  budgetOrgBox.className = 'multi-select-box';
  body.appendChild(field('Pick a budget org', '', 'Type a name, abbreviation, or alias. Drives the per-org Budget panel in v57.'));
  body.lastChild.appendChild(budgetOrgBox);
  const budgetOrgPicker = makeBudgetOrgPicker(budgetOrgBox, o.budget_org_id || '');

  // ---- v209: Linked Budget Lines (read-only display + unlink) ----
  // Surfaces pe_office_links / sag_office_links so the FY27 amount
  // shown in the Orgs list view has a visible breakdown in the editor.
  // Pre-v209, manually-tagged PEs/SAGs were only discoverable via the
  // slide-out detail panel (renderOfficeBudgetPanel/renderOfficeOmPanel)
  // or the Budget tab itself; the editor showed nothing about them.
  const _linkedSect = document.createElement('div');
  _linkedSect.innerHTML = '<div class="detail-label" style="margin:14px 0 8px 0;border-top:1px solid var(--border);padding-top:12px;">'
    + 'Linked Budget Lines '
    + '<span style="color:var(--text-dim);font-weight:400;font-size:10px;text-transform:none;letter-spacing:0.2px;margin-left:6px;">'
    + '(PEs and SAGs manually tagged to this org from the Budget tab)</span></div>';
  body.appendChild(_linkedSect);
  const _linkedWrap = document.createElement('div');
  _linkedWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
  _linkedSect.appendChild(_linkedWrap);

  function _renderLinkedBudgetLines() {
    if (!o.id) {
      _linkedWrap.innerHTML = '<div style="font-size:11.5px;color:var(--text-muted);font-style:italic;padding:6px 2px;">Save the org first; linked budget lines will appear here once it has an ID.</div>';
      return;
    }
    const peLinks = ((DB.list && DB.list('pe_office_links')) || [])
      .filter(function(l){ return l && l.office_id === o.id; });
    const sagLinks = ((DB.list && DB.list('sag_office_links')) || [])
      .filter(function(l){ return l && l.office_id === o.id; });
    if (!peLinks.length && !sagLinks.length) {
      _linkedWrap.innerHTML = '<div style="font-size:11.5px;color:var(--text-muted);font-style:italic;padding:6px 2px;">No PEs or SAGs manually tagged to this org. Use <strong>+ Add office</strong> on a PE row in the Budget tab to link one.</div>';
      return;
    }
    const pesById = {};
    ((DB.list && DB.list('budget_pes')) || []).forEach(function(p){ if (p && p.id) pesById[p.id] = p; });
    const sagsById = {};
    ((DB.list && DB.list('budget_om_sags')) || []).forEach(function(s){ if (s && s.id) sagsById[s.id] = s; });

    const fmt = (typeof fmtBudget === 'function') ? fmtBudget : function(x){ return '$' + String(x); };
    const rows = [];
    peLinks.forEach(function(l){
      const pe = pesById[l.pe_id] || {};
      rows.push({
        kind: 'PE',
        id: l.pe_id,
        title: pe.title || '(unknown PE)',
        amount: Number(pe.request_amount) || 0,
        source: l.source || 'manual'
      });
    });
    sagLinks.forEach(function(l){
      const sag = sagsById[l.sag_id] || {};
      const sagAmt = (window._v150SagAmt ? window._v150SagAmt(sag) : (Number(sag.fy26_estimate) || 0));
      rows.push({
        kind: 'SAG',
        id: l.sag_id,
        title: sag.sag_title || sag.title || '(unknown SAG)',
        amount: sagAmt,
        source: l.source || 'manual'
      });
    });
    rows.sort(function(a, b){ return (b.amount || 0) - (a.amount || 0); });

    function srcLabel(s) {
      if (s === 'manual') return 'Manual';
      if (s === 'rollup') return 'Rollup';
      if (s === 'jbook_title') return 'Auto (J-Book)';
      return s ? (s.charAt(0).toUpperCase() + s.slice(1)) : '';
    }

    let html = '';
    rows.forEach(function(r){
      const kindBg = r.kind === 'PE' ? 'var(--accent, #4a7bd9)' : '#2a9d8f';
      html += '<div class="linked-budget-line" style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--surface-alt);border:1px solid var(--border);border-radius:4px;font-size:11.5px;">';
      html +=   '<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:' + kindBg + ';color:#fff;font-size:9.5px;font-weight:600;letter-spacing:0.4px;flex-shrink:0;">' + r.kind + '</span>';
      html +=   '<code style="font-size:11px;color:var(--text);flex-shrink:0;">' + escHtml(r.id) + '</code>';
      html +=   '<span style="flex:1;min-width:0;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escAttr(r.title) + '">' + escHtml(r.title) + '</span>';
      html +=   '<span style="color:var(--text-muted);font-size:10px;flex-shrink:0;">' + escHtml(srcLabel(r.source)) + '</span>';
      html +=   '<strong style="font-size:11px;flex-shrink:0;min-width:64px;text-align:right;">' + fmt(r.amount) + '</strong>';
      html +=   '<button type="button" class="linked-budget-unlink" data-kind="' + r.kind + '" data-link-id="' + escAttr(r.id) + '" title="Unlink" style="margin-left:2px;border:1px solid var(--border);background:transparent;color:var(--text-muted);cursor:pointer;padding:2px 8px;border-radius:3px;font-size:13px;line-height:1;">&times;</button>';
      html += '</div>';
    });
    _linkedWrap.innerHTML = html;

    _linkedWrap.querySelectorAll('.linked-budget-unlink').forEach(function(btn){
      btn.addEventListener('click', async function(ev){
        ev.preventDefault();
        ev.stopPropagation();
        const kind = btn.dataset.kind;
        const linkId = btn.dataset.linkId;
        if (!kind || !linkId) return;
        if (!confirm('Unlink ' + kind + ' ' + linkId + ' from this org?')) return;
        btn.disabled = true;
        try {
          if (kind === 'PE' && typeof unlinkPeFromOffice === 'function') {
            await unlinkPeFromOffice(linkId, o.id);
          } else if (kind === 'SAG' && typeof unlinkSagFromOffice === 'function') {
            await unlinkSagFromOffice(linkId, o.id);
          }
          _renderLinkedBudgetLines();
          if (typeof refreshAll === 'function') {
            try { refreshAll(); } catch (e) { console.warn('[v209] refreshAll failed', e); }
          }
        } catch (err) {
          console.warn('[v209] unlink failed', err);
          btn.disabled = false;
        }
      });
    });
  }
  _renderLinkedBudgetLines();

  body.appendChild(field('Notes', '<textarea id="f-notes">' + escHtml(o.notes||'') + '</textarea>', 'Free-form context -- programs, background, misc.'));

  // ---- v97: Media library (multi-file: photos, screenshots, slides from
  //       conferences / meetings). Files live in the 'letters' Storage
  //       bucket under 'org-media/<office_id>/...'. Each new file becomes
  //       a row in office_media. Existing rows render as a thumbnail strip
  //       with a remove button.
  var _mediaPending = []; // array of File objects
  var _mediaRemovedIds = new Set();
  var _existingMedia = (DB.list && DB.list('office_media')
    ? DB.list('office_media').filter(function(m){ return m && m.office_id === o.id; })
    : []);
  _existingMedia.sort(function(a,b){
    return String(b.uploaded_at||'').localeCompare(String(a.uploaded_at||''));
  });
  var _mediaSect = document.createElement('div');
  _mediaSect.innerHTML =
    '<div class="detail-label" style="margin:14px 0 8px 0;border-top:1px solid var(--border);padding-top:12px;">Media '
    + '<span style="color:var(--text-dim);font-weight:400;font-size:10px;text-transform:none;letter-spacing:0.2px;margin-left:6px;">'
    + '(screenshots, conference photos, slides \u2014 not the formal docs)</span></div>';
  body.appendChild(_mediaSect);
  var _mediaWrap  = document.createElement('div');
  var _mediaInput = document.createElement('input');
  _mediaInput.type = 'file';
  _mediaInput.multiple = true;
  _mediaInput.accept = 'image/*,application/pdf';
  _mediaInput.style.cssText = 'margin-top:6px;font-size:12px;display:block;';
  function _renderMediaSlot() {
    var html = '';
    var keepers = _existingMedia.filter(function(m){ return !_mediaRemovedIds.has(m.id); });
    if (keepers.length || _mediaPending.length) {
      html += '<div style="display:flex;flex-wrap:wrap;gap:8px;font-size:11.5px;">';
      keepers.forEach(function(m){
        var isImg = /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(m.filename || m.media_url || '');
        html += '<div style="position:relative;border:1px solid var(--border);border-radius:6px;padding:6px 8px;background:var(--surface);min-width:120px;max-width:200px;">';
        html += '<a href="' + escHtml(m.media_url) + '" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;display:block;">';
        if (isImg) {
          html += '<img src="' + escHtml(m.media_url) + '" alt="" style="display:block;max-width:100%;max-height:80px;object-fit:cover;border-radius:4px;margin-bottom:4px;">';
        } else {
          html += '<div style="font-size:18px;color:var(--text-muted);text-align:center;line-height:1.2;">\u00b6</div>';
        }
        html += '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escAttr(m.filename||'') + '">' + escHtml(m.filename||'(file)') + '</div>';
        html += '</a>';
        html += '<a data-rm-media="' + escAttr(m.id) + '" title="Remove" style="position:absolute;right:4px;top:2px;cursor:pointer;color:var(--text-muted);font-size:13px;line-height:1;">\u00d7</a>';
        html += '</div>';
      });
      _mediaPending.forEach(function(f, idx){
        html += '<div style="position:relative;border:1px dashed var(--accent);border-radius:6px;padding:6px 8px;background:var(--surface-alt);min-width:120px;max-width:200px;">';
        html += '<div style="font-size:11px;color:var(--accent);margin-bottom:4px;">\u23f7 New</div>';
        html += '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escAttr(f.name||'') + '">' + escHtml(f.name||'') + '</div>';
        html += '<div style="color:var(--text-muted);font-size:10.5px;">' + Math.round(f.size/1024) + ' KB</div>';
        html += '<a data-cancel-pending="' + idx + '" title="Cancel" style="position:absolute;right:4px;top:2px;cursor:pointer;color:var(--text-muted);font-size:13px;line-height:1;">\u00d7</a>';
        html += '</div>';
      });
      html += '</div>';
    } else {
      html = '<div style="font-size:11.5px;color:var(--text-muted);">No media yet. Use the file picker below to add screenshots / photos / slides.</div>';
    }
    _mediaWrap.innerHTML = html;
    _mediaWrap.querySelectorAll('[data-rm-media]').forEach(function(a){
      a.addEventListener('click', function(){ _mediaRemovedIds.add(a.getAttribute('data-rm-media')); _renderMediaSlot(); });
    });
    _mediaWrap.querySelectorAll('[data-cancel-pending]').forEach(function(a){
      a.addEventListener('click', function(){ _mediaPending.splice(Number(a.getAttribute('data-cancel-pending')),1); _renderMediaSlot(); });
    });
  }
  _mediaInput.addEventListener('change', function(){
    var files = _mediaInput.files ? Array.prototype.slice.call(_mediaInput.files) : [];
    files.forEach(function(f){ if (f) _mediaPending.push(f); });
    _mediaInput.value = '';
    _renderMediaSlot();
  });
  _renderMediaSlot();
  body.appendChild(_mediaWrap);
  body.appendChild(_mediaInput);

  openModal({
    title: id ? 'Edit Org · ' + (o.name || o.id) : 'Add Org',
    body, table:'offices', id: o.id || '',
    onSave: async () => {
      // v178b: hard-block save when Show-on-Dashboard is checked but either
      // Department or Tier is empty. The validator is the single source of
      // truth and also re-paints the red border styling so the user can see
      // exactly which fields need attention.
      if (!_validateV178()) {
        alert('When "Show on Dashboard" is checked, both Department and Tier must be set. Either uncheck "Show on Dashboard" or pick a Department and a Tier.');
        return;
      }
      //   Tier 1   -> Strategy + Funder  (Roadmap Shapers / Co-Funders)
      //   Tier 2a  -> Acquisition        (PAE / contract-authority)
      //   Tier 2b  -> Acquisition        (RCO / bypass authority)
      //   Tier 2c  -> Acquisition        (Werx / innovation hubs)
      //   Tier 3   -> End User           (demand-signal generators)
      //   Tier 4   -> Demand-Arbiter     (COCOMs)
      //   Tier 5   -> Oversight          (auth + approps)
      //   N/A      -> preserve existing roles (don't destroy historical
      //              multi-role data on a save that doesn't touch tier)
      const _newTier_v178 = (document.getElementById('f-echelon').value || '').trim();
      const _TIER_TO_ROLES_V178 = {
        '':   Array.isArray(o.roles) ? o.roles : [],
        '1':  ['strategy', 'funder'],
        '2a': ['acquisition'],
        '2b': ['acquisition'],
        '2c': ['acquisition'],
        '3':  ['end-user'],
        '4':  ['demand-arbiter'],
        '5':  ['oversight'],
      };
      const roles = (_TIER_TO_ROLES_V178[_newTier_v178] || []).slice();
      const leadership = (document.getElementById('f-leadership').value || '')
        .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const shortDesc = (document.getElementById('f-short_description').value || '').trim();
      if (shortDesc.length > 200) { alert('Short Description must be 200 characters or fewer.'); return; }
      // the block is hidden for non-Congress orgs)
      const fChamber    = document.getElementById('f-chamber');
      const fParty      = document.getElementById('f-party');
      const fDistrict   = document.getElementById('f-district');
      const fCommittees = document.getElementById('f-committees');
      // existing readers (search blob, table cell, map lookup) keep working.
      const _locCity    = document.getElementById('f-location-city').value.trim();
      const _locState   = document.getElementById('f-location-state').value.trim();
      const _locCountry = document.getElementById('f-location-country').value.trim();
      const _locCombined = [_locCity, _locState, _locCountry].filter(Boolean).join(', ');
      const rec = {
        id: o.id || '',
        name:            document.getElementById('f-name').value.trim(),
        fullName:        document.getElementById('f-fullName').value.trim(),
        // Legacy columns preserved (editors removed in v47): service, tier, dashboardCardId
        service:         (function(){ const f=document.querySelector('#modalBody input[data-force-service]'); return f ? f.value : (o.service || ''); })(),
        //       the offices-table tier filter (4889+ tier select) and the
        //       Tier View dashboard bucketer agree. If the user picks N/A
        //       (empty), preserve any existing legacy tier so we don't
        //       silently demote pre-v178 records.
        tier:            (_newTier_v178 || o.tier || ''),
        dashboardCardId: o.dashboardCardId || '',
        location:           _locCombined,
        location_city:      _locCity,
        location_state:     _locState,
        location_country:   _locCountry,
        notes:           document.getElementById('f-notes').value.trim(),
        tags: arrField(document.getElementById('f-tags').value),
        // Phase 1 structured fields
        parent_id:         parentPicker.get() || null,
        department:        document.getElementById('f-department').value,
        roles:             roles,
        echelon:           document.getElementById('f-echelon').value.trim(),
        show_on_dashboard: document.getElementById('f-show_on_dashboard').checked,
        priority:          document.getElementById('f-priority').checked,
        short_description: shortDesc,
        leadership:        leadership,
        chamber:    fChamber    ? fChamber.value    : (o.chamber    || ''),
        party:      fParty      ? fParty.value      : (o.party      || ''),
        district:   fDistrict   ? fDistrict.value.trim()   : (o.district   || ''),
        committees: fCommittees ? arrField(fCommittees.value) : (o.committees || []),
        budget_org_id: budgetOrgPicker.get() || null,
        // the 1..9 check constraint added in v97-multi.sql).
        trl_min: (function(){ var v = document.getElementById('f-trl-min'); var n = v && v.value !== '' ? Number(v.value) : null; return (n === null || isNaN(n)) ? null : Math.max(1, Math.min(9, Math.round(n))); })(),
        trl_max: (function(){ var v = document.getElementById('f-trl-max'); var n = v && v.value !== '' ? Number(v.value) : null; return (n === null || isNaN(n)) ? null : Math.max(1, Math.min(9, Math.round(n))); })(),
      };
      if (!rec.name) { alert('Name is required.'); return; }
      // Sanity: max >= min if both set (matches DB check constraint).
      if (rec.trl_min != null && rec.trl_max != null && rec.trl_max < rec.trl_min) {
        alert('TRL max must be >= TRL min.'); return;
      }
      var saved = DB.upsert('offices', rec);
      var officeId = (saved && saved.id) || rec.id || o.id;

      // any newly picked files to the 'letters' bucket under
      // org-media/<officeId>/... and write office_media rows for each.
      try {
        if (officeId && _mediaRemovedIds && _mediaRemovedIds.size) {
          var _delIds = Array.from(_mediaRemovedIds);
          for (var di = 0; di < _delIds.length; di++) {
            try { DB.remove('office_media', _delIds[di]); } catch (_) {}
          }
        }
        if (officeId && _mediaPending && _mediaPending.length) {
          for (var ui = 0; ui < _mediaPending.length; ui++) {
            var f = _mediaPending[ui];
            try {
              var up = await uploadIntoLettersBucket('org-media', officeId, f);
              var row = {
                id: 'om_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                office_id: officeId,
                media_url: up.url,
                filename: up.filename || (f && f.name) || '',
                caption: '',
                uploaded_at: new Date().toISOString(),
              };
              DB.upsert('office_media', row);
            } catch (eUp) {
              alert('Media upload failed for ' + (f && f.name ? f.name : '(file)') + ': ' + (eUp && eUp.message ? eUp.message : eUp));
            }
          }
        }
      } catch (eMed) {
        console.warn('[v97] media save failed', eMed);
      }
      closeModal();
      refreshAll();
    }
  });
}

// =================================================================
// =================================================================
window.editOffice = editOffice;
