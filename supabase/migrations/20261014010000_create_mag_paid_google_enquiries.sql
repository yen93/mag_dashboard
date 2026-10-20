-- Cache table for the dashboard "Historical Paid Leads" page
-- (GET /api/operations/paid-google-enquiries). One row per ActiveCampaign deal
-- that the MAG Enquiry & Deal Reconciliation sheet classified as "Paid - Google"
-- (the 39 reconciled enquiries, Jul 2024 - Oct 2026). Anchored to that fixed set
-- of deal_ids; the display fields are kept current from the Supabase AC mirror.
--
-- Filled daily by the paid-google-enquiries-sync edge function, which UPSERTs on
-- deal_id and NEVER truncates. The dashboard only SELECTs this table.
--
-- Column ownership (so the seed and the sync never clobber each other):
--   * SEED-STATIC (written once from the sheet, never overwritten by the sync):
--       source_reconciled, confidence, check_with_sales, evidence,
--       type_of_engagement, email_domain, pipeline, stage, ac_lead_source_field,
--       deal_source_field, source_tags_raw, won_date.
--   * AC-LIVE (refreshed every sync from the AC mirror, upsert on deal_id):
--       enquiry_date, contact_created, organisation, contact, email, deal_title,
--       outcome, deal_value_aud, won_value_aud, google_ads_field.

create table if not exists public.mag_paid_google_enquiries (
  deal_id               text primary key,

  -- reconciliation-only (seed-static) --------------------------------------
  source_reconciled     text,                  -- always 'Paid – Google'
  confidence            text,                  -- e.g. 'Medium – automatic tag'
  check_with_sales      text,                  -- optional caveat note
  evidence              text,                  -- how the source was determined
  type_of_engagement    text,                  -- Keynote F2F / Immersive - F2F / ...
  email_domain          text,
  pipeline              text,                  -- sheet's cleaned pipeline label
  stage                 text,                  -- AC stage NAME at reconciliation time
  ac_lead_source_field  text,                  -- AC contact "Lead Source" field
  deal_source_field     text,                  -- AC deal "Deal Source?" (Direct/Indirect)
  source_tags_raw       text,                  -- raw [SALES]/[WEBSITE] tag string
  won_date              date,                  -- reconciled won date (static)

  -- AC-live (refreshed each sync from the mirror) --------------------------
  enquiry_date          timestamptz,           -- activecampaign_deals.cdate
  contact_created       timestamptz,           -- activecampaign_contacts.cdate
  organisation          text,
  contact               text,
  email                 text,
  deal_title            text,
  outcome               text,                  -- won / lost / open (from status)
  deal_value_aud        numeric,               -- activecampaign_deals.value / 100
  won_value_aud         numeric,               -- value when won, else 0
  google_ads_field      text,                  -- AC deal "Google Ads?" (Yes/No)

  first_synced_at       timestamptz not null default now(),
  last_synced_at        timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists mag_paid_google_enquiries_contact_created_idx
  on public.mag_paid_google_enquiries (contact_created desc);
create index if not exists mag_paid_google_enquiries_enquiry_date_idx
  on public.mag_paid_google_enquiries (enquiry_date desc);

-- Dashboard connects via a direct Postgres role (bypasses RLS); the sync edge
-- function uses the service role (bypasses RLS). RLS on with no policies keeps the
-- anon key from reading it, matching the other dashboard cache tables.
alter table public.mag_paid_google_enquiries enable row level security;

comment on table public.mag_paid_google_enquiries is
  'The 39 "Paid – Google" reconciled enquiries (MAG Enquiry & Deal Reconciliation sheet). Anchored to a fixed set of AC deal_ids; display fields refreshed from the AC mirror daily by the paid-google-enquiries-sync edge function (upsert on deal_id, never truncate). Read by the dashboard "Historical Paid Leads" tab.';
