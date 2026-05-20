-- optional/rls_demo.sql
--
-- DEMO PROJECT ONLY. Apply this INSTEAD of ../001_rls.sql on a
-- read-only public-demo Supabase project (skip entirely if you don't
-- run a demo environment).
--
-- Apply via Supabase Studio SQL editor:
-- https://supabase.com/dashboard/project/<YOUR_DEMO_PROJECT_REF>/sql
--
-- Demo RLS posture:
--   * anon SELECT on full CRM tables (offices/contacts/sols/letters/
--     washops/requests are visible -- demo seed should use fake emails
--     and phones so PII isn't a concern).
--   * anon CANNOT see scout_*, user_roles, auth_allowlist,
--     office_media (file uploads), apollo_phone_webhook_log.
--   * anon writes still blocked (no INSERT/UPDATE/DELETE policy).
--   * No authenticated role on demo (no login overlay) -- this
--     migration deliberately omits the authenticated tier that
--     ../001_rls.sql provides.

BEGIN;

-- ==========================================================================
-- Tier A: Anon-readable tables (full SELECT for visitor browsing).
-- ==========================================================================

DO $$
DECLARE
  t text;
  pol record;
  readable_tables text[] := ARRAY[
    -- CRM (demo data should be fake -- no real PII)
    'offices', 'contacts', 'solicitations', 'letters', 'washops', 'requests',
    -- Hill (public Congress data)
    'hill_members', 'hill_committees', 'hill_committee_memberships',
    'hill_meetings', 'hill_requests',
    -- PE/SAG office links + dismissals + suggestions
    'pe_office_links', 'pe_office_link_dismissals', 'pe_office_suggestions',
    'sag_office_links', 'sag_office_link_dismissals', 'sag_office_suggestions',
    -- Budget reference
    'budget_appropriations', 'budget_om_sags', 'budget_orgs', 'budget_pes',
    'budget_projects', 'budget_topline_lines',
    'pe_budget_years', 'pe_narratives',
    'procurement_line_years', 'om_activity_years',
    'om_sag_narratives', 'proc_line_narratives',
    'pe_title_overrides'
  ];
BEGIN
  FOREACH t IN ARRAY readable_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      -- drop ALL existing policies before creating the canonical one
      FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
      END LOOP;
      EXECUTE format(
        'CREATE POLICY demo_select_anon ON public.%I FOR SELECT TO anon USING (true)',
        t
      );
    END IF;
  END LOOP;
END $$;

-- ==========================================================================
-- Tier B: Anon-hidden tables. RLS on, NO anon policy = total denial.
-- These are also empty (or scrubbed) after seed_demo.py runs, but RLS is
-- the authoritative guard.
-- ==========================================================================

DO $$
DECLARE
  t text;
  pol record;
  hidden_tables text[] := ARRAY[
    -- File uploads (PDFs of letters, office media) -- don't expose URLs
    'office_media',
    -- Scout workflow (active engagement data, never demo-safe)
    'scout_findings', 'scout_jobs', 'scout_messages', 'scout_searches',
    'scout_tool_calls', 'scout_url_cache',
    -- Apollo phone webhook log (PII-adjacent)
    'apollo_phone_webhook_log',
    -- Auth surfaces
    'auth_allowlist',
    'user_roles'
  ];
BEGIN
  FOREACH t IN ARRAY hidden_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      -- drop ALL existing policies. For hidden tables we drop
      -- and create nothing -- RLS denies-by-default.
      FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- ==========================================================================
-- Tier C: Audit tables (forensic snapshots from migrations on Stage; may
-- exist on Demo if Stage was used as source). Total denial.
-- ==========================================================================

DO $$
-- (No audit-table loop needed in the OSS template; the snapshot schema
-- does not ship with audit_* tables. If you add your own audit tables
-- later, copy the pattern from optional/rls_stage.sql's authenticated
-- tier and add an admin_read policy.)

-- ==========================================================================
-- Belt-and-suspenders grants. RLS is the primary guard; grants are the
-- fallback if a future policy mistake creates a permission gap.
-- ==========================================================================

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon;

-- Explicit SELECT grants on the readable set. RLS still gates rows.
DO $$
DECLARE
  t text;
  pol record;
  readable_tables text[] := ARRAY[
    'offices', 'contacts', 'solicitations', 'letters', 'washops', 'requests',
    'hill_members', 'hill_committees', 'hill_committee_memberships',
    'hill_meetings', 'hill_requests',
    'pe_office_links', 'pe_office_link_dismissals', 'pe_office_suggestions',
    'sag_office_links', 'sag_office_link_dismissals', 'sag_office_suggestions',
    'budget_appropriations', 'budget_om_sags', 'budget_orgs', 'budget_pes',
    'budget_projects', 'budget_topline_lines',
    'pe_budget_years', 'pe_narratives',
    'procurement_line_years', 'om_activity_years',
    'om_sag_narratives', 'proc_line_narratives',
    'pe_title_overrides'
  ];
BEGIN
  FOREACH t IN ARRAY readable_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t) THEN
      EXECUTE format('GRANT SELECT ON public.%I TO anon', t);
    END IF;
  END LOOP;
END $$;

-- ==========================================================================
-- RPCs anon needs to call from the demo dashboard.
-- ==========================================================================

DO $$
DECLARE
  proc record;
  readable_functions text[] := ARRAY[
    'get_pes_for_year',
    'get_narrative_for_pe',
    'get_all_narratives_brief',
    'get_narrative_diff_set'
  ];
BEGIN
  -- Walk pg_proc to grant EVERY signature. Bare name granting
  -- fails when the function is overloaded (e.g., get_all_narratives_brief
  -- has both a no-arg and a year-arg form on Demo).
  FOR proc IN
    SELECT n.nspname,
           p.proname,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY(readable_functions)
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO anon', proc.proname, proc.args);
  END LOOP;
END $$;

-- Admin RPCs MUST NOT be callable from anon on demo.
DO $$
DECLARE
  proc record;
  admin_only_functions text[] := ARRAY[
    'admin_list_users', 'admin_set_user_role', 'admin_remove_user',
    'admin_list_allowlist', 'admin_add_to_allowlist', 'admin_remove_from_allowlist'
  ];
BEGIN
  -- same overload-safe pattern as the readable_functions block.
  FOR proc IN
    SELECT n.nspname,
           p.proname,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY(admin_only_functions)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM anon', proc.proname, proc.args);
  END LOOP;
END $$;

-- is_email_allowed is meaningless on demo (no login overlay) but keep it
-- consistent across projects -- grant to anon since it doesn't leak data
-- (returns boolean).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_email_allowed') THEN
    GRANT EXECUTE ON FUNCTION public.is_email_allowed(text) TO anon;
  END IF;
END $$;

-- ==========================================================================
-- Default privileges for future tables. New tables get NO anon access by
-- default. If a new table needs demo visibility, update this migration.
-- ==========================================================================

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon;

COMMIT;

-- Smoke-test:
--   SET ROLE anon;
--   SELECT count(*) FROM public.offices;             -- OK
--   SELECT count(*) FROM public.contacts;            -- OK (fake data)
--   SELECT count(*) FROM public.scout_findings;     -- ERROR (good)
--   SELECT count(*) FROM public.user_roles;         -- ERROR (good)
--   SELECT count(*) FROM public.auth_allowlist;     -- ERROR (good)
--   INSERT INTO public.offices (id, name) VALUES ('x', 'x'); -- ERROR (good)
--   RESET ROLE;
