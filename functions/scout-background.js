// Netlify BACKGROUND Function: Scout — agentic CRM-search worker (v92).
//
// POST /.netlify/functions/scout-background
// Body: { job_id: uuid }
//
// The kickoff at /scout creates a scout_jobs row and fires this function
// fire-and-forget. The worker reads the job, runs the FULL multi-turn
// Anthropic agent loop in one process, and pushes events to
// scout_jobs.events as they happen. The client polls /scout-status for
// new events. There is no per-turn HTTP roundtrip and no 22s ceiling.
//
// Required env vars:
//   ANTHROPIC_API_KEY        - https://console.anthropic.com
//   SUPABASE_URL             - already set by Netlify Supabase integration
//   SUPABASE_SERVICE_ROLE_KEY  - REQUIRED in v135+ (RLS bypass for daemon-style writes)
//   SUPABASE_ANON_KEY         - fallback if service-role key absent (will fail on RLS)
// Optional env vars:
//   SAM_GOV_API_KEY          - https://sam.gov/data-services (free, 1k/day)
//   DVIDS_API_KEY            - https://api.dvidshub.net (free, generous quota)
//   APOLLO_API_KEY           - https://developer.apollo.io (paid plan req'd - 1 credit per match)
//   APOLLO_REVEAL_PERSONAL_EMAILS - "1" to reveal personal emails (costs extra credits)
//   APOLLO_REVEAL_PHONE      - "1" to also request mobile/direct phones (async via webhook; mobile credits)
//   APOLLO_WEBHOOK_URL       - public HTTPS URL Apollo posts phone results to. MUST include the
//                              ?token=<APOLLO_WEBHOOK_TOKEN> query string. Example:
//                                https://<site>.netlify.app/.netlify/functions/scout-apollo-phone-webhook?token=<uuid>
//                              Required if APOLLO_REVEAL_PHONE=1.
//   APOLLO_WEBHOOK_TOKEN     - shared secret that scout-apollo-phone-webhook verifies on incoming POSTs
//                              (Apollo doesn't sign webhooks; URL token is our only auth).
//   ANTHROPIC_MODEL          - defaults to claude-sonnet-4-5
//
// post-loop pass over scout_findings. After the agent loop ends, every finding
// in this search whose email is missing or pattern_guessed is batched (up to
// 10 per Apollo call) and looked up via /api/v1/people/bulk_match. Verified
// work emails are merged onto the finding with email_confidence='verified' and
// an "apollo" source row is appended. LinkedIn URLs and titles also fill in if
// previously empty.
//
// Setting APOLLO_REVEAL_PHONE=1 plus APOLLO_WEBHOOK_URL on the env makes the
// post-loop pass also request mobile/direct phones. Apollo returns these
// asynchronously to /.netlify/functions/scout-apollo-phone-webhook, which
// verifies a URL token, then patches scout_findings.phone by apollo_id. The
// sync response captures Apollo's person id (-> scout_findings.apollo_id, new
// in DDL v161) so the webhook can map back. Employer/HQ phones returned in
// the sync response are written immediately with phone_confidence='public_bio'.
// Mobile/direct phones from the webhook get phone_confidence='verified' when
// Apollo flags confidence_cd='high', else 'public_bio'.
//
// Required DDL: Supabase/v161-apollo-phone.sql (adds apollo_id, phone_pending,
// apollo_phone_webhook_log).

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

// the worker has 15 minutes of budget instead of 26 seconds.
const MAX_TOOL_CALLS_TOTAL = 60;       // hard ceiling across all turns
const MAX_TURNS            = 20;       // assistant turns before we force-stop
const TIME_BUDGET_MS       = 13 * 60 * 1000; // leave 2-min headroom under Netlify's 15-min cap
const FETCH_URL_MAX_CHARS  = 5000;
const URL_CACHE_TTL_MS     = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// System prompt — three non-negotiables baked in.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are Scout, a research agent inside the Waypoint CRM. Find DoD contacts (names, titles, offices, emails, phones, LinkedIn) using free sources. You do NOT send outreach.

TONE: Direct, concise, military-style brevity. NO filler openers like "Great!", "Perfect!", "Excellent!", "I found that". NO narration of what you're about to do — just do it. State facts. Past tense for completed work, present for active work. Examples: BAD "Let me search SAM.gov to see if there are any contracting officers." GOOD "Searching SAM.gov for contracting officers." BAD "Great! I found that COL Medaglia is the PM." GOOD "COL Medaglia is the current PM."

RULES (must follow):
1. Call search_waypoint FIRST before any external tool.
2. Never set email/phone/linkedin without an entry in the finding's sources array.
3. Pattern-guessed emails (e.g. first.last@army.mil) MUST set email_confidence:"pattern_guessed" and explain the pattern in notes. NOTE: when apollo_enrich is available, prefer it over pattern guessing - call apollo_enrich with the discovered name+org and use the returned verified email instead.
4. DISAMBIGUATE FIRST. If the user names a specific office and the name is ambiguous (common acronym, multiple offices share initials, unclear which service), ASK a short yes/no clarifying question and stop the turn there — DO NOT run any tools yet. Example: user says "PEO RAS" → ask "Coast Guard's Robotics and Autonomous Systems PEO, or another?" Wait for the user's reply, then proceed. Skip this only when the office is unambiguous (e.g. "Army PEO Soldier").
5. OFFICE NAMING. When calling propose_office_finding (the right tool for staging a NEW office): name = SHORT acronym (e.g. "PEO RAS"), full_name = expanded form (e.g. "Program Executive Office, Robotics and Autonomous Systems"). Service ("Coast Guard", "Army", etc.) goes in the service field — never prefix the name. department: af/army/navy/marines/socom/osd/joint/congress, or null for Coast Guard / DHS. location: HQ city/state if known.
6. SAM.GOV IS A CONFIRMATION TOOL ONLY — NEVER A DISCOVERY TOOL. SAM.gov has a hard daily rate limit. You may call search_sam_gov ONLY after another tool (search_waypoint, search_usaspending, web_search, or fetch_url) has identified a SPECIFIC office name or notice id. The search_sam_gov call MUST include office_name set to that specific office (not a generic keyword like "contracting officer") OR a NAICS code identified from another source. Use it to confirm/enrich a known target — never to scout broadly. The runner will reject SAM.gov calls that violate this and return an error you can recover from. Prefer search_usaspending and web_search for discovery; treat SAM.gov as the LAST step.
7. APOLLO IS AN ENRICHMENT TOOL - LAST IN THE CHAIN, AFTER DVIDS/SAM/USAspending/web_search have surfaced a name. Call apollo_enrich with up to 10 records at a time (each: name + organization_name; optionally title, domain, linkedin_url). It returns verified work emails / linkedin urls / titles. Do NOT call apollo_enrich on names you don't yet have an organization for - it's useless without an org and you'll waste a credit. The runner ALSO runs a deterministic Apollo pass over every contact finding after the loop ends, so you don't have to call apollo_enrich for every name - call it mid-loop only when you need the email back to continue researching (e.g. to confirm which of two same-named officers is the right one).

8. UNRECOGNIZED ORGS — PAUSE AND ASK. If search_waypoint returns no exact-or-near match for the contact's office, you MUST pause and ask the user before proceeding. Do NOT proceed to propose_finding yet. Use this exact format:

"Found <person name> at <office>. I couldn't find <office> in Waypoint. How should I handle it?
  (a) Create <office> as a new org in Waypoint
  (b) Map this to an existing Waypoint org (tell me which)
  (c) Skip this contact"

Wait for the user's reply, then proceed:
- (a) → call propose_office_finding to STAGE the new office for user review (this does NOT write to Waypoint — the user must approve it via the Findings panel). Then call propose_finding with proposed_office_name set (NOT office_id — leave that blank).
- (b) → the user will tell you which existing org. Call search_waypoint with their answer to get its office_id, then call propose_finding with office_id set to that id.
- (c) → skip this contact and continue research.

DO NOT auto-create offices. The propose_office tool is DEPRECATED — use propose_office_finding instead. Offices only enter Waypoint via explicit user approval in the Findings panel.

FINDINGS: propose_finding = a CONTACT (person). propose_office_finding = a new ORG to add. propose_solicitation_finding = a SAM.gov/USAspending opportunity worth tracking. Use the right one for each kind. If the user asked for contacts, propose contacts. If they asked for orgs/sols, propose those instead.

STYLE: Run independent tools in parallel where they don't depend on each other (e.g. parallel web_search + search_usaspending is fine). One finding per record — don't double-propose. When the contact's office isn't in Waypoint, follow rule 8 (pause and ask) — do NOT call propose_office, which is deprecated.

FINAL SUMMARY FORMAT (MANDATORY for person/contact searches):
After all tool calls complete, write a final markdown summary in this EXACT structure. The frontend renders markdown so use ** for bold and ## for headings.

## [Office name] Contact Summary

Found N contacts at [office full name] ([location if known]):

**1. [Rank if known] [Full Name]** — [Title], [Organization]
- Phone: <number with country/area code if known> — OR — not found
- Email: <address> — OR — not found
- LinkedIn: <full URL> — OR — not found
- [One to two sentence factual description of role/background. No marketing voice. State facts.]

**2. [Next person]** — ...
(continue for each contact)

