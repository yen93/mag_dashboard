// ROAS deals — the per-FY deal list behind the ROAS page's deals table. Mirrors the
// artifact's "Deals" section. LIVE from Supabase.
//   • group 'counted' = the canonical public.roas_counted_deals view (the SAME set the
//     ROAS tab counts and the GA4 & Ads Leads "ROAS-counted only" view shows — niki FY22–24
//     + clover-Yes/JC/ga4-cpc FY25+, deduped by deal_id).
//   • group 'review'  = clover_audited_deals final_gads_tag='Uncertain' (James to decide),
//                       FY25+, NOT already in the counted view.
//   • group 'actag'   = clover attributed Google Ads (effective attribution) but NOT counted.
// The frontend filters this flat list client-side by FY + status + group + search.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';
import { acValueAud } from '../lib/sql.js';

const SRC =
  'Live (Supabase): counted = public.roas_counted_deals view; review/actag = ' +
  'clover_audited_deals (final_gads_tag / attribution) not in the counted set';

const SELECT = `
  WITH counted AS (
    -- The canonical counted set (shared view). Date from the deal's resolved cdate.
    SELECT row_key AS key, fy_end, fy,
      to_char(cdate, 'DD Mon YYYY')     AS date,
      org, title,
      initcap(status)                   AS status,
      value, method, comment,
      xero_engagement_fee, xero_gst, xero_other_fees, xero_total, xero_invoice_json,
      'counted'                         AS grp
    FROM public.roas_counted_deals
  ),
  extra_src AS (
    -- Clover FY25+ deals NOT in the counted view → review / actag context rows.
    SELECT c.deal_id,
      right(c.fiscal_year, 2)::int + 2000 AS fy_end,
      c.inquiry_date                      AS date,
      c.organization                      AS org,
      c.deal_crm_title                    AS title,
      initcap(lower(btrim(c.status)))     AS status,
      ${acValueAud('ad')}                 AS value,
      lower(btrim(c.final_gads_tag))      AS gtag,
      coalesce(nullif(btrim(c.james_final_attribution), ''), nullif(btrim(c.attribution), '')) AS eff_attr,
      c.james_comments                    AS comment
    FROM public.clover_audited_deals c
    LEFT JOIN public.activecampaign_deals ad ON ad.id::text = c.deal_id::text
    WHERE c.fiscal_year ~ '^FY[0-9]{2}$'
      AND right(c.fiscal_year, 2)::int + 2000 >= 2025
      AND lower(coalesce(c.deal_crm_title, '')) NOT LIKE 'uniting%'
      AND c.deal_id NOT IN (SELECT deal_id FROM public.roas_counted_deals WHERE deal_id IS NOT NULL)
  ),
  extra AS (
    SELECT 'clv-' || deal_id AS key, fy_end, 'FY' || right(fy_end::text, 2) AS fy,
      date, org, title, status, value,
      CASE WHEN gtag = 'uncertain' THEN 'Audit: uncertain (review)'
           WHEN eff_attr IS NOT NULL THEN 'Audit: ' || eff_attr
           ELSE 'Audit' END AS method,
      comment,
      NULL::numeric AS xero_engagement_fee, NULL::numeric AS xero_gst,
      NULL::numeric AS xero_other_fees, NULL::numeric AS xero_total, NULL::jsonb AS xero_invoice_json,
      CASE WHEN gtag = 'uncertain' THEN 'review' ELSE 'actag' END AS grp
    FROM extra_src
    WHERE gtag = 'uncertain'
       OR lower(coalesce(eff_attr, '')) IN ('google ads','could be seo or paid ad')
  )
  SELECT key, fy AS "fy", fy_end AS "fyEnd",
    date AS "date", org AS "org", title AS "title", status AS "status",
    value AS "value", method AS "method", comment AS "comment", grp AS "group",
    xero_engagement_fee AS "xeroEngagementFee", xero_gst AS "xeroGst",
    xero_other_fees AS "xeroOtherFees", xero_total AS "xeroTotal", xero_invoice_json AS "xeroInvoiceJson"
  FROM (
    SELECT key, fy_end, fy, date, org, title, status, value, method, comment,
      xero_engagement_fee, xero_gst, xero_other_fees, xero_total, xero_invoice_json, grp FROM counted
    UNION ALL
    SELECT key, fy_end, fy, date, org, title, status, value, method, comment,
      xero_engagement_fee, xero_gst, xero_other_fees, xero_total, xero_invoice_json, grp FROM extra
  ) u
  ORDER BY fy_end DESC, status, value DESC NULLS LAST`;

const num = (v) => (v === null || v === undefined ? null : Number(v));

export async function getRoasDeals() {
  if (!supabaseConfigured()) {
    return { asOf: new Date().toISOString(), rows: section([], { source: SRC, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' }) };
  }
  const rows = (await q(SELECT)).map((r) => ({
    key: r.key,
    fy: r.fy,
    fyEnd: num(r.fyEnd),
    date: r.date || '',
    org: r.org || '',
    title: r.title || '',
    status: r.status || '',
    value: num(r.value),
    method: r.method || '',
    comment: r.comment || '',
    group: r.group || '',
    xeroEngagementFee: num(r.xeroEngagementFee),
    xeroGst: num(r.xeroGst),
    xeroOtherFees: num(r.xeroOtherFees),
    xeroTotal: num(r.xeroTotal),
    xeroInvoiceJson: r.xeroInvoiceJson || null,
  }));
  return {
    asOf: new Date().toISOString(),
    rows: section(rows, {
      source: SRC,
      status: 'live',
      note: `${rows.length} deals across FY. FY22–24 from Niki's log; FY25+ from the ROAS audit (+GA4 cpc).`,
    }),
  };
}
