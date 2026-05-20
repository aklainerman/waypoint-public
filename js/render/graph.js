// js/render/graph.js
//
// Graph tab — Cytoscape.js relationship network rendering.
// Builds + lays out + filters the org / contact / solicitation / letter
// / Hill-member graph. Bound to a single Cytoscape instance held in
// window.GRAPH.cy. Lazy-built on first tab activation; rebuilt on theme
// toggle to re-resolve CSS-variable colors.
//
// Originally at file-scope of the inline monolith; lifted to ES module
// in v183. Same classic-script-split pattern as v181 / v182.
//
// Exposes on window:
//   window.GRAPH         -- { cy, built, focusedId } state object
//   window.renderGraph   -- entry point called from tab activation, sub-tab
//                            activator, dashboard hook, and theme toggle hook
//
// All other declarations are module-internal. Consumes from window
// (provided by the monolith + CDN globals): DB, cytoscape, escHtml,
// openModal, officeIsPriority, editOffice, editContact, editWo, editSol,
// activateTab, and other helpers.
//
// Listens on 'waypoint:themechange' (renamed from legacy enigma:* in v235).
// Re-renders Cytoscape colors on theme cycles. The earlier event-bus bridge
// listener fires either way. Migration deferred.

// ---------------------------------------------------------------
//  Graph tab — Cytoscape.js relationship network
// ---------------------------------------------------------------
const GRAPH = {
  cy: null,           // Cytoscape instance
  built: false,       // has the initial render happened
  focusedId: null,    // currently focused node (for neighborhood mode)
};

// Map a service string to the CSS variable used for node fill.
function graphServiceColor(service) {
  const s = (service || '').toLowerCase();
  if (s === 'air force' || s === 'space force') return 'var(--af)';
  if (s === 'army') return 'var(--army)';
  if (s === 'navy' || s === 'marines') return 'var(--navy)';
  if (s === 'osd' || s === 'socom' || s === 'joint') return 'var(--joint)';
  if (s === 'congress') return 'var(--hill)';
  return 'var(--text-dim)';
}

// Resolve a CSS variable against :root at runtime — Cytoscape needs real colors,
// not var(--x) strings. Re-call on theme change.
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

function resolveNodeColor(node) {
  // node.data.fillVar is the var name (e.g. '--af')
  const v = node.data('fillVar');
  if (v) return cssVar(v);
  return '#888';
}

