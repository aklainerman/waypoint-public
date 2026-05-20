// Netlify Function: Scout kickoff (v92).
//
// POST /.netlify/functions/scout
// Body: { search_id?: uuid, message: string, created_by?: string }
//
// Creates the scout_searches row (if needed), persists the user message,
// creates a scout_jobs row (status=queued), then fires the background
// worker (`scout-background`) fire-and-forget. Returns immediately with
// { job_id, search_id, search } so the client can start polling
// /scout-status?job_id=<id>&since=0 for events.
//
// The actual Anthropic agent loop lives in scout-background.js, which
// has 15 minutes of runtime budget instead of the 26s sync limit that
// constrained v87-v91.

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const SCOUT_VERSION = 'v101';

// ---------------------------------------------------------------------------
// Supabase REST helpers (mirror scout-background.js so this file is standalone)
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
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path} ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const supa = {
  select: (table, qs) => supaRequest('GET', `${table}?${qs}`),
  insert: (table, row) => supaRequest('POST', table, row, { prefer: 'return=representation' }),
  update: (table, qs, patch) => supaRequest('PATCH', `${table}?${qs}`, patch, { prefer: 'return=representation' }),
  rpc: (fn, args) => supaRequest('POST', `rpc/${fn}`, args || {}),
};

// ---------------------------------------------------------------------------
// Auto-title (cheap Haiku call after first user message)
// ---------------------------------------------------------------------------
async function autoTitle(firstMessage) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return firstMessage.slice(0, 60);
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
          content: 'Title this Scout search in 6 words or fewer, no quotes, no period. Just the title.\n\nSearch: ' + firstMessage.slice(0, 500),
        }],
      }),
    });
    const data = await res.json();
    const t = data.content?.[0]?.text?.trim().replace(/^["']|["']$/g, '').slice(0, 80);
    return t || firstMessage.slice(0, 60);
  } catch (_e) { return firstMessage.slice(0, 60); }
}

// ---------------------------------------------------------------------------
// Fire the background worker.
//
// Netlify visitor-access password protection, the edge intercepts every
// request — including server-to-server calls between functions — and
// returns 401 unless the request carries a valid session.
//
// Two ways the kickoff can authenticate to /scout-background:
//   (1) Forward the user's auth cookie (browser session). The user
//       already passed the password page, so their cookie is valid for
//       any path on the site, including the function URL.
//   (2) Basic Auth via NETLIFY_SITE_PASSWORD env var. Netlify accepts
//       Authorization: Basic <base64(":<password>")> as a bypass.
//
// We send BOTH when available so whichever the edge accepts first wins.
// ---------------------------------------------------------------------------
async function fireBackground(jobId, authHints) {
  const baseUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || '';
  if (!baseUrl) {
    console.warn('scout kickoff: no URL/DEPLOY_PRIME_URL/DEPLOY_URL env var, attempting relative fetch');
  }
  const target = (baseUrl || '') + '/.netlify/functions/scout-background';

  const headers = { 'Content-Type': 'application/json' };
  // Forward any Cookie header the user sent — that's their visitor-access
  // session from the password page.
  if (authHints && authHints.cookie) headers.Cookie = authHints.cookie;
  // Add Basic Auth fallback if NETLIFY_SITE_PASSWORD is configured. Netlify's
  // password protection accepts Basic Auth with empty username + the password.
  const sitePw = process.env.NETLIFY_SITE_PASSWORD || process.env.SITE_PASSWORD || '';
  if (sitePw) {
    headers.Authorization = 'Basic ' + Buffer.from(':' + sitePw, 'utf8').toString('base64');
  }

  try {
    const r = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify({ job_id: jobId }),
    });
    if (r.status !== 202 && !r.ok) {
      const txt = await r.text().catch(() => '');
      const hint = (r.status === 401)
        ? ' [HINT: site password is blocking the call. Set NETLIFY_SITE_PASSWORD env var on Netlify to match your visitor-access password, or ensure the user\'s browser session cookie is forwarded.]'
        : '';
      throw new Error('scout-background returned ' + r.status + (txt ? (': ' + txt.slice(0, 200)) : '') + hint);
    }
    return { ok: true, status: r.status };
  } catch (e) {
    console.error('scout-background dispatch failed', e.message || e);
    throw e;
  }
}


// ---------------------------------------------------------------------------
// Auth gate: every /scout call requires a valid Supabase user JWT.
//
// Forked deployments are public-internet-reachable; without this gate any
// stranger who guesses the URL can drain the deployer's Anthropic credits.
// We verify the token by calling Supabase's /auth/v1/user endpoint with the
// caller's bearer + the project's anon (publishable) key. Latency is ~80-150ms
// per request which is negligible against a multi-minute agent loop.
// ---------------------------------------------------------------------------
function supaAuthConfig() {
  const url = process.env.SUPABASE_URL || process.env.SUPABASE_DATABASE_URL || '';
  // The /auth/v1/user endpoint expects the project's anon/publishable key in
  // the apikey header. service_role works too but is semantically wrong.
  const anon = process.env.SUPABASE_ANON_KEY
            || process.env.SUPABASE_PUBLISHABLE_KEY
            || process.env.SUPABASE_KEY
            || '';
  return { url: url.replace(/\/+$/, ''), anon };
}

