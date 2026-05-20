-- 003_auth_trigger.sql
--
-- Attach the public.handle_new_user() trigger to auth.users so that the
-- first sign-in on a fresh deployment auto-creates a user_roles row.
--
-- Why this is a separate migration: pg_dump silently omits triggers on the
-- `auth` schema because the dumping role doesn't own auth.* objects (it's
-- Supabase-managed). The OSS snapshot at 000_initial_schema.sql therefore
-- ships the FUNCTION but not the TRIGGER that wires it up. Without this
-- migration:
--   * The first user to sign in lands with NO row in public.user_roles
--   * The client (js/auth/...) does a single-object SELECT against
--     user_roles, gets HTTP 406 from PostgREST (zero rows where one expected)
--   * Falls through to a default 'viewer' role
--   * The "first user becomes admin" logic in handle_new_user() never fires
--     and no admin can ever be bootstrapped without manual SQL
--
-- This migration is idempotent: DROP IF EXISTS before CREATE.

BEGIN;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

COMMIT;
