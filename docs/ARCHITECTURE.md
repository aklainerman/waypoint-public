# Waypoint architecture

## One codebase, up to three environments

Waypoint is a browser-only ES-module dashboard: `index.html` (~270 KB
of chrome shell + inline CSS) plus ~50 modules under `js/` plus a
handful of Netlify Functions under `functions/`. It supports up to
three deployments off a single `main` branch, differentiated at
runtime by the `WAYPOINT_ENV` environment variable. A minimum viable
deployment is one site set to `prod`; stage and demo are optional
extensions documented below.

```
                       (one git repo, branch=main)
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
   <your-prod-site>        <your-stage-site>           <your-demo-site>
   WAYPOINT_ENV=prod       WAYPOINT_ENV=stage          WAYPOINT_ENV=demo
   Supabase: <prod>        Supabase: <stage>           Supabase: <demo>
   API keys per           API keys per                 (deliberately no
   `.env.example`         `.env.example`              optional API keys;
                                                       Scout/Apollo 404)
```

## Environment contract

Every Netlify site sets, at minimum:

| Env var | Required | Notes |
|---|---|---|
| `WAYPOINT_ENV`       | yes | `prod` \| `stage` \| `demo`. Authoritative source of "what environment am I in." |
| `SUPABASE_URL`       | yes | `https://<project-ref>.supabase.co` |
| `SUPABASE_ANON_KEY`  | yes | Publishable key. Read-only on demo (RLS-enforced). |
| `SUPABASE_SERVICE_ROLE_KEY` | yes (functions only) | RLS-bypass for daemon writes from `functions/`. Never expose to browser. |
| `ANTHROPIC_API_KEY`  | optional | Powers Scout. Absent → Scout tab hidden + functions 503. Demo always 404s Scout regardless of this key. |
| `APOLLO_API_KEY`     | optional | Apollo email/phone enrichment for Scout. Absent → Scout works without enrichment; webhook 503s. |
| `APOLLO_WEBHOOK_TOKEN` + `APOLLO_WEBHOOK_URL` | optional | Required only if `APOLLO_REVEAL_PHONE=1`. Async Apollo phone callback. |
| `SAM_GOV_API_KEY`    | optional | Scout solicitation lookups. Free tier sufficient. |
| `DVIDS_API_KEY`      | optional | Scout DVIDS image lookups. |
| `CONGRESS_GOV_API_KEY` | optional | Hill members nightly refresh. Absent → Hill data is static from seed. |

See `.env.example` for the full env-var list with descriptions, and
`docs/SCOUT.md` for the Scout-specific keys + graceful degradation
behavior.

The `functions/config.js` endpoint reads these at request time and returns `{env, supabaseUrl, supabaseAnonKey}` to the client at boot. There is no build-time env injection.

## How demo-mode works (defense in depth)

Three independent layers prevent demo visitors from mutating data:

**Layer 1 — Client UI hides write controls.** On boot, `js/db/supabase.js`'s `_initSupabase` reads `env` from `/.netlify/functions/config`. If `env === 'demo'`, it sets `DEMO_MODE = true` and adds the `demo-mode` class to `<body>`. A small set of CSS rules then hides every Edit, Delete, Add, Save, and Scout button. (Scout is additionally hidden whenever `ANTHROPIC_API_KEY` is absent, regardless of env — see `docs/SCOUT.md`.)

**Layer 2 — Client handlers early-return.** Every mutation handler (save-office, delete-contact, etc.) calls `if (DEMO_MODE) return demoToast();` at its entry. Belt and suspenders against missed CSS rules.

**Layer 3 — Server-side RLS denies writes.** The DEMO Supabase project (`<YOUR_DEMO_PROJECT_REF>`) has Row Level Security policies that grant `anon` SELECT but deny INSERT/UPDATE/DELETE on all data tables. Even if a hostile visitor opens devtools and dispatches a raw `supabase.from('contacts').insert()`, Supabase rejects with 401.

**Layer 4 — Scout endpoints 404 on demo.** The four `scout-*.js` Netlify functions check `process.env.WAYPOINT_ENV === 'demo'` at handler entry and return `404` without touching Anthropic or Apollo. (Anthropic/Apollo keys are also deliberately not set on the demo site, so even bypassing the guard would fail.)

## What's where

