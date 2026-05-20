// Netlify Function: Scout job status reader (v92).
//
// GET /.netlify/functions/scout-status?job_id=<uuid>&since=<int>
//
// Returns the current scout_jobs row state plus events.slice(since).
// The client polls this every ~1.5s until status === 'completed' or 'failed'.

function supaConfig() {
  const url = process.env.SUPABASE_URL || process.env.SUPABASE_DATABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_KEY || '';
  if (!url || !key) throw new Error('Supabase env vars not set');
  return { url: url.replace(/\/+$/, ''), key };
}

async function supaSelect(path) {
  const { url, key } = supaConfig();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${path} ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}


// ---------------------------------------------------------------------------
// Auth gate — see functions/scout.js for the full rationale. Same helper,
// duplicated here to keep each function self-contained.
// ---------------------------------------------------------------------------
function supaAuthConfig() {
  const url = process.env.SUPABASE_URL || process.env.SUPABASE_DATABASE_URL || '';
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

exports.handler = async (event) => {
  if ((process.env.WAYPOINT_ENV || '').toLowerCase() === 'demo') {
    return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'not_found' }) };
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

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders(), body: 'GET only' };
  }

  const qs = event.queryStringParameters || {};
  const jobId = qs.job_id;
  const since = parseInt(qs.since || '0', 10) || 0;
  if (!jobId) {
    return { statusCode: 400, headers: corsHeaders(), body: 'job_id required' };
  }

  try {
    const rows = await supaSelect(`scout_jobs?id=eq.${jobId}&select=id,search_id,status,events,total_turns,total_tool_calls,error,started_at,completed_at,updated_at&limit=1`);
    const job = rows && rows[0];
    if (!job) {
      return {
        statusCode: 404,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'job not found' }),
      };
    }
    const allEvents = Array.isArray(job.events) ? job.events : [];
    const newEvents = allEvents.slice(since);
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders(),
        'Content-Type': 'application/json',
        // Encourage no caching anywhere along the wire — each poll must
        // see the latest state.
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
      body: JSON.stringify({
        job_id: job.id,
        search_id: job.search_id,
        status: job.status,
        events: newEvents,
        total_events: allEvents.length,
        next_since: allEvents.length,
        total_turns: job.total_turns,
        total_tool_calls: job.total_tool_calls,
        error: job.error || null,
        started_at: job.started_at,
        completed_at: job.completed_at,
        updated_at: job.updated_at,
      }),
    };
  } catch (e) {
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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
