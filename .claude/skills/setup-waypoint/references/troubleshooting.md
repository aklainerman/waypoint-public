# Setup-waypoint troubleshooting

Known failure modes encountered during real Waypoint deployments,
with diagnostic steps and fixes. Reference this when an install
goes sideways.

## Deploy succeeded but app shows "Supabase URL not configured"

**Cause (F-NEW-NETLIFY-1)**: `SUPABASE_URL` or `SUPABASE_ANON_KEY` was
marked as a secret value in Netlify. Netlify drops secret-marked env
vars from the function build environment, so `functions/config.js`
returns an empty config and the client can't initialize.

**Diagnostic**: Open the site, F12 console. Look for an error like
`config.supabaseUrl is undefined` or a Supabase client init failure.
In Netlify dashboard, check Site settings > Environment variables -
if either has a lock icon or "Contains secret values" checked, that's
the bug.

**Fix**:
1. Site settings > Environment variables.
2. Click each of `SUPABASE_URL` and `SUPABASE_ANON_KEY`.
3. Uncheck "Contains secret values" / remove from secret scope.
4. Trigger a redeploy (Deploys > Trigger deploy > Deploy site).

Hard-refresh the browser after the deploy completes.

`SUPABASE_SERVICE_ROLE_KEY` SHOULD remain marked secret. Only the
client-readable pair must not be.

## Changed an env var, but the app doesn't see it

**Cause (F-NEW-NETLIFY-2)**: Netlify functions snapshot env vars at
the moment of the most recent deploy. Changing an env var in the
dashboard does NOT trigger a redeploy automatically.

**Fix**: Deploys > Trigger deploy > Deploy site. Wait for the build
to complete (~30 sec), then hard-refresh.

## Sign-in flow rejects my email pre-send

**Cause**: The `auth_allowlist` table doesn't contain the email being
entered, so the `is_email_allowed` RPC returns false and the magic
link send is skipped.

**Diagnostic**: In Supabase SQL editor:
```sql
SELECT * FROM auth_allowlist;
SELECT public.is_email_allowed('your-email@example.com');
```

**Fix**:
```sql
INSERT INTO auth_allowlist (email) VALUES ('your-email@example.com')
ON CONFLICT (email) DO NOTHING;
```

## Magic link email never arrives

**Possible causes**:

1. **Spam filter**. Supabase free-tier sends from `noreply@mail.supabase.io`.
   Check spam/junk folders. Whitelist the sender.
2. **Email rate limit**. Supabase free tier rate-limits passwordless
   sends. Wait 60 sec between attempts.
3. **Wrong email in allowlist**. The `is_email_allowed` RPC short-
   circuits send-side. Verify the allowlist contains the exact email
   (case-insensitive but otherwise exact - no aliases).

**Diagnostic**: Supabase dashboard > Authentication > Logs. Filter to
the last hour. Look for `magic_link.send` entries with status.

## Schema apply (000_initial_schema.sql) errored mid-flight

**Cause**: The Supabase project was not actually empty. `pg_dump`-style
output uses `CREATE TABLE` (not `IF NOT EXISTS`), so the first table
that already exists aborts the transaction.

**Diagnostic**:
```sql
SELECT table_name FROM information_schema.tables WHERE table_schema='public';
```

**Fix**: Reset the project completely.
1. Supabase dashboard > Settings > Database > Reset database.
2. Confirm. This drops all tables, data, functions, and RLS.
3. Re-run the setup-waypoint skill from Phase 3.

## Seed apply fails with FK constraint violation

**Cause**: Files applied out of order. Lexicographic sort (`01_*` ->
`18_*`) preserves FK-dependency order; manually applying in a different
order skips parent rows.

**Diagnostic**: Look at which file failed. If the error mentions
`pe_office_links` failing FK to `budget_pes`, you skipped one of the
`03_budget_pes_*.sql` chunks.

