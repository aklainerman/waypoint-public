// js/render/mission-control.js
//
// renderMissionControl() reads DB.state and populates every widget on
// the dashboard tab. Helpers (_money, _escapeHtml, _attrJSON,
// _departmentSwatch, _solOpen/Value/Pwin/DueDate/OfficeId) are
// presentation utilities used internally.
//
// Companion v141 priority-budget helpers (_consolidateSvc,
// _svcFromAppr, _expandPriorityBudgetPaths) are used by the
// "go to priority PEs" MC tile launcher (window._v98GoToPriorityPEs).
//
// The v98InstrumentMC IIFE near the bottom wraps window.renderMissionControl
// with diagnostics + a retry loop that nudges MC for 10s after DB.lastSaved
// flips. Originally ran during HTML parsing in the inline monolith; now
// runs at module-load time (deferred), AFTER HTML parse completes. External
// callers reach the WRAPPED window.renderMissionControl, not the bare
// module-scoped renderMissionControl.
//
// Two waypoint:datachange listeners are also in this section (renamed
// from legacy enigma:datachange in v235):
//   1. Re-render MC when data changes AND user is on the dashboard tab.
//   2. v143: re-render Budget > Tag Offices subtab when offices data
//      changes AND that panel is active. (Not strictly MC, but lives
//      here because both listeners share the same datachange event.)
//
// Originally at file-scope of the inline monolith; lifted to ES module
// in v189. Same classic-script-split pattern as v181-v186.
//
// Exposes on window:
//   window.renderMissionControl  -- 10 external callers. Defensive
//                                    pre-expose at top of module; the
//                                    v98InstrumentMC IIFE then overrides
//                                    it with the diagnostics wrapper.
//   window._v98GoToPriorityPEs   -- already exposed inline; preserved
//   window._v141GoToPriorityOrgsBudget  -- already exposed inline; preserved
//
// Consumes from window (provided by the monolith + earlier modules):
//   DB, escHtml, fmtMoney, fmtDate, officeName, officeIsPriority,
//   svcBadge, statusPill, alignmentStars, deptBadge, activateTab,
//   renderBudget, renderBudgetTagOffices, and many others. All
//   reachable via the monolith's classic-script global hoisting.

// Defensive pre-expose so external callers always find renderMissionControl
// on window even if the v98InstrumentMC wrap below fails its pre-flight.
// The wrap IIFE runs after this and overrides window.renderMissionControl
// with the diagnostics-wrapped version.
window.renderMissionControl = renderMissionControl;

