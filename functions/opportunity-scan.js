// Netlify Function: opportunity-scan
//
// Scheduled (Mon + Wed 9 AM UTC) AND manual POST trigger.
//
// Sources:
//   1. DoD SBIR/STTR Innovation Portal (dodsbirsttr.mil) — DoD/DAF/Army/Navy topics
//   2. NASA SBIR portal (sbir.nasa.gov)
//   3. SAM.gov — BAAs and broader solicitations (requires SAM_GOV_API_KEY)
//
// Tech profile: HE DE lasers · SDA · Power beaming · Emergency comms
// Target agencies: DoD (all services), NASA, DARPA, NRO, Space Force, AFRL, MDA
//
// Deduplicates by link/topic-code against existing solicitations table.
// Inserts new matches with status='Identified', source noted in notes field.
//
// AWS-portable: no Netlify-specific APIs in core logic.
//
// Required env vars:
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)
// Optional:
//   SAM_GOV_API_KEY   — enables SAM.gov BAA leg
//   WAYPOINT_ENV      — set "demo" to disable

// ---------------------------------------------------------------------------
// Tech profile
// ---------------------------------------------------------------------------
const TECH_PROFILE = [
  {
    label: 'HE DE Lasers',
    keywords: [
      'high energy laser', 'high-energy laser', 'hel system', 'directed energy',
      'laser weapon', 'laser lethality', 'beam control', 'high power laser',
      'kilowatt laser', 'megawatt laser', 'dew', 'directed energy weapon',
      'laser platform', 'laser engagement', 'laser scaling',
    ],
  },
  {
    label: 'SDA',
    keywords: [
      'space domain awareness', 'space situational awareness', 'ssa',
      'space object tracking', 'space surveillance', 'debris tracking',
      'conjunction assessment', 'resident space object', 'rso',
      'space traffic management', 'space fence', 'space domain',
      'on-orbit tracking', 'satellite tracking',
    ],
  },
  {
    label: 'Power Beaming',
    keywords: [
      'power beaming', 'wireless power transmission', 'laser power beaming',
      'energy beaming', 'beamed energy', 'space solar power',
      'microwave power transmission', 'wireless energy transfer',
      'in-space power', 'power-beaming', 'beamed power',
    ],
  },
  {
    label: 'Emergency Comms',
    keywords: [
      'emergency communications', 'emergency comms', 'resilient communications',
      'contested communications', 'denied communications',
      'survivable communications', 'backup communications',
      'tactical satellite', 'satcom on the move', 'leo communications',
      'low earth orbit communications', 'mesh communications',
      'communications denied', 'comms resilience',
    ],
  },
];

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------
function supaConfig() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
           || process.env.SUPABASE_ANON_KEY
           || process.env.SUPABASE_KEY || '';
  if (!url || !key) throw new Error('Supabase env vars not set');
  return { url, key };
}
async function supaRequest(method, path, body, opts = {}) {
  const { url, key } = supaConfig();
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (opts.prefer) headers.Prefer = opts.prefer;
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const supa = {
  select: (t, qs) => supaRequest('GET', `${t}?${qs}`),
  insert: (t, row) => supaRequest('POST', t, row, { prefer: 'return=representation' }),
};

// ---------------------------------------------------------------------------
// Scoring — returns matched topic labels or empty array (= no match)
// ---------------------------------------------------------------------------
function scoreOpportunity(title, description) {
  const hay = ((title || '') + ' ' + (description || '')).toLowerCase();
  const matched = [];
  for (const topic of TECH_PROFILE) {
    for (const kw of topic.keywords) {
      if (hay.includes(kw.toLowerCase())) {
        if (!matched.find(t => t.label === topic.label)) matched.push(topic);
        break;
      }
    }
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Source 1: DoD SBIR/STTR Innovation Portal
// API: https://www.dodsbirsttr.mil/topics-app/api/public/topics/
// Returns paginated JSON with content[] array
// ---------------------------------------------------------------------------
async function scanDodSbir() {
  const results = [];
  const PAGE_SIZE = 100;
  let page = 0;
  let totalPages = 1;

  // Topic-code prefix check: SDA = 'sda' in title, DE = 'directed energy' etc.
  // We pull all open topics (no keyword filter) and score locally to avoid
  // missing anything due to API keyword mismatch.

  while (page < totalPages && page < 5) { // cap at 500 topics to avoid runaway
    const params = new URLSearchParams({
      page: String(page),
      size: String(PAGE_SIZE),
      // Only open solicitations
      'solicitation.status': 'OPEN',
    });
    let data;
    try {
      const res = await fetch(
        `https://www.dodsbirsttr.mil/topics-app/api/public/topics/?${params}`,
        {
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        }
      );
      if (!res.ok) {
        console.warn('DoD SBIR topics API returned', res.status, 'page', page);
        break;
      }
      data = await res.json();
    } catch (e) {
      console.warn('DoD SBIR topics fetch failed page', page, ':', e.message);
      break;
    }

    const items = data.content || data.topics || (Array.isArray(data) ? data : []);
    totalPages = data.totalPages || 1;

    for (const t of items) {
      const title       = t.title || t.topicTitle || '';
      const description = t.description || t.objective || t.abstract || t.topicDescription || '';
      const topicCode   = t.topicCode || t.code || t.solicitation_number || '';
      const branch      = t.branch || t.agency || t.component || '';
      const program     = t.program || 'SBIR';
      const openDate    = t.openDate || t.open_date || (t.solicitation && t.solicitation.openDate) || '';
      const closeDate   = t.closeDate || t.close_date || (t.solicitation && t.solicitation.closeDate) || '';
      const link        = topicCode
        ? `https://www.dodsbirsttr.mil/topics-app/topic-details/${encodeURIComponent(topicCode)}`
        : '';

      const topics = scoreOpportunity(title, description);
      if (!topics.length) continue;

      results.push({
        source: 'dodsbirsttr.mil',
        external_id: topicCode || link,
        title: topicCode ? `[${topicCode}] ${title}` : title,
        agency: branch || 'DoD',
        type: program,
        open_date: openDate ? String(openDate).slice(0, 10) : null,
        due_date:  closeDate ? String(closeDate).slice(0, 10) : null,
        link,
        topics,
        abstract: description.slice(0, 500),
      });
    }
    page++;
    if (items.length < PAGE_SIZE) break; // last page
  }

  console.log(`DoD SBIR: scanned pages 0-${page}, found ${results.length} matches`);
  return results;
}

// ---------------------------------------------------------------------------
// Source 2: NASA SBIR portal
// API: https://sbir.nasa.gov/solicitations
// ---------------------------------------------------------------------------
async function scanNasaSbir() {
  const results = [];
  let data;
  try {
    const res = await fetch('https://sbir.nasa.gov/api/solicitations?open=true&rows=100', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      // Try alternate endpoint
      const res2 = await fetch('https://sbir.nasa.gov/solicitations.json?status=open', {
        headers: { Accept: 'application/json' },
      });
      if (!res2.ok) {
        console.warn('NASA SBIR API not reachable, status', res.status);
        return [];
      }
      data = await res2.json();
    } else {
      data = await res.json();
    }
  } catch (e) {
    console.warn('NASA SBIR fetch failed:', e.message);
    return [];
  }

  const items = Array.isArray(data) ? data
    : (data && Array.isArray(data.solicitations)) ? data.solicitations
    : (data && Array.isArray(data.results)) ? data.results
    : [];

  for (const s of items) {
    const title    = s.title || s.solicitation_title || '';
    const abstract = s.description || s.abstract || '';
    const code     = s.solicitation_number || s.number || s.id || '';
    const link     = s.url || s.link || (code ? `https://sbir.nasa.gov/solicitations/${code}` : '');

    const topics = scoreOpportunity(title, abstract);
    if (!topics.length) continue;

    results.push({
      source: 'sbir.nasa.gov',
      external_id: String(code || link),
      title: code ? `[${code}] ${title}` : title,
      agency: 'NASA',
      type: s.program || 'SBIR',
      open_date: (s.open_date || s.openDate || '').slice(0, 10) || null,
      due_date:  (s.close_date || s.closeDate || '').slice(0, 10) || null,
      link,
      topics,
      abstract: abstract.slice(0, 500),
    });
  }
  console.log(`NASA SBIR: found ${results.length} matches`);
  return results;
}

// ---------------------------------------------------------------------------
// Source 3: SAM.gov (BAAs + solicitations — requires SAM_GOV_API_KEY)
// ---------------------------------------------------------------------------
async function scanSamGov() {
  if (!process.env.SAM_GOV_API_KEY) {
    console.log('SAM.gov skipped: no SAM_GOV_API_KEY');
    return [];
  }
  const results = [];
  const now  = new Date();
  const from = new Date(now.getTime() - 90 * 86400000);
  const fmtMdy = d => `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;

  const SEARCH_TERMS = [
    'directed energy laser',
    'space domain awareness',
    'power beaming',
    'emergency communications satellite',
    'high energy laser space',
    'SBIR directed energy',
    'SBIR space domain',
  ];

  const seen = new Set();
  for (const term of SEARCH_TERMS) {
    const params = new URLSearchParams({
      api_key: process.env.SAM_GOV_API_KEY,
      q: term,
      postedFrom: fmtMdy(from),
      postedTo: fmtMdy(now),
      limit: '50',
    });
    let data;
    try {
      const res = await fetch(`https://api.sam.gov/opportunities/v2/search?${params}`);
      if (!res.ok) { console.warn('SAM.gov', res.status, 'for term:', term); continue; }
      data = await res.json();
    } catch (e) {
      console.warn('SAM.gov fetch failed for term', term, ':', e.message);
      continue;
    }
    for (const opp of (data.opportunitiesData || [])) {
      const noticeId = opp.noticeId || '';
      if (seen.has(noticeId)) continue;
      seen.add(noticeId);

      const title    = opp.title || '';
      const abstract = opp.description || '';
      const topics   = scoreOpportunity(title, abstract);
      if (!topics.length) continue;

      results.push({
        source: 'sam.gov',
        external_id: noticeId,
        title,
        agency: opp.fullParentPathName || opp.organizationName || 'DoD',
        type: opp.type || 'Solicitation',
        open_date: opp.postedDate ? opp.postedDate.slice(0, 10) : null,
        due_date:  opp.responseDeadLine ? opp.responseDeadLine.slice(0, 10) : null,
        link: opp.uiLink || `https://sam.gov/opp/${noticeId}/view`,
        topics,
        abstract: abstract.slice(0, 500),
        pocs: (opp.pointOfContact || []).map(p => p.email).filter(Boolean),
      });
    }
  }
  console.log(`SAM.gov: found ${results.length} matches`);
  return results;
}

// ---------------------------------------------------------------------------
// Deduplicate + insert into solicitations table
// ---------------------------------------------------------------------------
async function deduplicateAndInsert(opportunities) {
  if (!opportunities.length) return { inserted: 0, skipped: 0 };

  let existing = [];
  try {
    existing = await supa.select('solicitations', 'select=link,title&limit=2000');
  } catch (e) {
    console.warn('Could not fetch existing solicitations:', e.message);
  }
  const existingLinks  = new Set((existing || []).map(s => (s.link  || '').trim()).filter(Boolean));
  const existingTitles = new Set((existing || []).map(s => (s.title || '').trim().toLowerCase()).filter(Boolean));

  let inserted = 0, skipped = 0;
  for (const opp of opportunities) {
    if (opp.link  && existingLinks.has(opp.link.trim()))                  { skipped++; continue; }
    if (existingTitles.has((opp.title || '').trim().toLowerCase()))        { skipped++; continue; }

    const topicLabel = opp.topics.map(t => t.label).join(', ');
    const noteLines = [
      `Source: ${opp.source}`,
      `Topic match: ${topicLabel}`,
      opp.abstract ? `Summary: ${opp.abstract}` : null,
      opp.pocs && opp.pocs.length ? `POC emails: ${opp.pocs.join(', ')}` : null,
    ].filter(Boolean);

    const row = {
      title:     opp.title,
      status:    'Identified',
      type:      opp.type || 'SBIR',
      link:      opp.link || null,
      org:       opp.agency || null,
      notes:     noteLines.join('\n'),
      topic:     topicLabel,
      open_date: opp.open_date || null,
      due_date:  opp.due_date  || null,
    };

    try {
      await supa.insert('solicitations', row);
      existingLinks.add(opp.link || '');
      existingTitles.add((opp.title || '').toLowerCase());
      inserted++;
    } catch (e) {
      console.warn('Insert failed for:', opp.title, e.message);
    }
  }
  return { inserted, skipped };
}

// ---------------------------------------------------------------------------
// Core runner (AWS-portable)
// ---------------------------------------------------------------------------
async function runScan() {
  const start = Date.now();
  const [dodResults, nasaResults, samResults] = await Promise.all([
    scanDodSbir(),
    scanNasaSbir(),
    scanSamGov(),
  ]);
  const all = [...dodResults, ...nasaResults, ...samResults];
  const { inserted, skipped } = await deduplicateAndInsert(all);
  const result = {
    scanned:      all.length,
    inserted,
    skipped,
    dod_matches:  dodResults.length,
    nasa_matches: nasaResults.length,
    sam_matches:  samResults.length,
    elapsed_ms:   Date.now() - start,
    ran_at:       new Date().toISOString(),
  };
  console.log('opportunity-scan complete', JSON.stringify(result));
  return result;
}

// ---------------------------------------------------------------------------
// Netlify handler
// ---------------------------------------------------------------------------
exports.handler = async (event) => {
  if ((process.env.WAYPOINT_ENV || '').toLowerCase() === 'demo') {
    return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  }
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod && event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'POST or scheduled only' };
  }
  try {
    const result = await runScan();
    return {
      statusCode: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (e) {
    console.error('opportunity-scan failed', e);
    return {
      statusCode: 500,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: String(e.message || e) }),
    };
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
