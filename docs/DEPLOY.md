# Deploy runbook

This document covers **ongoing operations** — pushing changes, authoring
migrations, refreshing demo data, rolling back. For **first-time
install** see one of:

- [`CLAUDE_SETUP.md`](CLAUDE_SETUP.md) — Claude-driven setup (recommended,
  ~30 min)
- [`../README.md`](../README.md) → "Manual install" section — drive every
  step yourself (~3 hours, requires `psql`)

## Pushing a change to all three environments

1. **Branch from main.** `git checkout -b feature/<short-name>`
2. **Edit, commit.** Standard git workflow. Keep commits scoped.
3. **Open a PR.** Netlify auto-creates a deploy preview against Stage. Click the preview URL in the PR check and validate.
4. **Merge to main.** Once merged, all three Netlify sites (prod, stage, demo) rebuild from `main` automatically.
5. **Tag a release** if the change is noteworthy:
   ```bash
   git tag v179
   git push --tags
   ```

## Schema migration runbook

Schema changes live in `supabase/migrations/NNN_description.sql`. Files are numbered to enforce order.

### Authoring a migration

1. Pick the next number (look at the highest existing prefix, add 1).
2. Create the file. Wrap everything in a transaction. Make it idempotent.
   ```sql
   BEGIN;
   ALTER TABLE budget_pes
     ADD COLUMN IF NOT EXISTS new_field text;
   COMMIT;
   ```
3. Test locally against Stage:
   ```bash
   # Via Supabase MCP (preferred) or:
   psql "$STAGE_DB_URL" -f supabase/migrations/179_new_field.sql
   ```
4. Commit + push.

### Applying a migration

**Always Stage → Demo → Prod.** Never the other way.

```bash
# Stage
psql "$STAGE_DB_URL" -f supabase/migrations/179_new_field.sql

# Demo
psql "$DEMO_DB_URL"  -f supabase/migrations/179_new_field.sql

# Prod (only after Stage + Demo are clean)
psql "$PROD_DB_URL"  -f supabase/migrations/179_new_field.sql
```

If you prefer to drive via Claude + the Supabase MCP, ask for `apply_migration` against each project ref:
- Stage: `<YOUR_STAGE_PROJECT_REF>`
- Demo: `<YOUR_DEMO_PROJECT_REF>`
- Prod: `<YOUR_PROD_PROJECT_REF>`

### Rollback

Don't write rollback migrations. Instead:
- For additive changes (most cases): no rollback needed; the old code ignores the new column.
- For destructive changes: write a forward-fix migration (`NNN_revert_xxx.sql`) that undoes the bad change.

## Demo data refresh runbook

The demo dataset is a sanitized subset of Stage. Refresh quarterly (or after a major budget update).

```bash
cd waypoint
# Set up env vars in your shell:
export STAGE_DB_URL='postgres://...stage...'
export DEMO_SERVICE_KEY='<DEMO project service_role key>'
export DEMO_SUPABASE_URL='https://<YOUR_DEMO_PROJECT_REF>.supabase.co'

# Run the seeder
python scripts/seed_demo.py
```

The script is idempotent: it truncates the data tables on DEMO first, then re-seeds from Stage. Sensitive tables (contacts, solicitations, letters, requests, washops, hill_meetings, hill_requests, office_media, scout_*, apollo_phone_webhook_log) are deliberately not seeded — they stay empty.

After re-seeding, run the adversarial verifier against the demo URL:

```bash
python scripts/verify_read_only.py --url https://your-demo-site.netlify.app
```

This attempts a series of writes through the public anon key. All must fail with 401.

## Production rollback

If a `main` push breaks prod:

```bash
# Find the last good commit
git log --oneline -10

# Revert
git revert <bad-sha> --no-edit
git push origin main
```

Or, if the failure is at the Netlify build layer, roll back via Netlify UI: Site → Deploys → "Publish deploy" on the prior green build. Code on `main` is then out of sync with prod, so still revert the offending commit afterward.

## Adding a new Netlify env var

1. Decide which environments need it. Most are prod+stage only.
2. In the Netlify dashboard for each site: Site Settings → Environment variables → Add.
3. If functions need it at build time vs runtime, set the appropriate scope (default `all` is usually right).
4. Trigger a rebuild for the change to take effect (the site picks up new env vars on next deploy).

**`SUPABASE_URL` and `SUPABASE_ANON_KEY` must NOT be marked secret.**
Netlify drops secret-marked env vars from the function build environment,
and `functions/config.js` reads both at build time. Marking either as
secret causes the client to see a missing-config error. The anon key
is browser-safe by design; RLS enforces the actual access control.
`SUPABASE_SERVICE_ROLE_KEY` SHOULD be marked secret.

## Adding a new connector secret (Anthropic, Apollo, etc.)

