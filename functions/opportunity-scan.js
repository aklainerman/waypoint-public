// Netlify Function: opportunity-scan
//
// Scheduled (Mon + Wed 9 AM UTC) AND manual POST trigger.
//
// Scans SBIR.gov and SAM.gov for open opportunities matching the company's
// tech profile (HE DE lasers, SDA, power beaming, emergency comms) from
// target agencies (DoD, NASA, DARPA, NRO, Space Force, AFRL, MDA).
//
// Deduplicates against existing solicitations by external URL.
// Inserts new matches into the `solicitations` table with status='Identified'
// and source='auto-scan'.
//
// AWS-portable: no Netlify-specific APIs used in core logic. Swap the
// exported handler for a Lambda handler when migrating to AWS.
//
// Required env vars (same Supabase vars used by scout):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  (preferred) or SUPABASE_ANON_KEY
// Optional:
//   SAM_GOV_API_KEY            (for SAM.gov leg; without it only SBIR.gov runs)
//   WAYPOINT_ENV               set to "demo" to disable in demo environment

// ---------------------------------------------------------------------------
// Tech profile — keywords per topic area
// ---------------------------------------------------------------------------
const TECH_PROFILE = [
  {
    label: 'HE DE Lasers',
    keywords: [
      'high energy laser', 'high-energy laser', 'HEL', 'directed energy',
      'laser weapon', 'laser lethality', 'beam control', 'laser system',
      'high power laser', 'kilowatt laser', 'megawatt laser', 'DEW',
      'directed energy weapon',
    ],
  },
  {
    label: 'SDA',
    keywords: [
      'space domain awareness', 'SDA', 'space situational awareness', 'SSA',
      'space object tracking', 'space surveillance', 'debris tracking',
      'conjunction assessment', 'resident space object', 'RSO',
      'space traffic management', 'STM', 'space fence',
    ],
  },
  {
    label: 'Power Beaming',
    keywords: [
      'power beaming', 'wireless power transmission', 'laser power beaming',
      'energy beaming', 'beamed energy', 'space solar power',
      'microwave power transmission', 'wireless energy transfer',
      'power-beaming', 'in-space power',
    ],
  },
  {
    label: 'Emergency Comms',
    keywords: [
      'emergency communications', 'emergency comms', 'resilient communications',
      'contested communications', 'denied communications', 'PACE plan',
      'survivable communications', 'backup communications',
      'tactical satellite', 'SATCOM on the move', 'LEO communications',
      'low earth orbit communications', 'mesh communications',
    ],
  },
];

const TARGET_AGENCIES = [
  'DOD', 'DOD/AF', 'DOD/ARMY', 'DOD/DARPA', 'DOD/MDA', 'DOD/NRO',
  'DOD/NAVY', 'DOD/SOCOM', 'DOD/OSD', 'DOD/DIA',
  'NASA',
  'NRO', 'DARPA', 'AFRL', 'MDA', 'Space Force', 'USSF',
];

// SBIR.gov abbreviations for agency filter
const SBIR_AGENCY_CODES = ['DOD', 'NASA'];

// SAM.gov agency names to search
const SAM_AGENCIES = [
  'Department of Defense',
  'National Aeronautics and Space Administration',
  'Defense Advanced Research Projects Agency',
];

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------
function supaConfig() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
           || process.env.SUPABASE_ANON_KEY
           || process.env.SUPABASE_KEY
           || '';
  if (!url || !key) throw new Error('Supabase env vars not set');
  return { url, key };
}

