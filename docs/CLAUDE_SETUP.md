# Claude-driven setup

The fastest way to get Waypoint running is to let Claude drive the
install. Claude applies the SQL migrations, seeds the budget data,
creates the Netlify site, wires the env vars, and triggers the
deploy. You handle account creation, the GitHub fork, and clicking
the magic-link email at the end.

Total time: ~30 minutes, mostly waiting on Claude to apply ~110
seed files via the Supabase MCP.

## What you'll do yourself

Before invoking Claude, do these three things. They can't be automated.

### 1. Create a Supabase project (free tier)

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) →
   New Project.
2. Pick a name (`waypoint` is fine), a region close to you, and
   generate a strong database password. Save the password locally.
3. Wait ~2 minutes for the project to provision.
4. From **Settings → General**, copy the **Reference ID** (a 20-char
   alphanumeric like `abcdefghijklmnopqrst`). You'll give this to Claude.

That's it for Supabase. Don't create any tables yourself — the project
must be empty when Claude runs.

### 2. Fork this repo

Go to https://github.com/reesemozer/waypoint, click **Fork**, accept
the defaults. The fork URL is `https://github.com/<your-username>/waypoint`.

(If you have a GitHub MCP connected to Claude, you can skip this step
and ask Claude to fork the repo for you instead.)

### 3. Create a Netlify account

Sign up at [app.netlify.com](https://app.netlify.com). Free tier is
fine. You don't need to create a site yet — Claude does that.

## Connect the MCPs to Claude

Claude drives the install through two MCP (Model Context Protocol)
connections to your accounts. Both are official integrations:

- **Supabase MCP** — lets Claude apply migrations and run SQL on your
  Supabase project.
- **Netlify MCP** — lets Claude create the site, set env vars, trigger
  the deploy.

Connect both in your Claude product's MCP settings. The exact UI
varies by product — see https://docs.claude.com/en/docs/agents-and-tools/mcp
for the up-to-date instructions.

Once connected, both should appear as "Connected" in your MCP list.

## Tell Claude to set up Waypoint

In Claude, paste this:

```
Set up Waypoint for me.
```

That's it. The `setup-waypoint` skill loads from your fork (or from
the skill registry, depending on your Claude product) and Claude walks
you through the rest interactively.

Claude will ask you for:

- Your Supabase project ref (the 20-char ID from Step 1)
- Your Supabase project region (e.g. `us-east-1`) — needed for the pooler hostname
- **Your Supabase database password** — needed for the seed phase (Claude streams ~161 MB of seed SQL via direct Postgres, which the MCP can't do practically). Used once for this install; rotate it after if you want.
- Your GitHub fork URL
- The email you want allowlisted for sign-in
- Whether you want Scout enabled (and your Anthropic API key if yes)
- (Optional) Apollo / SAM.gov / DVIDS / Congress.gov API keys

Cross-platform note: this flow works the same on Windows, macOS, and Linux. Claude drives Postgres via `psycopg2` (pure Python), so no shell-specific commands run on your machine — you only paste values back during the conversation.

Answer each. Claude reports progress as it goes through ~110 seed files.

## What happens during the install

Roughly 10 distinct phases. Claude tells you about each one as it runs.

| Phase | What Claude does | Time |
|---|---|---|
| 1 | Asks you for inputs (project ref, region, DB password, fork URL, email, optional keys) | 1–2 min |
| 2 | Verifies your Supabase project is empty | 5 sec |
| 3 | Applies the 4 migrations (schema, RLS, allowlist RPC, auth trigger) | 30 sec total |
| 4 | Seeds budget + Hill data via direct Postgres (psycopg2) — ~116 files, ~161 MB | ~30 sec |
| 5 | Adds your email to `auth_allowlist` | 2 sec |
| 6 | Creates a blank Netlify site, asks you to link your GitHub fork via the Netlify dashboard | ~2 min including manual link step |
| 7 | Sets Netlify env vars (all with `envVarIsSecret: false` to avoid the silent-drop bug) | 30 sec |
| 7.5 | Pauses for you to configure Supabase Auth Site URL (manual, ~2 min) | ~2 min |
| 8 | Asks you to click "Trigger deploy" in the Netlify dashboard, polls for `Published` | ~30 sec build + polling |
| 9 | Smoke-checks function endpoints (`/`, `/.netlify/functions/config`, `/.netlify/functions/scout-status`) | 5 sec |
| 10 | Hands off — you click the magic-link email | — |

At the end, Claude reports:

```
Done. Your Waypoint deployment is live at:
  https://<site-name>.netlify.app
```

## After Claude finishes

Five remaining manual steps (three already done mid-install when
Claude paused; two come last):

1. **Link your GitHub fork to the Netlify site (Phase 6).** Claude
   creates the blank site via MCP, then asks you to open
   `https://app.netlify.com/projects/<site-name>/configuration/deploys`
   → "Link repository" and pick your fork. The Netlify MCP cannot do
   this step today.
2. **Configure Supabase Auth Site URL (Phase 7.5).** Claude pauses to
   ask you to do this. The change cannot be automated through any
   current MCP.
   - Open your Supabase project's dashboard → Authentication →
     URL Configuration.
   - Set Site URL to the Netlify URL Claude reports (no trailing slash).
   - Add that URL and `<url>/**` to Redirect URLs.
   - Click Save. Applies live; no redeploy needed.
   - **Why this matters**: Supabase's default Site URL is
     `http://localhost:3000`. Magic-link emails embed Site URL as the
     redirect target. Without this change, clicking the email link
     bounces you to localhost.
3. **Trigger the first Netlify deploy (Phase 8).** Claude asks you to
   open `https://app.netlify.com/projects/<site-name>/deploys` and
   click **Trigger deploy** → **Deploy site**. The Netlify MCP's
   `deploy-site` operation does not actually trigger a deploy from
   Claude's environment (it returns a CLI invocation for you to run
   locally), so this stays manual. Build takes ~30 seconds.
