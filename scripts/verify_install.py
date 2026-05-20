#!/usr/bin/env python3
"""
scripts/verify_install.py -- post-install smoke check for Waypoint.

Runs three verification passes against a deployed Waypoint instance:

  1. Row counts via Postgres (psycopg2): confirms every seed table
     matches the expected count from supabase/seed/budget/README.md.
  2. Function endpoints via HTTPS: confirms /, /.netlify/functions/config,
     and /.netlify/functions/scout-status return the expected status codes
     and payloads.
  3. Auth allowlist: confirms at least one email is allowlisted and
     is_email_allowed() returns true for it.

Cross-platform: pure Python 3.8+, no shell-specific behavior. Works
identically on Windows, macOS, Linux.

USAGE:

  python3 scripts/verify_install.py \\
      --db-url "postgresql://postgres.<ref>:<pwd>@aws-1-<region>.pooler.supabase.com:5432/postgres" \\
      --site-url https://<site-name>.netlify.app

Or set env vars and run without flags:

  export WAYPOINT_DB_URL="..."
  export WAYPOINT_SITE_URL="https://..."
  python3 scripts/verify_install.py

On Windows PowerShell:

  $env:WAYPOINT_DB_URL = "..."
  $env:WAYPOINT_SITE_URL = "https://..."
  python scripts/verify_install.py

Exit code: 0 if all checks pass, 1 otherwise. Designed to be safe to
re-run any time; makes no writes.

REQUIREMENTS:

  python3 -m pip install --user psycopg2-binary

(`psycopg2-binary` ships pre-built wheels for every common platform;
no compiler toolchain required.)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import List, Tuple

# Expected row counts from supabase/seed/budget/README.md
EXPECTED_COUNTS = {
    "budget_appropriations": 205,
    "budget_orgs": 201,
    "budget_pes": 2143,
    "budget_om_sags": 389,
    "pe_narratives": 1753,
    "hill_members": 536,
    "hill_committees": 230,
    "hill_committee_memberships": 3879,
    "budget_topline_lines": 51,
    "budget_projects": 2302,
    "pe_office_links": 6911,
    "sag_office_links": 699,
}

# Required count threshold per table — exact match expected.
# We don't tolerate drift because seeds are deterministic by design
# (every INSERT is ON CONFLICT DO NOTHING; re-running doesn't add rows).

REQUIRED_FUNCTION_FIELDS = {"supabaseUrl", "scoutAvailable"}


class CheckResult:
    def __init__(self, name: str, ok: bool, detail: str = ""):
        self.name = name
        self.ok = ok
        self.detail = detail

    def __str__(self):
        status = "PASS" if self.ok else "FAIL"
        line = f"  [{status}]  {self.name}"
        if self.detail:
            line += f"  -- {self.detail}"
        return line


def check_db(db_url: str) -> List[CheckResult]:
    """Connect to Postgres, verify row counts and allowlist state."""
    out: List[CheckResult] = []
    try:
        import psycopg2  # type: ignore
    except ImportError:
        out.append(CheckResult(
            "psycopg2 import",
            False,
            "Run: python3 -m pip install --user psycopg2-binary",
        ))
        return out

    try:
        conn = psycopg2.connect(db_url, connect_timeout=10)
    except Exception as e:
        out.append(CheckResult("Postgres connect", False, str(e)[:200]))
        return out

    try:
        with conn:
            with conn.cursor() as cur:
                # Row counts
                for table, expected in EXPECTED_COUNTS.items():
                    try:
                        cur.execute(f"SELECT count(*) FROM public.{table};")
                        actual = cur.fetchone()[0]
                        out.append(CheckResult(
                            f"public.{table}",
                            actual == expected,
                            f"actual={actual} expected={expected}",
                        ))
                    except Exception as e:
                        out.append(CheckResult(
                            f"public.{table}",
                            False,
                            f"query error: {str(e)[:120]}",
                        ))

                # Allowlist must have at least one row
                try:
                    cur.execute("SELECT count(*) FROM public.auth_allowlist;")
                    n = cur.fetchone()[0]
                    out.append(CheckResult(
                        "auth_allowlist has rows",
                        n > 0,
                        f"count={n}",
                    ))
                    if n > 0:
                        cur.execute("SELECT email FROM public.auth_allowlist LIMIT 1;")
                        email = cur.fetchone()[0]
                        cur.execute("SELECT public.is_email_allowed(%s);", (email,))
                        allowed = cur.fetchone()[0]
                        out.append(CheckResult(
                            f"is_email_allowed({email!r})",
                            bool(allowed),
                            f"returned {allowed}",
                        ))
                except Exception as e:
                    out.append(CheckResult(
                        "auth_allowlist / is_email_allowed",
                        False,
                        f"query error: {str(e)[:120]}",
                    ))

                # Auth trigger must exist (F-NEW-AUTH-TRIGGER-1)
                try:
                    cur.execute(
                        "SELECT count(*) FROM pg_trigger "
                        "WHERE tgname = 'on_auth_user_created';"
                    )
                    n = cur.fetchone()[0]
                    out.append(CheckResult(
                        "on_auth_user_created trigger present",
                        n == 1,
                        f"count={n} (expected 1)",
                    ))
                except Exception as e:
                    out.append(CheckResult(
                        "on_auth_user_created trigger present",
                        False,
                        f"query error: {str(e)[:120]}",
                    ))

                # RLS policy count
                try:
                    cur.execute(
                        "SELECT count(*) FROM pg_policies "
                        "WHERE schemaname = 'public';"
                    )
                    n = cur.fetchone()[0]
                    out.append(CheckResult(
                        "RLS policies on public schema",
                        n >= 80,
                        f"count={n} (expected >= 80)",
                    ))
                except Exception as e:
                    out.append(CheckResult(
                        "RLS policies on public schema",
                        False,
                        f"query error: {str(e)[:120]}",
                    ))

    finally:
        conn.close()

    return out


def http_get(url: str, timeout: float = 10.0) -> Tuple[int, str, dict]:
    """GET a URL. Returns (status_code, body, parsed_json_or_empty_dict).

    Does not raise on non-2xx; returns the status code. JSON parsing
    errors return an empty dict (body is preserved as the raw string).
    """
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.getcode()
            body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        status = e.code
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
    except Exception as e:
        return -1, f"connect error: {e}", {}

    parsed: dict = {}
    if body and body.lstrip().startswith(("{", "[")):
        try:
            parsed = json.loads(body)
            if not isinstance(parsed, dict):
                parsed = {"__list__": parsed}
        except Exception:
            parsed = {}
    return status, body, parsed


def check_endpoints(site_url: str) -> List[CheckResult]:
    """Hit the three required endpoints and verify status + payload."""
    out: List[CheckResult] = []
    site = site_url.rstrip("/")

    # 1. Site root
    status, body, _ = http_get(f"{site}/")
    has_title = "<title>" in body.lower() and "waypoint" in body.lower()
    out.append(CheckResult(
        "GET /",
        status == 200 and has_title,
        f"status={status} title={'present' if has_title else 'missing'}",
    ))

    # 2. /.netlify/functions/config
    status, body, parsed = http_get(f"{site}/.netlify/functions/config")
    missing = REQUIRED_FUNCTION_FIELDS - set(parsed.keys()) if parsed else REQUIRED_FUNCTION_FIELDS
    supa_url_present = bool(parsed.get("supabaseUrl"))
    scout_available = parsed.get("scoutAvailable")
    out.append(CheckResult(
        "GET /.netlify/functions/config",
        status == 200 and not missing and supa_url_present,
        f"status={status} supabaseUrl={'present' if supa_url_present else 'MISSING (F-NEW-NETLIFY-1)'} "
        f"scoutAvailable={scout_available} missing_fields={sorted(missing) if missing else '[]'}",
    ))

    # 3. /.netlify/functions/scout-status
    status, body, parsed = http_get(f"{site}/.netlify/functions/scout-status")
    # If Scout enabled -> 400 with job_id required. If disabled -> 503 scout_disabled.
    if scout_available is True:
        ok = status == 400 and ("job_id" in body.lower())
        detail = f"scout_enabled: status={status} body~{body[:80]!r}"
    elif scout_available is False:
        ok = status == 503 and ("scout_disabled" in body.lower())
        detail = f"scout_disabled: status={status} body~{body[:80]!r}"
    else:
        ok = False
        detail = f"scoutAvailable unknown from config; got status={status}"
    out.append(CheckResult("GET /.netlify/functions/scout-status", ok, detail))

    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Post-install smoke check for Waypoint."
    )
    parser.add_argument(
        "--db-url",
        default=os.environ.get("WAYPOINT_DB_URL"),
        help="Postgres connection string. Falls back to $WAYPOINT_DB_URL.",
    )
    parser.add_argument(
        "--site-url",
        default=os.environ.get("WAYPOINT_SITE_URL"),
        help="Deployed site root URL (e.g. https://yoursite.netlify.app). "
             "Falls back to $WAYPOINT_SITE_URL.",
    )
    parser.add_argument(
        "--skip-db",
        action="store_true",
        help="Skip Postgres checks (e.g. if you only have the site URL).",
    )
    parser.add_argument(
        "--skip-endpoints",
        action="store_true",
        help="Skip HTTPS endpoint checks (e.g. if you only have DB access).",
    )
    args = parser.parse_args(argv)

    if not args.skip_db and not args.db_url:
        print("ERROR: --db-url is required (or set WAYPOINT_DB_URL).", file=sys.stderr)
        print("       Or pass --skip-db to skip Postgres checks.", file=sys.stderr)
        return 2
    if not args.skip_endpoints and not args.site_url:
        print("ERROR: --site-url is required (or set WAYPOINT_SITE_URL).", file=sys.stderr)
        print("       Or pass --skip-endpoints to skip HTTPS checks.", file=sys.stderr)
        return 2

    print("Waypoint install verification")
    print("=" * 60)

    all_results: List[CheckResult] = []

    if not args.skip_db:
        print("\n[1] Postgres row counts + allowlist + trigger + RLS")
        print("-" * 60)
        db_results = check_db(args.db_url)
        for r in db_results:
            print(r)
        all_results.extend(db_results)

    if not args.skip_endpoints:
        print("\n[2] Function endpoints (HTTPS)")
        print("-" * 60)
        ep_results = check_endpoints(args.site_url)
        for r in ep_results:
            print(r)
        all_results.extend(ep_results)

    print("\n" + "=" * 60)
    n_total = len(all_results)
    n_pass = sum(1 for r in all_results if r.ok)
    n_fail = n_total - n_pass
    print(f"Result: {n_pass}/{n_total} passed, {n_fail} failed")
    if n_fail > 0:
        print("\nFailing checks:")
        for r in all_results:
            if not r.ok:
                print(f"  - {r.name}: {r.detail}")
        return 1
    print("OK — install verified.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
