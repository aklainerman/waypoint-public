# Demo environment

Public, read-only, anonymized version of Waypoint. Lives at https://your-demo-site.netlify.app (and any custom domain you set).

## What the demo shows

- Full budget corpus: appropriations, PEs, SAGs, procurement lines, narratives, topline. Same data Prod and Stage have.
- Office tree (organizational hierarchy). Office names + tiers + locations only — no notes, no contacts attached.
- Hill members + committees + memberships. Public Congress data; safe to display.

## What the demo deliberately does NOT show

- `contacts` — every entry is a real person we've corresponded with. Stripped.
- `solicitations` — pipeline data for the prospects you're tracking. Stripped.
- `letters` — letters of support we've drafted/uploaded. Stripped.
- `requests` — outreach requests. Stripped.
- `washops` — Washington Ops engagement log. Stripped.
- `hill_meetings` and `hill_requests` — our recorded interactions with Hill staff. Stripped.
- `office_media` — uploaded images/files attached to office cards. Stripped.
- `scout_*` and `apollo_phone_webhook_log` — Scout LLM history + Apollo enrichment results. Stripped.
- `auth_allowlist`, `user_roles` — empty; demo has no users.

## How writes are blocked

Four independent layers (see `ARCHITECTURE.md` for full detail):

1. CSS hides every Edit/Delete/Add/Save button when `body.demo-mode` is set.
2. JS mutation handlers all early-return when `DEMO_MODE === true`.
3. Supabase RLS on the DEMO project denies INSERT/UPDATE/DELETE for `anon` role.
4. Scout/Apollo Netlify functions return 404 when `WAYPOINT_ENV=demo`.

Any one of these is enough to block a visitor from mutating data. Together they're paranoid-grade.

## Refreshing demo data

Run quarterly or after major budget updates. See `DEPLOY.md` → "Demo data refresh runbook."

```bash
python scripts/seed_demo.py
python scripts/verify_read_only.py --url https://your-demo-site.netlify.app
```

## Adding a new visible field

If you add a new column to a data table that the demo should also display:

1. Apply the schema migration to Stage → Demo → Prod (per `DEPLOY.md`).
2. Update `scripts/seed_demo.py` to copy the new column from Stage.
3. Re-run the seeder.

If the new column is sensitive (e.g., contains real names or contact info), update the seeder to NULL or redact it on copy.

## Visibility / branding

The dashboard footer shows `Waypoint Demo` instead of `Waypoint` when `env === 'demo'`. This is a visual signal to the user that they're not on a real environment. Set in the inline JS near the bottom of `index.html`.

## What happens if WAYPOINT_ENV is missing on the Demo site?

- `config.js` returns `env: "unknown"` with a `warning` field.
- Inline JS treats `env !== 'demo'` as "not demo mode," so DEMO_MODE stays false.
- **Edit/Delete buttons would render!** But Supabase RLS would still block the writes at the server.

In other words: a misconfiguration would let a visitor *click* buttons, but they wouldn't actually mutate data. The demo would look broken (failed write attempts) but data would stay safe.

If you ever see this happen, check the Demo Netlify site's env vars first — `WAYPOINT_ENV` must be the string `demo`.

## Demo doesn't have

- Scout (LLM CRM agent). The button is hidden; the endpoint returns 404.
- Apollo enrichment.
- Letters upload (no `letters` storage bucket bound).
- Office image uploads.
- Any auth flow — demo is anonym