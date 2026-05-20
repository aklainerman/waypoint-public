// Netlify Function: Hill Ops sync (v108).
//
//   - photo_url switched from theunitedstates.io to bioguide.congress.gov
//     (more reliable for browser rendering; the user reported missing
//     photos from v107).
//   - bio_summary now computed: "{N}-term {Senator|Representative} from
//     {state}{-district}. In Congress since {year} ({Y} years)."
//   - Defensive subcommittee thomas_id: if sc.thomas_id already starts
//     with parent.thomas_id, use as-is; otherwise concat. Handles both
//     legacy and current YAML shapes.
//   - Dry run now reports `subc_orphans` — subcommittee thomas_ids in
//     hill_committees with NO matching rows in hill_committee_memberships.
//   - Adds bio_summary to the member row (column already exists).
//
// POST /.netlify/functions/hill-sync           -> manual sync
// GET  /.netlify/functions/hill-sync?dry=1     -> dry run, returns trace
//                                                 + subc_orphans report

const yaml = require('js-yaml');

const SYNC_VERSION = 'v108';

const FEED_LEGISLATORS = [
  ['https://raw.githubusercontent.com/unitedstates/congress-legislators/main/legislators-current.yaml', 'yaml'],
  ['https://theunitedstates.io/congress-legislators/legislators-current.json', 'json'],
];
const FEED_COMMITTEES = [
  ['https://raw.githubusercontent.com/unitedstates/congress-legislators/main/committees-current.yaml', 'yaml'],
  ['https://theunitedstates.io/congress-legislators/committees-current.json', 'json'],
];
const FEED_MEMBERSHIPS = [
  ['https://raw.githubusercontent.com/unitedstates/congress-legislators/main/committee-membership-current.yaml', 'yaml'],
  ['https://theunitedstates.io/congress-legislators/committee-membership-current.json', 'json'],
];

// bioguide.congress.gov hosts member photos at a stable URL pattern.
// Format: /bioguide/photo/{first letter of bioguide id}/{bioguide id}.jpg
function photoUrl(bg) {
  if (!bg) return null;
  const first = String(bg).charAt(0).toUpperCase();
  return 'https://bioguide.congress.gov/bioguide/photo/' + first + '/' + bg + '.jpg';
}

const CG_BASE = 'https://api.congress.gov/v3';

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------
function supaConfig() {
  const url = process.env.SUPABASE_URL || process.env.SUPABASE_DATABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
           || process.env.SUPABASE_ANON_KEY
           || process.env.SUPABASE_PUBLISHABLE_KEY
           || process.env.SUPABASE_KEY
           || '';
  if (!url || !key) throw new Error('Supabase env vars not set (need SUPABASE_URL + SUPABASE_*_KEY)');
  return { url: url.replace(/\/+$/, ''), key };
}
async function supaRequest(method, path, body, opts) {
  opts = opts || {};
  const cfg = supaConfig();
  const headers = {
    apikey: cfg.key,
    Authorization: 'Bearer ' + cfg.key,
    'Content-Type': 'application/json',
  };
  if (opts.prefer) headers.Prefer = opts.prefer;
  const res = await fetch(cfg.url + '/rest/v1/' + path, {
    method: method, headers: headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Supabase ' + method + ' ' + path + ' ' + res.status + ': ' + text.slice(0, 400));
  return text ? JSON.parse(text) : null;
}
async function supaUpsert(table, rows, conflictCol) {
  if (!rows.length) return { inserted: 0 };
  const CHUNK = 200;
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await supaRequest('POST', table + '?on_conflict=' + encodeURIComponent(conflictCol), slice, { prefer: 'resolution=merge-duplicates,return=minimal' });
    total += slice.length;
  }
  return { inserted: total };
}
async function supaDelete(table, qs) {
  return supaRequest('DELETE', table + '?' + qs, null, { prefer: 'return=minimal' });
}

// ---------------------------------------------------------------------------
// Fetch chain
// ---------------------------------------------------------------------------
const ATTEMPTS = 2;
const ATTEMPT_BACKOFF_MS = [0, 1500];
const ATTEMPT_TIMEOUT_MS = 6000;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function fetchOne(url, parser, label, trace) {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (ATTEMPT_BACKOFF_MS[attempt]) await sleep(ATTEMPT_BACKOFF_MS[attempt]);
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          Accept: parser === 'json' ? 'application/json' : 'text/plain, application/yaml, */*',
          'User-Agent': 'Waypoint-HillSync/' + SYNC_VERSION + ' (+netlify-function)',
        },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (!res.ok) {
        if (trace) trace.push(label + ' [try ' + (attempt + 1) + '/' + ATTEMPTS + '] ' + url + ' -> HTTP ' + res.status + ' in ' + ms + 'ms');
        if (res.status >= 400 && res.status < 500) return { ok: false, label: label, url: url, error: 'HTTP ' + res.status };
        continue;
      }
      let data;
      if (parser === 'json') data = await res.json();
      else if (parser === 'yaml') {
        const text = await res.text();
        data = yaml.load(text, { json: true });
      } else throw new Error('unknown parser: ' + parser);
      if (trace) trace.push(label + ' OK <- ' + url + ' (' + ms + 'ms, parser=' + parser + ', ' + (Array.isArray(data) ? data.length + ' items' : Object.keys(data).length + ' keys') + ', try ' + (attempt + 1) + ')');
      return { ok: true, data: data };
    } catch (e) {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      if (trace) trace.push(label + ' [try ' + (attempt + 1) + '/' + ATTEMPTS + '] ' + url + ' -> ' + (e.code || e.name || '') + ' ' + e.message + ' (' + ms + 'ms)');
    }
  }
  return { ok: false, label: label, url: url, error: 'all ' + ATTEMPTS + ' attempts failed (network/timeout)' };
}