**Fix**: Identify the missing parent table. Re-apply all earlier
files in lexicographic order. The seeds are idempotent (`ON CONFLICT
DO NOTHING`), so re-running is safe.

## Scout tab is hidden but ANTHROPIC_API_KEY is set

**Cause**: Env var change didn't get a redeploy (see F-NEW-NETLIFY-2 above).

**Fix**: Trigger a Netlify redeploy. Hard-refresh.

If it's still hidden after a redeploy, F12 the page, check
`window.SCOUT_AVAILABLE` in the console. If `false`, fetch
`/.netlify/functions/config` and look at the response - it should
include `"scoutAvailable": true`. If it's false in the response,
the Anthropic key didn't reach the function env. Re-check Netlify
env vars.

## Optional/rls_stage.sql or optional/rls_demo.sql got applied by accident

**Cause (F-NEW-STAGE-RLS-1 family)**: One of the optional environment-
specific RLS files was applied on top of `001_rls.sql`. Stage RLS
denies anon reads outside admin-tagged users; demo RLS adds the 4-layer
write defense including blanket write denials.

**Diagnostic**:
```sql
SELECT policyname FROM pg_policies WHERE schemaname='public'
ORDER BY tablename, policyname;
```
Look for policies named `*_stage_*` or `*_demo_*`.

**Fix**: Drop the optional policies, leave `001_rls.sql`'s policies in place.
```sql
-- example - adjust to actual policy names
DROP POLICY "deny_writes_when_demo" ON budget_pes;
-- etc, for each *_stage_* or *_demo_* policy
```

Or reset the database (above) and re-run setup-waypoint without applying
the optional files.

## Netlify build fails on first deploy

**Likely causes**:

1. **Function bundling error**. `functions/*.js` files import a missing
   dependency. Rare on a clean fork - investigate `functions/package.json`
   if present.
2. **netlify.toml syntax error**. The committed `netlify.toml` is known
   good; check for accidental edits.
3. **Node version mismatch**. Set `NODE_VERSION=18` (or `20`) in env vars,
   redeploy.

**Diagnostic**: Open the failed deploy in Netlify dashboard, read the
build log from top to bottom.

## PDF deep-link buttons all 404

**Expected**. PDFs are not bundled with the snapshot. To enable them
the user must follow `supabase/seed/budget/PDF_MANIFEST.md`'s 4-step
setup. This is documented as optional in the public README.

If a single PDF 404s but others work, check the exact filename in the
Supabase Storage bucket matches the `source_pdf` column value
character-for-character (no extra spaces, no case mismatch).

## Magic link arrives but bounces to localhost:3000

**Cause (F-NEW-SUPA-SITEURL)**: Supabase Auth's default Site URL is
`http://localhost:3000`. The default email templates use
`{{ .SiteURL }}` as the redirect target. On a fresh project, magic-
link emails embed localhost as the redirect, so clicking the link
takes the user to a non-existent local dev server instead of the
deployed app.

**Diagnostic**: Open the magic-link email. Inspect the link URL.
If it points at `localhost:3000`, Site URL is unset.

**Fix**:
1. Supabase dashboard for the project > Authentication >
   URL Configuration.
2. Set Site URL to the Netlify URL (e.g. `https://your-site.netlify.app`).
   No trailing slash.
3. Under Redirect URLs, add both `https://your-site.netlify.app`
   and `https://your-site.netlify.app/**`. The first allows the exact
   root; the second whitelists any sub-path the magic-link callback
   might land on. Supabase rejects redirects not in this list as
   phishing attempts and falls back to Site URL.
4. Click Save.

The change is read live by Supabase on each magic-link generation;
no redeploy needed. Request a new magic link, the next email points
at the Netlify URL.

## Signed in as viewer, not admin (first user)

**Cause (F-NEW-AUTH-TRIGGER-1)**: The `handle_new_user()` trigger
function exists in the schema but the corresponding
`CREATE TRIGGER on_auth_user_created` was never applied. `pg_dump`
silently omits triggers on the `auth` schema because the dumper does
not own auth.* objects. Without the trigger:

