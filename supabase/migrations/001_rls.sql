-- 001_rls.sql
--
-- Default RLS posture for a single-environment ("prod") deployment.
-- Apply this on a fresh Waypoint Supabase project after 000_initial_schema.sql.
-- For multi-environment deploys, apply this on the prod project and
-- apply optional/rls_stage.sql or optional/rls_demo.sql on the stage /
-- demo projects INSTEAD of this file.
--
-- Apply via Supabase Studio SQL editor:
-- https://supabase.com/dashboard/project/<YOUR_PROJECT_REF>/sql
--
-- ==========================================================================
-- Posture summary
-- ==========================================================================
-- anon (no session):
--   * Zero table access (no SELECT, INSERT, UPDATE, DELETE on any table).
--   * One EXECUTE: public.is_email_allowed(p_email text) -- needed by the
--     pre-magic-link allowlist check in the login modal.
--   * No other RPC EXECUTE.
--
-- authenticated, role=viewer:
--   * SELECT on every data table (CRM, Hill, Budget reference).
--   * Cannot INSERT/UPDATE/DELETE anything.
--   * EXECUTE on read RPCs (get_pes_for_year, get_narrative_for_pe, etc.).
--   * Cannot read user_roles (except own row) or auth_allowlist.
--
-- authenticated, role=editor:
--   * Everything role=viewer can do, plus
--   * INSERT/UPDATE/DELETE on CRM tables (offices, contacts, solicitations,
--     letters, washops, requests, hill_meetings, hill_requests, office_media,
--     PE/SAG link + dismissal + suggestion tables).
--   * No write access to budget_* reference tables (those are J-Book ingest
--     only -- admin can mutate via SECURITY DEFINER scripts).
--   * EXECUTE on Scout RPCs and write RPCs on CRM.
--
-- authenticated, role=admin:
--   * Everything role=editor can do, plus
--   * Read + write access to user_roles, auth_allowlist, scout_* tables.
--   * Read + write access to budget_* reference tables.
--   * EXECUTE on admin_* RPCs.
--
-- service_role: unaffected (bypasses RLS by design).
--
-- ==========================================================================
-- Idempotency
-- ==========================================================================
-- Every CREATE POLICY is preceded by DROP POLICY IF EXISTS, so re-applying
-- this migration is safe. Helper functions use CREATE OR REPLACE.
-- The transaction wraps the whole thing so partial failure rolls back.
--
-- ==========================================================================
-- Rollback
-- ==========================================================================
-- If this migration locks you out (e.g., admin user not in user_roles),
-- in Supabase Studio:
--   1. Open the SQL editor with service_role (default in Studio).
--   2. Run:  INSERT INTO public.user_roles (user_id, role)
--            VALUES ('<your-auth-uid>', 'admin')
--            ON CONFLICT (user_id) DO UPDATE SET role = 'admin';
--   3. Your role check at boot will now pass.
-- To fully undo, drop all created policies (see "Smoke-test post-apply"
-- block at the bottom of this file for a list).

BEGIN;

-- ==========================================================================
-- Helper functions (role-aware predicates)
-- ==========================================================================

-- Returns the role of the current auth.uid() from user_roles. Returns NULL
-- if the user has no row in user_roles (which should mean "no access").
-- SECURITY DEFINER so the function can read user_roles even when the
-- caller's RLS would deny it.
CREATE OR REPLACE FUNCTION public.user_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.user_roles WHERE user_id = auth.uid() LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.user_role() FROM public;
GRANT EXECUTE ON FUNCTION public.user_role() TO authenticated;

CREATE OR REPLACE FUNCTION public.is_editor()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$ SELECT public.user_role() IN ('editor', 'admin'); $$;

REVOKE ALL ON FUNCTION public.is_editor() FROM public;
GRANT EXECUTE ON FUNCTION public.is_editor() TO authenticated;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$ SELECT public.user_role() = 'admin'; $$;

REVOKE ALL ON FUNCTION public.is_admin() FROM public;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- ==========================================================================
-- Tier 1: CRM tables (offices, contacts, sols, letters, washops, requests,
--                     link/dismissal/suggestion tables, office_media,
--                     hill_meetings, hill_requests)
-- Authenticated SELECT for all; INSERT/UPDATE/DELETE for editor+.
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

      -- drop ALL existing policies on this table. Named drops
      -- miss legacy policies like Supabase Studio's default
      -- 'Enable read access for all users' (anon-permissive).
      FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
      END LOOP;

      -- Canonical policies
      EXECUTE format(
        'CREATE POLICY authenticated_read ON public.%I FOR SELECT TO authenticated USING (true)',
        t
      );
      EXECUTE format(
        'CREATE POLICY editor_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (public.is_editor())',
        t
      );
      EXECUTE format(
        'CREATE POLICY editor_update ON public.%I FOR UPDATE TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor())',
        t
      );
      EXECUTE format(
        'CREATE POLICY editor_delete ON public.%I FOR DELETE TO authenticated USING (public.is_editor())',
        t
      );
    END IF;
  END LOOP;