// Build nodes + edges from live DB state. Returns { elements: [...] }.
function buildGraphData() {
  const elements = [];
  const officeMap = new Map();
  DB.state.offices.forEach(o => {
    officeMap.set(o.id, o);
    const svcVar = ({
      'Air Force':'--af','Space Force':'--af',
      'Army':'--army',
      'Navy':'--navy','Marines':'--navy',
      'OSD':'--joint','SOCOM':'--joint','Joint':'--joint',
      'Congress':'--hill',
    })[o.service] || '--text-dim';
    const isPri = officeIsPriority(o);
    elements.push({
      data: {
        id: 'org-' + o.id,
        type: 'org',
        label: o.name,
        fullName: o.fullName || o.name,
        service: o.service || '',
        tier: o.tier || '',
        priority: isPri ? 1 : 0,
        officeId: o.id,
        dashboardCardId: o.dashboardCardId || o.id,
        fillVar: svcVar,
      },
      classes: 'n-org' + (isPri ? ' n-priority' : ''),
    });
  });

  DB.state.contacts.forEach(c => {
    const isChampion = !!c.champion;
    const oids = (c.officeIds || []).filter(id => officeMap.has(id));
    elements.push({
      data: {
        id: 'con-' + c.id,
        type: 'contact',
        label: ((c.firstName||'') + ' ' + (c.lastName||'')).trim() || '(unnamed)',
        title: c.title || '',
        rank: c.rank || '',
        champion: isChampion,
        contactId: c.id,
        fillVar: isChampion ? '--priority' : '--text-dim',
      },
      classes: 'n-contact' + (isChampion ? ' n-champion' : ''),
    });
    oids.forEach(oid => {
      elements.push({ data: { id: 'e-con-' + c.id + '-' + oid, source: 'con-' + c.id, target: 'org-' + oid, type: 'works-at' }, classes: 'e-works' });
    });
  });

  DB.state.solicitations.forEach(s => {
    const stat = (s.status || '').toLowerCase();
    let statusVar = '--text-dim';
    if (stat === 'won') statusVar = '--priority';
    else if (['applied','selected','negotiating'].includes(stat)) statusVar = '--accent';
    else if (['drafting','reviewing','planned'].includes(stat)) statusVar = '--text-muted';
    elements.push({
      data: {
        id: 'sol-' + s.id,
        type: 'sol',
        label: (s.title || '').length > 40 ? (s.title||'').slice(0,37) + '…' : (s.title || '(untitled)'),
        fullLabel: s.title || '',
        status: s.status || '',
        value: s.value || 0,
        solId: s.id,
        fillVar: statusVar,
      },
      classes: 'n-sol',
    });
    if (s.officeId && officeMap.has(s.officeId)) {
      elements.push({ data: { id: 'e-sol-' + s.id + '-office', source: 'sol-' + s.id, target: 'org-' + s.officeId, type: 'issued-by' }, classes: 'e-issued' });
    }
    (s.contactIds || []).forEach(cid => {
      // Only link if contact exists
      if (DB.state.contacts.find(x => x.id === cid)) {
        elements.push({ data: { id: 'e-sol-' + s.id + '-con-' + cid, source: 'sol-' + s.id, target: 'con-' + cid, type: 'contact' }, classes: 'e-contact' });
      }
    });
  });


  DB.state.letters.forEach(l => {
    elements.push({
      data: {
        id: 'let-' + l.id,
        type: 'letter',
        label: (l.name || '').length > 40 ? (l.name||'').slice(0,37) + '…' : (l.name || '(unnamed)'),
        fullLabel: l.name || '',
        stage: l.status || '',
        letterId: l.id,
        fillVar: '--army-bg',
      },
      classes: 'n-letter',
    });
    if (l.officeId && officeMap.has(l.officeId)) {
      elements.push({ data: { id: 'e-let-' + l.id + '-office', source: 'let-' + l.id, target: 'org-' + l.officeId, type: 'targets' }, classes: 'e-targets' });
    }
    (l.contactIds || []).forEach(cid => {
      if (DB.state.contacts.find(x => x.id === cid)) {
        elements.push({ data: { id: 'e-let-' + l.id + '-con-' + cid, source: 'let-' + l.id, target: 'con-' + cid, type: 'signer' }, classes: 'e-signer' });
      }
    });
  });

  DB.state.washops.forEach(w => {
    elements.push({
      data: {
        id: 'wo-' + w.id,
        type: 'washop',
        label: (w.summary || w.type || 'Engagement').slice(0, 36),
        fullLabel: w.summary || '',
        date: w.date || '',
        washopId: w.id,
        fillVar: '--text-dim',
      },
      classes: 'n-washop',
    });
    (w.officeIds || []).forEach(oid => {
      if (officeMap.has(oid)) {
        elements.push({ data: { id: 'e-wo-' + w.id + '-' + oid, source: 'wo-' + w.id, target: 'org-' + oid, type: 'engaged' }, classes: 'e-washop' });
      }
    });
    (w.contactIds || []).forEach(cid => {
      if (DB.state.contacts.find(x => x.id === cid)) {
        elements.push({ data: { id: 'e-wo-' + w.id + '-con-' + cid, source: 'wo-' + w.id, target: 'con-' + cid, type: 'attended' }, classes: 'e-washop' });
      }
    });
  });

  return elements;
}

// Cytoscape stylesheet — resolved to hex values at build time for portability.
function buildGraphStylesheet() {
  return [
    // ----- Nodes -----
    {
      selector: 'node',
      style: {
        'background-color': (ele) => {
          const v = ele.data('fillVar');
          return v ? cssVar(v) : '#888';
        },
        'label': 'data(label)',
        'color': cssVar('--text'),
        'font-size': '10px',
        'font-family': cssVar('--font-sans') || 'system-ui, sans-serif',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'ellipsis',
        'text-max-width': '140px',
        'text-outline-width': 2,
        'text-outline-color': cssVar('--bg'),
        'border-width': 1,
        'border-color': cssVar('--border'),
      },
    },
    // Orgs — rounded rectangles, bigger
    {
      selector: 'node.n-org',
      style: {
        'shape': 'round-rectangle',
        'width': 'mapData(priority, 0, 1, 46, 62)',
        'height': 'mapData(priority, 0, 1, 26, 32)',
        'font-size': '11px',
      },
    },
    {
      selector: 'node.n-priority',
      style: {
        'border-width': 3,
        'border-color': cssVar('--priority'),
        'border-opacity': 0.9,
      },
    },
    // Contacts — circles
    {
      selector: 'node.n-contact',
      style: {
        'shape': 'ellipse',
        'width': 18, 'height': 18,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'font-size': '9px',
        'text-max-width': '110px',
      },
    },
    {
      selector: 'node.n-champion',
      style: {
        'width': 24, 'height': 24,
        'border-width': 2,
        'border-color': cssVar('--priority'),
      },
    },
    // Solicitations — diamonds
    {
      selector: 'node.n-sol',
      style: {
        'shape': 'diamond',
        'width': 22, 'height': 22,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'font-size': '9px',
      },
    },
    // Letters — triangles
    {
      selector: 'node.n-letter',
      style: {
        'shape': 'triangle',
        'width': 22, 'height': 22,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'font-size': '9px',
      },
    },
    // WashOps — tiny dots, minimal
    {
      selector: 'node.n-washop',
      style: {
        'shape': 'ellipse',
        'width': 10, 'height': 10,
        'label': '',
        'border-width': 0,
        'opacity': 0.7,
      },
    },
    // ----- Edges -----
    {
      selector: 'edge',
      style: {
        'width': 1,
        'line-color': cssVar('--border-strong'),
        'curve-style': 'bezier',
        'opacity': 0.55,
        'target-arrow-shape': 'none',
      },
    },
    { selector: 'edge.e-works',     style: { 'line-color': cssVar('--text-dim'), 'width': 1 } },
    { selector: 'edge.e-issued',    style: { 'line-color': cssVar('--accent'),   'width': 1.5 } },
    { selector: 'edge.e-contact',   style: { 'line-color': cssVar('--text-dim'), 'line-style': 'dashed', 'width': 1 } },
    { selector: 'edge.e-awarded',   style: { 'line-color': cssVar('--accent'),   'width': 2 } },
    { selector: 'edge.e-from-sol',  style: { 'line-color': cssVar('--accent'),   'line-style': 'dashed', 'width': 1.5 } },
    { selector: 'edge.e-targets',   style: { 'line-color': cssVar('--army'),     'width': 1.5 } },
    { selector: 'edge.e-signer',    style: { 'line-color': cssVar('--army'),     'line-style': 'dashed', 'width': 1 } },
    { selector: 'edge.e-washop',    style: { 'line-color': cssVar('--text-dim'), 'line-style': 'dotted', 'width': 1, 'opacity': 0.4 } },
    // ----- Highlighted (hover / focus) -----
    {
      selector: '.highlighted',
      style: {
        'border-width': 3,
        'border-color': cssVar('--priority'),
        'z-index': 999,
      },
    },
    {
      selector: 'edge.highlighted',
      style: {
        'line-color': cssVar('--priority'),
        'opacity': 1,
        'width': 2,
      },
    },
    {
      selector: '.faded',
      style: { 'opacity': 0.1, 'text-opacity': 0.1 },
    },
  ];
}

