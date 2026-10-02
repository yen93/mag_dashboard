-- Sales Top-Line KPI cache for the dashboard "Sales" page (MAG_Sales_Metrics
-- dev_sheet rows 2-8). Long format: one row per (metric, bucket, dimension).
-- Filled weekly (Mon 06:00 PH) by the sales-topline-sync Claude routine
-- (see routines/sales-topline-sync.md). The dashboard only SELECTs this table.
--
-- metric    : total_income | direct_indirect_split | speaking_enquiries
--             | bureau | tailor | inbound | outbound
-- bucket    : month-start for monthly series; year-start (Jan 1) for YTD scalars
-- dimension : '' for monthly series; 'ytd'/'ytd_prev' for the income scalars;
--             'direct'/'indirect' for the income split
-- unit      : 'aud' | 'count' | 'pct'

create table if not exists public.sales_topline (
  metric     text not null,
  bucket     date not null,
  dimension  text not null default '',
  value      numeric,
  unit       text not null,
  updated_at timestamptz not null default now(),
  primary key (metric, bucket, dimension)
);

-- Dashboard connects via a direct Postgres role (bypasses RLS); the sync routine
-- uses the service role (bypasses RLS). RLS on with no policies keeps the anon
-- key from reading it, matching the other cache tables.
alter table public.sales_topline enable row level security;

comment on table public.sales_topline is
  'Pre-computed Top-Line sales KPIs for the dashboard Sales page. Filled weekly (Mon 06:00 PH) by the sales-topline-sync Claude routine. Long format: one row per (metric,bucket,dimension).';