Set these in Prod and Stage; deliberately omit from Demo:
- `ANTHROPIC_API_KEY`
- `APOLLO_API_KEY`
- `APOLLO_WEBHOOK_TOKEN`
- `APOLLO_WEBHOOK_URL` (must point at the site's own webhook function)
- `SAM_GOV_API_KEY` (optional)
- `DVIDS_API_KEY` (optional)

If you ever expose Demo to scout, remember: the `WAYPOINT_ENV=demo` guard inside each scout function still returns 404 regardless. You'd need to remove the guard too.

## Configuring Supabase Auth Site URL (per-environment)

Each Supabase project has its own Site URL setting. The default is
`http://localhost:3000`, which makes magic-link emails redirect to a
non-existent localhost on every deployed environment until manually
changed.

For each environment (prod, stage, demo):

1. Supabase dashboard for the project → Authentication →
   URL Configuration.
2. Site URL: that environment's Netlify URL (no trailing slash).
3. Redirect URLs: the same URL plus `<url>/**`, one per line.
4. Save. Live immediately; no redeploy needed.

This is the most common new-environment trap: schema applied, seeds
applied, Netlify deployed, env vars set, magic-link email arrives,
click the link, land on localhost. Add to your environment-bootstrap
checklist.

If your deployment needs more than ~4 magic-link emails per hour
(the built-in Supabase SMTP rate limit), also configure custom SMTP
under Authentication → Emails → SMTP Settings. The built-in sender
is `noreply@mail.supabase.io`; fine for testing, not for production.

## CI (future)

Not configured yet. When we add it, a minimal pipeline:
- `node --check index.html`'s inline JS via a small extraction script
- `python -m py_compile scripts/*.py`
- Lint `supabase/migrations/*.sql` for unwrapped transactions

For now, the lint is manual.

## First-time deployment (single environment)

The Quickstart in the top-level `README.md` walks through the minimal viable
prod-only deployment. The rest of this document assumes the multi-environment
prod/stage/demo pattern is already wired. If you only need a single
environment, you can ignore the three-site loops above: set `WAYPOINT_ENV=prod`
on one Netlify site pointed at one Supabase project, apply migrations + seeds
to that project once, and you're done.

## Swap vendors? Honest coupling notes

The template ships preconfigured for **Netlify (host) + Supabase (backend)**.
Both choices are load-bearing but separable, in order of escape difficulty:

### Easy: Netlify → Vercel / Cloudflare Pages

Cost: a few hours of rewiring, no application-code rewrites.

- Replace `netlify.toml` with the equivalent host config
  (`vercel.json` or Cloudflare's `_routes.json` + Workers).
- Rewrite functions in `functions/` for the target host's runtime. The
  Node.js handler signature is similar across all three (`exports.handler =
  async (event) => {...}`); the differences are mostly in event shape
  (query string, headers, body parsing) and the wrapper export style.
- The `/.netlify/functions/<name>` path prefix is hard-coded in client
  fetch calls. On Vercel, switch to `/api/<name>`. On Cloudflare, switch
  to your Workers route prefix. A search-replace across `js/` for
  `/.netlify/functions/` is the bulk of the client-side change.
- Netlify-specific env vars (`COMMIT_REF`, `DEPLOY_PRIME_URL`, `URL`,
  `NETLIFY_SITE_PASSWORD`) have direct equivalents on the other platforms;
  rebind the references inside `functions/config.js`, `functions/scout.js`,
  and `functions/scout-background.js`.

### Moderate: Self-host Supabase (Docker / Postgres + supabase-go)

Cost: a weekend, mostly DevOps work.

- Stand up the open-source Supabase stack via `supabase/docker-compose.yml`
  from the upstream repo (GoTrue + PostgREST + Realtime + Storage).
- Point `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`
  at your self-hosted instance instead of `*.supabase.co`. Zero code
  changes needed — the JS client + REST contract are identical.
- Apply the migrations in `supabase/migrations/` in numeric order against
  your self-hosted Postgres just like you would against the hosted Supabase
  Studio SQL editor.
- This is the cheapest swap if your concern is recurring SaaS spend.
  Maintenance burden becomes Postgres + the Supabase stack instead of
  Netlify's bill, so it's a cost-shape change, not a free lunch.

### Hard: Supabase → Firebase / AWS Amplify / something fundamentally different

Cost: ~50% rewrite, do not undertake lightly.

- Every `_sb.from('table').select(...)` call (~hundreds across `js/db/*`,
  `js/render/*`, `js/scout/*`) maps to a different SDK with a different
  query shape.
- RLS — the policy stack in `supabase/migrations/001_rls.sql` (plus the
  optional environment variants under `supabase/migrations/optional/`) — has
  no direct equivalent on Firebase (Firestore rules are similar in spirit,
  very different in mechanics). You'd rewrite the access-control model
  from scratch.
- The `supabase.auth.signInWithOtp` magic-link flow + `auth_allowlist`
  table + `is_email_allowed` RPC would need a wholesale port to whichever
  IdP the new platform provides.
- The 4-layer Demo write-defense (CSS hide + SDK write-blocker + RLS
  deny-write + function 404) loses one of its 4 layers (RLS) and would
  need re-architecting on the new backend.

If you're considering this, the honest advice is: keep Supabase, swap the
host instead, or build a fresh app and port over only the data model + UI
patterns you actually like.