// Choose layout config based on the dropdown value.
function graphLayoutConfig(name) {
  if (name === 'cose') {
    return {
      name: 'cose',
      animate: false,
      randomize: true,
      // Very strong org-to-org repulsion — creates generous white space
      // between hubs so each org's leaf cluster has room to breathe.
      nodeRepulsion: (n) => {
        const t = n.data('type');
        if (t === 'org') return 2000000;         // hubs push each other hard
        if (t === 'letter' || t === 'sol') return 150000;
        return 80000;                             // contacts, washops
      },
      // Longer edges: org-to-org acts as a tether (keeps graph bounded),
      // org-to-leaf is long enough that leaves don't crowd the parent.
      idealEdgeLength: (e) => {
        const srcType = e.source().data('type');
        const tgtType = e.target().data('type');
        if (srcType === 'org' && tgtType === 'org') return 500;
        // Leaves further from parent = more arc length for siblings to spread
        return 110;
      },
      edgeElasticity: 80,
      nestingFactor: 1.2,
      gravity: 0.08,                              // weak gravity = more spread
      numIter: 2500,                              // more iterations for larger layout
      initialTemp: 300,
      coolingFactor: 0.97,
      minTemp: 1.0,
      fit: true,
      padding: 50,
      nodeDimensionsIncludeLabels: false,
    };
  }
  if (name === 'breadthfirst') {
    return { name: 'breadthfirst', directed: false, padding: 40, spacingFactor: 1.3, fit: true, animate: false };
  }
  // concentric — tier-based rings for ORGS only. Leaf nodes (contacts,
  // sols, letters, contracts, washops) are positioned in a cluster-around-
  // parent pass AFTER the concentric layout runs (see postLayoutClusterLeaves).
  return {
    name: 'concentric',
    concentric: (n) => {
      // Only orgs participate in the tier rings
      const tier = n.data('tier');
      const map = { '1': 6, '2a': 5, '2b': 4, '3': 3, '4': 2, '5': 1 };
      return map[tier] || 0;
    },
    levelWidth: () => 1,
    minNodeSpacing: 45,
    spacingFactor: 0.9,
    padding: 40,
    fit: true,
    animate: false,
    avoidOverlap: true,
    // Pre-filter: only consider orgs for ring placement. Leaf nodes get
    // placed in the post-pass; we hide them from concentric's calculations
    // by giving them a preset position we'll override.
  };
}

