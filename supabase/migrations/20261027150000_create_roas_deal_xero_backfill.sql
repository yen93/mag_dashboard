-- One-time backfill table for the Xero invoice breakdown of ROAS-counted WON deals whose invoices
-- predate the 2026+ invoice_tracking cache. Keyed by AC deal_id; the roas_counted_deals view
-- COALESCEs this as a FALLBACK after invoice_tracking (see the next migration).
--
-- DATA is NOT seeded here: the rows are a one-time load reconciled from Xero (via the Xero MCP
-- connector) by matching each deal's EVENT to its sales invoice(s) and splitting line items the same
-- way invoice_tracking does — engagement_fee = net on service accounts (220-228), other_fees = net
-- on expense accounts (465/311), gst = invoice tax, total = invoice total, summed across a deal's
-- invoices. Each loaded row carries a match_note explaining the match. Treat it like the other
-- static loads (clover_audited_deals, niki_ad_leads_tracking): reload from Xero if it needs refreshing.
-- Only invoices issued on/after ~2023-07-01 are reachable via the Xero MCP (current FY + 3 prior),
-- so deals invoiced earlier stay NULL.
CREATE TABLE IF NOT EXISTS public.roas_deal_xero_backfill (
  deal_id             text PRIMARY KEY,
  org                 text,
  ac_title            text,
  xero_engagement_fee numeric,
  xero_gst            numeric,
  xero_other_fees     numeric,
  xero_total          numeric,
  xero_invoice_json   jsonb,
  invoice_numbers     text,
  matched             boolean NOT NULL DEFAULT false,
  match_note          text,
  filled_at           timestamptz NOT NULL DEFAULT now()
);
