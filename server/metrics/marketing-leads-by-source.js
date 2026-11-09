// Marketing — Leads & Bookings by source.
//
// Enquiries and bookings split across FOUR fixed lead sources, for the
// "Enquiries by source" stacked chart and the "By source" table on
// public/leads_bookings.html. LIVE, computed at request time from Supabase.
//
// The four sources — the SAME population the Marketing Overview "Keynote
// enquiries/bookings" cards count, so the two pages reconcile exactly:
//   • Paid Ads → public.roas_counted_deals (the canonical ROAS-counted view —
//                Google + Bing + any paid-attributed deal; it carries no
//                Google-vs-Bing platform split, so it is shown as one row).
//   • Organic  → ga4_ac_contact_source  WHERE medium='organic'
//   • Tailor   → ac_indirect_deals      WHERE is_tailor=true  (excl. paid deals)
//   • Bureau   → ac_indirect_deals      WHERE is_tailor=false (excl. paid deals)
//
// Paid Ads booking = roas_counted_deals.status='won'. Organic: a row is an
// enquiry, booking = deal_status='won'. Tailor/Bureau: a deal is an enquiry,
// booking = status=1 (Won); both EXCLUDE any deal already counted as Paid Ads
// (precedence paid > indirect, mirroring the Overview/ROI dedup) so the four
// buckets are disjoint. Month + Australian FY (END-year, Jul–Jun) are derived
// from cdate so they match the Overview/ROI tabs. NB organic reads only within
// GA4's ~60-day retention, so earlier FYs carry no organic rows (expected).

import { q, supabaseConfigured } from '../providers/supabase.js';

// Fixed display order (and the only sources shown).
export const LEAD_SOURCES = ['Paid Ads', 'Organic', 'Tailor', 'Bureau'];

const SRC =
  'Live (Supabase): enquiries + bookings per source — Paid Ads from ' +
  'roas_counted_deals, Organic from ga4_ac_contact_source (medium=organic), ' +
  'Tailor/Bureau from ac_indirect_deals (excl. paid deals). Booking = won deal. ' +
  'Month + AU FY from the deal/contact cdate.';

// AU financial-year END year from a date column (calendar year + 1 if month >= July).
const FY = (col) =>
  `extract(year FROM ${col})::int + CASE WHEN extract(month FROM ${col}) >= 7 THEN 1 ELSE 0 END`;

// The four-source UNION, shared by the per-FY payload and the custom-range variant.
// `roas` is the paid set and also excludes paid deal_ids from Tailor/Bureau.
const SRC_CTE = `
  WITH roas AS (
    SELECT deal_id::text AS deal_id, cdate, (status = 'won') AS won
      FROM public.roas_counted_deals WHERE cdate IS NOT NULL
  ),
  src AS (
    SELECT 'Paid Ads'::text AS source, cdate, won FROM roas
    UNION ALL
    SELECT 'Organic', cdate, (deal_status = 'won')
      FROM public.ga4_ac_contact_source
      WHERE medium = 'organic' AND cdate IS NOT NULL
    UNION ALL
    SELECT 'Tailor', cdate, (status = 1)
      FROM public.ac_indirect_deals
      WHERE is_tailor = true AND cdate IS NOT NULL
        AND deal_id::text NOT IN (SELECT deal_id FROM roas WHERE deal_id IS NOT NULL)
    UNION ALL
    SELECT 'Bureau', cdate, (status = 1)
      FROM public.ac_indirect_deals
      WHERE is_tailor = false AND cdate IS NOT NULL
        AND deal_id::text NOT IN (SELECT deal_id FROM roas WHERE deal_id IS NOT NULL)
  )`;

const BY_SOURCE_SQL = `${SRC_CTE}
  SELECT source,
    to_char(date_trunc('month', cdate), 'YYYY-MM') AS month,
    ${FY('cdate')} AS "fyEnd",
    count(*)                    AS enquiries,
    count(*) FILTER (WHERE won) AS bookings
  FROM src
  GROUP BY source, month, "fyEnd"
  ORDER BY month, source`;

