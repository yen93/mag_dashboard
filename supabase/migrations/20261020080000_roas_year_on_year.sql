-- ROAS "Year on Year" (calendar year) cache for the dashboard ROAS tab.
--
-- Mirrors the "Year on Year" tab of the Google Sheet
--   "MAG Marketing ROAS Report – YTD - FY24-27 deal"
--   (id 1nf80glgW7EeIIPtTKQBtQlUoZ16h8BqLJDkbihPR1Sc)
-- which blends three sources that the live Supabase DB can't reproduce on its own:
--   • 2022–2024  = the previous marketing manager's Google Ads lead log (manual)
--   • 2025+      = CRM rebuild (strict Google rule + MAG Buyer Analysis values, ex-GST)
--   • Ad spend   = Google/Microsoft Ads platform exports (Jul 2024+) and estimates before.
--
-- One row per calendar year (2022 → current). The dashboard SELECTs this table
-- (server/metrics/roas.js) and derives the "All years" total itself, so no total
-- row is stored here. Refreshed by the roas-year-on-year-sync Claude routine
-- (see routines/roas-year-on-year-sync.md), which re-reads the sheet and UPSERTs
-- on cal_yr — so a manual row edit survives until the next sync re-writes that year.

create table if not exists public.roas_year_on_year (
  cal_yr          integer primary key,          -- calendar year (Jan–Dec; 2022 is May–Dec)
  period_label    text,                          -- "May – Dec 2022", "Jan – Sep 2026 (so far)"
  won_amount      numeric,                       -- Won $  (pipeline value of won deals, ex-GST)
  lost_amount     numeric,                       -- Lost $
  open_amount     numeric,                       -- Open $
  won_leads       integer,                       -- Won deal count
  lost_leads      integer,                       -- Lost deal count
  open_leads      integer,                       -- Open deal count
  leads           integer,                       -- Total leads (won + lost + open)
  win_rate        numeric,                       -- Won / leads  (ratio 0..1)
  ad_spend        numeric,                       -- Google Ads spend (AUD)
  won_revenue     numeric,                       -- Won revenue credited to Google Ads (ex-GST)
  roi_dollars     numeric,                       -- Won revenue − ad spend (AUD)
  roi_pct         numeric,                       -- (Won revenue − ad spend) / ad spend  (ratio)
  roas            numeric,                       -- Won revenue / ad spend  (× multiple)
  per_lead_value  numeric,                       -- Won revenue / leads (AUD)
  counted_method  text,                          -- how that year was counted (tooltip)
  target_roas     numeric default 2.0,           -- James's target ($ won per $1 spent)
  updated_at      timestamptz not null default now()
);

comment on table public.roas_year_on_year is
  'Per-calendar-year Google Ads ROAS, mirrored from the "Year on Year" tab of the MAG Marketing ROAS Report Google Sheet. Backs the dashboard ROAS tab (server/metrics/roas.js). Refreshed by the roas-year-on-year-sync Claude routine (upsert on cal_yr). The "All years" total is derived in the app, not stored.';

-- Server connects via SUPABASE_DB_URL as the table owner (bypasses RLS); enabling
-- RLS with no policy denies the anon/authenticated API roles, matching the other
-- cache tables (sales_topline, invoice_tracking).
alter table public.roas_year_on_year enable row level security;

insert into public.roas_year_on_year
  (cal_yr, period_label, won_amount, lost_amount, open_amount,
   won_leads, lost_leads, open_leads, leads, win_rate,
   ad_spend, won_revenue, roi_dollars, roi_pct, roas, per_lead_value, counted_method)
values
  (2022, 'May – Dec 2022',          131900, 57000,     0, 11, 17, 0, 28, 0.3928571429, 12687, 131900, 119213, 9.396468826,  10.39646883,  4710.714286, 'Previous manager''s lead log (manual check of each lead)'),
  (2023, 'Jan – Dec 2023',           95400, 128500,    0, 10, 25, 0, 35, 0.2857142857, 33776,  95400,  61624, 1.824490763,  2.824490763,  2725.714286, 'Previous manager''s lead log (manual check of each lead)'),
  (2024, 'Jan – Dec 2024',          108000, 113200, 27500, 11, 26, 4, 41, 0.2682926829, 30478, 108000,  77522, 2.543539602,  3.543539602,  2634.146341, 'Previous manager''s lead log (manual check of each lead)'),
  (2025, 'Jan – Dec 2025',           72700, 57909,     0,  7,  9, 0, 16, 0.4375,         33521,  72700,  39179, 1.168789714,  2.168789714,  4543.75,     'CRM rebuild (strict Google rule + Buyer Analysis values), checked by sales & ops 14 Oct'),
  (2026, 'Jan – Sep 2026 (so far)',  38000, 81000, 20000,  3,  9, 2, 14, 0.2142857143, 26673,  38000,  11327, 0.4246616429, 1.424661643,  2714.285714, 'CRM rebuild (strict Google rule + Buyer Analysis values), checked by sales & ops 14 Oct')
on conflict (cal_yr) do update set
  period_label   = excluded.period_label,
  won_amount     = excluded.won_amount,
  lost_amount    = excluded.lost_amount,
  open_amount    = excluded.open_amount,
  won_leads      = excluded.won_leads,
  lost_leads     = excluded.lost_leads,
  open_leads     = excluded.open_leads,
  leads          = excluded.leads,
  win_rate       = excluded.win_rate,
  ad_spend       = excluded.ad_spend,
  won_revenue    = excluded.won_revenue,
  roi_dollars    = excluded.roi_dollars,
  roi_pct        = excluded.roi_pct,
  roas           = excluded.roas,
  per_lead_value = excluded.per_lead_value,
  counted_method = excluded.counted_method,
  updated_at     = now();
