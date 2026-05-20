-- Pre-flight check: is the public schema empty?
-- Used by the setup-waypoint skill to confirm a fresh Supabase project
-- before applying schema migrations. The 000_initial_schema.sql migration
-- uses bare CREATE TABLE (not CREATE TABLE IF NOT EXISTS), so re-running
-- it against a non-empty project will fail mid-flight and leave partial
-- state.
--
-- Expected on a fresh project: count = 0.
-- If count > 0, the skill stops and asks the user to either:
--   1. Reset the project (Supabase Studio: Settings > Database > Reset database)
--   2. Create a new throwaway project and re-run the skill against it.

SELECT count(*) AS public_table_count
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE';
