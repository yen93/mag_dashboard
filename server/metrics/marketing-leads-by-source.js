// Marketing — Leads & Bookings by source.
//
// Enquiries and bookings split across FIVE fixed lead sources, for the
// "Enquiries by source" stacked chart and the "By source" table on
// public/leads_bookings.html. LIVE, computed at request time from Supabase.
//
// The five sources (exact definitions supplied by the owner):
//   • Google  → ga4_ac_contact_source  WHERE medium ILIKE '%cpc%' AND source='google'
//   • Bing    → ga4_ac_contact_source  WHERE medium ILIKE '%cpc%' AND source='bing'
//   • Organic → ga4_ac_contact_source  WHERE medium='organic'
//   • Tailor  → ac_indirect_deals      WHERE is_tailor=true
//   • Bureau  → ac_indirect_deals      WHERE is_tailor=false
//
// For the two ga4 sources a row is an enquiry; a BOOKING is a row whose
// deal_status='won'. For the two indirect sources a deal is an enquiry; a
// BOOKING is a deal with status=1 (Won). Month + Australian FY (END-year,
// Jul–Jun) are both derived from cdate so they match the Overview/ROI tabs.

import { q, supabaseConfigured } from '../providers/supabase.js';

// Fixed display order (and the only sources shown — item #4 of the brief).
export const LEAD_SOURCES = ['Google', 'Bing', 'Organic', 'Tailor', 'Bureau'];

const SRC =
  'Live (Supabase): enquiries + bookings per source — Google/Bing/Organic from ' +
  'ga4_ac_contact_source (cpc / organic), Tailor/Bureau from ac_indirect_deals. ' +
  'Booking = won deal. Month + AU FY from the deal/contact cdate.';

// AU financial-year END year from a date column (calendar year + 1 if month >= July).
const FY = (col) =>
  `extract(year FROM ${col})::int + CASE WHEN extract(month FROM ${col}) >= 7 THEN 1 ELSE 0 END`;

const BY_SOURCE_SQL = `
  WITH src AS (
    SELECT 'Google'::text AS source, cdate, (deal_status = 'won') AS won
      FROM public.ga4_ac_contact_source
      WHERE medium ILIKE '%cpc%' AND source = 'google' AND cdate IS NOT NULL
    UNION ALL
    SELECT 'Bing', cdate, (deal_status = 'won')
      FROM public.ga4_ac_contact_source
      WHERE medium ILIKE '%cpc%' AND source = 'bing' AND cdate IS NOT NULL
    UNION ALL
    SELECT 'Organic', cdate, (deal_status = 'won')
      FROM public.ga4_ac_contact_source
      WHERE medium = 'organic' AND cdate IS NOT NULL
    UNION ALL
    SELECT 'Tailor', cdate, (status = 1)
      FROM public.ac_indirect_deals
      WHERE is_tailor = true AND cdate IS NOT NULL
    UNION ALL
    SELECT 'Bureau', cdate, (status = 1)
      FROM public.ac_indirect_deals
      WHERE is_tailor = false AND cdate IS NOT NULL
  )
  SELECT source,
    to_char(date_trunc('month', cdate), 'YYYY-MM') AS month,
    ${FY('cdate')} AS "fyEnd",
    count(*)                    AS enquiries,
    count(*) FILTER (WHERE won) AS bookings
  FROM src
  GROUP BY source, month, "fyEnd"
  ORDER BY month, source`;

export async function getMarketingLeadsBySource() {
  if (!supabaseConfigured()) {
    return {
      sources: LEAD_SOURCES, data: [],
      meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' },
    };
  }
  const n = (v) => Number(v) || 0;
  const rows = await q(BY_SOURCE_SQL);
  const data = rows.map((r) => ({
    source: r.source,
    month: r.month,
    fyEnd: n(r.fyEnd),
    enquiries: n(r.enquiries),
    bookings: n(r.bookings),
  }));
  return { sources: LEAD_SOURCES, data, meta: { status: 'live', source: SRC, note: null } };
}