// Place orgs on tier-based concentric rings. Radii are computed
// dynamically from the actual leaf density per tier so crowded tiers get
// more radial room than sparse ones. Also keeps runs of many orgs on the
// same tier from overlapping tangentially.
function runConcentricOrgRings(cy) {
  const orgs = cy.nodes('node.n-org');
  if (orgs.empty()) return;

  const tierOrder = ['1','2a','2b','3','4','5'];
  const groups = {};
  tierOrder.forEach(t => groups[t] = []);
  const noTier = [];
  orgs.forEach(o => {
    const t = o.data('tier');
    if (tierOrder.includes(t)) groups[t].push(o);
    else noTier.push(o);
  });

  // For each tier, estimate the "leaf halo depth" — the max radial reach
  // of any org's leaf cluster on that tier. We use max(leafCount) in the
  // tier since all orgs share the same ring.
  // Leaf halo reaches ~baseRadius + (numRings-1)*ringSpacing ≈ 60 + ringsNeeded*65.
  function haloDepth(tierOrgs) {
    if (!tierOrgs.length) return 0;
    let maxLeaves = 0;
    tierOrgs.forEach(o => {
      const n = o.connectedEdges().connectedNodes().difference(o).length;
      if (n > maxLeaves) maxLeaves = n;
    });
    // Approximate: first ring holds ~4 nodes, each outer ring ~8–12.
    // ringsNeeded ≈ 1 + ceil((maxLeaves - 4) / 10) for long-labeled nodes.
    const ringsNeeded = Math.max(1, 1 + Math.ceil(Math.max(0, maxLeaves - 4) / 10));
    // ~65px per ring after the base, plus 60px base = halo depth
    return 60 + ringsNeeded * 65;
  }

  // Also: two adjacent orgs on the same ring need enough tangential space
  // that their halos don't touch. Required angular step per org =
  //   2 * asin((haloDepth + padding) / R)
  // We'll pick R per tier to satisfy both (a) radial clearance to next tier
  // and (b) tangential clearance to neighbors.
  function tierTangentialMinRadius(tierOrgs, halo) {
    const n = tierOrgs.length;
    if (n <= 1) return 200;
    // Angular step = 2π / n; required chord between org centers = 2 * halo + 60
    // chord = 2R sin(π/n) → R = (2 * halo + 60) / (2 sin(π/n))
    return (2 * halo + 60) / (2 * Math.sin(Math.PI / n));
  }

  // Build radii cumulatively: each tier starts after the previous tier's
  // outer halo, and has enough radius of its own to fit its orgs tangentially.
  const tierRadii = {};
  let previousOuterEdge = 0;
  tierOrder.forEach(t => {
    const tierOrgs = groups[t];
    const halo = haloDepth(tierOrgs);
    const minRadialR = previousOuterEdge + halo + 100;  // gap from previous tier
    const minTangentialR = tierTangentialMinRadius(tierOrgs, halo);
    const R = Math.max(minRadialR, minTangentialR, 200);
    tierRadii[t] = R;
    previousOuterEdge = R + halo;
  });

  const noTierHalo = haloDepth(noTier);
  const noTierMinR = previousOuterEdge + noTierHalo + 100;
  const noTierMinTangR = tierTangentialMinRadius(noTier, noTierHalo);
  const noTierRadius = Math.max(noTierMinR, noTierMinTangR, 200);

  tierOrder.forEach(t => {
    const ring = groups[t];
    if (!ring.length) return;
    const r = tierRadii[t];
    const step = (2 * Math.PI) / ring.length;
    ring.sort((a, b) => (a.data('label')||'').localeCompare(b.data('label')||''));
    ring.forEach((node, i) => {
      const angle = i * step - Math.PI / 2;
      node.position({ x: r * Math.cos(angle), y: r * Math.sin(angle) });
    });
  });

  if (noTier.length) {
    const step = (2 * Math.PI) / noTier.length;
    noTier.sort((a, b) => (a.data('label')||'').localeCompare(b.data('label')||''));
    noTier.forEach((node, i) => {
      const angle = i * step - Math.PI / 2;
      node.position({ x: noTierRadius * Math.cos(angle), y: noTierRadius * Math.sin(angle) });
    });
  }
}