async function fetchChain(urls, label, trace) {
  const errs = [];
  for (let i = 0; i < urls.length; i++) {
    const r = await fetchOne(urls[i][0], urls[i][1], label + '[' + i + ']', trace);
    if (r.ok) return r.data;
    errs.push(label + '[' + i + '] ' + urls[i][0] + ' -> ' + r.error);
  }
  throw new Error(label + ' ALL urls failed: ' + errs.join(' | '));
}

async function fetchCgCommitteeSystemCodes(congressNumber, trace) {
  const apiKey = process.env.CONGRESS_GOV_API_KEY;
  if (!apiKey) {
    if (trace) trace.push('CG enrichment SKIPPED (no CONGRESS_GOV_API_KEY)');
    return {};
  }
  const out = {};
  const chambers = ['house', 'senate', 'joint'];
  for (let ci = 0; ci < chambers.length; ci++) {
    const chamber = chambers[ci];
    let offset = 0;
    while (offset < 500) {
      const url = CG_BASE + '/committee/' + congressNumber + '/' + chamber + '?api_key=' + apiKey + '&limit=250&offset=' + offset + '&format=json';
      try {
        const r = await fetch(url);
        if (!r.ok) { if (trace) trace.push('CG ' + chamber + ' HTTP ' + r.status); break; }
        const data = await r.json();
        const list = data.committees || [];
        for (let j = 0; j < list.length; j++) {
          const c = list[j];
          if (c.systemCode) {
            const tk = c.systemCode.replace(/0+$/, '').toUpperCase();
            out[tk] = c.systemCode;
          }
        }
        if (list.length < 250) break;
        offset += 250;
      } catch (e) {
        if (trace) trace.push('CG ' + chamber + ' fetch threw: ' + e.message);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Defensive subcommittee thomas_id resolution.
// In committees-current.yaml subcommittees are usually:
//     thomas_id: '14'        -> we prefix with parent: 'HSAG' + '14' = 'HSAG14'
// But occasionally we see:
//     thomas_id: 'HSAG14'    -> already full; use as-is
// committee-membership-current.yaml ALWAYS uses the full key.
// ---------------------------------------------------------------------------
function fullSubcommitteeId(parentThomasId, scThomasId) {
  const sid = String(scThomasId == null ? '' : scThomasId);
  const pid = String(parentThomasId);
  if (sid.toUpperCase().startsWith(pid.toUpperCase())) return sid;
  return pid + sid;
}

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------
function buildMemberRow(leg) {
  const id = leg.id || {};
  const name = leg.name || {};
  const terms = leg.terms || [];
  const cur = terms[terms.length - 1] || {};
  const chamber = cur.type === 'sen' ? 'senate' : cur.type === 'rep' ? 'house' : null;
  if (!chamber) return null;

  // Tenure stats
  const earliestStart = terms.reduce(function (acc, t) {
    const s = t && t.start ? String(t.start) : '';
    return (s && (!acc || s < acc)) ? s : acc;
  }, '');
  const firstYear = earliestStart ? parseInt(earliestStart.slice(0, 4), 10) : null;
  const thisYear = new Date().getFullYear();
  const yearsServed = firstYear ? (thisYear - firstYear) : null;

  // Build a one-liner bio
  const bits = [];
  const titlePrefix = chamber === 'senate' ? 'Senator' : 'Representative';
  bits.push(titlePrefix);
  if (cur.state) bits.push('from ' + cur.state + (chamber === 'house' && cur.district != null ? '-' + cur.district : ''));
  if (firstYear) {
    if (yearsServed != null && yearsServed > 0) {
      bits.push('serving since ' + firstYear + ' (' + yearsServed + ' years, ' + terms.length + ' terms)');
    } else {
      bits.push('elected in ' + firstYear);
    }
  }
  const bio = bits.join(', ') + '.';

  const partyMap = { Republican: 'Republican', Democrat: 'Democratic', Democratic: 'Democratic', Independent: 'Independent' };

  return {
    bioguide_id:      id.bioguide,
    full_name:        name.official_full || ((name.first || '') + ' ' + (name.last || '')).trim(),
    first_name:       name.first || null,
    last_name:        name.last || null,
    chamber:          chamber,
    party:            partyMap[cur.party] || cur.party || null,
    state:            cur.state || null,
    district:         (chamber === 'house' && cur.district !== undefined && cur.district !== null) ? Number(cur.district) : null,
    term_start:       cur.start ? String(cur.start) : null,
    term_end:         cur.end ? String(cur.end) : null,
    office_address:   cur.office || null,
    office_phone:     cur.phone || null,
    contact_form_url: cur.contact_form || null,
    official_url:     cur.url || null,
    photo_url:        photoUrl(id.bioguide),
    bio_summary:      bio,
    leadership_title: null,
    source:           'unitedstates+congress.gov',
    last_synced_at:   new Date().toISOString(),
  };
}

function flattenCommittees(commTree) {
  const rows = [];
  for (let i = 0; i < commTree.length; i++) {
    const c = commTree[i];
    const chamber = (c.type === 'house') ? 'house' : (c.type === 'senate') ? 'senate' : 'joint';
    rows.push({
      thomas_id:        String(c.thomas_id),
      system_code:      null,
      name:             c.name,
      chamber:          chamber,
      type:             c.subcommittees ? 'standing' : (c.type || 'standing'),
      parent_thomas_id: null,
      url:              c.url || null,
      jurisdiction:     c.jurisdiction || null,
      last_synced_at:   new Date().toISOString(),
    });
    const subs = c.subcommittees || [];
    for (let j = 0; j < subs.length; j++) {
      const sc = subs[j];
      rows.push({
        thomas_id:        fullSubcommitteeId(c.thomas_id, sc.thomas_id),
        system_code:      null,
        name:             sc.name,
        chamber:          chamber,
        type:             'subcommittee',
        parent_thomas_id: String(c.thomas_id),
        url:              sc.url || null,
        jurisdiction:     null,
        last_synced_at:   new Date().toISOString(),
      });
    }
  }
  return rows;
}

function flattenMemberships(map, validBioguides) {
  const rows = [];
  const keys = Object.keys(map);
  for (let i = 0; i < keys.length; i++) {
    const committeeKey = String(keys[i]);
    const members = map[committeeKey];
    if (!Array.isArray(members)) continue;
    for (let j = 0; j < members.length; j++) {
      const m = members[j];
      const bioguide = m.bioguide;
      if (!bioguide || !validBioguides.has(bioguide)) continue;
      let role = 'Member';
      if (m.title === 'Chair' || m.title === 'Chairman' || m.title === 'Chairwoman') role = 'Chair';
      else if (m.title === 'Ranking Member') role = 'Ranking Member';
      else if (m.title === 'Vice Chair' || m.title === 'Vice Chairman' || m.title === 'Vice Chairwoman') role = 'Vice Chair';
      else if (m.title) role = m.title;
      rows.push({
        bioguide_id: bioguide,
        thomas_id:   committeeKey,
        role:        role,
        rank:        Number.isFinite(m.rank) ? m.rank : null,
        side:        m.party === 'majority' ? 'majority' : (m.party === 'minority' ? 'minority' : null),
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Diagnostic: count subcommittee committees that have NO membership rows.
// ---------------------------------------------------------------------------
function findOrphanSubcommittees(committeeRows, membershipRows) {
  const haveMembers = new Set(membershipRows.map(function (r) { return r.thomas_id; }));
  const orphans = [];
  for (let i = 0; i < committeeRows.length; i++) {
    const c = committeeRows[i];
    if (c.parent_thomas_id && !haveMembers.has(c.thomas_id)) {
      orphans.push({ thomas_id: c.thomas_id, parent: c.parent_thomas_id, name: c.name });
    }
  }
  return orphans;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
exports.handler = async function (event) {
  const startedAt = Date.now();
  const qs = (event && event.queryStringParameters) || {};
  const isDry = qs.dry === '1' || qs.debug === '1';
  const trace = [];

  try {
    const results = await Promise.all([
      fetchChain(FEED_LEGISLATORS, 'legislators', trace),
      fetchChain(FEED_COMMITTEES,  'committees',  trace),
      fetchChain(FEED_MEMBERSHIPS, 'memberships', trace),
    ]);
    const legislators = results[0];
    const committees  = results[1];
    const memberships = results[2];

    const memberRows = legislators.map(buildMemberRow).filter(function (r) { return r && r.bioguide_id; });
    const validBioguides = new Set(memberRows.map(function (r) { return r.bioguide_id; }));
    const committeeRows = flattenCommittees(committees);
    const congressNumber = process.env.CONGRESS_NUMBER || '119';
    const cgSystemCodes = await fetchCgCommitteeSystemCodes(congressNumber, trace);
    for (let i = 0; i < committeeRows.length; i++) {
      const c = committeeRows[i];
      const key = c.thomas_id.toUpperCase();
      if (cgSystemCodes[key]) c.system_code = cgSystemCodes[key];
    }
    const membershipRows = flattenMemberships(memberships, validBioguides);
    const orphans = findOrphanSubcommittees(committeeRows, membershipRows);

    if (isDry) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true, dry: true, version: SYNC_VERSION, ms: Date.now() - startedAt,
          counts: {
            members: memberRows.length, committees: committeeRows.length,
            subcommittees: committeeRows.filter(function (c) { return c.parent_thomas_id; }).length,
            memberships: membershipRows.length,
            membership_keys: Object.keys(memberships).length,
            cg_system_codes: Object.keys(cgSystemCodes).length,
            subc_orphans: orphans.length,
          },
          subc_orphans_sample: orphans.slice(0, 10),
          membership_keys_sample: Object.keys(memberships).filter(function (k) { return /\d/.test(k); }).slice(0, 10),
          trace: trace,
          sample: {
            member: memberRows[0] || null,
            committee: committeeRows[0] || null,
            subcommittee: committeeRows.find(function (c) { return c.parent_thomas_id; }) || null,
            membership: membershipRows[0] || null,
          },
        }, null, 2),
      };
    }

    trace.push('writing to Supabase...');
    trace.push('subc_orphans: ' + orphans.length + (orphans.length ? ' (sample: ' + orphans.slice(0, 3).map(function (o) { return o.thomas_id; }).join(', ') + ')' : ''));
    const memOut  = await supaUpsert('hill_members',    memberRows,    'bioguide_id');
    const comOut  = await supaUpsert('hill_committees', committeeRows, 'thomas_id');
    await supaDelete('hill_committee_memberships', 'bioguide_id=not.is.null');
    const mshipOut = await supaUpsert('hill_committee_memberships', membershipRows, 'bioguide_id,thomas_id');

    const summary = {
      ok: true, version: SYNC_VERSION, ms: Date.now() - startedAt,
      counts: {
        members: memOut.inserted, committees: comOut.inserted,
        memberships: mshipOut.inserted,
        cg_system_codes: Object.keys(cgSystemCodes).length,
        subc_orphans: orphans.length,
      },
      trace: trace,
      timestamp: new Date().toISOString(),
    };
    console.log('[hill-sync] ok', JSON.stringify(summary));
    return { statusCode: 200, body: JSON.stringify(summary) };
  } catch (e) {
    const out = { ok: false, version: SYNC_VERSION, error: e.message, trace: trace, ms: Date.now() - startedAt };
    console.error('[hill-sync] FAIL', JSON.stringify(out));
    return { statusCode: 500, body: JSON.stringify(out) };
  }
};