// ============================================================
// ------------------------------------------------------------
// Reads DB.state and populates every widget on the dashboard tab.
// Safe to call any time after DB has hydrated. No new schema.
// ============================================================
function _money(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2).replace(/\.0+$/, '') + 'B';
  if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (abs >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(n).toString();
}
function _escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// double-quoted attribute. JSON.stringify alone produces literal
// double quotes which prematurely close the attribute.
function _attrJSON(s) {
  return JSON.stringify(String(s == null ? '' : s)).replace(/"/g, '&quot;');
}
function _departmentSwatch(dept) {
  // chips elsewhere). The donut wedges use a distinct, saturated palette
  // because the dark-mode tokens collapse multiple services to the
  // same hue and the small donut wedges become unreadable.
  const d = String(dept || '').toLowerCase().trim();
  // Match in specificity order: longer/exact codes first.
  if (d === 'sf' || d.includes('space') || d.includes('ussf')) return { color: 'var(--af)', bg: 'var(--af-bg)', donut: '#9B7EDC', label: 'Space Force' };
  if (d === 'af' || d === 'usaf' || d === 'haf' || d.includes('air force') || d.includes('air-force')) return { color: 'var(--af)', bg: 'var(--af-bg)', donut: '#5B8DEF', label: 'Air Force' };
  if (d.includes('marine') || d.includes('usmc')) return { color: 'var(--army)', bg: 'var(--army-bg)', donut: '#C0392B', label: 'USMC' };
  if (d === 'army' || d.includes('army')) return { color: 'var(--army)', bg: 'var(--army-bg)', donut: '#5DAA48', label: 'Army' };
  if (d === 'navy' || d.includes('navsea') || d.includes('naval') || d.includes('navy')) return { color: 'var(--navy)', bg: 'var(--navy-bg)', donut: '#2E86C1', label: 'Navy' };
  if (d.includes('darpa')) return { color: 'var(--joint)', bg: 'var(--joint-bg)', donut: '#8E44AD', label: 'DARPA' };
  if (d.includes('socom') || d.includes('cocom')) return { color: 'var(--cocom)', bg: 'var(--cocom-bg)', donut: '#E67E22', label: 'COCOM' };
  if (d.includes('hill') || d.includes('senate') || d.includes('house') || d.includes('congress')) return { color: 'var(--hill)', bg: 'var(--hill-bg)', donut: '#95A5A6', label: 'Hill' };
  if (d.includes('joint') || d === 'osd' || d.includes('osw')) return { color: 'var(--joint)', bg: 'var(--joint-bg)', donut: '#F39C12', label: 'Joint' };
  return { color: 'var(--enduser)', bg: 'var(--enduser-bg)', donut: '#7F8C8D', label: dept || '—' };
}
function _solOpen(sol) {
  const s = String(sol.status || '').toLowerCase();
  return s !== 'won' && s !== 'lost' && s !== 'ignored';
}
function _solValue(sol) {
  // sol.value is the JS-side $ ceiling (matches v97 kanban totals).
  // estimated_value is the Postgres generated column; we don't read it.
  const v = parseFloat(sol.value);
  return isFinite(v) ? v : 0;
}
function _solPwin(sol) {
  const p = parseFloat(sol.probability_pct);
  if (!isFinite(p)) return 0;
  // Allow either 0..1 or 0..100 stored values.
  return p > 1.5 ? p / 100 : p;
}
function _solDueDate(sol) {
  return sol.dueDate || sol.due_date || sol.dueDt || '';
}
function _solOfficeId(sol) {
  return sol.officeId || sol.office_id || sol.office_id_new || '';
}

function renderMissionControl() {
  // Bail out if the dashboard tab isn't actually mounted (e.g. early call).
  if (!document.getElementById('missionControl')) return;
  if (!window.DB || !DB.state) return;

  const sols = DB.list('solicitations') || [];
  const contacts = DB.list('contacts') || [];
  const letters = DB.list('letters') || [];
  const offices = DB.list('offices') || [];
  const washops = DB.list('washops') || [];
  const pes = DB.list('budget_pes') || [];
  const peLinks = DB.list('pe_office_links') || [];

  // ---------- KPI strip ----------
  const openSols = sols.filter(_solOpen);
  const wonSols = sols.filter(s => String(s.status || '').toLowerCase() === 'won');
  const pipelineTotal = openSols.reduce((a, s) => a + _solValue(s), 0);
  const weightedTotal = openSols.reduce((a, s) => a + _solValue(s) * _solPwin(s), 0);
  const awardsTotal = wonSols.reduce((a, s) => a + _solValue(s), 0);
  const championCount = contacts.filter(c => !!c.champion).length;
  const supportCount = letters.length;

  function setKpi(name, txt) {
    const el = document.querySelector('[data-mc-val="' + name + '"]');
    if (el) el.textContent = txt;
  }
  setKpi('pipeline', _money(pipelineTotal));
  setKpi('weighted', _money(weightedTotal));
  setKpi('active', String(openSols.length));
  setKpi('awards', _money(awardsTotal));
  setKpi('champions', String(championCount));
  setKpi('support', String(supportCount));

  // ---------- Pipeline by Stage ----------
  const STAGES = ['Identified', 'Reviewing', 'Drafting', 'Applied', 'Negotiating', 'Won'];
  const byStage = {};
  STAGES.forEach(s => { byStage[s] = { count: 0, total: 0, weighted: 0 }; });
  sols.forEach(sol => {
    const st = sol.status || '';
    if (!byStage[st]) return;
    const v = _solValue(sol);
    byStage[st].count += 1;
    byStage[st].total += v;
    byStage[st].weighted += v * _solPwin(sol);
  });
  let stageMax = 0;
  STAGES.forEach(s => { if (byStage[s].total > stageMax) stageMax = byStage[s].total; });
  const stageColors = {
    'Identified': '#888780',
    'Reviewing': '#378ADD',
    'Drafting': '#185FA5',
    'Applied': '#BA7517',
    'Negotiating': '#854F0B',
    'Won': '#639922',
  };
  const stageRows = STAGES.map(stage => {
    const d = byStage[stage];
    const pct = stageMax > 0 ? Math.round((d.total / stageMax) * 100) : 0;
    return ''
      + '<div class="mc-stage-row" data-mc-stage="' + stage + '" '
      + 'onclick="_v98GoToStage(' + _attrJSON(stage) + '); return false;" style="cursor:pointer;">'
      + '<span class="mc-stage-label">' + stage + '</span>'
      + '<div class="mc-stage-bar"><span style="width:' + pct + '%;background:' + stageColors[stage] + ';"></span></div>'
      + '<span class="mc-stage-money">' + _money(d.total) + '</span>'
      + '<span class="mc-stage-weighted" title="weighted by P(win)">' + _money(d.weighted) + '</span>'
      + '<span class="mc-stage-count">n=' + d.count + '</span>'
      + '</div>';
  }).join('');
  const stageList = document.getElementById('mcStageList');
  if (stageList) stageList.innerHTML = stageRows || '<div class="mc-empty">No solicitations yet.</div>';
  const stageSub = document.getElementById('mcStageSub');
  if (stageSub) stageSub.textContent = openSols.length + ' open opportunities';

  // ---------- Closing in 30 days ----------
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueRows = openSols
    .map(sol => {
      const dStr = _solDueDate(sol);
      if (!dStr) return null;
      const due = new Date(dStr);
      if (isNaN(due.getTime())) return null;
      due.setHours(0, 0, 0, 0);
      const days = Math.round((due - today) / 86400000);
      return { sol, days };
    })
    .filter(r => r && r.days >= 0 && r.days <= (window._dueWindow || 30))
    .sort((a, b) => a.days - b.days)
    .slice(0, 12);
  const dueList = document.getElementById('mcDueList');
  if (dueList) {
    if (!dueRows.length) {
      dueList.innerHTML = '<div class="mc-empty">No solicitations due within ' + (window._dueWindow || 30) + ' days.</div>';
    } else {
      dueList.innerHTML = dueRows.map(r => {
        const sol = r.sol;
        const days = r.days;
        const dueCls = days <= 14 ? 'due-red' : (days <= 30 ? 'due-amber' : '');
        const pri = sol.is_priority
          ? '<span class="mc-pri-star" title="Priority">\u2605</span>'
          : '<span class="mc-pri-spacer"></span>';
        const officeId = _solOfficeId(sol);
        const _off = officeId ? DB.get('offices', officeId) : null;
        const _offName = (_off && _off.name) || '';
        const v = _solValue(sol);
        const _solTitle = sol.title || '(untitled)';
        return ''
          + '<div class="mc-list-row" data-mc-sol="' + _escapeHtml(sol.id) + '" '
          + 'onclick="_v98GoToSol(' + _attrJSON(_solTitle) + '); return false;" style="cursor:pointer;">'
          + pri
          + '<span class="mc-list-name" title="' + _escapeHtml(_offName) + '">'
          + _escapeHtml(_solTitle) + '</span>'
          + '<span class="mc-list-meta ' + dueCls + '">' + days + 'd · ' + _money(v) + '</span>'
          + '</div>';
      }).join('');
    }
  }
  const dueSub = document.getElementById('mcDueSub');
  if (dueSub) dueSub.textContent = (dueRows.length ? (dueRows.length + ' upcoming') : 'none in window') + ' · ' + (window._dueWindow || 30) + 'd';
  document.querySelectorAll('#mcDueToggle button').forEach(function (b) {
    b.classList.toggle('active', parseInt(b.dataset.due, 10) === (window._dueWindow || 30));
  });

  // ---------- Top orgs by pipeline ----------
  const officeMap = new Map();
  offices.forEach(o => { if (o && o.id) officeMap.set(o.id, o); });
  const orgTotals = new Map();
  openSols.forEach(sol => {
    const oid = _solOfficeId(sol);
    if (!oid) return;
    orgTotals.set(oid, (orgTotals.get(oid) || 0) + _solValue(sol));
  });
  const topOrgs = Array.from(orgTotals.entries())
    .map(([id, total]) => ({ id, total, office: officeMap.get(id) }))
    .filter(r => r.office && r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
  const topOrgsList = document.getElementById('mcTopOrgsList');
  if (topOrgsList) {
    if (!topOrgs.length) {
      topOrgsList.innerHTML = '<div class="mc-empty">No pipeline tied to orgs yet.</div>';
    } else {
      topOrgsList.innerHTML = topOrgs.map(r => {
        const swatch = _departmentSwatch(r.office.department || r.office.dashboard_group || '');
        const _orgName = r.office.name || r.id;
        return ''
          + '<div class="mc-list-row" '
          + 'onclick="_v98GoToOrg(' + _attrJSON(_orgName) + '); return false;" '
          + 'style="cursor:pointer;">'
          + '<span class="mc-pill" style="background:' + swatch.bg + ';color:' + swatch.color + ';">' + _escapeHtml(swatch.label) + '</span>'
          + '<span class="mc-list-name">' + _escapeHtml(_orgName) + '</span>'
          + '<span class="mc-list-meta">' + _money(r.total) + '</span>'
          + '</div>';
      }).join('');
    }
  }

  // ---------- Service mix donut ----------
  const svcTotals = new Map();
  const svcMode = window._svcMode || 'sol';
  function _bumpSvc(o, amt) {
    if (!o) return;
    const sw = _departmentSwatch(o.department || o.dashboard_group || '');
    const k = sw.label;
    if (!svcTotals.has(k)) svcTotals.set(k, { total: 0, donut: sw.donut });
    svcTotals.get(k).total += amt;
  }
  if (svcMode === 'sol') {
    openSols.forEach(sol => {
      const o = officeMap.get(_solOfficeId(sol));
      if (o) _bumpSvc(o, _solValue(sol));
    });
  } else if (svcMode === 'contacts') {
    contacts.forEach(c => {
      const oids = (c.officeIds || []).concat(c.officeId ? [c.officeId] : []);
      const seen = new Set();
      oids.forEach(oid => {
        if (!oid || seen.has(oid)) return;
        seen.add(oid);
        _bumpSvc(officeMap.get(oid), 1);
      });
    });
  } else if (svcMode === 'champions') {
    contacts.filter(c => c.champion).forEach(c => {
      const oids = (c.officeIds || []).concat(c.officeId ? [c.officeId] : []);
      const seen = new Set();
      oids.forEach(oid => {
        if (!oid || seen.has(oid)) return;
        seen.add(oid);
        _bumpSvc(officeMap.get(oid), 1);
      });
    });
  }
  const svcArr = Array.from(svcTotals.entries())
    .map(([label, d]) => ({ label, total: d.total, donut: d.donut }))
    .sort((a, b) => b.total - a.total);
  const svcSum = svcArr.reduce((a, b) => a + b.total, 0) || 1;
  const svcEl = document.getElementById('mcServiceMix');
  if (svcEl) {
    if (!svcArr.length) {
      svcEl.innerHTML = '<div class="mc-empty">No service data.</div>';
    } else {
      const C = 2 * Math.PI * 22; // circumference for r=22
      let offset = 0;
      const arcs = svcArr.map(s => {
        const len = (s.total / svcSum) * C;
        const tag = '<circle cx="30" cy="30" r="22" fill="none" stroke="' + s.donut + '" stroke-width="10" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) + '" stroke-dashoffset="' + (-offset).toFixed(2) + '" transform="rotate(-90 30 30)"/>';
        offset += len;
        return tag;
      }).join('');
      const legend = svcArr.slice(0, 5).map(s => ''
        + '<div>'
        + '<span class="mc-svc-swatch" style="background:' + s.donut + ';"></span>'
        + '<span>' + _escapeHtml(s.label) + '</span>'
        + '<span class="mc-svc-money">' + (svcMode === 'sol' ? _money(s.total) : Math.round(s.total)) + '</span>'
        + '<span class="mc-svc-pct">' + Math.round(100 * s.total / svcSum) + '%</span>'
        + '</div>'
      ).join('');
      svcEl.innerHTML = ''
        + '<svg class="mc-service-svg" viewBox="0 0 60 60">'
        + '<circle cx="30" cy="30" r="22" fill="none" stroke="var(--surface-alt)" stroke-width="10"/>'
        + arcs
        + '</svg>'
        + '<div class="mc-service-legend">' + legend + '</div>';
    }
  }
  const svcSub = document.getElementById('mcServiceSub');
  if (svcSub) {
    if (!svcArr.length) svcSub.textContent = '—';
    else if (svcMode === 'sol') svcSub.textContent = _money(svcSum) + ' OPEN · ' + svcArr.length + ' SERVICES';
    else if (svcMode === 'contacts') svcSub.textContent = Math.round(svcSum) + ' CONTACTS · ' + svcArr.length + ' SERVICES';
    else if (svcMode === 'champions') svcSub.textContent = Math.round(svcSum) + ' CHAMPIONS · ' + svcArr.length + ' SERVICES';
  }
  document.querySelectorAll('#mcSvcToggle button').forEach(function (b) {
    b.classList.toggle('active', b.dataset.svc === (window._svcMode || 'sol'));
  });

  // ---------- Top priority PEs ----------
  // Filter: PE.is_priority === true AND linked via pe_office_links to an office where office.priority === true.
  const priorityOfficeIds = new Set(offices.filter(o => !!o.priority).map(o => o.id));
  const linksByPe = new Map();
  peLinks.forEach(l => {
    if (!l || !l.pe_id) return;
    if (!linksByPe.has(l.pe_id)) linksByPe.set(l.pe_id, []);
    linksByPe.get(l.pe_id).push(l.office_id);
  });
  const priorityPes = pes
    .filter(pe => pe && pe.is_priority)
    .map(pe => {
      const linked = linksByPe.get(pe.id) || [];
      const matchOffice = linked.find(oid => priorityOfficeIds.has(oid));
      return matchOffice ? { pe, officeId: matchOffice } : null;
    })
    .filter(Boolean)
    .map(r => Object.assign({}, r, { fy26: parseFloat(r.pe.request_amount) || 0 }))
    .sort((a, b) => b.fy26 - a.fy26)
    .slice(0, 5);
  const peList = document.getElementById('mcTopPesList');
  if (peList) {
    if (!priorityPes.length) {
      peList.innerHTML = '<div class="mc-empty">No priority PEs tagged to priority orgs yet.</div>';
    } else {
      peList.innerHTML = priorityPes.map(r => {
        const office = officeMap.get(r.officeId);
        const peId = r.pe.id || '';
        return ''
          + '<div class="mc-list-row" '
          + 'onclick="activateTab(\'budget\', { budgetPe: \'' + _escapeHtml(peId) + '\' }); return false;" '
          + 'style="cursor:pointer; grid-template-columns: 70px 1fr 100px 70px;">'
          + '<span class="mc-pill" title="PE id">' + _escapeHtml(peId.slice(0, 12)) + '</span>'
          + '<span class="mc-list-name">' + _escapeHtml(r.pe.title || '(untitled PE)') + '</span>'
          + '<span class="mc-list-meta" style="text-align:left;">' + _escapeHtml((office && office.name) || '—') + '</span>'
          + '<span class="mc-list-meta">' + _money(r.fy26) + '</span>'
          + '</div>';
      }).join('');
    }
  }

  // ---------- v103 helpers: per-office aggregates ----------
  const officeMap2 = new Map();
  offices.forEach(o => { if (o && o.id) officeMap2.set(o.id, o); });
  const peMap = new Map();
  pes.forEach(p => { if (p && p.id) peMap.set(p.id, p); });
  // contacts per office (any link)
  const contactsByOffice = new Map();
  const championsByOffice = new Map();
  contacts.forEach(c => {
    const oids = (c.officeIds || []).concat(c.officeId ? [c.officeId] : []);
    const seen = new Set();
    oids.forEach(oid => {
      if (!oid || seen.has(oid)) return;
      seen.add(oid);
      contactsByOffice.set(oid, (contactsByOffice.get(oid) || 0) + 1);
      if (c.champion) championsByOffice.set(oid, (championsByOffice.get(oid) || 0) + 1);
    });
  });
  // open sols per office
  const solsByOffice = new Map();
  openSols.forEach(s => {
    const oid = _solOfficeId(s);
    if (!oid) return;
    solsByOffice.set(oid, (solsByOffice.get(oid) || 0) + 1);
  });
  // letters/support per office
  const lettersByOffice = new Map();
  letters.forEach(l => {
    const oid = l.office_id_new || l.officeId || l.office_id;
    if (!oid) return;
    lettersByOffice.set(oid, (lettersByOffice.get(oid) || 0) + 1);
  });
  // budget $ per office (PE links + SAG links + budget_org_id rollup).
  //
  // sag_office_links and missed the budget_org_id rollup that the office
  // detail view's _bovOfficeFy26Total includes. Symptom: SOCOM/SOF AT&L
  // (and any office that holds its budget via budget_org_id rather than
  // direct PE links) showed $0 on the "Strongest Org Fits" list while the
  // office detail panel showed a real total. Routing the per-office total
  // through _bovOfficeFy26Total guarantees parity with the detail view by
  // construction. _bovOfficeFy26Total internally folds rollup + direct
  // pe_office_links + getSagsForOffice into one number.
  const budgetByOffice = new Map();
  offices.forEach(o => {
    if (!o || !o.id) return;
    const total = (typeof _bovOfficeFy26Total === 'function')
      ? (_bovOfficeFy26Total(o) || 0)
      : 0;
    if (total) budgetByOffice.set(o.id, total);
  });
  // SAG link tables still needed for the downstream "Priority Org Budget"
  // tile (which de-dupes by tied PE / SAG ID across all priority offices).
  // budgetByOffice no longer references these directly -- SAG contribution
  // now flows through _bovOfficeFy26Total above.
  const sags = DB.list('budget_om_sags') || [];
  const sagLinks = DB.list('sag_office_links') || [];
  const sagMap = new Map();
  sags.forEach(s => { if (s && s.id) sagMap.set(s.id, s); });
  const priorityOffices = offices.filter(o => !!o.priority);
  const priorityOfficeIdsSet = new Set(priorityOffices.map(o => o.id));

  // ---------- Priority org budget ----------
  const tiedPeIds = new Set();
  peLinks.forEach(l => { if (priorityOfficeIdsSet.has(l.office_id) && l.pe_id) tiedPeIds.add(l.pe_id); });
  const tiedSagIds = new Set();
  sagLinks.forEach(l => { if (priorityOfficeIdsSet.has(l.office_id) && l.sag_id) tiedSagIds.add(l.sag_id); });
  let priorityOrgBudget = 0;
  tiedPeIds.forEach(id => {
    const p = peMap.get(id); if (p) priorityOrgBudget += parseFloat(p.request_amount) || 0;
  });
  tiedSagIds.forEach(id => {
    const s = sagMap.get(id); if (s) priorityOrgBudget += (window._v150SagAmt ? window._v150SagAmt(s) : (parseFloat(s.fy26_estimate) || 0));
  });
  const elPob = document.getElementById('mcPriorityOrgBudget');
  if (elPob) elPob.textContent = _money(priorityOrgBudget);
  const elPobd = document.getElementById('mcPriorityOrgBudgetDetail');
  if (elPobd) elPobd.textContent = priorityOffices.length
    ? (priorityOffices.length + ' priority orgs \u00B7 ' + tiedPeIds.size + ' PEs \u00B7 ' + tiedSagIds.size + ' SAGs')
    : 'no priority orgs flagged';

  // ---------- Priority PE budget ----------
  const priorityPesAll = pes.filter(p => p && p.is_priority);
  const priorityPeBudget = priorityPesAll.reduce((a, p) => a + (parseFloat(p.request_amount) || 0), 0);
  const elPpb = document.getElementById('mcPriorityPeBudget');
  if (elPpb) elPpb.textContent = _money(priorityPeBudget);
  const elPpbd = document.getElementById('mcPriorityPeBudgetDetail');
  if (elPpbd) elPpbd.textContent = priorityPesAll.length
    ? (priorityPesAll.length + ' priority PEs')
    : 'no priority PEs flagged';

  // ---------- Strongest org fits (top 5 by composite score) ----------
  const fitScored = offices.map(o => {
    const cnt = contactsByOffice.get(o.id) || 0;
    const ch = championsByOffice.get(o.id) || 0;
    const sl = solsByOffice.get(o.id) || 0;
    const lt = lettersByOffice.get(o.id) || 0;
    const bg = budgetByOffice.get(o.id) || 0;
    const score = ch * 5 + cnt * 1 + sl * 3 + lt * 2 + (o.priority ? 5 : 0) + Math.min(15, (bg / 1e9) * 3);
    return { office: o, cnt, ch, sl, lt, bg, score };
  })
  .filter(r => r.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, 5);
  const elFits = document.getElementById('mcStrongFitsList');
  if (elFits) {
    if (!fitScored.length) {
      elFits.innerHTML = '<div class="mc-empty">No org engagement yet.</div>';
    } else {
      // Score formula recap: champ*5 + contact*1 + sol*3 + letter*2 + priority(5)
      //                       + min(15, $B*3). A solid engaged org sits ~25-30,
      //                       a thin one sits ~5. Saturate pure green at 30.
      function _fitLed(score) {
        if (score >= 30) return '#5DAA48';
        if (score >= 18) return '#7BC25A';
        if (score >= 10) return '#9BD176';
        if (score >=  5) return '#BBDD96';
        return '#D6E7B6';
      }
      elFits.innerHTML = fitScored.map((r, i) => {
        const name = (r.office.name || r.office.id);
        const meta = r.cnt + ' contact' + (r.cnt===1?'':'s') + ' · ' + r.ch + ' champ · ' + r.sl + ' sol';
        const led = _fitLed(r.score);
        return '<div class="mc-fit-row" '
          + 'onclick="_v98GoToOrg(' + _attrJSON(name) + '); return false;">'
          + '<span class="mc-fit-led" style="background:' + led + ';"></span>'
          + '<span class="mc-fit-name">' + _escapeHtml(name) + '</span>'
          + '<span class="mc-fit-meta">' + meta + '</span>'
          + '<span class="mc-fit-money">' + _money(r.bg) + '</span>'
          + '</div>';
      }).join('');
    }
  }

  // ---------- Biggest org gaps (priority orgs by budget/engagement) ----------
  const gapScored = priorityOffices.map(o => {
    const cnt = contactsByOffice.get(o.id) || 0;
    const ch = championsByOffice.get(o.id) || 0;
    const sl = solsByOffice.get(o.id) || 0;
    const lt = lettersByOffice.get(o.id) || 0;
    const bg = budgetByOffice.get(o.id) || 0;
    const eng = ch * 3 + cnt * 1 + sl * 2 + lt * 1.5;
    const gap = bg / (1 + eng);
    return { office: o, cnt, ch, sl, lt, bg, eng, gap };
  })
  .filter(r => r.bg > 0)
  .sort((a, b) => b.gap - a.gap)
  .slice(0, 5);
  const elGaps = document.getElementById('mcOrgGapsList');
  if (elGaps) {
    if (!gapScored.length) {
      elGaps.innerHTML = '<div class="mc-empty">No priority orgs with tagged budget.</div>';
    } else {
      // eng = ch*3 + cnt*1 + sl*2 + lt*1.5. eng==0 means a budget-tagged
      // priority org with literally zero engagement -> pure red. Any pulse
      // of activity (even a single sol) fades the red toward yellow.
      function _gapLed(gap, eng) {
        if (!eng || eng <= 0)  return '#E24B4A'; // pure red - zero engagement
        if (eng <= 2)          return '#E2715A'; // 1 sol or a couple contacts
        if (eng <= 5)          return '#E0996A';
        if (eng <= 10)         return '#D8B26A';
        return '#D0C76A';                          // healthy engagement
      }
      elGaps.innerHTML = gapScored.map((r, i) => {
        const name = (r.office.name || r.office.id);
        const meta = r.cnt + ' contact' + (r.cnt===1?'':'s') + ' · ' + r.ch + ' champ · ' + r.sl + ' sol';
        const led = _gapLed(r.gap, r.eng);
        return '<div class="mc-fit-row" '
          + 'onclick="_v98GoToOrg(' + _attrJSON(name) + '); return false;">'
          + '<span class="mc-fit-led" style="background:' + led + ';"></span>'
          + '<span class="mc-fit-name">' + _escapeHtml(name) + '</span>'
          + '<span class="mc-fit-meta">' + meta + '</span>'
          + '<span class="mc-fit-money">' + _money(r.bg) + '</span>'
          + '</div>';
      }).join('');
    }
  }

  // ---------- The Hill ----------
  // Merge both, tag MTG/REQ, sort by date desc, show name of the member or
  // committee the engagement is tied to.
  const hillMeetings = (DB.list && DB.list('hill_meetings')) || [];
  const hillRequests = (DB.list && DB.list('hill_requests')) || [];
  const hillMembers  = (DB.list && DB.list('hill_members')) || [];
  const hillCommittees = (DB.list && DB.list('hill_committees')) || [];
  const _memById = new Map(); hillMembers.forEach(m => { if (m && m.bioguide_id) _memById.set(m.bioguide_id, m); });
  const _comById = new Map(); hillCommittees.forEach(c => { if (c && c.thomas_id) _comById.set(c.thomas_id, c); });
  function _hillTargetName(targetType, targetId) {
    if (targetType === 'member') {
      const m = _memById.get(targetId);
      return (m && m.full_name) || targetId || '';
    }
    if (targetType === 'committee') {
      const c = _comById.get(targetId);
      return (c && c.name) || targetId || '';
    }
    return targetId || '';
  }
  const hillCombined = [].concat(
    hillMeetings.map(r => ({
      kind: 'MTG',
      title: r.title || 'Meeting',
      date: r.meeting_date || '',
      target_type: r.target_type, target_id: r.target_id
    })),
    hillRequests.map(r => ({
      kind: 'REQ',
      title: r.title || 'Request',
      date: r.submit_date || '',
      target_type: r.target_type, target_id: r.target_id,
      status: r.status
    }))
  ).filter(x => x.date)
   .sort((a, b) => String(b.date).localeCompare(String(a.date)))
   .slice(0, 8);

  const hillList = document.getElementById('mcHillList');
  if (hillList) {
    if (!hillCombined.length) {
      hillList.innerHTML = '<div class="mc-empty">No engagements logged yet.</div>';
    } else {
      hillList.innerHTML = hillCombined.map(r => {
        const tName = _hillTargetName(r.target_type, r.target_id);
        const summary = r.title + (tName ? ' · ' + tName : '') + (r.status ? ' · ' + r.status : '');
        // auto-open the matching member's drawer instead of just landing
        // on the Hill Ops tab with no context.
        return ''
          + '<div class="mc-list-row" '
          + 'onclick="_v230GoToHillEntry('
              + _attrJSON(r.target_type || '') + ','
              + _attrJSON(r.target_id || '') + ','
              + _attrJSON(summary)
            + '); return false;" '
          + 'style="cursor:pointer;">'
          + '<span class="mc-pill">' + r.kind + '</span>'
          + '<span class="mc-list-name">' + _escapeHtml(summary) + '</span>'
          + '<span class="mc-list-meta">' + _escapeHtml(r.date) + '</span>'
          + '</div>';
      }).join('');
    }
  }
  // Bump card subtitle to reflect the new count
  const hillCard = hillList && hillList.closest('.mc-card');
  const hillSub = hillCard && hillCard.querySelector('.mc-card-sub');
  if (hillSub) hillSub.textContent = (hillMeetings.length + hillRequests.length) + ' total · 8 most recent';
}

// array (referenced by the boot IIFE) and a light rail-count refresh
// pinned to data changes.  Mission Control re-renders are driven by
// the v98 fix-002 InstrumentMC nudge, the waypoint:datachange listener,
// and the v147 post-budget-phase hook — no perpetual 500ms timer.
window.__waypoint_boot_errors = window.__waypoint_boot_errors || [];
(function v172RailCountRefresher() {
  function refreshRailCounts() {
    if (!window.DB || !DB.state) return;
    document.querySelectorAll('.v98-rail-count[data-count]').forEach(function (el) {
      var t = el.dataset.count;
      if (t === 'washops') {
        var meets = (DB.state.hill_meetings || []).length;
        var reqs  = (DB.state.hill_requests || []).length;
        el.textContent = (meets + reqs);
      } else if (Array.isArray(DB.state[t])) {
        el.textContent = DB.state[t].length;
      }
    });
  }
  document.addEventListener('waypoint:datachange', refreshRailCounts);
  // First paint + a handful of post-boot retries (covers the window
  // between DB.load resolve and the first dispatched datachange event).
  function paint(tries) {
    refreshRailCounts();
    if (tries > 0) setTimeout(function () { paint(tries - 1); }, 500);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { paint(20); });
  } else {
    paint(20);
  }
})();

window._dueWindow = window._dueWindow || 30;
window._svcMode = window._svcMode || 'sol';
window._v98SetDueWindow = function (days) {
  window._dueWindow = days;
  if (typeof window.renderMissionControl === 'function') {
    try { window.renderMissionControl(); } catch (e) { console.warn('[mc]', e); }
  }
};
window._v98SetSvcMode = function (mode) {
  window._svcMode = mode;
  if (typeof window.renderMissionControl === 'function') {
    try { window.renderMissionControl(); } catch (e) { console.warn('[mc]', e); }
  }
};
// pre-expand the path for every priority PE/SAG so the rows render open.
function _consolidateSvc(raw) {
  if (!raw) return 'Defense Wide';
  var u = String(raw).trim().toUpperCase();
  if (u === 'AF' || u === 'AIR FORCE' || u === 'USAF') return 'Air Force';
  if (u === 'AIR FORCE RESERVE' || u === 'AFRC') return 'Air Force';
  if (u === 'AIR NATIONAL GUARD' || u === 'ANG') return 'Air Force';
  if (u === 'ARMY' || u === 'DA') return 'Army';
  if (u === 'ARMY RESERVE' || u === 'USAR') return 'Army';
  if (u === 'ARMY NATIONAL GUARD' || u === 'ARNG') return 'Army';
  if (u === 'NAVY' || u === 'USN') return 'Navy';
  if (u === 'NAVY RESERVE' || u === 'USNR') return 'Navy';
  if (u === 'MC' || u === 'USMC' || u === 'MARINES' || u === 'MARINE CORPS') return 'Navy';
  if (u === 'MARINE CORPS RESERVE' || u === 'USMCR') return 'Navy';
  if (u === 'SF' || u === 'USSF' || u === 'SPACE' || u === 'SPACE FORCE') return 'Air Force';
  if (u === 'DW' || u === 'DEFENSE' || u === 'DEFENSE-WIDE' || u === 'DEFENSE WIDE') return 'Defense Wide';
  return 'Defense Wide';
}
function _svcFromAppr(ap) {
  var acct = (ap && ap.account) || '';
  var m = acct.match(/,\s*(.+)$/);
  if (m) return m[1].trim();
  var au = acct.toUpperCase();
  if (au.indexOf('AIR FORCE') === 0) return 'Air Force';
  if (au.indexOf('ARMY') === 0)      return 'Army';
  if (au.indexOf('NAVY') === 0)      return 'Navy';
  if (au.indexOf('MARINE') === 0)    return 'Marine Corps';
  return (ap && ap.title) || '?';
}
function _expandPriorityBudgetPaths() {
  try {
    if (typeof _budgetExpanded === 'undefined' || _budgetExpanded === null) {
      _budgetExpanded = new Set();
    }
    var pes = (DB.list && DB.list('budget_pes')) || [];
    var apprs = (DB.list && DB.list('budget_appropriations')) || [];
    var orgs = (DB.list && DB.list('budget_orgs')) || [];
    var apprById = {}; apprs.forEach(function(a){ apprById[a.id] = a; });
    var orgById  = {}; orgs.forEach(function(o){ orgById[o.id] = o; });
    pes.filter(function(p){ return p && p.is_priority; }).forEach(function(pe){
      var ap = apprById[pe.appropriation_id]; if (!ap) return;
      var oo = orgById[pe.owning_org_id];
      var rawSvc = (oo && oo.service) || _svcFromAppr(ap);
      var svcKey = _consolidateSvc(rawSvc);
      var acctKey = ap.account || '?';
      _budgetExpanded.add('svc:' + svcKey);
      _budgetExpanded.add('svc:' + svcKey + '|acct:' + acctKey);
      _budgetExpanded.add('svc:' + svcKey + '|acct:' + acctKey + '|ba:' + pe.appropriation_id);
      _budgetExpanded.add('svc:' + svcKey + '|acct:' + acctKey + '|ba:' + pe.appropriation_id + '|pe:' + pe.id);
    });
    var sags = (DB.list && DB.list('budget_om_sags')) || [];
    sags.filter(function(s){ return s && s.is_priority; }).forEach(function(sag){
      var ap = apprById[sag.appropriation_id]; if (!ap) return;
      var rawSvc = '';
      if (sag.owning_org_id) {
        var oo2 = orgById[sag.owning_org_id];
        rawSvc = (oo2 && oo2.service) || '';
      }
      if (!rawSvc) rawSvc = _svcFromAppr(ap);
      var svcKey = _consolidateSvc(rawSvc);
      var acctKey = ap.account || 'O&M,Defense-Wide';
      _budgetExpanded.add('svc:' + svcKey);
      _budgetExpanded.add('svc:' + svcKey + '|acct:' + acctKey);
      _budgetExpanded.add('svc:' + svcKey + '|acct:' + acctKey + '|ba:' + sag.appropriation_id);
      _budgetExpanded.add('svc:' + svcKey + '|acct:' + acctKey + '|ba:' + sag.appropriation_id + '|pe:' + (sag.sag_short_code || sag.id));
    });
  } catch (e) { console.warn('[v141] expand priority paths failed', e); }
}
window._v98GoToPriorityPEs = function () {
  _expandPriorityBudgetPaths();
  if (typeof activateTab === 'function') activateTab('budget');
  setTimeout(function () {
    var hb = document.querySelector('[data-subtab-group="budget"] .subtab-btn[data-subtab="budget-hierarchy"]');
    if (hb && !hb.classList.contains('active')) hb.click();
    var cb = document.getElementById('budgetPriorityOnly');
    if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
    else if (typeof renderBudget === 'function') { renderBudget(); }
  }, 60);
};
window._v141GoToPriorityOrgsBudget = function () {
  if (typeof activateTab === 'function') {
    activateTab('budget', { budgetOfficeView: { priorityOnly: true } });
  }
};

(function v98InstrumentMC() {
  if (typeof renderMissionControl !== 'function') {
    console.warn('[mc] renderMissionControl missing at instrument time');
    return;
  }
  const original = renderMissionControl;
  let lastSummary = '';
  window.renderMissionControl = function () {
    try {
      const res = original.apply(this, arguments);
      const sols = (window.DB && DB.state && DB.state.solicitations) || [];
      const summary = '[mc] rendered · sols=' + sols.length
        + ' contacts=' + ((DB.state.contacts||[]).length)
        + ' offices=' + ((DB.state.offices||[]).length)
        + ' letters=' + ((DB.state.letters||[]).length)
        + ' washops=' + ((DB.state.washops||[]).length)
        + ' pes=' + ((DB.state.budget_pes||[]).length);
      if (summary !== lastSummary) { console.log(summary); lastSummary = summary; }
      return res;
    } catch (e) {
      console.error('[mc] render threw:', e);
      const root = document.getElementById('missionControl');
      if (root) {
        const note = document.createElement('div');
        note.style.cssText = 'padding:8px 12px;margin-bottom:8px;background:#3B1F0E;color:#FA824C;border-radius:4px;font-size:11px;font-family:monospace;';
        note.textContent = 'Mission Control render error: ' + (e && e.message ? e.message : String(e));
        root.insertBefore(note, root.firstChild);
      }
      throw e;
    }
  };
  // Retry loop: nudge for 10s after DOM ready.
  function nudge() {
    if (window.DB && DB.state && DB.state.lastSaved) {
      try { window.renderMissionControl(); } catch (e) { /* already logged */ }
    }
  }
  let count = 0;
  const iv = setInterval(function () {
    count++; nudge();
    if (count > 20) clearInterval(iv);
  }, 500);
})();

// Re-render Mission Control whenever data changes AND the user is on it.
document.addEventListener('waypoint:datachange', function () {
  if (document.getElementById('tab-dashboard') && document.getElementById('tab-dashboard').classList.contains('active')) {
    try { renderMissionControl(); } catch (e) { console.warn('[mc]', e); }
  }
});
// This is what lets a manual office save (via 'Pick manually...' -> editOffice
// modal -> Save) update the Tag Offices view so the row gets a green check
// and disappears from the untagged list without a page reload.
document.addEventListener('waypoint:datachange', function (ev) {
  var det = ev && ev.detail; if (!det || det.table !== 'offices') return;
  var panel = document.querySelector('.subtab-panel[data-subtab-panel="budget-tag-offices"]');
  if (panel && panel.classList.contains('active')
      && typeof renderBudgetTagOffices === 'function') {
    try { renderBudgetTagOffices(); } catch (e) { console.warn('[budget-tag]', e); }
  }
});