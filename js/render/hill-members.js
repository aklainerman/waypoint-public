// js/render/hill-members.js
//
//
// Originally an inline IIFE at the bottom of index.html; lifted to ES module
// in v180.
//
// Exposes on window:
//   window.renderHillMembers
//   window.renderHillCommittees
//   window.openHillMemberDrawer
//   window.syncHillNow
//
// Consumes from window: DB, escHtml, magic-link Supabase client _sb.

// ==================================================================
// ==================================================================
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function esc(s) { return (typeof escHtml === 'function') ? escHtml(s) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function partyKey(p) { p = (p || '').toLowerCase(); if (p.indexOf('republic') === 0) return 'R'; if (p.indexOf('democrat') === 0) return 'D'; if (p.indexOf('indep') === 0) return 'I'; return 'M'; }
  function memberById(bg) { return ((DB.list && DB.list('hill_members')) || []).find(function (m) { return m && m.bioguide_id === bg; }); }
  function committeeById(tid) { return ((DB.list && DB.list('hill_committees')) || []).find(function (c) { return c && c.thomas_id === tid; }); }

  function membershipsForMember(bg) {
    return ((DB.list && DB.list('hill_committee_memberships')) || []).filter(function (r) { return r && r.bioguide_id === bg; });
  }
  function membershipsForCommittee(tid) {
    return ((DB.list && DB.list('hill_committee_memberships')) || []).filter(function (r) { return r && r.thomas_id === tid; });
  }

  // ----------------------------------------------------------------
  // Members subtab
  // ----------------------------------------------------------------
  function renderHillMembers() {
    var grid = $('hillMGrid'); if (!grid) return;
    var members = (DB.list && DB.list('hill_members')) || [];

    // Populate state + committee filter dropdowns lazily
    var stateSel = $('hillMState');
    if (stateSel && stateSel.options.length <= 1) {
      var states = Array.from(new Set(members.map(function (m) { return m.state; }).filter(Boolean))).sort();
      stateSel.innerHTML = '<option value="">All states</option>' + states.map(function (s) { return '<option>' + esc(s) + '</option>'; }).join('');
    }
    var commSel = $('hillMCommittee');
    if (commSel && commSel.options.length <= 1) {
      var comms = ((DB.list && DB.list('hill_committees')) || []).filter(function (c) { return c && !c.parent_thomas_id; }).sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
      commSel.innerHTML = '<option value="">All committees</option>' + comms.map(function (c) { return '<option value="' + esc(c.thomas_id) + '">' + esc(c.name) + ' (' + esc(c.chamber) + ')</option>'; }).join('');
    }

    var q = (($('hillMSearch') || {}).value || '').toLowerCase();
    var ch = (($('hillMChamber') || {}).value || '');
    var pa = (($('hillMParty') || {}).value || '');
    var st = (($('hillMState') || {}).value || '');
    var co = (($('hillMCommittee') || {}).value || '');
    var pri = !!(($('hillMPriority') || {}).checked);

    var filtered = members.filter(function (m) {
      if (!m) return false;
      if (ch && m.chamber !== ch) return false;
      if (pa && m.party !== pa) return false;
      if (st && m.state !== st) return false;
      if (pri && !m.is_priority) return false;
      if (co) {
        var mships = membershipsForMember(m.bioguide_id);
        if (!mships.some(function (r) { return r.thomas_id === co || (committeeById(r.thomas_id) || {}).parent_thomas_id === co; })) return false;
      }
      if (q) {
        var hay = (m.full_name || '') + ' ' + (m.state || '') + ' ' + (m.district == null ? '' : ('-' + m.district));
        if (hay.toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });

    filtered.sort(function (a, b) {
      if (!!b.is_priority - !!a.is_priority) return (!!b.is_priority) - (!!a.is_priority);
      return (a.last_name || a.full_name || '').localeCompare(b.last_name || b.full_name || '');
    });

    var cnt = $('hillMCount'); if (cnt) cnt.textContent = filtered.length + ' members';

    if (!members.length) {
      grid.innerHTML = '<div style="grid-column:1/-1;padding:30px;text-align:center;color:var(--text-dim);">'
        + '<strong>No Hill Ops data yet.</strong><br>'
        + 'Click <em>Sync now</em> to pull members + committees from Congress.gov + theunitedstates.io.<br>'
        + '<small>(Apply Supabase/v103-hill-ops.sql first if you haven\'t already.)</small></div>';
      return;
    }

    grid.innerHTML = filtered.map(function (m) {
      var pk = partyKey(m.party);
      var photo = m.photo_url ? ('<div class="hill-member-photo" style="background-image:url(\'' + esc(m.photo_url) + '\')"></div>')
                              : ('<div class="hill-member-photo">' + esc(((m.first_name || ' ')[0] || '') + ((m.last_name || ' ')[0] || '')) + '</div>');
      var subBits = [];
      if (m.chamber === 'senate') subBits.push('Senator');
      else subBits.push('Rep.');
      if (m.state) subBits.push(m.state + (m.district != null ? '-' + m.district : ''));
      var leadHtml = m.leadership_title ? '<span class="hill-member-badge lead">' + esc(m.leadership_title) + '</span>' : '';
      // badge row instead. Detail panel still lists every committee.
      var commCount = membershipsForMember(m.bioguide_id).length;
      var commBadge = '<span class="hill-member-badge" title="Committees">COM ' + commCount + '</span>';
      // and aren't reachable from this scope. Use DB.state directly.
      var _hm = (DB.state && DB.state.hill_meetings) || [];
      var _hr = (DB.state && DB.state.hill_requests) || [];
      var mtgCount = _hm.filter(function(r){ return r && r.target_type === 'member' && r.target_id === m.bioguide_id; }).length;
      var reqCount = _hr.filter(function(r){ return r && r.target_type === 'member' && r.target_id === m.bioguide_id; }).length;
      var mtgBadge = '<span class="hill-member-badge" title="Meetings">MTG ' + mtgCount + '</span>';
      var reqBadge = '<span class="hill-member-badge" title="Requests">REQ ' + reqCount + '</span>';
      return '<div class="hill-member-card' + (m.is_priority ? ' priority' : '') + '" data-bioguide="' + esc(m.bioguide_id) + '">'
        + photo
        + '<div class="hill-member-meta">'
        +   '<div class="hill-member-name">'
        +     '<span class="hill-member-star ' + (m.is_priority ? '' : 'off') + '" data-star="' + esc(m.bioguide_id) + '" title="Priority">&#9733;</span>'
        +     esc(m.full_name)
        +   '</div>'
        +   '<div class="hill-member-sub">' + esc(subBits.join(' \u00B7 ')) + '</div>'
        +   '<div class="hill-member-badges">'
        +     '<span class="hill-member-badge party-' + pk + '">' + esc((m.party || '').slice(0, 1) || '?') + '</span>'
        +     '<span class="hill-member-badge">' + esc(m.chamber === 'senate' ? 'Senate' : 'House') + '</span>'
        +     commBadge
        +     mtgBadge
        +     reqBadge
        +     leadHtml
        +   '</div>'
        + '</div>'
        + '</div>';
    }).join('');
  }

  // ----------------------------------------------------------------
  // Committees subtab
  // ----------------------------------------------------------------
  function renderHillCommittees() {
    var tree = $('hillCTree'); if (!tree) return;
    var comms = (DB.list && DB.list('hill_committees')) || [];
    var q = (($('hillCSearch') || {}).value || '').toLowerCase();
    var ch = (($('hillCChamber') || {}).value || '');

    var byParent = {};
    comms.forEach(function (c) {
      if (c.parent_thomas_id) (byParent[c.parent_thomas_id] = byParent[c.parent_thomas_id] || []).push(c);
    });
    var fulls = comms.filter(function (c) { return !c.parent_thomas_id; }).sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    if (ch) fulls = fulls.filter(function (c) { return c.chamber === ch; });
    if (q) fulls = fulls.filter(function (c) { return ((c.name || '') + ' ' + (c.jurisdiction || '')).toLowerCase().indexOf(q) >= 0; });

    var cnt = $('hillCCount'); if (cnt) cnt.textContent = fulls.length + ' committees';
    if (!comms.length) {
      tree.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-dim);">No Hill Ops data yet. Click <em>Sync now</em> on the Members subtab.</div>';
      return;
    }

    tree.innerHTML = fulls.map(function (c) { return committeeRowHtml(c, byParent); }).join('');
  }

  function committeeRowHtml(c, byParent) {
    var subs = (byParent[c.thomas_id] || []).sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    var hasSubs = subs.length > 0;
    var chev = hasSubs
      ? '<span class="hill-committee-chevron" title="Show subcommittees">\u25B6</span>'
      : '<span class="hill-committee-chevron empty"></span>';
    function _mtgReqBadges(tid) {
      var _hm = (DB.state && DB.state.hill_meetings) || [];
      var _hr = (DB.state && DB.state.hill_requests) || [];
      var mc = _hm.filter(function(r){ return r && r.target_type === 'committee' && r.target_id === tid; }).length;
      var rc = _hr.filter(function(r){ return r && r.target_type === 'committee' && r.target_id === tid; }).length;
      return '<span class="hill-member-badge" title="Meetings">MTG ' + mc + '</span>'
           + '<span class="hill-member-badge" title="Requests">REQ ' + rc + '</span>';
    }
    return '<div class="hill-committee-row' + (hasSubs ? ' has-subs' : '') + '" data-tid="' + esc(c.thomas_id) + '">'
      + '<div class="hill-committee-head">'
      +   chev
      +   '<span class="hill-committee-name">' + esc(c.name) + '</span>'
      +   '<span class="hill-committee-meta">' + esc(c.chamber) + (subs.length ? ' \u00B7 ' + subs.length + ' subc.' : '') + '</span>'
      +   '<span class="hill-member-badges" style="margin-left:auto;">' + _mtgReqBadges(c.thomas_id) + '</span>'
      + '</div>'
      + (hasSubs
          ? '<div class="hill-committee-subc-list">' + subs.map(function (sc) {
              return '<div class="hill-committee-row subc" data-tid="' + esc(sc.thomas_id) + '">'
                   + '<div class="hill-committee-head">'
                   +   '<span class="hill-committee-chevron empty"></span>'
                   +   '<span class="hill-committee-name">' + esc(sc.name) + '</span>'
                   +   '<span class="hill-committee-meta">subcommittee</span>'
                   +   '<span class="hill-member-badges" style="margin-left:auto;">' + _mtgReqBadges(sc.thomas_id) + '</span>'
                   + '</div>'
                   + '</div>';
            }).join('') + '</div>'
          : '')
      + '</div>';
  }

  function rosterHtml(tid) {
    var rows = membershipsForCommittee(tid);
    if (!rows.length) return '<div class="hill-committee-roster-section" style="color:var(--text-dim);">No roster data.</div>';
    var maj = rows.filter(function (r) { return r.side === 'majority'; });
    var min = rows.filter(function (r) { return r.side === 'minority'; });
    function chip(r) {
      var m = memberById(r.bioguide_id) || {};
      var pk = partyKey(m.party);
      var roleLead = (r.role === 'Chair' || r.role === 'Ranking Member' || r.role === 'Vice Chair');
      return '<span class="hill-roster-chip ' + (roleLead ? 'role-lead' : '') + '" data-bioguide="' + esc(r.bioguide_id) + '">'
        + '<span class="pmark ' + pk + '"></span>'
        + esc(m.full_name || r.bioguide_id) + (roleLead ? ' (' + esc(r.role) + ')' : '')
        + '</span>';
    }
    var html = '';
    if (maj.length) html += '<div class="hill-committee-roster-section"><h5>Majority (' + maj.length + ')</h5><div class="hill-roster-list">' + maj.map(chip).join('') + '</div></div>';
    if (min.length) html += '<div class="hill-committee-roster-section"><h5>Minority (' + min.length + ')</h5><div class="hill-roster-list">' + min.map(chip).join('') + '</div></div>';
    if (!maj.length && !min.length) html += '<div class="hill-committee-roster-section"><div class="hill-roster-list">' + rows.map(chip).join('') + '</div></div>';
    return html;
  }

  // ----------------------------------------------------------------
  // Member drawer
  // ----------------------------------------------------------------
  function openHillMemberDrawer(bg) {
    var m = memberById(bg); if (!m) return;
    var panel = $('detail-panel'); if (!panel) return;
    // built for office cards; .panel-title-text / .panel-subtitle / .panel-body
    // are the actual DOM nodes — the v103 .dp-head/.dp-body selectors silently
    // returned null, which is why clicking a member card did nothing).
    var titleEl = panel.querySelector('.panel-title-text');
    var subEl   = panel.querySelector('.panel-subtitle');
    var body    = panel.querySelector('.panel-body');
    if (!body) return;
    // Hide the star/prev/next/budget/related sections — they're office-card features
    var starBtn = panel.querySelector('.panel-star'); if (starBtn) starBtn.style.display = 'none';
    var pBudget = panel.querySelector('#panel-budget'); if (pBudget) pBudget.style.display = 'none';
    var pRel    = panel.querySelector('#panel-related'); if (pRel) pRel.style.display = 'none';
    var pBadges = panel.querySelector('.panel-role-badges'); if (pBadges) pBadges.innerHTML = '';
    var pCounters = panel.querySelector('.panel-counters'); if (pCounters) pCounters.innerHTML = '';

    if (titleEl) titleEl.textContent = m.full_name || '';
    var subParts = [];
    if (m.chamber) subParts.push(m.chamber === 'senate' ? 'Senator' : 'Representative');
    if (m.state) subParts.push(m.state + (m.district != null ? '-' + m.district : ''));
    if (m.party) subParts.push(m.party);
    if (m.leadership_title) subParts.push(m.leadership_title);
    if (subEl) subEl.textContent = subParts.join(' \u00B7 ');

    var photo = m.photo_url ? '<div class="hill-mdraw-photo" style="background-image:url(\'' + esc(m.photo_url) + '\')"></div>' : '';

    var linkedContacts = ((DB.list && DB.list('contacts')) || [])
      .filter(function (c) { return c && c.legislator_bioguide_id === bg; });
    linkedContacts.sort(function (a, b) {
      var ac = a.champion ? 0 : 1, bc = b.champion ? 0 : 1;
      if (ac !== bc) return ac - bc;
      return (a.lastName || '').localeCompare(b.lastName || '');
    });
    var linkedHtml;
    if (!linkedContacts.length) {
      linkedHtml = '<div style="font-size:11.5px;color:var(--text-dim);">No contacts linked to this Member yet. Open a contact and pick this Member in the Add/Edit modal under Link to › Congress.</div>';
    } else {
      linkedHtml = '<div class="hill-mdraw-contacts">'
        + linkedContacts.map(function (c) {
            var fullName = ((c.firstName || '') + ' ' + (c.lastName || '')).trim() || '(unnamed contact)';
            var titleBits = [];
            if (c.rank)  titleBits.push(esc(c.rank));
            if (c.title) titleBits.push(esc(c.title));
            var contactBits = [];
            if (c.email) contactBits.push('<a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a>');
            if (c.phone) contactBits.push('<a href="tel:' + esc(c.phone) + '">' + esc(c.phone) + '</a>');
            return '<div class="hill-mdraw-contact-row" data-linked-contact="' + esc(c.id) + '">'
              + (c.champion ? '<span class="hill-mdraw-star" title="Champion">★</span>' : '')
              + '<div class="hill-mdraw-contact-meta">'
              +   '<div class="hill-mdraw-contact-name">' + esc(fullName) + '</div>'
              + (titleBits.length ? '<div class="hill-mdraw-contact-title">' + titleBits.join(' · ') + '</div>' : '')
              + (contactBits.length ? '<div class="hill-mdraw-contact-contact">' + contactBits.join(' · ') + '</div>' : '')
              + '</div>'
              + '<button class="hm-drawer-open" data-open-contact="' + esc(c.id) + '">Open ›</button>'
              + '</div>';
          }).join('')
        + '</div>';
    }

    var rows = membershipsForMember(bg).map(function (r) {
      var c = committeeById(r.thomas_id) || {};
      return '<li>' + esc(c.name || r.thomas_id) + (r.role && r.role !== 'Member' ? ' \u00B7 <strong>' + esc(r.role) + '</strong>' : '') + '</li>';
    }).join('');

    body.innerHTML = photo
      + '<div class="hill-mdraw-row"><div class="label">bioguide</div><div class="val"><a href="https://bioguide.congress.gov/search/bio/' + esc(m.bioguide_id) + '" target="_blank" rel="noopener">' + esc(m.bioguide_id) + '</a></div></div>'
      + (m.office_address ? '<div class="hill-mdraw-row"><div class="label">Office</div><div class="val">' + esc(m.office_address) + '</div></div>' : '')
      + (m.office_phone ? '<div class="hill-mdraw-row"><div class="label">Phone</div><div class="val"><a href="tel:' + esc(m.office_phone) + '">' + esc(m.office_phone) + '</a></div></div>' : '')
      + (m.contact_form_url ? '<div class="hill-mdraw-row"><div class="label">Contact form</div><div class="val"><a href="' + esc(m.contact_form_url) + '" target="_blank" rel="noopener">' + esc(m.contact_form_url) + '</a></div></div>' : '')
      + (m.official_url ? '<div class="hill-mdraw-row"><div class="label">Website</div><div class="val"><a href="' + esc(m.official_url) + '" target="_blank" rel="noopener">' + esc(m.official_url) + '</a></div></div>' : '')
      + (m.bio_summary ? '<div class="hill-mdraw-section"><h4>Bio</h4><div style="font-size:11.5px;color:var(--text);line-height:1.4;">' + esc(m.bio_summary) + '</div></div>' : '')
      + '<div class="hill-mdraw-section"><h4>Committees (' + membershipsForMember(bg).length + ')</h4><ul style="margin:0;padding-left:18px;font-size:11.5px;">' + (rows || '<li style="list-style:none;color:var(--text-dim);">None on file.</li>') + '</ul></div>'
      + (typeof window.meetingsSectionHtml === 'function' ? window.meetingsSectionHtml('member', bg) : '')
      + '<div class="hill-mdraw-section"><h4>Outreach</h4>'
      +   '<div class="hill-mdraw-row"><div class="label">Priority</div><div class="val"><label><input type="checkbox" id="hmEditPriority"' + (m.is_priority ? ' checked' : '') + '> Mark as priority</label></div></div>'
      +   '<div class="hill-mdraw-row"><div class="label">Owner</div><div class="val"><input class="hill-mdraw-input" id="hmEditOwner" value="' + esc(m.owner || '') + '" placeholder="Internal owner / lobbyist on file"></div></div>'
      +   '<div class="hill-mdraw-row"><div class="label">Last contacted</div><div class="val"><input class="hill-mdraw-input" id="hmEditLast" type="date" value="' + esc(m.last_contacted || '') + '"></div></div>'
      +   '<div class="hill-mdraw-row"><div class="label">Notes</div><div class="val"><textarea class="hill-mdraw-textarea" id="hmEditNotes" placeholder="Meeting notes, asks, relationship status...">' + esc(m.notes || '') + '</textarea></div></div>'
      +   '<div style="margin-top:8px;text-align:right;"><button class="btn primary" id="hmEditSave">Save</button></div>'
      + '</div>'
      + '<div class="hill-mdraw-section hill-mdraw-section--linked"><h4>Linked Contacts (' + linkedContacts.length + ')</h4>' + linkedHtml + '</div>';

    panel.classList.add('open');

    var saveBtn = $('hmEditSave');
    if (saveBtn) saveBtn.onclick = function () {
      var patch = {
        is_priority:    !!($('hmEditPriority') && $('hmEditPriority').checked),
        owner:          ($('hmEditOwner') || {}).value || null,
        last_contacted: ($('hmEditLast')  || {}).value || null,
        notes:          ($('hmEditNotes') || {}).value || null,
      };
      Object.assign(m, patch);
      if (typeof window._hillSaveUpdate === 'function') window._hillSaveUpdate('hill_members', 'bioguide_id', m.bioguide_id, patch);
      panel.classList.remove('open');
      renderHillMembers();
    };

    body.querySelectorAll('[data-open-contact]').forEach(function (b) {
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var cid = b.getAttribute('data-open-contact');
        if (typeof window.openContactDetailPanel === 'function') {
          window.openContactDetailPanel(cid);
        } else if (typeof window.editContact === 'function') {
          window.editContact(cid);
        }
      });
    });
    body.querySelectorAll('[data-linked-contact]').forEach(function (row) {
      row.addEventListener('click', function (ev) {
        if (ev.target.closest('button, a')) return;
        var cid = row.getAttribute('data-linked-contact');
        if (typeof window.openContactDetailPanel === 'function') {
          window.openContactDetailPanel(cid);
        }
      });
    });
  }

  // ----------------------------------------------------------------
  // Sync now
  // ----------------------------------------------------------------
  async function syncHillNow() {
    var status = $('hillSyncStatus'); var btn = $('hillSyncBtn');
    if (status) { status.className = 'hill-sync-status syncing'; status.textContent = 'Syncing… (this can take 20s)'; }
    if (btn) btn.disabled = true;
    try {
      var res = await fetch('/.netlify/functions/hill-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      if (status) { status.className = 'hill-sync-status ok'; status.textContent = 'Synced ' + data.counts.members + ' members, ' + data.counts.committees + ' committees, ' + data.counts.memberships + ' memberships'; }
      // Refresh in-memory cache by re-reading the three tables.
      if (typeof _refreshHillTables === 'function') await _refreshHillTables();
      renderHillMembers(); renderHillCommittees();
    } catch (e) {
      if (status) { status.className = 'hill-sync-status err'; status.textContent = 'Sync failed: ' + (e && e.message || e); }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ----------------------------------------------------------------
  // Re-pull the three Hill Ops tables from Supabase into DB.state
  // ----------------------------------------------------------------
  async function _refreshHillTables() {
    if (typeof _sb === 'undefined' || !_sb) return;
    // so a naive select('*') silently dropped everything past row 1000 -- which
    // is why subcommittee rosters all appeared empty. Paginate via .range().
    var PAGE = 1000;
    var tables = ['hill_members', 'hill_committees', 'hill_committee_memberships', 'hill_meetings', 'hill_requests'];
    for (var i = 0; i < tables.length; i++) {
      try {
        var t = tables[i];
        var all = [];
        for (var start = 0; start < 200000; start += PAGE) {
          var end = start + PAGE - 1;
          var res = await _sb.from(t).select('*').range(start, end);
          if (res.error) { console.warn('hill refresh', t, res.error); break; }
          var batch = res.data || [];
          all = all.concat(batch);
          if (batch.length < PAGE) break;
        }
        DB.state[t] = all;
      } catch (e) { console.warn('hill refresh', tables[i], e); }
    }
  }
  window._refreshHillTables = _refreshHillTables;

  // ----------------------------------------------------------------
  // Wiring
  // ----------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    ['hillMSearch', 'hillMChamber', 'hillMParty', 'hillMState', 'hillMCommittee', 'hillMPriority'].forEach(function (id) {
      var el = $(id); if (!el) return;
      var ev = (el.tagName === 'INPUT' && el.type !== 'checkbox') ? 'input' : 'change';
      el.addEventListener(ev, renderHillMembers);
    });
    ['hillCSearch', 'hillCChamber'].forEach(function (id) {
      var el = $(id); if (!el) return;
      el.addEventListener(el.tagName === 'INPUT' ? 'input' : 'change', renderHillCommittees);
    });
    var btn = $('hillSyncBtn'); if (btn) btn.addEventListener('click', syncHillNow);
  });

  // Card click -> drawer; star click toggles priority
  document.addEventListener('click', function (e) {
    var star = e.target.closest && e.target.closest('.hill-member-star');
    if (star) {
      e.stopPropagation();
      var bg = star.dataset.star;
      var m = memberById(bg); if (!m) return;
      var newVal = !m.is_priority;
      m.is_priority = newVal;
      if (typeof window._hillSaveUpdate === 'function') window._hillSaveUpdate('hill_members', 'bioguide_id', m.bioguide_id, { is_priority: newVal });
      renderHillMembers();
      return;
    }
    var card = e.target.closest && e.target.closest('.hill-member-card');
    if (card) {
      var bg2 = card.dataset.bioguide;
      if (bg2) openHillMemberDrawer(bg2);
      return;
    }
    var head = e.target.closest && e.target.closest('.hill-committee-head');
    if (head) {
      // inline-expand toggle was removed — roster now lives in the drawer.
      return;
    }
    var chip = e.target.closest && e.target.closest('.hill-roster-chip');
    if (chip) {
      var bg3 = chip.dataset.bioguide;
      if (bg3) openHillMemberDrawer(bg3);
    }
  });

  // Hook into the global subtab handler so renders fire on click
  var origSubtabAttach = function () {
    document.querySelectorAll('[data-subtab-group="washops"] .subtab-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = b.dataset.subtab;
        if (t === 'washops-members') setTimeout(renderHillMembers, 0);
        else if (t === 'washops-committees') setTimeout(renderHillCommittees, 0);
      });
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', origSubtabAttach);
  else origSubtabAttach();

  // Hook into the rail / top-tab activation: when Hill Ops tab is shown,
  // render members AND summary AND committees. v124: previously only
  // renderHillMembers fired here, so the default-active Summary subtab
  // stayed empty ("Loading...") until the user clicked Members or
  // Committees and came back. Now all three subtab panels render so the
  // user sees populated content immediately on tab open.
  document.querySelectorAll('[data-tab="washops"], [data-v98-tab="washops"]').forEach(function (b) {
    b.addEventListener('click', function () {
      setTimeout(renderHillMembers, 50);
      setTimeout(function(){ if (typeof renderHillCommittees === 'function') renderHillCommittees(); }, 50);
      setTimeout(function(){ if (typeof renderHillSummary === 'function') renderHillSummary(); }, 50);
    });
  });

  // Expose for debugging
  window.renderHillMembers = renderHillMembers;
  window.renderHillCommittees = renderHillCommittees;
  window.openHillMemberDrawer = openHillMemberDrawer;
  window.syncHillNow = syncHillNow;
})();