RULES for the summary:
- EVERY person gets all four lines (Phone, Email, LinkedIn, description). If a value is missing, write "not found" — never omit the line.
- For pattern-guessed emails, append " (pattern-guessed)" after the address. Do NOT mark these as "not found".
- For emails Apollo extrapolated, append " (Apollo)" after the address.
- For phones, note: Apollo's database has limited coverage for active-duty US military personnel. For .mil-domain contacts expect "not found" — civilian/contractor contacts have much better Apollo phone coverage. Don't apologize for missing military phones; just state "not found".
- LinkedIn URLs should be the full URL when you have one (e.g. https://linkedin.com/in/danielle-medaglia-3b60652a). Bare-domain (linkedin.com/in/...) is also acceptable.
- Description is FACTS ONLY: current position, predecessor, key programs, location. No "highly accomplished" or "seasoned leader" marketing language.

If the search was for SOLICITATIONS or OFFICES (not people), disregard the per-person template and write a brief summary in your own structure — facts only, no praise.`;

// ---------------------------------------------------------------------------
// Supabase REST helpers
// ---------------------------------------------------------------------------
function supaConfig() {
  const url = process.env.SUPABASE_URL || process.env.SUPABASE_DATABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_KEY || '';
  if (!url || !key) throw new Error('Supabase env vars not set');
  return { url: url.replace(/\/+$/, ''), key };
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
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

const supa = {
  select: (table, qs) => supaRequest('GET', `${table}?${qs}`),
  insert: (table, row) => supaRequest('POST', table, row, { prefer: 'return=representation' }),
  update: (table, qs, patch) => supaRequest('PATCH', `${table}?${qs}`, patch, { prefer: 'return=representation' }),
  rpc: (fn, args) => supaRequest('POST', `rpc/${fn}`, args || {}),
};

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function tool_search_waypoint({ query, scope }) {
  scope = scope || 'all';
  const enc = encodeURIComponent;
  const like = `*${(query || '').replace(/[*%]/g, '')}*`;
  const out = {};

  // 1. Offices via fuzzy RPC (pg_trgm). Matches "PM UAS" when the user types
  //    "PM UAS Army", catches typos and reorderings the old ILIKE missed.
  if (scope === 'all' || scope === 'offices' || scope === 'contacts') {
    try {
      const r = await supa.rpc('scout_fuzzy_offices', {
        q: query, threshold: 0.25, max_rows: 10,
      });
      out.offices = (r || []).map(o => ({
        id:         o.office_id,
        name:       o.name,
        service:    o.service,
        similarity: o.similarity,
      }));
    } catch (e) { out.offices_error = String(e.message || e); }
  }

  // 2. Contacts: union of (a) contacts at matched offices and
  //    (b) contacts whose name fuzzy-matches the query.
  if (scope === 'all' || scope === 'contacts') {
    // count reflects ONE office (not the union of every near-match). If
    // multiple offices tied for top similarity (within 0.05), include them
    // — that catches genuine multi-office tagging without inflating noise.
    let topOffices = [];
    if ((out.offices || []).length) {
      const topSim = out.offices[0].similarity || 0;
      topOffices = out.offices.filter(o => (o.similarity || 0) >= topSim - 0.05);
    }

    try {
      let merged = [];
      if (topOffices.length) {
        const ors = topOffices.map(o =>
          `"officeIds".cs.${enc('["' + String(o.id).replace(/"/g, '\\"') + '"]')}`
        ).join(',');
        const rows = await supa.select(
          'contacts',
          `select=id,"firstName","lastName",rank,title,"officeIds",email,phone,champion&or=(${ors})&limit=40`
        );
        merged = rows || [];
      } else {
        // No office match — fall back to fuzzy NAME search (the user might
        // be looking up a person, not an office).
        const rows = await supa.rpc('scout_fuzzy_contacts', {
          q_name: query, q_office_id: null, threshold: 0.40, max_rows: 10,
        });
        merged = (rows || []).map(c => {
          const parts = (c.full_name || '').trim().split(/\s+/);
          return {
            id: c.contact_id,
            firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] || ''),
            lastName:  parts.length > 1 ? parts[parts.length - 1] : '',
            rank: c.rank, title: c.title, email: c.email, phone: c.phone,
            officeIds: c.office_ids,
          };
        });
      }
      out.contacts = merged.slice(0, 40);
    } catch (e) { out.contacts_error = String(e.message || e); }
  }

  // 3. Solicitations — ILIKE on title + id (right column names this time).
  if (scope === 'all' || scope === 'solicitations') {
    try {
      out.solicitations = await supa.select(
        'solicitations',
        `select=id,title,"officeId",status,owner&or=(title.ilike.${enc(like)},id.ilike.${enc(like)})&limit=15`
      );
    } catch (e) { out.solicitations_error = String(e.message || e); }
  }

  const counts = {
    contacts:      (out.contacts || []).length,
    offices:       (out.offices || []).length,
    solicitations: (out.solicitations || []).length,
  };
  return {
    result: out,
    summary: `Waypoint: ${counts.contacts} contacts, ${counts.offices} offices, ${counts.solicitations} solicitations`,
  };
}

async function tool_search_sam_gov({ keywords, office_name, posted_from, posted_to, naics, limit }, ctx) {
  const apiKey = process.env.SAM_GOV_API_KEY;
  if (!apiKey) {
    return {
      result: { error: 'SAM_GOV_API_KEY not configured. Get a free key at sam.gov/data-services.' },
      summary: 'SAM.gov not configured',
    };
  }

  // discovery — they burn the daily quota on noise. Two checks:
  //   (a) at least one discovery tool (search_waypoint, search_usaspending,
  //       web_search, or fetch_url) must have run earlier this job.
  //   (b) the call must include either a specific office_name (>=4 chars,
  //       not a generic noun) or a NAICS code.
  const discoveryRan = ctx && ctx.discoveryToolsCalled > 0;
  const hasOffice = office_name && String(office_name).trim().length >= 4;
  const hasNaics  = naics && String(naics).trim().length > 0;
  const GENERIC_OFFICE_RE = /^(contracting|acquisition|procurement|program|office)$/i;
  const officeIsGeneric = hasOffice && GENERIC_OFFICE_RE.test(String(office_name).trim());
  if (!discoveryRan) {
    return {
      result: { error: 'SAM.gov is a confirmation tool only. Call search_waypoint / search_usaspending / web_search / fetch_url first to identify a specific office or notice, then re-call SAM.gov with office_name or naics set to that target.' },
      summary: 'SAM.gov rejected: discovery tools not run yet',
    };
  }
  if (!(hasOffice && !officeIsGeneric) && !hasNaics) {
    return {
      result: { error: 'SAM.gov requires a specific office_name (full org name, not a generic word) or a NAICS code. The keywords field alone is not sufficient — that\'s discovery, not confirmation.' },
      summary: 'SAM.gov rejected: missing specific office_name or naics',
    };
  }
  const params = new URLSearchParams({
    api_key: apiKey,
    limit: String(Math.min(limit || 25, 50)),
  });
  if (keywords) params.set('q', keywords);
  if (office_name) params.set('organizationName', office_name);
  if (naics) params.set('ncode', naics);
  //   1. PostedFrom and PostedTo are BOTH mandatory if either is provided.
  //      The v98 code set them independently and 400'd with "PostedFrom and
  //      PostedTo are mandatory" whenever the agent passed only one.
  //   2. The date range cannot exceed 1 year. SAM's error template is broken
  //      and surfaces as "Date range must be null year(s) apart" (their bug).
  // Both are recoverable here without bothering the agent.
  const MS_DAY = 86400000;
  const MS_YEAR = 365 * MS_DAY;
  const parseYmd = s => {
    if (!s) return null;
    const [y, m, day] = String(s).split('-').map(Number);
    if (!y || !m || !day) return null;
    return new Date(Date.UTC(y, m - 1, day));
  };
  const fmtMdy = d => `${String(d.getUTCMonth() + 1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')}/${d.getUTCFullYear()}`;

  let pf = parseYmd(posted_from);
  let pt = parseYmd(posted_to);
  const now = new Date();
  if (!pf && !pt) {
    // No dates: default 90-day window ending today.
    pt = now;
    pf = new Date(now.getTime() - 90 * MS_DAY);
  } else if (pf && !pt) {
    // Open-ended forward: end at today.
    pt = now;
  } else if (!pf && pt) {
    // Open-ended backward: start one year before posted_to (SAM's max).
    pf = new Date(pt.getTime() - MS_YEAR);
  }
  // Clamp range to <= 365 days. If the agent asked for a longer window, keep
  // posted_to as the anchor (most relevant data is recent) and slide
  // posted_from forward.
  if (pt.getTime() - pf.getTime() > MS_YEAR) {
    pf = new Date(pt.getTime() - MS_YEAR);
  }
  // Don't let posted_from be after posted_to (defensive).
  if (pf.getTime() > pt.getTime()) {
    pf = new Date(pt.getTime() - 90 * MS_DAY);
  }
  params.set('postedFrom', fmtMdy(pf));
  params.set('postedTo',   fmtMdy(pt));

  const res = await fetch(`https://api.sam.gov/opportunities/v2/search?${params}`);
  if (!res.ok) {
    const txt = await res.text();
    // ("Date range must be null year(s) apart"). Surface a hint the agent can
    // act on without retrying the same bad params.
    let hint = '';
    const lower = (txt || '').toLowerCase();
    if (lower.includes('postedfrom') && lower.includes('postedto') && lower.includes('mandatory')) {
      hint = ' [HINT: SAM.gov requires both posted_from AND posted_to. The runner now auto-derives the missing one — if you see this error, the dates were both undefined and the default window failed. Retry without specifying dates to get the default 90-day window.]';
    } else if (lower.includes('year(s) apart') || lower.includes('year apart')) {
      hint = ' [HINT: SAM.gov caps date ranges at 1 year. The runner now clamps automatically, but the message means it received a >1y range somehow. Retry without date params or with a window <= 12 months.]';
    } else if (res.status === 429) {
      hint = ' [HINT: SAM.gov daily rate limit hit. Stop calling SAM for the rest of this job and use search_usaspending or web_search instead.]';
    }
    return { result: { error: `SAM.gov ${res.status}: ${txt.slice(0, 200)}${hint}` }, summary: `SAM.gov error (${res.status})` };
  }
  const data = await res.json();
  const opps = (data.opportunitiesData || []).map(o => ({
    notice_id: o.noticeId,
    title: o.title,
    posted_date: o.postedDate,
    response_deadline: o.responseDeadLine,
    office: o.fullParentPathName || o.organizationName,
    pocs: (o.pointOfContact || []).map(p => ({
      name: p.fullName, email: p.email, phone: p.phone, role: p.type,
    })),
    url: o.uiLink,
    naics: o.naicsCode,
    type: o.type,
  }));
  const pocCount = opps.reduce((s, o) => s + o.pocs.length, 0);
  return {
    result: { count: opps.length, opportunities: opps },
    summary: `SAM.gov: ${opps.length} solicitations, ${pocCount} POCs`,
  };
}

async function tool_search_usaspending({ awarding_agency, awarding_office, recipient, fiscal_year, limit }) {
  const filters = { award_type_codes: ['A', 'B', 'C', 'D'] };
  if (awarding_agency) {
    filters.agencies = [{ type: 'awarding', tier: 'toptier', name: awarding_agency }];
  }
  if (awarding_office) {
    filters.agencies = (filters.agencies || []).concat([
      { type: 'awarding', tier: 'subtier', name: awarding_office },
    ]);
  }
  if (recipient) filters.recipient_search_text = [recipient];
  if (fiscal_year) {
    filters.time_period = [{
      start_date: `${fiscal_year - 1}-10-01`,
      end_date: `${fiscal_year}-09-30`,
    }];
  }
  const body = {
    filters,
    fields: [
      'Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency',
      'Awarding Sub Agency', 'Awarding Office', 'Description', 'Start Date',
    ],
    page: 1,
    limit: Math.min(limit || 15, 50),
    sort: 'Award Amount',
    order: 'desc',
  };
  const res = await fetch('https://api.usaspending.gov/api/v2/search/spending_by_award/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    return { result: { error: `USAspending ${res.status}: ${txt.slice(0, 200)}` }, summary: `USAspending error (${res.status})` };
  }
  const data = await res.json();
  const awards = (data.results || []).map(r => ({
    award_id: r['Award ID'],
    recipient: r['Recipient Name'],
    amount: r['Award Amount'],
    awarding_agency: r['Awarding Agency'],
    awarding_subagency: r['Awarding Sub Agency'],
    awarding_office: r['Awarding Office'],
    description: r['Description'],
    start_date: r['Start Date'],
  }));
  return {
    result: { count: awards.length, awards },
    summary: `USAspending: ${awards.length} awards`,
  };
}

