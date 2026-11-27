# CLAUDE.md — MAG Metrics Dashboard

Internal Sales/Marketing/Operations metrics dashboard. **Plain HTML/CSS/JS**
frontend (no build step) + Express API in one deployable service, JWT login.
**Sales and Operations are LIVE**, backed by real data queried at runtime from
MAG's Supabase database; **Marketing is partially live**. Deployed on Google Cloud Run.

> Started as React + Vite → converted to plain editable HTML pages → wired to real
> MAG data (Supabase primary). No more `client/`, Vite, Recharts, or `server/data/` mocks.

## How this doc is organised — READ FIRST
Per-page / per-area detail lives in **`context/<dept>/<page>.txt`**, NOT in this file, to
keep CLAUDE.md small. **Before working on a page, open its context file** (see the map
below): it carries that page's endpoints, SQL sourcing, caches, gotchas and build history.
This file keeps only the always-apply rules + the map. When you change a page, update its
context file (add a row here only if the page is new) instead of growing CLAUDE.md. Keep the
per-page `.txt` the single source of truth for that page.

## Architecture essentials (full detail → `context/shared/architecture.txt`)
- **Single origin.** `server/index.js` serves `/api/*` + the static pages in `public/`.
  `/` redirects to `/home.html`. No SPA fallback — each page is a real file.
- **Frontend = static files in `public/`, no build.** One HTML file per screen; shared CSS
  `public/app.css`, shared JS `public/app.js` (each page's inline `<script>` calls
  `initPage(area, renderFn)` and maps API data onto charts/tables). Charts = Chart.js,
  vendored at `public/vendor/chart.umd.min.js`. **Do not add a bundler** — hand-editability
  is the point.
- **Navigation** — the top tab bar, the Sales/Marketing/Operations/AI sidebars, the Marketing
  horizontal sub-tab bar, and the shared custom-date-range control are each built by ONE
  single-source helper in `app.js` (`renderSalesSidebar` / `renderMarketingSidebar` /
  `renderOperationsSidebar` / `renderAiAutomationSidebar` / `renderMarketingHead` /
  `renderDateRange`). **Never hand-duplicate.** The `<nav class="tabbar">` block IS duplicated
  across all top-level pages, so adding/reordering a top tab = edit them all. Full rules +
  `app.js?v=` cache-bust discipline → `context/shared/navigation.txt`.
- **ESM on the server** (`"type":"module"` in package.json) — use `import`.
- **Data layer** (`server/config.js` + `hasSource()`, `providers/supabase.js` pooled `pg` =
  primary source, `lib/{range,sql,metric,cache}.js`, `metrics/{sales,marketing,operations}.js`,
  generic `/api/metrics/:area` route): the app never hard-fails on a missing credential — tiles
  show "needs setup". Detail → `context/shared/architecture.txt`.
- **Design system** — DESIGN_GUIDE.md (repo root; `public/roas.html` is the reference), the
  segmented FY toggle as THE period control, and the MANDATORY one ⓘ info-tool per widget (§6)
  → `context/shared/design-system.txt`. Read it before restyling or building a page.
- **Data pipeline** — the AC deals/contacts mirror syncs, the attribution caches
  (`ac_indirect_deals`, `ac_google_ads_yes_deals`, …), and the GA4 rebuild tables →
  `context/shared/data-pipeline.txt`.

