# Scout — the LLM-driven research agent

Scout is an opt-in feature inside Waypoint that automates contact research
on DoD offices using free public sources plus optional paid enrichment.
It's a multi-turn Anthropic agent loop running as a Netlify background
function, with events streamed back to the browser via short-poll on the
`scout_jobs.events` JSONB column.

This document covers (1) what Scout does, (2) what each API key buys you,
(3) how to wire the optional Apollo phone-reveal webhook, and (4) the
graceful-degradation behavior when keys are missing.

If you don't want Scout, set nothing — the template detects the missing
key, hides the Scout tab + sidebar link, and returns 503 if anyone hits
the function endpoint directly. The rest of the app is unaffected.

## What Scout does

A Scout "search" is a conversation. The user describes who they want to
find (e.g. "find the program manager for PEO Aviation's UH-60 Modernization
office"), and the agent loop:

1. Searches Waypoint's own DB first via the `search_waypoint` tool —
   already-tracked offices / contacts / solicitations / Hill engagement
   surface immediately without external API calls.
2. Disambiguates if the office name is ambiguous (ASKS a yes/no
   clarifier first, doesn't blast tool calls).
3. Searches free-tier external sources via tools:
   - `search_usaspending` — federal contract history (free)
   - `web_search` — general web (free, via the agent's built-in tool)
   - `fetch_url` — read a specific page
   - `search_dvids` — military news + imagery (free, generous quota)
   - `search_sam_gov` — federal-contract opportunity confirmation
     (free, ~1k requests/day; tool prompt enforces "confirmation only,
     never discovery" to stay under quota)
4. Stages findings as `propose_finding` (contact) or
   `propose_office_finding` (new office) which the user reviews and
   commits to the CRM with one click.
5. (Optional) Apollo enrichment — after the agent loop ends, a
   deterministic post-loop pass batches every contact finding with a
   missing/guessed email and bulk-matches against Apollo's people API
   to upgrade to a verified work email + LinkedIn URL + title.

The system prompt enforces three non-negotiables: military-brevity tone
(no "Great!" / "Let me search..." filler), search-Waypoint-first ordering,
and a citation rule (no email/phone/linkedin without a `sources` entry).
See `functions/scout-background.js` for the canonical SYSTEM_PROMPT and
tool inventory.

## API keys

### Required for Scout

| Key | Purpose | Where to get it | Cost |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Powers the agent loop. Sonnet 4.5 by default. | [console.anthropic.com](https://console.anthropic.com) | Pay-per-token. A typical Scout search runs ~3-8 turns and burns single-digit cents in input tokens, low-double-digit cents in output. |

Without this key, the Scout tab is hidden entirely and any direct hit to
`/.netlify/functions/scout*` returns 503 `{"error": "scout_disabled"}`.
Everything else in Waypoint works fine.

### Optional model overrides

| Key | Default | Purpose |
|---|---|---|
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5` | The model for the main agent loop. Override if you want to test a newer Sonnet release or downgrade to Haiku for cheap experimentation (Haiku is too cheap to be useful here — the tool-use chain is too long). |
| `ANTHROPIC_TITLE_MODEL` | `claude-haiku-4-5-20251001` | Cheap one-shot model that auto-titles each Scout search from the user's first message. Haiku is deliberate; don't pay Sonnet rates for 6-word titles. |

### Optional enrichment (Scout works without these but with thinner output)

| Key | Purpose | Where to get it | Cost |
|---|---|---|---|
| `APOLLO_API_KEY` | Verified email + LinkedIn URL + title for contact findings. Bulk-match call batches up to 10 names per request. | [developer.apollo.io](https://developer.apollo.io) | Paid plan required. ~1 credit per matched person for email; mobile phone reveals consume additional credits. |
| `APOLLO_REVEAL_PERSONAL_EMAILS` | Set to `"1"` to fetch personal emails (not just work). Costs extra credits. | (feature flag) | Apollo credits. |
| `APOLLO_REVEAL_PHONE` | Set to `"1"` to enable async mobile/direct phone reveal. Apollo returns these via webhook several minutes after the call. | (feature flag) | Apollo credits; requires the webhook wiring below. |
| `APOLLO_WEBHOOK_URL` | The public URL Apollo will POST phone-reveal results to. MUST end in `?token=<APOLLO_WEBHOOK_TOKEN>`. | (your deploy URL) | Free. |
| `APOLLO_WEBHOOK_TOKEN` | Shared secret. Apollo doesn't sign webhook deliveries, so the URL token is the only auth. Pick any long random string. | (self-generated, e.g. `uuidgen`) | Free. |
| `APOLLO_WEBHOOK_DEBUG` | Set to `"1"` to echo Apollo's parsed payload back in the webhook's 200 response. Dev only — leaks Apollo data. | (debug flag) | Free. |
| `SAM_GOV_API_KEY` | Federal contract confirmation (NAICS, opportunity ids). The tool prompt enforces a confirmation-only posture so you stay under the hard daily rate limit. | [sam.gov/data-services](https://sam.gov/data-services) | Free. |
| `DVIDS_API_KEY` | Military news + imagery search. Used by Scout for context ("when did this PM last appear in a DVIDS press release?"). Generous quota. | [api.dvidshub.net](https://api.dvidshub.net) | Free. |

## Setting up the Apollo phone-reveal webhook

Apollo's phone reveals are asynchronous — Apollo confirms acceptance
synchronously, then posts the actual phone numbers minutes later to a
webhook URL you provide. If you want phone enrichment:

1. Generate a token. Any long random string. `uuidgen` is fine.
   ```bash
   uuidgen
   # -> 01HXYZ12345...
   ```
2. Set the env vars on your Netlify site:
   ```
   APOLLO_API_KEY=<from apollo.io dashboard>
   APOLLO_REVEAL_PHONE=1
   APOLLO_WEBHOOK_TOKEN=01HXYZ12345...
   APOLLO_WEBHOOK_URL=https://<your-site>.netlify.app/.netlify/functions/scout-apollo-phone-webhook?token=01HXYZ12345...
   ```
3. **CRITICAL: if your Netlify site has visitor-access password
   protection enabled, Apollo's webhook POST will be 401'd by the edge.**
   Either disable site password, or deploy the webhook function to a
   separate Netlify site without password protection (and point
   `APOLLO_WEBHOOK_URL` at that site).
4. Verify wiring: `GET https://<your-site>/.netlify/functions/scout-apollo-phone-webhook`
   returns a small JSON health check showing which env vars are set.
5. Trigger a Scout search that produces a contact finding, then watch
   `scout_findings.phone_pending` flip to `false` and `scout_findings.phone`
   populate a few minutes later when Apollo's webhook fires.

The webhook is idempotent — Apollo may retry on 5xx, and the function
dedupes on `(apollo_id, sanitized_number)` via the
`apollo_phone_webhook_log` table. It never downgrades a verified phone
to a lower-confidence value on retry.

## Graceful degradation behavior

Three layers of defense against a misconfigured deploy:

| Layer | Where | Behavior |
|---|---|---|
| Config flag | `functions/config.js` | Returns `scoutAvailable: Boolean(process.env.ANTHROPIC_API_KEY)` in the boot payload. |
| Client UI gate | `js/db/supabase.js` `_initSupabase` | When `scoutAvailable` is false, sets `window.SCOUT_AVAILABLE = false`, adds `scout-disabled` class on `<body>`, and `hidden=true`'s the Scout tab button, sidebar rail link, and tab panel. `activateTab` in `js/nav/tabs.js` additionally redirects `'scout'` calls to `'dashboard'`. |
| Function 503 | Each `functions/scout*.js` handler | Returns `503 {"error": "scout_disabled"}` if `ANTHROPIC_API_KEY` is missing. The Apollo webhook gates on `APOLLO_API_KEY` separately and returns `503 {"error": "apollo_disabled"}` if that's missing. |

Demo mode (`WAYPOINT_ENV=demo`) unconditionally forces `SCOUT_AVAILABLE`
to false in the client AND returns `404 {"error": "not_found"}` from each
Scout function — a defense-in-depth that makes Scout fully invisible
even if someone manages to flip the client flag in a demo deployment.

## Architecture pointer

Scout's runtime is intentionally three files plus a webhook:

- `functions/scout.js` — the kickoff. Creates `scout_searches` + `scout_messages` + `scout_jobs` rows, fires the background worker, returns immediately.
- `functions/scout-background.js` — the long-running worker (~2000 LOC). Runs the full Anthropic agent loop in a single Netlify Background Function invocation (15-minute budget), persists events to `scout_jobs.events` as it goes.
- `functions/scout-status.js` — the polling endpoint. Client calls `?job_id=<id>&since=<int>` ~every 1.5s; returns the events appended since `since`.
- `functions/scout-apollo-phone-webhook.js` — receives Apollo's async phone-reveal callbacks and patches `scout_findings.phone` by `apollo_id`.

Tool implementations live inline in `scout-background.js`; the dispatch
table near the top of the file enumerates everything the agent can call.
Add new tools by appending to that dispatch table plus the matching
schema entry in the `tools` array passed to the Anthropic API.