// throw ERR_TLS_CERT_ALTNAME_INVALID under Node's strict hostname check.
// For *.mil and *.gov hosts only, route through Node's built-in https
// module with rejectUnauthorized:false. Strict TLS validation stays on
// for every other origin (we keep using global fetch there).
//
// can't statically resolve unless undici is listed in package.json. The
// built-in https module needs no dependency and is available in every
// Node version Netlify supports.
function _isGovTldHost(rawUrl) {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase();
    return h === 'mil' || h === 'gov' || h.endsWith('.mil') || h.endsWith('.gov');
  } catch (_e) { return false; }
}

function _laxFetch(url, init, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = 5;
  const https = require('https');
  const http  = require('http');
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const reqOpts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + (u.search || ''),
      method: (init && init.method) || 'GET',
      headers: (init && init.headers) || {},
      rejectUnauthorized: false,
    };
    const req = lib.request(reqOpts, (res) => {
      const sc = res.statusCode || 0;
      if (sc >= 300 && sc < 400 && res.headers.location && redirectsLeft > 0) {
        // Mirror fetch's redirect:'follow' behavior.
        const next = new URL(res.headers.location, u).toString();
        res.resume();
        return resolve(_laxFetch(next, init, redirectsLeft - 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: sc >= 200 && sc < 300,
          status: sc,
          statusText: res.statusMessage || '',
          headers: res.headers || {}, // v102: expose so cookie warm-up can scrape Set-Cookie
          text: () => Promise.resolve(body),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('lax-fetch timeout (20s)')));
    req.end();
  });
}

function _isLinkedInUrl(rawUrl) {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase();
    return h === 'linkedin.com' || h.endsWith('.linkedin.com');
  } catch (_e) { return false; }
}
function _isArmyMilHost(rawUrl) {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase();
    return h.endsWith('.army.mil');
  } catch (_e) { return false; }
}
// Akamai/Imperva sites sometimes accept a request after the first one
// dropped a session cookie. Best-effort: fetch the origin, scrape
// Set-Cookie, return a Cookie header value (or '' if nothing usable).
async function _warmCookies(rawUrl, baseHeaders) {
  let originUrl;
  try {
    const u = new URL(rawUrl);
    originUrl = u.origin + '/';
  } catch (_e) { return ''; }
  try {
    const warmRes = await _laxFetch(originUrl, {
      method: 'GET',
      headers: baseHeaders,
    });
    const sc = warmRes && warmRes.headers && (warmRes.headers['set-cookie'] || warmRes.headers['Set-Cookie']);
    if (!sc) return '';
    const cookies = (Array.isArray(sc) ? sc : [String(sc)])
      .map(line => String(line).split(';')[0].trim())
      .filter(Boolean);
    return cookies.join('; ');
  } catch (_e) {
    return '';
  }
}

async function tool_fetch_url({ url, max_chars }) {
  const cap = Math.min(max_chars || FETCH_URL_MAX_CHARS, 30000);

  // server-side fetches; no header tweak gets past it. Tell the agent
  // to use web_search and skip the round trip.
  if (_isLinkedInUrl(url)) {
    return {
      result: {
        error: 'LinkedIn blocks all server-side fetches (HTTP 999).',
        bot_protected: true,
        fallback_hint: 'LinkedIn is not fetchable. Use web_search with the person\u2019s name + role + organization, then read the cached snippet from the search result. Do NOT call fetch_url on linkedin.com again in this job.',
      },
      summary: 'LinkedIn is unfetchable \u2014 use web_search instead',
    };
  }

  // Cache check
  try {
    const cached = await supa.select('scout_url_cache', `url=eq.${encodeURIComponent(url)}&select=*&limit=1`);
    if (cached && cached[0]) {
      const age = Date.now() - new Date(cached[0].fetched_at).getTime();
      if (age < URL_CACHE_TTL_MS) {
        return {
          result: {
            title: cached[0].title,
            text: (cached[0].text || '').slice(0, cap),
            fetched_at: cached[0].fetched_at,
            cached: true,
          },
          summary: `fetch_url cached (${(cached[0].text || '').length}c)`,
        };
      }
    }
  } catch (_e) { /* cache miss is fine */ }

  // omitted the sec-ch-ua-* and sec-fetch-* headers a real browser sends;
  // many .mil/.gov sites (acc.army.mil saw RST mid-read) sit behind
  // Akamai/Cloudflare bot detectors that look at exactly this header set.
  // If THIS doesn't get through, the site is fingerprinting at the TLS
  // layer and we tell the agent to pivot to web_search instead.
  let res;
  try {
    const _fetchOpts = {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    };
    // lax-TLS fetcher. Every other origin keeps strict TLS via global fetch.
    const _fetcher = _isGovTldHost(url) ? _laxFetch : fetch;
    // after a homepage hit drops a session cookie. Best-effort, no-op
    // on failure.
    if (_isArmyMilHost(url)) {
      const _cookieHeader = await _warmCookies(url, _fetchOpts.headers);
      if (_cookieHeader) {
        _fetchOpts.headers = Object.assign({}, _fetchOpts.headers, { Cookie: _cookieHeader });
      }
    }
    res = await _fetcher(url, _fetchOpts);
  } catch (e) {
    // like an anti-bot reset (ECONNRESET, EPIPE, TLS-level error), tell
    // the agent the site is bot-protected and to retry the same lookup
    // via web_search instead of trying fetch_url again.
    const root = (e && e.cause) ? e.cause : e;
    const code = (root && (root.code || root.errno)) || '';
    const msg  = (root && root.message) || String(e);
    let extras = '';
    if (root && Array.isArray(root.errors) && root.errors.length) {
      extras = ' [' + root.errors.slice(0, 3).map(x => (x && (x.code || x.message)) || String(x)).join('; ') + ']';
    }
    const detail = (code ? (code + ': ') : '') + msg + extras;
    const ANTIBOT = ['ECONNRESET','EPIPE','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'];
    const looksAntibot = ANTIBOT.indexOf(code) >= 0;
    const fallback_hint = looksAntibot
      ? 'This site appears to block automated requests at the TLS layer (the connection was reset before the response could be read). Do NOT retry fetch_url on this URL. Use web_search instead with the page title or relevant query terms — for .mil/.gov pages, the cached snippets in search results often contain the same names/emails you were looking for.'
      : 'Try web_search with the page title or relevant query terms instead.';
    return {
      result: {
        error: 'fetch failed (' + detail + ')',
        cause_code: code,
        cause_message: msg,
        bot_protected: looksAntibot,
        fallback_hint,
      },
      summary: 'Fetch failed (' + (code || 'network') + ': ' + msg.slice(0, 80) + ') \u2014 try web_search',
    };
  }
  if (!res.ok) {
    // treatment as connection-reset failures so the agent pivots to
    // web_search instead of retrying.
    const HTTP_BOT_BLOCK = new Set([401, 403, 451, 999]);
    if (HTTP_BOT_BLOCK.has(res.status)) {
      return {
        result: {
          error: 'fetch ' + res.status + ' ' + (res.statusText || ''),
          bot_protected: true,
          fallback_hint: 'This site rejected the request at the application layer (HTTP ' + res.status + '). Most likely cause: Akamai/Cloudflare/Imperva bot detection. Do NOT retry fetch_url on this URL. Use web_search with the page title or relevant query terms \u2014 cached snippets often surface the same names/emails the page contains.',
        },
        summary: 'Fetch blocked (' + res.status + ') \u2014 try web_search',
      };
    }
    return { result: { error: 'fetch ' + res.status + ' ' + (res.statusText || '') }, summary: 'Fetch failed (' + res.status + ' ' + (res.statusText || 'error') + ')' };
  }
  const html = await res.text();
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  // Cache write (best-effort)
  try {
    await supaRequest('POST', 'scout_url_cache?on_conflict=url', {
      url, title, text: text.slice(0, 50000), fetched_at: new Date().toISOString(),
    }, { prefer: 'resolution=merge-duplicates' });
  } catch (_e) { /* cache write failure shouldn't block */ }

  return {
    result: { title, text: text.slice(0, cap), fetched_at: new Date().toISOString(), cached: false },
    summary: `fetch_url ${title || url} (${text.length}c)`,
  };
}

async function tool_dvids_search({ query, limit }) {
  const apiKey = process.env.DVIDS_API_KEY;
  if (!apiKey) {
    return {
      result: { error: 'DVIDS_API_KEY not configured. Skipping DVIDS for this query — use web_search instead.', skipped: true },
      summary: 'DVIDS skipped (no key)',
    };
  }
  const params = new URLSearchParams({
    q: query || '',
    max_results: String(Math.min(limit || 10, 25)),
    type: 'news',
    api_key: apiKey,
  });
  const res = await fetch(`https://api.dvidshub.net/search?${params}`);
  if (!res.ok) {
    const txt = await res.text();
    return { result: { error: `DVIDS ${res.status}: ${txt.slice(0, 200)}` }, summary: `DVIDS error (${res.status})` };
  }
  const data = await res.json();
  const items = (data.results || []).map(r => ({
    headline: r.title || r.headline,
    date: r.date_published || r.date,
    unit: r.unit_name,
    description: (r.description || '').slice(0, 400),
    url: r.url,
  }));
  return {
    result: { count: items.length, items },
    summary: `DVIDS: ${items.length} stories`,
  };
}

async function tool_propose_office({ proposed_name, proposed_full_name, service, department, location, chosen_office_id, search_id }) {
  // offices table, which created phantom orgs without user review. The agent
  // must now use propose_office_finding (which writes a scout_findings row of
  // kind=office for user approval in the Findings panel) and rule 8 in the
  // system prompt requires it to PAUSE and ASK the user before doing even
  // that. We keep this stub callable so in-flight agent loops don't crash,
  // but we return only fuzzy candidates + a hint.
  if (chosen_office_id) {
    return {
      result: { office_id: chosen_office_id, was_created: false, deprecated: true },
      summary: `office: deprecated — linked to existing ${chosen_office_id}`,
    };
  }
  // Surface fuzzy candidates for the agent's reasoning.
  let candidates = [];
  try {
    candidates = await supa.rpc('scout_fuzzy_offices', {
      q: proposed_name, threshold: 0.30, max_rows: 8,
    });
  } catch (_e) { /* RPC missing — return empty */ }
  return {
    result: {
      deprecated: true,
      error: 'propose_office is deprecated and no longer creates offices. Pause and ask the user (rule 8): which option do they want — (a) create new (then call propose_office_finding), (b) map to existing (then call propose_finding with that office_id), or (c) skip? Do NOT retry propose_office.',
      fuzzy_candidates: candidates,
    },
    summary: 'office: deprecated — ask user (rule 8)',
  };
}

