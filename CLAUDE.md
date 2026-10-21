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
  `operations.html`, `mag_buyer_sheet.html` (nav tab "Buyer Analysis" as of
  2026-10-13 — the in-page `<h3>`/`<title>` still read "Buyer Sheet"),
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
    invoice-tracking,sales-topline,roas}.js`. `sales-topline.js` (`/api/sales/topline`)
    backs the **Sales** page from `public.sales_topline`, refreshed **weekly**
    (Mon 6am PH) by the `sales-topline-sync` Claude routine — see
    `routines/sales-topline-sync.md`. Live: total_income, bureau, tailor;
    "needs setup" until their AC fields/tags are mirrored: direct/indirect split,
    speaking_enquiries, inbound/outbound.
  - **ROAS** (`roas.html` = nav tab "ROAS", `/api/operations/roas`,
    `server/metrics/roas.js`) is a self-rendering page: Google Ads ROAS by
    **calendar year** — an 11-col table (Won $, Lost #/Open # counts, Won Leads, Win rate,
    Ad Spend, ROI $/%, ROAS, Per-Lead Value — the redundant Won Revenue column, equal to
    Won $, is hidden; the Won Revenue KPI card stays) + 3 inline Chart.js charts
    (grouped bar, ROAS-vs-2.00×-target line, Leads-by-outcome stacked bar). **As of
    2026-10-20 it is LIVE, computed at request time from existing Supabase tables
    — NOT a cache, NOT the Google Sheet:** the WON numerator = `public.ga4_ac_contact_source`,
    counting the rows matched by the shared `CONTACT_SOURCE_SHOWN` predicate (**NOT quite
    "exactly the rows shown on the page" anymore** — see the divergence note below) — won
    revenue = CRM `deal_value`, counted by contact `cal_yr`. As of **2026-10-21** `roas.js`
    imports `CONTACT_SOURCE_SHOWN` from `server/lib/sql.js` (organic/cpc channel OR a JC
    manual tag; free-gift / excluded-link rows dropped) instead of the old
    `google_ads_ac_field='Yes' OR channel='google / cpc'` filter — so `google_ads_ac_field`
    NO LONGER affects the ROAS count (an UNtagged "Google Ads?"=Yes row with no channel is
    excluded **from ROAS** here — but note that as of later the same day such rows ARE now
    SHOWN on the GA4 & Ads Leads page, which is a deliberate DISPLAY-only divergence; see the
    contact-sources "Row-visibility" note). **BUT (as of 2026-10-21, later) a JC manual-review
    tag DOES feed ROAS:** `CONTACT_SOURCE_SHOWN`'s JC branch now uses the **EFFECTIVE** tag
    (a `public.ga4cs_jc_manual_review` override wins over `cs.jc_manual_tag`), so a row JC
    tags "Could be SEO or Paid Ad" enters the WON population (won deal → Won $; lost/open →
    the GA4-shown `leads` denominator) and a "Not paid ad / SEO" (decision NULL) one doesn't.
    The predicate therefore **requires consumers to `LEFT JOIN public.ga4cs_jc_manual_review r
    ON r.contact_id = cs.contact_id`** — `roas.js`'s WON `deals` CTE adds that join. See the
    contact-sources "JC manual-review tagging" note. **ASYMMETRY (as of 2026-10-21): the Lost /
    Open COUNT columns AND the win-rate denominator come from ONLY the deals flagged
    "Google Ads?"=Yes in AC — `public.ac_google_ads_deals` (the full AC
    `dealCustomFieldData` scan; `status_raw=2` lost / `status_raw=0` open, bucketed by
    `public.mag_cal_yr(deal_cdate)`), NOT every CRM deal and NOT the GA4-shown rows**.
    (`activecampaign_deals` has NO Google-Ads field, so it can't be the source; the earlier
    "every lost/open deal in `activecampaign_deals`, all pipelines" design was replaced.)
    So win rate = won(shown) ÷ (won + Google-Ads?=Yes lost + open). Won $/count stay
    GA4-attributed (GA4-shown), so Won and Lost/Open come from different populations by
    design. **The Lost
    and Open table columns now show deal COUNT, not $** (no more `$`; the `lostAmount`/
    `openAmount` are still in the API payload but not displayed). The **"Won Leads" column
    shows won ÷ (won + lost + open count)** — same denominator as the Win rate %; **Per-Lead
    Value alone still uses the GA4-shown leads basis** (`shownLeads` in `roas.js`). Column
    `title=` tooltips + the intro explain the denominators. Denominator (for ROAS) =
    `sum(cost)` from `public.google_ads_campaign_monthly` by calendar year. Only years
    **with ad spend** are shown (Jul 2024+); a `<12`-month-spend year (2024) reads high
    and the row note says so. The "All years" total is derived in `roas.js`.
    **This is a live GA4-attributed cross-check, NOT the audited ROAS report** (CRM
    values + broader attribution → different numbers; 2022–2024 history dropped). The
    old sheet-mirror design (cache table `public.roas_year_on_year` + the
    `roas-year-on-year-sync` routine) is **retired** — the routine is DISABLED and the
    table is unused/unread (safe to drop). Ad-spend freshness now depends on the
    **`google-ads-campaign-monthly-sync` Supabase edge function** (deployed
    `--no-verify-jwt`; pg_cron `google-ads-campaign-monthly-sync-weekly`, `0 22 * * 0`
    = Mon 06:00 PH; migration `20261020090000`). It mints an OAuth token from the
    Google Ads **service account** `insta-drive-uploader@claudegwscli-502400` (added as
    a Read-only user directly in the Ads account `402-451-5888` — **no MCC / no
    login-customer-id**; the claude.ai Google-Ads MCP connector can't be used because it
    uses per-user OAuth without access), calls the Google Ads REST `searchStream`
    (no developer token — sunset Sept 2026) and upserts on `(month, campaign_id)`.
    **Secret `GOOGLE_ADS_SA_KEY`** (full SA JSON) is a Supabase edge secret. Bump
    `GOOGLE_ADS_API_VERSION` (default `v26`) when Google sunsets a version. Files:
    `supabase/functions/google-ads-campaign-monthly-sync/index.ts`.
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
    re-links `deal_id` at 07:00 PH (after the deals mirror settles — refreshed by
    `activecampaign-deals-sync` at 05:00 PH, see next bullet). As of 2026-10-13 it ALSO
    denormalizes the display columns; **never add/leave a linker that sets `deal_id`
    without also denormalizing** or org-matched non-primary contacts get `deal_id` but a
    blank title.
  - **`public.activecampaign_deals` (the base AC deal mirror) is the denormalization
    source** for both deal-linkers above — **if it's empty/stale, every matched row's
    `deal_title`/value/status goes blank even though `deal_id` is still set** (the recurring
    "deal column blank" bug). As of 2026-10-20 it's fully refreshed daily by the
    **`activecampaign-deals-sync` edge function** (pg_cron jobid 19, `0 21 * * 0-4` =
    05:00 AM PH, an hour before the 06:00 rebuild), replacing a flaky n8n webhook that
    deleted-then-reloaded and left the table empty on failure. It fetches the full AC
    snapshot FIRST, then `reload_activecampaign_deals(_deals jsonb)` does null-refs →
    delete → insert in ONE transaction (never wipes on failure; emails `julienne@` via
    Gmail SMTP on any error — needs `GMAIL_USER`/`GMAIL_APP_PASSWORD` edge secrets, the
    16-char app password with NO spaces). Deploy `--no-verify-jwt`; the cron calls it
    with **`?sync=1`** because async/background mode doesn't finish the ~40s job. The old
    n8n trigger lives in a SEPARATE Supabase project (`n8n-production`, ref
    `uwsncuowtzydylfabikj`, cron jobid 7) and is now **disabled**. Files:
    `supabase/functions/activecampaign-deals-sync/`, `supabase/migrations/20261020*`.
  - **`public.activecampaign_contacts` is synced the same way (as of 2026-10-20):**
    the **`activecampaign-contacts-sync` edge function** (pg_cron jobid 20,
    `30 21 * * 0-4` = 05:30 AM PH — after deals, before the 06:00 rebuild/consumer
    batch that reads contacts) fetches the full AC `/api/3/contacts` snapshot (paginated,
    concurrency 4; ~15.5k rows, ~95s) then calls `reload_activecampaign_contacts(_contacts
    jsonb)` (delete-all → insert in ONE transaction; refuses empty; emails `julienne@` on
    failure). Replaces n8n-production cron **jobid 8** (`n8n-get-all-ac-contacts`, now
    `active=false`; sibling **jobid 9** `n8n-get-all-ac-accounts` is still on n8n — not yet
    converted). **Full rebuild, NOT an upsert** (no `ON CONFLICT`), same as the deals sync.
    **Two contacts-specific gotchas (it's ~4× the deals row count):** (1) the AC `links`
    object is deliberately **NOT fetched** — it was ~1.6 kB/row (~85% of the table) and
    nothing reads it; the rpc stores `links='{}'` (keeps the tiny `scoreValues`/
    `accountContacts`). Sending it made the rpc payload ~38 MB and blew the ~150s edge wall
    clock. (2) the rpc carries **`SET statement_timeout TO '120000'`** because the PostgREST
    role `authenticator` caps at 8s — too short for a 15k-row insert. Function
    `WALL_CLOCK_MS=140000` trips its own guard before the ~150s gateway kill (clean 500 +
    email, not a silent 504). Deploy `--no-verify-jwt`; cron calls it with **`?sync=1`** +
    150s pg_net timeout. Secrets reused from the deals sync. Files:
    `supabase/functions/activecampaign-contacts-sync/`, `supabase/migrations/20261020040000*`
    (rpc) + `20261020050000*` (schedule).
  - **Both rebuild tables now ACCUMULATE, not truncate (as of 2026-10-13) — don't
    re-introduce a `truncate` in `rebuild_ga4_ac_matches()`.**
    - `ga4_ac_event_matches`: section 2 UPSERTs on a stable `event_uid` (md5 of event
      dimensions + occurrence; **`event_count` is deliberately excluded** — it's a
      revisable measure). `inserted_at`=first-seen, `last_rebuilt_at`=last re-derivation.
    - `ga4_ac_contact_source`: section 1 (matched) and section 4 (gads) UPSERT on
      `contact_id`, so contacts older than the 60-day window are retained on the page.
      **Ownership split (do not break):** MATCHED rows (`match_method` NOT NULL) are
      owned by sections 1/1b/3 — `deal_value = activecampaign_deals.value/100` (cents);
      GOOGLE-ADS rows (`match_method` NULL, `deal_value` already **AUD**) are owned
      solely by section 4's upsert. Sections 1b/3 are **scoped to `match_method IS NOT
      NULL`** precisely so they never `/100`-corrupt the AUD gads rows, and section 4's
      `DO UPDATE` is guarded with `WHERE match_method IS NULL` so it never clobbers a
      matched row. (Both tables are append-only now, so a manual row edit survives
      unless the next rebuild upserts that same key — a matched row is overwritten each
      run; an out-of-window row is left alone.)
    - **Manual `roas-<deal_id>` rows (as of 2026-10-20):** `ga4_ac_contact_source.contact_id`
      is **no longer always a real AC contact id**. 12 "Could be SEO or Paid Ad" ROAS-audit
      deals (from `mag_gads_direct_inbound_lead_source`) were hand-seeded with a **synthetic
      `contact_id = 'roas-'||deal_id`** and `match_method NULL`, pre-filled deal columns
      (`deal_value` already AUD). The synthetic key is deliberate: it matches no
      `activecampaign_contacts` row, so `update_ga4_contact_deals()` §1 and `rebuild` §1b
      can't repoint their `deal_id`; `match_method NULL` dodges §1b/§3/§2; no gads PK
      collision. They're **static** (won't auto-refresh from AC) and immune to the daily
      jobs — don't "clean up" non-numeric contact_ids or add a linker that assumes
      contact_id ∈ `activecampaign_contacts`.
    - **`fy` / `cal_yr` / `jc_manual_tag` columns (as of 2026-10-20):** `ga4_ac_contact_source`
      carries three extra columns the GA4 Leads Tracker shows. `cal_yr` (int) and `fy`
      (text, `"FY26"` = last 2 digits of the AU FY start year, FY starting Jul 1) are
      **GENERATED STORED** from `cdate` via IMMUTABLE helpers `public.mag_cal_yr()` /
      `public.mag_fy_label()` (UTC, matching the page's existing cdate date handling) — so
      they need **no sync maintenance** and are correct even for the static roas rows.
      `jc_manual_tag` mirrors `mag_gads_direct_inbound_lead_source.jc_final_attr` (only value
      so far: `"Could be SEO or Paid Ad"`) joined by `deal_id`, kept current by a
      **BEFORE INSERT/UPDATE OF deal_id trigger** (`trg_ga4cs_jc_manual_tag` →
      `ga4cs_set_jc_manual_tag()`) — so it follows `deal_id` regardless of which linker sets
      it, and **neither `rebuild_ga4_ac_matches()` nor `update_ga4_contact_deals()` was
      edited**. Any new deal-linker inherits the tag for free; the static roas rows keep the
      one-time backfill value. **JC-tagged rows are ALWAYS shown** — `isExcludedRow()`
      short-circuits `return false` when `jcManualTag` is set, so the ROAS-audit rows
      (null channel, no match) stay visible. The page's "Show JC's Manual Tag" toolbar
      toggle controls only the **column**, not row visibility.
    - **JC manual-review tagging (NEW as of 2026-10-21):** James (`james@`) + admins
      (`canReviewJc` in `server/users.js` = `ADMIN_EMAILS` + `JC_REVIEW_EMAILS[james@]`;
      **James is a `viewer` so gate by EMAIL, not role**) can set the JC tag from the page.
      The "for review" rows (`google_ads_ac_field='Yes'` + blank `channel` + no effective
      tag + not yet reviewed, ~87) get an **amber `.acs-review` row highlight** (new
      OPTIONAL `opts.rowClass` on `renderSortableTable`) and an in-cell `<select>`
      (`jcTagCell`) to pick **"Could be SEO or Paid Ad"** or **"Not paid ad / SEO"**
      (= reviewed, tag cleared, shows "—"), or — on an already-reviewed row — **"— set
      tag —" to RESET** it (removes the override → back to "for review"; this is the ONLY
      un-review path, since "Not paid ad / SEO" stays reviewed). The decision does **NOT**
      go into `cs.jc_manual_tag` (the trigger + daily jobs would clobber it) — it is
      upserted into a **separate durable table `public.ga4cs_jc_manual_review`** (PK
      contact_id) + an append-only **`public.ga4cs_jc_manual_review_log`** (migration
      `20261021090000_ga4cs_jc_manual_review.sql`; a later migration
      `20261021100000_jc_review_log_action.sql` adds `action` = `'set'`/`'reset'` so a
      reset is distinguishable from a "not" — both NULL `decision`), via **`POST
      /api/operations/contact-sources/jc-tag`** (gated by `canReviewJc`; body `{decision}`
      to set, `{reset:true}` to delete the override; parameterized upsert/delete + log then
      `clearCache()`). **The read path and ROAS treat this override as the
      EFFECTIVE tag — it WINS over `cs.jc_manual_tag` — so both the SELECT in
      `ac-contact-sources.js` AND `CONTACT_SOURCE_SHOWN` LEFT JOIN
      `ga4cs_jc_manual_review r ON r.contact_id = cs.contact_id`.** `jcManualTag` shown on
      the page is thus the effective value, and a positive tag FEEDS ROAS (see the ROAS
      bullet). Client gate `canTagJc()` mirrors the server; the JC column is **default-open
      for reviewers**; `app.js` gained `postJSON()`; page is `app.js?v=4`.
    - **Row-visibility rule — DISPLAY vs ROAS now DELIBERATELY DIVERGE (as of 2026-10-21,
      later same day):** the **page DISPLAY** rule is: a row is SHOWN iff it has a JC manual
      tag (always, bypassing the blacklist), OR it is not a `free_gifts_opt_ins` and not an
      excluded conversion link AND (`channel` matches `/cpc|organic/i` **OR**
      `google_ads_ac_field` is `'yes'`). Everything else (null/direct/referral/teams/email/
      booking with no Google-Ads flag) is hidden. The `google_ads_ac_field='Yes'` branch was
      **RE-ADDED** (it had been dropped earlier the same day) to un-hide ~87 "Google Ads?"=Yes
      contacts whose GA4 `channel` is blank (aged out of the ~60-day window) and that have no
      JC tag — the user asked for these back in the table. The display rule lives in **TWO**
      identical copies, "KEEP IDENTICAL" — **edit both together:** the page's inline
      `isExcludedRow()` (`public/ac_contact_sources.html`) and the server `isExcludedRow()`
      (`server/metrics/ac-contact-sources.js`, drives the chip count / API rows). **It
      intentionally DIVERGES from the `CONTACT_SOURCE_SHOWN` SQL predicate (`server/lib/sql.js`),
      which `roas.js` uses: that predicate OMITS the `google_ads_ac_field` branch (channel +
      effective-JC-tag only) so merely SHOWING these rows doesn't affect ROAS — DO NOT
      "re-sync" it by adding a google_ads branch there.** (But a JC manual-review tag DOES
      feed ROAS via the effective-tag branch — see the JC manual-review tagging bullet
      above.) Knock-on: the re-shown rows DO count toward the page KPIs + chip-count note
      (they're "shown"), but an UNtagged one does NOT count toward ROAS. Migration (unrelated,
      for the FY/calYr/JC columns): `supabase/migrations/20261020060000_contact_source_fy_calyr_jc_columns.sql`.
    - **`engagement_fee` / `other_fees` / `gst` / `amount_total` (Xero $) columns (as of
      2026-10-20):** the Xero invoice breakdown of a deal, shown behind the page's **"Show
      Xero $"** toolbar toggle (`#acsXeroToggle` → `SHOW_XERO_COLS`; inserted right after the
      deal Status column, formatted as whole AUD like "AC Value"). They come from
      `mag_gads_direct_inbound_lead_source` by `deal_id` — the **same source + key as
      `jc_manual_tag`** — and are populated by **folding them into the SAME
      `ga4cs_set_jc_manual_tag()` deal_id trigger** (one `mag_gads` lookup per deal_id;
      `deal_id` is unique there so the `jc_manual_tag` pick is unchanged). So, like
      jc_manual_tag, **neither `rebuild_ga4_ac_matches()` nor `update_ga4_contact_deals()` was
      edited** — the figures ride `deal_id` for free, incl. the static roas rows.
      **`deal_value` was deliberately NOT added** — `mag_gads.deal_value` is identical to the
      `deal_value` already shown as the "AC Value" column (verified). ~21 displayed rows carry
      figures (deals that have been invoiced); NULL until invoiced. One inherited caveat (same
      as jc_manual_tag): if `mag_gads` fees change for a deal whose cache-row `deal_id` doesn't
      change, the row refreshes only when a job re-sets `deal_id`. Migration:
      `supabase/migrations/20261020070000_contact_source_xero_fee_columns.sql`.
  - **Calendly rows are decoupled from the GA4 `calendly_form_submit` event (as of
    2026-10-14).** That website GA4/GTM event **stopped firing after 2026-10-08** (an
    upstream site issue, not in this repo), so `ga4_calendly_events_staging` has no rows
    past Oct 8 (it's truncate-reloaded purely from GA4 — re-running the sync won't fill
    it). Calendly rows no longer depend on it: `conversion_link` for
    `match_method='calendly_email'` falls back to the **constant `'/thank-you-2/'`**
    (and `conversion_action` is always `'calendly_form_submit'`) — so don't be surprised
    the link is always `/thank-you-2/`; `channel` = `coalesce(GA4 session src/medium,
    the Calendly booking's own utm)`. `source`/`medium` always come from the Calendly
    API booking (`calendly_bookings_staging`), the authoritative tracker. **Section 2
    (the audit table) was intentionally left reading GA4** — its `conversion_link` feeds
    the `event_uid` md5, so changing it would mint duplicate rows; a NULL link there is
    honest. The migrations are the two latest `supabase/migrations/20261014*` files.
  - **60-day window gotcha:** sections 1/1b/3 only roll up contacts whose
    `activecampaign_contacts.cdate` is within `window_days` (60). A returning/older
    contact who books again after aging out lands in `ga4_ac_event_matches` (section 2
    matches bookings to any contact by email, no window) but **not** on the page. Fixing
    that means keying the Calendly match off booking date, not contact `cdate`.
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
> **Claude NEVER deploys the dashboard to Cloud Run.** This is ALWAYS done manually by
> the user — do not run `gcloud run deploy`, do not offer to, and do not ask whether to.
> After code/DB changes, just state that a manual redeploy is needed; the commands below
> are reference for the user, not an action for Claude.
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