- A successful magic-link sign-in inserts a row into `auth.users`.
- No trigger fires on that insert.
- The client (js/auth/...) queries `user_roles` for the new user_id
  via single-object SELECT, gets HTTP 406 (zero rows where one
  expected) from PostgREST, and falls through to a default `viewer`.
- The trigger's first-user-becomes-admin logic never fires; no admin
  can be bootstrapped without manual SQL.

**Diagnostic**:
```sql
-- Should return at least one row:
SELECT tgname FROM pg_trigger WHERE tgname = 'on_auth_user_created';

-- And the user_roles table should have an admin row for the first user:
SELECT u.email, r.role FROM auth.users u
LEFT JOIN public.user_roles r ON u.id = r.user_id;
```

If `pg_trigger` query returns zero rows, the trigger is missing.

**Fix**:
1. Apply `supabase/migrations/003_auth_trigger.sql`.
2. Manually backfill any existing users:
   ```sql
   INSERT INTO public.user_roles (user_id, role)
   SELECT id, 'admin'::public.waypoint_user_role
   FROM auth.users
   WHERE email = '<first-user-email>'
   ON CONFLICT (user_id) DO UPDATE SET role = 'admin';
   ```
3. Sign out + back in in the browser. Client re-fetches role on each
   load; admin panel appears.

This migration ships in the snapshot under `supabase/migrations/`.
The setup-waypoint skill applies it as Phase 3, file 4 of 4.

## envVarIsSecret: true silently dropped the value

**Cause (F-NEW-NETLIFY-3)**: The Netlify MCP's `manage-env-vars` operation accepts an `envVarIsSecret` flag. When set to `true`, the upsert call returns success ("Environment variable upserted") but the value is silently dropped — the key shows up in `getAllEnvVars` with no value (or doesn't show up at all). The build runs with the variable missing.

This is worse than F-NEW-NETLIFY-1, which only affects `SUPABASE_URL` / `SUPABASE_ANON_KEY` at build time. F-NEW-NETLIFY-3 affects ANY variable upserted with `envVarIsSecret: true`, including service-role keys and Anthropic keys.

**Diagnostic**: Right after every `manage-env-vars` upsert, call `getAllEnvVars` and confirm the key is present AND has a non-empty value. If it's missing or empty, the upsert lied.

**Fix**: Always upsert with `envVarIsSecret: false`. The "secret" flag in Netlify only affects build-log redaction and a few internal warnings; it has no effect on the value-visibility model. Function-scoped env vars are never sent to the browser by design — the `Yes/No` column in the env-vars table is cosmetic.

```javascript
// Wrong:
manage_env_vars({ key: "ANTHROPIC_API_KEY", value: "sk-...", envVarIsSecret: true })

// Right:
manage_env_vars({ key: "ANTHROPIC_API_KEY", value: "sk-...", envVarIsSecret: false })
```

## deploy-site doesn't actually deploy

**Cause (F-NEW-NETLIFY-4)**: The Netlify MCP's `deploy-site` operation does not trigger a deploy from a Claude session. It returns a CLI command intended for the user to run locally:

> "To deploy this to Netlify, run the following command within the source/repo directory:
> `npx -y @netlify/mcp@latest --site-id <id> --proxy-path "..."`"

This requires Node + npx in the user's shell, in the repo's working directory. From a sandboxed Claude environment, you can't run it; from the user's machine, they're often not set up to run it conveniently mid-conversation.

**Fix**: Don't try `deploy-site` from the skill. Instead, instruct the user:

> "Open `https://app.netlify.com/projects/<site-name>/deploys` and click **Trigger deploy** → **Deploy site**. Build takes ~30 seconds. Tell me when it shows `Published`."

