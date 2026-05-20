-- demo_seed.sql
--
-- Strategy notes for seeding the DEMO project. The actual data transfer
-- happens via `scripts/seed_demo.py` (uses two Supabase clients to copy
-- rows from Stage to Demo). This file is the schema-level cleanup that
-- runs BEFORE that Python script.
--
-- Apply to: <YOUR_DEMO_PROJECT_REF> (Waypoint - DEMO)
-- Idempotent. Re-runnable. Truncates demo data tables in dependency order.

BEGIN;

-- ---------------------------------------------------------------------------
-- Step 1: TRUNCATE everything we plan to re-seed (children first, parents
-- second, to respect FK dependencies).
-- ---------------------------------------------------------------------------
TRUNCATE TABLE
  public.pe_office_link_dismissals,
  public.sag_office_link_dismissals,
  public.pe_office_suggestions,
  public.sag_office_suggestions,
  public.pe_office_links,
  public.sag_office_links,
  public.pe_narratives,
  public.om_sag_narratives,
  public.proc_line_narratives,
  public.pe_title_overrides,
  public.pe_budget_years,
  public.procurement_line_years,
  public.om_activity_years,
  public.budget_pes,
  public.budget_om_sags,
  public.budget_projects,
  public.budget_topline_lines,
  public.budget_appropriations,
  public.budget_orgs,
  public.hill_committee_memberships,
  public.hill_committees,
  public.hill_members,
  public.offices
RESTART IDENTITY CASCADE;

-- ---------------------------------------------------------------------------
-- Step 2: TRUNCATE the tables that must stay empty. Belt-and-suspenders
-- in case something dirty got in (it shouldn't, but defensive).
-- ---------------------------------------------------------------------------
TRUNCATE TABLE
  public.contacts,
  public.solicitations,
  public.letters,
  public.requests,
  public.washops,
  public.hill_meetings,
  public.hill_requests,
  public.office_media,
  public.scout_findings,
  public.scout_jobs,
  public.scout_messages,
  public.scout_searches,
  public.scout_tool_calls,
  public.scout_url_cache,
  public.apollo_phone_webhook_log,
  public.auth_allowlist,
  public.user_roles
RESTART IDENTITY CASCADE;

COMMIT;

-- Now run: python scripts/seed_demo.py
-- Then run: python scripts/verify_read_only.py --url <demo-url>
