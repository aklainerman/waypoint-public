// js/render/hill-summary.js
//
//
// Originally an inline IIFE at the bottom of index.html; lifted to ES module
// in v180.
//
// Exposes on window:
//   window.renderHillSummary
//   plus the committee drawer + engagement add/delete helpers
//
// Consumes from window: DB, escHtml, _partyKey, _commCount.

// ==================================================================
// ==================================================================
(function () {
  'use strict';

  function $h(id) { return document.getElementById(id); }
  function escH(s) { return (typeof escHtml === 'function') ? escHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]; }); }
  function membersList()    { return (DB.list && DB.list('hill_members'))               || []; }
  function committeesList() { return (DB.list && DB.list('hill_committees'))            || []; }
  function meetingsList()   { return (DB.list && DB.list('hill_meetings'))              || []; }
  function requestsList()   { return (DB.list && DB.list('hill_requests'))              || []; }
  function memberByBg(bg)   { return membersList().find(function (m) { return m && m.bioguide_id === bg; }); }
  function committeeByTid(t){ return committeesList().find(function (c) { return c && c.thomas_id === t; }); }

  // ----- engagements: fetch / add / delete --------------------------
  function lastContactedForMember(bg) {
    var meetings = meetingsFor('member', bg);
    if (meetings.length > 0) return meetings[0].meeting_date; // sorted desc
    var m = memberByBg(bg);
    return (m && m.last_contacted) || null;
  }
  function _engDot(dateStr) {
    if (!dateStr) return '<span class="hill-lc-dot none" title="No engagements logged"></span>';
    var days = (Date.now() - new Date(dateStr).getTime()) / 86400000;
    var color = days > 180 ? '#c0392b' : days > 90 ? '#e67e22' : '#27ae60';
    var label = 'Last contact: ' + dateStr + ' · ' + (days > 180 ? '>6 months ago' : days > 90 ? '3-6 months ago' : 'within 3 months');
    return '<span class="hill-lc-dot" style="background:' + color + ';" title="' + escH(label) + '"></span><span class="hill-lc-date" style="color:' + color + ';">' + escH(dateStr) + '</span>';
  }

  function meetingsFor(targetType, targetId) {
    return meetingsList()
      .filter(function (r) { return r && r.target_type === targetType && r.target_id === targetId; })
      .sort(function (a, b) { return (b.meeting_date || '').localeCompare(a.meeting_date || ''); });
  }
  function requestsFor(targetType, targetId) {
    return requestsList()
      .filter(function (r) { return r && r.target_type === targetType && r.target_id === targetId; })
      .sort(function (a, b) { return (b.submit_date || '').localeCompare(a.submit_date || ''); });
  }
  function uuidv4() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random()*16|0, v = c === 'x' ? r : (r&0x3|0x8); return v.toString(16);
    });
  }
  async function addMeeting(targetType, targetId, fields) {
    var rec = {
      id: uuidv4(),
      target_type: targetType,
      target_id: targetId,
      meeting_date: fields.date || new Date().toISOString().slice(0, 10),
      title: fields.title || null,
      attendees: fields.attendees || null,
      notes: fields.notes || null,
      created_at: new Date().toISOString(),
    };
    DB.state.hill_meetings = (DB.state.hill_meetings || []).concat([rec]);
    if (typeof _hillSaveInsert === 'function') await _hillSaveInsert('hill_meetings', rec);
    return rec;
  }
  async function addRequest(targetType, targetId, fields) {
    var rec = {
      id: uuidv4(),
      target_type: targetType,
      target_id: targetId,
      submit_date: fields.date || new Date().toISOString().slice(0, 10),
      title: fields.title || null,
      type: fields.type || null,
      status: fields.status || 'Drafted',
      ask_amount: fields.ask_amount || null,
      notes: fields.notes || null,
      created_at: new Date().toISOString(),
    };
    DB.state.hill_requests = (DB.state.hill_requests || []).concat([rec]);
    if (typeof _hillSaveInsert === 'function') await _hillSaveInsert('hill_requests', rec);
    return rec;
  }
  async function deleteMeeting(id) {
    DB.state.hill_meetings = (DB.state.hill_meetings || []).filter(function (r) { return r.id !== id; });
    if (typeof _sb !== 'undefined' && _sb) {
      try { await _sb.from('hill_meetings').delete().eq('id', id); } catch (e) {}
    }
  }
  async function deleteRequest(id) {
    DB.state.hill_requests = (DB.state.hill_requests || []).filter(function (r) { return r.id !== id; });
    if (typeof _sb !== 'undefined' && _sb) {
      try { await _sb.from('hill_requests').delete().eq('id', id); } catch (e) {}
    }
  }

  // ----- engagement section HTML (used in both drawers) -------------
  function meetingsSectionHtml(targetType, targetId) {
    var rows = meetingsFor(targetType, targetId);
    var listH = rows.length
      ? rows.map(function (r) {
          return '<div class="hill-eng-item" data-eng-id="' + escH(r.id) + '" data-eng-type="meeting">'
            + '<span class="d">' + escH(r.meeting_date || '') + '</span>'
            + '<span class="t">' + escH(r.title || 'Meeting') + '</span>'
            + '<span class="del" title="Remove">×</span>'
            + (r.notes ? '<div class="hill-eng-notes">' + escH(r.notes) + '</div>' : '')
            + '</div>';
        }).join('')
      : '<div class="hill-eng-empty">No engagements logged yet.</div>';
    var today = new Date().toISOString().slice(0, 10);
    return '<div class="hill-eng-section" data-eng-section="meeting" data-target-type="' + escH(targetType) + '" data-target-id="' + escH(targetId) + '">'
      + '<h4>Engagements <span class="count" style="font-weight:400;color:var(--text-dim);">(' + rows.length + ')</span></h4>'
      + '<div class="hill-eng-list">' + listH + '</div>'
      + '<div class="hill-eng-add">'
      +   '<input type="date" class="hm-date" value="' + today + '" style="flex:0 0 auto;">'
      +   '<select class="hm-type" style="flex:0 0 auto;"><option>Meeting</option><option>Phone</option><option>Email</option><option>In-Person</option><option>Conference</option><option>Other</option></select>'
      +   '<textarea class="hm-notes" placeholder="Notes (optional)" rows="2" style="width:100%;box-sizing:border-box;margin-top:4px;font-size:12px;padding:4px 6px;resize:vertical;background:var(--surface-alt);border:1px solid var(--border);border-radius:4px;color:var(--text);"></textarea>'
      +   '<button class="hm-add" style="margin-top:4px;">+ Log engagement</button>'
      + '</div>'
      + '</div>';
  }
  function requestsSectionHtml(targetType, targetId) {
    var rows = requestsFor(targetType, targetId);
    var listH = rows.length
      ? rows.map(function (r) {
          return '<div class="hill-eng-item" data-eng-id="' + escH(r.id) + '" data-eng-type="request">'
            + '<span class="d">' + escH(r.submit_date || '') + '</span>'
            + '<span class="t">' + escH(r.title || '(untitled)') + (r.type ? ' (' + escH(r.type) + ')' : '') + '</span>'
            + (r.status ? '<span class="badge">' + escH(r.status) + '</span>' : '')
            + '<span class="del" title="Delete">&times;</span>'
            + '</div>';
        }).join('')
      : '<div class="hill-eng-empty">No requests logged yet.</div>';
    var today = new Date().toISOString().slice(0, 10);
    return '<div class="hill-eng-section" data-eng-section="request" data-target-type="' + escH(targetType) + '" data-target-id="' + escH(targetId) + '">'
      + '<h4>Requests <span class="count" style="font-weight:400;color:var(--text-dim);">(' + rows.length + ')</span></h4>'
      + '<div class="hill-eng-list">' + listH + '</div>'
      + '<div class="hill-eng-add">'
      +   '<input type="date" class="hr-date" value="' + today + '">'
      +   '<input type="text" class="title hr-title" placeholder="Request title (e.g. NDAA mark for X)">'
      +   '<select class="hr-type">'
      +     '<option value="">type</option>'
      +     '<option>NDAA mark</option><option>Plus-up</option><option>RFI</option>'
      +     '<option>Approps request</option><option>Authorization language</option><option>Other</option>'
      +   '</select>'
      +   '<button class="hr-add">+ Log request</button>'
      + '</div>'
      + '</div>';
  }

  // ----- committee drawer -------------------------------------------
  function openHillCommitteeDrawer(tid) {
    var c = committeeByTid(tid); if (!c) return;
    var panel = document.getElementById('detail-panel'); if (!panel) return;
    var titleEl = panel.querySelector('.panel-title-text');
    var subEl   = panel.querySelector('.panel-subtitle');
    var body    = panel.querySelector('.panel-body');
    if (!body) return;
    var starBtn = panel.querySelector('.panel-star'); if (starBtn) starBtn.style.display = 'none';
    var pBudget = panel.querySelector('#panel-budget'); if (pBudget) pBudget.style.display = 'none';
    var pRel    = panel.querySelector('#panel-related'); if (pRel) pRel.style.display = 'none';
    var pBadges = panel.querySelector('.panel-role-badges'); if (pBadges) pBadges.innerHTML = '';
    var pCounters = panel.querySelector('.panel-counters'); if (pCounters) pCounters.innerHTML = '';

    if (titleEl) titleEl.textContent = c.name || tid;
    var subParts = [];
    if (c.chamber) subParts.push(c.chamber);
    if (c.parent_thomas_id) subParts.push('subcommittee of ' + (committeeByTid(c.parent_thomas_id) || {}).name);
    else subParts.push(c.type === 'subcommittee' ? 'subcommittee' : 'committee');
    if (subEl) subEl.textContent = subParts.join(' · ');

    // Roster (scrollable)
    var members = (DB.list && DB.list('hill_committee_memberships') || []).filter(function (r) { return r && r.thomas_id === tid; });
    function chip(r) {
      var m = memberByBg(r.bioguide_id) || {};
      var pk = (m.party || '').toLowerCase().indexOf('republic') === 0 ? 'R'
              : (m.party || '').toLowerCase().indexOf('democrat') === 0 ? 'D'
              : (m.party || '').toLowerCase().indexOf('indep')    === 0 ? 'I' : 'M';
      var roleLead = (r.role === 'Chair' || r.role === 'Ranking Member' || r.role === 'Vice Chair');
      return '<span class="hill-roster-chip ' + (roleLead ? 'role-lead' : '') + '" data-bioguide="' + escH(r.bioguide_id) + '">'
        + '<span class="pmark ' + pk + '"></span>'
        + escH(m.full_name || r.bioguide_id) + (roleLead ? ' (' + escH(r.role) + ')' : '')
        + '</span>';
    }
    var maj = members.filter(function (r) { return r.side === 'majority'; });
    var min = members.filter(function (r) { return r.side === 'minority'; });
    var rosterH = '';
    if (maj.length) rosterH += '<div class="hill-committee-roster-section"><h5>Majority (' + maj.length + ')</h5><div class="hill-roster-list">' + maj.map(chip).join('') + '</div></div>';
    if (min.length) rosterH += '<div class="hill-committee-roster-section"><h5>Minority (' + min.length + ')</h5><div class="hill-roster-list">' + min.map(chip).join('') + '</div></div>';
    if (!maj.length && !min.length) rosterH += '<div class="hill-committee-roster-section"><div class="hill-roster-list">' + members.map(chip).join('') + '</div></div>';
    if (!members.length) rosterH = '<div class="hill-eng-empty">No roster data.</div>';

    body.innerHTML =
        '<div class="hill-mdraw-section"><h4>Toggles</h4>'
      +   '<label style="display:block;font-size:11.5px;margin-bottom:4px;"><input type="checkbox" id="hcEditPriority"' + (c.is_priority ? ' checked' : '') + '> Mark as priority</label>'
      +   '<label style="display:block;font-size:11.5px;"><input type="checkbox" id="hcEditShowSummary"' + (c.show_on_summary ? ' checked' : '') + '> Show card on Summary tab</label>'
      + '</div>'
      + (c.jurisdiction ? '<div class="hill-mdraw-section"><h4>Jurisdiction</h4><div style="font-size:11.5px;line-height:1.4;">' + escH(c.jurisdiction) + '</div></div>' : '')
      + '<div class="hill-mdraw-section"><h4>Roster (' + members.length + ')</h4><div class="hill-cdraw-roster">' + rosterH + '</div></div>'
      + meetingsSectionHtml('committee', tid)
      + requestsSectionHtml('committee', tid)
      + '<div class="hill-mdraw-section"><h4>Notes</h4>'
      +   '<textarea class="hill-mdraw-textarea" id="hcEditNotes" placeholder="Internal notes about this committee...">' + escH(c.notes || '') + '</textarea>'
      +   '<div style="margin-top:8px;text-align:right;"><button class="btn primary" id="hcEditSave">Save</button></div>'
      + '</div>';

    panel.classList.add('open');

    // Wire toggles + save
    var saveBtn = $h('hcEditSave');
    if (saveBtn) saveBtn.onclick = function () {
      var patch = {
        is_priority:    !!($h('hcEditPriority') && $h('hcEditPriority').checked),
        show_on_summary:!!($h('hcEditShowSummary') && $h('hcEditShowSummary').checked),
        notes:          ($h('hcEditNotes') || {}).value || null,
      };
      Object.assign(c, patch);
      if (typeof _hillSaveUpdate === 'function') _hillSaveUpdate('hill_committees', 'thomas_id', c.thomas_id, patch);
      saveBtn.textContent = 'Saved';
      setTimeout(function () { saveBtn.textContent = 'Save'; }, 1200);
      if (typeof renderHillCommittees === 'function') renderHillCommittees();
      if (typeof renderHillSummary === 'function') renderHillSummary();
      // v168-tier5-committees: refresh dashboard so Tier 5 reflects the new
      // show_on_summary state immediately (committee appears / disappears).
      if (typeof renderDashboard === 'function') {
        try { renderDashboard(); } catch (e) { console.warn('[hcEditSave-renderDashboard]', e); }
      }
    };
  }
  // silently matches zero rows on hill_members (PK=bioguide_id) and
  // hill_committees (PK=thomas_id). These wrappers use the correct PK
  // column and surface failures so the user sees them.
  async function _hillSaveUpdate(table, pkCol, pkVal, fields) {
    if (typeof _sb === 'undefined' || !_sb) return { ok: false, error: 'Supabase not ready' };
    try {
      var res = await _sb.from(table).update(fields).eq(pkCol, pkVal);
      if (res.error) {
        console.error('[hill] UPDATE FAIL', table, pkCol, pkVal, res.error);
        alert('Save failed: ' + (res.error.message || res.error.code || 'unknown'));
        return { ok: false, error: res.error };
      }
      return { ok: true };
    } catch (e) {
      console.error('[hill] UPDATE THREW', table, e);
      alert('Save failed: ' + (e && e.message || e));
      return { ok: false, error: e };
    }
  }
  async function _hillSaveInsert(table, rec) {
    if (typeof _sb === 'undefined' || !_sb) return { ok: false, error: 'Supabase not ready' };
    try {
      var res = await _sb.from(table).insert(rec);
      if (res.error) {
        console.error('[hill] INSERT FAIL', table, res.error, rec);
        alert('Save failed: ' + (res.error.message || res.error.code || 'unknown'));
        return { ok: false, error: res.error };
      }
      return { ok: true };
    } catch (e) {
      console.error('[hill] INSERT THREW', table, e);
      alert('Save failed: ' + (e && e.message || e));
      return { ok: false, error: e };
    }
  }
  async function _hillSaveDelete(table, id) {
    if (typeof _sb === 'undefined' || !_sb) return { ok: false };
    try {
      var res = await _sb.from(table).delete().eq('id', id);
      if (res.error) {
        console.error('[hill] DELETE FAIL', table, id, res.error);
        alert('Delete failed: ' + (res.error.message || res.error.code || 'unknown'));
        return { ok: false, error: res.error };
      }
      return { ok: true };
    } catch (e) { console.error('[hill] DELETE THREW', table, e); return { ok: false, error: e }; }
  }
  window._hillSaveUpdate = _hillSaveUpdate;
  window._hillSaveInsert = _hillSaveInsert;
  window._hillSaveDelete = _hillSaveDelete;

  window.openHillCommitteeDrawer = openHillCommitteeDrawer;
  window.meetingsSectionHtml = meetingsSectionHtml;
  window.requestsSectionHtml = requestsSectionHtml;
  window.lastContactedForMember = lastContactedForMember;
  window._engDot = _engDot;

  // ----- summary subtab ---------------------------------------------
  function renderHillSummary() {
    var wrap = $h('hillSummaryWrap'); if (!wrap) return;
    var prioMembers   = membersList().filter(function (m) { return m && m.is_priority; });
    var summaryComms  = committeesList().filter(function (c) { return c && c.show_on_summary; });

    // Uses escH (in scope here) instead of esc (which is in IIFE 1). Inline
    // partyKey + committee-membership lookup so we don't reach into IIFE 1.
    function _partyKey(p) {
      p = (p || '').toLowerCase();
      if (p.indexOf('republic') === 0) return 'R';
      if (p.indexOf('democrat') === 0) return 'D';
      if (p.indexOf('indep') === 0)    return 'I';
      return 'M';
    }
    function _commCount(bg) {
      return ((DB.state && DB.state.hill_committee_memberships) || [])
        .filter(function (r) { return r && r.bioguide_id === bg; }).length;
    }
    function _memberCardSummary(m) {
      var pk = _partyKey(m.party);
      var photo = m.photo_url ? ('<div class="hill-member-photo" style="background-image:url(\'' + escH(m.photo_url) + '\')"></div>')
                              : ('<div class="hill-member-photo">' + escH(((m.first_name || ' ')[0] || '') + ((m.last_name || ' ')[0] || '')) + '</div>');
      var subBits = [];
      if (m.chamber === 'senate') subBits.push('Senator');
      else subBits.push('Rep.');
      if (m.state) subBits.push(m.state + (m.district != null ? '-' + m.district : ''));
      var leadHtml = m.leadership_title ? '<span class="hill-member-badge lead">' + escH(m.leadership_title) + '</span>' : '';
      var commCount = _commCount(m.bioguide_id);
      var mtgCount = meetingsFor('member', m.bioguide_id).length;
      var reqCount = requestsFor('member', m.bioguide_id).length;
      return '<div class="hill-member-card' + (m.is_priority ? ' priority' : '') + '" data-bioguide="' + escH(m.bioguide_id) + '">'
        + photo
        + '<div class="hill-member-meta">'
        +   '<div class="hill-member-name">'
        +     '<span class="hill-member-star ' + (m.is_priority ? '' : 'off') + '" data-star="' + escH(m.bioguide_id) + '" title="Priority">\u2605</span>'
        +     escH(m.full_name)
        +   '</div>'
        +   '<div class="hill-member-sub">' + escH(subBits.join(' \u00B7 ')) + '</div>'
        +   '<div class="hill-member-badges">'
        +     '<span class="hill-member-badge party-' + pk + '">' + escH((m.party || '').slice(0, 1) || '?') + '</span>'
        +     '<span class="hill-member-badge">' + escH(m.chamber === 'senate' ? 'Senate' : 'House') + '</span>'
        +     '<span class="hill-member-badge" title="Committees">COM ' + commCount + '</span>'
        +     '<span class="hill-member-badge" title="Engagements">ENG ' + mtgCount + '</span>'
        +     leadHtml
        +   '</div>'
        +   '<div class="hill-lc-row">' + _engDot(lastContactedForMember(m.bioguide_id)) + '</div>'
        + '</div>'
        + '</div>';
    }

    function _commCardSummary(c) {
      var subLabel = c.parent_thomas_id ? ('Subcommittee \u00B7 ' + (c.chamber || '')) : ('Committee \u00B7 ' + (c.chamber || ''));
      var initials = String(c.name || '?').split(/\s+/).slice(0, 2).map(function (w) { return (w[0] || '').toUpperCase(); }).join('') || 'C';
      var mtgCount = meetingsFor('committee', c.thomas_id).length;
      var reqCount = requestsFor('committee', c.thomas_id).length;
      return '<div class="hill-member-card" data-summary-tid="' + escH(c.thomas_id) + '">'
        + '<div class="hill-member-photo" style="background:var(--surface-2);font-weight:600;">' + escH(initials) + '</div>'
        + '<div class="hill-member-meta">'
        +   '<div class="hill-member-name">' + escH(c.name) + '</div>'
        +   '<div class="hill-member-sub">' + escH(subLabel) + '</div>'
        +   '<div class="hill-member-badges">'
        +     '<span class="hill-member-badge">' + escH(c.chamber || '') + '</span>'
        +     '<span class="hill-member-badge" title="Meetings">MTG ' + mtgCount + '</span>'
        +     '<span class="hill-member-badge" title="Requests">REQ ' + reqCount + '</span>'
        +   '</div>'
        + '</div>'
        + '</div>';
    }

    var memCardsH = prioMembers.length
      ? prioMembers.map(_memberCardSummary).join('')
      : '<div class="hill-summary-empty">Star members on the Members tab to see them here.</div>';
    var commCardsH = summaryComms.length
      ? summaryComms.map(_commCardSummary).join('')
      : '<div class="hill-summary-empty">Open a committee, check "Show card on Summary tab" to add it here.</div>';

    wrap.innerHTML =
        '<div class="hill-summary-section">'
      +   '<div class="hill-summary-h">Priority committees <span class="count">' + summaryComms.length + '</span></div>'
      +   '<div class="hill-member-grid">' + commCardsH + '</div>'
      + '</div>'
      + '<div class="hill-summary-section">'
      +   '<div class="hill-summary-h">Priority members <span class="count">' + prioMembers.length + '</span></div>'
      +   '<div class="hill-member-grid">' + memCardsH + '</div>'
      + '</div>';
  }
  window.renderHillSummary = renderHillSummary;

  // ----- wiring: committee click opens drawer -----------------------
  document.addEventListener('click', function (e) {
    // on the committee head (name, meta, etc.) opens the drawer.
    var chev = e.target.closest && e.target.closest('.hill-committee-chevron');
    if (chev && !chev.classList.contains('empty')) {
      e.preventDefault();
      var rowC = chev.closest('.hill-committee-row');
      if (rowC && rowC.classList.contains('has-subs')) rowC.classList.toggle('open');
      return;
    }
    var head = e.target.closest && e.target.closest('.hill-committee-head');
    if (head) {
      e.preventDefault();
      var row = head.closest('.hill-committee-row');
      var tid = row && row.dataset && row.dataset.tid;
      if (tid) openHillCommitteeDrawer(tid);
      return;
    }
    // .hill-member-card, so this selector stopped matching. Look for the
    // data-summary-tid marker on the new chassis instead. (Member cards
    // on Summary use data-bioguide and are picked up by the .hill-member-card
    // handler above, which works.)
    var sumCom = e.target.closest && e.target.closest('.hill-member-card[data-summary-tid]');
    if (sumCom) {
      e.preventDefault();
      e.stopPropagation();
      return openHillCommitteeDrawer(sumCom.dataset.summaryTid);
    }
    // Engagement add buttons
    var engSec = e.target.closest && e.target.closest('.hill-eng-section');
    if (engSec) {
      var tt = engSec.dataset.targetType, tid = engSec.dataset.targetId;
      if (e.target.classList && e.target.classList.contains('hm-add')) {
        var d = engSec.querySelector('.hm-date');
        var tyEl = engSec.querySelector('.hm-type');
        var notesEl = engSec.querySelector('.hm-notes');
        var engDate = d ? d.value : new Date().toISOString().slice(0, 10);
        var engType = tyEl ? tyEl.value : 'Meeting';
        var engNotes = notesEl ? notesEl.value.trim() : '';
        addMeeting(tt, tid, { date: engDate, title: engType, notes: engNotes || null }).then(function () { rerenderEngagement(engSec, 'meeting'); });
        return;
      }
      if (e.target.classList && e.target.classList.contains('hr-add')) {
        var d2 = engSec.querySelector('.hr-date'), tEl2 = engSec.querySelector('.hr-title'), tyEl = engSec.querySelector('.hr-type');
        if (!tEl2.value.trim()) return;
        addRequest(tt, tid, { date: d2.value, title: tEl2.value.trim(), type: tyEl.value || null }).then(function () { rerenderEngagement(engSec, 'request'); });
        return;
      }
      if (e.target.classList && e.target.classList.contains('del')) {
        var item = e.target.closest('.hill-eng-item'); if (!item) return;
        var id = item.dataset.engId, kind = item.dataset.engType;
        if (kind === 'meeting') deleteMeeting(id).then(function () { rerenderEngagement(engSec, 'meeting'); });
        else deleteRequest(id).then(function () { rerenderEngagement(engSec, 'request'); });
        return;
      }
    }
  });

  function rerenderEngagement(section, kind) {
    var tt = section.dataset.targetType, tid = section.dataset.targetId;
    var newH = (kind === 'meeting') ? meetingsSectionHtml(tt, tid) : requestsSectionHtml(tt, tid);
    var tmp = document.createElement('div'); tmp.innerHTML = newH;
    section.replaceWith(tmp.firstElementChild);
    // Refresh the Last contacted input in the drawer (computed live from meetings)
    if (kind === 'meeting' && tt === 'member') {
      var lcInput = document.getElementById('hmEditLast');
      if (lcInput) lcInput.value = lastContactedForMember(tid) || '';
    }
    if (typeof renderHillSummary === 'function') renderHillSummary();
  }

  // ----- subtab activation hook for Summary -------------------------
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-subtab-group="washops"] .subtab-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.subtab === 'washops-summary') setTimeout(renderHillSummary, 0);
      });
    });
  });

  // Re-pull the new tables in the existing _refreshHillTables loop
  // (TABLES array is updated separately; the boot loader handles it.)
})();