## Context map — open the page's file BEFORE touching it
### Marketing (`marketing.html` + sub-tabs; backend mostly `/api/marketing/*`)
| Page / tab | Context file |
|---|---|
| Overview (`marketing.html`) | `context/marketing/overview.txt` |
| Leads & Bookings (`leads_bookings.html`) | `context/marketing/leads-bookings.txt` |
| Spend & ROI (`spend_roi.html`) | `context/marketing/spend-roi.txt` |
| Content & Social (`content_social.html`) | `context/marketing/content-social.txt` |
| Email & Partners = "Outreach Campaign" (`email_partners.html`) | `context/marketing/email-partners.txt` |
| Website & Search (`website_search.html`) | `context/marketing/website-search.txt` |
| Monthly Log (`monthly_log.html`) | `context/marketing/monthly-log.txt` |
| Nurture & Events (`nurture_events.html`) | `context/marketing/nurture-events.txt` |
| Social Platforms (`social_platforms.html`) | `context/marketing/social-platforms.txt` |
| ROI (`roi.html`) | `context/marketing/roi.txt` |
| ROAS (`roas.html`) | `context/marketing/roas.txt` |
| Ad Platforms (`ad_platforms.html`) | `context/marketing/ad-platforms.txt` |
| GA4 & Ads Leads Tracking (`ac_contact_sources.html`) + GA4 rebuild tables + Calendly | `context/marketing/ga4-leads-tracker.txt` |
| Time Doctor Sync (`td_sync.html`, More dropdown) | `context/marketing/td-sync.txt` |
### Sales (`sales_overview.html`; Conferences = legacy `sales.html`)
| Page / tab | Context file |
|---|---|
| Sales top-line + Conferences | `context/sales/overview.txt` |
| Education Outreach (`education_outreach.html`) | `context/sales/education-outreach.txt` |
| Education Leads (`education_leads.html`) | `context/sales/education-leads.txt` |
| Alternate Leads (`alternate_leads.html`) | `context/sales/alternate-leads.txt` |
### Operations (`operations.html`)
| Page / tab | Context file |
|---|---|
| Overview + Buyer Analysis + Invoices | `context/operations/overview.txt` |
### AI & Automation (`builds_monitoring.html`)
| Page / tab | Context file |
|---|---|
| Ticketing (`ticketing.html`) | `context/ai-automation/ticketing.txt` |
| Team Check-in (`checkin.html`) | `context/ai-automation/checkin.txt` |
### Cross-cutting (`context/shared/`)
`navigation.txt` · `architecture.txt` · `design-system.txt` · `data-pipeline.txt` ·
`auth-access.txt` (passwordless OTP login + restricted partner role) · `deploy.txt` (every secret).

## Data safety — ALWAYS
- **Never truncate — we only upsert in syncs.** Every data sync (any Supabase/DB table) must
  use upsert / `insert … on conflict (…) do update`. Never `TRUNCATE`, never drop-and-reload,
  never bulk `DELETE` as part of a sync. Deduplicate on the natural key and update in place.

## Data caveats — read before touching any query
- `activecampaign_deals.value` is in **CENTS** — divide by 100. `currency` is
  mixed-case (`aud`/`AUD`/`usd`) — always `lower()` it.
- Deal value is **CRM-contracted**, not billed revenue (Xero would be billed).
- Real demo/proposal signal is `ac_custom_fields.demo_date` /
  `.proposal_sent` — **not** `activecampaign_deals.demo_date_is_added` /
  `.proposal_sent_bool_is_added`, which are backfill flags, true for every row.
- `follow_up_sequence_logs` has no person identifier (only id/created_at/
  lead_type/message_no) — don't try to derive "people reached" from it.
- `leads.is_referred` is only an approximate direct/indirect proxy; "bureau"
  isn't explicitly tagged anywhere in Supabase yet.
- Ignore `ac_deals_160726` / `ac_contacts_170726` — empty one-off backups.

- **"Visits from AI tools" is a classification, not a GA4 feature.** GA4 is stock; the
  AI label is applied in `ga4-website-traffic-sync`, which matches GA4's standard
  `sessionSource` against the active rows of `public.ai_source_patterns` (lowercase
  substring match, NOT regex). That table is append-only (never DELETE; soft-disable with
  `active=false`), filled monthly by `ai-source-patterns-sync` (curated baseline + OpenAI
  discovery, sanitized). The hardcoded `AI_SOURCE_RE` in the sync function is a fallback
  only. It is a referrer-attributable floor, not total AEO influence. Patterns are added
  as new hostname fragments and never as bare words such as `google`, `bing`, or `chat`.