4. **Open the site URL** and **enter your allowlisted email**, click
   "Send magic link."
5. **Check your inbox for the magic link email** (from
   `noreply@mail.supabase.io`; may be in spam) and click it. You land
   signed-in on the Dashboard.

The Budget tab and Hill Ops tab populate from the seed; CRM tabs
(Offices, Contacts, Solicitations, Letters, Washops) start empty for
you to fill.

## Optional: enable PDF deep-links

The Budget tab's "Source" buttons deep-link into specific pages of
DoD budget justification books. By default these 404 because the
PDFs aren't bundled. To enable, follow the 4-step setup in
[`supabase/seed/budget/PDF_MANIFEST.md`](../supabase/seed/budget/PDF_MANIFEST.md).

Claude can't automate this part — the PDFs are too large to push
through MCP file uploads, and downloading them from comptroller.defense.gov
is a manual step. Plan for ~30 minutes if you want all deep-links
working; or skip it (the rest of the app is unaffected).

## Falling back to a Claude product without skill support

If your Claude product doesn't load `.claude/skills/` files (older
Claude versions, raw API usage, etc.), paste this verbatim into Claude
instead of the short trigger above:

```
I want you to set up Waypoint for me. Drive the entire install via
the Supabase and Netlify MCPs. I'm on <Windows | macOS | Linux> — the
flow is the same on every OS because you'll use psycopg2 (pure Python)
for the seed phase.

Steps:

1. Ask me for: my Supabase project ref, my project region (e.g.
   us-east-1), my Supabase database password (needed for the seed
   phase via direct Postgres — MCP can't stream 161 MB practically),
   my GitHub fork URL, the email I want allowlisted, and whether I
   want Scout enabled (which needs an Anthropic API key).

2. Verify my Supabase project's public schema is empty (
   SELECT count(*) FROM information_schema.tables WHERE table_schema='public'
   should return 0). If not empty, stop and tell me to reset the project.

3. Apply these 4 migrations in order via the Supabase MCP's
   apply_migration tool, against my project ref:
   - supabase/migrations/000_initial_schema.sql
   - supabase/migrations/001_rls.sql
   - supabase/migrations/002_is_email_allowed.sql
   - supabase/migrations/003_auth_trigger.sql
   (Migration 000 uses CREATE SCHEMA IF NOT EXISTS, so re-apply is
   safe against Supabase's auto-created public schema.)

4. Apply every .sql file in supabase/seed/budget/ in lexicographic
   order via psycopg2 against the pooler endpoint:
     postgresql://postgres.<ref>:<password>@aws-1-<region>.pooler.supabase.com:5432/postgres
   (Use aws-1-* for 2025+ projects, aws-0-* for older ones. If you
   get "Tenant or user not found", flip the digit.) There are ~116
   files totaling ~161 MB. Report progress every ~10 files. Total
   runtime ~30 seconds.

5. Insert my email into auth_allowlist with
   ON CONFLICT (email) DO NOTHING.

6. Create a Netlify site via MCP create-new-project. The Netlify MCP
   cannot link a Git repo to a site — instruct me to open
   https://app.netlify.com/projects/<name>/configuration/deploys and
   click "Link repository" → pick my fork. Wait for me to confirm.

7. Set Netlify env vars via manage-env-vars. SET EVERY VARIABLE WITH
   envVarIsSecret: false (the "true" path silently drops the value
   from Netlify storage — F-NEW-NETLIFY-3):
   - WAYPOINT_ENV = prod
   - SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
   - ANTHROPIC_API_KEY if I provided one
   After setting, call getAllEnvVars and verify every key shows up
   with a non-empty value. Re-upsert any that didn't land.

7.5. Tell me to open Supabase dashboard → Authentication → URL
   Configuration and set Site URL to the Netlify URL (no trailing
   slash), plus add the URL and URL/** to Redirect URLs. Wait for me
   to confirm I've saved that change.

8. The Netlify MCP's deploy-site does NOT trigger a deploy from your
   environment (it returns a CLI command for me to run locally).
   Instead, tell me to open
   https://app.netlify.com/projects/<name>/deploys and click
   "Trigger deploy" → "Deploy site". Wait for me to confirm it shows
   "Published". Build takes ~30 seconds.

9. Smoke-check three endpoints via web fetch:
   - GET / → expect 200, HTML with <title>Waypoint
   - GET /.netlify/functions/config → expect 200, JSON with
     supabaseUrl non-empty and scoutAvailable=<true|false>
   - GET /.netlify/functions/scout-status → expect 400 if Scout
     enabled, 503 if not
   Report results.

10. Report the live URL and tell me to check my email for the magic
    link.

My OS: <Windows | macOS | Linux>
My Supabase project ref: <paste your ref here>
My Supabase region: <e.g. us-east-1>
My Supabase DB password: <paste; rotate after install if desired>
My GitHub fork URL: https://github.com/<your-username>/waypoint
Allowlist email: <your email>
Anthropic key (skip if no): <paste or skip>
```