// tightly around their "parent" org. Leaf nodes connected to multiple orgs
// are placed at the centroid of their parents.
function postLayoutClusterLeaves(cy) {
  const orgs = cy.nodes('node.n-org');
  if (orgs.empty()) return;

  // Graph centroid — used for outward orientation
  const center = { x: 0, y: 0 };
  orgs.forEach(o => { const p = o.position(); center.x += p.x; center.y += p.y; });
  center.x /= orgs.length; center.y /= orgs.length;

  // Group leaves by parent org. A leaf with multiple parents is assigned
  // to its most-connected parent (deterministic by id as tiebreaker) so it
  // has a single layout anchor — visual edges still show the other links.
  const leaves = cy.nodes().filter(n => n.data('type') !== 'org');
  const leavesByParent = new Map();
  const orphans = [];

  leaves.forEach(leaf => {
    const parents = leaf.connectedEdges().connectedNodes('node.n-org').difference(leaf);
    if (parents.empty()) { orphans.push(leaf); return; }
    let chosen = null, bestDegree = -1;
    parents.forEach(p => {
      const deg = p.degree();
      if (deg > bestDegree || (deg === bestDegree && (chosen === null || p.id() < chosen.id()))) {
        chosen = p; bestDegree = deg;
      }
    });
    const pid = chosen.id();
    if (!leavesByParent.has(pid)) leavesByParent.set(pid, []);
    leavesByParent.get(pid).push(leaf);
  });

  // Half-width needed around each leaf to avoid *visible* overlap — this is
  // driven by the label's pixel width, not the node's dot radius, because
  // labels are what you see colliding. At 10–11px font with the app's sans
  // stack, ~6.2px per char is a safe estimate; we clamp to the node size
  // at minimum so nodes without labels still get dot-sized spacing.
  function leafHalfWidth(leaf) {
    const t = leaf.data('type');
    // Dot half-widths (minimum)
    const dotR = (t === 'contact') ? (leaf.hasClass('n-champion') ? 12 : 9)
               : (t === 'sol')     ? 11
               : (t === 'letter')  ? 11
               : (t === 'washop')  ? 5
               :                     10;
    // Label half-width
    const label = leaf.data('label') || '';
    // WashOps don't render a label (style has label: '')
    if (t === 'washop') return dotR;
    const charPx = 6.2;
    const labelHalf = (label.length * charPx) / 2;
    // Add small padding so adjacent labels have a gap
    return Math.max(dotR, labelHalf) + 4;
  }

  // Place each group in a sequence of arcs around its parent org. Each ring
  // has as many slots as fit without collision given the nodes' radii plus
  // padding. Spacing is computed so adjacent nodes on the same ring never
  // overlap — this is the key fix vs. the previous fixed-capacity approach.
  leavesByParent.forEach((group, pid) => {
    const parent = cy.getElementById(pid);
    if (!parent.length) return;
    const pp = parent.position();

    // Outward unit vector from graph center → parent org
    let dx = pp.x - center.x, dy = pp.y - center.y;
    let mag = Math.sqrt(dx*dx + dy*dy);
    if (mag < 1) { dx = 1; dy = 0; mag = 1; }
    const ux = dx / mag, uy = dy / mag;

    // Type order: letters, contracts, sols, contacts, washops
    const typeOrder = { letter: 0, sol: 1, contact: 2, washop: 3 };
    group.sort((a, b) => {
      const ta = typeOrder[a.data('type')] ?? 5;
      const tb = typeOrder[b.data('type')] ?? 5;
      if (ta !== tb) return ta - tb;
      return a.id().localeCompare(b.id());
    });

    // Pack into rings. Each ring starts at baseRadius + ring*ringSpacing.
    // For each ring, compute how many nodes can fit given:
    //   * arc span (we use up to a full 300° arc for the last ring, with
    //     inner rings narrower so they don't crowd the parent's sides)
    //   * required angular step = 2 * asin((nodeRadius + padding) / radius)
    //
    // We pre-compute a ring plan (list of arrays of node indices) then
    // position each node on its ring.
    const paddingBetween = 6;
    const baseRadius = 60;
    const ringSpacingMin = 60;  // minimum vertical room between rings (dot + label + gap)

    // Arc widths (half-angle from outward axis) per ring: first ring is
    // narrower (110°), expands as we go out, caps at 170° (340° total span).
    function ringHalfAngle(ringIdx) {
      const base = 55;
      const growth = 15;
      const deg = Math.min(170, base + ringIdx * growth);
      return deg * Math.PI / 180;
    }

    // Figure out the widest leaf in this group (by label width) to set
    // ring spacing conservatively so labels don't stack vertically.
    let maxLeafHW = 0;
    group.forEach(l => { maxLeafHW = Math.max(maxLeafHW, leafHalfWidth(l)); });
    // Ring radial spacing must cover: dot diameter + label height + gap.
    // Label height ≈ 14px; we use max(60, 2×leafHalfWidth + 14) but cap so
    // even very long labels don't push rings apart absurdly — clamped to 80.
    const actualRingSpacing = Math.min(80, Math.max(ringSpacingMin, maxLeafHW * 2 * 0.35 + 50));

    // Assign each node to a ring
    const ringAssignments = [];
    const ringMembers = [];
    let ring = 0;

    function ringCapacity(ringIdx, nodesPlanned) {
      // Each adjacent pair on the ring needs an angular step wide enough to
      // fit both nodes' half-widths (labels) plus padding. Use the worst
      // pair (widest two nodes in the ring) as the conservative chord.
      const R = baseRadius + ringIdx * actualRingSpacing;
      if (nodesPlanned.length === 0) return 99;
      // Sort half-widths descending to find the two widest
      const widths = nodesPlanned.map(idx => leafHalfWidth(group[idx])).sort((a,b) => b - a);
      const maxHW = widths[0];
      const secondHW = widths.length > 1 ? widths[1] : widths[0];
      // Required chord for worst adjacent pair = maxHW + secondHW + padding
      const minChord = maxHW + secondHW + paddingBetween;
      // Chord = 2R sin(halfStep) → halfStep = asin(minChord/(2R))
      const halfStep = Math.asin(Math.min(1, minChord / (2 * R)));
      const arc = 2 * ringHalfAngle(ringIdx);
      const gaps = Math.floor(arc / (2 * halfStep));
      return Math.max(1, gaps + 1);
    }

    // Greedy ring packing
    for (let i = 0; i < group.length; i++) {
      if (!ringMembers[ring]) ringMembers[ring] = [];
      ringMembers[ring].push(i);
      const cap = ringCapacity(ring, ringMembers[ring]);
      if (ringMembers[ring].length > cap) {
        ringMembers[ring].pop();
        ring++;
        if (!ringMembers[ring]) ringMembers[ring] = [];
        ringMembers[ring].push(i);
      }
      ringAssignments[i] = ring;
    }

    // Position each node on its ring, evenly distributed across that
    // ring's arc.
    ringMembers.forEach((members, ringIdx) => {
      const R = baseRadius + ringIdx * actualRingSpacing;
      const halfAngle = ringHalfAngle(ringIdx);
      const n = members.length;

      members.forEach((nodeIdx, j) => {
        let angle;
        if (n === 1) angle = 0;
        else angle = -halfAngle + (j / (n - 1)) * (2 * halfAngle);

        const cos = Math.cos(angle), sin = Math.sin(angle);
        const rx = ux * cos - uy * sin;
        const ry = ux * sin + uy * cos;

        const leaf = group[nodeIdx];
        leaf.position({ x: pp.x + rx * R, y: pp.y + ry * R });
      });
    });
  });

  // Orphan leaves (no parent org): grid them off to the side below the graph
  if (orphans.length) {
    const cols = Math.ceil(Math.sqrt(orphans.length));
    const cellSize = 34;
    let maxY = 0;
    orgs.forEach(o => { maxY = Math.max(maxY, o.position().y); });
    const startY = maxY + 220;
    const startX = -((cols - 1) * cellSize) / 2;
    orphans.forEach((leaf, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      leaf.position({ x: startX + c * cellSize, y: startY + r * cellSize });
    });
  }
}