## Build / run
- Local: `npm install` then `npm run dev` (nodemon on :8080) or `npm start`.
  Without `SUPABASE_DB_URL` set, metrics endpoints still return 200 with every
  tile marked `pending` — fine for frontend-only work.
- No `npm run build` and no client install step.


## Deploy (Cloud Run) — full secrets list → `context/shared/deploy.txt`
> **Claude NEVER deploys the dashboard to Cloud Run.** This is ALWAYS done manually by the
> user — do not run `gcloud run deploy`, do not offer to, do not ask whether to. After
> code/DB changes, just state that a manual redeploy is needed.
```
gcloud run deploy dashboard --source . --region australia-southeast1 \
  --set-secrets SUPABASE_DB_URL=SUPABASE_DB_URL:latest
```
Project `claudegwscli-502400`. Live URL: https://dashboard-659687081407.australia-southeast1.run.app
`--allow-unauthenticated` is intentional (the JWT login is the real gate). `JWT_SECRET` is
already on the service — omit it on redeploys or it's dropped. Add any NEW secret **additively**
with `--update-secrets NAME=NAME:latest` (never bare `--set-secrets`, which drops the others).
gcloud is NOT on PATH — full path:
`C:\Users\Cloverly\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`.
Service secrets in use: `SUPABASE_DB_URL`, `GMAIL_USER`/`GMAIL_APP_PASSWORD`, `OPENAI_API_KEY`,
`META_PAGE_TOKEN` (+ `GEMINI_API_KEY` for Education Outreach). What each unlocks + how to set it
→ `context/shared/deploy.txt` (GEMINI detail → `context/sales/education-outreach.txt`).

## Gotchas
- **Testing a new DB credential:** never inline a password in a Bash command
  or print a connection string — read it from an env var in a throwaway script,
  print only success/failure and non-secret diagnostics, then delete the
  script. `pg` needs `ssl:{rejectUnauthorized:false}` for Supabase's pooler.
- **Windows/shells:** the `!` in-session prompt runs **Bash**, not PowerShell —
  don't use PowerShell `&`/`$` call syntax there.
- **Leftover dev processes lock files.** A stray `vite`/`esbuild`/`node` from an
  old `npm run dev` can lock folders on Windows; kill the process tree if a
  delete/rename fails with "resource busy".
- Dockerfile uses `npm install` (not `npm ci`); no lockfile-strict install.
- **Supabase Edge Functions must be deployed `--no-verify-jwt`.** The pg_cron +
  pg_net job(s) and the `contact-sources-sync` orchestrator that drive them (the
  GA4/Ads leads chain: `ga4-ads-leads-sync`, `ga4-ac-custom-fields-sync`,
  `ac-google-ads-deals-sync`, which fill `ga4_ac_contact_source` /
  `ac_google_ads_deals`) POST with **no Authorization header** (the orchestrator
  calls its children the same way). If a function is deployed with `verify_jwt=true` (the default, and
  what `supabase functions deploy` / the Supabase MCP `deploy_edge_function` do
  unless told otherwise), the edge gateway returns `401
  UNAUTHORIZED_NO_AUTH_HEADER` *before the function body runs* — the sync silently
  never executes, yet `cron.job_run_details` still shows **"succeeded"** (pg_net
  only queued the POST). Diagnose by reading `net._http_response` (status_code /
  content), not the cron status. Project ref: `aivitcomiywiysrfwqxt`
  (MAGTestProject). Manually backfill with `curl -X POST
  ".../functions/v1/<fn>?sync=1"` once verify_jwt is off.

## Signing in
No demo passwords anymore — any `@myadventuregroup.com.au` email can sign in by
requesting a code (emailed to that address) and entering it. `admin` role is
limited to the allowlist in `server/users.js` (`ADMIN_EMAILS`); everyone else is
`viewer`. Locally, when `GMAIL_*` isn't set, the code is printed to the server
console (`[mailer] … login code for …`), so you can sign in without real SMTP —
but you still need `SUPABASE_DB_URL` set, since codes are stored in Supabase.