Adjust the values at the bottom. Claude follows these instructions
without needing the skill loaded.

## If something goes wrong

The skill includes a troubleshooting reference at
[`.claude/skills/setup-waypoint/references/troubleshooting.md`](../.claude/skills/setup-waypoint/references/troubleshooting.md).
Common issues:

- **App shows "Supabase URL not configured"**: `SUPABASE_URL` or
  `SUPABASE_ANON_KEY` was marked as secret in Netlify. Unmark, redeploy.
- **Magic link arrives but redirects to `localhost:3000`**: Supabase
  Auth Site URL was not configured. Open Supabase dashboard →
  Authentication → URL Configuration; set Site URL to your Netlify URL.
- **Magic link doesn't arrive**: Check spam. Free-tier Supabase sends
  from `noreply@mail.supabase.io` and rate-limits to ~4 emails/hour.
  For higher volume, configure custom SMTP under Authentication →
  Emails → SMTP Settings.
- **Sign-in rejects your email**: The `auth_allowlist` insert
  didn't land. Run it manually in Supabase SQL editor.
- **Schema apply errored mid-flight**: The project wasn't empty. Reset
  via Supabase Settings → Database → Reset database, start over.

For the full failure-mode catalog, read the troubleshooting reference.
Or ask Claude — paste the error message and your install will recover
or restart from the right phase.

## When you want to start over

Wipe the Supabase project (Settings → Database → Reset database) and
delete the Netlify site, then re-run the install. Total cleanup time
is ~2 minutes.

The skill is idempotent on seeds (every INSERT has `ON CONFLICT DO
NOTHING`) but **not** on schema — `000_initial_schema.sql` uses bare
`CREATE TABLE`, so a partial install requires a database reset before
retry.