// Custom date-range variant — same per-source × month rows, bounded to [from,to]
// (inclusive) on cdate at DAY level (an edge month shows only its in-range days).
// $1=from, $2=to ('YYYY-MM-DD' or null).
const RANGE_SQL = `${SRC_CTE}
  SELECT source,
    to_char(date_trunc('month', cdate), 'YYYY-MM') AS month,
    ${FY('cdate')} AS "fyEnd",
    count(*)                    AS enquiries,
    count(*) FILTER (WHERE won) AS bookings
  FROM src
  WHERE ($1::date IS NULL OR cdate::date >= $1::date)
    AND ($2::date IS NULL OR cdate::date <= $2::date)
  GROUP BY source, month, "fyEnd"
  ORDER BY month, source`;

// ---------------------------------------------------------------------------
// Per-lead detail — one row per individual deal/lead behind the counts above.
// Same four disjoint sources + dedup as SRC_CTE, but carrying each deal's
// date, org, title, status and value (AUD) for the "All leads" table.
const LEADS_CTE = `
  WITH roas AS (
    SELECT deal_id::text AS deal_id, cdate, status, org, title, email,
           coalesce(xero_engagement_fee, value) AS value
      FROM public.roas_counted_deals WHERE cdate IS NOT NULL
  ),
  leads AS (
    SELECT 'Paid Ads'::text AS source, cdate,
           coalesce(nullif(org, ''), email) AS org, title,
           initcap(status) AS status, (status = 'won') AS won, value
      FROM roas
    UNION ALL
    SELECT 'Organic', cdate,
           email AS org, deal_title AS title,
           initcap(coalesce(deal_status, '')) AS status, (deal_status = 'won') AS won, deal_value AS value
      FROM public.ga4_ac_contact_source
      WHERE medium = 'organic' AND cdate IS NOT NULL
    UNION ALL
    SELECT CASE WHEN is_tailor THEN 'Tailor' ELSE 'Bureau' END, cdate,
           coalesce(nullif(organization, ''), contact_name) AS org, title,
           coalesce(status_label, '') AS status, (status = 1) AS won, value_aud AS value
      FROM public.ac_indirect_deals
      WHERE cdate IS NOT NULL
        AND deal_id::text NOT IN (SELECT deal_id FROM roas WHERE deal_id IS NOT NULL)
  )`;

const LEADS_SELECT = `
  SELECT source,
    to_char(cdate, 'YYYY-MM-DD') AS date,
    to_char(date_trunc('month', cdate), 'YYYY-MM') AS month,
    ${FY('cdate')} AS "fyEnd",
    org, title, status, won, coalesce(value, 0) AS value
  FROM leads`;

const LEADS_SQL = `${LEADS_CTE}${LEADS_SELECT} ORDER BY cdate DESC, source`;

// Day-level custom-range variant. $1=from, $2=to ('YYYY-MM-DD' or null).
const LEADS_RANGE_SQL = `${LEADS_CTE}${LEADS_SELECT}
  WHERE ($1::date IS NULL OR cdate::date >= $1::date)
    AND ($2::date IS NULL OR cdate::date <= $2::date)
  ORDER BY cdate DESC, source`;

const toLead = (r) => ({
  source: r.source, date: r.date, month: r.month, fyEnd: Number(r.fyEnd) || 0,
  org: r.org || '', title: r.title || '', status: r.status || '',
  won: r.won === true, value: Number(r.value) || 0,
});

export async function getMarketingLeadsBySource(opts = {}) {
  const { from = null, to = null } = opts || {};
  if (!supabaseConfigured()) {
    return {
      sources: LEAD_SOURCES, data: [], leads: [],
      meta: { status: 'pending', source: SRC, note: 'Supabase not configured.' },
    };
  }
  const n = (v) => Number(v) || 0;
  const toRow = (r) => ({
    source: r.source, month: r.month, fyEnd: n(r.fyEnd),
    enquiries: n(r.enquiries), bookings: n(r.bookings),
  });
  const [rows, leadRows] = await Promise.all([q(BY_SOURCE_SQL), q(LEADS_SQL)]);
  const data = rows.map(toRow);
  const leads = leadRows.map(toLead);

  // Custom date-range rows (day-level), only when a range was requested.
  let range = null;
  if (from || to) {
    const [rRows, rLeads] = await Promise.all([q(RANGE_SQL, [from, to]), q(LEADS_RANGE_SQL, [from, to])]);
    range = { from, to, data: rRows.map(toRow), leads: rLeads.map(toLead) };
  }
  return { sources: LEAD_SOURCES, data, leads, range, meta: { status: 'live', source: SRC, note: null } };
}
