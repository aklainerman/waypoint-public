// Netlify Function: scout-apollo-phone-webhook (v98).
//
// POST /.netlify/functions/scout-apollo-phone-webhook?token=<APOLLO_WEBHOOK_TOKEN>
//
// Receives Apollo's async phone-reveal callback for bulk_match calls that
// were made with reveal_phone_number=true. Apollo posts the result several
// minutes after the original request; the only correlation key in the
// payload is the matched person's Apollo id, which we previously wrote to
// scout_findings.apollo_id during the synchronous bulk_match call.
//
// Webhook payload shape (per https://docs.apollo.io/docs/retrieve-mobile-phone-numbers-for-contacts):
//   {
//     "status": "success",
//     "total_requested_enrichments": N,
//     "unique_enriched_records": M,
//     "missing_records": N-M,
//     "credits_consumed": K,
//     "people": [
//       {
//         "id": "<apollo-person-id>",
//         "status": "success" | "failed",
//         "phone_numbers": [
//           {
//             "raw_number": "+1 555-123-4567",
//             "sanitized_number": "+15551234567",
//             "type_cd": "mobile" | "work_direct_phone" | "other" | ...,
//             "confidence_cd": "high" | "medium" | "low",
//             "dnc_status_cd": "not_found" | ...,
//             "status_cd": "valid_number" | ...,
//             ...
//           }, ...
//         ]
//       }, ...
//     ]
//   }
//
// Apollo MAY retry on 5xx. This function MUST be idempotent — we dedup on
// (apollo_id, sanitized_number) in apollo_phone_webhook_log (v161 DDL adds
// a unique index for that), and we never downgrade an already-verified
// phone on a retry.
//
// Required env vars:
//   APOLLO_WEBHOOK_TOKEN     - shared secret. Compared against the ?token=
//                              query parameter. Without it the function 401s.
//   SUPABASE_URL             - already set
//   SUPABASE_SERVICE_ROLE_KEY - REQUIRED. RLS bypass for the patch.
//
// Optional env vars:
//   APOLLO_WEBHOOK_DEBUG     - "1" to echo the parsed result back in the 200
//                              response (off in prod — leaks Apollo data).

// ---------------------------------------------------------------------------
// Supabase REST helpers (independent — this function deploys alongside but
// doesn't share state with scout-background)
// ---------------------------------------------------------------------------
function supaConfig() {
  const url = process.env.SUPABASE_URL || process.env.SUPABASE_DATABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) throw new Error('Supabase env vars not set');
  return { url: url.replace(/\/+$/, ''), key };
}
async function supaRequest(method, path, body, opts) {
  opts = opts || {};
  const { url, key } = supaConfig();
  const headers = {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
  };
  if (opts.prefer) headers.Prefer = opts.prefer;
  const res = await fetch(url + '/rest/v1/' + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error('Supabase ' + method + ' ' + path + ' ' + res.status + ': ' + text.slice(0, 300));
  }
  return text ? JSON.parse(text) : null;
}
const supa = {
  select: (table, qs) => supaRequest('GET', table + '?' + qs),
  insert: (table, row, prefer) => supaRequest('POST', table, row, { prefer: prefer || 'return=representation' }),
  upsert: (table, row, conflictCol) => supaRequest(
    'POST',
    table + '?on_conflict=' + encodeURIComponent(conflictCol),
    row,
    { prefer: 'resolution=merge-duplicates,return=representation' }
  ),
  update: (table, qs, patch) => supaRequest('PATCH', table + '?' + qs, patch, { prefer: 'return=representation' }),
};

// ---------------------------------------------------------------------------
// Phone-confidence mapping
//
// Apollo's confidence_cd: 'high' | 'medium' | 'low'.
// Scout's phone_confidence enum: 'verified' | 'public_bio'.
//
// We treat 'high' as 'verified' (Apollo's high-confidence direct dials and
// mobiles are typically dialed-and-tested). Everything else stays
// 'public_bio' — still useful but with the caveat noted.
// ---------------------------------------------------------------------------
function apolloPhoneConfidence(confidence_cd) {
  if (!confidence_cd) return 'public_bio';
  const c = String(confidence_cd).toLowerCase();
  if (c === 'high') return 'verified';
  return 'public_bio';
}

// Confidence rank for comparing two candidates so we don't downgrade.
function confRank(c) {
  if (c === 'verified') return 2;
  if (c === 'public_bio') return 1;
  return 0;
}

