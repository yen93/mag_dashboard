# email-partners-sync — weekly Email & Partners snapshot

Populates `public.email_partner_metrics`, the append-only cache behind the
Marketing **Email & Partners** page (`/api/marketing/email-partners` →
`server/metrics/email-partner-metrics.js`). Same model as `sales-topline-sync`
and the social-platform sync: a scheduled job writes a Supabase cache; the
dashboard only ever `SELECT`s the latest row per FY.

- **Where it runs:** a Claude Code scheduled routine (cloud agent) with the
  **ActiveCampaign MCP** + **Supabase MCP** — *not* a Supabase edge function
  (the email KPIs come from the AC MCP, which only Claude can call).
- **Schedule:** weekly, **Monday 06:00 Asia/Manila** (`0 6 * * 1`, ≈ `0 22 * * 0`
  UTC) — same cadence as the other weekly syncs.
- **Supabase project:** `aivitcomiywiysrfwqxt` (MAGTestProject). Writes via the
  Supabase MCP `execute_sql` (service role).
- **APPEND-ONLY:** each run **INSERTs** one row per Australian FY (FY22 →
  current) under a shared `run_id`. The table has a trigger that **blocks UPDATE
  and DELETE** — never try to upsert, truncate, or clean up; just insert. History
  accumulates (one batch of FY rows per week).

## What feeds each card
| Card / column | Source | Field(s) |
|---|---|---|
| **Subscribed contacts** (KPI) | AC MCP `list_contacts` `{limit:1, status:1}` → `meta.total` | `active_contacts` |
| **EDM sends** (KPI) | AC MCP `run_campaign_performance_report` `summaryData` | `campaigns_sent` (+ `total_sends` in the sub-line) |
| **Click rate** (KPI) | same report | `click_rate` (open-rate/CTO in the hover) |
| **Unsubscribes** (KPI) | same report | `total_unsubscribes`, `unsubscribe_rate` |
| **Replies** (KPI + partner col) | — | **Not tracked in ActiveCampaign** → leave NULL (page shows a `pending` chip) |
| **Sent on time** (partner col) | — | **Not an AC metric** → page shows a `pending` chip |
| Partner **Contacts** | AC MCP `list_lists` (bureau) + `ac_indirect_deals` (tailor) | `bureau_list_subscribers`, `tailor_contacts` |
| Partner **Enquiries / Bookings / Revenue** | Supabase `public.ac_indirect_deals` (`is_tailor` split) | `*_enquiries`, `*_bookings` (status=1 won), `*_revenue` (won `value_aud`) |

## Step 1 — pull the email KPIs from ActiveCampaign (MCP)
Run the campaign report **once per FY window** (AU FY, Jul–Jun, END-year). Use a
tiny `columns`/`limit` — the account-level `summaryData` is what we store, and it
covers the whole window regardless of returned rows:

```
run_campaign_performance_report({
  module: "campaigns",
  explore: "all_campaigns_performance",
  columns: ["campaign_name"],
  params: { view_distinct_campaigns_event_date_start: "<FY start>",
            view_distinct_campaigns_event_date_end:   "<FY end or today>" },
  limit: 1
})
```
From each response's `summaryData` record: `number_of_campaigns`, `total_sends`,
`open_rate`, `click_rate`, `click_to_open_rate`, `unsubscribe_rate`,
`total_unsubscribes`, `bounce_rate`, `total_bounces`, `total_unique_opens`,
`total_unique_clicks`.

FY windows: FY22 `2021-07-01..2022-06-30`, FY23 `..2023-06-30`, FY24
`..2024-06-30`, FY25 `..2025-06-30`, FY26 `..2026-06-30`, **current FY** start
`<Jul 1 of current FY>` → **today** (partial).

## Step 2 — current subscriber snapshot (AC MCP)
- `active_contacts` = `list_contacts({ params:{ limit:1, status:1 }}).meta.total`
  (account-wide ACTIVE contacts).
- `bureau_list_subscribers` = `list_lists({ params:{ filters:{channel:"email"} }})`
  → the **SPEAKERS BUREAUS** list (`id = 3`) `active_subscribers`.

These are "as of now" figures; write the **same value on every FY row** of the run.

## Step 3 — insert the snapshot (Supabase MCP `execute_sql`)
One statement. Fill the `email(...)` VALUES from Step 1 (one tuple per FY) and the
two subscriber constants from Step 2; the partner figures are computed inline from
`ac_indirect_deals` so they always reconcile with the Leads & Bookings / Overview
tabs. **Do not** add `ON CONFLICT` and **never** UPDATE/DELETE.

