# CLAUDE.md — MAG Metrics Dashboard

Internal Sales/Marketing/Operations metrics dashboard. **Plain HTML/CSS/JS**
frontend (no build step) + Express API in one deployable service, JWT login.
**Sales and Operations are LIVE**, backed by real data queried at runtime from
MAG's Supabase database; **Marketing is partially live**. Deployed on Google
Cloud Run.

> History: started as a React + Vite app → converted to plain editable HTML
> pages → wired to real MAG data (Supabase primary, more sources planned). No
> more `client/`, Vite, Recharts, or `server/data/` mock generators.

## Architecture (the non-obvious bits)
- **Single origin.** `server/index.js` serves both `/api/*` and the static pages
  in `public/`. `/` redirects to `/sales_overview.html` (the first tab). No SPA
  fallback — each page is a real file.
- **Frontend = static files in `public/`, no build.** One HTML file per screen
  Tab bar (in order): `sales_overview.html` ("Sales"), `marketing.html`,
  `operations.html`, `mag_buyer_sheet.html` ("Buyer Sheet"),
  `invoice_tracking.html` ("Invoices"), `sales.html` ("Conferences"); plus
  `login.html`. **Naming gotcha:** the "Sales" tab is `sales_overview.html`;
  `sales.html` is the **Conferences** page (legacy name). The `<nav class="tabbar">`
  block is duplicated in every page, so reordering/adding a tab = edit them all. Shared styling in `public/app.css` (CSS
  variables drive theming). Shared logic in `public/app.js`. Each page has an
  inline `<script>` that calls `initPage(area, renderFn)` and maps API data onto
  charts/tables. **Do not add a bundler** — the point is hand-editability.
- **Charts:** Chart.js, vendored locally at `public/vendor/chart.umd.min.js`.
  `app.js` exposes `lineChart`/`barChart`/`pieChart`/`renderKpis`/`renderTable`
  plus `metaChips()`/`renderPendingBody()` for the source-chip / "needs setup"
  badges every metric can carry. `monthLabel()`/`weekLabel()` format the
  month/week-bucketed x-axes the live data uses (date range is now month-window
  based: `3m`/`6m`/`12m`/`ytd`, default `12m` — not the old daily `7d`/`30d`).
- **ESM on the server** (`"type":"module"` in package.json) — use `import`.
- **Data layer (live, not mock):**
  - `server/config.js` — reads every source credential from env vars and
    exposes `hasSource(name)`.
  - `server/providers/supabase.js` — pooled `pg` connection; **the primary
    data source**.
  - `server/lib/range.js` — month-window date-range → a complete month-bucket
    axis (`fillMonths` left-joins query rows onto it so trends have no gaps).
  - `server/lib/sql.js` — shared SQL fragments, esp. `SOURCE_BUCKET` (buckets
    the free-text taxonomy MAG encodes in `activecampaign_deals.title` after
    `//`, e.g. `"Acme // Keynote"`).
  - `server/lib/metric.js` — `live()`/`pending()`/`section()` wrap every value
    in `{value, unit, delta, meta:{status, source, note}}` (or `{data, meta}`).
  - `server/metrics/{sales,marketing,operations}.js` — compose real Supabase
    queries into the API payload. Each has a `notConfigured()` fallback (all
    metrics `pending`) if `SUPABASE_DB_URL` isn't set — **the app never
    hard-fails on a missing credential**, tiles just show "needs setup".
  - `server/index.js` metrics route is generic (`/api/metrics/:area`) and
    caches each `(area, range)` response briefly via `server/lib/cache.js`.
  - **Cached sub-resources** (plain SELECT of a pre-filled Supabase cache, no
    source calls at request time): `server/metrics/{liv-deals,mag-buyer-sheet,
    invoice-tracking,sales-topline}.js`. `sales-topline.js` (`/api/sales/topline`)
    backs the **Sales** page from `public.sales_topline`, refreshed **weekly**
    (Mon 6am PH) by the `sales-topline-sync` Claude routine — see
    `routines/sales-topline-sync.md`. Live: total_income, bureau, tailor;
    "needs setup" until their AC fields/tags are mirrored: direct/indirect split,
    speaking_enquiries, inbound/outbound.
  - **Contact Sources** (`ac_contact_sources.html` = "GA4 & Ads Leads Tracking",
    `/api/operations/contact-sources`, `server/metrics/ac-contact-sources.js`) is
    also a plain single-table read: as of 2026-10-09 **every display column is stored
    on `public.ga4_ac_contact_source`** (the old LATERAL joins are gone — don't
    re-add them). `rebuild_ga4_ac_matches()` denormalizes those columns each rebuild
    (section 3: conversion_action/link, deal_title/value/status, source_type, cpc)
    and **appends** the primary contact of each `ac_google_ads_deals` deal whose
    email isn't already present (section 4; GA4/match cols left NULL). The three
    former sync cron jobs are now one orchestrator edge function
    `contact-sources-sync` (daily 06:00 PH; see AUTOMATIONS in `as_built.txt`). NB:
    `ac_google_ads_deals.value` is already AUD (unlike `activecampaign_deals.value`,
    which is cents). **Two deal-linkers, both must denormalize:** besides the
    rebuild (step 1b links `deal_id`, step 3b fills `deal_title`/value/status),
    a second cron `update-deals-daily-7am-pht` → `public.update_ga4_contact_deals()`
    re-links `deal_id` at 07:00 PH (after the deals mirror settles — `sales-deals-sync`
    races the 06:00 rebuild at the same slot). As of 2026-10-13 it ALSO denormalizes
    the display columns; **never add/leave a linker that sets `deal_id` without also
    denormalizing** or org-matched non-primary contacts get `deal_id` but a blank title.
  - **`ga4_ac_event_matches` is ACCUMULATE, not truncate (as of 2026-10-13).** The
    rebuild's section 2 UPSERTs on a stable `event_uid` (md5 of event dimensions +
    occurrence; **`event_count` is deliberately excluded** — it's a revisable measure)
    so rows aging out of the staging window are retained (history >60d, forward-only).
    `inserted_at`=first-seen, `last_rebuilt_at`=last re-derivation. **Don't re-introduce
    a `truncate` there.** (`ga4_ac_contact_source` IS still truncate+rebuilt — it's a
    current-state view, so manual row edits there are wiped each rebuild.)
