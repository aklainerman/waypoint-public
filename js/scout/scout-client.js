// js/scout/scout-client.js
//
// SCOUT tab (v92) — LLM CRM-agent kickoff, polling, and rendering.
//
// Originally an inline IIFE at the bottom of index.html; lifted to ES module
// in v180. The original outer IIFE also wired the v55 Sankey threshold input
// and v55/v66 Expand-all / Collapse-all toggles, plus a window-resize re-render
// for Sankey + Office View. Those ~50 lines remain at the top of this module
// because they share the IIFE; they will split out into
// js/render/budget-sankey-wiring.js in a v180.x pass.
//
// SCOUT object itself is captured in the inner IIFE scope and never escapes;
// cross-tab callers reach it through the DOM event handlers SCOUT registers
// at boot. No window.SCOUT exposure exists or is needed.

(function(){
  document.addEventListener('input', function(ev){
    if (ev.target && ev.target.id === 'budgetSankeyThreshold') {
      var v = Number(ev.target.value);
      if (!isFinite(v) || v < 0) return;
      window._budgetSankeyState = window._budgetSankeyState || {};
      window._budgetSankeyState.thresholdM = v;
      if (typeof renderBudgetSankey === 'function') renderBudgetSankey();
    }
  });
  // v55+v66: Expand-all / Collapse-all toggle buttons. Both buttons now
  // operate on accts AND BAs in lockstep so users can flip between the
  // fully-collapsed (svc + acct only) and fully-expanded (all PEs) views.
  document.addEventListener('click', function(ev){
    var t = ev.target;
    if (!t || !t.id) return;
    if (t.id === 'budgetSankeyExpandAll') {
      window._budgetSankeyState = window._budgetSankeyState || {};
      var sBA = window._budgetSankeyState.expandedBas = new Set();
      var sAcct = window._budgetSankeyState.expandedAccts = new Set();
      var apprs = (typeof DB !== 'undefined' && DB.list) ? DB.list('budget_appropriations') || [] : [];
      apprs.forEach(function(a){
        sBA.add(a.id);
        if (a.account) sAcct.add(a.account);
      });
      if (typeof renderBudgetSankey === 'function') renderBudgetSankey();
    } else if (t.id === 'budgetSankeyCollapseAll') {
      window._budgetSankeyState = window._budgetSankeyState || {};
      window._budgetSankeyState.expandedBas = new Set();
      window._budgetSankeyState.expandedAccts = new Set();
      if (typeof renderBudgetSankey === 'function') renderBudgetSankey();
    }
  });
  // Re-render on window resize (debounced).
  var _rzT = null;
  window.addEventListener('resize', function(){
    if (_rzT) clearTimeout(_rzT);
    _rzT = setTimeout(function(){
      var active = document.querySelector('[data-subtab-group="budget"] .subtab-btn.active');
      if (active && active.dataset.subtab === 'budget-sankey' && typeof renderBudgetSankey === 'function') {
        renderBudgetSankey();
      }
      if (active && active.dataset.subtab === 'budget-office-view' && typeof renderBudgetOfficeView === 'function') {
        renderBudgetOfficeView();
      }
    }, 250);
  });

/* ============ SCOUT TAB (v92) ============ */
const SCOUT = (function(){
  // and fires the scout-background worker fire-and-forget. The client
  // polls /scout-status?job_id=<id>&since=<n> for incremental events.
  const FN        = '/.netlify/functions/scout';
  const STATUS_FN = '/.netlify/functions/scout-status';
  const state = {
    activeSearchId: null,
    sending: false,
    findings: [],            // current search's findings, reactive
    searches: [],
    activeJobId: null,       // v92: lets us cancel polling on user nav
  };

  const el = id => document.getElementById(id);

  // bearer when available. Before v165 this helper used the anon key as the
  // bearer, which silently 0-rowed every read against RLS-gated tables
  // (scout_searches, scout_jobs, scout_messages, scout_findings) because the
  //
  // The token is cached in _restBearer + refreshed on every auth state
  // change so we don't hit getSession() on every call. The anon key remains
  // the apikey header for Supabase's request routing — that's separate from
  // the user JWT that drives RLS.
  let _restBearer = null;
  window.CURRENT_USER_EMAIL = window.CURRENT_USER_EMAIL || null;
  (function wireRestBearer() {
    if (typeof _sb === 'undefined' || !_sb || !_sb.auth) return;
    function applySession(session) {
      _restBearer = (session && session.access_token) || null;
      window.CURRENT_USER_EMAIL = (session && session.user && session.user.email) || null;
    }
    // Prime from existing session on page load.
    _sb.auth.getSession().then(({ data }) => {
      applySession(data && data.session);
    }).catch(() => {});
    // Keep both in sync as the session refreshes / signs out.
    _sb.auth.onAuthStateChange((event, session) => {
      applySession(session);
    });
  })();
  async function rest(method, path, body) {
    if (typeof _sb === 'undefined' || !_sb) throw new Error('Supabase not ready');
    // If we don't have a cached bearer yet (e.g. very first request after
    // hard reload), grab one synchronously from the session. getSession()
    // resolves immediately when a session is stored in localStorage.
    if (!_restBearer && _sb.auth) {
      try {
        const { data } = await _sb.auth.getSession();
        _restBearer = (data && data.session && data.session.access_token) || null;
      } catch (_e) { /* fall through to anon */ }
    }
    const url = _sb.supabaseUrl.replace(/\/+$/,'') + '/rest/v1/' + path;
    const opts = {
      method,
      headers: {
        apikey: _sb.supabaseKey,
        Authorization: 'Bearer ' + (_restBearer || _sb.supabaseKey),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    };
    if (method !== 'GET') opts.headers['Prefer'] = 'return=representation';
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    if (!r.ok) {
      const t = await r.text();
      throw new Error(method + ' ' + path + ' ' + r.status + ': ' + t.slice(0,200));
    }
    const txt = await r.text();
    return txt ? JSON.parse(txt) : null;
  }

  // Auth header for Scout Netlify function calls (kickoff + status polling).
  // Mirrors the same _restBearer the rest() helper uses; falls back to {} if
  // unauthenticated (the function will then 401, which surfaces as a clean
  // error to the caller).
  async function scoutFnAuth() {
    if (!_restBearer && typeof _sb !== 'undefined' && _sb && _sb.auth) {
      try {
        const { data } = await _sb.auth.getSession();
        _restBearer = (data && data.session && data.session.access_token) || null;
      } catch (_e) { /* no session */ }
    }
    return _restBearer ? { Authorization: 'Bearer ' + _restBearer } : {};
  }


  // ---------- Searches sidebar ----------
  async function refreshSearches() {
    try {
      const rows = await rest('GET', 'scout_searches?select=id,title,created_by,updated_at,status&status=eq.active&order=updated_at.desc&limit=50');
      state.searches = rows || [];
      renderSearches();
    } catch (e) { setStatus('Could not load searches: ' + e.message, true); }
  }

  function renderSearches() {
    const list = el('scoutSearchList');
    if (!state.searches.length) {
      list.innerHTML = '<div class="scout-empty">No searches yet. Click + New.</div>';
      return;
    }
    list.innerHTML = state.searches.map(s => {
      const d = new Date(s.updated_at);
      const dStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      const author = s.created_by ? (s.created_by.split('@')[0]) : '';
      const cls = s.id === state.activeSearchId ? ' active' : '';
      return '<div class="scout-search-row' + cls + '" data-id="' + s.id + '">' +
        '<div class="scout-search-content">' +
          '<div>' + escapeHtml(s.title || 'Untitled') + '</div>' +
          '<div class="meta"><span>' + dStr + '</span><span>' + escapeHtml(author) + '</span></div>' +
        '</div>' +
        '<button class="scout-search-delete" data-delete-id="' + s.id + '" title="Delete this search" aria-label="Delete">×</button>' +
        '</div>';
    }).join('');
    list.querySelectorAll('[data-id]').forEach(row => {
      row.onclick = (e) => {
        if (e.target.closest('[data-delete-id]')) return;
        loadSearch(row.dataset.id);
      };
    });
    list.querySelectorAll('[data-delete-id]').forEach(btn => {
      btn.onclick = (e) => { e.stopPropagation(); deleteSearch(btn.dataset.deleteId); };
    });
  }

  async function deleteSearch(searchId) {
    const s = state.searches.find(x => x.id === searchId);
    const label = (s && s.title) ? s.title : 'this search';
    if (!confirm('Delete \u201C' + label + '\u201D and all its findings?\n\nThis cannot be undone.')) return;
    try {
      await rest('DELETE', 'scout_searches?id=eq.' + searchId);
      state.searches = state.searches.filter(x => x.id !== searchId);
      if (state.activeSearchId === searchId) {
        newSearch();
      } else {
        renderSearches();
      }
      setStatus('Deleted.');
    } catch (e) {
      setStatus('Delete failed: ' + e.message, true);
    }
  }

  // ---------- Active search ----------
  async function loadSearch(searchId) {
    state.activeSearchId = searchId;
    state.activeJobId = null;  // v92: cancels any in-flight poll loop
    renderSearches();
    el('scoutMessages').innerHTML = '<div class="scout-empty">Loading…</div>';
    el('scoutFindingsList').innerHTML = '<div class="scout-empty">Loading…</div>';
    try {
      const [search, msgs, findings, calls] = await Promise.all([
        rest('GET', 'scout_searches?id=eq.' + searchId + '&select=*&limit=1'),
        rest('GET', 'scout_messages?search_id=eq.' + searchId + '&order=created_at.asc&select=role,content,created_at'),
        rest('GET', 'scout_findings?search_id=eq.' + searchId + '&order=created_at.asc&select=*'),
        rest('GET', 'scout_tool_calls?search_id=eq.' + searchId + '&order=created_at.asc&select=tool_name,arguments,result,result_summary,latency_ms,error,created_at'),
      ]);
      const s = (search || [])[0] || {};
      el('scoutThreadTitle').textContent = s.title || 'Search';
      el('scoutThreadMeta').textContent = s.created_by ? ('by ' + s.created_by) : '';
      state.findings = findings || [];
      renderConversation(msgs || [], calls || []);
      renderFindings();
    } catch (e) {
      setStatus('Could not load search: ' + e.message, true);
    }
  }

  function newSearch() {
    state.activeSearchId = null;
    state.activeJobId = null;  // v92: cancels any in-flight poll loop
    state.findings = [];
    renderSearches();
    el('scoutThreadTitle').textContent = 'New search';
    el('scoutThreadMeta').textContent = '';
    el('scoutMessages').innerHTML =
      '<div class="scout-welcome">' +
      '<h3>Scout — agentic CRM search</h3>' +
      '<p>Ask Scout to find contacts at a DoD office. It searches Waypoint, SAM.gov, USAspending, DVIDS, the open web, and reads pages directly.</p>' +
      '<div class="scout-examples">' +
      '<button class="scout-example">Find 5 contracting officers at PEO STRI from solicitations posted in the last 6 months.</button>' +
      '<button class="scout-example">Who runs PEO Soldier? I want names, titles, and any public emails.</button>' +
      '<button class="scout-example">Find the program manager and key engineers for the Army Robotic Combat Vehicle program.</button>' +
      '</div></div>';
    el('scoutFindingsList').innerHTML = '<div class="scout-empty">Findings will appear here as Scout works.</div>';
    bindExamples();
    setStatus('');
  }

  // ---------- Render conversation (interleaves messages + tool_calls) ----------
  function renderConversation(messages, toolCalls) {
    const box = el('scoutMessages');
    box.innerHTML = '';
    // Build a flat list: text/user msgs in order; tool_calls indexed by created_at
    const tcByTime = (toolCalls || []).slice().sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
    let tcIdx = 0;
    for (const m of messages) {
      const t = new Date(m.created_at).getTime();
      // Drain tool_calls that occurred before this message
      while (tcIdx < tcByTime.length && new Date(tcByTime[tcIdx].created_at).getTime() <= t) {
        appendToolCard(box, tcByTime[tcIdx]); tcIdx++;
      }
      if (m.role === 'user' && typeof m.content === 'string') {
        appendUserMsg(box, m.content);
      } else if (m.role === 'assistant' && Array.isArray(m.content)) {
        // Merge all text blocks in this turn into a single bubble — Anthropic
        // splits them around web_search results, but the user reads them as one.
        const txt = m.content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('');
        if (txt) appendAssistantMsg(box, txt);
      }
    }
    while (tcIdx < tcByTime.length) { appendToolCard(box, tcByTime[tcIdx]); tcIdx++; }
    box.scrollTop = box.scrollHeight;
  }

  function appendUserMsg(box, text) {
    const d = document.createElement('div');
    d.className = 'scout-msg user';
    d.textContent = text;
    box.appendChild(d);
  }
  function appendAssistantMsg(box, text) {
    const d = document.createElement('div');
    d.className = 'scout-msg assistant';
    d.innerHTML = renderScoutMarkdown(text);
    box.appendChild(d);
  }

  // Supports: ## heading, ### heading, **bold**, [text](url), bare https URLs,
  // linkedin.com/in/... bare URLs, mailto/tel autolinks, blank-line paragraphs,
  // and basic list bullets ("- " at line start). HTML is escaped first so the
  // model can't inject script.
  function renderScoutMarkdown(text) {
    // 1. Escape HTML.
    let s = String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    // 2. Markdown links [text](url) BEFORE bare URL detection so we don't
    //    double-linkify.
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      function (_m, label, url) {
        return '<a href="' + url + '" target="_blank" rel="noopener">' + label + '</a>';
      });

    // 3. Bare LinkedIn URLs — most common in our output.
    s = s.replace(/(^|[\s(\[])(linkedin\.com\/[a-z0-9._/-]+)/gi,
      function (_m, before, url) {
        return before + '<a href="https://' + url + '" target="_blank" rel="noopener">' + url + '</a>';
      });

    // 4. Bare https URLs.
    s = s.replace(/(^|[\s(\[])(https?:\/\/[^\s<)\]]+)/g,
      function (_m, before, url) {
        return before + '<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>';
      });

    // 5. Emails -> mailto:
    s = s.replace(/(^|[\s(\[<>])([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g,
      function (_m, before, email) {
        return before + '<a href="mailto:' + email + '">' + email + '</a>';
      });

    // 6. US phone numbers -> tel:
    s = s.replace(/(^|[\s(\[])((?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})\b/g,
      function (_m, before, phone) {
        const digits = phone.replace(/\D/g, '');
        if (digits.length < 10 || digits.length > 11) return _m;
        return before + '<a href="tel:+' + (digits.length === 10 ? '1' : '') + digits + '">' + phone + '</a>';
      });

    // 7. Headings (line-anchored, processed before bold).
    s = s.replace(/^###\s+(.+)$/gm, '<h4 class="scout-md-h4">$1</h4>');
    s = s.replace(/^##\s+(.+)$/gm,  '<h3 class="scout-md-h3">$1</h3>');
    s = s.replace(/^#\s+(.+)$/gm,   '<h2 class="scout-md-h2">$1</h2>');

    // 8. Bold (after links so we don't bold inside an href attribute).
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

    // 9. List items ("- " or "* " at line start). Convert each to a li-like
    //    flexed row with the bullet glyph; cheaper than wrapping in <ul>.
    s = s.replace(/^[-*]\s+(.+)$/gm, '<div class="scout-md-li"><span class="scout-md-bullet">\u2022</span><span>$1</span></div>');

    // 10. Paragraph breaks (blank line) -> stack break; single newline -> br.
    //     Only apply outside the list/heading spans.
    s = s.replace(/\n{2,}/g, '<div class="scout-md-gap"></div>');
    s = s.replace(/\n/g, '<br>');

    // 11. Cleanup: redundant <br> right after a block-level construct (list
    //     item div, heading) where the trailing \n was already represented
    //     by the block element.
    s = s.replace(/<\/div><br>/g, '</div>');
    s = s.replace(/<\/h([2-4])><br>/g, '</h$1>');

    return s;
  }
  // Map raw tool name + args -> { displayName, argSnippet }
  function humanizeTool(tool, args) {
    args = args || {};
    const trim = (s, n) => { s = (s == null ? '' : String(s)); return s.length > n ? s.slice(0, n - 1) + '\u2026' : s; };
    const hostPath = (u) => { try { const x = new URL(u); return x.hostname + (x.pathname && x.pathname !== '/' ? x.pathname : ''); } catch(_){ return u; } };
    switch (tool) {
      case 'search_pulse':
      case 'search_waypoint':   return { name: 'Waypoint search',    arg: args.query ? '\u201C' + trim(args.query, 80) + '\u201D' : '' };
      case 'search_sam_gov':     return { name: 'SAM.gov search',     arg: trim(args.office_name || args.keywords || '', 100) };
      case 'search_usaspending': return { name: 'USAspending search', arg: trim(args.awarding_office || args.awarding_agency || args.recipient || '', 100) };
      case 'fetch_url':          return { name: 'Fetched page',       arg: args.url ? trim(hostPath(args.url), 100) : '', argHref: args.url || null };
      case 'dvids_search':       return { name: 'DVIDS search',       arg: args.query ? '\u201C' + trim(args.query, 80) + '\u201D' : '' };
      case 'web_search':         return { name: 'Web search',         arg: args.query ? '\u201C' + trim(args.query, 80) + '\u201D' : '' };
      case 'propose_office':     return { name: 'Office proposal',    arg: trim(args.proposed_name || '', 80) };
      case 'propose_finding':    return { name: 'Recorded contact',   arg: trim(args.full_name || '', 60) };
      default:                   return { name: tool || 'tool',       arg: '' };
    }
  }

  function statusFromCard(tc) {
    if (tc._running) return 'running';
    if (tc.error) return 'error';
    const sum = (tc.result_summary || '').toLowerCase();
    if (sum.indexOf('skipped') !== -1 || sum.indexOf('not configured') !== -1) return 'skipped';
    if (sum.indexOf('error') !== -1 || sum.indexOf('failed') !== -1 || sum.indexOf('not found') !== -1) return 'error';
    return 'done';
  }

  function appendToolCard(box, tc) {
    const d = document.createElement('div');
    const status = statusFromCard(tc);
    d.className = 'scout-tool-card tc-' + status;
    if (tc._toolUseId) d.setAttribute('data-tool-use-id', tc._toolUseId);
    const h = humanizeTool(tc.tool_name, tc.arguments);
    const time = tc.latency_ms ? (tc.latency_ms + 'ms') : (status === 'running' ? '' : '');
    const errDetail = (tc.result && tc.result.error) ? String(tc.result.error).slice(0, 240) : (tc.error ? String(tc.error).slice(0, 240) : '');
    const summaryText = tc._running
      ? ''
      : ((tc.result_summary || (errDetail ? 'error' : '')) + (errDetail ? ('\n' + errDetail) : ''));
    d.innerHTML =
      '<div class="scout-tc-head">' +
        '<span class="scout-tc-name">' + escapeHtml(h.name) + '</span>' +
        '<span class="scout-tc-time">' + escapeHtml(time) + '</span>' +
      '</div>' +
      (h.arg
        ? '<div class="scout-tc-arg">' + (
            h.argHref
              ? '<a href="' + escapeHtml(h.argHref) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(h.arg) + '</a>'
              : escapeHtml(h.arg)
          ) + '</div>'
        : '') +
      (summaryText ? '<div class="scout-tc-result" style="white-space:pre-wrap">' + escapeHtml(summaryText) + '</div>' : '');
    box.appendChild(d);
    return d;
  }

  function updateToolCard(toolUseId, tc) {
    const card = document.querySelector('.scout-tool-card[data-tool-use-id="' + toolUseId + '"]');
    if (!card) return false;
    const status = statusFromCard(tc);
    card.classList.remove('tc-running', 'tc-done', 'tc-error', 'tc-skipped');
    card.classList.add('tc-' + status);
    const timeEl = card.querySelector('.scout-tc-time');
    if (timeEl) timeEl.textContent = tc.latency_ms ? (tc.latency_ms + 'ms') : '';
    const errDetail = (tc.result && tc.result.error) ? String(tc.result.error).slice(0, 240) : (tc.error ? String(tc.error).slice(0, 240) : '');
    const sumText = (tc.result_summary || (errDetail ? 'error' : '')) + (errDetail ? ('\n' + errDetail) : '');
    let resEl = card.querySelector('.scout-tc-result');
    if (!resEl && sumText) {
      resEl = document.createElement('div');
      resEl.className = 'scout-tc-result';
      resEl.style.whiteSpace = 'pre-wrap';
      card.appendChild(resEl);
    }
    if (resEl) { resEl.textContent = sumText; resEl.style.whiteSpace = 'pre-wrap'; }
    return true;
  }

  // ---------- Findings panel ----------
  function renderFindings() {
    const list = el('scoutFindingsList');
    if (!state.findings.length) {
      list.innerHTML = '<div class="scout-empty">Findings will appear here as Scout works.</div>';
      el('scoutCommitBtn').disabled = true;
      return;
    }
    list.innerHTML = state.findings.map(renderFindingCard).join('');
    list.querySelectorAll('[data-finding-id]').forEach(card => {
      const id = card.dataset.findingId;
      const cb = card.querySelector('input[type="checkbox"]');
      if (cb) cb.onchange = updateCommitButton;
      const dismiss = card.querySelector('[data-act="dismiss"]');
      if (dismiss) dismiss.onclick = (e) => { e.stopPropagation(); dismissFinding(id); };
      const edit = card.querySelector('[data-act="edit"]');
      if (edit) edit.onclick = (e) => {
        e.stopPropagation();
        const f = state.findings.find(x => x.id === id);
        if (f) openFindingEditor(f);
      };
      const mapBtn = card.querySelector('[data-act="map"]');
      if (mapBtn) mapBtn.onclick = (e) => {
        e.stopPropagation();
        const f = state.findings.find(x => x.id === id);
        if (f) openOfficeMapPicker(f);
      };
      var view = card.querySelector('[data-act="view"]');
      var targetContactId = card.dataset.targetContact || null;
      var targetOfficeId  = card.dataset.targetOffice  || null;
      var targetSolId     = card.dataset.targetSol     || null;
      var goToTarget = function() {
        if (targetContactId) {
          if (typeof activateTab === 'function') activateTab('contacts');
          setTimeout(function(){ if (typeof openContactDetailPanel === 'function') openContactDetailPanel(targetContactId); }, 80);
        } else if (targetOfficeId) {
          if (typeof activateTab === 'function') activateTab('offices');
        } else if (targetSolId) {
          if (typeof activateTab === 'function') activateTab('solicitations');
        }
      };
      if (view) view.onclick = function(e){ e.stopPropagation(); goToTarget(); };
      if (card.classList.contains('clickable')) {
        card.onclick = function(e) {
          if (e.target.closest('button, a, input')) return;
          goToTarget();
        };
      }
    });
    updateCommitButton();
  }

  function renderFindingCard(f) {
    var CONF_LABELS = { verified: 'Confirmed', public_bio: 'Public bio', pattern_guessed: 'Pattern guessed' };
    var conf = function(c) { return c ? '<span class="scout-confidence ' + c + '">' + (CONF_LABELS[c] || c) + '</span>' : ''; };
    var sources = (f.sources || []).map(function(s) {
      var u = (s && s.url) ? s.url : '';
      var t = (s && (s.type || s.title)) ? (s.type || s.title) : (u ? URL_safe(u) : 'source');
      return u ? '<a href="' + escapeAttr(u) + '" target="_blank" rel="noopener">' + escapeHtml(t) + '</a>' : escapeHtml(t);
    }).join(' \u00b7 ');
    var kind = f.kind || 'contact';
    if (kind === 'office')       return _renderOfficeFinding(f, sources);
    if (kind === 'solicitation') return _renderSolFinding(f, sources);
    return _renderContactFinding(f, sources, conf);
  }

  function _kindTag(k) { return '<div class="scout-finding-kind ' + k + '">' + k + '</div>'; }

  function _renderContactFinding(f, sources, conf) {
    var isMatched   = !!f.matched_contact_id && f.status !== 'dismissed';
    var isAddedNew  = f.status === 'added' && f.added_contact_id && !f.matched_contact_id;
    var targetId    = f.matched_contact_id || f.added_contact_id || null;
    var clickable   = (isMatched || isAddedNew) && targetId;
    var md          = f.matched_contact_data || null;
    var display = (isMatched && md) ? {
      name:  md.full_name || f.full_name || '', title: md.title || f.rank_or_title || '',
      email: md.email || null, phone: md.phone || null, rank: md.rank || null
    } : { name: f.full_name || '', title: f.rank_or_title || '', email: f.email || null, phone: f.phone || null, rank: null };
    var cls = (f.status === 'added' ? ' added' : '') + (f.status === 'dismissed' ? ' dismissed' : '') + (isMatched ? ' matched' : '') + (clickable ? ' clickable' : '');
    var officeDisplay = f.office_id || (f.proposed_office_name ? ('proposed: ' + f.proposed_office_name) : '');
    var actions;
    if (isMatched) actions = '<div class="scout-finding-actions"><button data-act="view">Open in Waypoint</button><button data-act="dismiss">Dismiss</button></div>';
    else if (f.status === 'draft') actions = '<div class="scout-finding-actions"><button data-act="edit">Edit</button><button data-act="dismiss">Dismiss</button></div>';
    else if (isAddedNew) actions = '<div class="scout-finding-actions"><button data-act="view">Open in Waypoint</button></div>';
    else actions = '<div class="scout-finding-actions"><span style="font-size:10.5px;color:var(--text-muted)">' + escapeHtml(f.status) + '</span></div>';
    var showCheckbox = (f.status === 'draft' && !isMatched);
    var checked = showCheckbox ? 'checked' : '';
    var nameTxt = ((display.rank ? (display.rank + ' ') : '') + display.name).trim();
    var s1 = '<div class="scout-finding-card' + cls + '" data-finding-id="' + f.id + '" data-kind="contact"' + (clickable ? ' data-target-contact="' + escapeAttr(targetId) + '"' : '') + '>';
    var head = _kindTag('contact') + '<div class="scout-finding-head">' + (showCheckbox ? '<input type="checkbox" ' + checked + '>' : '') + '<div style="flex:1"><div class="scout-finding-name">' + escapeHtml(nameTxt) + '</div>' + (display.title ? '<div class="scout-finding-title">' + escapeHtml(display.title) + '</div>' : '') + (officeDisplay ? '<div class="scout-finding-office">' + escapeHtml(officeDisplay) + '</div>' : '') + '</div></div>';
    var emailHtml = display.email ? (escapeHtml(display.email) + (isMatched ? conf('verified') : conf(f.email_confidence || 'verified'))) : '<span class="scout-finding-none">None found</span>';
    // suggested_legislator_bioguide_id to the finding.
    var legHtml = '';
    if (f.suggested_legislator_bioguide_id) {
      var legChip = (typeof legislatorChipHtml === 'function') ? legislatorChipHtml(f.suggested_legislator_bioguide_id) : '';
      legHtml = '<div class="scout-finding-fields scout-finding-legislator"><div><span class="label">recommended Hill principal</span>'
        + (legChip || escapeHtml(f.suggested_legislator_bioguide_id))
        + ' <span class="scout-confidence pattern_guessed" title="Pre-linked from this Scout job\'s detected Member. Edit the finding to override.">auto-linked</span>'
        + '</div></div>';
    }
    var fields = '<div class="scout-finding-fields"><div><span class="label">email</span>' + emailHtml + '</div>' + (display.phone ? '<div><span class="label">phone</span>' + escapeHtml(display.phone) + (isMatched ? '' : conf(f.phone_confidence)) + '</div>' : '') + (!isMatched && f.linkedin_url ? '<div><span class="label">linkedin</span><a href="' + escapeAttr(f.linkedin_url) + '" target="_blank" rel="noopener">profile</a></div>' : '') + (!isMatched && f.notes ? '<div><span class="label">notes</span>' + escapeHtml(f.notes) + '</div>' : '') + '</div>';
    var srcLine = (!isMatched && sources) ? ('<div class="scout-finding-sources">sources: ' + sources + '</div>') : '';
    return s1 + head + fields + legHtml + srcLine + actions + '</div>';
  }

  function _renderOfficeFinding(f, sources) {
    var d = f.data || {};
    var isAdded = f.status === 'added' && f.added_contact_id;
    var wasRemapped = isAdded && d.remapped_to;
    var clickable = isAdded && f.added_contact_id;
    var cls = (f.status === 'added' ? ' added' : '') + (f.status === 'dismissed' ? ' dismissed' : '') + (clickable ? ' clickable' : '');
    var showCheckbox = f.status === 'draft';
    var checked = showCheckbox ? 'checked' : '';
    var actions;
    if (f.status === 'draft') {
      actions = '<div class="scout-finding-actions">'
        + '<button data-act="map">Map to existing</button>'
        + '<button data-act="edit">Edit</button>'
        + '<button data-act="dismiss">Dismiss</button>'
        + '</div>';
    } else if (wasRemapped) {
      actions = '<div class="scout-finding-actions"><span style="font-size:10.5px;color:var(--text-muted)">mapped to existing</span></div>';
    } else {
      actions = '<div class="scout-finding-actions"><span style="font-size:10.5px;color:var(--text-muted)">' + escapeHtml(f.status) + '</span></div>';
    }
    var fp = [];
    if (d.full_name)  fp.push('<div><span class="label">full</span>' + escapeHtml(d.full_name) + '</div>');
    if (d.service)    fp.push('<div><span class="label">service</span>' + escapeHtml(d.service) + '</div>');
    if (d.department) fp.push('<div><span class="label">dept</span>' + escapeHtml(d.department) + '</div>');
    if (d.location)   fp.push('<div><span class="label">location</span>' + escapeHtml(d.location) + '</div>');
    if (f.notes)      fp.push('<div><span class="label">notes</span>' + escapeHtml(f.notes) + '</div>');
    if (wasRemapped) {
      fp.push('<div style="margin-top:6px;color:var(--accent);font-size:11px;"><span class="label">mapped</span>' + escapeHtml((d.remapped_to && d.remapped_to.name) || f.added_contact_id) + '</div>');
    }
    var head = _kindTag('office') + '<div class="scout-finding-head">' + (showCheckbox ? '<input type="checkbox" ' + checked + '>' : '') + '<div style="flex:1"><div class="scout-finding-name">' + escapeHtml(d.name || '(unnamed office)') + '</div></div></div>';
    var fields = fp.length ? ('<div class="scout-finding-fields">' + fp.join('') + '</div>') : '';
    var s1 = '<div class="scout-finding-card' + cls + '" data-finding-id="' + f.id + '" data-kind="office"' + (clickable ? ' data-target-office="' + escapeAttr(f.added_contact_id) + '"' : '') + '>';
    var srcLine = sources ? ('<div class="scout-finding-sources">sources: ' + sources + '</div>') : '';
    return s1 + head + fields + srcLine + actions + '</div>';
  }

  function _renderSolFinding(f, sources) {
    var d = f.data || {};
    var isAdded = f.status === 'added' && f.added_contact_id;
    var clickable = isAdded && f.added_contact_id;
    var cls = (f.status === 'added' ? ' added' : '') + (f.status === 'dismissed' ? ' dismissed' : '') + (clickable ? ' clickable' : '');
    var showCheckbox = f.status === 'draft';
    var checked = showCheckbox ? 'checked' : '';
    var actions = (f.status === 'draft') ? '<div class="scout-finding-actions"><button data-act="edit">Edit</button><button data-act="dismiss">Dismiss</button></div>' : ('<div class="scout-finding-actions"><span style="font-size:10.5px;color:var(--text-muted)">' + escapeHtml(f.status) + '</span></div>');
    var fp = [];
    if (d.office_id || d.office_name) fp.push('<div><span class="label">office</span>' + escapeHtml(d.office_name || d.office_id) + '</div>');
    if (d.value)    fp.push('<div><span class="label">value</span>$' + escapeHtml(String(d.value)) + '</div>');
    if (d.status)   fp.push('<div><span class="label">status</span>' + escapeHtml(d.status) + '</div>');
    if (d.due_date) fp.push('<div><span class="label">due</span>' + escapeHtml(d.due_date) + '</div>');
    if (d.type)     fp.push('<div><span class="label">type</span>' + escapeHtml(d.type) + '</div>');
    if (d.topic)    fp.push('<div><span class="label">topic</span>' + escapeHtml(d.topic) + '</div>');
    if (f.notes)    fp.push('<div><span class="label">notes</span>' + escapeHtml(f.notes) + '</div>');
    var titleHtml = d.link ? ('<a href="' + escapeAttr(d.link) + '" target="_blank" rel="noopener">' + escapeHtml(d.title || '(untitled)') + '</a>') : escapeHtml(d.title || '(untitled)');
    var head = _kindTag('solicitation') + '<div class="scout-finding-head">' + (showCheckbox ? '<input type="checkbox" ' + checked + '>' : '') + '<div style="flex:1"><div class="scout-finding-name">' + titleHtml + '</div></div></div>';
    var fields = fp.length ? ('<div class="scout-finding-fields">' + fp.join('') + '</div>') : '';
    var s1 = '<div class="scout-finding-card' + cls + '" data-finding-id="' + f.id + '" data-kind="solicitation"' + (clickable ? ' data-target-sol="' + escapeAttr(f.added_contact_id) + '"' : '') + '>';
    var srcLine = sources ? ('<div class="scout-finding-sources">sources: ' + sources + '</div>') : '';
    return s1 + head + fields + srcLine + actions + '</div>';
  }


  function updateCommitButton() {
    const draftCount = state.findings.filter(f => f.status === 'draft').length;
    const checkedCount = el('scoutFindingsList').querySelectorAll('input[type="checkbox"]:checked').length;
    el('scoutCommitBtn').disabled = !checkedCount;
    el('scoutCommitBtn').textContent = checkedCount
      ? ('Add ' + checkedCount + ' to Waypoint' + (draftCount > checkedCount ? ' (' + (draftCount - checkedCount) + ' unchecked)' : ''))
      : 'Add selected to Waypoint';
  }

  // URL_safe — silent fallback if URL constructor throws
  function URL_safe(u){ try { return new URL(u).hostname; } catch(_e){ return u; } }

  // ---------- Send (v92 background-job polling) ----------
  // The kickoff POST creates a scout_jobs row + fires the background
  // worker, then returns { job_id, search_id, search }. The client polls
  // /scout-status for new events until status === 'completed' | 'failed'.
  // Single round-trip per poll, no per-turn HTTP, no 22s ceiling — the
  // worker has 15 minutes of runtime budget.
  async function send(text) {
    if (!text || state.sending) return;
    state.sending = true;

    const box = el('scoutMessages');
    if (box.querySelector('.scout-welcome')) box.innerHTML = '';
    appendUserMsg(box, text);

    // Animated thinking indicator until the first event arrives.
    const showThinking = () => {
      if (box.querySelector('.scout-thinking')) return;
      const t = document.createElement('div');
      t.className = 'scout-thinking';
      t.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
      box.appendChild(t);
      box.scrollTop = box.scrollHeight;
    };
    const hideThinking = () => {
      const t = box.querySelector('.scout-thinking');
      if (t) t.remove();
    };
    showThinking();
    el('scoutInput').value = '';

    const me = window.CURRENT_USER_EMAIL || (window._whoAmI && _whoAmI()) || (typeof CURRENT_USER_EMAIL !== 'undefined' && CURRENT_USER_EMAIL) || null;
    const payload = { message: text };
    if (state.activeSearchId) payload.search_id = state.activeSearchId;
    if (me) payload.created_by = me;

    let totalToolCalls = 0;
    let totalTurns = 0;
    setStatus('Scout is thinking\u2026');

    try {
      // 1. Kickoff
      const _kickAuth = await scoutFnAuth();
      const kickRes = await fetch(FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ..._kickAuth },
        body: JSON.stringify(payload),
      });
      const kick = await kickRes.json();
      if (!kickRes.ok) throw new Error(kick.error || ('HTTP ' + kickRes.status));

      if (kick.search_id && kick.search_id !== state.activeSearchId) {
        state.activeSearchId = kick.search_id;
      }
      if (kick.search && kick.search.title) {
        el('scoutThreadTitle').textContent = kick.search.title;
      }
      const jobId = kick.job_id;
      if (!jobId) throw new Error('Kickoff did not return job_id');
      state.activeJobId = jobId;

      // 2. Poll loop
      const POLL_MS = 1500;
      const MAX_QUIET_POLLS = 240;  // ~6 min of total silence -> bail
      let cursor = 0;
      let quietPolls = 0;

      while (true) {
        await new Promise(r => setTimeout(r, POLL_MS));

        // If the user navigated away to another search, stop polling.
        if (state.activeJobId !== jobId) break;

        let s;
        try {
          const _pollAuth = await scoutFnAuth();
          const sRes = await fetch(STATUS_FN + '?job_id=' + encodeURIComponent(jobId) + '&since=' + cursor, { method: 'GET', cache: 'no-store', headers: _pollAuth });
          s = await sRes.json();
          if (!sRes.ok) throw new Error(s.error || ('HTTP ' + sRes.status));
        } catch (e) {
          // Transient poll error -- retry once after 2s, then bail loudly.
          await new Promise(r => setTimeout(r, 2000));
          if (state.activeJobId !== jobId) break;
          const _pollAuth2 = await scoutFnAuth();
          const sRes2 = await fetch(STATUS_FN + '?job_id=' + encodeURIComponent(jobId) + '&since=' + cursor, { method: 'GET', cache: 'no-store', headers: _pollAuth2 });
          s = await sRes2.json();
          if (!sRes2.ok) throw new Error(s.error || ('HTTP ' + sRes2.status));
        }

        const newEvents = s.events || [];
        cursor = (typeof s.next_since === 'number') ? s.next_since : (cursor + newEvents.length);

        if (newEvents.length === 0) {
          quietPolls++;
          if (s.status === 'completed' || s.status === 'failed') break;
          if (quietPolls > MAX_QUIET_POLLS) {
            appendAssistantMsg(box, '(Scout went quiet \u2014 try refreshing this search.)');
            break;
          }
          continue;
        }
        quietPolls = 0;

        for (const ev of newEvents) {
          if (ev.type === 'text') {
            hideThinking();
            appendAssistantMsg(box, ev.text);
          } else if (ev.type === 'tool_use') {
            hideThinking();
            appendToolCard(box, { tool_name: ev.name, arguments: ev.input, _running: true, _toolUseId: ev.tool_use_id });
            totalToolCalls++;
          } else if (ev.type === 'tool_result') {
            const tcLive = { tool_name: ev.name, result_summary: ev.summary, latency_ms: ev.latency_ms, error: ev.error, result: ev.result };
            const ok = updateToolCard(ev.tool_use_id, tcLive);
            if (!ok) appendToolCard(box, tcLive);
          } else if (ev.type === 'finding') {
            // De-dupe in case the same event was already streamed.
            if (ev.finding && !state.findings.some(x => x.id === ev.finding.id)) {
              state.findings = state.findings.concat([ev.finding]);
              renderFindings();
            }
          } else if (ev.type === 'turn_done') {
            totalTurns++;
            // Show "still thinking" between turns.
            if (s.status === 'running') showThinking();
          } else if (ev.type === 'error') {
            hideThinking();
            appendAssistantMsg(box, '\u26a0 Scout error: ' + (ev.message || 'unknown'));
          }
          // assistant_turn / done / server_tool_use / web_search_result / office_proposed:
          //   no-op in UI; the meaningful events are above.
          box.scrollTop = box.scrollHeight;
        }

        const turnsShown = (s.total_turns || totalTurns);
        const callsShown = (s.total_tool_calls || totalToolCalls);
        setStatus('Scout \u00b7 ' + turnsShown + ' turn' + (turnsShown === 1 ? '' : 's') + ' \u00b7 ' + callsShown + ' tool call' + (callsShown === 1 ? '' : 's'));

        if (s.status === 'completed') break;
        if (s.status === 'failed') {
          appendAssistantMsg(box, '\u26a0 Scout job failed: ' + (s.error || 'unknown error'));
          break;
        }
      }

      hideThinking();
      setStatus('Done \u00b7 ' + totalToolCalls + ' tool calls \u00b7 ' + totalTurns + ' turn' + (totalTurns === 1 ? '' : 's'));
      refreshSearches();
    } catch (e) {
      const t = box.querySelector('.scout-thinking'); if (t) t.remove();
      setStatus('Error: ' + (e.message || e), true);
    } finally {
      const t2 = box.querySelector('.scout-thinking'); if (t2) t2.remove();
      state.activeJobId = null;
      state.sending = false;
    }
  }

  // ---------- Commit selected to Waypoint ----------
  async function commitSelected() {
    var ids = Array.from(el('scoutFindingsList').querySelectorAll('input[type="checkbox"]:checked'))
      .map(function(cb){ return cb.closest('[data-finding-id]').dataset.findingId; });
    if (!ids.length) return;
    if (!confirm('Add ' + ids.length + ' selected to Waypoint? Findings already in Waypoint will be skipped.')) return;
    setStatus('Adding to Waypoint\u2026');
    var added = 0, skipped = 0, errors = 0;
    // proposed_office_name matches a newly-created office pick up the
    // resolved office_id in the same batch.
    var KIND_ORDER = { office: 0, solicitation: 1, contact: 2 };
    ids.sort(function (a, b) {
      var fa = state.findings.find(function (x) { return x.id === a; });
      var fb = state.findings.find(function (x) { return x.id === b; });
      var ka = (fa && fa.kind) || 'contact';
      var kb = (fb && fb.kind) || 'contact';
      return (KIND_ORDER[ka] || 9) - (KIND_ORDER[kb] || 9);
    });
    for (var idx = 0; idx < ids.length; idx++) {
      var fid = ids[idx];
      var f = state.findings.find(function(x){ return x.id === fid; });
      if (!f) continue;
      var kind = f.kind || 'contact';
      try {
        if (kind === 'contact') {
          var out = await _commitContact(f);
          if (out === 'skipped') skipped++; else if (out === 'added') added++;
        } else if (kind === 'office')       { await _commitOffice(f); added++; }
        else if (kind === 'solicitation')   { await _commitSol(f);    added++; }
      } catch (e) { errors++; console.warn('Scout commit failed for', fid, e); }
    }
    renderFindings();
    setStatus('Added ' + added + ' \u00b7 skipped ' + skipped + (errors ? (' \u00b7 ' + errors + ' errors') : ''));
  }

  async function _commitContact(f) {
    if (f.matched_contact_id) {
      await rest('PATCH', 'scout_findings?id=eq.' + f.id, { status: 'added', added_contact_id: f.matched_contact_id });
      f.status = 'added'; return 'skipped';
    }
    var newId = 'scout_' + (f.full_name || 'c').toLowerCase().replace(/[^a-z0-9]+/g,'_').slice(0,32) + '_' + Math.random().toString(36).slice(2,8);
    var nm = (f.full_name || '').trim().split(/\s+/);
    var firstName = nm.length > 1 ? nm.slice(0, -1).join(' ') : (nm[0] || '');
    var lastName  = nm.length > 1 ? nm[nm.length - 1] : '';
    var rank = null, title = f.rank_or_title || null;
    if (title) {
      var rankM = title.match(/^(Mr\.|Mrs\.|Ms\.|Dr\.|Lt\.|Lt\. Cmdr\.|Cmdr\.|Capt\.|Cdr|Cdr\.|LCDR|CDR|CAPT|Col\.|COL|Maj\.|MAJ|Sgt\.|SGT|RDML|VADM|RADM|ADM|GEN|BG|MG|LTG)\s+(.*)$/i);
      if (rankM) { rank = rankM[1]; title = rankM[2]; }
    }
    var notesParts = [];
    if (f.notes) notesParts.push(f.notes);
    // of being stuffed into notes. v164 DDL Supabase/v164-contacts-linkedin.sql
    // adds the column + backfills prior notes-stuffed values.
    notesParts.push('Added via Scout. Sources: ' + JSON.stringify(f.sources || []));
    // carries suggested_legislator_bioguide_id; propagate it onto the new
    // contact so it's pre-linked to that senator/representative.
    var legBg = (typeof f.suggested_legislator_bioguide_id === 'string' && f.suggested_legislator_bioguide_id.trim())
      ? f.suggested_legislator_bioguide_id.trim() : null;
    var contact = { id: newId, firstName: firstName, lastName: lastName, rank: rank, title: title, email: f.email || null, phone: f.phone || null, linkedinUrl: f.linkedin_url || null, officeIds: f.office_id ? [f.office_id] : [], legislator_bioguide_id: legBg, notes: notesParts.join('\n\n') };
    await rest('POST', 'contacts', contact);
    await rest('PATCH', 'scout_findings?id=eq.' + f.id, { status: 'added', added_contact_id: newId });
    f.status = 'added'; f.added_contact_id = newId;
    try { if (typeof DB !== 'undefined' && DB && DB.state && Array.isArray(DB.state.contacts)) { DB.state.contacts.push(contact); if (typeof updateAllCounts === 'function') updateAllCounts(); if (typeof renderContacts === 'function' && document.querySelector('#tab-contacts.active')) renderContacts(); } } catch (_) {}
    return 'added';
  }

  // an EXISTING office in Waypoint instead of creating a new one.
  function openOfficeMapPicker(f) {
    if (!f || f.status !== 'draft' || f.kind !== 'office') return;
    var offices = (typeof DB !== 'undefined' && DB.list) ? DB.list('offices').slice() : [];
    if (!offices.length) {
      alert('No offices in Waypoint yet to map to. Approve this as a new office instead.');
      return;
    }
    offices.sort(function (a, b) { return String(a.name || a.id).localeCompare(String(b.name || b.id)); });
    var d = f.data || {};
    var proposed = d.name || '(unnamed)';
    var body = document.createElement('div');
    body.innerHTML =
      '<div style="margin-bottom:8px;color:var(--text-muted);font-size:12.5px;">'
        + 'Scout proposed: <strong>' + escapeHtml(proposed) + '</strong>' + (d.full_name ? ' (' + escapeHtml(d.full_name) + ')' : '') + '<br>'
        + 'Pick the existing Waypoint office it should map to. Any draft contact findings at &ldquo;' + escapeHtml(proposed) + '&rdquo; will be relinked automatically.'
      + '</div>'
      + '<input id="omap-q" placeholder="Search offices..." style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:13px;margin-bottom:8px;" />'
      + '<div id="omap-list" style="max-height:320px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;background:var(--surface);"></div>'
      + '<div id="omap-empty" style="display:none;padding:18px;text-align:center;color:var(--text-dim);font-size:12px;">No matches.</div>';
    function renderList(query) {
      var q = (query || '').toLowerCase().trim();
      var listEl = body.querySelector('#omap-list');
      var emptyEl = body.querySelector('#omap-empty');
      var rows = offices.filter(function (o) {
        if (!q) return true;
        var hay = ((o.name || '') + ' ' + (o.fullName || '') + ' ' + (o.service || '') + ' ' + (o.department || '')).toLowerCase();
        return hay.indexOf(q) >= 0;
      }).slice(0, 80);
      if (!rows.length) { listEl.style.display = 'none'; emptyEl.style.display = 'block'; return; }
      listEl.style.display = 'block';
      emptyEl.style.display = 'none';
      listEl.innerHTML = rows.map(function (o) {
        var subBits = [];
        if (o.fullName)   subBits.push(escapeHtml(o.fullName));
        if (o.service)    subBits.push(escapeHtml(o.service));
        if (o.department) subBits.push(escapeHtml(String(o.department).toUpperCase()));
        var sub = subBits.length ? '<div style="font-size:10.5px;color:var(--text-dim);margin-top:2px;">' + subBits.join(' &middot; ') + '</div>' : '';
        return '<div class="omap-row" data-office-id="' + escapeAttr(o.id) + '" style="padding:8px 10px;border-bottom:1px solid var(--border);cursor:pointer;font-size:12.5px;">'
          + '<div><strong>' + escapeHtml(o.name || o.id) + '</strong></div>'
          + sub
          + '</div>';
      }).join('');
      listEl.querySelectorAll('.omap-row').forEach(function (row) {
        row.addEventListener('mouseenter', function () { row.style.background = 'var(--surface-alt)'; });
        row.addEventListener('mouseleave', function () { row.style.background = ''; });
        row.addEventListener('click', function () {
          var oid = row.dataset.officeId;
          var picked = offices.find(function (o) { return o.id === oid; });
          if (!picked) return;
          _remapOfficeFinding(f, picked).catch(function (err) {
            alert('Remap failed: ' + (err && err.message ? err.message : err));
          });
          closeModal();
        });
      });
    }
    renderList('');
    setTimeout(function () {
      var q = body.querySelector('#omap-q');
      if (q) { q.focus(); q.addEventListener('input', function () { renderList(q.value); }); }
    }, 30);
    openModal({ title: 'Map "' + (proposed) + '" to existing office', body: body, hideSave: true });
  }

  // Does NOT insert a new office. Auto-links sibling draft contact findings
  // by proposed_office_name match.
  async function _remapOfficeFinding(f, existingOffice) {
    if (!f || !existingOffice || !existingOffice.id) return;
    var d = Object.assign({}, f.data || {}, {
      remapped_to: { id: existingOffice.id, name: existingOffice.name || existingOffice.id },
    });
    await rest('PATCH', 'scout_findings?id=eq.' + encodeURIComponent(f.id), {
      status: 'added',
      added_contact_id: existingOffice.id,
      data: d,
    });
    f.status = 'added';
    f.added_contact_id = existingOffice.id;
    f.data = d;
    var proposedName = (f.data && f.data.name) || '';
    if (proposedName) {
      var siblings = state.findings.filter(function (x) {
        return x.kind === 'contact'
          && x.status === 'draft'
          && !x.office_id
          && (x.proposed_office_name || '').toLowerCase() === proposedName.toLowerCase();
      });
      for (var i = 0; i < siblings.length; i++) {
        var sib = siblings[i];
        try {
          await rest('PATCH', 'scout_findings?id=eq.' + encodeURIComponent(sib.id), {
            office_id: existingOffice.id,
            proposed_office_name: null,
          });
          sib.office_id = existingOffice.id;
          sib.proposed_office_name = null;
        } catch (e) { console.warn('auto-link failed for finding', sib.id, e); }
      }
      if (siblings.length) setStatus('Mapped \u201C' + proposedName + '\u201D \u2192 ' + (existingOffice.name || existingOffice.id) + '. Auto-linked ' + siblings.length + ' contact' + (siblings.length === 1 ? '' : 's') + '.');
      else setStatus('Mapped \u201C' + proposedName + '\u201D \u2192 ' + (existingOffice.name || existingOffice.id) + '.');
    }
    renderFindings();
  }

  async function _commitOffice(f) {
    var d = f.data || {};
    // the picker, treat it as a no-op (it's already marked added).
    if (d.remapped_to && f.status === 'added') return;
    var slug = (d.name || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g,'_').slice(0,32);
    var newId = 'scout_' + slug + '_' + Math.random().toString(36).slice(2,8);
    var office = { id: newId, name: d.name || '(unnamed)', fullName: d.full_name || null, service: d.service || null, department: d.department || null, location: d.location || null, notes: (f.notes ? (f.notes + '\n\n') : '') + 'Added via Scout. Sources: ' + JSON.stringify(f.sources || []), needs_mapping: true, created_via: 'scout' };
    await rest('POST', 'offices', office);
    await rest('PATCH', 'scout_findings?id=eq.' + f.id, { status: 'added', added_contact_id: newId });
    f.status = 'added'; f.added_contact_id = newId;
    try { if (typeof DB !== 'undefined' && DB && DB.state && Array.isArray(DB.state.offices)) { DB.state.offices.push(office); if (typeof updateAllCounts === 'function') updateAllCounts(); if (typeof renderOffices === 'function' && document.querySelector('#tab-offices.active')) renderOffices(); } } catch (_) {}
    // office by proposed_office_name, so the user can commit those contacts
    // directly without a second linking step.
    var proposedName = (d.name || '').trim();
    if (proposedName) {
      var siblings = state.findings.filter(function (x) {
        return x.kind === 'contact'
          && x.status === 'draft'
          && !x.office_id
          && (x.proposed_office_name || '').toLowerCase() === proposedName.toLowerCase();
      });
      for (var i = 0; i < siblings.length; i++) {
        var sib = siblings[i];
        try {
          await rest('PATCH', 'scout_findings?id=eq.' + encodeURIComponent(sib.id), {
            office_id: newId,
            proposed_office_name: null,
          });
          sib.office_id = newId;
          sib.proposed_office_name = null;
        } catch (_) {}
      }
    }
  }

  async function _commitSol(f) {
    var d = f.data || {};
    var slug = (d.title || 'sol').toLowerCase().replace(/[^a-z0-9]+/g,'_').slice(0,32);
    var newId = 'scout_' + slug + '_' + Math.random().toString(36).slice(2,8);
    var sol = { id: newId, title: d.title || '(untitled)', link: d.link || null, officeId: d.office_id || null, value: typeof d.value === 'number' ? d.value : (Number(d.value) || 0), openDate: d.open_date || null, dueDate: d.due_date || null, awardDate: d.award_date || null, type: d.type || null, phase: d.phase || null, topic: d.topic || null, tech: d.tech || [], status: d.status || 'tracking', contactIds: [], alignment: 0, notes: (f.notes ? (f.notes + '\n\n') : '') + 'Added via Scout. Sources: ' + JSON.stringify(f.sources || []) };
    await rest('POST', 'solicitations', sol);
    await rest('PATCH', 'scout_findings?id=eq.' + f.id, { status: 'added', added_contact_id: newId });
    f.status = 'added'; f.added_contact_id = newId;
    try { if (typeof DB !== 'undefined' && DB && DB.state && Array.isArray(DB.state.solicitations)) { DB.state.solicitations.push(sol); if (typeof updateAllCounts === 'function') updateAllCounts(); if (typeof renderSols === 'function' && document.querySelector('#tab-solicitations.active')) renderSols(); } } catch (_) {}
  }

  // ---------- v92: Inline finding editor ----------
  // Replaces the v91 "coming soon" alert. Lets the user edit ALL key fields
  // of a draft finding (contact / office / solicitation) before commit.
  // Saves PATCH the row in scout_findings, refresh state.findings, re-render.
  function openFindingEditor(f) {
    if (!f) return;
    if (f.status !== 'draft') {
      // Findings that are already added/dismissed shouldn't be editable.
      return;
    }
    const kind = f.kind || 'contact';

    // Build a flat list of [{ key, label, type, value, kindPath }] where:
    //   kindPath ∈ {'top', 'data', 'sources'}  — where to write the value back
    //   type     ∈ {'text','textarea','select','number','date'}
    let fields;
    if (kind === 'contact') {
      var _legOpts = [''];
      var _legLabels = { '': '(none)' };
      try {
        var _allMembers = (typeof DB !== 'undefined' && DB.list)
          ? DB.list('hill_members').slice() : [];
        _allMembers.sort(function (a, b) {
          var ar = a.chamber === 'senate' ? 0 : 1;
          var br = b.chamber === 'senate' ? 0 : 1;
          if (ar !== br) return ar - br;
          return (a.last_name || a.full_name || '').localeCompare(b.last_name || b.full_name || '');
        });
        _allMembers.forEach(function (m) {
          if (!m || !m.bioguide_id) return;
          _legOpts.push(m.bioguide_id);
          var pa = (m.party || '').slice(0, 1).toUpperCase() || '?';
          var sd = (m.state || '') + (m.district != null && m.district !== '' ? '-' + m.district : '');
          var hon = m.chamber === 'senate' ? 'Sen.' : 'Rep.';
          _legLabels[m.bioguide_id] = hon + ' ' + (m.full_name || m.last_name || m.bioguide_id)
            + ' (' + pa + '-' + sd + ') — ' + m.bioguide_id;
        });
      } catch (_) {}
      fields = [
        { key:'full_name',           label:'Full name',          type:'text',     path:'top', value: f.full_name || '' },
        { key:'rank_or_title',       label:'Rank / title',       type:'text',     path:'top', value: f.rank_or_title || '' },
        { key:'office_id',           label:'Office id (Waypoint)',  type:'text',     path:'top', value: f.office_id || '' },
        { key:'proposed_office_name',label:'Proposed office',    type:'text',     path:'top', value: f.proposed_office_name || '' },
        { key:'email',               label:'Email',              type:'text',     path:'top', value: f.email || '' },
        { key:'email_confidence',    label:'Email confidence',   type:'select',   path:'top', value: f.email_confidence || '', options: ['','verified','public_bio','pattern_guessed'] },
        { key:'phone',               label:'Phone',              type:'text',     path:'top', value: f.phone || '' },
        { key:'phone_confidence',    label:'Phone confidence',   type:'select',   path:'top', value: f.phone_confidence || '', options: ['','verified','public_bio'] },
        { key:'linkedin_url',        label:'LinkedIn URL',       type:'text',     path:'top', value: f.linkedin_url || '' },
        { key:'suggested_legislator_bioguide_id', label:'Hill principal (bioguide_id)', type:'select', path:'top', value: f.suggested_legislator_bioguide_id || '', options: _legOpts, labels: _legLabels },
        { key:'notes',               label:'Notes',              type:'textarea', path:'top', value: f.notes || '' },
      ];
    } else if (kind === 'office') {
      const d = f.data || {};
      fields = [
        { key:'name',       label:'Short name / acronym', type:'text',     path:'data', value: d.name || '' },
        { key:'full_name',  label:'Full name',            type:'text',     path:'data', value: d.full_name || '' },
        { key:'service',    label:'Service / branch',     type:'text',     path:'data', value: d.service || '' },
        { key:'department', label:'Department code',      type:'select',   path:'data', value: d.department || '', options: ['','af','army','navy','marines','socom','osd','joint','congress'] },
        { key:'location',   label:'HQ location',          type:'text',     path:'data', value: d.location || '' },
        { key:'notes',      label:'Notes',                type:'textarea', path:'top',  value: f.notes || '' },
      ];
    } else { // solicitation
      const d = f.data || {};
      fields = [
        { key:'title',       label:'Title',          type:'text',     path:'data', value: d.title || '' },
        { key:'link',        label:'Link / URL',     type:'text',     path:'data', value: d.link || '' },
        { key:'office_id',   label:'Office id',      type:'text',     path:'data', value: d.office_id || '' },
        { key:'office_name', label:'Office name',    type:'text',     path:'data', value: d.office_name || '' },
        { key:'value',       label:'Estimated value (USD)', type:'number', path:'data', value: (d.value == null ? '' : d.value) },
        { key:'status',      label:'Status',         type:'text',     path:'data', value: d.status || '' },
        { key:'open_date',   label:'Open date',      type:'date',     path:'data', value: d.open_date || '' },
        { key:'due_date',    label:'Due date',       type:'date',     path:'data', value: d.due_date || '' },
        { key:'award_date',  label:'Award date',     type:'date',     path:'data', value: d.award_date || '' },
        { key:'type',        label:'Type (RFI/RFP/...)', type:'text', path:'data', value: d.type || '' },
        { key:'phase',       label:'Phase',          type:'text',     path:'data', value: d.phase || '' },
        { key:'topic',       label:'Topic',          type:'text',     path:'data', value: d.topic || '' },
        { key:'notes',       label:'Notes',          type:'textarea', path:'top',  value: f.notes || '' },
      ];
    }

    // Build the modal DOM
    const overlay = document.createElement('div');
    overlay.className = 'scout-edit-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;';
    const modal = document.createElement('div');
    modal.className = 'scout-edit-modal';
    modal.style.cssText = 'background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;width:min(640px,100%);max-height:90vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.5);';
    const header = document.createElement('div');
    header.style.cssText = 'padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;';
    header.innerHTML = '<div style="font-weight:600;font-size:14px;">Edit finding · <span style="color:var(--text-muted);text-transform:capitalize;">' + escapeHtml(kind) + '</span></div><button class="scout-edit-x" style="background:transparent;border:none;color:var(--text-muted);font-size:18px;cursor:pointer;line-height:1;">×</button>';
    const body = document.createElement('div');
    body.style.cssText = 'padding:16px 18px;overflow-y:auto;flex:1;display:grid;grid-template-columns:1fr;gap:10px;';

    function makeField(f) {
      const wrap = document.createElement('label');
      wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--text-muted);';
      const lbl = document.createElement('span');
      lbl.textContent = f.label;
      wrap.appendChild(lbl);
      let input;
      if (f.type === 'textarea') {
        input = document.createElement('textarea');
        input.rows = 3;
        input.value = f.value;
      } else if (f.type === 'select') {
        input = document.createElement('select');
        (f.options || []).forEach(opt => {
          const o = document.createElement('option');
          o.value = opt;
          const lbl = (f.labels && Object.prototype.hasOwnProperty.call(f.labels, opt))
            ? f.labels[opt] : (opt || '(none)');
          o.textContent = lbl;
          if (opt === f.value) o.selected = true;
          input.appendChild(o);
        });
      } else {
        input = document.createElement('input');
        input.type = (f.type === 'number') ? 'number' : (f.type === 'date' ? 'date' : 'text');
        input.value = (f.value == null ? '' : String(f.value));
      }
      input.dataset.key = f.key;
      input.dataset.path = f.path;
      input.style.cssText = 'background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:6px 8px;font-size:13px;font-family:inherit;';
      wrap.appendChild(input);
      return wrap;
    }
    fields.forEach(f => body.appendChild(makeField(f)));

    const footer = document.createElement('div');
    footer.style.cssText = 'padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'background:transparent;border:1px solid var(--border);color:var(--text);padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12.5px;';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.style.cssText = 'background:var(--accent);border:1px solid var(--accent);color:#fff;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12.5px;font-weight:500;';
    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function close() { try { document.body.removeChild(overlay); } catch (_) {} }
    cancelBtn.onclick = close;
    header.querySelector('.scout-edit-x').onclick = close;
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    saveBtn.onclick = async () => {
      // Collect into a patch object that mirrors the row structure.
      const patch = {};
      const dataPatch = {};
      let anyData = false;
      body.querySelectorAll('input, select, textarea').forEach(inp => {
        const k = inp.dataset.key;
        const p = inp.dataset.path;
        let v = inp.value;
        if (inp.type === 'number') v = (v === '' ? null : Number(v));
        if (typeof v === 'string') v = v.trim();
        if (p === 'top') {
          patch[k] = (v === '' ? null : v);
        } else if (p === 'data') {
          dataPatch[k] = (v === '' ? null : v);
          anyData = true;
        }
      });
      // For office/sol findings, merge into existing data object so we
      // don't drop fields that aren't in the editor (sources, tech, etc.).
      if (anyData) {
        patch.data = Object.assign({}, f.data || {}, dataPatch);
      }
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        const updated = await rest('PATCH', 'scout_findings?id=eq.' + f.id, patch);
        const row = (updated && updated[0]) || null;
        if (row) {
          // Replace the cached row with the server's authoritative copy.
          const idx = state.findings.findIndex(x => x.id === f.id);
          if (idx >= 0) state.findings[idx] = row;
        } else {
          // Local merge as fallback (PATCH returned nothing).
          Object.assign(f, patch);
          if (anyData) f.data = patch.data;
        }
        renderFindings();
        close();
        setStatus('Finding updated.');
      } catch (e) {
        saveBtn.disabled = false; saveBtn.textContent = 'Save';
        alert('Could not save: ' + (e.message || e));
      }
    };

    // Focus the first input for fast keyboard editing.
    setTimeout(() => { const first = body.querySelector('input, textarea, select'); if (first) first.focus(); }, 30);
  }

  async function dismissFinding(fid) {
    try {
      await rest('PATCH', 'scout_findings?id=eq.' + fid, { status: 'dismissed', dismissed_at: new Date().toISOString() });
      const f = state.findings.find(x => x.id === fid);
      if (f) f.status = 'dismissed';
      renderFindings();
    } catch (e) { setStatus('Dismiss failed: ' + e.message, true); }
  }

  // ---------- Helpers ----------
  function setStatus(text, isError) {
    const s = el('scoutStatus');
    s.textContent = text || '';
    s.classList.toggle('error', !!isError);
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function escapeAttr(s) { return escapeHtml(s); }
  function bindExamples() {
    document.querySelectorAll('#tab-scout .scout-example').forEach(b => {
      b.onclick = () => { el('scoutInput').value = b.textContent; el('scoutInput').focus(); };
    });
  }

  // ---------- Init ----------
  let inited = false;
  function ensureInit() {
    if (inited) return;
    inited = true;
    el('scoutNewBtn').onclick = newSearch;
    el('scoutSendBtn').onclick = () => send(el('scoutInput').value.trim());

    (function wireScoutCollapse() {
      const shell = el('scoutShell');
      if (!shell) return;
      const LS = window.localStorage;
      const KEY_L = 'scout.collapse.left';
      const KEY_R = 'scout.collapse.right';
      function applyState() {
        const cl = LS.getItem(KEY_L) === '1';
        const cr = LS.getItem(KEY_R) === '1';
        shell.classList.toggle('collapse-left',  cl);
        shell.classList.toggle('collapse-right', cr);
      }
      function toggle(side) {
        const key = side === 'left' ? KEY_L : KEY_R;
        const cur = LS.getItem(key) === '1';
        LS.setItem(key, cur ? '0' : '1');
        applyState();
      }
      applyState();
      const btnL = el('scoutCollapseLeft');
      const btnR = el('scoutCollapseRight');
      const railMini = el('scoutRailMini');
      const expandTab = el('scoutFindingsExpandTab');
      const railMiniNew = el('scoutRailMiniNew');
      if (btnL) btnL.onclick = (e) => { e.stopPropagation(); toggle('left'); };
      if (btnR) btnR.onclick = (e) => { e.stopPropagation(); toggle('right'); };
      if (railMini) railMini.onclick = (e) => {
        // Click on the mini rail anywhere (except the + button) expands.
        if (e.target.id !== 'scoutRailMiniNew') toggle('left');
      };
      if (expandTab) expandTab.onclick = () => toggle('right');
      if (railMiniNew) railMiniNew.onclick = (e) => { e.stopPropagation(); newSearch(); };
      document.addEventListener('keydown', (e) => {
        // Only when Scout tab is active.
        const panel = document.getElementById('tab-scout');
        if (!panel || !panel.classList.contains('active') && panel.style.display === 'none') return;
        if (!(e.metaKey || e.ctrlKey)) return;
        if (e.key === '[') { e.preventDefault(); toggle('left'); }
        else if (e.key === ']') { e.preventDefault(); toggle('right'); }
      });
    })();

    (function wireScoutCollapseCounts() {
      function updateCounts() {
        try {
          const sc = window.state && window.state.searches ? window.state.searches.length : 0;
          const fc = window.state && window.state.findings
            ? window.state.findings.filter(x => x.status !== 'dismissed').length
            : 0;
          const railCount = el('scoutRailMiniCount');
          if (railCount) railCount.textContent = sc ? String(sc) : '';
          const expandCount = el('scoutFindingsExpandCount');
          if (expandCount) expandCount.textContent = String(fc);
        } catch (_e) {}
      }
      // Refresh on a slow heartbeat (cheap, no observer needed).
      setInterval(updateCounts, 800);
    })();

    // added later by the streaming render.
    document.addEventListener('click', (e) => {
      const card = e.target.closest && e.target.closest('.scout-tool-card');
      if (!card) return;
      // Don't toggle when clicking an inline link inside the card.
      if (e.target.closest('a')) return;
      card.classList.toggle('expanded');
    });

    // auto-scroll-to-bottom. Drops the jank during active polling.
    (function wireSmoothScroll() {
      const box = el('scoutMessages');
      if (!box) return;
      let userScrollTimer = null;
      box.addEventListener('wheel', () => {
        box.classList.add('user-scrolling');
        clearTimeout(userScrollTimer);
        userScrollTimer = setTimeout(() => box.classList.remove('user-scrolling'), 600);
      }, { passive: true });
    })();
    el('scoutInput').addEventListener('keydown', e => {
      // Enter sends; Shift+Enter inserts a newline.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send(el('scoutInput').value.trim());
      }
    });
    el('scoutCommitBtn').onclick = commitSelected;
    bindExamples();
    // search list. The v98 DOMContentLoaded safety net runs ensureInit
    // before the async config-fetch resolves, which used to throw
    // 'Could not load searches: Supabase not ready' on first view.
    (function waitSb(tries){
      if (typeof _sb !== 'undefined' && _sb) { refreshSearches(); return; }
      if (tries > 100) { refreshSearches(); return; } // ~10s — let it surface a real error if still null
      setTimeout(function(){ waitSb(tries + 1); }, 100);
    })(0);
  }

  // Activate when the tab opens (legacy tabbar OR v98 left rail link)
  document.addEventListener('click', e => {
    const btn = e.target.closest && (e.target.closest('[data-tab="scout"]') || e.target.closest('[data-v98-tab="scout"]'));
    if (btn) setTimeout(ensureInit, 50);
  });
  // work even if the user lands on Scout via deep-link, hashchange, or any
  // path that doesn't fire a click on a [data-(v98-)tab="scout"] node.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureInit);
  } else {
    setTimeout(ensureInit, 0);
  }
  // If user lands directly on #scout
  if (location.hash.indexOf('scout') >= 0) {
    setTimeout(ensureInit, 200);
  }

  return { ensureInit, refreshSearches, _state: state };
})();

})();

