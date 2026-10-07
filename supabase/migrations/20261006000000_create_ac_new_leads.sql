-- New Paid Leads cache for the dashboard "New Paid Leads Tracking" page
-- (GET /api/operations/new-paid-leads). One row per ActiveCampaign contact
-- CREATED on/after 5 Oct 2026 Philippine time (= 2026-10-04T16:00:00Z, since AC
-- cdate is UTC) OR last-UPDATED on/after that cutoff (so older contacts that get a
-- new form submit / Src field after the cutoff are included), carrying the 11 AC
-- "Src - *" acquisition custom fields (contact field ids 77-87) captured at
-- form-submit time.
--
-- Filled Mon-Fri 06:00 PH by the new-paid-leads-sync edge function, which UPSERTs
-- on contact_id and NEVER truncates. The dashboard only SELECTs this table.

create table if not exists public.ac_new_leads (
  contact_id            text primary key,
  email                 text,
  first_name            text,
  last_name             text,
  phone                 text,
  cdate                 timestamptz,           -- AC creation date (UTC)
  udate                 timestamptz,           -- AC last-updated date (UTC)

  -- The 11 "Src - *" contact custom fields (AC field id in brackets).
  src_lead_channel      text,                  -- [77] SRC_CHANNEL
  src_utm_source        text,                  -- [78] SRC_UTM_SOURCE
  src_utm_medium        text,                  -- [79] SRC_UTM_MEDIUM
  src_utm_campaign      text,                  -- [80] SRC_UTM_CAMPAIGN
  src_utm_term          text,                  -- [81] SRC_UTM_TERM
  src_gclid             text,                  -- [82] SRC_GCLID  (Google Ads click id)
  src_msclkid           text,                  -- [83] SRC_MSCLKID (Microsoft Ads click id)
  src_landing_page      text,                  -- [84] SRC_LANDING_PAGE
  src_referrer          text,                  -- [85] SRC_REFERRER
  src_ft_channel        text,                  -- [86] SRC_FT_CHANNEL (first-touch channel)
  src_ft_landing_page   text,                  -- [87] SRC_FT_LANDING_PAGE

  -- Derived for the dashboard cards/table (same "source / medium" shape as the
  -- historical Lead Source Tracking tab's channel column).
  channel               text,
  is_paid               boolean,

  first_synced_at       timestamptz not null default now(),
  last_synced_at        timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists ac_new_leads_cdate_idx on public.ac_new_leads (cdate desc);
create index if not exists ac_new_leads_udate_idx on public.ac_new_leads (udate desc);

-- Dashboard connects via a direct Postgres role (bypasses RLS); the sync edge
-- function uses the service role (bypasses RLS). RLS on with no policies keeps the
-- anon key from reading it, matching the other dashboard cache tables.
alter table public.ac_new_leads enable row level security;

comment on table public.ac_new_leads is
  'New AC contacts (created >= 2026-10-05 PHT) with their Src-* acquisition fields. Filled Mon-Fri 06:00 PH by the new-paid-leads-sync edge function (upsert on contact_id). Read by the dashboard "New Paid Leads Tracking" tab.';
