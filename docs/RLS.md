# Row Level Security (RLS) — Waypoint

Defines the security posture for all three Supabase projects.
Authoritative source: `supabase/migrations/001_rls.sql` (with env-specific
variants under `supabase/migrations/optional/`).

## Project map

| Env | Project ref | Netlify site | Audience |
|---|---|---|---|
| Prod | `<YOUR_PROD_PROJECT_REF>` | `<your-prod-site>` | Real users, real data |
| Stage | `<YOUR_STAGE_PROJECT_REF>` | `<your-stage-site>` | Internal testing |
| Demo | `<YOUR_DEMO_PROJECT_REF>` | `<your-demo-site>` | Public read-only, fake data |

## Role model (Prod + Stage)

Authentication is magic-link via Supabase Auth, gated by an allowlist
(`auth_allowlist` table). Once authenticated, the user's role is
looked up in `user_roles` (one row per user, role in `{viewer, editor, admin}`).

| Role | Reads | Writes |
|---|---|---|
| **anon** | Nothing (except `is_email_allowed` RPC) | Nothing |
| **viewer** | All CRM, Budget, Hill data. Own row of `user_roles` only. | Nothing |
| **editor** | Same as viewer | CRM tables (offices/contacts/sols/letters/washops/requests/hill_meetings/hill_requests/office_media + PE/SAG link tables) + Scout tables |
| **admin** | All tables including `user_roles` (all rows), `auth_allowlist` | All tables, including budget reference + auth + Scout |

## Role model (Demo)

No authenticated tier. Anonymous visitors only.

| Role | Reads | Writes |
|---|---|---|
| **anon** | Curated subset of tables (see below) | Nothing |

Anon-readable tables on Demo: offices, contacts, solicitations, letters,
washops, requests, hill_*, pe_*_links/dismissals/suggestions,
sag_*_links/dismissals/suggestions, all budget_* and pe_/om_/proc_/
narrative tables.

Anon-hidden tables on Demo: `office_media` (file URLs), `scout_*`,
`user_roles`, `auth_allowlist`, `apollo_phone_webhook_log`.

Demo seed data uses **fake emails and phone numbers** so contacts can be
fully visible without PII leakage. Real DoD office names are kept (they
are public information).

## Helper functions

Each project's migration defines three SECURITY DEFINER functions in
`public`:

| Function | Returns | Purpose |
|---|---|---|
| `user_role()` | `text` | Returns role from `user_roles` for `auth.uid()`, NULL if not present |
| `is_editor()` | `boolean` | True if `user_role() IN ('editor', 'admin')` |
| `is_admin()` | `boolean` | True if `user_role() = 'admin'` |

These are SECURITY DEFINER so they bypass `user_roles` RLS when called
from a policy on another table. Without that, every policy check would
recurse into `user_roles` RLS.

## Apply order

### Single-environment ("prod") deployment

On your one Supabase project, apply in numeric order:

1. `supabase/migrations/000_initial_schema.sql` (creates tables)
2. `supabase/migrations/001_rls.sql` (default RLS posture)
3. `supabase/migrations/002_is_email_allowed.sql` (hardens the allowlist RPC)

Before running 001, ensure your own admin row exists in `user_roles`:

```sql
SELECT * FROM public.user_roles WHERE user_id = auth.uid();
```

If empty, INSERT yourself as admin via Studio (which runs as `service_role`
and bypasses RLS) BEFORE applying 001 — otherwise you'll lock yourself out.

### Multi-environment (prod + stage + demo)

Same numbered files on the prod project. On the stage / demo projects,
apply 000 and 002 as normal, but apply the env-specific file from
`supabase/migrations/optional/` **instead of** 001:

| Project | Schema (always) | RLS file | Allowlist |
|---|---|---|---|
| Prod | `000_initial_schema.sql` | `001_rls.sql` | `002_is_email_allowed.sql` |
| Stage | `000_initial_schema.sql` | `optional/rls_stage.sql` | `002_is_email_allowed.sql` |
| Demo | `000_initial_schema.sql` | `optional/rls_demo.sql` | (skip — demo has no login) |

**Apply order across environments: Stage first → Prod → Demo.** That
sequence minimizes blast radius — a bad policy on Stage breaks internal
testing only, and you can fix it before promoting.

After applying any RLS migration, smoke-check:
- Sign in to that environment as yourself; confirm the app loads.
- Sign in as a viewer-role user (if you have one); confirm read-only.
- Run `npm run smoke` locally — `tests/smoke/rls-anon-*.spec.js` should pass.

## Rollback

If a Prod or Stage migration locks you out (most common cause: your
user_roles row is missing or wrong role), recover via Supabase Studio's
SQL editor (it runs as `service_role`, which bypasses RLS):

```sql
INSERT INTO public.user_roles (user_id, role)
VALUES ('<your-auth-uid>', 'admin')
ON CONFLICT (user_id) DO UPDATE SET role = 'admin';
```

Get your `auth.uid()` from the Authentication → Users panel in Studio.

To fully roll back this RLS posture on a project, drop every policy named:
`authenticated_read`, `editor_insert`, `editor_update`, `editor_delete`,
`admin_write`, `editor_full`, `admin_read`, `user_reads_own_role`,
`admin_reads_all_roles`, `admin_writes_roles`, `admin_read_allowlist`,
`admin_write_allowlist`, `demo_select_anon`. Then re-grant `anon` what
it had before. The migrations are idempotent so this is rare — the
typical recovery is "apply the migration again with the fix" not "revert".

## Verifying RLS is working

Three layers of verification, in order of authority:

1. **Supabase Studio SQL editor, role=anon:**
   ```sql
   SET ROLE anon;
   SELECT count(*) FROM public.contacts; -- ERROR on Prod/Stage; OK on Demo
   RESET ROLE;
   ```

2. **Browser DevTools console (signed in as different roles):**
   ```js
   await window._sb.from('user_roles').select('*');  // viewer: own row only
   await window._sb.from('offices').insert({name:'x'}); // viewer: error
   ```

3. **Automated smoke (Playwright):**
   - `tests/smoke/rls-anon-stage.spec.js` — confirms anon can't SELECT CRM data on Stage.
   - `tests/smoke/rls-anon-demo.spec.js` — confirms anon CAN SELECT public tables on Demo AND CANNOT SELECT hidden tables AND CANNOT write.

## Drift detection

When new tables are added in future migrations, they get NO `anon` grants
by default (per `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON
TABLES FROM anon` at the end of each RLS file). Authenticated users get
full table grants by default; RLS gates row access.

To audit which tables on a project have RLS enabled vs not, run in Studio:

```sql
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY rowsecurity, tablename;
```

Any `rowsecurity = false` rows are exposed. Fix by adding an `ALTER TABLE
… ENABLE ROW LEVEL SECURITY;` block in a follow-up migration.

## Known constraints

- **Column-level masking is not used.** If a future table has a sensitive
  column that must be hidden from a role, the pattern is: create a VIEW
  that excludes the column, grant SELECT on the view, REVOKE SELECT on
  the underlying table. Cleaner than column-level RLS in Postgres.
- **SECURITY DEFINER functions can leak.** Anything tagged `SECURITY
  DEFINER` runs with elevated privileges. Audit before adding.
- **Service_role bypasses everything.** Netlify Functions that need
  unrestricted access use the service_role key. Treat that key as a
  password — it's in the Netlify dashboard env vars and never in git.


