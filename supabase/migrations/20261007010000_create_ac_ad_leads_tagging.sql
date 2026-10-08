-- AC Ad Leads Tagging cache for the dashboard "AC Ad Leads Tagging" page
-- (GET /api/operations/ac-ad-leads). One row per ActiveCampaign CONTACT carrying
-- the tag "[WEBSITE] google-ads-click-through" (AC tag id 88), applied by the
-- "Google Ads Click Through" automation (#93) when a contact lands on a MAG page
-- from a Google Ads click. Each row rolls up that contact's deals (counts + value
-- sums by status) plus a single representative "primary" deal, so the dashboard
-- can show Revenue (won value), Leads tagged (row count) and Won deals.
--
-- Tag membership lives ONLY in ActiveCampaign, so the ac-ad-leads-sync edge
-- function fetches the tag-88 contacts from the AC API and joins their deals
-- against the existing public.activecampaign_deals mirror (value is in CENTS →
-- /100; currency is mixed-case → lower()). Filled Mon-Fri 06:00 PH by that edge
-- function, which UPSERTs on contact_id and NEVER truncates. The dashboard only
-- SELECTs this table.

create table if not exists public.ac_ad_leads_tagging (
  contact_id            text primary key,
  email                 text,
  first_name            text,
  last_name             text,
  phone                 text,
  contact_cdate         timestamptz,           -- AC contact created (UTC) — the date axis
  tagged_at             timestamptz,           -- when tag 88 was applied (best-effort; nullable)

  -- Deal rollups for this contact (status: 0=open, 1=won, 2=lost).
  deals_count           int not null default 0,
  won_deals_count       int not null default 0,
  open_deals_count      int not null default 0,
  lost_deals_count      int not null default 0,
  deal_value_total      numeric,               -- AUD, all deals (value/100)
  won_value_total       numeric,               -- AUD, won deals → feeds the Revenue card
  open_value_total      numeric,               -- AUD, open deals (pipeline)

  -- Representative "primary" deal: won > open > lost, then newest cdate, then highest value.
  primary_deal_id       text,
  primary_deal_title    text,
  primary_deal_value    numeric,               -- AUD
  primary_deal_status   text,                  -- 'won' | 'open' | 'lost'
  primary_deal_cdate    timestamptz,           -- deal created (UTC)
  currency              text,                  -- primary deal currency, lower-cased

  first_synced_at       timestamptz not null default now(),
  last_synced_at        timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists ac_ad_leads_tagging_cdate_idx  on public.ac_ad_leads_tagging (contact_cdate desc);
create index if not exists ac_ad_leads_tagging_tagged_idx on public.ac_ad_leads_tagging (tagged_at desc);

-- Dashboard connects via a direct Postgres role (bypasses RLS); the sync edge
-- function uses the service role (bypasses RLS). RLS on with no policies keeps the
-- anon key from reading it, matching the other dashboard cache tables.
alter table public.ac_ad_leads_tagging enable row level security;

comment on table public.ac_ad_leads_tagging is
  'AC contacts carrying tag id 88 "[WEBSITE] google-ads-click-through", with their deal rollups + a primary deal. Filled Mon-Fri 06:00 PH by the ac-ad-leads-sync edge function (upsert on contact_id). Read by the dashboard "AC Ad Leads Tagging" tab.';