async function tool_propose_finding(args, ctx) {
  // a job that targeted a specific senator/representative inherits the
  // detected bioguide_id by default. The agent CAN override by passing
  // legislator_bioguide_id explicitly (empty string clears).
  let suggestedBioguide = null;
  if (typeof args.legislator_bioguide_id === 'string') {
    suggestedBioguide = args.legislator_bioguide_id.trim() || null;
  } else if (ctx && ctx.legislator && ctx.legislator.bioguide_id) {
    suggestedBioguide = ctx.legislator.bioguide_id;
  }

  const row = {
    search_id: ctx.search_id,
    full_name: args.full_name,
    rank_or_title: args.rank_or_title || null,
    office_id: args.office_id || null,
    proposed_office_name: args.proposed_office_name || null,
    email: args.email || null,
    email_confidence: args.email_confidence || null,
    phone: args.phone || null,
    phone_confidence: args.phone_confidence || null,
    linkedin_url: args.linkedin_url || null,
    sources: args.sources || [],
    notes: args.notes || null,
    suggested_legislator_bioguide_id: suggestedBioguide,
  };

  // "Jeffrey Bess" — the old ILIKE %name% match couldn't.
  let matched_contact_id = null;
  let matched_contact_data = null;
  try {
    const matches = await supa.rpc('scout_fuzzy_contacts', {
      q_name: args.full_name,
      q_office_id: args.office_id || null,
      threshold: 0.45,
      max_rows: 3,
    });
    if (matches && matches[0]) {
      matched_contact_id = matches[0].contact_id;
      matched_contact_data = matches[0];
    }
  } catch (_e) { /* RPC missing or fuzzy fails — fall through to email match */ }

  // Fallback: exact email match (catches name changes / nicknames the
  // trigram missed).
  if (!matched_contact_id && args.email) {
    try {
      const enc = encodeURIComponent;
      const eq = await supa.select(
        'contacts',
        `select=id,"firstName","lastName",rank,title,email,phone,"officeIds"&email=eq.${enc(args.email)}&limit=1`
      );
      if (eq && eq[0]) {
        matched_contact_id = eq[0].id;
        matched_contact_data = {
          contact_id: eq[0].id,
          full_name: ((eq[0].firstName || '') + ' ' + (eq[0].lastName || '')).trim(),
          rank: eq[0].rank,
          title: eq[0].title,
          email: eq[0].email,
          phone: eq[0].phone,
          office_ids: eq[0].officeIds,
          similarity: 1.0,
        };
      }
    } catch (_e) { /* dedup is best-effort */ }
  }

  row.kind = 'contact';
  if (matched_contact_id)   row.matched_contact_id = matched_contact_id;
  if (matched_contact_data) row.matched_contact_data = matched_contact_data;

  const inserted = await supa.insert('scout_findings', row);
  const finding = inserted && inserted[0];
  return {
    result: {
      finding_id: finding && finding.id,
      matched_contact_id,
      matched_contact_data,
      finding,
    },
    summary: `finding: ${args.full_name}${matched_contact_id ? ' (already in Waypoint)' : ''}`,
  };
}

async function tool_propose_office_finding(args, ctx) {
  const data = {
    name:         args.name || null,
    full_name:    args.full_name || null,
    service:      args.service || null,
    department:   args.department || null,
    location:     args.location || null,
  };
  const row = {
    search_id: ctx.search_id,
    kind: 'office',
    full_name: args.name || '(unnamed office)',  // legacy NOT-NULL workaround
    sources: args.sources || [],
    notes: args.notes || null,
    data,
  };
  const inserted = await supa.insert('scout_findings', row);
  const finding = inserted && inserted[0];
  return {
    result: { finding_id: finding && finding.id, finding },
    summary: `office finding: ${args.name}`,
  };
}

async function tool_propose_solicitation_finding(args, ctx) {
  const data = {
    title:       args.title || null,
    link:        args.link || null,
    office_id:   args.office_id || null,
    office_name: args.office_name || null,
    value:       args.value || null,
    status:      args.status || null,
    open_date:   args.open_date || null,
    due_date:    args.due_date || null,
    award_date:  args.award_date || null,
    type:        args.type || null,
    phase:       args.phase || null,
    topic:       args.topic || null,
    tech:        args.tech || [],
  };
  const row = {
    search_id: ctx.search_id,
    kind: 'solicitation',
    full_name: args.title || '(untitled solicitation)',  // legacy NOT-NULL workaround
    sources: args.sources || [],
    notes: args.notes || null,
    data,
  };
  const inserted = await supa.insert('scout_findings', row);
  const finding = inserted && inserted[0];
  return {
    result: { finding_id: finding && finding.id, finding },
    summary: `solicitation finding: ${args.title}`,
  };
}

// ---------------------------------------------------------------------------
// Apollo.io enrichment - bulk people match
// ---------------------------------------------------------------------------
//
// Apollo's bulk_match endpoint takes up to 10 person "details" records per
// call and returns a same-length `matches` array (null entries = no match).
// 1 credit per matched record on most plans. Work-email reveal is included;
// personal-email reveal costs extra credits and is gated by env var.
// Phone reveal is intentionally NOT wired here because Apollo dials in real
// time and requires a webhook URL to deliver the number asynchronously.

const APOLLO_API = 'https://api.apollo.io/api/v1';
const APOLLO_BULK_MAX = 10;

// Map Apollo's email_status string onto Scout's email_confidence enum.
function apolloEmailConfidence(emailStatus) {
  if (!emailStatus) return null;
  const s = String(emailStatus).toLowerCase();
  if (s === 'verified') return 'verified';
  if (s === 'likely to engage' || s === 'extrapolated') return 'public_bio';
  if (s === 'guessed') return 'pattern_guessed';
  return null;
}

