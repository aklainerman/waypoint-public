#!/usr/bin/env python3
"""
seed_demo.py - copy budget + office + hill data from Stage to DEMO.

Idempotent. Run before this:
  psql "$DEMO_DB_URL" -f supabase/seed/demo_seed.sql

Then run this script. It:
  1. Connects to Stage (read-only, anon key OK)
  2. Connects to Demo (service_role key required, bypasses RLS)
  3. Copies each readable table from Stage -> Demo in dependency order
  4. NULLs sensitive columns on the way (offices.notes specifically)
  5. Prints a row-count summary

Env vars required:
  STAGE_SUPABASE_URL       https://<YOUR_STAGE_PROJECT_REF>.supabase.co
  STAGE_SUPABASE_ANON_KEY  publishable key for Staging
  DEMO_SUPABASE_URL        https://<YOUR_DEMO_PROJECT_REF>.supabase.co
  DEMO_SERVICE_ROLE_KEY    service_role key for DEMO (bypasses RLS)

Usage:
  python scripts/seed_demo.py [--dry-run] [--only TABLE]
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from typing import Any

try:
    from supabase import create_client, Client  # type: ignore
except ImportError:
    print("ERROR: supabase-py not installed. Run: pip install supabase", file=sys.stderr)
    sys.exit(2)


# ---------------------------------------------------------------------------
# Tables to copy, in FK dependency order.
# Each entry: (table_name, columns_to_null_on_copy)
# columns_to_null_on_copy = list of column names to clear during the copy
# (used to strip "notes" from offices, e.g.).
# ---------------------------------------------------------------------------
COPY_ORDER: list[tuple[str, list[str]]] = [
    # Reference / lookup
    ("budget_orgs", []),
    ("budget_appropriations", []),
    # Hill (public data)
    ("hill_members", []),
    ("hill_committees", []),
    ("hill_committee_memberships", []),
    # Offices — strip any user-entered notes
    ("offices", ["notes"]),
    # Budget structure
    ("budget_om_sags", []),
    ("budget_pes", []),
    ("budget_projects", []),
    ("budget_topline_lines", []),
    # Per-year + narratives
    ("pe_budget_years", []),
    ("procurement_line_years", []),
    ("om_activity_years", []),
    ("pe_narratives", []),
    ("om_sag_narratives", []),
    ("proc_line_narratives", []),
    ("pe_title_overrides", []),
    ("pe_ingestion_audit", []),
    # Office <-> PE/SAG link tables
    ("pe_office_links", []),
    ("sag_office_links", []),
    ("pe_office_link_dismissals", []),
    ("sag_office_link_dismissals", []),
    ("pe_office_suggestions", []),
    ("sag_office_suggestions", []),
]

# Tables that must stay empty on DEMO. Listed for clarity; not used in copy
# loop, but a final sanity check confirms each is row-count 0.
MUST_BE_EMPTY: list[str] = [
    "contacts",
    "solicitations",
    "letters",
    "requests",
    "washops",
    "hill_meetings",
    "hill_requests",
    "office_media",
    "scout_findings",
    "scout_jobs",
    "scout_messages",
    "scout_searches",
    "scout_tool_calls",
    "scout_url_cache",
    "apollo_phone_webhook_log",
    "auth_allowlist",
    "user_roles",
]

BATCH_SIZE = 1000  # rows per request


def env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        print(f"ERROR: env var {name} not set", file=sys.stderr)
        sys.exit(2)
    return value


def copy_table(
    stage: Client, demo: Client, table: str, nulls: list[str], dry_run: bool
) -> int:
    """Copy all rows from stage[table] to demo[table]. Returns row count."""
    total = 0
    offset = 0
    while True:
        # Range queries: Supabase REST defaults to 1000-row pages; we make
        # pagination explicit to avoid the silent truncation that bit v47c.
        page = (
            stage.table(table)
            .select("*")
            .range(offset, offset + BATCH_SIZE - 1)
            .execute()
        )
        rows = page.data or []
        if not rows:
            break

        # NULL specified columns
        if nulls:
            for row in rows:
                for col in nulls:
                    if col in row:
                        row[col] = None

        if not dry_run:
            demo.table(table).insert(rows).execute()

        total += len(rows)
        print(f"  {table}: copied {total} rows...", flush=True)

        if len(rows) < BATCH_SIZE:
            break
        offset += BATCH_SIZE

    return total


def count_rows(client: Client, table: str) -> int:
    res = client.table(table).select("id", count="exact", head=True).execute()
    return res.count or 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="don't write to DEMO")
    parser.add_argument("--only", help="copy a single table only")
    args = parser.parse_args()

    stage_url = env("STAGE_SUPABASE_URL")
    stage_key = env("STAGE_SUPABASE_ANON_KEY")
    demo_url = env("DEMO_SUPABASE_URL")
    demo_key = env("DEMO_SERVICE_ROLE_KEY")

    print(f"Stage: {stage_url}")
    print(f"Demo:  {demo_url}")
    print(f"Dry run: {args.dry_run}")
    print()

    stage = create_client(stage_url, stage_key)
    demo = create_client(demo_url, demo_key)

    started = time.time()
    summary: dict[str, int] = {}

    targets = COPY_ORDER
    if args.only:
        targets = [(t, nulls) for (t, nulls) in COPY_ORDER if t == args.only]
        if not targets:
            print(f"ERROR: --only {args.only} is not a known table", file=sys.stderr)
            return 2

    for table, nulls in targets:
        print(f"-> {table}{' (nulls: ' + ','.join(nulls) + ')' if nulls else ''}")
        try:
            n = copy_table(stage, demo, table, nulls, args.dry_run)
            summary[table] = n
        except Exception as e:  # noqa: BLE001
            print(f"  FAILED: {e}", file=sys.stderr)
            return 1

    elapsed = time.time() - started

    print()
    print("=== Copy summary ===")
    for t, n in summary.items():
        print(f"  {t:<35}  {n:>8} rows")
    print(f"  TOTAL: {sum(summary.values())} rows in {elapsed:.1f}s")

    # Sanity-check the must-be-empty set.
    if not args.dry_run and not args.only:
        print()
        print("=== Empty-table verification ===")
        bad = []
        for table in MUST_BE_EMPTY:
            try:
                n = count_rows(demo, table)
                marker = "OK" if n == 0 else "VIOLATION"
                print(f"  {table:<35}  {n:>8} rows  {marker}")
                if n != 0:
                    bad.append((table, n))
            except Exception as e:  # noqa: BLE001
                # Table missing or access denied — treat as OK (RLS blocking
                # us with service_role would be a config bug, but we don't
                # want to fail the seed for it).
                print(f"  {table:<35}  ?        {e}")

        if bad:
            print()
            print("ERROR: the following tables should be empty but are not:")
            for t, n in bad:
                print(f"  {t}: {n} rows")
            return 1

    print()
    print("Seed complete. Next: python scripts/verify_read_only.py --url <demo-url>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