async function requireAuth(event) {
  const hdr = (event && event.headers
              && (event.headers.authorization || event.headers.Authorization)) || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(hdr).trim());
  if (!m) {
    return { ok: false, status: 401, body: { error: 'unauthorized', message: 'Authorization: Bearer <token> required.' } };
  }
  const token = m[1];
  const { url, anon } = supaAuthConfig();
  if (!url || !anon) {
    return { ok: false, status: 500, body: { error: 'auth_misconfigured', message: 'Supabase URL or anon key not set.' } };
  }
  try {
    const r = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      return { ok: false, status: 401, body: { error: 'invalid_token', message: 'Token rejected by Supabase auth (' + r.status + ').' } };
    }
    const user = await r.json();
    return { ok: true, user };
  } catch (e) {
    return { ok: false, status: 502, body: { error: 'auth_check_failed', message: String(e.message || e) } };
  }
}

// ---------------------------------------------------------------------------
// Main kickoff handler
// ---------------------------------------------------------------------------
exports.handler = async (event) => {
  // Demo-mode guard: Scout endpoints return 404 in the public demo env.
  // Belt-and-suspenders alongside the client-side hide; the runtime env
  // var is authoritative regardless of what the caller asserts.
  if ((process.env.WAYPOINT_ENV || '').toLowerCase() === 'demo') {
    return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'not_found' }) };
  }
  // Scout-disabled guard: if no Anthropic API key, the Scout function is
  // inert. The client hides the Scout UI when functions/config.js reports
  // scoutAvailable=false, so this path should never fire in practice — but
  // we 503 defensively if a forker hits the endpoint directly.
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
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  // Auth gate — every non-preflight Scout call must carry a valid Supabase
  // user JWT. See requireAuth() comment for rationale.
  const _auth = await requireAuth(event);
  if (!_auth.ok) {
    return {
      statusCode: _auth.status,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(_auth.body),
    };
  }

  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: SCOUT_VERSION,
        mode: 'kickoff',
        worker: '/.netlify/functions/scout-background',
        status_endpoint: '/.netlify/functions/scout-status',
        env: {
          has_anthropic_key: !!process.env.ANTHROPIC_API_KEY,
          has_sam_key: !!process.env.SAM_GOV_API_KEY,
          has_dvids_key: !!process.env.DVIDS_API_KEY,
          has_apollo_key: !!process.env.APOLLO_API_KEY,
          apollo_reveal_personal_emails: process.env.APOLLO_REVEAL_PERSONAL_EMAILS === '1',
          apollo_reveal_phone: process.env.APOLLO_REVEAL_PHONE === '1',
          has_apollo_webhook_url: !!process.env.APOLLO_WEBHOOK_URL,
          has_apollo_webhook_token: !!process.env.APOLLO_WEBHOOK_TOKEN,
          has_url: !!(process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL),
        },
      }),
    };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: 'POST only' };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: corsHeaders(), body: 'Bad JSON' }; }

  const { search_id: existingSearchId, message, created_by } = payload;
  if (!message || typeof message !== 'string') {
    return { statusCode: 400, headers: corsHeaders(), body: 'message required' };
  }

  try {
    // 1. Get or create scout_searches row
    let search;
    if (existingSearchId) {
      const got = await supa.select('scout_searches', `id=eq.${existingSearchId}&limit=1`);
      search = got && got[0];
    }
    if (!search) {
      const title = await autoTitle(message);
      const ins = await supa.insert('scout_searches', {
        title, created_by: created_by || null,
      });
      search = ins && ins[0];
    }

    // 2. Persist the user message NOW so the worker sees it on first read.
    await supa.insert('scout_messages', {
      search_id: search.id, role: 'user', content: message,
    });

    // 3. Create the job row
    const jobIns = await supa.insert('scout_jobs', {
      search_id: search.id,
      status: 'queued',
      message,
      created_by: created_by || null,
    });
    const job = jobIns && jobIns[0];
    if (!job) throw new Error('Could not create scout_jobs row');

    // 4. Fire the background worker AND await the dispatch (v93 fix).
    //    Netlify acks with 202 quickly; without the await the un-awaited
    //    promise was getting killed when the handler returned, so the
    //    worker never started and the job sat in 'queued' forever.
    //
    //    Netlify edge doesn't block the inter-function call when site
    //    visitor-access password protection is enabled.
    const incomingCookie = (event.headers && (event.headers.cookie || event.headers.Cookie)) || '';
    let fireOk = false;
    try {
      await fireBackground(job.id, { cookie: incomingCookie });
      fireOk = true;
    } catch (fireErr) {
      // Mark the job failed and surface the reason to the client so it
      // doesn't poll forever waiting on a worker that won't run.
      try {
        await supa.update('scout_jobs', `id=eq.${job.id}`, {
          status: 'failed',
          error: 'Background worker dispatch failed: ' + (fireErr.message || fireErr),
          completed_at: new Date().toISOString(),
        });
      } catch (_e) { /* best-effort */ }
    }

    // Push a kickoff_fired event so polling clients see ANY activity
    // immediately and can distinguish "worker dispatched" from
    // "worker stuck before starting".
    try {
      await supa.rpc('scout_jobs_append_events', {
        j: job.id,
        evts: [{ type: 'kickoff_fired', dispatched: fireOk, ts: new Date().toISOString() }],
      });
    } catch (_e) { /* RPC missing? non-fatal */ }

    // 5. Touch the search so the sidebar shows it on top.
    try { await supa.update('scout_searches', `id=eq.${search.id}`, { updated_at: new Date().toISOString() }); }
    catch (_e) {}

    return {
      statusCode: 202,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: job.id,
        search_id: search.id,
        search,
        dispatched: fireOk,
      }),
    };
  } catch (e) {
    console.error('scout kickoff failed', e);
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
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
