# Waypoint env var reference

Full enumeration of environment variables Waypoint reads. Set these in
your hosting provider's environment configuration. Netlify users set
them at Site settings > Environment variables.

The `setup-waypoint` skill only sets the required + optional vars the
user explicitly enables. For everything else (model overrides, webhook
debug flags, site password protection), use this reference to set
them post-install.

## Required

| Variable | Purpose | Mark as secret? |
|---|---|---|
| `WAYPOINT_ENV` | One of `prod`, `stage`, `demo`. Gates Demo mode and stage banners. | No |
| `SUPABASE_URL` *or* `SUPABASE_DATABASE_URL` | Backend connection URL. The Netlify Supabase integration sets one or the other depending on integration version; `functions/config.js` accepts either. | **No (see warning below)** |
| `SUPABASE_ANON_KEY` *or* `SUPABASE_PUBLISHABLE_KEY` | Backend anon JWT. Browser-visible by design (RLS guards the actual data). | **No (see warning below)** |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend admin key. Used by `functions/*` for RLS-bypassed daemon writes. **Never expose to the browser.** | Yes |

### Why SUPABASE_URL / SUPABASE_ANON_KEY must NOT be marked secret

Netlify drops env vars marked as secret values from the build environment
when bundling functions. Both `SUPABASE_URL` and `SUPABASE_ANON_KEY` are
read at build time by `functions/config.js` to populate the client-readable
runtime config. Marking either as secret causes config to be missing and
the app to fail with "supabase URL not configured" in the browser console.

The anon key is safe in build/client contexts by design. RLS is the
actual access control; the anon key only grants JWT-level claims that
RLS policies enforce against.

## Optional - Scout LLM agent loop

Without `ANTHROPIC_API_KEY`, the Scout tab is hidden entirely. All other
keys in this section gracefully degrade individual tool calls within
Scout - the agent loop works, just with thinner outputs.

| Variable | Purpose | Mark as secret? |
|---|---|---|
| `ANTHROPIC_API_KEY` | Powers Scout's agent loop. Default model `claude-sonnet-4-5`. ~$0.10-$1 per query. | Yes |
| `ANTHROPIC_MODEL` | Override the default Claude model (literal model id). | No |
| `ANTHROPIC_TITLE_MODEL` | Override the Haiku title-generation model. | No |
| `APOLLO_API_KEY` | Apollo email + phone enrichment. Paid plan required. ~1 credit per matched contact. | Yes |
| `APOLLO_REVEAL_PERSONAL_EMAILS` | `"1"` to fetch personal emails (uses extra credits). | No |
| `APOLLO_REVEAL_PHONE` | `"1"` to enable async phone reveal. Requires webhook wiring below. | No |
| `APOLLO_WEBHOOK_URL` | Public URL Apollo POSTs phone results to. MUST include `?token=<APOLLO_WEBHOOK_TOKEN>`. | Yes |
| `APOLLO_WEBHOOK_TOKEN` | Shared secret. URL token is the only webhook auth (Apollo doesn't sign). | Yes |
| `APOLLO_WEBHOOK_DEBUG` | `"1"` to echo parsed Apollo payload in webhook 200. Dev only. | No |
| `SAM_GOV_API_KEY` | Federal contract confirmation. Hard daily rate limit. Free. | Yes |
| `DVIDS_API_KEY` | Military news + imagery context. Generous quota. Free. | Yes |

## Optional - Hill data nightly sync

Separate from Scout. Refreshes the Hill members + committees data
from public Congress.gov endpoints. The seed already populates these
tables; this var only matters if you want nightly drift updates.

| Variable | Purpose | Mark as secret? |
|---|---|---|
| `CONGRESS_GOV_API_KEY` | Hill members + committees nightly sync. Free. | Yes |
| `CONGRESS_NUMBER` | Congress number; defaults to `'119'`. | No |

## Optional - Site password protection

If you wrap the Netlify site in visitor-access password protection
(Site settings > Visitor access), the Scout function needs to know
the password so it can re-enter the site for its background polling.

| Variable | Purpose | Mark as secret? |
|---|---|---|
| `NETLIFY_SITE_PASSWORD` *or* `SITE_PASSWORD` | Same value as the Netlify visitor password. | Yes |

If you don't password-protect the site, leave these unset.

## Auto-injected by Netlify (don't set manually)

These are populated by Netlify at build/deploy time:

| Variable | Purpose |
|---|---|
| `COMMIT_REF` | Git SHA of the current deploy. Read by `functions/config.js` for the footer build SHA. |
| `DEPLOY_PRIME_URL` | The active deploy preview URL. |
| `URL` | The site's primary URL. |

If you're hosting somewhere other than Netlify, set equivalents
manually or strip the references in `functions/config.js`,
`functions/scout.js`, and `functions/scout-background.js`.
