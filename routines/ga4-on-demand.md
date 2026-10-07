# GA4 On-Demand Report — the MAG GA4 Agent tab's cloud worker

Powers the dashboard **GA4 Agent** tab (`public/ga4_agent.html` →
`/api/ga4-agent/*` → `server/ga4Agent.js`). Lets any signed-in dashboard user ask
a natural-language question about Google Analytics 4 / Google Ads and get a live
answer, without any GA4 credentials ever touching the browser or their machine.

## Why a routine (not a skill)
Claude Code **skills run on the invoking user's own machine** and routines are
**account-scoped** (not shareable org-wide). So neither works as a shared
org-wide `/command`. Instead the dashboard backend (which already holds secrets)
**fires one routine server-side** and the routine hands its answer back through a
Supabase table — the same model as `sales-topline-sync` / `invoice-tracking`.

## Flow
1. User types a question in the GA4 Agent tab and clicks **⚡ GA4 On-Demand Report**.
2. `POST /api/ga4-agent/run` inserts a `pending` row into `public.ga4_agent_requests`
   and fires the routine via its one-time **fire** endpoint (token server-side only).
3. The routine (this doc) claims the oldest `pending` row, maps the prompt to
   `scripts/ga4_routine.py` args, runs it (GA4 key from the routine's cloud env),
   and writes the markdown result back, status → `done`.
4. The tab polls `GET /api/ga4-agent/result?id=…` until `done`/`error` and renders it.

## Routine config
- **Routine:** "GA4 On-Demand Report" (`trig_01DFkHgvzKJUDCNcHwM87gyS`), owner: Yen.
- **Repo:** `github.com/yen93/google_ads_leads_tracking` (holds `scripts/ga4_routine.py`).
- **Environment:** the Default cloud environment, which must hold env vars
  `GA4_PROPERTY_ID` (363754280) and `GA4_SA_JSON_B64` (base64 of the read-only
  GA4 service-account key). These never leave the cloud environment.
- **Tools:** `Bash, Read, Grep, Glob, mcp__Supabase__execute_sql, mcp__Supabase__list_tables`.
- **Supabase:** project `aivitcomiywiysrfwqxt` (MAGTestProject), table
  `public.ga4_agent_requests` (see migration `20261002010000_...`).
- **Trigger:** on-demand only (cron is a far-future placeholder). The dashboard
  fires it; it is not meant to run on a schedule.

## Dashboard env (Cloud Run)
- `GA4_ROUTINE_FIRE_URL` — the routine's `/fire` endpoint.
- `GA4_ROUTINE_FIRE_TOKEN` — the routine's fire bearer token (secret).
- `SUPABASE_DB_URL` — already set (the agent reuses it).

## Notes / limits
- Concurrency: each fire claims the oldest `pending` row atomically, so N near-
  simultaneous requests need N fires (the backend fires once per submit — 1:1).
- Latency: ~1–2 min per request (a fresh cloud session spins up each time).
- Rotate the fire token (and re-set `GA4_ROUTINE_FIRE_TOKEN`) if it ever leaks.