```
waypoint/
├── index.html                  # chrome shell + inline CSS + module tags (~270 KB)
├── js/                         # ~50 ES modules organized by feature area
│   ├── boot.js, boot-app.js    # bootstrap + legacy-key migration
│   ├── auth/                   # login overlay + admin panel
│   ├── chrome/wire.js          # sidebar, topbar, keyboard shortcuts, KPI tiles
│   ├── core/                   # event-bus, refresh, utils, year-toggle
│   ├── db/                     # Supabase client, narrative helpers, rollup
│   ├── demo/demo-mode.js       # lazy-loaded; demo write blockers + SDK intercept
│   ├── drawer/year-toggle.js   # per-row drawer FY26/FY27 toggle
│   ├── modal/                  # office modal, select helpers, PDF deep-link button
│   ├── nav/                    # tab routing, drill-through, subtab dispatch
│   ├── render/                 # ~25 tab/panel renderers (dashboard, budget, hill, etc.)
│   ├── scout/scout-client.js   # Scout tab UI + event-stream polling
│   ├── source/source-line.js   # PE/SAG drawer source-line + deep-link
│   ├── theme/theme.js          # dark/light/dim cycle
│   └── admin/settings-actions.js  # Export/Import JSON, Share-Export
├── functions/
│   ├── config.js               # env + supabase keys bridge; reports `scoutAvailable`
│   ├── scout.js                # LLM agent kickoff (demo-404; scout-503 without key)
│   ├── scout-background.js     # 15-min LLM worker (same gates)
│   ├── scout-status.js         # job poller (same gates)
│   ├── scout-apollo-phone-webhook.js  # async Apollo phone reveal (apollo-503 without key)
│   └── hill-sync.js            # nightly Congress data refresh
├── supabase/
│   ├── migrations/             # numbered SQL; apply in order. v233 = RLS posture, v234 = email allowlist enforcement.
│   └── seed/
│       └── budget/             # public DoD FY27 PB data as SQL INSERTs, numbered 01-18 in FK-dependency order
├── scripts/
│   ├── seed_demo.py            # cross-project Stage→DEMO data copy (template)
│   ├── seed_one_local.py       # seed a single Supabase project from local JSON dumps
│   └── verify_read_only.py     # adversarial test against a deployed demo URL
├── tests/
│   └── smoke/                  # Playwright suite: RLS, demo write-defense, smoke render
├── docs/
│   ├── ARCHITECTURE.md         # (this file)
│   ├── DEPLOY.md               # deploy runbook + Swap-vendors section
│   ├── DEMO.md                 # demo-mode write-defense reference
│   ├── RLS.md                  # role model + apply order + rollback
│   ├── SCOUT.md                # Scout agent + API keys + graceful degradation
│   └── SMOKE.md                # how to run the Playwright suite
├── netlify.toml
└── .env.example
```

## Versioning

- `main` is always production-ready. Pushing to `main` triggers deploys on all three Netlify sites simultaneously.
- Feature work happens on `feature/<short-name>` branches. Netlify auto-builds a deploy preview per PR; the preview URL is what you test before merging.
- Releases are tagged on `main`: `git tag v179 && git push --tags`. The old `netlify_vNNN/` folder pattern is retired — tags + commits are the audit trail.
- Hotfix releases: branch from the affected tag, fix, merge to `main`, re-tag.

## Supabase project map

| Env | Project | Project ref | Notes |
|---|---|---|---|
| Prod  | Waypoint | `<YOUR_PROD_PROJECT_REF>` | Live data. Mutations gated by user role. |
| Stage | Staging  | `<YOUR_STAGE_PROJECT_REF>` | Mirror of Prod. Bulk experiments land here first. |
| Demo  | DEMO     | `<YOUR_DEMO_PROJECT_REF>` | Anonymized subset of Stage data. RLS deny-write. |

Schema changes go through `supabase/migrations/NNN_short_description.sql`. Migrations are applied in the order: **Stage → Demo → Prod.** This catches breakage on Stage (no live users), validates on Demo (smaller blast radius, easier reset), then promotes to Prod.

## Data quality notes

Calibration the snapshot ships with — read this before drawing conclusions from the pre-loaded data.

- **Budget figures (PE / SAG / Procurement line dollar amounts)** are extracted verbatim from the public J-Books (DoD comptroller FY27 PB justification books). High confidence at the line-item level; the figures match the source PDFs. Any errors are extraction bugs against published source material, not opinions.
- **Org tree structure** (which DoD subordinate-organizations exist; the parent → child relationships) is hand-curated. High confidence. The 201 entries in `budget_orgs` reflect a deliberate model of the DoD acquisition hierarchy, not a generated list.
- **PE → Office assignments** (the `pe_office_links` table, 6,911 rows; same shape for `sag_office_links`) are **LLM-derived and approximately 80% accurate at the entity level.** The mapping was generated by running each PE's narrative through an LLM pass that picked the most likely owning org from the curated tree. It's the right starting point for surfacing the Budget tab's organizing axis, but individual assignments will be wrong. The Edit Office modal in the running app exposes these tags for per-row correction — refining them is expected forker work, not a bug.
- **Narrative text** (PE planned program / justification / mission description; same for SAGs and Procurement lines) is extracted from J-Book PDFs via a page-header-stripping pipeline. Most pages parse cleanly; some leave residual header artifacts. The seed README links to the source PDF page for every row, so spot-checks are easy.
- **Hill data** (members, committees, memberships) is from public Congress.gov API data, 119th Congress snapshot. Drift starts the moment that Congress's roster changes; set `CONGRESS_GOV_API_KEY` to enable the nightly resync.

## Why this shape

- **ES modules from a chrome `index.html`** instead of a build step.
  No bundler, no transpilation. The browser loads each `js/*` module
  directly via `<script type="module">` tags in `index.html`. Trade-off:
  more network round-trips on cold load; benefit: zero build complexity,
  view-source readability, trivial debug + iteration.
- **Multiple Netlify sites watching the same branch** (for forkers who
  want stage + demo) beats Netlify "deploy contexts" because each site
  has independent env vars and an independent deploy lifecycle. If
  prod goes down, demo doesn't care. A minimum viable deployment is
  one site; the multi-site pattern is opt-in.
- **Cross-env behavior gates on `WAYPOINT_ENV` only.** Not on URL, not
  on hostname, not on user. One variable, one truth — the demo defense
  layers, Scout availability, and CRM write paths all read the same
  source.
- **Functions-as-feature-gates.** Optional features (Scout, Apollo
  enrichment, Hill sync) check `process.env.<KEY>` at handler entry
  and 503 cleanly if missing. The client mirrors this via
  `functions/config.js`'s `scoutAvailable` flag and hides the relevant
  UI. Forkers who don't want Scout set nothing and Scout disappears
  with no errors.