function gvisibleTypes() {
  const set = new Set();
  document.querySelectorAll('.graph-toolbar .graph-filter-group input[data-gtype]').forEach(cb => {
    if (cb.checked) set.add(cb.dataset.gtype);
  });
  return set;
}

// Apply all active toolbar filters to the live Cytoscape instance.
function applyGraphFilters() {
  const cy = GRAPH.cy;
  if (!cy) return;
  const types = gvisibleTypes();
  const tier = document.getElementById('graphTierFilter').value;
  const priOnly = document.getElementById('graphPriorityOnly').checked;
  const q = (document.getElementById('graphSearch').value || '').trim().toLowerCase();

  cy.batch(() => {
    cy.nodes().forEach(n => {
      const t = n.data('type');
      let keep = types.has(t);
      if (keep && tier && t === 'org' && n.data('tier') !== tier) keep = false;
      if (keep && priOnly) {
        if (t === 'org' && !n.data('priority')) keep = false;
        if (t !== 'org') {
          const hasPri = n.neighborhood('node.n-priority').nonempty();
          if (!hasPri) keep = false;
        }
      }
      if (keep && q) {
        const hay = ((n.data('label')||'') + ' ' + (n.data('fullName')||'') + ' ' + (n.data('fullLabel')||'') + ' ' + (n.data('title')||'') + ' ' + (n.data('service')||'')).toLowerCase();
        if (!hay.includes(q)) keep = false;
      }
      // Remember filter intent so zoom-hiding doesn't fight with it
      n.data('_filterHidden', !keep);
    });
  });
  // Re-evaluate visibility (toolbar + zoom both contribute)
  applyCombinedVisibility();
}

// Combine toolbar filter state (_filterHidden) with zoom-density rules
// to set final display on each node/edge.
function applyCombinedVisibility() {
  const cy = GRAPH.cy;
  if (!cy) return;
  const z = cy.zoom();
  const densityToggle = document.getElementById('graphDensityHide');
  const densityEnabled = densityToggle ? densityToggle.checked : true;
  const hideDensity = densityEnabled && (z < 0.5) && !GRAPH.focusedId;

  cy.batch(() => {
    cy.nodes().forEach(n => {
      const filterHidden = n.data('_filterHidden');
      const t = n.data('type');
      const densityHide = hideDensity && (t === 'contact' || t === 'washop');
      n.style('display', (filterHidden || densityHide) ? 'none' : 'element');
    });
    cy.edges().forEach(e => {
      const visible = e.source().style('display') !== 'none' && e.target().style('display') !== 'none';
      e.style('display', visible ? 'element' : 'none');
    });
  });

  const nCount = cy.nodes().filter(n => n.style('display') !== 'none').length;
  const eCount = cy.edges().filter(e => e.style('display') !== 'none').length;
  const cnt = document.getElementById('graphCount');
  if (cnt) cnt.textContent = nCount + ' nodes · ' + eCount + ' edges';
}

