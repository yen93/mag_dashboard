-- Google Ads monthly spend sourced from XERO (replaces Niki's per-lead cpc for
-- FY22–24 and google_ads_campaign_monthly / the Google Ads API for FY25+ as the
-- ROAS page's Google cost — ALL financial years now come from here).
--
-- MAG pays Google Ads by card / direct debit; those charges land in Xero as
-- reconciled SPEND bank transactions coded to account 302 "Advertising and
-- marketing", under the "Google" and (for a May-2023→Feb-2024 window) "Google
-- Ads" contacts. The xero-ad-spend-sync edge function reads them (REST
-- BankTransactions — the claude.ai Xero MCP only sees UNRECONCILED txns), sums
-- the EX-GST amount of the account-302 LINE ITEMS only (the "Google" contact
-- also has non-ad Google charges on other accounts), buckets by calendar month
-- across both contacts, and wipe-then-reinserts this whole table each run.
--
-- One row per month, ex-GST. roas.js SUMs cost by FY, so no dashboard redeploy
-- is needed to pick up refreshed data — only the roas.js rewiring to read this
-- table (instead of niki_ad_leads_tracking / google_ads_campaign_monthly).
create table if not exists public.google_ads_xero_monthly (
  month      date        not null primary key,
  cost       numeric,                      -- ex-GST, account 302 only, both Google contacts
  currency   text        default 'AUD',
  txns       integer,                      -- bank transactions contributing to the month
  updated_at timestamptz not null default now()
);

create index if not exists google_ads_xero_monthly_month_idx
  on public.google_ads_xero_monthly (month);
