---
name: setup-waypoint
description: Install Waypoint on a fresh Supabase + Netlify environment. Drives the entire end-to-end setup using the Supabase and Netlify MCPs - applies schema and RLS migrations, seeds DoD budget + Hill data, configures auth allowlist, creates the Netlify site, wires env vars, triggers deploy, returns the live URL. Use when the user has forked Waypoint and says any of - "set up waypoint", "install waypoint", "deploy waypoint", "I forked waypoint help me set it up", "configure my waypoint instance", "get my waypoint running".
---

# Setup Waypoint

You are setting up a Waypoint deployment for someone who forked the repo and wants you to drive the install. Be conversational, confirm each major step, surface errors clearly with remediation.

This skill is OS-neutral. The user may be on Windows, macOS, or Linux — every step below works the same way because you drive Postgres via `psycopg2` (pure Python) and never depend on a specific shell.

## Required MCPs

Before starting, verify these MCPs are connected:

- **Supabase MCP** (for `list_projects`, `list_tables`, `execute_sql`, `apply_migration`)
- **Netlify MCP** (for site creation, env vars, deploy management)
- **GitHub MCP** (optional - lets you fork the repo on the user's behalf; otherwise the user forks manually)

If any required MCP is missing, tell the user which one to connect and link to https://docs.claude.com/en/docs/agents-and-tools/mcp - then stop.

## Direct Postgres is also required for the seed phase

The seed phase (Phase 4) applies ~116 SQL files totaling ~161 MB. Each `execute_sql` call requires reading the file's full content into your conversation context, then sending it as a tool-call argument — this is not feasible at that scale (the schema dump alone is ~57k tokens).

**Ask the user for their Supabase database password upfront in Phase 1.** Use `psycopg2` (preferred — pure Python, works the same on Windows / macOS / Linux, no system binaries to install) for the seed apply via the Supabase **pooler** endpoint. Reserve MCP `execute_sql` / `apply_migration` for small verification queries and the four schema migrations.

If `psycopg2` isn't already installed, install it once via:

```bash
python3 -m pip install --user psycopg2-binary
```

(`psycopg2-binary` ships pre-built wheels for every common platform — no compiler toolchain required.)

The pooler connection string format (IPv4-reachable from any sandbox, works on every OS):

```
postgresql://postgres.<project-ref>:<db-password>@aws-1-<region>.pooler.supabase.com:5432/postgres
```

**Region note**: Supabase projects created in 2025+ use `aws-1-*` pooler hostnames. Older projects use `aws-0-*`. If the first attempt fails with `Tenant or user not found`, switch the `aws-N` digit and retry. (F-NEW-MCP-1.)

## What the user must do themselves

Tell the user upfront that these steps stay manual - you cannot do them through the MCPs:

1. **Create a free Supabase project.** Go to https://supabase.com/dashboard, click New Project, pick a name and region. Save the database password somewhere — they will paste it to you in Phase 1.
2. **Have a GitHub fork of `reesemozer/waypoint`.** If they have GitHub MCP connected you can offer to do the fork; otherwise they fork via github.com UI.
3. **Click the magic-link email** at the very end to sign in.
4. **(Optional) Provide an Anthropic API key** if they want Scout (the LLM-powered contact research agent) enabled.
5. **Link the GitHub fork to the Netlify site** (Phase 6), **configure Supabase Auth Site URL** (Phase 7.5), and **trigger the first Netlify deploy** (Phase 8). All three are dashboard-only operations — no current MCP exposes them.

Everything else - schema, seeds, allowlist, Netlify site shell, env vars, function endpoint smoke checks - you handle.

## Orchestration protocol

Walk the user through these phases conversationally. At each phase boundary, summarize what you did and ask permission before continuing if there is any state change.

### Phase 1 - Gather inputs

Ask the user (in one message, conversationally):

- The Supabase project ref (the 20-char alphanumeric ID from Settings > General > Reference ID, e.g. `abcdefghijklmnopqrst`).
- The Supabase project region (e.g. `us-east-1`, `eu-west-2`). Needed to build the pooler hostname.
- **The Supabase database password.** Needed for the seed phase via psycopg2. Tell the user: "Needed for the seed phase — MCP can't stream 161 MB of seeds practically. I'll only use it once; you can rotate it after install if you want."
- The GitHub URL of their Waypoint fork (e.g. `https://github.com/their-username/waypoint`).
- The email address they want allowlisted for sign-in (must be one they can receive email at).
- Whether they want Scout enabled. If yes, ask for their Anthropic API key. They can get one at https://console.anthropic.com. Cost is ~$0.10-$1 per Scout query.
- (Optional) Apollo API key (paid, for email/phone enrichment), SAM.gov API key (free), DVIDS API key (free), Congress.gov API key (free, for nightly Hill data refresh). All optional - skip unless they say yes.

Tell them: "If you skip any optional key, the corresponding feature is gracefully disabled - the app still works, that feature just isn't exposed."

### Phase 2 - Verify the Supabase project is empty

Call `list_projects` to confirm the project ref is one they own. Then call `execute_sql` against that project:

```sql
SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public';
```

Expected: `n = 0` for a fresh project. If `n > 0`, STOP and tell the user the project is not empty. Ask them to either drop the existing tables (Settings > Database > Reset database) or create a new Supabase project. Do not proceed on a non-empty project - the schema apply will fail mid-flight and leave broken state.

### Phase 3 - Apply schema, RLS, and the auth RPC

Apply these four files in order via `apply_migration` (one per call):

1. `supabase/migrations/000_initial_schema.sql` (116 KB - 40 tables, 85 indexes, 23 functions)
2. `supabase/migrations/001_rls.sql` (15 KB - Row-Level Security policies)
3. `supabase/migrations/002_is_email_allowed.sql` (2 KB - allowlist enforcement RPC)
4. `supabase/migrations/003_auth_trigger.sql` (1 KB - wires handle_new_user trigger onto auth.users)

**Why 003 is separate:** `pg_dump` silently omits triggers on schemas the dumper doesn't own (auth.* is Supabase-managed). Without 003, the first user to sign in lands with no user_roles row, defaults to viewer, and the first-user-becomes-admin logic never fires.

**Migration 000 schema-collision guard:** The file uses `CREATE SCHEMA IF NOT EXISTS public;` so it's safe to re-apply against any Supabase project (which always pre-creates the `public` schema). If you ever see a `duplicate_schema` error, the user has an older copy of the snapshot before this guard was added — pull the latest, or string-replace `CREATE SCHEMA public;` → `CREATE SCHEMA IF NOT EXISTS public;` in the file before retrying. (F-NEW-SEED-1.)

Optional - do NOT apply by default:
- `supabase/migrations/optional/rls_stage.sql` - only if the user explicitly wants stage-environment semantics
- `supabase/migrations/optional/rls_demo.sql` - only if the user explicitly wants a public read-only demo

If `apply_migration` errors on 000 with anything other than `duplicate_schema` (which the IF NOT EXISTS guard prevents), the project was not actually empty. Stop and ask the user to reset.

Verify after each:

```sql
-- After 000:
SELECT count(*) FROM information_schema.tables WHERE table_schema='public';  -- expect ~40

-- After 001:
SELECT count(*) FROM pg_policies WHERE schemaname='public';  -- expect 80+

-- After 002:
SELECT public.is_email_allowed('test@example.com');  -- expect: false

-- After 003:
SELECT tgname FROM pg_trigger WHERE tgname = 'on_auth_user_created';  -- expect: one row
```

Report each verification to the user.

### Phase 4 - Apply budget + Hill seed data

This is the longest phase but it's fast over a direct Postgres connection — roughly 30 seconds for all 116 files, not the 5-10 minutes you'd see going through MCP `execute_sql`.

Read `supabase/seed/budget/README.md` for the canonical apply order and per-table row counts.

**How to apply via psycopg2** (works identically on Windows, macOS, Linux). Build a small inline Python script:

```python
import glob
import os
import psycopg2

DB_URL = "postgresql://postgres.<project-ref>:<password>@aws-1-<region>.pooler.supabase.com:5432/postgres"

seed_dir = "supabase/seed/budget"
files = sorted(f for f in glob.glob(os.path.join(seed_dir, "*.sql")))
print(f"Applying {len(files)} seed files...")

with psycopg2.connect(DB_URL) as conn:
    conn.autocommit = True
    with conn.cursor() as cur:
        for i, path in enumerate(files, 1):
            with open(path, "r", encoding="utf-8") as fh:
                sql = fh.read()
            cur.execute(sql)
            if i % 10 == 0 or i == len(files):
                print(f"  [{i}/{len(files)}] {os.path.basename(path)}")
```

Use `bash` or your equivalent to run this — same script across all OSes. List the files via `Glob` (OS-neutral) before running so you can confirm the count is 116 (or 118 including the `README.md` and `PDF_MANIFEST.md` non-SQL siblings, which the `*.sql` filter excludes).

If running on a Windows host without `python3`, fall back to `python` (Windows installer maps `python` to the active interpreter; macOS/Linux convention is `python3`).

If any `cur.execute()` raises an error other than benign `ON CONFLICT DO NOTHING`-style notices:
- If it's a FK constraint violation, you skipped a file or the file list isn't lexicographically sorted. Re-apply earlier files.
- If it's a `column is of type jsonb but expression is of type text[]` error, the user has an older snapshot before the jsonb fix landed — point them at the latest commit. (F-NEW-SEED-2.)
- Otherwise, report the SQL error verbatim and pause for the user.

After completion, verify row counts via MCP `execute_sql` (single small query, MCP is the right tool):

```sql
SELECT
  (SELECT count(*) FROM budget_appropriations) AS appropriations,
  (SELECT count(*) FROM budget_orgs) AS orgs,
  (SELECT count(*) FROM budget_pes) AS pes,
  (SELECT count(*) FROM budget_om_sags) AS sags,
  (SELECT count(*) FROM pe_narratives) AS pe_narr,
  (SELECT count(*) FROM hill_members) AS hill_members;
```

Expected (from the seed README): `appropriations=205 orgs=201 pes=2143 sags=389 pe_narr=1753 hill_members=536`. Report results to the user.

### Phase 5 - Bootstrap the auth allowlist

Apply via `execute_sql`:

```sql
INSERT INTO auth_allowlist (email) VALUES ('user@example.com')
ON CONFLICT (email) DO NOTHING;
```

Substitute the email from Phase 1. The `ON CONFLICT` clause makes this idempotent so re-running the skill never errors here. Then verify:

```sql
SELECT public.is_email_allowed('user@example.com');  -- expect: true
```

### Phase 6 - Create the Netlify site

Via Netlify MCP, call `create-new-project` with a name like `waypoint-<their-username>` (let them adjust). Pass `teamSlug` if they have multiple Netlify teams.

**Honest reality**: the current Netlify MCP does NOT expose an operation to link a Git repository to a site. `create-new-project` gives you a blank site; the user must link their GitHub fork themselves via the Netlify dashboard. There are two ways to handle this:

- **Recommended path** — create the site via MCP first so you can set env vars before the first deploy (Phase 7), then instruct the user to open `https://app.netlify.com/projects/<site-name>/configuration/deploys` → "Link repository" and pick their fork. Wait for confirmation before proceeding.
- **Alternative path** — instruct the user to use the "Import an existing project" wizard at https://app.netlify.com/start from the start (one wizard does Git linking + first deploy). They then paste back the site ID and you continue from Phase 7. Downside: the first deploy runs without env vars, so functions return errors until Phase 7+8 land.

Pick the recommended path unless the user says they prefer the all-in-dashboard flow.

Build settings: leave default — `netlify.toml` in the repo specifies them (publish dir `.`, functions dir `functions/`, no build step needed).

### Phase 7 - Set environment variables

Set these via the Netlify MCP (`netlify-project-services-updater` or equivalent). **Set every variable with `envVarIsSecret: false`** — see the warning below.

| Variable | Value | Secret flag |
|---|---|---|
| `WAYPOINT_ENV` | `prod` | No |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | **No** (F-NEW-NETLIFY-1) |
| `SUPABASE_ANON_KEY` | (anon key from Supabase Settings > API) | **No** (F-NEW-NETLIFY-1) |
| `SUPABASE_SERVICE_ROLE_KEY` | (service role key from Supabase Settings > API) | **No** (F-NEW-NETLIFY-3) |
| `ANTHROPIC_API_KEY` | (if Scout enabled) | **No** (F-NEW-NETLIFY-3) |

Optional (skip unless the user provided them in Phase 1):

| Variable | Purpose |
|---|---|
| `APOLLO_API_KEY` | Apollo email enrichment |
| `SAM_GOV_API_KEY` | SAM.gov contract confirmation |
| `DVIDS_API_KEY` | Military news context |
| `CONGRESS_GOV_API_KEY` | Hill data nightly sync |

**Critical (F-NEW-NETLIFY-1)**: `SUPABASE_URL` and `SUPABASE_ANON_KEY` must NOT be marked as secret. Netlify drops env vars marked secret from the build environment at deploy time, which causes `functions/config.js` to fail with a missing-config error.

**Critical (F-NEW-NETLIFY-3 — newly identified)**: The Netlify MCP's `envVarIsSecret: true` path can silently drop the *value* from server-side storage entirely. The upsert call returns success ("Environment variable upserted") but `getAllEnvVars` afterward shows the key with no value. **Set every variable with `envVarIsSecret: false`** regardless of whether it's a secret-class key. The "secret" flag in Netlify only affects build-log redaction; function-scoped env vars are never sent to the browser by design. Recommend `false` everywhere.

After setting, verify by calling `getAllEnvVars` and confirming every key from your list shows up with a non-empty value. If a key is missing or has an empty value, re-upsert it (with `envVarIsSecret: false`).

### Phase 7.5 - Configure Supabase Auth Site URL

**Critical**: Supabase's default Site URL is `http://localhost:3000`. Magic-link emails embed the Site URL as the redirect target, so without changing it the user clicks the email link and lands on localhost.

This step CANNOT be automated through the Supabase MCP (no current tool exposes Auth URL config). Instruct the user manually:

> "Open your Supabase dashboard for this project, go to Authentication > URL Configuration. Set Site URL to `<netlify-url>` (no trailing slash). Then in Redirect URLs, add two entries: `<netlify-url>` and `<netlify-url>/**`. Click Save. This change is read live by Supabase on each magic-link send, so no redeploy needed."

Wait for the user to confirm they've saved the change before proceeding.

### Phase 8 - Trigger deploy and wait

**Honest reality (F-NEW-NETLIFY-4)**: the Netlify MCP's `deploy-site` operation does NOT trigger a deploy from your environment — it returns a CLI command (`npx -y @netlify/mcp@latest --site-id ... --proxy-path "..."`) for the user to run locally. You can't run it from a sandboxed Claude session.

**Instead, instruct the user**: "Open `https://app.netlify.com/projects/<site-name>/deploys` and click **Trigger deploy** -> **Deploy site**. Build takes ~30 seconds. Tell me when it shows `Published`."

Wait for confirmation. Functions snapshot env vars at first deploy (F-NEW-NETLIFY-2) so this must run AFTER Phase 7 — otherwise the function bundle ships with empty config and the next change requires another redeploy.

If deploy fails, ask the user to copy the build log and paste it. Most common failures:
- Function bundling error — corrupt `functions/*.js` — rare since the snapshot is squashed.
- Env var missing — Phase 7 didn't land. Re-set with `envVarIsSecret: false` and re-deploy.

### Phase 9 - Smoke-check function endpoints

Before declaring done, verify the deployed function layer is healthy. Three quick checks (use `mcp__workspace__web_fetch` or curl-equivalent):

1. **Site root** — `GET https://<site-name>.netlify.app/` should return 200 with HTML containing `<title>Waypoint`.
2. **Config function** — `GET https://<site-name>.netlify.app/.netlify/functions/config` should return 200 with JSON containing `supabaseUrl` (non-empty) and `scoutAvailable` (`true` if Anthropic key was set, `false` otherwise). If `supabaseUrl` is missing, F-NEW-NETLIFY-1 fired — re-check Phase 7 and redeploy.
3. **Scout status function** —
   - If Scout enabled: `GET https://<site-name>.netlify.app/.netlify/functions/scout-status` should return **400** with `{"error":"job_id required"}` (Scout works, just needs a job_id parameter).
   - If Scout NOT enabled: same endpoint should return **503** with `{"error":"scout_disabled"}` (graceful degradation working).

Report each result to the user. Any 5xx or unexpected response surfaces a real bug — pause and investigate before handoff.

You can also have the user run `python3 scripts/verify_install.py` (or `python scripts/verify_install.py` on Windows) from their fork checkout, which does the same three checks plus the row-count verification in one go.

### Phase 10 - Hand off

Report to the user:

```
Done. Your Waypoint deployment is live at:
  <site-url>

Smoke checks (Phase 9):
  PASS  GET /                                    200 OK
  PASS  GET /.netlify/functions/config           scoutAvailable=<true|false>, supabaseUrl=present
  PASS  GET /.netlify/functions/scout-status     <400 if Scout enabled | 503 if disabled>

Final manual steps (you do these):

1. Open <site-url> in your browser.
2. Enter your allowlisted email (<email>) and click Send magic link.
3. Check your inbox for an email from noreply@mail.supabase.io. Click the link.
4. You should land signed in on the Dashboard. The Budget tab and Hill Ops tab populate from the seed; CRM tabs (Offices, Contacts, Solicitations, Letters, Washops) start empty for you to fill.

Optional follow-ups:
- Set up PDF deep-links: see supabase/seed/budget/PDF_MANIFEST.md.
- Enable Hill data nightly refresh: add CONGRESS_GOV_API_KEY to Netlify env, redeploy.
- Add more allowlisted users: INSERT INTO auth_allowlist via Supabase SQL editor.
- Run scripts/verify_install.py to re-verify row counts + function endpoints any time.
```

Then ask if they want to test Scout end-to-end (if `ANTHROPIC_API_KEY` was set). If yes, suggest: "Open the Scout tab and try a query like `Find acquisition POCs at AFWERX`. Costs roughly $0.10-$1 in Anthropic tokens."

## Recovery / re-running

The whole flow is idempotent on retry IF you stopped before Phase 6:

- Migrations 000-003 are mostly idempotent: 000's `CREATE SCHEMA IF NOT EXISTS` is safe, but `CREATE TABLE` is not — re-running Phase 3 against a partially-populated project will fail on the first existing table. Reset the project (Settings > Database > Reset database) and start over.
- Seeds ARE idempotent (every INSERT carries ON CONFLICT DO NOTHING). Re-running Phase 4 is safe.
- auth_allowlist INSERT is idempotent (the skill wraps with `ON CONFLICT (email) DO NOTHING`).
- Netlify site creation is one-shot. If you retry after partial Phase 6, list existing sites first and reuse the matching one.

If a user has a broken half-finished install:
1. Offer to drop everything: `Settings > Database > Reset database` on Supabase + delete the Netlify site.
2. Or fix in place: identify which phase failed, do the missing operations, continue.

## Known failure modes

See `references/troubleshooting.md` for the full table. Top hits:

- **F-NEW-NETLIFY-1**: `SUPABASE_URL` / `SUPABASE_ANON_KEY` marked secret -> dropped at build -> "Missing config" error in browser console. Fix: unmark, redeploy.
- **F-NEW-NETLIFY-2**: Env vars changed after deploy don't take effect until next deploy. Functions snapshot env at first build. Fix: trigger redeploy.
- **F-NEW-NETLIFY-3**: `envVarIsSecret: true` may silently drop value entirely (worse than F-NEW-NETLIFY-1). Fix: always use `envVarIsSecret: false`; verify with `getAllEnvVars` after each upsert.
- **F-NEW-NETLIFY-4**: `deploy-site` returns a CLI command, not a triggered deploy. Fix: instruct user to click "Trigger deploy" in dashboard.
- **F-NEW-SUPA-SITEURL**: Supabase default Site URL is localhost:3000 -> magic-link redirects to localhost. Fix: Phase 7.5.
- **F-NEW-AUTH-TRIGGER-1**: First user lands as viewer because `on_auth_user_created` trigger missing. Fix: ensure migration 003 applied.
- **F-NEW-MCP-1**: Pooler hostname uses `aws-1-*` for 2025+ projects, not `aws-0-*`. Fix: retry with switched digit.
- **F-NEW-SEED-1**: `CREATE SCHEMA public;` errors on fresh Supabase project (Supabase auto-creates public). Fixed in current snapshot via `IF NOT EXISTS`; if an older snapshot is in play, string-replace before applying.
- **F-NEW-SEED-2**: Legacy snapshots emit raw `ARRAY[...]` for jsonb columns; Postgres rejects `text[] -> jsonb`. Fixed in current snapshot via `to_jsonb(ARRAY[...])` wrapping; older snapshots can be patched via `_build_patch_jsonb.py` at the snapshot root.
- **F-NEW-STAGE-RLS-1**: If the user accidentally applied the stage RLS migration (`optional/rls_stage.sql`), anon reads will be blocked. Fix: drop the policies it added, re-apply `001_rls.sql`.
- **Magic link not arriving**: Check Supabase Settings > Authentication > Email Templates. Free tier sends from `noreply@mail.supabase.io`; aggressive spam filters may bin it.

## Env var reference

For the full list of env vars Waypoint reads, including model overrides and the Apollo webhook setup, see `references/env_vars.md`.