async function apolloBulkMatch(records, opts) {
  const key = process.env.APOLLO_API_KEY;
  if (!key) {
    return { matches: [], error: 'APOLLO_API_KEY not configured.' };
  }
  if (!records || !records.length) return { matches: [] };
  const details = records.slice(0, APOLLO_BULK_MAX).map(r => {
    const d = {};
    if (r.first_name) d.first_name = String(r.first_name).slice(0, 80);
    if (r.last_name)  d.last_name  = String(r.last_name).slice(0, 80);
    if (r.name && !r.first_name && !r.last_name) d.name = String(r.name).slice(0, 160);
    if (r.organization_name) d.organization_name = String(r.organization_name).slice(0, 160);
    if (r.domain) d.domain = String(r.domain).slice(0, 120);
    if (r.title)  d.title  = String(r.title).slice(0, 120);
    if (r.linkedin_url) d.linkedin_url = String(r.linkedin_url).slice(0, 240);
    if (r.email) d.email = String(r.email).slice(0, 160);
    return d;
  });
  const body = {
    details,
    reveal_personal_emails: !!(opts && opts.reveal_personal_emails),
    reveal_phone_number: !!(opts && opts.reveal_phone_number),
  };
  if (opts && opts.reveal_phone_number) {
    if (!opts.webhook_url) {
      return { matches: [], error: 'reveal_phone_number=true requires webhook_url' };
    }
    body.webhook_url = String(opts.webhook_url);
  }
  async function once() {
    return fetch(APOLLO_API + '/people/bulk_match', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': key,
        'accept': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }
  let res;
  try { res = await once(); }
  catch (e) {
    return { matches: [], error: 'Apollo fetch failed: ' + (e.message || String(e)) };
  }
  if (res.status === 429) {
    const ra = parseInt(res.headers.get('retry-after') || '0', 10);
    const waitMs = Math.min(Math.max(ra * 1000, 2000), 5000);
    await new Promise(r => setTimeout(r, waitMs));
    try { res = await once(); }
    catch (e) {
      return { matches: [], error: 'Apollo retry failed: ' + (e.message || String(e)), rate_limited: true };
    }
  }
  const txt = await res.text();
  if (!res.ok) {
    return {
      matches: [],
      error: 'Apollo ' + res.status + ': ' + txt.slice(0, 240),
      raw_status: res.status,
      rate_limited: res.status === 429,
    };
  }
  let data;
  try { data = JSON.parse(txt); }
  catch (_e) { return { matches: [], error: 'Apollo returned non-JSON body' }; }
  return {
    matches: Array.isArray(data.matches) ? data.matches : [],
    raw_status: res.status,
  };
}

const _RANK_TOKENS = new Set([
  'pvt','pv2','pfc','spc','cpl','sgt','ssg','sfc','msg','1sg','sgm','csm',
  '2lt','1lt','cpt','maj','ltc','col','bg','mg','ltg','gen',
  'ens','ltjg','lt','lcdr','cdr','capt','radm','vadm','adm',
  'a1c','sra','ssgt','tsgt','msgt','smsgt','cmsgt','ccm','ccmsgt',
  'po3','po2','po1','cpo','scpo','mcpo','mcpoc','mcpon',
  'amn','sgtmaj','sgmaj','wo1','wo2','wo3','wo4','wo5','cw2','cw3','cw4','cw5',
  'mr','mrs','ms','miss','dr','sir','madam','hon',
]);
function splitNameForApollo(fullName) {
  if (!fullName) return { first_name: '', last_name: '' };
  let raw = String(fullName).trim();
  // Last-comma-first form ("Smith, John A.") is common in SAM.gov POC blobs
  // and government rosters. Detect it before tokenizing: comma BEFORE the
  // last whitespace token, and no obvious "Jr."/"III" sitting on the right
  // side (which would be a true suffix comma).
  let commaSwap = false;
  const commaIdx = raw.indexOf(',');
  if (commaIdx > 0 && commaIdx < raw.length - 1) {
    const right = raw.slice(commaIdx + 1).trim().split(/\s+/)[0] || '';
    const rNorm = right.toLowerCase().replace(/\.$/, '');
    const SUFFIXES = new Set(['jr','sr','ii','iii','iv','v','phd','md','esq']);
    if (!SUFFIXES.has(rNorm)) commaSwap = true;
  }
  let tokens;
  if (commaSwap) {
    const left  = raw.slice(0, commaIdx).trim();
    const right = raw.slice(commaIdx + 1).trim();
    tokens = (right + ' ' + left).split(/\s+/).filter(Boolean);
  } else {
    tokens = raw.replace(/[,]/g, ' ').split(/\s+/).filter(Boolean);
  }
  // Strip a leading rank/honorific token.
  while (tokens.length > 1) {
    const t0 = tokens[0].toLowerCase().replace(/\.$/, '');
    if (_RANK_TOKENS.has(t0)) tokens = tokens.slice(1);
    else break;
  }
  // Drop a trailing generational suffix.
  if (tokens.length > 1) {
    const last = tokens[tokens.length - 1].toLowerCase().replace(/\.$/, '');
    if (['jr','sr','ii','iii','iv','v'].indexOf(last) >= 0) tokens = tokens.slice(0, -1);
  }
  if (tokens.length === 0) return { first_name: '', last_name: '' };
  if (tokens.length === 1) return { first_name: tokens[0], last_name: '' };
  return {
    first_name: tokens[0],
    last_name: tokens[tokens.length - 1],
  };
}

async function tool_apollo_enrich({ records, reveal_personal_emails }, ctx) {
  if (!process.env.APOLLO_API_KEY) {
    return {
      result: { error: 'APOLLO_API_KEY not set. Add it in Netlify env vars to enable Apollo enrichment.' },
      summary: 'Apollo not configured',
    };
  }
  if (!Array.isArray(records) || !records.length) {
    return { result: { error: 'records must be a non-empty array.' }, summary: 'Apollo: empty records' };
  }
  const norm = records.slice(0, APOLLO_BULK_MAX).map(r => {
    if (r.first_name || r.last_name) return r;
    if (r.name) {
      const split = splitNameForApollo(r.name);
      return Object.assign({}, r, split);
    }
    return r;
  });
  const out = await apolloBulkMatch(norm, {
    reveal_personal_emails: !!reveal_personal_emails,
  });
  if (out.error) {
    return { result: { error: out.error, rate_limited: !!out.rate_limited }, summary: 'Apollo error: ' + String(out.error).slice(0, 80) };
  }
  const matched = out.matches.filter(Boolean).length;
  const trimmed = out.matches.map(m => {
    if (!m) return null;
    return {
      name: m.name,
      first_name: m.first_name,
      last_name: m.last_name,
      title: m.title || m.headline,
      email: m.email,
      email_status: m.email_status,
      linkedin_url: m.linkedin_url,
      organization_name: m.organization && (m.organization.name || m.organization.website_url),
      organization_domain: m.organization && (m.organization.primary_domain || m.organization.domain),
      city: m.city, state: m.state, country: m.country,
      apollo_id: m.id,
    };
  });
  return {
    result: { count_requested: norm.length, count_matched: matched, matches: trimmed },
    summary: 'Apollo: ' + matched + '/' + norm.length + ' matched',
  };
}

async function runApolloEnrichmentPass(searchId, ctx) {
  if (!process.env.APOLLO_API_KEY) {
    return { ran: false, reason: 'no_api_key' };
  }
  if (!searchId) return { ran: false, reason: 'no_search_id' };

  // Phone-reveal gate: requires both the env flag and a publicly-reachable
  // webhook URL. If APOLLO_REVEAL_PHONE=1 but APOLLO_WEBHOOK_URL is missing,
  // we deliberately fall back to email-only rather than 422-ing on every batch.
  const wantPhone = process.env.APOLLO_REVEAL_PHONE === '1';
  const webhookUrl = process.env.APOLLO_WEBHOOK_URL || '';
  const phoneEnabled = wantPhone && /^https:\/\//i.test(webhookUrl);
  const phoneSkippedReason = wantPhone && !phoneEnabled
    ? 'APOLLO_REVEAL_PHONE=1 but APOLLO_WEBHOOK_URL not set or not https'
    : null;

  let findings;
  try {
    findings = await supa.select(
      'scout_findings',
      'search_id=eq.' + encodeURIComponent(searchId)
      + '&kind=eq.contact'
      + '&select=id,full_name,rank_or_title,office_id,proposed_office_name,email,email_confidence,phone,phone_confidence,linkedin_url,sources,notes,apollo_id,phone_pending'
      + '&limit=200'
    );
  } catch (e) {
    return { ran: false, reason: 'select_failed: ' + (e.message || e) };
  }
  if (!findings || !findings.length) return { ran: false, reason: 'no_findings' };

  // Enrich any contact missing verified email OR missing verified phone (the
  // latter only when phone reveal is enabled — otherwise re-asking is wasted
  // spend).
  const candidates = findings.filter(f => {
    if (!f.full_name) return false;
    const emailLocked   = f.email && f.email_confidence === 'verified';
    const phoneLocked   = f.phone && f.phone_confidence === 'verified';
    if (emailLocked && (!phoneEnabled || phoneLocked)) return false;
    return true;
  });
  if (!candidates.length) return {
    ran: false, reason: 'nothing_to_enrich', total_findings: findings.length,
    phone_enabled: phoneEnabled, phone_skipped_reason: phoneSkippedReason,
  };

  const officeIds = Array.from(new Set(candidates.map(f => f.office_id).filter(Boolean)));
  const officeMap = {};
  if (officeIds.length) {
    try {
      const enc = encodeURIComponent;
      const idList = officeIds.map(x => '"' + String(x).replace(/"/g, '\\"') + '"').join(',');
      const rows = await supa.select(
        'offices',
        'id=in.(' + enc(idList) + ')&select=id,name,"fullName",service'
      );
      for (const o of (rows || [])) officeMap[o.id] = o;
    } catch (_e) {}
  }

  const records = candidates.map(f => {
    const split = splitNameForApollo(f.full_name);
    const office = f.office_id && officeMap[f.office_id];
    const org_name = (office && (office.fullName || office.name))
      || f.proposed_office_name
      || (office && office.service)
      || null;
    return {
      _finding_id: f.id,
      _finding: f,
      first_name: split.first_name,
      last_name:  split.last_name,
      organization_name: org_name,
      title: f.rank_or_title || undefined,
      linkedin_url: f.linkedin_url || undefined,
      email: (f.email && f.email_confidence !== 'pattern_guessed') ? f.email : undefined,
    };
  });

  const reveal_personal_emails = process.env.APOLLO_REVEAL_PERSONAL_EMAILS === '1';
  const batchResults = [];
  let calls = 0, matched = 0, rateLimited = false, lastError = null;
  let phoneRequested = 0;
  for (let i = 0; i < records.length; i += APOLLO_BULK_MAX) {
    const batch = records.slice(i, i + APOLLO_BULK_MAX);
    const stripped = batch.map(r => {
      const { _finding_id, _finding, ...rest } = r;
      return rest;
    });
    const tStart = Date.now();
    const callOpts = { reveal_personal_emails };
    if (phoneEnabled) {
      callOpts.reveal_phone_number = true;
      callOpts.webhook_url = webhookUrl;
    }
    const out = await apolloBulkMatch(stripped, callOpts);
    calls++;
    const latency = Date.now() - tStart;
    try {
      await auditToolCall(ctx, 'apollo_enrich_pass', {
        count: stripped.length,
        reveal_personal_emails,
        reveal_phone_number: !!callOpts.reveal_phone_number,
      }, {
        result: { count_matched: (out.matches || []).filter(Boolean).length, error: out.error || null },
        summary: 'apollo_enrich_pass batch ' + (i / APOLLO_BULK_MAX + 1),
      }, latency, out.error || null);
    } catch (_e) {}
    if (out.error) {
      lastError = out.error;
      if (out.rate_limited) rateLimited = true;
      continue;
    }
    for (let k = 0; k < batch.length; k++) {
      const m = out.matches[k];
      if (!m) continue;
      matched++;
      batchResults.push({ finding: batch[k]._finding, match: m });
    }
    if (phoneEnabled) phoneRequested += stripped.length;
  }

  let patched = 0, phonePendingSet = 0, syncPhonesCaptured = 0;
  for (const { finding, match } of batchResults) {
    const patch = {};

    // --- Email merge (unchanged from v97) ---
    const matchEmail = match.email;
    const emailConf  = apolloEmailConfidence(match.email_status);
    if (matchEmail && emailConf) {
      const isUpgrade = !finding.email
        || finding.email_confidence === 'pattern_guessed'
        || (finding.email_confidence === 'public_bio' && emailConf === 'verified');
      if (isUpgrade) {
        patch.email = matchEmail;
        patch.email_confidence = emailConf;
      }
    }
    if (!finding.linkedin_url && match.linkedin_url) {
      patch.linkedin_url = match.linkedin_url;
    }
    if (!finding.rank_or_title && (match.title || match.headline)) {
      patch.rank_or_title = String(match.title || match.headline).slice(0, 200);
    }

    // --- Apollo id (always store on a successful match — required for the
    //     phone webhook to map back, useful for de-dup forever after) ---
    if (match.id && !finding.apollo_id) {
      patch.apollo_id = String(match.id);
    }

    // --- Synchronous phone capture: Apollo sometimes returns the employer
    //     or HQ phone in the sync response (under organization.phone or
    //     match.phone_numbers[]). We capture it with phone_confidence=
    //     'public_bio' so the user has something to work with even if the
    //     mobile reveal webhook never arrives. Never overwrites a verified
    //     phone. ---
    const syncPhones = [];
    if (match.organization && match.organization.phone) {
      syncPhones.push({
        sanitized_number: match.organization.phone,
        raw_number: match.organization.phone,
        type_cd: 'organization',
        confidence_cd: 'medium',
      });
    }
    if (Array.isArray(match.phone_numbers)) {
      for (const p of match.phone_numbers) {
        if (p && (p.sanitized_number || p.raw_number)) syncPhones.push(p);
      }
    }
    if (syncPhones.length && !(finding.phone && finding.phone_confidence === 'verified')) {
      // Prefer non-organization first, then highest confidence.
      const ranked = syncPhones.slice().sort((a, b) => {
        const aOrg = (a.type_cd === 'organization') ? 1 : 0;
        const bOrg = (b.type_cd === 'organization') ? 1 : 0;
        if (aOrg !== bOrg) return aOrg - bOrg;
        const aC = (a.confidence_cd === 'high') ? 0 : (a.confidence_cd === 'medium' ? 1 : 2);
        const bC = (b.confidence_cd === 'high') ? 0 : (b.confidence_cd === 'medium' ? 1 : 2);
        return aC - bC;
      });
      const best = ranked[0];
      const num = best.sanitized_number || best.raw_number;
      if (num && (!finding.phone || finding.phone_confidence !== 'verified')) {
        patch.phone = num;
        patch.phone_confidence = 'public_bio';
        syncPhonesCaptured++;
      }
    }

    // --- Phone pending flag: we asked for the phone via webhook, none arrived
    //     synchronously (or only an employer phone did). Set the flag so the
    //     UI can render "phone arriving soon". The webhook clears it. ---
    if (phoneEnabled && !(finding.phone && finding.phone_confidence === 'verified')) {
      patch.phone_pending = true;
      phonePendingSet++;
    }

    if (!Object.keys(patch).length) continue;
    const newSrc = {
      provider: 'apollo',
      url: 'https://app.apollo.io/people/' + (match.id || ''),
      note: 'Apollo bulk_match enrichment' + (phoneEnabled ? ' (phone webhook requested)' : ''),
      retrieved_at: new Date().toISOString(),
      apollo_email_status: match.email_status || null,
      apollo_id: match.id || null,
    };
    patch.sources = (Array.isArray(finding.sources) ? finding.sources : []).concat([newSrc]);
    try {
      await supa.update('scout_findings', 'id=eq.' + encodeURIComponent(finding.id), patch);
      patched++;
    } catch (_e) {}
  }

  return {
    ran: true,
    candidates: candidates.length,
    apollo_calls: calls,
    matched,
    patched,
    phone_enabled: phoneEnabled,
    phone_requested: phoneRequested,
    phone_pending_set: phonePendingSet,
    sync_phones_captured: syncPhonesCaptured,
    phone_skipped_reason: phoneSkippedReason,
    rate_limited: rateLimited,
    last_error: lastError,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions sent to Claude
// ---------------------------------------------------------------------------

const TOOL_DEFS = [
  {
    name: 'search_waypoint',
    description: 'Search Waypoint (own CRM). Call first.',
    input_schema: { type: 'object', properties: {
      query: { type: 'string' },
      scope: { type: 'string', enum: ['all','contacts','offices','solicitations'] },
    }, required: ['query'] },
  },
  {
    name: 'search_sam_gov',
    description: 'SAM.gov solicitations + POC/KO emails. CONFIRMATION TOOL ONLY — never use for discovery. Call this AFTER another tool (search_waypoint / search_usaspending / web_search / fetch_url) has identified a SPECIFIC office name or NAICS. Required: office_name (specific org, not generic words like "contracting") OR naics. The runner rejects calls that don\'t meet these constraints. SAM.gov has a hard daily rate limit; treat it as the last step in a chain, not the first.',
    input_schema: { type: 'object', properties: {
      keywords: { type: 'string', description: 'Optional extra keywords. NOT a substitute for office_name/naics — keywords alone will be rejected.' },
      office_name: { type: 'string', description: 'Specific organization name (e.g. "PEO STRI") identified from a prior tool call. Generic terms like "contracting" are rejected.' },
      posted_from: { type: 'string', description: 'YYYY-MM-DD' },
      posted_to: { type: 'string', description: 'YYYY-MM-DD' },
      naics: { type: 'string', description: 'NAICS code identified from another source (e.g. via search_usaspending or web_search).' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    } },
  },
  {
    name: 'search_usaspending',
    description: 'USAspending past awards (KO history).',
    input_schema: { type: 'object', properties: {
      awarding_agency: { type: 'string' },
      awarding_office: { type: 'string' },
      recipient: { type: 'string' },
      fiscal_year: { type: 'integer' },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    } },
  },
  {
    name: 'dvids_search',
    description: 'DVIDS press releases (DoD names + units). Requires DVIDS_API_KEY.',
    input_schema: { type: 'object', properties: {
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 25 },
    }, required: ['query'] },
  },
  {
    name: 'fetch_url',
    description: 'Fetch URL as cleaned text. 24h cache.',
    input_schema: { type: 'object', properties: {
      url: { type: 'string' },
      max_chars: { type: 'integer', minimum: 1000, maximum: 30000 },
    }, required: ['url'] },
  },
  {
    name: 'propose_office',
    description: 'DEPRECATED in v166 — do NOT call this for new orgs. Use propose_office_finding instead (which stages the office for user review without auto-creating it in Waypoint). Per rule 8, you must PAUSE and ASK the user before staging any new office. This tool is preserved only as a no-op stub returning fuzzy candidates.',
    input_schema: { type: 'object', properties: {
      proposed_name:      { type: 'string', description: 'Short name / acronym (e.g. "PEO RAS"). No service prefix.' },
      proposed_full_name: { type: 'string', description: 'Expanded name (e.g. "Program Executive Office, Robotics and Autonomous Systems").' },
      service:            { type: 'string', description: 'Service / branch as text (e.g. "Coast Guard", "Army", "DoD").' },
      department:         { type: 'string', enum: ['af','army','navy','marines','socom','osd','joint','congress'], description: 'Dropdown code; omit if no match (e.g. Coast Guard).' },
      location:           { type: 'string', description: 'HQ city/state if known (e.g. "Washington, DC").' },
      chosen_office_id:   { type: 'string', description: 'Set to a candidate id from fuzzy_candidates if it matches; omit to create.' },
    }, required: ['proposed_name'] },
  },
  {
    name: 'propose_finding',
    description: 'Record one contact. Sources required for any email/phone/linkedin. If this job targets a specific senator or representative, the runner auto-attaches the detected bioguide_id; pass legislator_bioguide_id explicitly only to override (empty string clears).',
    input_schema: { type: 'object', properties: {
      full_name: { type: 'string' },
      rank_or_title: { type: 'string' },
      office_id: { type: 'string' },
      proposed_office_name: { type: 'string' },
      email: { type: 'string' },
      email_confidence: { type: 'string', enum: ['verified','public_bio','pattern_guessed'] },
      phone: { type: 'string' },
      phone_confidence: { type: 'string', enum: ['verified','public_bio'] },
      linkedin_url: { type: 'string' },
      legislator_bioguide_id: { type: 'string', description: 'Optional Hill principal override. Empty string clears the auto-inherited value.' },
      sources: { type: 'array', items: { type: 'object' } },
      notes: { type: 'string' },
    }, required: ['full_name'] },
  },
  {
    name: 'propose_office_finding',
    description: 'Record a NEW office (organization) the user should add to Waypoint. Use only when search_waypoint confirmed the office is not already in Waypoint. Required: name (short acronym). Recommended: full_name, service, location. department must be one of: af, army, navy, marines, socom, osd, joint, congress; null for Coast Guard / DHS.',
    input_schema: { type: 'object', properties: {
      name:       { type: 'string', description: 'Short acronym (e.g. "PEO RAS")' },
      full_name:  { type: 'string', description: 'Expanded name (e.g. "Program Executive Office, Robotics and Autonomous Systems")' },
      service:    { type: 'string', description: 'Service / branch text (e.g. "Coast Guard", "Army")' },
      department: { type: 'string', enum: ['af','army','navy','marines','socom','osd','joint','congress'] },
      location:   { type: 'string', description: 'HQ city/state if known' },
      sources:    { type: 'array', items: { type: 'object' } },
      notes:      { type: 'string' },
    }, required: ['name'] },
  },
  {
    name: 'propose_solicitation_finding',
    description: 'Record a NEW solicitation / contract opportunity the user should track. Use when SAM.gov / USAspending surface an opportunity worth following. Required: title. Include link, office_id (if known) or office_name (if proposing a new office), value, status, dates.',
    input_schema: { type: 'object', properties: {
      title:       { type: 'string' },
      link:        { type: 'string', description: 'URL to the opportunity / award' },
      office_id:   { type: 'string', description: 'Waypoint office id if known' },
      office_name: { type: 'string', description: 'Office name if office_id not in Waypoint yet' },
      value:       { type: 'number', description: 'Estimated value in USD' },
      status:      { type: 'string', description: 'tracking | open | submitted | won | lost' },
      open_date:   { type: 'string', description: 'YYYY-MM-DD' },
      due_date:    { type: 'string', description: 'YYYY-MM-DD' },
      award_date:  { type: 'string', description: 'YYYY-MM-DD' },
      type:        { type: 'string', description: 'e.g. RFI, RFP, BAA, SBIR' },
      phase:       { type: 'string' },
      topic:       { type: 'string' },
      tech:        { type: 'array', items: { type: 'string' } },
      sources:     { type: 'array', items: { type: 'object' } },
      notes:       { type: 'string' },
    }, required: ['title'] },
  },
  {
    name: 'apollo_enrich',
    description: 'Apollo.io people enrichment via bulk_match. ENRICHMENT TOOL - call only after another tool has identified at least one specific person\'s name. Up to 10 records per call, 1 Apollo credit per matched record. Use to confirm/verify a name -> email/title/linkedin before proposing the finding. The runner also runs a deterministic Apollo pass over ALL contact findings after the loop ends, so you only need to call this mid-loop when you want the email back before continuing to research (e.g. to disambiguate two people with the same name by office). NEVER pattern-guess an email when Apollo is available - call this instead. Phone reveal is NOT supported in v97.',
    input_schema: { type: 'object', properties: {
      records: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          properties: {
            name:              { type: 'string', description: 'Full name (preferred over first/last when you have one string).' },
            first_name:        { type: 'string' },
            last_name:         { type: 'string' },
            organization_name: { type: 'string', description: 'Org / employer / agency name. Helps disambiguation dramatically.' },
            domain:            { type: 'string', description: 'Org primary domain (e.g. army.mil, lockheedmartin.com).' },
            title:             { type: 'string' },
            linkedin_url:      { type: 'string' },
            email:             { type: 'string', description: 'Pre-known email (helps Apollo match exactly).' },
          },
        },
      },
      reveal_personal_emails: { type: 'boolean', description: 'Costs extra Apollo credits. Default false.' },
    }, required: ['records'] },
  },
  { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
];

// ---------------------------------------------------------------------------
// Local tool runner — dispatch + audit log + propose_office fuzzy injection
// ---------------------------------------------------------------------------
async function runLocalTool(name, args, ctx) {
  // narrowing has happened. search_waypoint counts as discovery (Waypoint itself
  // is a free, fast first stop).
  const DISCOVERY = ['search_waypoint', 'search_usaspending', 'fetch_url', 'web_search'];
  if (DISCOVERY.indexOf(name) >= 0 && ctx) {
    ctx.discoveryToolsCalled = (ctx.discoveryToolsCalled || 0) + 1;
  }
  if (name === 'search_waypoint') return tool_search_waypoint(args);
  if (name === 'search_sam_gov') return tool_search_sam_gov(args, ctx);
  if (name === 'search_usaspending') return tool_search_usaspending(args);
  if (name === 'fetch_url') return tool_fetch_url(args);
  if (name === 'dvids_search') return tool_dvids_search(args);
  if (name === 'propose_office') {
    // (which returns fuzzy candidates + the hint) without pre-attach logic.
    return tool_propose_office({ ...args, search_id: ctx.search_id });
  }
  if (name === 'apollo_enrich')                return tool_apollo_enrich(args, ctx);
  if (name === 'propose_finding')              return tool_propose_finding(args, ctx);
  if (name === 'propose_office_finding')       return tool_propose_office_finding(args, ctx);
  if (name === 'propose_solicitation_finding') return tool_propose_solicitation_finding(args, ctx);
  return { result: { error: `Unknown tool: ${name}` }, summary: `unknown ${name}` };
}

async function auditToolCall(ctx, toolName, args, result, latencyMs, error) {
  try {
    await supa.insert('scout_tool_calls', {
      search_id: ctx.search_id,
      message_id: ctx.message_id || null,
      tool_name: toolName,
      arguments: args || null,
      result: result?.result || null,
      result_summary: result?.summary || null,
      latency_ms: latencyMs,
      error: error || null,
    });
  } catch (_e) { /* audit failure shouldn't break the loop */ }
}

// ---------------------------------------------------------------------------
// History pruning — strip large tool_result content from older turns so we
// don't blow the input-token budget every turn. The agent sees full results
// from the most recent K tool_results; older ones become a short stub.
// ---------------------------------------------------------------------------
function pruneHistory(messages) {
  const KEEP_FULL = 4;
  const cloned = JSON.parse(JSON.stringify(messages));
  // Find every tool_result block in order
  const idx = [];
  for (let i = 0; i < cloned.length; i++) {
    const m = cloned[i];
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (let j = 0; j < m.content.length; j++) {
        if (m.content[j] && m.content[j].type === 'tool_result') idx.push([i, j]);
      }
    }
  }
  const collapseTo = Math.max(0, idx.length - KEEP_FULL);
  for (let k = 0; k < collapseTo; k++) {
    const [i, j] = idx[k];
    const orig = cloned[i].content[j];
    const cstr = typeof orig.content === 'string' ? orig.content : JSON.stringify(orig.content || '');
    cloned[i].content[j] = {
      type: 'tool_result',
      tool_use_id: orig.tool_use_id,
      content: '[Result truncated for context budget. Was ' + cstr.length + ' chars.]',
    };
  }
  return cloned;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
const US_STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR',
  california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX',
  utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
const HILL_CUES = [
  // NO /i flag. Under /i, [A-Z] also matches lowercase, which makes the
  // surname group greedily eat following lowercase words ("Senator
  // Sanders defense LA" would capture "Sanders defense LA"). Enumerate
  // the cue keyword case variants explicitly instead.
  [/\b(?:Senator|senator|SENATOR|Sen\.?|sen\.?|SEN\.?)\s+([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){0,2})/, 'senate'],
  [/\b(?:Representative|representative|REPRESENTATIVE|Rep\.?|rep\.?|REP\.?|Congressman|congressman|CONGRESSMAN|Congresswoman|congresswoman|CONGRESSWOMAN|Congressperson|congressperson|CONGRESSPERSON)\s+([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){0,2})/, 'house'],
];
const HILL_ROLE_CUES = /(military legislative assistant|military liaison officer|\bmla\b|\bmlo\b|defense (?:legislative assistant|fellow|advisor|aide|la)|legislative director|\bLD\b|legislative aide|chief of staff|defense detailee|hill staffer|hill aide|congressional staffer)/i;

function _hillExtractStateHint(text) {
  const stateAbbrRe = /(?:from|of|representing|,)\s+([A-Z]{2})(?:[\s.,?!]|$)/g;
  let m;
  while ((m = stateAbbrRe.exec(text)) !== null) return m[1].toUpperCase();
  const lower = text.toLowerCase();
  for (const name in US_STATE_NAMES) {
    if (lower.indexOf(name) >= 0) return US_STATE_NAMES[name];
  }
  return null;
}

async function detectLegislator(message, ctx) {
  if (!message || typeof message !== 'string') return null;
  const text = message;

  let chamberHint = null;
  let surnameGuess = null;
  for (const pair of HILL_CUES) {
    const mm = text.match(pair[0]);
    if (mm) { chamberHint = pair[1]; surnameGuess = mm[1].trim(); break; }
  }
  if (!surnameGuess && HILL_ROLE_CUES.test(text)) {
    const tail = text.match(/(?:for|of)\s+([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){0,2})/);
    if (tail) surnameGuess = tail[1].trim();
  }
  if (!surnameGuess) return null;

  let tokens = surnameGuess.split(/\s+/);
  // Strip trailing all-caps acronyms (e.g. "Sen. Wicker MLA contact" or
  // "SEN WICKER MLA"): the surname pattern's {0,2} extension can greedily
  // absorb a following ACRONYM, which makes the surname-lookup miss.
  // Only strip from the tail, never from the first token (which may itself
  // be an all-caps name like "WICKER" in an all-caps query).
  while (tokens.length > 1 && /^[A-Z]+$/.test(tokens[tokens.length - 1])) tokens.pop();
  const lastToken = tokens[tokens.length - 1];
  const surnameLower = lastToken.toLowerCase();

  let members = ctx && ctx._hillMembersCache;
  if (!members) {
    try {
      members = await supa.select(
        'hill_members',
        'select=bioguide_id,full_name,first_name,last_name,chamber,state,district,party,office_address,office_phone,official_url,leadership_title&limit=1000'
      );
    } catch (e) {
      console.warn('detectLegislator: failed to load hill_members', e.message || e);
      members = [];
    }
    if (ctx) ctx._hillMembersCache = members;
  }
  if (!members.length) return null;

  let candidates = members.filter(m => (m.last_name || '').toLowerCase() === surnameLower);
  if (!candidates.length) {
    candidates = members.filter(m => {
      const fn = (m.full_name || '').toLowerCase();
      return tokens.every(t => fn.indexOf(t.toLowerCase()) >= 0);
    });
  }
  if (!candidates.length) return null;

  // Multi-token cue ("Adam Smith"): if surname is ambiguous, narrow by
  // first_name match against the leading token.
  if (tokens.length >= 2 && candidates.length > 1) {
    const firstLower = tokens[0].toLowerCase();
    const narrowed = candidates.filter(m => (m.first_name || '').toLowerCase() === firstLower);
    if (narrowed.length) candidates = narrowed;
  }

  if (chamberHint) {
    const ch = candidates.filter(m => m.chamber === chamberHint);
    if (ch.length) candidates = ch;
  }
  const stateHint = _hillExtractStateHint(text);
  if (stateHint) {
    const st = candidates.filter(m => (m.state || '').toUpperCase() === stateHint);
    if (st.length) candidates = st;
  }
  const partyHint = /republican|\bGOP\b|democrat|democratic|independent/i.exec(text);
  if (partyHint) {
    const partyKey = partyHint[0].toLowerCase();
    const matchParty = (p) => {
      p = (p || '').toLowerCase();
      if (partyKey.indexOf('republic') === 0 || partyKey === 'gop') return p === 'republican';
      if (partyKey.indexOf('democrat') === 0) return p === 'democratic';
      if (partyKey.indexOf('indep') === 0)    return p === 'independent';
      return false;
    };
    const pa = candidates.filter(m => matchParty(m.party));
    if (pa.length) candidates = pa;
  }

  if (candidates.length !== 1) return null;
  return candidates[0];
}

function _hillContextPreamble(m) {
  if (!m) return '';
  const honorific = m.chamber === 'senate' ? 'Senator' : 'Representative';
  const partyAbbr = (m.party || '').slice(0, 1).toUpperCase() || '?';
  const stateBit  = (m.state || '') + (m.district != null && m.district !== '' ? '-' + m.district : '');
  return [
    '\n\nHILL CONTEXT (auto-attached): The user is asking about a STAFFER / AIDE for ' + honorific + ' ' + (m.full_name || m.last_name || '') + ' (' + partyAbbr + '-' + stateBit + ', bioguide=' + m.bioguide_id + ').',
    'Treat the Member\'s personal office as the "organization" for any Apollo enrichment (organization_name = "Office of ' + honorific + ' ' + (m.last_name || m.full_name) + '").',
    'Prefer the Member\'s official site (' + (m.official_url || 'congress.gov') + '), legistorm.com, and rollcall.com pressroom listings for staffer roster pages.',
    'Common Hill staffer titles to watch for: Chief of Staff, Legislative Director (LD), Military Legislative Assistant (MLA), Defense Legislative Fellow / Defense Fellow, Communications Director, Press Secretary, Scheduler.',
    'Skip search_waypoint for the Member itself — Members live in hill_members; Waypoint only stores their STAFFERS as contacts linked via legislator_bioguide_id. Use search_waypoint only to check whether the staffer you find is already on file.',
    'The runner will auto-link any contact you propose to bioguide_id ' + m.bioguide_id + ' (override only if you discover the staffer actually works for a different Member). Mention the Member explicitly in the final summary.',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Anthropic API call (with one 429 retry honoring Retry-After)
// ---------------------------------------------------------------------------
async function callAnthropic(messages, systemOverride) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var not set');

  const pruned = pruneHistory(messages);
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 2048,
    system: systemOverride || SYSTEM_PROMPT,
    tools: TOOL_DEFS,
    messages: pruned,
  });

  async function once() {
    return fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body,
    });
  }

  let res = await once();
  if (res.status === 429) {
    const ra = parseInt(res.headers.get('retry-after') || '0', 10);
    // Cap wait so we don't blow Netlify's function timeout. 6s is fine for
    // per-minute limits where the quota usually resets quickly.
    const waitMs = Math.min(Math.max(ra * 1000, 4000), 6000);
    await new Promise(r => setTimeout(r, waitMs));
    res = await once();
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error('Anthropic ' + res.status + ': ' + text.slice(0, 500));
  }
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Auto-title (cheap call after first user message)
// ---------------------------------------------------------------------------
async function autoTitle(firstMessage) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_TITLE_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 30,
        messages: [{
          role: 'user',
          content: `Title this Scout search in 6 words or fewer, no quotes, no period. Just the title.\n\nSearch: ${firstMessage.slice(0, 500)}`,
        }],
      }),
    });
    const data = await res.json();
    const t = data.content?.[0]?.text?.trim().replace(/^["']|["']$/g, '').slice(0, 80);
    return t || firstMessage.slice(0, 60);
  } catch (_e) {
    return firstMessage.slice(0, 60);
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
const SCOUT_VERSION = 'v101';

// Append events to scout_jobs.events atomically via the v92 RPC. Best-effort:
// if a single batch fails we log and keep going so the loop still finishes.
async function pushEvents(jobId, evts) {
  if (!jobId || !evts || !evts.length) return;
  try {
    await supa.rpc('scout_jobs_append_events', { j: jobId, evts });
  } catch (e) {
    // Fallback: read-modify-write so a missing RPC doesn't kill the job.
    try {
      const cur = await supa.select('scout_jobs', `id=eq.${jobId}&select=events&limit=1`);
      const existing = (cur && cur[0] && cur[0].events) || [];
      await supa.update('scout_jobs', `id=eq.${jobId}`, { events: existing.concat(evts) });
    } catch (e2) {
      console.error('pushEvents failed', e2);
    }
  }
}

async function setJobStatus(jobId, patch) {
  try { await supa.update('scout_jobs', `id=eq.${jobId}`, patch); }
  catch (e) { console.error('setJobStatus failed', e); }
}

// Netlify background functions return 202 immediately and are awaited
// asynchronously. Logs go to Netlify function logs; client reads progress
// via /scout-status polling against scout_jobs.events.
exports.handler = async (event) => {
  if ((process.env.WAYPOINT_ENV || '').toLowerCase() === 'demo') {
    return { statusCode: 404, body: 'not_found' };
  }
  // Scout-disabled guard — see functions/scout.js for rationale.
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'scout_disabled',
        message: 'Set ANTHROPIC_API_KEY in your hosting environment variables. See README.md for setup.',
      }),
    };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'POST only' };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Bad JSON' }; }

  const { job_id } = payload;
  if (!job_id) return { statusCode: 400, body: 'job_id required' };

  // Background functions on Netlify can run up to 15 minutes. We do NOT
  // wait for the loop to finish before returning to the dispatcher — but
  // because this is a single Node process we just inline-await and let
  // Netlify's queue mark the function done when we return.
  await runJob(job_id);
  return { statusCode: 202, body: 'done' };
};