async function supaRequest(method, path, body, opts = {}) {
  const { url, key } = supaConfig();
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  if (opts.prefer) headers.Prefer = opts.prefer;
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const supa = {
  select: (table, qs) => supaRequest('GET', `${table}?${qs}`),
  insert: (table, row) => supaRequest('POST', table, row, { prefer: 'return=representation' }),
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------
function scoreOpportunity(title, abstract) {
  const haystack = ((title || '') + ' ' + (abstract || '')).toLowerCase();
  const matched = [];
  for (const topic of TECH_PROFILE) {
    for (const kw of topic.keywords) {
      if (haystack.includes(kw.toLowerCase())) {
        if (!matched.find(t => t.label === topic.label)) matched.push(topic);
        break;
      }
    }
  }
  return matched; // array of matched topic objects; empty = no match
}

// ---------------------------------------------------------------------------
// SBIR.gov scan
// ---------------------------------------------------------------------------
async function scanSbirGov() {
  const results = [];
  // SBIR.gov public API — no auth required
  // Searches all open solicitations, filters client-side by topic
  const url = 'https://api.sbir.gov/public/api/solicitations?open=true&rows=200&start=0';
  let data;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
    });
    if (!res.ok) {
      console.warn('SBIR.gov API returned', res.status);
      return [];
    }
    data = await res.json();
  } catch (e) {
    console.warn('SBIR.gov fetch failed:', e.message);
    return [];
  }

  const solicitations = Array.isArray(data) ? data
    : (data && Array.isArray(data.solicitations)) ? data.solicitations
    : (data && Array.isArray(data.results)) ? data.results
    : [];

  for (const s of solicitations) {
    const title    = s.solicitation_title || s.title || '';
    const abstract = s.program_description || s.description || s.abstract || '';
    const agency   = s.agency || s.branch || '';
    const open     = s.open_date || s.solicitation_open_date || '';
    const close    = s.close_date || s.solicitation_close_date || '';
    const link     = s.solicitation_agency_url || s.url
                  || (s.solicitation_number ? `https://www.sbir.gov/solicitations/${s.solicitation_number}` : '');
    const type     = s.program || 'SBIR'; // SBIR / STTR

    // Only consider target agencies
    const agencyUp = (agency || '').toUpperCase();
    const isTarget = SBIR_AGENCY_CODES.some(a => agencyUp.includes(a))
                  || TARGET_AGENCIES.some(a => agencyUp.includes(a.toUpperCase()));
    if (!isTarget && agency) continue;

    const topics = scoreOpportunity(title, abstract);
    if (!topics.length) continue;

    results.push({
      source: 'sbir.gov',
      external_id: s.solicitation_number || s.id || link,
      title,
      agency,
      type,
      open_date: open ? open.slice(0, 10) : null,
      due_date: close ? close.slice(0, 10) : null,
      link,
      topics,
      abstract: abstract.slice(0, 500),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// SAM.gov scan
// ---------------------------------------------------------------------------
async function scanSamGov() {
  if (!process.env.SAM_GOV_API_KEY) return [];
  const results = [];

  // Build date window: last 90 days → today
  const now = new Date();
  const from = new Date(now.getTime() - 90 * 86400000);
  const fmtMdy = d => `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;

  // SAM.gov opportunity types relevant for R&D: BAA (broad agency announcement),
  // SBIR solicitations, Combined Synopsis/Solicitation
  const oppTypes = ['r', 'k', 'o']; // r=Sources Sought, k=Combined, o=Solicitation

  // Search each keyword cluster to avoid missing narrow matches
  const SEARCH_TERMS = [
    'directed energy laser',
    'space domain awareness',
    'power beaming',
    'emergency communications satellite',
    'high energy laser',
    'SBIR space',
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
      const res = await fetch(`https://api.sam.gov/opportunities/v2/search?${params}`, {
        signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
      });
      if (!res.ok) continue;
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
      const agency   = opp.fullParentPathName || opp.organizationName || '';
      const link     = opp.uiLink || `https://sam.gov/opp/${noticeId}/view`;

      const topics = scoreOpportunity(title, abstract);
      if (!topics.length) continue;

      results.push({
        source: 'sam.gov',
        external_id: noticeId,
        title,
        agency,
        type: opp.type || 'Solicitation',
        open_date: opp.postedDate ? opp.postedDate.slice(0, 10) : null,
        due_date: opp.responseDeadLine ? opp.responseDeadLine.slice(0, 10) : null,
        link,
        topics,
        abstract: abstract.slice(0, 500),
        pocs: (opp.pointOfContact || []).map(p => p.email).filter(Boolean),
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Deduplicate + insert into solicitations table
// ---------------------------------------------------------------------------
async function deduplicateAndInsert(opportunities) {
  if (!opportunities.length) return { inserted: 0, skipped: 0 };

  // Fetch existing solicitation links so we can deduplicate
  let existing = [];
  try {
    existing = await supa.select('solicitations', 'select=link,title&limit=1000');
  } catch (e) {
    console.warn('Could not fetch existing solicitations for dedup:', e.message);
  }
  const existingLinks = new Set((existing || []).map(s => (s.link || '').trim()).filter(Boolean));
  const existingTitles = new Set((existing || []).map(s => (s.title || '').trim().toLowerCase()).filter(Boolean));

  let inserted = 0, skipped = 0;
  for (const opp of opportunities) {
    // Deduplicate by link (primary) or exact title (fallback)
    if (opp.link && existingLinks.has(opp.link.trim())) { skipped++; continue; }
    if (existingTitles.has((opp.title || '').trim().toLowerCase())) { skipped++; continue; }

    const topicLabel = opp.topics.map(t => t.label).join(', ');
    const row = {
      title: opp.title,
      status: 'Identified',
      type: opp.type || 'SBIR',
      link: opp.link || null,
      org: opp.agency || null,
      notes: [
        `Source: ${opp.source}`,
        `Topic match: ${topicLabel}`,
        opp.abstract ? `Summary: ${opp.abstract}` : null,
        opp.pocs && opp.pocs.length ? `POC emails: ${opp.pocs.join(', ')}` : null,
      ].filter(Boolean).join('\n'),
      topic: topicLabel,
      open_date: opp.open_date || null,
      due_date: opp.due_date || null,
    };

    try {
      await supa.insert('solicitations', row);
      existingLinks.add(opp.link || '');
      existingTitles.add((opp.title || '').toLowerCase());
      inserted++;
    } catch (e) {
      console.warn('Failed to insert opportunity:', opp.title, e.message);
    }
  }
  return { inserted, skipped };
}

// ---------------------------------------------------------------------------
// Core scan runner (AWS-portable — no Netlify deps)
// ---------------------------------------------------------------------------
async function runScan() {
  const start = Date.now();
  const [sbirResults, samResults] = await Promise.all([
    scanSbirGov(),
    scanSamGov(),
  ]);
  const all = [...sbirResults, ...samResults];
  const { inserted, skipped } = await deduplicateAndInsert(all);
  return {
    scanned: all.length,
    inserted,
    skipped,
    sbir_matches: sbirResults.length,
    sam_matches: samResults.length,
    elapsed_ms: Date.now() - start,
    ran_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Netlify handler — scheduled + manual POST
// ---------------------------------------------------------------------------
exports.handler = async (event) => {
  // Demo guard
  if ((process.env.WAYPOINT_ENV || '').toLowerCase() === 'demo') {
    return { statusCode: 404, body: JSON.stringify({ error: 'not_found' }) };
  }

  const isScheduled = event.httpMethod === undefined || event.httpMethod === null;
  const isPost = event.httpMethod === 'POST';
  const isGet  = event.httpMethod === 'GET';

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  // Only allow POST (manual) or scheduled invocations
  if (!isScheduled && !isPost && !isGet) {
    return { statusCode: 405, body: 'POST or scheduled only' };
  }

  try {
    const result = await runScan();
    console.log('opportunity-scan complete', JSON.stringify(result));
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
