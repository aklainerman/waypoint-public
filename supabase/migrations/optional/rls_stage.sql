-- optional/rls_stage.sql
--
-- STAGE PROJECT ONLY. Apply this INSTEAD of ../001_rls.sql on a
-- staging Supabase project (skip entirely if you only have a single
-- production deployment).
--
-- Apply via Supabase Studio SQL editor:
-- https://supabase.com/dashboard/project/<YOUR_STAGE_PROJECT_REF>/sql
--
-- Stage uses the same role model as the default (001_rls.sql), with
-- a small difference: it explicitly drops any pre-existing temp
-- "authenticated_read" policy that may have been added during initial
-- seed loading. If you don't have such a policy, that DROP is a no-op
-- and the rest of this file behaves identically to the default RLS.

BEGIN;

-- ==========================================================================
-- Helper functions (identical to Prod)
-- ==========================================================================

CREATE OR REPLACE FUNCTION public.user_role()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT role FROM public.user_roles WHERE user_id = auth.uid() LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.user_role() FROM public;
GRANT EXECUTE ON FUNCTION public.user_role() TO authenticated;

CREATE OR REPLACE FUNCTION public.is_editor()
RETURNS boolean LANGUAGE sql STABLE
AS $$ SELECT public.user_role() IN ('editor', 'admin'); $$;
REVOKE ALL ON FUNCTION public.is_editor() FROM public;
GRANT EXECUTE ON FUNCTION public.is_editor() TO authenticated;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean LANGUAGE sql STABLE
AS $$ SELECT public.user_role() = 'admin'; $$;
REVOKE ALL ON FUNCTION public.is_admin() FROM public;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- ==========================================================================
-- Tiers 1-5 (CRM, Budget ref, Hill ref, Auth, Scout) -- identical to Prod
-- ==========================================================================

DO $$
DECLARE
  t text;
  pol record;
  crm_tables text[] := ARRAY[
    'offices', 'contacts', 'solicitations', 'letters', 'washops', 'requests',
    'pe_office_links', 'pe_office_link_dismissals', 'pe_office_suggestions',
    'sag_office_links', 'sag_office_link_dismissals', 'sag_office_suggestions',
    'office_media',
    'hill_meetings', 'hill_requests'
  ];
BEGIN
  FOREACH t IN ARRAY crm_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      -- drop EVERY existing policy on this table, not just
      -- the ones we know by name. Catches legacy Supabase-UI policies
      -- ('Enable read access for all users' etc.) that named drops miss.
      FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
      END LOOP;
      EXECUTE format('CREATE POLICY authenticated_read ON public.%I FOR SELECT TO authenticated USING (true)', t);
      EXECUTE format('CREATE POLICY editor_insert      ON public.%I FOR INSERT TO authenticated WITH CHECK (public.is_editor())', t);
      EXECUTE format('CREATE POLICY editor_update      ON public.%I FOR UPDATE TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor())', t);
      EXECUTE format('CREATE POLICY editor_delete      ON public.%I FOR DELETE TO authenticated USING (public.is_editor())', t);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  t text;
  pol record;
  budget_tables text[] := ARRAY[
    'budget_orgs', 'budget_appropriations', 'budget_pes', 'budget_projects',
    'budget_om_sags', 'budget_topline_lines',
    'pe_budget_years', 'procurement_line_years', 'om_activity_years',
    'pe_narratives', 'om_sag_narratives', 'proc_line_narratives',
    'pe_title_overrides'
  ];
BEGIN
  FOREACH t IN ARRAY budget_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      -- drop EVERY existing policy on this table, not just
      -- the ones we know by name. Catches legacy Supabase-UI policies
      -- ('Enable read access for all users' etc.) that named drops miss.
      FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
      END LOOP;
      EXECUTE format('CREATE POLICY authenticated_read ON public.%I FOR SELECT TO authenticated USING (true)', t);
      EXECUTE format('CREATE POLICY admin_write        ON public.%I FOR ALL    TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin())', t);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  t text;
  pol record;
  hill_ref_tables text[] := ARRAY['hill_members', 'hill_committees', 'hill_committee_memberships'];
BEGIN
  FOREACH t IN ARRAY hill_ref_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      -- drop EVERY existing policy on this table, not just
      -- the ones we know by name. Catches legacy Supabase-UI policies
      -- ('Enable read access for all users' etc.) that named drops miss.
      FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
      END LOOP;
      EXECUTE format('CREATE POLICY authenticated_read ON public.%I FOR SELECT TO authenticated USING (true)', t);
      EXECUTE format('CREATE POLICY admin_write        ON public.%I FOR ALL    TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin())', t);
    END IF;
  END LOOP;
END $$;

-- Auth tier
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
-- drop ALL existing policies on user_roles before creating canonical.
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='user_roles' LOOP
    EXECUTE format('DROP POLICY %I ON public.user_roles', pol.policyname);
  END LOOP;
END $$;
CREATE POLICY user_reads_own_role  ON public.user_roles FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY admin_reads_all_roles ON public.user_roles FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY admin_writes_roles   ON public.user_roles FOR ALL    TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

DO $$
DECLARE pol record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='auth_allowlist') THEN
    ALTER TABLE public.auth_allowlist ENABLE ROW LEVEL SECURITY;
    -- drop ALL existing policies on auth_allowlist
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='auth_allowlist' LOOP
      EXECUTE format('DROP POLICY %I ON public.auth_allowlist', pol.policyname);
    END LOOP;
    CREATE POLICY admin_read_allowlist  ON public.auth_allowlist FOR SELECT TO authenticated USING (public.is_admin());
    CREATE POLICY admin_write_allowlist ON public.auth_allowlist FOR ALL    TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
  END IF;
END $$;

-- Scout tier
DO $$
DECLARE
  t text;
  pol record;
  scout_tables text[] := ARRAY[
    'scout_jobs', 'scout_findings', 'scout_messages',
    'scout_searches', 'scout_tool_calls', 'scout_url_cache',
    'apollo_phone_webhook_log'
  ];
BEGIN
  FOREACH t IN ARRAY scout_tables LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      -- drop ALL existing policies (see CRM tier comment)
      FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
      END LOOP;
      EXECUTE format('CREATE POLICY editor_full ON public.%I FOR ALL TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor())', t);
    END IF;
  END LOOP;
END $$;

-- ==========================================================================
-- Anon role: zero access except is_email_allowed RPC.
-- ==========================================================================

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_email_allowed') THEN
    GRANT EXECUTE ON FUNCTION public.is_email_allowed(text) TO anon;
  END IF;
END $$;

-- Authenticated role: explicit table grants. RLS gates rows.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT EXECUTE                        ON ALL FUNCTIONS IN SCHEMA public TO authenticated;

-- Default privileges for new tables created after this migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon;

COMMIT;

-- Smoke-test (Supabase Studio SQL editor):
--   SET ROLE anon;
--   SELECT count(*) FROM public.offices;             -- ERROR (good)
--   SELECT public.is_email_allowed('test@x.com');   -- OK
--   RESET ROLE;