// Focus on a node's 1-hop neighborhood (dim everything else).
function focusNeighborhood(nodeOrId) {
  const cy = GRAPH.cy;
  if (!cy) return;
  const node = (typeof nodeOrId === 'string') ? cy.getElementById(nodeOrId) : nodeOrId;
  if (!node || !node.length) return;
  GRAPH.focusedId = node.id();
  const neighborhood = node.closedNeighborhood();
  // Reveal any density-hidden nodes in the focused neighborhood
  neighborhood.forEach(el => { el.style('display', 'element'); });
  cy.elements().addClass('faded');
  neighborhood.removeClass('faded');
  node.addClass('highlighted');
  cy.animate({ fit: { eles: neighborhood, padding: 80 }, duration: 400 });
}

function clearGraphFocus() {
  const cy = GRAPH.cy;
  if (!cy) return;
  GRAPH.focusedId = null;
  cy.elements().removeClass('faded highlighted');
  // Re-apply zoom-based density hiding now that focus is cleared
  applyCombinedVisibility();
  cy.animate({ fit: { padding: 40 }, duration: 300 });
}

// Open a graph node's corresponding detail panel / edit modal.
function openGraphNodeDetail(node) {
  const t = node.data('type');
  if (t === 'org') {
    const cardId = node.data('dashboardCardId') || node.data('officeId');
    const card = document.getElementById(cardId);
    if (card) {
      // Panel wants a dashboard card element
      if (typeof openDetailPanel === 'function') openDetailPanel(card);
      return;
    }
    // Fallback: jump to Orgs tab and edit
    activateTab('offices');
    if (typeof editOffice === 'function') editOffice(node.data('officeId'));
    return;
  }
  if (t === 'contact')  { activateTab('contacts');      if (typeof editContact === 'function') editContact(node.data('contactId')); return; }
  if (t === 'sol')      { activateTab('solicitations'); if (typeof editSol === 'function') editSol(node.data('solId')); return; }
  if (t === 'letter')   { activateTab('letters');       if (typeof editLet === 'function') editLet(node.data('letterId')); return; }
  if (t === 'washop')   { activateTab('washops');       if (typeof editWo === 'function') editWo(node.data('washopId')); return; }
}

// Build (or rebuild) the Cytoscape instance with fresh data.
function renderGraph() {
  const container = document.getElementById('graphCanvas');
  if (!container) return;
  if (typeof cytoscape === 'undefined') {
    container.innerHTML = '<div style="padding:2rem;color:var(--text-muted);font-size:12px;">Loading graph library…</div>';
    setTimeout(renderGraph, 300);
    return;
  }

  const elements = buildGraphData();
  const layoutName = document.getElementById('graphLayoutSelect').value || 'concentric';

  // Destroy any prior instance so theme / data changes take effect
  if (GRAPH.cy) { try { GRAPH.cy.destroy(); } catch(e){} GRAPH.cy = null; }
  container.innerHTML = '';

  // For concentric mode, we layout orgs manually (rings) and cluster leaves
  // around them in a single pass — avoids the built-in layout trying to
  // place 400+ leaf nodes on the same ring, which wrecks the radius.
  const initialLayout = (layoutName === 'concentric')
    ? { name: 'preset' }       // positions will be set programmatically
    : graphLayoutConfig(layoutName);

  GRAPH.cy = cytoscape({
    container,
    elements,
    style: buildGraphStylesheet(),
    layout: initialLayout,
    wheelSensitivity: 0.25,
    minZoom: 0.05,
    maxZoom: 2.5,
    hideEdgesOnViewport: elements.length > 600,
    textureOnViewport: elements.length > 800,
  });

  const cy = GRAPH.cy;

  if (layoutName === 'concentric') {
    runConcentricOrgRings(cy);
    postLayoutClusterLeaves(cy);
    cy.fit(undefined, 40);
  }

  // ---- Zoom-based density management ----
  // At low zoom, hide contacts + washops (the most numerous node types).
  // At higher zoom, reveal them. See applyCombinedVisibility() for the rule.
  let _zoomRaf = null;
  cy.on('zoom', () => {
    if (_zoomRaf) return;
    _zoomRaf = requestAnimationFrame(() => {
      _zoomRaf = null;
      applyCombinedVisibility();
    });
  });
  // Seed the filter state from the current toolbar settings (WashOps are
  // unchecked by default, so they must be flagged _filterHidden from the start)
  applyGraphFilters();

  // Click → open detail
  cy.on('tap', 'node', (evt) => {
    openGraphNodeDetail(evt.target);
  });

  // Hover → highlight neighborhood (unless focused mode active).
  // Also temporarily reveal any density-hidden nodes in that neighborhood,
  // so hovering an org always shows its full 1-hop reach even at low zoom.
  let _hoverRevealed = null;
  cy.on('mouseover', 'node', (evt) => {
    if (GRAPH.focusedId) return;
    const n = evt.target;
    const hood = n.closedNeighborhood();
    // Track what we had to reveal so we can hide it again on mouseout
    _hoverRevealed = hood.filter(el => el.style('display') === 'none' && !el.data('_filterHidden'));
    _hoverRevealed.forEach(el => { el.style('display', 'element'); });
    cy.elements().addClass('faded');
    hood.removeClass('faded');
    n.addClass('highlighted');
    n.connectedEdges().addClass('highlighted');
  });
  cy.on('mouseout', 'node', () => {
    if (GRAPH.focusedId) return;
    cy.elements().removeClass('faded highlighted');
    if (_hoverRevealed) {
      _hoverRevealed.forEach(el => { el.style('display', 'none'); });
      _hoverRevealed = null;
    }
  });

  // Double-click → focus neighborhood permanently (until cleared)
  cy.on('dbltap', 'node', (evt) => { focusNeighborhood(evt.target); });

  // Clicking empty space clears focus
  cy.on('tap', (evt) => { if (evt.target === cy) clearGraphFocus(); });

  GRAPH.built = true;
  applyGraphFilters();
}

