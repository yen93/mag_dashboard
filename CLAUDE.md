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
  in `public/`. `/` redirects to `/home.html` (the dashboard homepage). No SPA
  fallback — each page is a real file.
- **Frontend = static files in `public/`, no build.** One HTML file per screen
  Tab bar (in order, **4 top tabs as of 2026-10-22**): `home.html` ("Home"),
  `sales_overview.html` ("Sales"), `marketing.html`, `operations.html`; plus `login.html`.
  **`home.html` is the overall dashboard homepage** — the default landing (`/` redirects to
  it) with cross-area headline KPIs (pulled live from the Sales/Marketing/Operations
  endpoints) + navigation cards into each area; "Home" is the active top tab only there.
  **Naming gotcha:** the "Sales" tab is `sales_overview.html`;
  `sales.html` is the **Conferences** page (legacy name) — **no longer a top tab**, it now
  lives UNDER Sales via the Sales left sidebar (see below). The `<nav class="tabbar">`
  block is duplicated in **all 16 pages** (the 14 originals + `home.html` + `roi.html`),
  so reordering/adding a top tab = edit them all.
  **Sales left sidebar (as of 2026-10-22):** `sales.html` ("Conferences") is reached via a
  left sidebar (`<aside class="subnav" id="salesNav">`) shown on **2 pages** —
  `sales_overview.html` (Overview) and `sales.html` (Conferences). Built by ONE helper
  `renderSalesSidebar(active)` in `app.js` (same shape/single-source-of-truth as the
  Marketing & Operations helpers — **don't hand-duplicate**); each page wraps its `<main>` in
  `<div class="sales-layout">` + the aside, keeps **Sales** as the active top tab, and calls
  `renderSalesSidebar('<key>')` right after `initPage`. Reuses the same `.subnav`/`.subnav-link`
  CSS; `.sales-layout` is added alongside `.marketing-layout`/`.operations-layout` on the three
  shared layout rules in `app.css`. `sales.html` keeps its `<title>`/heading "Conferences".
  **Marketing left sidebar (as of 2026-10-22; +`roi.html` 2026-10-28):** five former top
  tabs plus the new **ROI** page live UNDER Marketing, reached via a left sidebar
  (`<aside class="subnav" id="marketingNav">`) shown on **7 pages** — `marketing.html`
  (Overview), **`roi.html` (ROI, new 2026-10-28)**, `roas.html`, `ac_contact_sources.html`,
  `new_paid_leads_tracking.html`, `ga4_agent.html`, `historical_paid_leads.html`. The sidebar
  link list is built by ONE helper `renderMarketingSidebar(active)` in `app.js` (single source
  of truth — **don't hand-duplicate it**); each of the 7 pages wraps its `<main>` in
  `<div class="marketing-layout">` + the aside, keeps **Marketing** as the active top tab, and
  calls `renderMarketingSidebar('<key>')` right after `initPage`. CSS `.marketing-layout`/
  `.subnav`/`.subnav-link` lives in `app.css` (sticky on desktop, horizontal scroll under 860px).
  So those are **no longer (or never were) top tabs** — to re-point one, edit the helper, not the tabbar.
  **ROI page (`roi.html` = Marketing sidebar "ROI", `/api/marketing/roi`,
  `server/metrics/marketing-roi.js`)** is a self-rendering page (same pattern as `roas.html`:
  `initPage('marketing')` with no renderFn + `renderMarketingSidebar('roi')` + its own
  `fetchJSON`). LIVE, computed at request time from Supabase, framed by Australian FY (Jul–Jun,
  END-year) with an FY filter bar (default = current FY). Unlike ROAS it is **WHOLE-BUSINESS,
  NOT ad-attributed**. **BOTH revenue AND spend now come from the Xero P&L (as of 2026-10-29),
  read from `public.xero_expenses_monthly`:** revenue = `total_income` (Xero P&L "Total Income",
  **ex-GST, accrual** — new column added 2026-10-29; **REPLACED the old `invoice_tracking`
  incl-GST source**, which was 2026+ only); **total spend = operating_expenses + cost_of_sales**
  (`total_spend` is a GENERATED column = op_ex + cos — don't INSERT it). The table is a STATIC
  Xero-P&L load via MCP (refresh routine pending), covering **FY24–FY27 monthly** (Jul 2023–
  current; re-seeded 2026-10-29) **PLUS FY22 & FY23 as MANUAL annual seeds (2026-10-30)**. deals =
  ALL `activecampaign_deals` (status 1/2/0 by `cdate`, won value via `public.ac_value_aud`), also
  split **per pipeline** (`"group"` → name map in `marketing-roi.js`). **FY axis = FYs with Xero
  P&L (revenue/spend) UNION FYs with AC deals.**
  **Xero's P&L *API* only exposes the current + 3 prior FYs** (FY24–FY27), so **FY22 & FY23 were
  hand-exported from the Xero *web* Reports P&L** (which keeps full history) and seeded via
  migrations `20261030140000_seed_fy23_xero_pnl.sql` / `20261030150000_seed_fy22_xero_pnl.sql`.
  Entity on those exports is **"Ditch Investments Pty Ltd"** = MAG's legal trading entity (the FY24
  export reconciled to the cent against the API-sourced FY24 rows, validating the Trading-Income /
  Cost-of-Sales / Operating-Expenses grouping; **`total_income` = Total *Trading* Income only —
  Other Income like interest/COVID grants is EXCLUDED**, matching FY24+). The exports are
  **annual-only**, so FY22/FY23 are **ONE row each** at `month = 2022-06-01` / `2023-06-01` (BY_FY
  groups them into the right FY; both sit below the by-month floor `2023-07-01`, so the **by-month
  chart is empty for FY22/FY23** — tiles, ROI-by-FY table, and the category chart all work). Each
  seed also writes the FY's **top-12 accounts** into `public.xero_pnl_accounts_fy` for the "Where
  the spend goes" chart. To add/refresh FY22/FY23, re-export from Xero and re-run the seed (the
  API can't reach them). The current FY is partial (YTD) so its spend is below a full year.
  **NB FY22 has 162 "won" AC deals (COVID-era, many small/virtual), so its CAC/avg-rev-per-client
  read low — a deal-count denominator artifact, not a data error; the Xero revenue/spend are solid.** **"Exclude owner wages" toggle
  (`#exclOwnerToggle`, DEFAULT ON, 2026-10-29):** subtracts director wages+super (Xero accounts
  *Wages/Super – James & Mia*, stored monthly in the new `xero_expenses_monthly.owner_wages`
  column — a subset of `operating_expenses`, don't double-count) from Total spend and recomputes
  ROI **client-side** (`effSpend()`/`effRoi()`/`effMonthSpend()` in `roi.html`); backend returns
  `ownerWages` per FY + per month. WITH owner comp in, the business runs ~breakeven (ROI ~0.96–0.99
  = Xero's own net profit); excluding it, ROI ≈ 1.2–1.45 (operating profit before director pay).
  **7 cards as of 2026-10-30** (Total revenue / **Marketing spend** / Return on spend `x.xx×` /
  **Net ROI** `±%` / Clients won / **Cost per client (CAC)** / Avg revenue per client) — all
  computed **client-side** in `render()` from the existing `/api/marketing/roi` payload (no backend
  change), null-guarded: `cac = effSpend÷dealsWon`, `avgRev = revenue÷dealsWon`,
  `netRoi = (roi−1)×100`; the money cards honour the exclude-owner-wages toggle via `effSpend()`.
  (NB the cards' "Marketing spend"/CAC/ROI are really **whole-business** figures, not ad spend —
  the sub-text says so.) Plus 2 charts (**revenue-vs-spend by month** =
  a **DUAL-AXIS combo chart** as of
  2026-10-29: green **spend bars** on the left $ axis, blue **revenue line** on the right $ axis —
  self-rendered by `renderMonthChart()` in `roi.html`, **no longer** the shared-axis `lineChart`;
  **AC pipeline Won/Open/Lost per pipeline** as horizontal stacked bars, with a **"Won only"
  toggle** `#pipeWonToggle` that drops Open/Lost and re-sorts by won), a "Where the spend goes"
  category chart, a **LIVE "Channel Summary" chart (as of 2026-10-30)** — a monthly **STACKED bar
  chart** (months on the x axis) with a **By type / By platform** toggle (`#channelDimBar`),
  self-rendered by `renderChannelChart()` in `roi.html`. `loadChannelSummary()` fetches
  **`/api/marketing/channel-summary`** (`server/metrics/marketing-channel-summary.js`), which is
  backed by the **live-from-Xero channel pipeline**: the **`xero-channel-summary-sync` edge fn**
  (reuses the `xero-ad-spend-sync` Xero OAuth) pulls **SPEND bank transactions** on the marketing
  accounts (**302 Advertising, 475 Website = OPEN; 332 Software, 411 Printing, 377 WrkPod Staff =
  SHARED**), buckets ex-GST by (month, contact, account) into **`public.marketing_channel_monthly`**,
  and the API joins **`public.marketing_channel_vendor_map`** (contact_id → type/platform, 34 seeded
  vendors) for the Type/Platform. **Key rule:** a line is kept if its contact is MAPPED **or** it's
  on an OPEN account (302/475, where unmapped vendors roll up as **"Uncategorized"**); unmapped
  vendors on SHARED accounts (which also hold non-marketing spend — Netflix, staff wages) are
  **dropped**. So to categorise a new/Uncategorized vendor, **insert a row into
  `marketing_channel_vendor_map`** — no Xero re-pull (Type/Platform are joined at query time, not
  stored). Refreshed **monthly** by cron `xero-channel-summary-sync-monthly` (`0 22 2 * *`). AP bills
  are fetched best-effort but 401 (the Xero app scope lacks invoices) — non-fatal, since the spend is
  all in bank txns. The chart is loaded once (independent of the FY bar). — and an ROI-by-FY table, all
  re-rendered client-side on FY change. The page is **full-width** (`.content { max-width: none }`,
  like `sales_overview`) and its FY toolbar is **sticky** (`position:sticky; top:var(--topbar-h,58px)`)
  so it freezes under the top bar on scroll. Note: raw monthly P&L carries year-end accrual reversals,
  so a few months (e.g. Jun 2024) show a **negative spend bar** — kept as-is (annual FY totals net
  correctly). The 6 other Marketing pages' `app.js` was bumped to `?v=7` so the ROI link shows.
  **Operations left sidebar (as of 2026-10-22):** `mag_buyer_sheet.html` (nav "Buyer Analysis" —
  in-page `<h3>`/`<title>` still read "Buyer Sheet") and `invoice_tracking.html` ("Invoices")
  are **no longer top tabs** either — they moved UNDER **Operations**, reached via an
  identical left sidebar (`<aside class="subnav" id="operationsNav">`) shown on **3 pages** —
  `operations.html` (Overview), `mag_buyer_sheet.html` (buyer), `invoice_tracking.html`
  (invoices). Built by ONE helper `renderOperationsSidebar(active)` in `app.js` (same shape as
  the Marketing one — **don't hand-duplicate**); each of the 3 pages wraps its `<main>` in
  `<div class="operations-layout">` + the aside, keeps **Operations** as the active top tab, and
  calls `renderOperationsSidebar('<key>')` right after `initPage`. Reuses the same `.subnav`/
  `.subnav-link` CSS; `.operations-layout` is just added alongside `.marketing-layout` on the
  three shared layout rules in `app.css`.
  Shared styling in `public/app.css` (CSS
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
  - **ROAS** (`roas.html` = Marketing sidebar item "ROAS", `/api/operations/roas`,
    `server/metrics/roas.js`) is a self-rendering page: Google Ads ROAS by **Australian
    FINANCIAL YEAR** (Jul–Jun, **END-year** convention: FY25 = Jul 2024–Jun 2025).
    **Rebuilt 2026-10-22 to mirror the standalone "MAG paid search ROAS" artifact**
    (FY filter bar + All-in/Google-only cost-basis toggle, artifact KPI tiles, a
    "ROAS by FY" bar+target chart, a "What we spent vs what we won" stacked-cost-vs-won
    chart, a wide "ROAS by FY" table, and a per-FY **deals table**). LIVE, computed at
    request time from Supabase — NOT a cache, NOT the Google Sheet.
    **GOOGLE ADS COST — ALL FYs now come from XERO (as of 2026-10-29).** `roas.js`'s
    Google spend for EVERY financial year = `sum(cost)` over the new table
    **`public.google_ads_xero_monthly`** (ex-GST, one row per month), via a single `gads_xero`
    CTE. This **replaced the old split** — Niki's per-lead `cpc` (FY22–24) and
    `public.google_ads_campaign_monthly` / the Google Ads API (FY25+) are **no longer the ROAS
    Google-cost source** (the `niki_spend` and `gads` CTEs are gone; the `fy_axis` is now just
    `gads_xero WHERE google_spend>0`). `google_ads_xero_monthly` is filled by the
    **`xero-ad-spend-sync`** edge fn (Google section — see that paragraph below): billed
    card/direct-debit SPEND bank txns coded to **account 302 "Advertising"**, EX-GST, summed
    across **two Xero contacts** — `"Google"` (`20732f2e…`, throughout) + `"Google Ads"`
    (`81b826a5…`, a May-2023→Feb-2024 window where billing was renamed); 302-only because the
    `"Google"` contact also has non-ad Google charges on other accounts. Per-FY (ex-GST, as
    seeded): FY22 $1,091 (2 mo, partial) · FY23 $22,132 · FY24 $33,098 · FY25 $27,610 ·
    FY26 $37,197 · FY27 $9,249 (4 mo, current). `google_ads_campaign_monthly` + its
    `google-ads-campaign-monthly-sync` cron still run but are now **unused by ROAS**.
    **DEAL COUNTS are UNCHANGED by this** — still the `roas_counted_deals` view (niki FY22–24;
    clover/ga4 FY25+). Only the Google **cost denominator** moved to Xero.
    **FY SOURCING (deal counts; cost is Xero per above):**
    • **FY22–FY24 deal side** → `public.niki_ad_leads_tracking` (Niki's Google Ads lead log):
      Won/Lost/Open counts + won revenue (`deal_value`) from rows with those statuses (via the
      `roas_counted_deals` view). FY22 is partial (data starts May 2022). `company LIKE
      'uniting%'` excluded (referrals). **(Niki's `cpc` is NO LONGER summed as spend — Xero
      replaced it.)**
      **Simple Digital is ALSO counted into the FY22–24 All-in cost** (as of 2026-10-26) —
      `sd_fee` from `public.simple_digital_fees_monthly`, same LEFT JOIN as FY25+ (SD history
      runs back to Mar 2022 in Xero: FY22 $3,680 / FY23 $11,040 / FY24 $11,540). **Bing is $0
      for FY22–24** — MAG didn't run Microsoft/Bing Ads until mid-FY25 (earliest Xero charge
      Jun 2025), so there's nothing to count. So FY22–24 All-in = **Xero Google + Xero Simple
      Digital** (Bing $0).
    • **FY25+** → **Bing = `sum(cost)`
      `public.bing_ads_campaign_monthly`** and **Simple Digital = `sum(paid_search_fee)`
      `public.simple_digital_fees_monthly`** — both **LIVE from Xero** via the
      `xero-ad-spend-sync` edge fn (see the "Bing + Simple Digital" paragraph below).
      (Google cost for FY25+ is ALSO Xero now — see GOOGLE ADS COST above.)
      Simple Digital's `seo_component` (the $600/mo SEO carve-out, **excluded** from the
      ROAS cost) is **NOT** in the cost — but as of 2026-10-28 `roas.js`'s `sd` CTE also
      sums it as `sd_seo` → `sdSeo`, surfaced as a **display-only "SEO (excluded)" column**
      in the ROAS-by-FY table (`roas.html`, right after "Simple Digital", hidden on the
      Ads-only basis). `totalCost`/both ROAS bases are unchanged — it's purely visibility.
    **DEAL COUNTS + won$/open$ (ALL FYs) — as of 2026-10-26 — come from the canonical VIEW
    `public.roas_counted_deals`**, NOT from inline CTEs. `roas.js` just `GROUP BY fy_end` over the
    view; spend stays computed in `roas.js` (niki cpc FY22–24; google/bing/sd monthly FY25+). The
    view is the **SINGLE source of truth** shared with `roas-deals.js` AND the GA4 & Ads Leads page's
    **"ROAS-counted only"** view, so all three reconcile per FY. **View set** = Niki (won/lost/open,
    excl uniting; its OWN sheet value; FY from its own logged month) ∪ FY25+ {`clover_audited_deals`
    `final_gads_tag='yes'` ∪ `ga4_ac_contact_source` `channel~cpc`}. **The jc source
    (`mag_gads_direct_inbound_lead_source` `jc_final_attr='Could be SEO or Paid Ad'`) was REMOVED from
    the view 2026-10-28 (migration `roas_counted_deals_drop_jc_source`) — jc deals are NO LONGER
    counted in ROAS.** It was a view-only change: no underlying table/source was touched, and the JC
    manual-tagging UI on the GA4 page still works, it just no longer feeds the ROAS count. FY25+
    status+value pulled uniformly from
    `activecampaign_deals` (value via **`public.ac_value_aud(value,currency)`** = cents→AUD, USD@1.4227
    — the SINGLE rate source; `server/lib/sql.js acValueAud()` emits a call to it), FY25+ **FY from the
    CONTACT cdate**; **deduped by `deal_id`, precedence `clover > ga4cpc > niki`** ("clover
    prevails"); niki rows with no deal_id kept via surrogate `'niki-'||id`. **Owner decisions:** FY24 =
    Niki+clover mix; include ALL Niki incl **outbound**; a **VIEW** (always live, no refresh job).
    Rebuild the underlying tables, not the view. Known quirk: 2 clover returning-customer wins land in
    **FY22** by contact cdate (deals really FY24+) — accepted. (Dropping jc removed 10 rows, but 2 of
    those deal_ids also live in Niki's log and resurfaced as niki rows, so the view went 171→163 deals;
    net 8 distinct deals removed.) Per-FY won (after the jc removal): FY22 6·FY23 11·FY24 15·FY25
    9·FY26 7·FY27 1.
    **END-YEAR FY is derived explicitly in SQL for every source** (`extract(year)+(month>=7?1:0)`;
    clover's `fiscal_year` text is already END-year via `right(fiscal_year,2)+2000`). As of
    2026-10-23 `public.mag_fy_label` / GA4's generated `fy` are ALSO END-year (migration
    `20261023130000`), so they now MATCH this convention — the old START-year off-by-one is gone.
    **Two cost bases per row** (`roasGoogle` = won$÷Google, `roasAllin` = won$÷(Google+Bing+SD));
    the frontend toggles between them client-side. ROI $/% and the "cost" KPI follow the active
    basis. Win rate = won ÷ (won+lost+open); Per-Lead Value = won$ ÷ (won+lost+open). Only FYs
    **with ad spend** are shown; `<12`-month-spend years (FY22 partial, FY27 current) are flagged.
    In the **"ROAS by FY" table** the two ROAS columns are **per-basis SYMMETRIC** (each basis
    shows only its own): the ads-only column renders `roasGoogle` and is labelled **"ROAS Ads"**
    (renamed from "ROAS Google" 2026-10-28); the **Ads-only** (google) basis hides *Simple Digital*
    + *ROAS all-in*, and the **All-in** basis hides *ROAS Ads* — both via `renderTable()`'s column
    filter, re-rendered on each basis click (`setBasis()` → `renderTable()`).
    **Deals table** = `/api/operations/roas/deals` (`server/metrics/roas-deals.js`): a flat
    per-deal list — group `counted` = the `roas_counted_deals` view; `review` =
    `clover_audited_deals` `final_gads_tag='Uncertain'` not in the view; `actag` = clover
    attributed-Google-Ads not counted. The page filters it client-side by FY + status + search,
    and (as of 2026-10-26) shows ONLY the `counted` group — the `#scopeSeg` counted/review/actag
    toggles were removed from `roas.html` (`SEL.scope` fixed at `'counted'`); review/actag still
    come from the API but aren't UI-selectable. **Counts reconcile with `/roas`** (same view).
    **XERO INVOICE COLUMNS (as of 2026-10-27):** the `roas_counted_deals` view appends 5 Xero
    columns — `xero_engagement_fee`/`xero_gst`/`xero_other_fees`/`xero_total` (numeric) +
    `xero_invoice_json` (jsonb). Each is `COALESCE(xt, bf)`: **xt** = `public.invoice_tracking`
    aggregated by **AC deal title** (sum of the fee fields; `jsonb_agg(invoice_json)`) — the SAME
    aggregation `buyer-sheet-sync` does, so these **reconcile with `mag_buyer_sheet`**, and a live
    `invoice_tracking` match WINS; **bf** = `public.roas_deal_xero_backfill` by `deal_id` (a static
    one-time Xero reconciliation of older won deals that predate invoice_tracking's 2026+ window —
    reload from Xero if it changes). The join is resolved at the view's **final stage** by
    `deal_id → activecampaign_deals.title`, so both FY25+ and niki rows pick it up. Migrations
    `20261027140000` (columns) / `20261027150000` (backfill table) / `20261027150100` (fallback).
    Both `roas-deals.js` and `roas-counted.js` now return these columns. The **Deals table**
    (`roas.html`) and the **"ROAS-counted only" view** (`ac_contact_sources.html`) both DROP the AC
    Value column and show **Engagement Fee / GST / Other Fees / Total**, with a hover **"See Invoice"**
    button on Total opening a **buyer-sheet-style modal** (`inv-backdrop`/`inv-modal`; renders
    `charges.lines` line tables where present, a net/GST/total fallback for the compact backfill JSON).
    The fee split follows `invoice_tracking`: engagement = service accounts **220–228**, other =
    expense **465/311**, gst = invoice tax, total = invoice total, summed across a deal's invoices.
    **ROAS HEADLINE now uses WON REVENUE = Xero engagement fee where invoiced, else the AC/
    contracted value (as of 2026-10-27)** — `roas.js` `won_rev = sum(coalesce(xero_engagement_fee,
    value)) FILTER (status='won')`. Flows into the KPI cards, both charts and the ROAS-by-FY table
    (won rev, ROAS Google/All-in, ROI, per-lead value). The **fallback is deliberate** (only ~32/57
    won deals have a Xero fee; pure-Xero would gut older FYs). **Open pipeline stays on contracted
    value** (open deals aren't invoiced). Deals-table / ROAS-counted DISPLAY columns still show the
    raw Xero fee (blank when uninvoiced), but the headline won-revenue falls back to AC.
    **GA4 & Ads Leads "ROAS-counted only" view** = `/api/operations/contact-sources/roas-counted`
    (`server/metrics/roas-counted.js`, a plain SELECT of the view). The page's toggle **SWITCHES its
    data source** to this endpoint with its own columns (FY/Date/Org/Deal/Status/Value/Source/Method)
    + own KPIs/table-state; the page's **default view + all other filters are UNTOUCHED** (still
    `ga4_ac_contact_source`). The old client `isRoasCounted()` predicate was **retired — do not
    re-add a row-filter**.
    **NOT the full audited ROAS report** (ex-GST Buyer Analysis values → different numbers).
    The old calendar-year design (`won_audit` CTE by `calendar_year`; lost/open from
    `ac_google_ads_deals`; `CONTACT_SOURCE_SHOWN` for the shown-leads basis) is **replaced**,
    as is the even-older sheet-mirror design (cache `public.roas_year_on_year` +
    `roas-year-on-year-sync` routine — both retired/unused, safe to drop). Google ad-spend
    freshness (FY25+) depends on the
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
    **Bing + Simple Digital (the All-in basis):** two tables feed the All-in cost —
    `public.bing_ads_campaign_monthly` (migration `20261022090000`, mirrors the Google table)
    and `public.simple_digital_fees_monthly` (migration `20261022091000`), both read by
    `roas.js` via LEFT JOIN.
    **LIVE FROM XERO (2026-10-23) — the active source for BING, SIMPLE DIGITAL, and (as of
    2026-10-29) GOOGLE ADS:** the
    **`xero-ad-spend-sync` edge function** (`--no-verify-jwt`; `supabase/functions/xero-ad-spend-sync/`)
    reads reconciled **SPEND bank transactions** for the Xero contacts **Microsoft Ads**
    (`5ea7b8c8-…`), **Simple Digital** (`fc88729b-…`), and **Google** (`20732f2e-…`) + **Google
    Ads** (`81b826a5-…`), all coded to **account 302
    "Advertising and marketing"** (these are card/direct-debit charges, NOT AP bills, so
    `get_bills`/Invoices and the claude.ai Xero MCP — unreconciled-only — can't see them; only
    the REST `BankTransactions` endpoint can). It buckets **ex-GST** by month and
    REWRITES `bing_ads_campaign_monthly` (sentinel `campaign_id=0, campaign_name='__xero_msads__'`,
    `cost`=month total) + `simple_digital_fees_monthly` (`invoice='xero'`, `paid_search_fee`=ex-GST
    **less $600 SEO from 2026-03** — the debit went $1320→$1920 then, the +$600 is SEO;
    `seo_component=600`; configurable `XERO_SD_SEO_FROM`/`XERO_SD_SEO_MONTHLY`) **+
    `google_ads_xero_monthly`** (one row/month, `cost`=ex-GST). **Bing/SD use the whole-txn
    `SubTotal` (ex-GST); GOOGLE must NOT** — the `"Google"` contact mixes non-ad charges on other
    accounts, so Google sums only the **account-302 LINE ITEMS**, ex-GST = `LineAmount −
    TaxAmount` (these bank txns are tax-**Inclusive**, so `LineAmount` carries GST); both Google
    contacts are merged (`XERO_GOOGLE_CONTACT_IDS`, `XERO_AD_ACCOUNT=302`). `roas.js` already
    sums all three tables, so **no dashboard redeploy** is needed to pick up refreshed *data*
    (but the roas.js rewire to READ `google_ads_xero_monthly` instead of niki/the Google Ads API
    IS a dashboard redeploy).
    **FETCH WINDOW (as of 2026-10-26): `SINCE` default is `2021-07-01` (FY22 start), not the old
    `2024-07-01`** — so the All-in cost basis now covers FY22–24 too (Simple Digital has Xero
    history back to Mar 2022; Bing only from Jun 2025). Override via the `XERO_SPEND_SINCE` secret.
    **Keep this a full-history floor** — all three writes wipe-then-reinsert the whole window (SD +
    Google delete EVERY row; Bing deletes all `campaign_id=0`), so narrowing `SINCE` on a later
    cron run would DELETE the FY22–24 rows. (Note: picking up FY22–24 on the DASHBOARD also required removing the
    old `fy_end<=2024 THEN 0` gate on `bingSpend`/`sdFee` in `roas.js` — that IS a dashboard
    redeploy; the "no redeploy" line above only covers the data itself.)
    **AUTH = a FREE standard Xero "Web app"** (OAuth2 auth-code + refresh-token rotation, NOT a
    paid Custom Connection). First consent is captured by the **`xero-oauth-callback` edge fn**
    (its public URL is the app's **Redirect URI**; a no-`?code` visit 302s to the Xero consent
    screen built from the stored client id); the refresh token lives in `public.oauth_token_store`
    **`provider='xero'`** and rotates each run (Xero tokens rotate per use + lapse after 60 days
    idle). Secrets **`XERO_CLIENT_ID`/`XERO_CLIENT_SECRET`** are edge secrets (client id
    `B9BD329D…`, non-secret). Tenant resolved live via `GET /connections` (MyAdventure Group
    `2cc630e1-…`). **SCOPE GOTCHA:** Xero deprecated the broad `accounting.transactions` scope
    for apps created from **2 Mar 2026** — bank txns need the granular
    **`accounting.banktransactions.read`** (+ `accounting.contacts.read` + `offline_access`); the
    old scope → authorize-time `invalid_scope`; also encode scope-separator spaces as `%20` (not
    `+`). Weekly cron **`xero-ad-spend-sync-weekly`** `30 22 * * 0` (Mon 06:30 PH, migration
    `20261023120000`) — also keeps the refresh token alive. Modes: `?dry=1` (preview, no write),
    `?sync=1` (write), bare (background).
    ⚠ **This is now the SOLE Bing + Simple Digital source** — do NOT also run the two superseded
    syncs below against these tables (the Bing-API per-campaign rows `campaign_id<>0` would
    double-count the `campaign_id=0` Xero total, since `roas.js` sums all rows). Caveat: Xero
    figures are actual **billed** card/debit charges (threshold/arrears timing), so months differ
    from platform-reported spend — the right basis for All-in cost.
    **HISTORY (superseded 2026-10-23, kept for reference):**
    Bing was to be filled by the **`bing-ads-campaign-monthly-sync` edge function (IMPLEMENTED +
    DEPLOYED 2026-10-23, `verify_jwt:false` v1)** — full Microsoft Advertising Reporting API
    v13 REST flow (OAuth refresh-token grant → `SubmitGenerateReport` CampaignPerformanceReport
    Aggregation=Monthly → poll → download ZIP → unzip via `fflate` → parse CSV → upsert on
    `(month, campaign_id)`), with MSA single-use refresh-token **rotation** persisted in the NEW
    `public.oauth_token_store` table (migration `20261023090000`, `provider='bing_ads'`; seeded
    from the `BING_ADS_REFRESH_TOKEN` secret, rotated token written back each run). Needs the six
    `BING_ADS_*` edge secrets (client id/secret, refresh token, developer token, account/customer
    id) — **SET**. ⚠ **BLOCKED** at time of writing: every call returns **Code 105
    InvalidCredentials** (even `GetUser`, which needs no account access). Root cause: the only
    developer token is the **Gmail Super Admin's SINGLE-USER** token, but OAuth authenticates as
    the user's **Microsoft/Outlook account** (Gmail is Google-federated → can't do Microsoft
    OAuth) — the dev token and OAuth identity **must be the same user**. Fix: promote the MS
    account to Super Admin and self-issue a dev token, OR get a **Universal** dev token. Weekly
    cron is **staged** (`20261023091000`) but **not yet applied** (held until the backfill works).
    **Full resume guide: `BING_SYNC_NEXT_STEPS.txt`.** Simple Digital is filled by the
    **`simple-digital-fees-sync` Claude routine** (Gmail MCP
    → GoCardless "Upcoming Direct Debit … Simple Digital" notices ÷1.1, less $600 SEO from Mar
    2026; monthly). Files: `supabase/functions/bing-ads-campaign-monthly-sync/index.ts`,
    `routines/simple-digital-fees-sync.md`. A dashboard redeploy is needed for the roas.js/
    roas.html rebuild + the new `/api/operations/roas/deals` route.
    **(Former TEMPORARY sheet load, now REPLACED):** both tables briefly held a one-time load
    from the "Ad spend by month" tab of the ROAS sheet (Bing as `campaign_id=0, '__sheet_total__'`;
    Simple Digital mirrored per month). `xero-ad-spend-sync`'s first run **deleted and replaced**
    those rows on 2026-10-23, so the sheet load is gone — the tables now hold only the Xero data
    above.
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
      (text, `"FY27"` = last 2 digits of the AU FY **END** year, FY ending Jun 30 — END-year
      as of migration `20261023130000`, matching the ROAS tab; was START-year until 2026-10-23) are
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
      `clearCache()`). **The read path treats this override as the
      EFFECTIVE tag — it WINS over `cs.jc_manual_tag` — so the SELECT in
      `ac-contact-sources.js` LEFT JOINs
      `ga4cs_jc_manual_review r ON r.contact_id = cs.contact_id`.** `jcManualTag` shown on
      the page is thus the effective value. **NOTE (as of 2026-10-28): the JC tag NO LONGER
      FEEDS ROAS.** It used to, via `CONTACT_SOURCE_SHOWN` (which also LEFT JOINs the override),
      but ROAS stopped reading `CONTACT_SOURCE_SHOWN` in the 2026-10-26 view refactor (`roas.js`
      now only `GROUP BY`s `public.roas_counted_deals`), and on 2026-10-28 the jc source was
      removed from that view entirely (see the ROAS bullet). `CONTACT_SOURCE_SHOWN` is still
      defined in `server/lib/sql.js` but has no ROAS consumer now. Client gate `canTagJc()` mirrors the server; the JC column is **default-open
      for reviewers**; `app.js` gained `postJSON()`; page is `app.js?v=5`. **Gotcha: the JC
      cell's `render` is an interactive `<select>`, so its stripped HTML is identical for
      every row — the column therefore supplies a `text(v,row)` projection (tag value /
      "Not paid ad / SEO" / "—") that `renderSortableTable`'s `textOf` prefers for
      filter/sort/search; without it the per-column filter merges for-review and tagged
      rows. Keep that `text` in sync with the three review states.**
    - **"Manual Tagging" column + "In Niki's List" (as of 2026-10-21):** the JC column and
      its toolbar toggle are **RENAMED "Manual Tagging"** (user-facing strings only;
      internal `SHOW_JC_COL` / `#acsJcToggle` / `jcManualTag` key unchanged). When a row's
      `deal_id` is present in **`public.niki_ad_leads_tracking`** (a NEW static, un-synced
      table holding Niki's 2022-2025 Google Ads leads sheet; see the data stores) **AND the
      row is still "for review"** (`isForReview()` — GAds=Yes, blank channel, no effective JC
      tag, not reviewed), the cell shows a read-only green **"In Niki's List"** pill instead of
      the amber tag `<select>`; the `text` projection returns `"In Niki's List"` for the same
      rows. **JC's tag PREVAILS on every non-for-review row** (a tagged/reviewed row keeps its
      JC value) — the Niki pill only replaces the for-review state. Driven by a
      new `inNikiList` boolean in `ac-contact-sources.js`'s SELECT via an **`EXISTS` subquery**
      on `niki_ad_leads_tracking` by `deal_id` (EXISTS, not a JOIN, so a deal on several sheet
      rows doesn't fan out the page rows). **Display/API-only — the cache table, syncs and
      ROAS predicate are untouched** (`niki_ad_leads_tracking` is a plain one-time load; its
      `deal_id` was back-filled by contact-name match to `activecampaign_contacts` → that
      contact's `activecampaign_deals` row). Its **`inbound_or_outbound`** column (also a
      static one-time fill, 2026-10-21) came from each matched deal's AC **"Inbound/ Outbound?"**
      deal custom field (`dealCustomFieldMetumId` **14**, under Qualification Details) — pulled
      with **per-deal** AC reads (`list-all-custom-fielddata-field-values`, `filters[dealId]=…`),
      because deal custom fields aren't stored in `activecampaign_deals`/`ac_google_ads_deals`
      and the endpoint only filters by `dealId` (a meta-id filter 422s). Both columns are
      static — re-run the matching AC lookup if the sheet/deal links change.
    - **Row-visibility rule — DISPLAY vs ROAS now DELIBERATELY DIVERGE (as of 2026-10-21,
      later same day):** the **page DISPLAY** rule is: a row is first HIDDEN if its `deal_id`
      is in the **manual `EXCLUDED_DEAL_IDS`** set (a curated 47-id hide-list, hidden by
      deal_id ALONE — not scoped to Niki's sheet; KEEP IDENTICAL as a JS `Set` in
      `server/metrics/ac-contact-sources.js` and an object map in the inline
      `public/ac_contact_sources.html` script), OR if its deal is in
      Niki's sheet marked **outbound** (`nikiOutbound` — a request-time `EXISTS` on
      `niki_ad_leads_tracking` where `inbound_or_outbound ILIKE 'outbound%'`). Both are placed
      FIRST in `isExcludedRow()`, so they override even the JC "always show" exemption (as of
      2026-10-21, latest — the deal-id list hides 4 present rows incl. 3822; nikiOutbound hides
      ~10, none JC-tagged). Otherwise a row is SHOWN iff it has a JC manual
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
      intentionally DIVERGES from the `CONTACT_SOURCE_SHOWN` SQL predicate (`server/lib/sql.js`):
      that predicate OMITS the `google_ads_ac_field` branch (channel + effective-JC-tag only).
      (Historical note: `CONTACT_SOURCE_SHOWN` used to drive the ROAS shown-leads basis, but
      `roas.js` stopped using it in the 2026-10-26 view refactor — ROAS now reads only
      `public.roas_counted_deals` — so this divergence no longer has any ROAS effect; it's kept
      so the two display copies stay in sync with the predicate's intent.)** (As of 2026-10-28
      the JC tag NO LONGER feeds ROAS either — the jc source was removed from the view; see the
      JC manual-review tagging + ROAS bullets above.) Knock-on: the re-shown rows DO count toward
      the page KPIs + chip-count note (they're "shown"). Migration (unrelated,
      for the FY/calYr/JC columns): `supabase/migrations/20261020060000_contact_source_fy_calyr_jc_columns.sql`.
    - **Clover ROAS-audit `final_gads_tag` PREVAILS (as of 2026-10-22):** the page joins
      **`public.clover_audited_deals`** (a static one-time load of the "Master Deals (audit)"
      tab of James' ROAS audit sheet — every AC deal Jul 2023→Oct 2026; sheet col N "Google Ads
      Tagged?" → `final_gads_tag` Yes/No/other; RLS on / no policies, read via the direct pg
      connection) by `deal_id` as the row field **`finalGadsTag`** (a scalar subquery in
      `ac-contact-sources.js`'s SELECT — `deal_id` is unique in the audit, so no fan-out; **not**
      a UNION — only EXISTING cache rows are annotated, no new contacts added). A
      **`final_gads_tag='yes'` PREVAILS over everything:** the check is placed at the **TOP of
      `isExcludedRow()`** (BOTH copies — server `ac-contact-sources.js` + inline
      `ac_contact_sources.html`, KEEP IDENTICAL) `→ return false`, so a Yes row is ALWAYS shown,
      overriding even the `EXCLUDED_DEAL_IDS` / `nikiOutbound` / Uniting hard-hides above. A Yes
      row shows a read-only green **"Yes"** pill in the **Manual Tagging** column (overriding the
      JC `jcTagCell` control / Niki pill), its column `text` projection returns `"Yes"`, and
      `isForReview()` returns false for it (the audit already decided — no amber highlight).
      A `'no'`/other value falls through to the normal rules unchanged. **No new table column was
      added** (final_gads_tag surfaces only via the existing Manual Tagging column). **This same
      table is ALSO the FY25+ ROAS counted source**: `final_gads_tag='Yes'` deals feed the
      canonical `public.roas_counted_deals` view (as of 2026-10-26 — the old `won_audit` CTE in
      `roas.js` and the client `isRoasCounted()` branch are both retired; see the ROAS bullet).
      `clover_audited_deals` is STATIC (reload from the sheet if it changes). Migration:
      `create_clover_audited_deals`.
    - **"ROAS-counted only" toggle (REBUILT 2026-10-26 — now a data-source SWITCH, not a row
      filter):** `#acsRoasToggle` → `ROAS_ONLY` (default off; label flips to "Show all rows").
      When ON, the table **switches its data source** to the canonical view
      `public.roas_counted_deals` via **`GET /api/operations/contact-sources/roas-counted`**
      (`server/metrics/roas-counted.js`), rendering its OWN columns
      (FY/Date/Org/Deal/Status/Value/Source/Method) + OWN `ROAS_TABLE_STATE`, but **reusing the
      SAME KPI cards as the default view** (the shared `renderKpis()`, recomputed on every in-table
      filter via `onFilter`). Rows are lazy-fetched once into `ROAS_ROWS` and aliased
      `status→dealStatus` / `value→dealValue` so `renderKpis` reads them; the endpoint also returns
      `channel` (LEFT JOIN `ga4_ac_contact_source` by deal_id) for the channel cards. **Caveat:**
      those 4 channel-breakdown cards read near-zero here (GA4 channel is ~60-day-retained; only
      ~3/171 ROAS-counted deals have one) — Total Revenue/Leads are the meaningful cards. This is
      the SAME set the ROAS tab aggregates, so the ROAS-counted list reconciles with the ROAS tab
      per FY — and it can show deals the page otherwise can't (Niki FY22–24, off-page clover deals).
      **The page's default view + every other filter are UNTOUCHED** (still read
      `ga4_ac_contact_source` via `getAcContactSources()`). The old client `isRoasCounted()`
      predicate (and its `filteredRows()` branch) was **RETIRED — do not re-add a row-filter**.
      Caveat: because the view uses the deal's FY (Niki = own logged month; clover/jc/ga4 =
      contact cdate), a deal can read a different FY here than in the contact-centric default view.
    - **Displayed deal value (`dealValue` / "AC Value" column) now comes from the AC-deals
      join, not the cache (as of 2026-10-26):** `server/metrics/ac-contact-sources.js`'s SELECT
      no longer reads the denormalized `cs.deal_value` for display — it `LEFT JOIN public.
      activecampaign_deals ad ON ad.id::text = cs.deal_id` and returns `${acValueAud('ad')}` as
      `dealValue`. `acValueAud()` (in `server/lib/sql.js`) now emits a call to the Postgres fn
      **`public.ac_value_aud(value, currency)`** = `value/100`, USD→AUD at **1.4227** (as of
      2026-10-26 the rate lives ONLY in that fn — the JS `USD_AUD_RATE` constant was removed; the
      fn is shared with the `roas_counted_deals` view). This applies to the page's **default** AC
      Value column; the **"ROAS-counted only"** view no longer sums these rows (it reads the
      canonical view instead — see its bullet above). The API field name `dealValue` is unchanged,
      so the inline page (`renderKpis`, `isFeeMismatch`, the AC Value column) picks it up with **no
      client-side edit**. **No fallback** — a blank means the daily `activecampaign_deals` sync is
      stale (intentional). Coverage 100% today (126/126 page deals have an AC row; 2 USD, converted).
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
    - **Fee-balance review highlight (as of 2026-10-21):** a SECOND, visually distinct
      row highlight — **red `.acs-fee-review`** (vs the amber `.acs-review` JC-review
      highlight) — flags rows where **AC Value (`dealValue`) and the Xero Engagement Fee
      (`engagementFee`) don't balance**. Client-only (like `isForReview`, NO server twin):
      helper `isFeeMismatch(r)` in `public/ac_contact_sources.html` — **WON deals only**
      (open/lost are never flagged; JC for-review rows still showing "— set tag —" i.e.
      `isForReview(r)` are also skipped until a JC decision is made) that are unbalanced:
      one side present and the other missing (incl. an AC Value with no Engagement Fee yet
      = not invoiced — **intentionally flags un-invoiced won deals**), or both present but
      differ by **≥ $1**. Gated on **`SHOW_XERO_COLS`** so it only shows with "Show Xero
      $" on (when `rowClass` combines both classes). The Engagement Fee column's custom
      `engFeeCell` render appends a **⚠ + title tooltip** (names both values + the Δ) on a
      mismatch, with a `text:` projection so the per-column filter/search stays clean
      (sort stays numeric via the raw value). CSS: `.acs-fee-review` rules sit AFTER
      `.acs-review` in `public/app.css` so red wins if a row matches both. No DB/server
      change (values already in the API payload).
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
- **`OPENAI_API_KEY`** (+ optional **`OPENAI_MODEL`**, default `gpt-4o-mini`) —
  powers the ROAS tab's **read-only chat assistant** (`server/roasAssistant.js`,
  `POST /api/roas-assistant`; widget bottom-right on `roas.html`). The endpoint
  context-stuffs the ROAS data (`getRoas`+`getRoasDeals`) + a primer and makes ONE
  OpenAI Chat Completions call (system prompt = first message) — **no DB, no tools,
  so it's read-only by construction**; the key stays server-side. Without it the route
  returns 503 and the widget shows it gracefully. **GOTCHA:** this is the **Cloud Run
  service's own env var** — the OpenAI key that already exists as a **Supabase edge
  secret** (used by `buyer-sheet-sync`) is NOT visible to the dashboard; it must be set
  on the Cloud Run service too. **Attach ADDITIVELY on redeploy:** `gcloud run services
  update dashboard --region australia-southeast1 --update-secrets
  OPENAI_API_KEY=OPENAI_API_KEY:latest` (`--update-secrets`, NOT `--set-secrets`, so the
  existing `SUPABASE_DB_URL`/`GMAIL_*` secrets aren't dropped). MVP only — deeper/cross-tab
  Q&A would need read-only *tools* (the GET endpoints or a SELECT-only DB role), never a
  write path.
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
