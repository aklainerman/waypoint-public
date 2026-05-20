-- 002_is_email_allowed.sql
--
-- Hardens the `is_email_allowed` RPC so the pre-magic-link allowlist
-- check actually enforces auth_allowlist. Apply on any project that
-- has authenticated user sign-in (a single-environment deployment, or
-- prod + stage if you run multi-env). Demo deployments don't need this
-- (no login overlay).
--
-- Apply via Supabase Studio SQL editor:
-- https://supabase.com/dashboard/project/<YOUR_PROJECT_REF>/sql
--
-- Without this hardening, the bare is_email_allowed() RPC returns TRUE
-- for any email, making the pre-magic-link allowlist check a no-op.
-- Any visitor could submit any email and trigger a magic-link send --
-- a free way to abuse Supabase's auth email quota and a minor email-
-- enumeration vector.
--
-- Correct behavior: return TRUE if and only if the email exists in
-- public.auth_allowlist.
--
-- Idempotent: CREATE OR REPLACE FUNCTION, plus a verify block at the
-- bottom that confirms the new behavior before COMMIT.

BEGIN;

CREATE OR REPLACE FUNCTION public.is_email_allowed(p_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.auth_allowlist
    WHERE lower(email) = lower(p_email)
  );
$$;

-- Anon must remain able to EXECUTE this (called from the login modal
-- before any session exists). 001_rls.sql already granted this; we
-- re-assert here for idempotency in case this migration is applied
-- standalone.
REVOKE ALL ON FUNCTION public.is_email_allowed(text) FROM public;
GRANT EXECUTE ON FUNCTION public.is_email_allowed(text) TO anon;
GRANT EXECUTE ON FUNCTION public.is_email_allowed(text) TO authenticated;

-- Pre-commit verify: a definitely-not-allowed email must return false.
DO $$
DECLARE
  v boolean;
BEGIN
  SELECT public.is_email_allowed('definitely-not-allowed-' || gen_random_uuid()::text || '@example.invalid') INTO v;
  IF v IS NOT FALSE THEN
    RAISE EXCEPTION 'is_email_allowed sanity check failed: should return FALSE for unknown emails; got %', v;
  END IF;
END $$;

COMMIT;

-- Smoke-test (in Studio SQL editor, run as anon):
--   SET ROLE anon;
--   SELECT public.is_email_allowed('your-real-allowlisted-email@example.com'); -- true
--   SELECT public.is_email_allowed('random-bogus@example.com');                -- false
--   RESET ROLE;