```sql
with run as (select gen_random_uuid() as rid, now() as ts),
-- one tuple per FY: (fy_end, win_start, win_end, campaigns, sends, open_rate,
--   click_rate, cto, unsub_rate, total_unsub, bounce_rate, bounces, uopens, uclicks)
email(fy_end, ws, we, campaigns, sends, openr, clickr, c2o, unsubr, unsub, bouncer, bounces, uopens, uclicks) as (
  values
   (2022, date '2021-07-01', date '2022-06-30', :c22, :s22, :o22, :cl22, :cto22, :ur22, :u22, :br22, :b22, :uo22, :uc22),
   (2023, date '2022-07-01', date '2023-06-30', :c23, :s23, :o23, :cl23, :cto23, :ur23, :u23, :br23, :b23, :uo23, :uc23),
   (2024, date '2023-07-01', date '2024-06-30', :c24, :s24, :o24, :cl24, :cto24, :ur24, :u24, :br24, :b24, :uo24, :uc24),
   (2025, date '2024-07-01', date '2025-06-30', :c25, :s25, :o25, :cl25, :cto25, :ur25, :u25, :br25, :b25, :uo25, :uc25),
   (2026, date '2025-07-01', date '2026-06-30', :c26, :s26, :o26, :cl26, :cto26, :ur26, :u26, :br26, :b26, :uo26, :uc26),
   (2027, date '2026-07-01', <TODAY>,           :c27, :s27, :o27, :cl27, :cto27, :ur27, :u27, :br27, :b27, :uo27, :uc27)
),
deals as (
  select
    (extract(year from cdate)::int + case when extract(month from cdate) >= 7 then 1 else 0 end) as fy_end,
    is_tailor,
    count(*) as enquiries,
    count(*) filter (where status=1) as bookings,
    coalesce(sum(value_aud) filter (where status=1),0)::numeric as revenue,
    count(distinct contact_id) filter (where contact_id is not null and contact_id <> '') as contacts
  from public.ac_indirect_deals
  where cdate is not null
  group by 1,2
),
bureau as (select * from deals where is_tailor=false),
tailor as (select * from deals where is_tailor=true)
insert into public.email_partner_metrics(
  run_id, captured_at, fy_end, fy_label, window_start, window_end,
  campaigns_sent, total_sends, open_rate, click_rate, click_to_open_rate,
  unsubscribe_rate, total_unsubscribes, bounce_rate, total_bounces,
  total_unique_opens, total_unique_clicks,
  active_contacts, bureau_list_subscribers,
  bureau_enquiries, bureau_bookings, bureau_revenue, bureau_contacts,
  tailor_enquiries, tailor_bookings, tailor_revenue, tailor_contacts,
  summary, note)
select
  run.rid, run.ts, e.fy_end, 'fy'||right(e.fy_end::text,2), e.ws, e.we,
  e.campaigns, e.sends, e.openr, e.clickr, e.c2o,
  e.unsubr, e.unsub, e.bouncer, e.bounces, e.uopens, e.uclicks,
  <ACTIVE_CONTACTS>, <BUREAU_LIST_SUBSCRIBERS>,
  coalesce(b.enquiries,0), coalesce(b.bookings,0), coalesce(b.revenue,0), coalesce(b.contacts,0),
  coalesce(t.enquiries,0), coalesce(t.bookings,0), coalesce(t.revenue,0), coalesce(t.contacts,0),
  jsonb_build_object('email_source','ActiveCampaign run_campaign_performance_report',
                     'partner_source','ac_indirect_deals','partial',(e.fy_end=2027)),
  'weekly email-partners-sync'
from email e cross join run
left join bureau b on b.fy_end=e.fy_end
left join tailor t on t.fy_end=e.fy_end;
```
Substitute the `:xx` placeholders with the numbers from Step 1, `<TODAY>` with the
run date, and `<ACTIVE_CONTACTS>` / `<BUREAU_LIST_SUBSCRIBERS>` with Step 2. (The
build-time seed used exactly this shape — see migration
`20261106160000_create_email_partner_metrics.sql`.)

## Verify
```sql
select fy_label, campaigns_sent, total_sends, open_rate, click_rate,
       total_unsubscribes, active_contacts, bureau_bookings, bureau_revenue,
       tailor_bookings, tailor_revenue, captured_at
from public.email_partner_metrics
where run_id = (select run_id from public.email_partner_metrics order by captured_at desc limit 1)
order by fy_end;
```

## Notes & gotchas
- **AC MCP aggregates:** `run_campaign_performance_report` IS the sanctioned
  aggregate tool — its `summaryData` is account-level for the window. Do **not**
  try to sum `list_campaigns` rows by hand (the MCP rejects that).
- **Replies / send-cadence are intentionally unfilled** — ActiveCampaign does not
  track email replies, and there's no "sent on time" field. The page renders those
  tiles with a `pending` chip; don't fabricate them.
- **Subscriber counts are current snapshots**, stored identically on every FY row
  of a run (we can't reconstruct historical list sizes).
- **`ac_indirect_deals`** is refreshed daily by `ac-indirect-deals-sync` (bureau =
  `is_tailor=false`, tailor = `is_tailor=true`); this routine just reads it.
- Frontend/server for this page already ship with the dashboard — a *data* refresh
  here needs **no redeploy** (the server only SELECTs the cache).