END $$;

-- ==========================================================================
-- Tier 2: Budget reference data (ingested from J-Books, NOT user-editable).
-- Authenticated SELECT for all; INSERT/UPDATE/DELETE for admin only.
-- ==========================================================================

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
      EXECUTE format(
        'CREATE POLICY authenticated_read ON public.%I FOR SELECT TO authenticated USING (true)',
        t
      );
      EXECUTE format(
        'CREATE POLICY admin_write ON public.%I FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin())',
        t
      );
    END IF;
  END LOOP;
END $$;

-- ==========================================================================
-- Tier 3: Hill reference data (public Congress data: members, committees).
-- Authenticated SELECT; admin write (sync from Congress.gov).
-- ==========================================================================

DO $$
DECLARE
  t text;
  pol record;
  hill_ref_tables text[] := ARRAY[
    'hill_members', 'hill_committees', 'hill_committee_memberships'
  ];
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
      EXECUTE format(
        'CREATE POLICY authenticated_read ON public.%I FOR SELECT TO authenticated USING (true)',
        t
      );
      EXECUTE format(
        'CREATE POLICY admin_write ON public.%I FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin())',
        t
      );
    END IF;
  END LOOP;
END $$;

-- ==========================================================================
-- Tier 4: Auth tables. user_roles is special -- each user can read THEIR OWN
-- row (so the boot path's role lookup works), but only admins read all rows.
-- auth_allowlist is admin-only.
-- ==========================================================================

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
-- drop ALL existing policies on user_roles before creating canonical.
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='user_roles' LOOP
    EXECUTE format('DROP POLICY %I ON public.user_roles', pol.policyname);
  END LOOP;
END $$;

CREATE POLICY user_reads_own_role ON public.user_roles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY admin_reads_all_roles ON public.user_roles
  FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE POLICY admin_writes_roles ON public.user_roles
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- auth_allowlist
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

-- ==========================================================================
-- Tier 5: Scout tables (active workflow tool -- editor+ access).
-- ==========================================================================

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
      -- drop EVERY existing policy on this table, not just
      -- the ones we know by name. Catches legacy Supabase-UI policies
      -- ('Enable read access for all users' etc.) that named drops miss.
      FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t);
      END LOOP;
      EXECUTE format(
        'CREATE POLICY editor_full ON public.%I FOR ALL TO authenticated USING (public.is_editor()) WITH CHECK (public.is_editor())',
        t
      );
    END IF;
  END LOOP;
END $$;

-- ==========================================================================
-- Anon role: zero table grants. The pre-magic-link allowlist RPC needs
-- EXECUTE access; nothing else does.
-- ==========================================================================

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;

-- Single anon-accessible RPC: pre-magic-link allowlist check.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'is_email_allowed') THEN
    GRANT EXECUTE ON FUNCTION public.is_email_allowed(text) TO anon;
  END IF;
END $$;

-- ==========================================================================
-- Authenticated role: explicit SELECT grants on data tables. RLS still
-- gates rows. Without the grant, even an admin's SELECT would 403.
-- ==========================================================================

GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;

-- (RLS policies determine what each authenticated user can actually do.)

-- ==========================================================================
-- Default privileges for future tables. Without these, a new table created
-- after this migration will not be readable until manually granted.
-- ==========================================================================

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon;

COMMIT;

-- ==========================================================================
-- Smoke-test post-apply (run manually in Supabase Studio SQL editor):
-- ==========================================================================
--
-- -- As anon:
-- SET ROLE anon;
-- SELECT count(*) FROM public.offices;           -- ERROR: permission denied (good)
-- SELECT public.is_email_allowed('test@x.com'); -- OK (anon can call this RPC)
-- RESET ROLE;
--
-- -- As authenticated viewer (in app: open app as a viewer-role user):
-- -- Open browser DevTools console on Prod, signed in as a viewer:
-- await window._sb.from('offices').select('id').limit(1);   -- OK
-- await window._sb.from('offices').insert({name:'x'});      -- error (RLS deny)
-- await window._sb.from('user_roles').select('*');          -- returns ONLY own row
--
-- -- As authenticated editor:
-- await window._sb.from('offices').insert({name:'test'});   -- OK
-- await window._sb.from('budget_pes').update({}).eq('id','x'); -- error (admin only)
--
-- -- As authenticated admin:
-- await 