Wait for them to confirm before proceeding to smoke checks. The first deploy MUST run after env vars are set (F-NEW-NETLIFY-2), or function bundles ship with empty config.

## Pooler hostname returns "Tenant or user not found"

**Cause (F-NEW-MCP-1)**: Supabase pooler hostnames changed convention around 2025. New projects use `aws-1-<region>.pooler.supabase.com`; older projects use `aws-0-<region>.pooler.supabase.com`. The MCP's `get_project` returns the *direct* connection host (`db.<ref>.supabase.co`), not the pooler host — and on most plans the direct host requires IPv6, which isn't reachable from sandboxes.

**Diagnostic**:
```
psql: error: connection to server at "aws-0-us-east-1.pooler.supabase.com" failed
FATAL:  Tenant or user not found
```

**Fix**: Switch the `aws-N` digit. For 2025+ projects, use `aws-1-`. Full format:

```
postgresql://postgres.<project-ref>:<password>@aws-1-<region>.pooler.supabase.com:5432/postgres
```

The username includes the project ref after `postgres.` — that's how the pooler multi-tenants requests. Don't drop the `.` separator.

## Schema apply fails with "schema public already exists"

**Cause (F-NEW-SEED-1)**: Older snapshots of `supabase/migrations/000_initial_schema.sql` use a bare `CREATE SCHEMA public;` statement. Supabase auto-creates the `public` schema on every new project, so the bare CREATE errors with `duplicate_schema`.

**Diagnostic**: First migration fails immediately on line ~24 with:
```
ERROR:  schema "public" already exists
```

**Fix**: The current snapshot ships `CREATE SCHEMA IF NOT EXISTS public;`. If you're applying an older snapshot, string-replace before retrying:

```bash
# macOS / Linux:
sed -i.bak 's/^CREATE SCHEMA public;/CREATE SCHEMA IF NOT EXISTS public;/' supabase/migrations/000_initial_schema.sql

# Windows PowerShell:
(Get-Content supabase/migrations/000_initial_schema.sql -Raw) -replace '(?m)^CREATE SCHEMA public;$', 'CREATE SCHEMA IF NOT EXISTS public;' | Set-Content supabase/migrations/000_initial_schema.sql
```

Then re-apply the migration.

## Seed apply errors with "column is of type jsonb but expression is of type text[]"

**Cause (F-NEW-SEED-2)**: Older snapshots of the seed files emit raw `ARRAY[$$a$$, $$b$$]` literals for jsonb columns. Postgres rejects `text[] -> jsonb` without an explicit cast.

**Diagnostic**:
```
ERROR:  column "aliases" is of type jsonb but expression is of type text[]
LINE 5: ...ARRAY[$$ACC$$, $$Air Combat Command$$, ...
```

**Fix**: The current snapshot wraps every jsonb-bound array as `to_jsonb(ARRAY[...])`. If applying an older snapshot, run the patch script at the repo root:

```bash
# Same on every OS:
python3 _build_patch_jsonb.py
# or on Windows where python3 may not exist:
python _build_patch_jsonb.py
```

The script is idempotent — re-running after the patch lands is a no-op. It walks every `.sql` file in `supabase/seed/budget/` and wraps every ARRAY literal assigned to a jsonb column.

If the older snapshot also has `02_budget_orgs.sql` in alphabetical (not topological) order, the self-FK on `parent_id` will also fail. Run `_build_patch_toposort.py` in addition — it sorts roots before children.


## Bash sandbox cannot delete files in FUSE mount

**Cause (F-NEW-V221-1)**: Sandboxed bash environments (some MCP runners,
some Cowork modes) mount the user's filesystem via FUSE which blocks
`unlink`. Writes succeed; deletes fail with `Operation not permitted`.

**Not encountered during forker installs** - this is a Claude-side
build artifact, mentioned here only so the skill doesn't try to delete
files via shell. If a cleanup is needed (rare), instruct the user to
run the corresponding command from their native PowerShell or terminal.