- **Auth = passwordless email code (OTP).** No passwords, no user table.
  `login.html` is a two-step form (email → code). `POST /api/request-code`
  accepts any `@myadventuregroup.com.au` email, generates a 6-digit code, stores
  its **bcrypt hash** in Supabase table `dashboard_login_codes` (10-min expiry,
  60s resend throttle, 5-attempt cap — see `server/lib/loginCodes.js`), and
  emails it via Gmail SMTP from `julienne@myadventuregroup.com.au`
  (`server/lib/mailer.js`; logs the code to console when email isn't
  configured). `POST /api/verify-code` checks the code, then `server/users.js`
  derives the user from the email (`userFromEmail`/`isAllowedEmail`; `admin`
  role only for an allowlist, everyone else `viewer`) and `server/auth.js` signs
  the same JWT payload (`{sub,email,name,role}`) with `JWT_SECRET`. Frontend
  keeps the token in `localStorage`; a 401 triggers logout → `login.html`.
  `requireAuth`/`/api/me` and all `/api/*` guards are unchanged.

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

## Build / run
- Local: `npm install` then `npm run dev` (nodemon on :8080) or `npm start`.
  Without `SUPABASE_DB_URL` set, metrics endpoints still return 200 with every
  tile marked `pending` — fine for frontend-only work.
- No `npm run build` and no client install step.

## Deploy (Cloud Run)
```
gcloud run deploy dashboard --source . --region australia-southeast1 \
  --set-secrets SUPABASE_DB_URL=SUPABASE_DB_URL:latest
```
(single-stage Dockerfile: `npm install --omit=dev`, copy `server/` + `public/`,
run on Node 20 alpine.) `JWT_SECRET` is already set on the service from a prior
deploy — omit it on redeploys or it'll be dropped (use `gcloud run services
describe dashboard --region australia-southeast1` to check current env/secrets
before changing them).
- Project `claudegwscli-502400`. Live URL:
  https://dashboard-659687081407.australia-southeast1.run.app
- **gcloud is NOT on PATH by default** on this machine (installed via winget).
  Full path: `C:\Users\Cloverly\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`.
- `--allow-unauthenticated` (network layer) is intentional — the JWT login is
  the actual gate.

## Credentials (see as_built.txt "PENDING METRICS" for what each unlocks)
- **`SUPABASE_DB_URL`** — LIVE. Stored only in **Google Secret Manager**
  (secret name `SUPABASE_DB_URL`, project `claudegwscli-502400`), mounted via
  `--set-secrets`. Only Cloud Run's runtime service account has
  `secretAccessor`. **Never put this in the repo or a local file that isn't
  gitignored** — `.gitignore` blocks `*connection_string*`, `*_secret*`,
  `*credentials*`, `service-account*.json`, `scratch_*`.
- **`GMAIL_USER` / `GMAIL_APP_PASSWORD`** — sends the login-code emails from
  `julienne@myadventuregroup.com.au` via Gmail SMTP (`server/lib/mailer.js`).
  `GMAIL_APP_PASSWORD` is a 16-char Google app password (requires 2-Step
  Verification on that account). Store both in Secret Manager + `--set-secrets`,
  same as Supabase. Without them the server still boots and logs codes to the
  console (dev), but no real emails go out.
- Not yet configured: `AC_API_URL`/`AC_API_KEY` (ActiveCampaign), `XERO_*`
  (Xero OAuth), `CALENDLY_TOKEN`, `MONDAY_TOKEN`,
  `GOOGLE_SERVICE_ACCOUNT_JSON`/`BUYER_ANALYSIS_SHEET_ID` (the MAG Buyer
  Analysis sheet). Read from env by `server/config.js`; add each the same way
  as Supabase (Secret Manager + `--set-secrets`) when connected.

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
