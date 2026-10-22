-- Bing (Microsoft Advertising) monthly spend, mirroring public.google_ads_campaign_monthly.
-- Filled by the bing-ads-campaign-monthly-sync edge function (Microsoft Advertising API),
-- upserting on (month, campaign_id). Feeds the ROAS page's All-in cost basis (FY25+).
-- Empty until the sync + Microsoft Ads credentials are configured — the ROAS metric reads
-- it with a LEFT JOIN, so Bing spend simply reads $0 until then.
create table if not exists public.bing_ads_campaign_monthly (
  month             date    not null,
  account_id        text,
  campaign_id       bigint  not null,
  campaign_name     text,
  channel_type      text,
  impressions       bigint,
  clicks            bigint,
  cost              numeric,
  conversions       numeric,
  conversions_value numeric,
  all_conversions   numeric,
  currency          text,
  updated_at        timestamptz not null default now(),
  primary key (month, campaign_id)
);

create index if not exists bing_ads_campaign_monthly_month_idx
  on public.bing_ads_campaign_monthly (month);
