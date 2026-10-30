-- Channel Summary (ROI tab) — live-from-Xero marketing spend, categorised by vendor.
-- marketing_channel_vendor_map: Xero contact -> {type, platform}. Seeded from the
-- FY25-26 Marketing ROI tracker workbook; new vendors on the "open" marketing accounts
-- (302 Advertising, 475 Website) fall through to 'Uncategorized' until mapped here.
create table if not exists public.marketing_channel_vendor_map (
  contact_id uuid primary key,
  vendor     text not null,
  type       text not null,            -- Digital Ads / Agency / Wages / Tools / Software / Printed Collaterals / ...
  platform   text,                     -- Google / Bing / Website / LinkedIn / Meta ; null = non-platform
  include    boolean not null default true,
  updated_at timestamptz not null default now()
);
comment on table public.marketing_channel_vendor_map is
  'Xero contact -> marketing Type/Platform bucket for the ROI tab Channel Summary. Maintained by hand; new vendors on accounts 302/475 show as Uncategorized until added here.';

-- marketing_channel_monthly: raw ex-GST spend bucketed by (month, contact, Xero account).
-- Type/Platform are NOT stored here — they are joined from the vendor map at query time,
-- so re-categorising a vendor is a map edit, not a Xero re-pull. Filled by the
-- xero-channel-summary-sync edge function (wipe-then-reinsert the whole window monthly).
create table if not exists public.marketing_channel_monthly (
  month        date not null,          -- first of month
  contact_id   uuid not null,
  vendor       text,
  account_code text not null,
  amount       numeric not null default 0,   -- ex-GST AUD
  updated_at   timestamptz not null default now(),
  primary key (month, contact_id, account_code)
);
comment on table public.marketing_channel_monthly is
  'ROI tab Channel Summary source: ex-GST marketing spend per (month, Xero contact, account), filled monthly from Xero by xero-channel-summary-sync. Join marketing_channel_vendor_map by contact_id for Type/Platform.';
create index if not exists marketing_channel_monthly_month_idx on public.marketing_channel_monthly (month);
