#!/usr/bin/env python3
"""seed_one_local.py - copy specific tables from Stage to DEMO.

Self-contained (stdlib only, no pip install needed). Pass tables as argv.

Env vars (all required):
  STAGE_URL        e.g. https://<YOUR_STAGE_PROJECT_REF>.supabase.co
  STAGE_ANON       Stage's anon publishable key
  DEMO_URL         e.g. https://<YOUR_DEMO_PROJECT_REF>.supabase.co
  DEMO_SERVICE     DEMO's service_role key (bypasses RLS for write)

Optional:
  BATCH_SIZE       rows per request (default 1000; reduce for narratives)
  OFFSET           skip this many rows on Stage (default 0; useful for resume)
  ORDER_BY         column for stable pagination (default 'id')

Example:
  set STAGE_URL=https://<YOUR_STAGE_PROJECT_REF>.supabase.co
  set STAGE_ANON=eyJhbGc...
  set DEMO_URL=https://<YOUR_DEMO_PROJECT_REF>.supabase.co
  set DEMO_SERVICE=eyJhbGc... (service_role)
  set BATCH_SIZE=100
  set ORDER_BY=pe_id
  python seed_one_local.py pe_narratives
"""
import os, sys, json, time, urllib.request, urllib.error, urllib.parse

STAGE_URL    = os.environ['STAGE_URL'].rstrip('/')
STAGE_ANON   = os.environ['STAGE_ANON']
DEMO_URL     = os.environ['DEMO_URL'].rstrip('/')
DEMO_SERVICE = os.environ['DEMO_SERVICE']

# Columns to NULL on the copy (e.g. strip "notes" from offices for DEMO).
NULLS = {'offices': ['notes']}

BATCH = int(os.environ.get('BATCH_SIZE', '1000'))
START = int(os.environ.get('OFFSET', '0'))
ORDER = os.environ.get('ORDER_BY', 'id')
TIMEOUT = 90


def http(method, url, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, r.read().decode('utf-8', 'replace'), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8', 'replace') if e.fp else '', dict(e.headers or {})


def copy_one(table):
    nulls = NULLS.get(table, [])
    total = 0
    offset = START
    t0 = time.time()
    while True:
        url = f"{STAGE_URL}/rest/v1/{urllib.parse.quote(table)}?select=*&order={ORDER}.asc"
        h = {
            'apikey': STAGE_ANON,
            'Authorization': f'Bearer {STAGE_ANON}',
            'Range-Unit': 'items',
            'Range': f'{offset}-{offset+BATCH-1}',
        }
        code, body, _ = http('GET', url, headers=h)
        if code not in (200, 206):
            print(f"  ERR {table} GET offset={offset} -> {code}: {body[:300]}", flush=True)
            return False
        rows = json.loads(body) if body else []
        if not rows:
            break
        for col in nulls:
            for r in rows:
                if col in r:
                    r[col] = None
        url2 = f"{DEMO_URL}/rest/v1/{urllib.parse.quote(table)}"
        h2 = {
            'apikey': DEMO_SERVICE,
            'Authorization': f'Bearer {DEMO_SERVICE}',
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal,resolution=ignore-duplicates',
        }
        code2, body2, _ = http('POST', url2, body=rows, headers=h2)
        if code2 not in (200, 201, 204):
            print(f"  ERR {table} POST offset={offset} -> {code2}: {body2[:600]}", flush=True)
            return False
        total += len(rows)
        print(f"  ... {table} offset={offset} batch={len(rows)} total={total} ({time.time()-t0:.1f}s)", flush=True)
        if len(rows) < BATCH:
            break
        offset += BATCH
    print(f"  OK  {table}: {total} rows in {time.time()-t0:.1f}s", flush=True)
    return True


if __name__ == '__main__':
    tables = sys.argv[1:]
    if not tables:
        print("Usage: seed_one_local.py <table> [table2 ...]")
        sys.exit(2)
    ok = True
    for t in tables:
        if not copy_one(t):
            ok = False
    sys.exit(0 if ok else 1)
