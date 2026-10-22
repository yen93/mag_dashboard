-- Simple Digital monthly fee (the paid-search management component), parsed from the
-- GoCardless "Upcoming Direct Debit … Simple Digital Pty Ltd" notices in Gmail by the
-- simple-digital-fees-sync routine. amount_inc_gst ÷ 1.1 = ex-GST; from Mar 2026 a $600
-- SEO component is excluded, so paid_search_fee = amount_ex_gst - seo_component.
-- Feeds the ROAS page's All-in cost basis (FY25+). Empty until the sync runs — the ROAS
-- metric reads it with a LEFT JOIN, so the Simple Digital fee simply reads $0 until then.
create table if not exists public.simple_digital_fees_monthly (
  month           date not null,
  invoice         text,
  notice_date     date,
  amount_inc_gst  numeric,
  amount_ex_gst   numeric,
  seo_component   numeric not null default 0,
  paid_search_fee numeric,
  updated_at      timestamptz not null default now(),
  primary key (month)
);