// Toolbar wiring (bound once)
(function wireGraphToolbar() {
  function onReady() {
    const search = document.getElementById('graphSearch');
    if (!search) return; // tab markup not present
    document.querySelectorAll('.graph-toolbar input[data-gtype]').forEach(cb => {
      cb.addEventListener('change', applyGraphFilters);
    });
    document.getElementById('graphTierFilter').addEventListener('change', applyGraphFilters);
    document.getElementById('graphPriorityOnly').addEventListener('change', applyGraphFilters);
    const densityHideBox = document.getElementById('graphDensityHide');
    if (densityHideBox) densityHideBox.addEventListener('change', () => applyCombinedVisibility());
    search.addEventListener('input', applyGraphFilters);
    document.getElementById('graphLayoutSelect').addEventListener('change', () => {
      if (!GRAPH.cy) return;
      const name = document.getElementById('graphLayoutSelect').value;
      if (name === 'concentric') {
        runConcentricOrgRings(GRAPH.cy);
        postLayoutClusterLeaves(GRAPH.cy);
        GRAPH.cy.animate({ fit: { padding: 40 }, duration: 300 });
      } else {
        GRAPH.cy.layout(graphLayoutConfig(name)).run();
      }
    });
    document.getElementById('graphFit').addEventListener('click', () => {
      if (GRAPH.cy) GRAPH.cy.animate({ fit: { padding: 40 }, duration: 300 });
    });
    document.getElementById('graphFocus').addEventListener('click', () => {
      if (!GRAPH.cy) return;
      const sel = GRAPH.cy.$('node:selected');
      if (sel.nonempty()) { focusNeighborhood(sel.first()); return; }
      // No selection — use the first highlighted node, if any
      const hi = GRAPH.cy.$('node.highlighted');
      if (hi.nonempty()) focusNeighborhood(hi.first());
    });
    document.getElementById('graphReset').addEventListener('click', clearGraphFocus);

    // Keyboard shortcuts within the graph tab
    document.addEventListener('keydown', (e) => {
      const panel = document.getElementById('tab-graph');
      if (!panel || !panel.classList.contains('active')) return;
      if (e.target.matches('input, textarea, select')) return;
      if (document.getElementById('modalBackdrop').classList.contains('open')) return;
      const k = e.key.toLowerCase();
      if (k === 'f') { if (GRAPH.cy) GRAPH.cy.animate({ fit: { padding: 40 }, duration: 300 }); e.preventDefault(); }
      else if (k === 'n') {
        if (!GRAPH.cy) return;
        const sel = GRAPH.cy.$('node:selected, node.highlighted');
        if (sel.nonempty()) { focusNeighborhood(sel.first()); e.preventDefault(); }
      }
      else if (k === 'escape') { clearGraphFocus(); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();
})();

// Re-render graph on theme toggle (colors are resolved from CSS vars at build time)
document.addEventListener('waypoint:themechange', () => {
  if (GRAPH.built && document.getElementById('tab-graph').classList.contains('active')) {
    renderGraph();
  } else {
    // Invalidate; next tab activation rebuilds
    GRAPH.built = false;
    if (GRAPH.cy) { try { GRAPH.cy.destroy(); } catch(e){} GRAPH.cy = null; }
  }
});

// =================================================================
// =================================================================
window.GRAPH = GRAPH;
window.renderGraph = renderGraph;

// jump-to-parent code at index.html:27645 (typeof-guarded, so it has
// silently no-op'd since v183). Re-expose so the feature works.
window.focusNeighborhood = focusNeighborhood;
