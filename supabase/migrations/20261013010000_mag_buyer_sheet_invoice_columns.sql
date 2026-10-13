-- mag_buyer_sheet: add invoice charge columns sourced from public.invoice_tracking.
-- A buyer-sheet row (one per WON deal) is matched to its Xero invoice(s) by
-- deal_title = invoice_tracking.ac_deal_title. A deal can have several invoices
-- (deposit + final), so the buyer-sheet-sync edge function SUMS the money and keeps
-- every invoice's JSON in an array. These three columns are deterministic from
-- invoice_tracking and refreshed on every buyer-sheet-sync run (base step).

alter table public.mag_buyer_sheet
  add column if not exists engagement_fee numeric,
  add column if not exists amount_total   numeric,
  add column if not exists invoice_json   text;

comment on column public.mag_buyer_sheet.engagement_fee is 'Sum of engagement_fee across the deal''s invoice_tracking invoices (matched ac_deal_title = deal_title). Filled by buyer-sheet-sync.';
comment on column public.mag_buyer_sheet.amount_total is 'Sum of amount_total (GST-incl total charged) across the deal''s invoice_tracking invoices. Filled by buyer-sheet-sync.';
comment on column public.mag_buyer_sheet.invoice_json is 'JSON array of the deal''s matched invoice_tracking.invoice_json objects (one element per invoice). Filled by buyer-sheet-sync.';