// Pick the best phone from Apollo's array for a person. Preference order:
//   1. type_cd in (mobile, work_direct_phone) over generic/other.
//   2. confidence_cd 'high' over 'medium'/'low'.
//   3. status_cd 'valid_number' over not.
//   4. dnc_status_cd 'not_found' over flagged.
function pickBestPhone(phoneArr) {
  if (!Array.isArray(phoneArr) || !phoneArr.length) return null;
  const score = p => {
    let s = 0;
    const t = (p.type_cd || '').toLowerCase();
    if (t === 'mobile') s += 100;
    else if (t === 'work_direct_phone' || t === 'direct') s += 80;
    else if (t === 'organization') s += 10;
    else s += 50;
    const c = (p.confidence_cd || '').toLowerCase();
    if (c === 'high') s += 40;
    else if (c === 'medium') s += 20;
    if ((p.status_cd || '').toLowerCase() === 'valid_number') s += 10;
    const dnc = (p.dnc_status_cd || '').toLowerCase();
    if (dnc && dnc !== 'not_found') s -= 30;
    return s;
  };
  return phoneArr.slice().sort((a, b) => score(b) - score(a))[0];
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
exports.handler = async (event) => {
  if ((process.env.WAYPOINT_ENV || '').toLowerCase() === 'demo') {
    return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'not_found' }) };
  }
  // Apollo-disabled guard: this webhook is part of Scout's optional phone-
  // enrichment chain. Without APOLLO_API_KEY, Apollo never makes the
  // original bulk_match call that would later POST here, so this is
  // defensive — return 503 so a forker hitting the URL directly gets a
  // helpful pointer instead of a 500 from supaConfig() below.
  if (!process.env.APOLLO_API_KEY) {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'apollo_disabled',
        message: 'Set APOLLO_API_KEY in your hosting environment variables to enable Scout phone enrichment. See README.md for setup.',
      }),
    };
  }
  // CORS preflight (Apollo won't send one but local testers might)
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  // GET = health check, no auth on metadata
  if (event.httpMethod === 'GET') {
    return jsonResp(200, {
      function: 'scout-apollo-phone-webhook',
      version: 'v98',
      ready: !!(process.env.APOLLO_WEBHOOK_TOKEN && process.env.SUPABASE_URL),
      env: {
        has_webhook_token: !!process.env.APOLLO_WEBHOOK_TOKEN,
        has_supabase_url: !!process.env.SUPABASE_URL,
        has_service_role_key: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        debug: process.env.APOLLO_WEBHOOK_DEBUG === '1',
      },
    });
  }
  if (event.httpMethod !== 'POST') {
    return jsonResp(405, { error: 'POST only' });
  }

  // --- Auth: ?token=<APOLLO_WEBHOOK_TOKEN> ---
  const want = process.env.APOLLO_WEBHOOK_TOKEN || '';
  if (!want) {
    console.error('webhook called but APOLLO_WEBHOOK_TOKEN not configured');
    return jsonResp(503, { error: 'webhook not configured' });
  }
  const q = (event.queryStringParameters || {});
  const got = q.token || q.t || '';
  if (!got || !constantTimeEqual(String(got), String(want))) {
    // 401 + minimal body so port-scanners don't get hints
    console.warn('webhook auth failed; got token len:', String(got).length);
    return jsonResp(401, { error: 'auth' });
  }

  // --- Parse payload ---
  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (_e) { return jsonResp(400, { error: 'bad json' }); }

  const people = Array.isArray(payload.people) ? payload.people : [];
  if (!people.length) {
    // No-op delivery (Apollo found zero phones); ack 200 so it doesn't retry.
    return jsonResp(200, { status: 'ok', people_processed: 0, note: 'no people in payload' });
  }

  const debug = process.env.APOLLO_WEBHOOK_DEBUG === '1';
  let processed = 0, patched = 0, skipped_no_finding = 0, skipped_no_phone = 0, skipped_already_verified = 0;
  const debugRows = [];

  for (const person of people) {
    processed++;
    const apolloId = person && person.id;
    if (!apolloId) continue;

    // Find the scout_findings row. Apollo can deliver phones for a person
    // multiple times across separate API calls; we may have one or more
    // findings with this apollo_id (different searches). Patch ALL of them.
    let findings = [];
    try {
      findings = await supa.select(
        'scout_findings',
        'apollo_id=eq.' + encodeURIComponent(apolloId)
        + '&select=id,search_id,phone,phone_confidence,sources,phone_pending'
        + '&limit=20'
      );
    } catch (e) {
      console.error('lookup failed for apollo_id', apolloId, e.message || e);
      continue;
    }
    if (!findings || !findings.length) {
      skipped_no_finding++;
      // Still log the delivery so we have a forensic trail.
      await logDelivery(apolloId, null, null, person, payload, 'no_finding_for_apollo_id').catch(() => {});
      continue;
    }

    const phoneArr = Array.isArray(person.phone_numbers) ? person.phone_numbers : [];
    const best = pickBestPhone(phoneArr);
    if (!best) {
      skipped_no_phone++;
      for (const f of findings) {
        await logDelivery(apolloId, f.id, f.search_id, person, payload, 'no_phone_in_payload').catch(() => {});
        // Clear phone_pending even on empty payload — Apollo did respond.
        await supa.update('scout_findings', 'id=eq.' + encodeURIComponent(f.id), {
          phone_pending: false,
        }).catch(() => {});
      }
      continue;
    }

    const num = best.sanitized_number || best.raw_number;
    const newConf = apolloPhoneConfidence(best.confidence_cd);

    for (const f of findings) {
      const existingRank = confRank(f.phone_confidence);
      const newRank = confRank(newConf);
      // Idempotency rules:
      //  - If the row already has a phone at >= the new confidence, leave it
      //    alone (this handles Apollo retries and also the case where the
      //    user already manually-verified a phone).
      //  - Otherwise, write the new phone and bump confidence.
      const shouldPatch = (!f.phone) || (newRank > existingRank);
      const patchReason = shouldPatch
        ? (f.phone ? 'upgrade_confidence' : 'first_write')
        : 'already_at_or_above_confidence';

      if (shouldPatch) {
        const newSrc = {
          provider: 'apollo',
          url: 'https://app.apollo.io/people/' + apolloId,
          note: 'Apollo phone webhook ('
            + (best.type_cd || 'unknown') + ', '
            + (best.confidence_cd || 'unknown') + ')',
          retrieved_at: new Date().toISOString(),
          apollo_phone_type: best.type_cd || null,
          apollo_phone_confidence_cd: best.confidence_cd || null,
        };
        const sources = (Array.isArray(f.sources) ? f.sources : []).concat([newSrc]);
        try {
          await supa.update('scout_findings', 'id=eq.' + encodeURIComponent(f.id), {
            phone: num,
            phone_confidence: newConf,
            phone_pending: false,
            sources,
          });
          patched++;
        } catch (e) {
          console.error('patch failed for finding', f.id, e.message || e);
        }
      } else {
        skipped_already_verified++;
        // Still clear phone_pending so the UI stops showing the spinner.
        if (f.phone_pending) {
          await supa.update('scout_findings', 'id=eq.' + encodeURIComponent(f.id), {
            phone_pending: false,
          }).catch(() => {});
        }
      }

      await logDelivery(apolloId, f.id, f.search_id, person, payload, patchReason, num, best).catch(() => {});

      if (debug) debugRows.push({
        apollo_id: apolloId,
        finding_id: f.id,
        phone: num,
        confidence: newConf,
        patched: shouldPatch,
        reason: patchReason,
      });
    }
  }

  const body = {
    status: 'ok',
    people_processed: processed,
    patched,
    skipped_no_finding,
    skipped_no_phone,
    skipped_already_verified,
    credits_consumed: payload.credits_consumed || null,
  };
  if (debug) body.debug = debugRows;
  return jsonResp(200, body);
};

// ---------------------------------------------------------------------------
// Append a row to apollo_phone_webhook_log. Idempotent via the partial
// unique index on (apollo_id, sanitized_number) added in v161 DDL.
// ---------------------------------------------------------------------------
async function logDelivery(apolloId, findingId, searchId, person, payload, patchReason, sanitized, best) {
  best = best || {};
  const row = {
    apollo_id: apolloId,
    finding_id: findingId || null,
    search_id: searchId || null,
    sanitized_number: sanitized || null,
    raw_number: best.raw_number || null,
    confidence_cd: best.confidence_cd || null,
    type_cd: best.type_cd || null,
    status: person && person.status ? String(person.status) : null,
    raw_payload: payload || null,
    patched: patchReason === 'first_write' || patchReason === 'upgrade_confidence',
    patch_reason: patchReason,
  };
  // Use upsert against the (apollo_id, sanitized_number) unique index. On
  // retries Postgres merges instead of failing.
  return supa.upsert(
    'apollo_phone_webhook_log',
    row,
    sanitized ? 'apollo_id,sanitized_number' : 'id'
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) {
    r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return r === 0;
}
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function jsonResp(statusCode, obj) {
  return {
    statusCode,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}
