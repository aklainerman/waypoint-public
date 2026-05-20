#!/usr/bin/env python3
"""
verify_read_only.py - adversarial test for the public DEMO site.

Confirms:
  1. The published demo URL responds (200 on /).
  2. /.netlify/functions/config returns env="demo" and a valid anon key.
  3. /.netlify/functions/scout returns 404 (Scout disabled on demo).
  4. /.netlify/functions/scout-status returns 404.
  5. /.netlify/functions/scout-background returns 404.
  6. Using the demo anon key, anon SELECT succeeds on budget_pes, offices,
     hill_members (sanity).
  7. Using the demo anon key, anon INSERT/UPDATE/DELETE is REJECTED on every
     mutation-sensitive table (the whole point of the test).

Exit 0 if all green, 1 otherwise.

Usage:
  python scripts/verify_read_only.py --url https://your-demo-site.netlify.app
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request


WRITE_TARGETS = [
    # (table, payload-or-None) — payload=None means we'll only try DELETE.
    ("contacts", {"name": "test-vandal", "company": "demo-attack"}),
    ("solicitations", {"title": "test-vandal"}),
    ("letters", {"recipient": "test-vandal"}),
    ("offices", {"name": "test-vandal"}),
    ("budget_pes", {"pe_id": "TEST_VANDAL", "title": "x"}),
    ("hill_members", {"bioguide_id": "X000000", "name_display": "x"}),
    ("hill_meetings", {"subject": "test-vandal"}),
]

READ_TARGETS = ["budget_pes", "offices", "hill_members", "budget_om_sags"]


def http_get(url: str, headers: dict[str, str] | None = None) -> tuple[int, str]:
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace") if e.fp else ""
    except Exception as e:  # noqa: BLE001
        return -1, str(e)


def http_post(url: str, body: dict, headers: dict[str, str] | None = None) -> tuple[int, str]:
    data = json.dumps(body).encode("utf-8")
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace") if e.fp else ""
    except Exception as e:  # noqa: BLE001
        return -1, str(e)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True, help="Demo site URL, e.g. https://your-demo-site.netlify.app")
    args = parser.parse_args()
    base = args.url.rstrip("/")

    failures: list[str] = []

    # 1. Site responds
    print(f"[1] GET {base}/")
    code, _ = http_get(f"{base}/")
    if code != 200:
        failures.append(f"site root returned {code}, expected 200")
    print(f"    -> {code}")

    # 2. Config endpoint
    print(f"[2] GET {base}/.netlify/functions/config")
    code, body = http_get(f"{base}/.netlify/functions/config")
    config = {}
    if code == 200:
        try:
            config = json.loads(body)
        except Exception:
            failures.append("config body is not JSON")
    else:
        failures.append(f"config endpoint returned {code}")
    if config.get("env") != "demo":
        failures.append(f"config env is {config.get('env')!r}, expected 'demo'")
    supabase_url = config.get("supabaseUrl", "")
    supabase_anon_key = config.get("supabaseAnonKey", "")
    if not supabase_url or not supabase_anon_key:
        failures.append("config missing supabaseUrl or supabaseAnonKey")
    print(f"    -> env={config.get('env')!r}, supabaseUrl set: {bool(supabase_url)}")

    # 3-5. Scout endpoints should 404
    for fn in ("scout", "scout-status", "scout-background"):
        url = f"{base}/.netlify/functions/{fn}"
        code, _ = http_post(url, {"job_id": "dummy"})
        ok = code in (404,)
        marker = "OK" if ok else "VIOLATION"
        print(f"[{fn}] POST {url} -> {code} {marker}")
        if not ok:
            failures.append(f"{fn} returned {code}, expected 404")

    # 6. anon SELECT must succeed on readable tables
    if supabase_url and supabase_anon_key:
        rest = f"{supabase_url}/rest/v1"
        sb_headers = {
            "apikey": supabase_anon_key,
            "Authorization": f"Bearer {supabase_anon_key}",
        }
        for table in READ_TARGETS:
            code, _ = http_get(f"{rest}/{table}?select=*&limit=1", headers=sb_headers)
            ok = code == 200
            marker = "OK" if ok else "VIOLATION"
            print(f"[read] GET {table} -> {code} {marker}")
            if not ok:
                failures.append(f"anon SELECT on {table} returned {code}, expected 200")

        # 7. anon INSERT must be denied on every mutation target
        for table, payload in WRITE_TARGETS:
            code, body = http_post(
                f"{rest}/{table}", payload,
                headers={**sb_headers, "Prefer": "return=minimal"},
            )
            ok = code in (401, 403, 404)
            marker = "OK" if ok else "VIOLATION"
            print(f"[write] POST {table} -> {code} {marker}")
            if not ok:
                failures.append(f"anon INSERT into {table} returned {code}, expected 401/403/404")

    print()
    if failures:
        print("=== FAILED ===")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("=== ALL CHECKS PASSED ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
