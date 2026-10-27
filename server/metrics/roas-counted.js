// ROAS-counted deals — the canonical deal-grained set, served to the GA4 & Ads Leads page's
// "ROAS-counted only" view. Plain SELECT of the public.roas_counted_deals view (the SAME
// source the ROAS tab aggregates, so the page's ROAS-counted list reconciles with the ROAS
// tab per FY). The page's DEFAULT view + all other filters still read ga4_ac_contact_source
// via getAcContactSources() and are unaffected by this endpoint.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC = 'Live (Supabase): public.roas_counted_deals view';

// `channel` is LEFT-JOINed from ga4_ac_contact_source by deal_id so the page's KPI cards
// (Paid Google / Bing, Organic …) have data where a GA4 session channel is known. deal_id is
// unique in that table, so the join can't fan out. NULL for Niki / non-GA4 deals.
const SELECT = `
  SELECT
    v.row_key AS "rowKey",
    v.deal_id AS "dealId",
    v.fy_end  AS "fyEnd",
    v.fy      AS "fy",
    v.cdate   AS "cdate",
    v.status  AS "status",
    v.value   AS "value",
    v.source  AS "source",
    v.org     AS "org",
    v.title   AS "title",
    v.email   AS "email",
    v.method  AS "method",
    v.comment AS "comment",
    v.xero_engagement_fee AS "xeroEngagementFee",
    v.xero_gst            AS "xeroGst",
    v.xero_other_fees     AS "xeroOtherFees",
    v.xero_total          AS "xeroTotal",
    v.xero_invoice_json   AS "xeroInvoiceJson",
    cs.channel AS "channel"
  FROM public.roas_counted_deals v
  LEFT JOIN public.ga4_ac_contact_source cs ON cs.deal_id = v.deal_id
  ORDER BY v.fy_end DESC, v.status, v.value DESC NULLS LAST`;

const num = (v) => (v === null || v === undefined ? null : Number(v));

export async function getRoasCounted() {
  if (!supabaseConfigured()) {
    return {
      asOf: new Date().toISOString(),
      count: 0,
      rows: section([], { source: SRC, status: 'pending', note: 'Supabase not configured (set SUPABASE_DB_URL).' }),
    };
  }
  const rows = (await q(SELECT)).map((r) => ({
    rowKey: r.rowKey,
    dealId: r.dealId == null ? null : String(r.dealId),
    fyEnd: num(r.fyEnd),
    fy: r.fy || '',
    cdate: r.cdate || null,
    status: r.status || '',
    value: num(r.value),
    source: r.source || '',
    org: r.org || '',
    title: r.title || '',
    email: r.email || '',
    method: r.method || '',
    comment: r.comment || '',
    xeroEngagementFee: num(r.xeroEngagementFee),
    xeroGst: num(r.xeroGst),
    xeroOtherFees: num(r.xeroOtherFees),
    xeroTotal: num(r.xeroTotal),
    xeroInvoiceJson: r.xeroInvoiceJson || null,
    channel: r.channel || '',
  }));
  const won = rows.filter((r) => r.status === 'won').length;
  return {
    asOf: new Date().toISOString(),
    count: rows.length,
    rows: section(rows, {
      source: SRC,
      status: 'live',
      note: `${rows.length} ROAS-counted deals across FY (${won} won). Same set as the ROAS tab.`,
    }),
  };
}
