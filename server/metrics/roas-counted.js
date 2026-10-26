// ROAS-counted deals — the canonical deal-grained set, served to the GA4 & Ads Leads page's
// "ROAS-counted only" view. Plain SELECT of the public.roas_counted_deals view (the SAME
// source the ROAS tab aggregates, so the page's ROAS-counted list reconciles with the ROAS
// tab per FY). The page's DEFAULT view + all other filters still read ga4_ac_contact_source
// via getAcContactSources() and are unaffected by this endpoint.

import { q, supabaseConfigured } from '../providers/supabase.js';
import { section } from '../lib/metric.js';

const SRC = 'Live (Supabase): public.roas_counted_deals view';

const SELECT = `
  SELECT
    row_key AS "rowKey",
    deal_id AS "dealId",
    fy_end  AS "fyEnd",
    fy      AS "fy",
    cdate   AS "cdate",
    status  AS "status",
    value   AS "value",
    source  AS "source",
    org     AS "org",
    title   AS "title",
    email   AS "email",
    method  AS "method",
    comment AS "comment"
  FROM public.roas_counted_deals
  ORDER BY fy_end DESC, status, value DESC NULLS LAST`;

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