async function runJob(jobId) {
  const t0 = Date.now();

  // 1. Load the job row
  let job;
  try {
    const got = await supa.select('scout_jobs', `id=eq.${jobId}&select=*&limit=1`);
    job = got && got[0];
  } catch (e) {
    console.error('runJob: could not load job', jobId, e);
    return;
  }
  if (!job) {
    console.error('runJob: job not found', jobId);
    return;
  }
  if (job.status === 'completed' || job.status === 'failed') {
    console.warn('runJob: job already terminal', jobId, job.status);
    return;
  }

  await setJobStatus(jobId, { status: 'running', started_at: new Date().toISOString() });

  let totalTurns = 0;
  let totalToolCalls = 0;

  try {
    const search = await loadSearch(job.search_id);
    if (!search) throw new Error('search row missing for job ' + jobId);

    // Pull existing thread history. If this is the very first turn (a fresh
    // job created from a new user message), the user's message has already
    // been persisted by the kickoff function before this worker runs.
    let messages = await loadMessages(search.id);
    const ctx = { search_id: search.id, discoveryToolsCalled: 0 };

    // most recent message. If a senator/representative is named and
    // matches a single hill_members row, pin to scout_jobs + ctx so
    // every contact finding auto-inherits the bioguide_id AND the
    // system prompt is augmented with Hill-staffer guidance.
    let systemForJob = SYSTEM_PROMPT;
    try {
      const lastUserMsg = (messages.slice().reverse().find(m => m.role === 'user' && typeof m.content === 'string') || {}).content
        || (job && job.message) || '';
      const detected = await detectLegislator(lastUserMsg, ctx);
      if (detected) {
        ctx.legislator = detected;
        systemForJob = SYSTEM_PROMPT + _hillContextPreamble(detected);
        try {
          await supa.update('scout_jobs', `id=eq.${jobId}`, {
            legislator_bioguide_id: detected.bioguide_id,
          });
        } catch (_e) { /* non-fatal */ }
        await pushEvents(jobId, [{
          type: 'legislator_detected',
          bioguide_id: detected.bioguide_id,
          full_name: detected.full_name,
          chamber: detected.chamber,
          party: detected.party,
          state: detected.state,
          district: detected.district,
        }]);
        const tag = (detected.chamber === 'senate' ? 'Sen.' : 'Rep.')
          + ' ' + (detected.last_name || detected.full_name)
          + ' (' + ((detected.party || '?').charAt(0) || '?') + '-'
          + (detected.state || '') + (detected.district != null && detected.district !== '' ? '-' + detected.district : '')
          + ')';
        await pushEvents(jobId, [{ type: 'text', text: '_Hill context detected: ' + tag + '. Auto-linking all contact findings._' }]);
      }
    } catch (_e) { /* detection is best-effort — never fail the job */ }

    // Multi-turn loop. Each turn = one Anthropic call + (optional) parallel
    // tool execution. Loop terminates when the assistant returns without
    // tool_use, or when a budget cap fires.
    for (;;) {
      if (totalTurns >= MAX_TURNS) {
        await pushEvents(jobId, [{ type: 'text', text: '_(Scout hit its turn cap. Ask a follow-up to continue.)_' }]);
        break;
      }
      if (totalToolCalls >= MAX_TOOL_CALLS_TOTAL) {
        await pushEvents(jobId, [{ type: 'text', text: '_(Scout hit its tool-call cap. Ask a follow-up to continue.)_' }]);
        break;
      }
      if (Date.now() - t0 > TIME_BUDGET_MS) {
        await pushEvents(jobId, [{ type: 'text', text: '_(Scout hit its time budget. Ask a follow-up to continue.)_' }]);
        break;
      }

      totalTurns++;
      const turnT0 = Date.now();
      const turnEvents = [];

      const resp = await callAnthropic(messages, systemForJob);
      turnEvents.push({ type: 'assistant_turn', stop_reason: resp.stop_reason });

      // Persist the assistant message for thread history
      await supa.insert('scout_messages', {
        search_id: search.id, role: 'assistant', content: resp.content,
      });
      messages = messages.concat([{ role: 'assistant', content: resp.content }]);

      const turnText = [];
      const toolUses = [];
      for (const block of resp.content || []) {
        if (block.type === 'text' && block.text) {
          turnText.push(block.text);
        } else if (block.type === 'tool_use') {
          toolUses.push(block);
          turnEvents.push({ type: 'tool_use', tool_use_id: block.id, name: block.name, input: block.input });
        } else if (block.type === 'server_tool_use') {
          turnEvents.push({ type: 'server_tool_use', name: block.name, input: block.input });
        } else if (block.type === 'web_search_tool_result') {
          turnEvents.push({ type: 'web_search_result', content: block.content });
        }
      }
      if (turnText.length) turnEvents.push({ type: 'text', text: turnText.join('') });

      // Flush events for this turn so the polling client renders fast.
      await pushEvents(jobId, turnEvents);

      if (resp.stop_reason !== 'tool_use') break;

      // Execute every local tool_use block in parallel
      const postToolEvents = [];
      const toolResults = await Promise.all(toolUses.map(async (tu) => {
        const tStart = Date.now();
        let res, err;
        try { res = await runLocalTool(tu.name, tu.input || {}, ctx); }
        catch (e) { err = String(e.message || e); res = { result: { error: err }, summary: tu.name + ' failed' }; }
        const latency = Date.now() - tStart;
        totalToolCalls++;
        await auditToolCall(ctx, tu.name, tu.input, res, latency, err);
        postToolEvents.push({
          type: 'tool_result',
          tool_use_id: tu.id, name: tu.name,
          summary: res.summary, result: res.result, latency_ms: latency, error: err,
        });
        if (tu.name === 'propose_finding' && res.result && res.result.finding) {
          postToolEvents.push({ type: 'finding', finding: res.result.finding, matched_contact_id: res.result.matched_contact_id });
        }
        if (tu.name === 'propose_office_finding' && res.result && res.result.finding) {
          postToolEvents.push({ type: 'finding', finding: res.result.finding });
        }
        if (tu.name === 'propose_solicitation_finding' && res.result && res.result.finding) {
          postToolEvents.push({ type: 'finding', finding: res.result.finding });
        }
        if (tu.name === 'propose_office' && res.result && res.result.office_id) {
          postToolEvents.push({ type: 'office_proposed', office_id: res.result.office_id, was_created: !!res.result.was_created });
        }
        return {
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(res.result).slice(0, 3000),
          is_error: !!err,
        };
      }));

      // Persist tool_results for next turn's context
      await supa.insert('scout_messages', {
        search_id: search.id, role: 'user', content: toolResults,
      });
      messages = messages.concat([{ role: 'user', content: toolResults }]);

      postToolEvents.push({ type: 'turn_done', wall_ms: Date.now() - turnT0, tool_calls_so_far: totalToolCalls });
      await pushEvents(jobId, postToolEvents);
    }

    // loop completes, over every contact finding in this search that doesn't
    // already have a verified email. Best-effort - failures here never fail
    // the job, they just leave the un-enriched rows untouched.
    let apolloSummary = null;
    if (process.env.APOLLO_API_KEY) {
      try {
        await pushEvents(jobId, [{ type: 'text', text: '_Enriching contacts via Apollo._' }]);
        apolloSummary = await runApolloEnrichmentPass(search.id, ctx);
        await pushEvents(jobId, [{
          type: 'apollo_enrichment',
          ran: apolloSummary.ran,
          candidates: apolloSummary.candidates || 0,
          apollo_calls: apolloSummary.apollo_calls || 0,
          matched: apolloSummary.matched || 0,
          patched: apolloSummary.patched || 0,
          rate_limited: !!apolloSummary.rate_limited,
          reason: apolloSummary.reason || null,
          last_error: apolloSummary.last_error || null,
        }]);
        if (apolloSummary.ran) {
          await pushEvents(jobId, [{
            type: 'text',
            text: '_Apollo: ' + apolloSummary.matched + '/' + apolloSummary.candidates
              + ' matched, ' + apolloSummary.patched + ' findings updated._',
          }]);
        }
      } catch (e) {
        console.error('apollo enrichment pass failed', e);
        await pushEvents(jobId, [{ type: 'apollo_enrichment', ran: false, reason: 'exception: ' + (e.message || String(e)) }]);
      }
    }

    // Touch the search so the sidebar reorders.
    try { await supa.update('scout_searches', `id=eq.${search.id}`, { updated_at: new Date().toISOString() }); }
    catch (_e) {}

    await pushEvents(jobId, [{
      type: 'done',
      total_turns: totalTurns,
      total_tool_calls: totalToolCalls,
      wall_ms: Date.now() - t0,
      apollo: apolloSummary,
    }]);
    await setJobStatus(jobId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      total_turns: totalTurns,
      total_tool_calls: totalToolCalls,
    });
  } catch (e) {
    const msg = String(e.message || e);
    console.error('runJob failed', jobId, msg);
    await pushEvents(jobId, [{ type: 'error', message: msg }]);
    await setJobStatus(jobId, {
      status: 'failed',
      completed_at: new Date().toISOString(),
      total_turns: totalTurns,
      total_tool_calls: totalToolCalls,
      error: msg,
    });
  }
}

async function loadSearch(searchId) {
  if (!searchId) return null;
  const got = await supa.select('scout_searches', `id=eq.${searchId}&limit=1`);
  return got && got[0];
}

async function loadMessages(searchId) {
  const history = await supa.select('scout_messages',
    `search_id=eq.${searchId}&order=created_at.asc&select=role,content&limit=400`);
  return (history || []).map(h => ({ role: h.role, content: h.content }));
}
